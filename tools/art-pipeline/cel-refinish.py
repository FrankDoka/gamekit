"""Cel re-finish for the video-route animation funnel.

Deterministic post-process that converts a soft, video-native runtime animation
sheet into a hard-cel finish WITHOUT any new (paid) generation. It consumes the
already-selected/normalized runtime frames and re-emits the runtime sheet, per
frame PNGs, and a lossless WebP.

WHY THIS EXISTS
---------------
Seedance/video source frames are anti-aliased and feathered: measured interior
sharpness (p95 of |horizontal luminance gradient| over alpha>64, the
visual-tuning-playbook definition) lands around 33-48 at native resolution. The
normalize funnel's LANCZOS downscale to the runtime cell lifts that to ~60-72,
but the hard-cel imagegen stills (B1 idle) and the slimes sit at ~85-97. A soft
finish reads as "sharpened video," not cel -- and it becomes the base for video
motions 2-10, so it must be fixed at the funnel, once, deterministically.

WHAT IT DOES (per frame, in order)
----------------------------------
1. Alpha re-threshold / edge firm: pixels with alpha >= --alpha-floor become
   fully opaque; the rest are cleared to transparent+zeroed-RGB. On an already
   hard-alpha sheet this is a NO-OP, which is exactly why anchors do not move
   (the alpha mask is byte-identical, so anchor_measure yields the same anchors).
2. Luminance-preserving unsharp mask on RGB, confined to the kept mask:
   sharp = rgb + amount * (rgb - gaussian_blur(rgb, radius)). This steepens the
   soft interior tone ramps into cel-like transitions, raising interior p95 into
   the hard-cel band, with NO new pixels outside the silhouette (no halo/ring).
3. Magenta edge-ring neutralization: the unsharp can push chroma-key edge pixels
   toward the magenta background hue. Any fully-opaque, magenta-leaning pixel in
   the 2px alpha edge band is desaturated to its own luminance grey. This keeps
   fringe at (or below) the pre-refinish level -- it never introduces an
   opaque-magenta ring.

GUARANTEES (asserted at runtime)
--------------------------------
- Alpha channel of every frame is byte-identical to the input's hard alpha
  (alpha>=floor), so no silhouette growth/shrink and <=0px anchor drift.
- No opaque pixel appears outside the input alpha dilated by 1px (halo == 0).

Default parameters (amount=0.7, radius=1.0, alpha-floor=128) were calibrated on
player_baldbase_swing_1h (clip05): every frame clears interior p95 75 with a
median ~92, matching B1 idle, at zero halo and fringe <= baseline. Override the
sharpen strength with the loud env escape hatch CEL_REFINISH_AMOUNT for special
cases; the value used is always recorded in the emitted report.
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


AMOUNT_ENV = "CEL_REFINISH_AMOUNT"
SHARPNESS_ALPHA_THRESHOLD = 64


def interior_p95(rgba: np.ndarray) -> float:
    """p95 of |horizontal luminance gradient| over alpha>64 (playbook metric)."""
    r = rgba[:, :, 0].astype(np.float64)
    g = rgba[:, :, 1].astype(np.float64)
    b = rgba[:, :, 2].astype(np.float64)
    a = rgba[:, :, 3]
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    grad = np.abs(np.diff(lum, axis=1))
    mask = a[:, 1:] > SHARPNESS_ALPHA_THRESHOLD
    values = grad[mask]
    if values.size == 0:
        return 0.0
    return round(float(np.percentile(values, 95)), 2)


def _dilate(mask: np.ndarray, radius: int) -> np.ndarray:
    m = Image.fromarray((mask.astype(np.uint8) * 255), "L").filter(ImageFilter.MaxFilter(radius * 2 + 1))
    return np.asarray(m) > 0


def _alpha_edge_band(alpha: np.ndarray, radius: int = 2) -> np.ndarray:
    eroded = np.asarray(Image.fromarray(alpha, "L").filter(ImageFilter.MinFilter(radius * 2 + 1)))
    return (alpha > 250) & (eroded == 0)


def _neutralize_magenta_edge_ring(arr: np.ndarray) -> tuple[np.ndarray, int]:
    """Desaturate opaque magenta-leaning edge pixels to their own luminance grey.

    Returns the mutated array and the count of neutralized pixels. Alpha is never
    touched (asserted by the caller via the byte-identical alpha guarantee).
    """
    r = arr[:, :, 0].astype(np.int16)
    g = arr[:, :, 1].astype(np.int16)
    b = arr[:, :, 2].astype(np.int16)
    a = arr[:, :, 3]
    magenta_lean = (a > 250) & (r > g + 25) & (b > g + 25)
    ring = magenta_lean & _alpha_edge_band(a)
    count = int(ring.sum())
    if count:
        neutral = np.clip((r + g + b) // 3, 0, 255).astype(np.uint8)
        for channel in range(3):
            arr[:, :, channel][ring] = neutral[ring]
    return arr, count


def refine_frame(rgba: np.ndarray, amount: float, radius: float, alpha_floor: int) -> tuple[np.ndarray, dict[str, object]]:
    original_mask = rgba[:, :, 3] > 20
    out = rgba.copy()
    keep = out[:, :, 3] >= alpha_floor

    rgb = out[:, :, :3].astype(np.float32)
    blurred = np.asarray(Image.fromarray(out[:, :, :3], "RGB").filter(ImageFilter.GaussianBlur(radius))).astype(np.float32)
    sharpened = np.clip(rgb + amount * (rgb - blurred), 0, 255)
    out[:, :, :3] = np.where(keep[:, :, None], sharpened, 0).astype(np.uint8)
    out[:, :, 3] = np.where(keep, 255, 0).astype(np.uint8)
    out[out[:, :, 3] == 0, :3] = 0

    out, fringe = _neutralize_magenta_edge_ring(out)

    # Halo / confinement guarantee: no opaque pixel outside the ORIGINAL alpha +1px.
    new_mask = out[:, :, 3] > 20
    allowed = _dilate(original_mask, 1)
    halo = int(np.sum(new_mask & ~allowed))
    if halo:
        raise AssertionError(f"cel re-finish produced {halo} opaque pixel(s) outside the original alpha +1px (ringing)")

    stats = {
        "p95Before": interior_p95(rgba),
        "p95After": interior_p95(out),
        "haloPixels": halo,
        "magentaRingNeutralized": fringe,
        "opaqueBefore": int(original_mask.sum()),
        "opaqueAfter": int(new_mask.sum()),
    }
    return out, stats


def split_frames(sheet: Image.Image, cell: int) -> list[Image.Image]:
    if sheet.width % cell != 0:
        raise SystemExit(f"sheet width {sheet.width} is not divisible by --cell {cell}")
    n = sheet.width // cell
    return [sheet.crop((i * cell, 0, (i + 1) * cell, sheet.height)) for i in range(n)]


def main() -> None:
    parser = argparse.ArgumentParser(description="Deterministic cel re-finish for the video-route animation funnel.")
    parser.add_argument("--sheet", type=Path, required=True, help="Input soft runtime sheet (horizontal .clean.png).")
    parser.add_argument("--cell", type=int, required=True, help="Frame cell width (explicit, never inferred).")
    parser.add_argument("--out-sheet", type=Path, required=True, help="Output re-finished .clean.png path.")
    parser.add_argument("--out-frames", type=Path, help="Optional directory for per-frame PNGs (default: <out-sheet>_frames).")
    parser.add_argument("--out-webp", type=Path, help="Optional lossless WebP path (default: alongside out-sheet).")
    parser.add_argument("--amount", type=float, default=0.7, help="Unsharp strength (calibrated default 0.7).")
    parser.add_argument("--radius", type=float, default=1.0, help="Unsharp gaussian radius (calibrated default 1.0).")
    parser.add_argument("--alpha-floor", type=int, default=128, help="Alpha re-threshold floor (default 128).")
    parser.add_argument("--report", type=Path, help="Optional JSON report path.")
    args = parser.parse_args()

    amount = args.amount
    env_amount = os.environ.get(AMOUNT_ENV, "").strip()
    if env_amount:
        amount = float(env_amount)
        print(f"[cel-refinish] {AMOUNT_ENV}={env_amount} overrides --amount (using {amount})")

    if not args.sheet.exists():
        raise SystemExit(f"sheet does not exist: {args.sheet}")

    sheet = Image.open(args.sheet).convert("RGBA")
    frames = split_frames(sheet, args.cell)

    out_frames_dir = args.out_frames or args.out_sheet.with_name(args.out_sheet.stem + "_frames")
    out_frames_dir.mkdir(parents=True, exist_ok=True)
    args.out_sheet.parent.mkdir(parents=True, exist_ok=True)

    refined: list[Image.Image] = []
    per_frame: list[dict[str, object]] = []
    for index, frame in enumerate(frames):
        rgba = np.asarray(frame.convert("RGBA"))
        out_arr, stats = refine_frame(rgba, amount, args.radius, args.alpha_floor)

        # Anchor-drift guarantee: alpha byte-identical to the input hard alpha.
        input_hard = np.where(rgba[:, :, 3] >= args.alpha_floor, 255, 0).astype(np.uint8)
        if not np.array_equal(out_arr[:, :, 3], input_hard):
            raise AssertionError(f"frame {index}: alpha changed vs input hard-alpha (would drift anchors)")

        out_img = Image.fromarray(out_arr, "RGBA")
        out_img.save(out_frames_dir / f"frame-{index + 1:03d}.png")
        refined.append(out_img)
        stats["frame"] = f"frame-{index + 1:03d}.png"
        per_frame.append(stats)

    out_sheet = Image.new("RGBA", (args.cell * len(refined), sheet.height), (0, 0, 0, 0))
    for index, frame in enumerate(refined):
        out_sheet.alpha_composite(frame, (index * args.cell, 0))
    out_sheet.save(args.out_sheet)

    out_webp = args.out_webp or args.out_sheet.with_suffix(".webp")
    out_sheet.save(out_webp, lossless=True, quality=100, exact=True)

    p95_after = [float(item["p95After"]) for item in per_frame]
    report = {
        "schemaVersion": 1,
        "kind": "cel-refinish",
        "createdAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "sheet": args.sheet.as_posix(),
        "outSheet": args.out_sheet.as_posix(),
        "outWebp": out_webp.as_posix(),
        "cell": args.cell,
        "frames": len(refined),
        "params": {"amount": amount, "radius": args.radius, "alphaFloor": args.alpha_floor},
        "amountEnvOverride": env_amount or None,
        "summary": {
            "minP95After": round(min(p95_after), 2),
            "medianP95After": round(float(np.median(p95_after)), 2),
            "maxP95After": round(max(p95_after), 2),
            "maxHaloPixels": max(int(item["haloPixels"]) for item in per_frame),
            "maxMagentaRingNeutralized": max(int(item["magentaRingNeutralized"]) for item in per_frame),
        },
        "perFrame": per_frame,
    }
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print(f"[cel-refinish] {len(refined)} frame(s) amount={amount} radius={args.radius} floor={args.alpha_floor}")
    print(f"[cel-refinish] interior p95 after: min={report['summary']['minP95After']} "
          f"median={report['summary']['medianP95After']} max={report['summary']['maxP95After']}")
    print(f"[cel-refinish] halo={report['summary']['maxHaloPixels']} "
          f"magentaRingNeutralized(max/frame)={report['summary']['maxMagentaRingNeutralized']}")
    print(f"[cel-refinish] sheet: {args.out_sheet}")


if __name__ == "__main__":
    main()

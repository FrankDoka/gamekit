"""Per-frame QA gate for animation frame sets.

Checks a directory of alpha PNG frames against a master sprite and writes a JSON
verdict. The scale check uses an area-equivalent body proxy so squash/stretch
poses can change height while preserving body mass.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

import numpy as np
from PIL import Image


ALPHA_THRESHOLD = 20

# Loud env escape hatch: set FRAMES_QA_ALLOW_SOFT=1 to downgrade a sharpness-floor
# FAIL to a warning (e.g. a deliberately soft placeholder). It NEVER auto-passes
# silently -- the bypass is recorded in the verdict and printed to stderr.
ALLOW_SOFT_ENV = "FRAMES_QA_ALLOW_SOFT"

# Interior-sharpness metric: p95 of the abs single-axis (horizontal) luminance
# gradient over the opaque body. This is the exact definition documented in
# docs/process/visual-tuning-playbook.md "Player-render sharpness"
# (lum = 0.299R+0.587G+0.114B, grad = |diff(lum)|, np.percentile(grad, 95),
# alpha>64). Video-route funnel finishes land ~60-72 here; hard-cel imagegen
# stills (B1 idle) and the slimes land ~85-97. The floor gate uses this metric
# so a soft video finish fails BEFORE it becomes the base for motions 2-10.
SHARPNESS_ALPHA_THRESHOLD = 64


@dataclass
class FrameMetrics:
    frame: str
    bbox: tuple[int, int, int, int]
    width: int
    height: int
    baselineY: int
    centroidY: float
    areaProxy: float
    scaleDeltaPx: float
    paletteDistance: float
    leftMassRatio: float
    pHash: str
    interiorP95: float


def interior_p95(img: Image.Image) -> float:
    """p95 of |horizontal luminance gradient| over the opaque interior.

    Playbook-canonical single-axis definition (see SHARPNESS notes at module top).
    Measured on the FULL frame (not the crop) so alpha alignment is exact.
    """
    rgba = np.asarray(img.convert("RGBA"))
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


def alpha_bbox(img: Image.Image) -> tuple[int, int, int, int] | None:
    alpha = img.getchannel("A")
    return alpha.point(lambda value: 255 if value > ALPHA_THRESHOLD else 0).getbbox()


def opaque_pixels(img: Image.Image) -> Iterable[tuple[int, int, int, int]]:
    for pixel in img.convert("RGBA").getdata():
        if pixel[3] > ALPHA_THRESHOLD:
            yield pixel


def area_proxy(img: Image.Image) -> float:
    return math.sqrt(sum(1 for _ in opaque_pixels(img)))


def palette_histogram(img: Image.Image) -> list[float]:
    buckets = [0] * 64
    total = 0
    for r, g, b, _a in opaque_pixels(img):
        index = (r // 64) * 16 + (g // 64) * 4 + (b // 64)
        buckets[index] += 1
        total += 1
    if total == 0:
        return [0.0] * len(buckets)
    return [bucket / total for bucket in buckets]


def histogram_l1(a: list[float], b: list[float]) -> float:
    return sum(abs(left - right) for left, right in zip(a, b))


def left_mass_ratio(img: Image.Image, bbox: tuple[int, int, int, int]) -> float:
    cx = (bbox[0] + bbox[2]) / 2
    left = 0
    total = 0
    pixels = img.convert("RGBA").load()
    for y in range(bbox[1], bbox[3]):
        for x in range(bbox[0], bbox[2]):
            if pixels[x, y][3] <= ALPHA_THRESHOLD:
                continue
            total += 1
            if x < cx:
                left += 1
    return left / total if total else 0.0


def centroid_y(img: Image.Image, bbox: tuple[int, int, int, int]) -> float:
    pixels = img.convert("RGBA").load()
    total = 0
    weighted = 0
    for y in range(bbox[1], bbox[3]):
        for x in range(bbox[0], bbox[2]):
            if pixels[x, y][3] <= ALPHA_THRESHOLD:
                continue
            total += 1
            weighted += y
    return weighted / total if total else 0.0


def phash(img: Image.Image) -> str:
    sample = img.convert("L").resize((8, 8), Image.Resampling.LANCZOS)
    values = list(sample.getdata())
    avg = sum(values) / len(values)
    bits = ["1" if value >= avg else "0" for value in values]
    return f"{int(''.join(bits), 2):016x}"


def hamming_hex(a: str, b: str) -> int:
    return (int(a, 16) ^ int(b, 16)).bit_count()


def frame_metrics(path: Path, master_proxy: float, master_hist: list[float]) -> FrameMetrics:
    img = Image.open(path).convert("RGBA")
    bbox = alpha_bbox(img)
    if bbox is None:
        raise ValueError(f"{path} has no opaque pixels")
    cropped = img.crop(bbox)
    return FrameMetrics(
        frame=path.name,
        bbox=bbox,
        width=bbox[2] - bbox[0],
        height=bbox[3] - bbox[1],
        baselineY=bbox[3],
        centroidY=centroid_y(img, bbox),
        areaProxy=area_proxy(cropped),
        scaleDeltaPx=area_proxy(cropped) - master_proxy,
        paletteDistance=histogram_l1(master_hist, palette_histogram(cropped)),
        leftMassRatio=left_mass_ratio(img, bbox),
        pHash=phash(cropped),
        interiorP95=interior_p95(img),
    )


def run(args: argparse.Namespace) -> dict[str, object]:
    frame_dir = Path(args.frames)
    frame_paths = sorted(frame_dir.glob("*.png"))
    failures: list[str] = []
    warnings: list[str] = []
    allow_soft = os.environ.get(ALLOW_SOFT_ENV, "").strip().lower() in {"1", "true", "yes"}
    if allow_soft and args.min_interior_p95 > 0:
        print(
            f"[frames-qa] WARNING: {ALLOW_SOFT_ENV} set -- sharpness floor "
            f"{args.min_interior_p95:.2f} downgraded to warning-only",
            file=sys.stderr,
        )
    if args.expected_count is not None and len(frame_paths) != args.expected_count:
        failures.append(f"expected {args.expected_count} frame(s), found {len(frame_paths)}")
    if not frame_paths:
        failures.append(f"no PNG frames found in {frame_dir}")

    master = Image.open(args.master).convert("RGBA")
    master_bbox = alpha_bbox(master)
    if master_bbox is None:
        raise ValueError(f"master has no opaque pixels: {args.master}")
    master_crop = master.crop(master_bbox)
    master_proxy = area_proxy(master_crop)
    master_hist = palette_histogram(master_crop)

    metrics: list[FrameMetrics] = []
    for path in frame_paths:
        try:
            metrics.append(frame_metrics(path, master_proxy, master_hist))
        except ValueError as exc:
            failures.append(str(exc))

    if metrics:
        baseline_median = sorted(item.baselineY for item in metrics)[len(metrics) // 2]
        for item in metrics:
            if abs(item.scaleDeltaPx) > args.scale_tolerance_px:
                failures.append(
                    f"{item.frame}: area-equivalent scale delta {item.scaleDeltaPx:.2f}px exceeds +/-{args.scale_tolerance_px}px"
                )
            wobble = abs(item.baselineY - baseline_median)
            if wobble > args.baseline_tolerance_px:
                failures.append(f"{item.frame}: baseline wobble {wobble}px exceeds {args.baseline_tolerance_px}px")
            if item.paletteDistance > args.palette_threshold:
                failures.append(
                    f"{item.frame}: palette histogram distance {item.paletteDistance:.3f} exceeds {args.palette_threshold:.3f}"
                )

        # Sharpness floor gate (opt-in via --min-interior-p95 > 0). Fail-closed:
        # any frame below the floor is a hard FAIL. The video-route funnel MUST
        # pass --min-interior-p95 75 so a soft finish (p95 ~60-72) is caught
        # before it becomes the base sheet for motions 2-10. Existing callers
        # that do not pass the flag keep their current behavior (floor disabled).
        if args.min_interior_p95 > 0:
            soft_frames = [item for item in metrics if item.interiorP95 < args.min_interior_p95]
            for item in soft_frames:
                message = (
                    f"{item.frame}: interior sharpness p95 {item.interiorP95:.2f} "
                    f"< floor {args.min_interior_p95:.2f} (soft video-native finish; "
                    f"re-finish to hard cel before promotion)"
                )
                if allow_soft:
                    warnings.append(message + f" [{ALLOW_SOFT_ENV}=1 bypass]")
                else:
                    failures.append(message)

        adjacent_phash_distances: list[int] = []
        for prev, curr in zip(metrics, metrics[1:]):
            mass_delta = abs(curr.leftMassRatio - prev.leftMassRatio)
            if mass_delta > args.left_mass_delta:
                failures.append(
                    f"{prev.frame}->{curr.frame}: left/right mass delta {mass_delta:.3f} exceeds {args.left_mass_delta:.3f}"
                )
            distance = hamming_hex(prev.pHash, curr.pHash)
            adjacent_phash_distances.append(distance)
            if args.motion_class == "idle":
                if distance <= args.idle_min_adjacent_phash:
                    failures.append(
                        f"{prev.frame}->{curr.frame}: idle adjacent pHash distance {distance} <= {args.idle_min_adjacent_phash}"
                    )
            elif distance <= args.phash_duplicate_distance:
                failures.append(
                    f"{prev.frame}->{curr.frame}: perceptual hash distance {distance} <= duplicate threshold {args.phash_duplicate_distance}"
                )

        full_cycle_phash_spread = 0
        for left in metrics:
            for right in metrics:
                full_cycle_phash_spread = max(full_cycle_phash_spread, hamming_hex(left.pHash, right.pHash))
        centroid_values = [item.centroidY for item in metrics]
        centroid_amplitude = max(centroid_values) - min(centroid_values) if centroid_values else 0.0
        if args.motion_class == "idle":
            if full_cycle_phash_spread < args.idle_min_full_cycle_phash_spread:
                failures.append(
                    "idle full-cycle pHash spread "
                    f"{full_cycle_phash_spread} < {args.idle_min_full_cycle_phash_spread}"
                )
            if centroid_amplitude < args.idle_min_centroid_amplitude:
                failures.append(
                    "idle centroid-Y amplitude "
                    f"{centroid_amplitude:.3f}px < {args.idle_min_centroid_amplitude:.3f}px"
                )
            if centroid_amplitude > args.idle_max_centroid_amplitude:
                failures.append(
                    "idle centroid-Y amplitude "
                    f"{centroid_amplitude:.3f}px > {args.idle_max_centroid_amplitude:.3f}px"
                )

    verdict = "PASS" if not failures else "FAIL"
    adjacent_phash_distances = [
        hamming_hex(prev.pHash, curr.pHash)
        for prev, curr in zip(metrics, metrics[1:])
    ]
    full_cycle_phash_spread = 0
    for left in metrics:
        for right in metrics:
            full_cycle_phash_spread = max(full_cycle_phash_spread, hamming_hex(left.pHash, right.pHash))
    centroid_values = [item.centroidY for item in metrics]
    centroid_amplitude = max(centroid_values) - min(centroid_values) if centroid_values else 0.0
    result = {
        "kind": "frames-qa",
        "verdict": verdict,
        "frames": str(frame_dir),
        "master": str(Path(args.master)),
        "thresholds": {
            "scaleTolerancePx": args.scale_tolerance_px,
            "baselineTolerancePx": args.baseline_tolerance_px,
            "paletteThreshold": args.palette_threshold,
            "leftMassDelta": args.left_mass_delta,
            "pHashDuplicateDistance": args.phash_duplicate_distance,
            "motionClass": args.motion_class,
            "idleMinAdjacentPHash": args.idle_min_adjacent_phash,
            "idleMinFullCyclePHashSpread": args.idle_min_full_cycle_phash_spread,
            "idleMinCentroidAmplitude": args.idle_min_centroid_amplitude,
            "idleMaxCentroidAmplitude": args.idle_max_centroid_amplitude,
            "minInteriorP95": args.min_interior_p95,
            "allowSoftBypass": allow_soft,
        },
        "summary": {
            "frameCount": len(frame_paths),
            "masterBbox": master_bbox,
            "masterAreaProxy": round(master_proxy, 3),
            "maxAbsScaleDeltaPx": round(max((abs(item.scaleDeltaPx) for item in metrics), default=0.0), 3),
            "maxBaselineWobblePx": max(
                (abs(item.baselineY - sorted(m.baselineY for m in metrics)[len(metrics) // 2]) for item in metrics),
                default=0,
            ),
            "maxPaletteDistance": round(max((item.paletteDistance for item in metrics), default=0.0), 3),
            "adjacentPHashDistances": adjacent_phash_distances,
            "minAdjacentPHash": min(adjacent_phash_distances) if adjacent_phash_distances else None,
            "maxAdjacentPHash": max(adjacent_phash_distances) if adjacent_phash_distances else None,
            "fullCyclePHashSpread": full_cycle_phash_spread,
            "centroidYAmplitude": round(centroid_amplitude, 3),
            "interiorP95PerFrame": [item.interiorP95 for item in metrics],
            "minInteriorP95Observed": round(min((item.interiorP95 for item in metrics), default=0.0), 2),
            "maxInteriorP95Observed": round(max((item.interiorP95 for item in metrics), default=0.0), 2),
        },
        "failures": failures,
        "warnings": warnings,
        "framesDetail": [asdict(item) for item in metrics],
    }
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf8")
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="QA animation frame consistency against a master sprite")
    parser.add_argument("--frames", required=True, help="Directory of PNG frames")
    parser.add_argument("--master", required=True, help="Master sprite PNG")
    parser.add_argument("--out", help="JSON verdict path")
    parser.add_argument("--expected-count", type=int)
    parser.add_argument("--scale-tolerance-px", type=float, default=2.0)
    parser.add_argument("--baseline-tolerance-px", type=int, default=3)
    parser.add_argument("--palette-threshold", type=float, default=0.95)
    parser.add_argument("--left-mass-delta", type=float, default=0.34)
    parser.add_argument("--phash-duplicate-distance", type=int, default=2)
    parser.add_argument("--motion-class", choices=["action", "idle"], default="action")
    parser.add_argument("--idle-min-adjacent-phash", type=int, default=0)
    parser.add_argument("--idle-min-full-cycle-phash-spread", type=int, default=7)
    parser.add_argument("--idle-min-centroid-amplitude", type=float, default=0.5)
    parser.add_argument("--idle-max-centroid-amplitude", type=float, default=2.6)
    parser.add_argument(
        "--min-interior-p95",
        type=float,
        default=0.0,
        help=(
            "Sharpness floor: minimum per-frame interior luminance-gradient p95 "
            "(playbook definition). 0 disables the check (default, backward compatible). "
            "Video-route motion sheets MUST pass 75 -- a soft video finish (~60-72) "
            f"fails. Loud escape hatch: set {ALLOW_SOFT_ENV}=1 to downgrade to a warning."
        ),
    )
    return parser


def main() -> None:
    result = run(build_parser().parse_args())
    print(f"[frames-qa] verdict={result['verdict']} frames={result['summary']['frameCount']}")
    if result["failures"]:
        for failure in result["failures"]:
            print(f"[frames-qa] FAILURE: {failure}")
    sys.exit(0 if result["verdict"] == "PASS" else 1)


if __name__ == "__main__":
    main()

"""Canonical-funnel front half for the cast runtime rebuild (card-p3-cast-funnel-rebuild).

Rebuilds transparent, despilled per-frame PNGs from the PRESERVED green-chroma raw
selected frames WITHOUT any palette quantization, dither, or palette reduction. This is
the matte + edge-despill stage of the animation.md "Player-Body Motion Pipeline" funnel;
downstream, animation-normalize.py (key-color NONE) does the normalize step, the committed
ground mask supplies the ground-shadow alpha edit, and cel-refinish.py does the cel finish.

WHY A PURPOSE-BUILT MATTE
-------------------------
The card's funnel names BiRefNet for the matte; BiRefNet-local needs a torch/CUDA runtime
that is not installed in this worktree, and installing it is a heavy, non-reversible change.
The raws sit on a FLAT, pure green chroma (R~4 G~170 B~7 across the field), so a hue-bounded
green chroma key produces a cleaner, fully deterministic matte than a learned segmenter would
for this specific source. A chroma-key matte IS a matte (funnel step 1); nothing here reduces
the palette.

STEPS (per frame, in order)
---------------------------
1. MATTE: hue-bounded green chroma key -> binary alpha (opaque foreground, 0 background).
   A pixel is background when it is chroma-green (G clearly above R and B) AND green-dominant.
   Alpha is hardened to {0,255} (the funnel's downstream stages assume hard alpha).
2. EDGE DESPILL: green spill removal confined to the <=2px alpha edge band, RGB-only, hue-
   bounded to chroma green (G > R and G > B), alpha byte-identical. Interior costume colours
   (blue sash/scarf, teal) are NEVER touched: they are not in the edge band, and the green-
   dominance test excludes blue/teal (where B >= G). Despilled pixels have their green pulled
   down to max(R,B) (the standard green-despill move) so a bright green rim becomes neutral.

The output is a directory of transparent PNGs at the raw resolution, ready for normalize.
No colour is quantized; the only alpha change vs the raw is the background matte itself.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


def green_background_mask(rgb: np.ndarray) -> np.ndarray:
    """Chroma-green background: green clearly dominant over both R and B.

    Calibrated on the cast raws (background R~4 G~170 B~7). The margins keep dark
    cel outlines, brown leather, cream cloth, skin, and BLUE/TEAL costume (where
    B >= G) as foreground.
    """
    r = rgb[:, :, 0].astype(np.int16)
    g = rgb[:, :, 1].astype(np.int16)
    b = rgb[:, :, 2].astype(np.int16)
    return (g > 90) & (g - r > 60) & (g - b > 60)


def matte(rgb: np.ndarray) -> np.ndarray:
    """Return hard alpha (uint8 {0,255}) from the green chroma key."""
    bg = green_background_mask(rgb)
    alpha = np.where(bg, 0, 255).astype(np.uint8)
    return alpha


def alpha_edge_band(alpha: np.ndarray, radius: int = 2) -> np.ndarray:
    """Opaque pixels within `radius` px of transparency (the despill scope)."""
    eroded = np.asarray(Image.fromarray(alpha, "L").filter(ImageFilter.MinFilter(radius * 2 + 1)))
    return (alpha > 250) & (eroded == 0)


def despill_green_edge(rgb: np.ndarray, alpha: np.ndarray, radius: int = 2) -> tuple[np.ndarray, int]:
    """Green-spill removal, edge-only, RGB-only, hue-bounded, alpha untouched.

    A spilled edge pixel is green-dominant (G > R and G > B); its green is pulled
    down to max(R,B). Blue/teal costume (B >= G) is excluded by the dominance test,
    so it is never desaturated even inside the edge band.
    """
    r = rgb[:, :, 0].astype(np.int16)
    g = rgb[:, :, 1].astype(np.int16)
    b = rgb[:, :, 2].astype(np.int16)
    edge = alpha_edge_band(alpha, radius)
    green_lean = edge & (g > r) & (g > b)
    if not green_lean.any():
        return rgb, 0
    cap = np.maximum(r, b)
    out = rgb.copy()
    new_g = np.minimum(g, cap).astype(np.uint8)
    out[:, :, 1][green_lean] = new_g[green_lean]
    return out, int(green_lean.sum())


def process(src: Path) -> tuple[Image.Image, dict]:
    im = Image.open(src).convert("RGB")
    rgb = np.array(im)
    alpha = matte(rgb)
    rgb2, despilled = despill_green_edge(rgb, alpha)
    rgba = np.dstack([rgb2, alpha]).astype(np.uint8)
    # zero RGB under transparent pixels (canonical hygiene; no colour loss on foreground)
    rgba[alpha == 0, :3] = 0
    return Image.fromarray(rgba, "RGBA"), {
        "source": src.as_posix(),
        "opaquePx": int((alpha > 250).sum()),
        "greenEdgeDespilledPx": despilled,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Cast rebuild matte + green edge-despill (canonical funnel front half).")
    ap.add_argument("--selected-dir", type=Path, required=True)
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--report", type=Path)
    args = ap.parse_args()

    frames = sorted(args.selected_dir.glob("*.png"))
    if not frames:
        raise SystemExit(f"no PNG frames under {args.selected_dir}")
    args.out_dir.mkdir(parents=True, exist_ok=True)

    records = []
    for idx, src in enumerate(frames):
        img, rec = process(src)
        rec["frame"] = f"matted-{idx:03d}.png"
        out = args.out_dir / rec["frame"]
        img.save(out)
        records.append(rec)
        print(f"[cast-rebuild-prep] {rec['frame']} opaque={rec['opaquePx']} greenEdgeDespilled={rec['greenEdgeDespilledPx']}")

    report = {
        "schemaVersion": 1,
        "kind": "cast-rebuild-prep",
        "createdAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "selectedDir": args.selected_dir.as_posix(),
        "outDir": args.out_dir.as_posix(),
        "frames": len(records),
        "records": records,
    }
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()

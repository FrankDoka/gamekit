#!/usr/bin/env python3
"""tone-match.py — reconcile a video-route sheet's color to the ACCEPTED canon identity.

Video generations re-render the character from the seed and drift color
(cast canary 2026-07-08: clip came back dimmer/cooler than the B1 canon;
postmortem docs/reviews/2026-07-08-cast-canary-postmortem.md). Faithfulness
to the clip is NOT the bar — the canon identity is. This step is a
deterministic, silhouette-only, per-channel affine transfer (mean/std) of
the sheet's RGB toward the canon's RGB statistics:

    out = (px - mean_sheet) * (std_canon / std_sheet) + mean_canon

RGB-only; alpha byte-identical (asserted); truecolor preserved (no
quantization, no dither — funnel law). Acceptance after this step:
recipes.py identity-palette vs canon < 0.95 (same-character target < 0.77)
+ color-parity + dither-noise + owner eyes on the canon torso side-by-side.
"""
from __future__ import annotations

import argparse
import json
import sys

import numpy as np
from PIL import Image


def masked_stats(arr: np.ndarray) -> tuple[np.ndarray, np.ndarray, int]:
    mask = arr[..., 3] > 8
    px = arr[..., :3][mask].astype(np.float64)
    return px.mean(axis=0), px.std(axis=0) + 1e-6, int(mask.sum())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("sheet")
    ap.add_argument("--canon", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--json", dest="report", default=None)
    args = ap.parse_args()

    sheet_img = Image.open(args.sheet).convert("RGBA")
    canon_img = Image.open(args.canon).convert("RGBA")
    sheet = np.array(sheet_img)
    canon = np.array(canon_img)

    s_mean, s_std, s_n = masked_stats(sheet)
    c_mean, c_std, c_n = masked_stats(canon)

    mask = sheet[..., 3] > 8
    rgb = sheet[..., :3].astype(np.float64)
    matched = (rgb - s_mean) * (c_std / s_std) + c_mean
    out = sheet.copy()
    out[..., :3] = np.clip(np.round(matched), 0, 255).astype(np.uint8)
    # RGB changes only where the silhouette exists; transparent px stay bytewise.
    out[~mask] = sheet[~mask]
    assert np.array_equal(out[..., 3], sheet[..., 3]), "alpha must be byte-identical"

    Image.fromarray(out, "RGBA").save(args.out)

    o_mean, o_std, _ = masked_stats(out)
    report = {
        "sheet": args.sheet,
        "canon": args.canon,
        "out": args.out,
        "silhouettePx": {"sheet": s_n, "canon": c_n},
        "meanRGB": {
            "sheetBefore": [round(v, 2) for v in s_mean],
            "canon": [round(v, 2) for v in c_mean],
            "sheetAfter": [round(v, 2) for v in o_mean],
        },
        "stdRGB": {
            "sheetBefore": [round(v, 2) for v in s_std],
            "canon": [round(v, 2) for v in c_std],
            "sheetAfter": [round(v, 2) for v in o_std],
        },
        "alphaIdentical": True,
    }
    if args.report:
        with open(args.report, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2)
    print(json.dumps(report["meanRGB"], indent=1))
    print(f"OK: tone-match {args.out} (alpha byte-identical, truecolor preserved)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

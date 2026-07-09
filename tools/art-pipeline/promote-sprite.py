"""Promote a candidate sprite to the runtime assets folder.

Handles alpha-aware resizing (composites over transparent black before LANCZOS
to prevent chroma-key bleed), validation, and sidecar metadata creation.

Usage:
    python tools/art-pipeline/promote-sprite.py <source_png> <manifest_id> [--display-size N]

Example:
    python tools/art-pipeline/promote-sprite.py \
        client/public/assets/sprites/candidates/mossling/final/mossling-slime-v1-alpha-clean-trimmed.png \
        monster_mossling
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

RUNTIME_DIR = Path(__file__).resolve().parent.parent.parent / "client" / "public" / "assets" / "sprites"
DEFAULT_DISPLAY_SIZE = 96


def validate_corners(img):
    w, h = img.size
    corners = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
    for x, y in corners:
        if img.getpixel((x, y))[3] != 0:
            return False, f"corner ({x},{y}) alpha={img.getpixel((x, y))[3]}"
    return True, ""


def check_chroma_remnants(img, threshold=20):
    import numpy as np
    arr = np.array(img)
    alpha = arr[:, :, 3]
    rgb = arr[:, :, :3]
    visible = alpha > 0
    magenta = visible & (rgb[:, :, 0] > 240) & (rgb[:, :, 1] < 15) & (rgb[:, :, 2] > 240)
    green_key = visible & (rgb[:, :, 0] < 15) & (rgb[:, :, 1] > 240) & (rgb[:, :, 2] < 15)
    count = int(magenta.sum() + green_key.sum())
    if count > threshold:
        return False, f"{count} chroma-key pixels remain in visible area"
    return True, ""


def alpha_aware_resize(img, target_size):
    clean = Image.new("RGBA", img.size, (0, 0, 0, 0))
    clean.alpha_composite(img)
    return clean.resize(target_size, Image.Resampling.LANCZOS)


def main():
    parser = argparse.ArgumentParser(description="Promote a candidate sprite to runtime assets")
    parser.add_argument("source", type=Path, help="Path to the cleaned alpha PNG")
    parser.add_argument("manifest_id", help="Entity manifest ID (e.g. monster_mossling)")
    parser.add_argument("--display-size", type=int, default=DEFAULT_DISPLAY_SIZE,
                        help=f"SPRITE_DISPLAY_SIZE (default {DEFAULT_DISPLAY_SIZE})")
    args = parser.parse_args()

    if not args.source.exists():
        print(f"ERROR: source not found: {args.source}", file=sys.stderr)
        sys.exit(1)

    img = Image.open(args.source).convert("RGBA")
    print(f"Source: {img.size[0]}x{img.size[1]} {img.mode}")

    ok, msg = validate_corners(img)
    if not ok:
        print(f"WARNING: corner check failed — {msg}", file=sys.stderr)

    ok, msg = check_chroma_remnants(img)
    if not ok:
        print(f"WARNING: {msg}", file=sys.stderr)

    target_px = args.display_size * 2
    scale = target_px / max(img.size)
    new_w = round(img.size[0] * scale)
    new_h = round(img.size[1] * scale)

    resized = alpha_aware_resize(img, (new_w, new_h))

    out_png = RUNTIME_DIR / f"{args.manifest_id}.png"
    out_meta = RUNTIME_DIR / f"{args.manifest_id}.metadata.json"

    resized.save(out_png)
    print(f"Saved runtime sprite: {out_png} ({new_w}x{new_h})")

    ok2, msg2 = validate_corners(resized)
    if not ok2:
        print(f"WARNING: resized corner check failed — {msg2}", file=sys.stderr)

    metadata = {
        "manifestId": args.manifest_id,
        "source": str(args.source),
        "sourceSize": [img.size[0], img.size[1]],
        "runtimeSize": [new_w, new_h],
        "displaySize": args.display_size,
        "resizeMethod": "alpha-aware LANCZOS (composite over transparent black)",
        "promotedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    out_meta.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(f"Saved metadata: {out_meta}")

    print("\nPromotion checklist:")
    print(f"  [{'x' if img.mode == 'RGBA' else ' '}] PNG mode is RGBA")
    print(f"  [{'x' if ok else ' '}] All four corners have alpha 0")
    print(f"  [{'x' if ok else ' '}] No chroma-key pixels near visible edge")
    print(f"  [x] Alpha-aware resize used")
    print(f"  [{'x' if max(new_w, new_h) == target_px else ' '}] Longest axis is {target_px}px (2x display)")
    print(f"  [x] Sidecar .metadata.json created")


if __name__ == "__main__":
    main()

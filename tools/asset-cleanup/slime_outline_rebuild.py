"""Measure and harden Bloomvale slime exterior outline alpha.

The slime outline card needs reproducible proof that the crawl source was the
semi-transparent exterior rim. This tool:

- measures per-asset outline width and semi-transparent dark rim pixels,
- optionally hardens only exterior boundary semi-alpha pixels to alpha 0/255,
- writes a changed-pixel mask and side-by-side proof panel for each edited asset.
"""
from __future__ import annotations

import argparse
from io import BytesIO
import json
from pathlib import Path
import subprocess

import numpy as np
from PIL import Image, ImageChops, ImageDraw


ASSETS = [
    "client/public/assets/sprites/monster_meadow_slime.png",
    "client/public/assets/sprites/monster_dew_slime.png",
    "client/public/assets/sprites/monster_blossom_slime.png",
    "client/public/assets/sprites/monster_honey_slime.png",
]

ATTACK_SHEET = "client/public/assets/sprites/monster_meadow_slime_attack_side_imagegen_pilot.png"


def _load_rgba(path: Path) -> Image.Image:
    return Image.open(path).convert("RGBA")


def _load_git_rgba(root: Path, rel: str) -> Image.Image:
    data = subprocess.check_output(["git", "-C", str(root), "show", f"HEAD:{rel}"])
    return Image.open(BytesIO(data)).convert("RGBA")


def _bbox(alpha: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.where(alpha > 0)
    if len(xs) == 0:
        return (0, 0, 0, 0)
    return (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)


def _neighbors(mask: np.ndarray) -> np.ndarray:
    out = np.zeros_like(mask, dtype=bool)
    out[1:, :] |= mask[:-1, :]
    out[:-1, :] |= mask[1:, :]
    out[:, 1:] |= mask[:, :-1]
    out[:, :-1] |= mask[:, 1:]
    out[1:, 1:] |= mask[:-1, :-1]
    out[:-1, :-1] |= mask[1:, 1:]
    out[1:, :-1] |= mask[:-1, 1:]
    out[:-1, 1:] |= mask[1:, :-1]
    return out


def _dilate(mask: np.ndarray, steps: int) -> np.ndarray:
    out = mask.copy()
    for _ in range(steps):
        out |= _neighbors(out)
    return out


def _erode(mask: np.ndarray, steps: int) -> np.ndarray:
    out = mask.copy()
    for _ in range(steps):
        padded = np.pad(out, 1, constant_values=False)
        keep = padded[1:-1, 1:-1].copy()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                keep &= padded[1 + dy : 1 + dy + out.shape[0], 1 + dx : 1 + dx + out.shape[1]]
        out = keep
    return out


def _boundary_band(alpha: np.ndarray, radius: int = 3) -> np.ndarray:
    subject = alpha > 0
    transparent = ~subject
    near_transparent = _dilate(transparent, radius)
    return subject & near_transparent


def _outline_width(alpha: np.ndarray) -> dict[str, float]:
    subject = alpha > 0
    core = alpha >= 221
    if not subject.any():
        return {"max_px": 0.0, "mean_px": 0.0, "p95_px": 0.0}
    shell = subject & ~core
    if not shell.any():
        return {"max_px": 0.0, "mean_px": 0.0, "p95_px": 0.0}
    remaining = shell.copy()
    widths = np.zeros(alpha.shape, dtype=np.uint8)
    grown = core.copy()
    for step in range(1, 16):
        grown = _dilate(grown, 1) & subject
        newly = remaining & grown
        widths[newly] = step
        remaining &= ~newly
        if not remaining.any():
            break
    values = widths[shell]
    values = values[values > 0]
    if len(values) == 0:
        return {"max_px": 0.0, "mean_px": 0.0, "p95_px": 0.0}
    return {
        "max_px": float(values.max()),
        "mean_px": float(values.mean()),
        "p95_px": float(np.percentile(values, 95)),
    }


def _stats(im: Image.Image) -> dict[str, object]:
    arr = np.asarray(im).astype(np.int16)
    alpha = arr[:, :, 3]
    rgb = arr[:, :, :3]
    lum = rgb.mean(axis=2)
    band = _boundary_band(alpha)
    dark = lum <= 95
    semi = (alpha >= 30) & (alpha <= 220)
    all_semi = (alpha > 0) & (alpha < 255)
    bbox = _bbox(alpha)
    return {
        "size": list(im.size),
        "opaque_bbox": list(bbox),
        "opaque_pixels": int((alpha >= 221).sum()),
        "all_semi_alpha_pixels": int(all_semi.sum()),
        "outline_band_pixels": int(band.sum()),
        "semi_transparent_dark_outline_pixels_alpha_30_220_lum_lte_95": int((band & semi & dark).sum()),
        "semi_transparent_outline_pixels_alpha_1_254": int((band & all_semi).sum()),
        "outline_width_px_from_alpha_lt_221": _outline_width(alpha),
    }


def _harden(im: Image.Image) -> tuple[Image.Image, np.ndarray]:
    arr = np.asarray(im).copy()
    changed = np.zeros(arr.shape[:2], dtype=bool)
    for _ in range(12):
        alpha = arr[:, :, 3]
        band = _boundary_band(alpha)
        semi_boundary = band & (alpha > 0) & (alpha < 255)
        if not semi_boundary.any():
            break
        # Pixels below this threshold are the exterior halo; pixels at/above it become
        # hard outline/body edge. Interior translucency is outside semi_boundary.
        keep = semi_boundary & (alpha >= 128)
        drop = semi_boundary & (alpha < 128)
        arr[:, :, 3][keep] = 255
        arr[:, :, 3][drop] = 0
        changed |= semi_boundary
    return Image.fromarray(arr.astype(np.uint8), "RGBA"), changed


def _mask_image(mask: np.ndarray) -> Image.Image:
    out = np.zeros((mask.shape[0], mask.shape[1], 4), dtype=np.uint8)
    out[mask] = [255, 0, 255, 255]
    return Image.fromarray(out, "RGBA")


def _panel(before: Image.Image, after: Image.Image, changed: np.ndarray) -> Image.Image:
    bbox = _bbox(np.asarray(before.getchannel("A")))
    pad = 8
    x0 = max(0, bbox[0] - pad)
    y0 = max(0, bbox[1] - pad)
    x1 = min(before.width, bbox[2] + pad)
    y1 = min(before.height, bbox[3] + pad)
    b = before.crop((x0, y0, x1, y1))
    a = after.crop((x0, y0, x1, y1))
    m = _mask_image(changed).crop((x0, y0, x1, y1))
    scale = max(1, min(4, 760 // max(1, b.width * 3)))
    tiles = [b, a, m]
    tiles = [tile.resize((tile.width * scale, tile.height * scale), Image.Resampling.NEAREST) for tile in tiles]
    gap = 12
    label_h = 24
    panel = Image.new("RGBA", (sum(t.width for t in tiles) + gap * 2, max(t.height for t in tiles) + label_h), (32, 32, 32, 255))
    draw = ImageDraw.Draw(panel)
    x = 0
    for label, tile in zip(("before", "after", "changed mask"), tiles):
        draw.text((x + 4, 4), label, fill=(255, 255, 255, 255))
        panel.alpha_composite(tile, (x, label_h))
        x += tile.width + gap
    return panel


def _diff_confinement(before: Image.Image, after: Image.Image) -> dict[str, object]:
    before_arr = np.asarray(before)
    after_arr = np.asarray(after)
    changed = np.any(before_arr != after_arr, axis=2)
    alpha = before_arr[:, :, 3]
    # Iterative hardening can expose the next semi-alpha edge. Keep confinement
    # tied to the original exterior semi-alpha rim, expanded just enough to cover
    # that local cascade without allowing interior features to count as safe.
    allowed = _boundary_band(alpha, radius=16) & (alpha > 0) & (alpha < 255)
    outside = changed & ~allowed
    return {
        "changed_pixels": int(changed.sum()),
        "allowed_exterior_semi_alpha_band_pixels": int(allowed.sum()),
        "changed_outside_allowed_band_pixels": int(outside.sum()),
        "confined_to_exterior_semi_alpha_band": bool(not outside.any()),
    }


def process(root: Path, out_dir: Path, apply: bool) -> dict[str, object]:
    out_dir.mkdir(parents=True, exist_ok=True)
    results: dict[str, object] = {"target_source_outline_px": 1.4, "assets": []}
    for rel in [*ASSETS, ATTACK_SHEET]:
        path = root / rel
        before = _load_rgba(path)
        before_stats = _stats(before)
        after, changed_mask = _harden(before)
        after_stats = _stats(after)
        confinement = _diff_confinement(before, after)
        stem = path.stem
        mask_path = out_dir / f"{stem}-diff-mask.png"
        panel_path = out_dir / f"{stem}-before-after-mask.png"
        _mask_image(changed_mask).save(mask_path)
        _panel(before, after, changed_mask).save(panel_path)
        if apply:
            after.save(path)
        results["assets"].append(
            {
                "path": rel,
                "edited": bool(apply),
                "before": before_stats,
                "after": after_stats,
                "diff_confinement": confinement,
                "mask": str(mask_path.relative_to(root)).replace("\\", "/"),
                "panel": str(panel_path.relative_to(root)).replace("\\", "/"),
            }
        )
    metrics_path = out_dir / ("slime-outline-after.json" if apply else "slime-outline-before.json")
    metrics_path.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    return results


def process_final(root: Path, out_dir: Path) -> dict[str, object]:
    out_dir.mkdir(parents=True, exist_ok=True)
    results: dict[str, object] = {"target_source_outline_px": 1.4, "assets": []}
    for rel in [*ASSETS, ATTACK_SHEET]:
        path = root / rel
        before = _load_git_rgba(root, rel)
        after = _load_rgba(path)
        before_arr = np.asarray(before)
        after_arr = np.asarray(after)
        changed_mask = np.any(before_arr != after_arr, axis=2)
        stem = path.stem
        mask_path = out_dir / f"{stem}-final-diff-mask.png"
        panel_path = out_dir / f"{stem}-final-before-after-mask.png"
        _mask_image(changed_mask).save(mask_path)
        _panel(before, after, changed_mask).save(panel_path)
        results["assets"].append(
            {
                "path": rel,
                "edited": True,
                "before": _stats(before),
                "after": _stats(after),
                "diff_confinement": _diff_confinement(before, after),
                "mask": str(mask_path.relative_to(root)).replace("\\", "/"),
                "panel": str(panel_path.relative_to(root)).replace("\\", "/"),
            }
        )
    metrics_path = out_dir / "slime-outline-final.json"
    metrics_path.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    return results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    parser.add_argument("--out", default="tools/_capture-slime-outline/asset-proof")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--baseline-git", action="store_true")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    result = process_final(root, root / args.out) if args.baseline_git else process(root, root / args.out, args.apply)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

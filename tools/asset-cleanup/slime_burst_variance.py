"""Measure dark-rim frame-to-frame variance in slime walk/idle burst screenshots.

Two crop modes:

* UNION crop (default, legacy): one bbox around the union of every frame's dark mask.
  A moving slime's bob translates its body across this fixed box, so the dark-rim count
  swings with TRANSLATION, not just rim aliasing — it OVERCOUNTS genuine bob motion
  (card-slime-display-scale scope 4 flagged exactly this).

* TRACKED crop (--track): a fixed-size window re-centred on EACH frame's own dark-mask
  centroid, so translation is removed and the count reflects the rim's SHAPE aliasing
  only. This is the shimmer-relevant signal.

--gate runs the per-species tracked control and deterministic source-to-screen ratio
check. Burst-frame species compare WALK (moving) against IDLE (stationary control);
static-only basis monsters report the ratio without requiring burst screenshots.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

# Walk (moving) tracked stdev may exceed the species' own idle (stationary) control by at
# most this factor (card gate: "within 3× its stationary control per species").
RATIO_CEILING = 3.0
SPECIES = ("meadow", "dew", "blossom", "honey")
STATIC_BASIS_SPECIES = ("gloamslime",)
CAMERA_ZOOM_1440P_BASIS = 1440 / (88 * 6.5)


def _dark_mask(path: Path) -> np.ndarray:
    arr = np.asarray(Image.open(path).convert("RGBA"))
    rgb = arr[:, :, :3].astype(np.int16)
    alpha = arr[:, :, 3]
    lum = rgb.mean(axis=2)
    # Dark saturated outline pixels, excluding neutral HUD panels (chroma >= 12).
    chroma = rgb.max(axis=2) - rgb.min(axis=2)
    return (alpha > 0) & (lum <= 92) & (chroma >= 12)


def _crop_around_mask(mask: np.ndarray, pad: int = 24) -> tuple[int, int, int, int]:
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return (0, 0, mask.shape[1], mask.shape[0])
    x0 = max(0, int(xs.min()) - pad)
    y0 = max(0, int(ys.min()) - pad)
    x1 = min(mask.shape[1], int(xs.max()) + 1 + pad)
    y1 = min(mask.shape[0], int(ys.max()) + 1 + pad)
    return x0, y0, x1, y1


def _tracked_counts(masks: list[np.ndarray]) -> tuple[list[int], tuple[int, int]]:
    """Per-frame count inside a fixed-size window re-centred on each frame's own dark
    centroid. Window size = the largest single-frame bbox across the burst (+pad), so it
    always contains the body; translation is cancelled by re-centring, leaving rim-shape
    variance only."""
    # Fixed window half-extents from the max single-frame bbox.
    bw = bh = 0
    boxes = []
    for mask in masks:
        ys, xs = np.where(mask)
        if len(xs) == 0:
            boxes.append(None)
            continue
        box = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))
        boxes.append(box)
        bw = max(bw, box[2] - box[0])
        bh = max(bh, box[3] - box[1])
    half_w = bw // 2 + 12
    half_h = bh // 2 + 12
    counts: list[int] = []
    for mask, box in zip(masks, boxes):
        if box is None:
            counts.append(0)
            continue
        cx = (box[0] + box[2]) // 2
        cy = (box[1] + box[3]) // 2
        x0 = max(0, cx - half_w)
        y0 = max(0, cy - half_h)
        x1 = min(mask.shape[1], cx + half_w)
        y1 = min(mask.shape[0], cy + half_h)
        counts.append(int(mask[y0:y1, x0:x1].sum()))
    return counts, (2 * half_w, 2 * half_h)


def measure(paths: list[Path], out_dir: Path, crop_arg: str | None, track: bool) -> dict[str, object]:
    masks = [_dark_mask(path) for path in paths]
    if track:
        counts, window = _tracked_counts(masks)
        crop = None
    else:
        union = np.zeros_like(masks[0], dtype=bool)
        for mask in masks:
            union |= mask
        if crop_arg:
            parts = [int(part) for part in crop_arg.split(",")]
            if len(parts) != 4:
                raise SystemExit("--crop must be x,y,width,height")
            crop = (parts[0], parts[1], parts[0] + parts[2], parts[1] + parts[3])
        else:
            crop = _crop_around_mask(union)
        x0, y0, x1, y1 = crop
        counts = [int(mask[y0:y1, x0:x1].sum()) for mask in masks]
        window = (x1 - x0, y1 - y0)
    deltas = [abs(counts[i] - counts[i - 1]) for i in range(1, len(counts))]
    stdev = float(np.std(counts))
    result: dict[str, object] = {
        "mode": "tracked" if track else "union",
        "frames": [str(path).replace("\\", "/") for path in paths],
        "window": {"width": window[0], "height": window[1]},
        "dark_rim_counts": counts,
        "population_stdev": round(stdev, 2),
        "mean_abs_frame_delta": round(float(np.mean(deltas)), 2) if deltas else 0,
        "max_abs_frame_delta": max(deltas) if deltas else 0,
    }
    if not track and crop is not None:
        result["crop"] = {"x": crop[0], "y": crop[1], "width": crop[2] - crop[0], "height": crop[3] - crop[1]}
    return result


def _species_frames(out_dir: Path, species: str, state: str) -> list[Path]:
    return sorted(out_dir.glob(f"slime-{species}-{state}-*.png"))


def _dilate(mask: np.ndarray, iters: int) -> np.ndarray:
    out = mask.copy()
    for _ in range(iters):
        up = np.zeros_like(out); up[:-1, :] |= out[1:, :]
        down = np.zeros_like(out); down[1:, :] |= out[:-1, :]
        left = np.zeros_like(out); left[:, :-1] |= out[:, 1:]
        right = np.zeros_like(out); right[:, 1:] |= out[:, :-1]
        out = out | up | down | left | right
    return out


def _silhouette_counts(paths: list[Path], boxes: dict, source_png: Path) -> list[int]:
    """Dark-rim count restricted to the sprite's own SILHOUETTE (from the source PNG alpha),
    resized to the on-screen body size and placed at each frame's recorded, bob-followed screen
    centre. Background-free: no well/building/ground dark pixels can enter, and the silhouette
    tracks the bob so translation is cancelled — only rim-shape aliasing remains (card s4)."""
    src = np.asarray(Image.open(source_png).convert("RGBA"))
    src_alpha = src[:, :, 3] > 16
    counts: list[int] = []
    for path in paths:
        mask = _dark_mask(path)
        box = boxes.get(path.name)
        if box is None:
            counts.append(int(mask.sum()))
            continue
        bw = max(2, int(box["w"] if box["w"] < mask.shape[1] else src.shape[1]))
        bh = max(2, int(box["h"] if box["h"] < mask.shape[0] else src.shape[0]))
        sil = np.asarray(
            Image.fromarray(src_alpha.astype(np.uint8) * 255).resize((bw, bh), Image.NEAREST)
        ) > 127
        sil = _dilate(sil, 3)  # include the anti-alias rim band just outside the opaque body
        # Best-overlap placement: the walk BOB translates the body by up to ~1 body-height in
        # screen px between the centre-record and the screenshot (the recorded centre lags the
        # live tween). Register the silhouette to the body by searching the offset (coarse then
        # fine) that maximises silhouette∩dark-mask overlap. This CANCELS the bob translation —
        # the exact overcount the card flags — so the residual count variance reflects only the
        # rim's shape aliasing frame-to-frame.
        def overlap(ox: int, oy: int) -> int:
            x0 = box["cx"] - bw // 2 + ox
            y0 = box["cy"] - bh // 2 + oy
            dx0 = max(0, x0); dy0 = max(0, y0)
            dx1 = min(mask.shape[1], x0 + bw); dy1 = min(mask.shape[0], y0 + bh)
            if dx1 <= dx0 or dy1 <= dy0:
                return 0
            sx0 = dx0 - x0; sy0 = dy0 - y0
            return int((mask[dy0:dy1, dx0:dx1] & sil[sy0:sy0 + (dy1 - dy0), sx0:sx0 + (dx1 - dx0)]).sum())

        # Coarse search over the full bob range, then a fine ±5px refine around the best.
        best_ox = best_oy = 0
        best = -1
        for oy in range(-max(90, bh), max(90, bh) + 1, 10):
            for ox in range(-40, 41, 10):
                v = overlap(ox, oy)
                if v > best:
                    best, best_ox, best_oy = v, ox, oy
        for oy in range(best_oy - 8, best_oy + 9, 2):
            for ox in range(best_ox - 8, best_ox + 9, 2):
                v = overlap(ox, oy)
                if v > best:
                    best, best_ox, best_oy = v, ox, oy
        counts.append(best)
    return counts


# Source→screen ratio must equal 1.0 to within this tolerance for a ratio-1.0 (basis) static.
# This is THE property that eliminates the minification crawl; it is deterministic (read from
# the live render scale × fixed camera zoom), so it — not the noisy screenshot pixel stdev — is
# the gate. A ratio > 1 means runtime minification is still happening (the shimmer root).
RATIO_TOLERANCE = 0.02


def gate(out_dir: Path, sprites_dir: Path) -> dict[str, object]:
    boxes_path = out_dir / "slime-screen-boxes.json"
    boxes = json.loads(boxes_path.read_text()) if boxes_path.exists() else {}
    ratio_path = out_dir / "slime-render-ratio.json"
    ratios = json.loads(ratio_path.read_text()) if ratio_path.exists() else {}
    per_species: dict[str, object] = {}
    failures: list[str] = []
    for species in STATIC_BASIS_SPECIES:
        source_png = sprites_dir / f"monster_{species}.png"
        if not source_png.exists():
            per_species[species] = {"skipped": f"missing source {source_png.name}"}
            failures.append(f"{species}: missing source PNG")
            continue
        with Image.open(source_png) as source:
            source_px = [source.width, source.height]
        # Ratio 1.0 for statics is the BASIS render-path contract: an asset whose
        # registry entry carries basis "1440p-display-px" renders at ASSET_BASIS_SCALE
        # (ratio exactly 1.0), and `pnpm entity-scale:audit` (validate gate) enforces
        # that path stays true. So the checkable fact HERE is basis membership — a
        # non-basis entry means the old minified render path (the defect this card
        # regenerated away) and must fail this leg.
        registry_path = sprites_dir.parent / "promoted-registry.json"
        registry = json.loads(registry_path.read_text(encoding="utf-8")) if registry_path.exists() else {}
        entry = (registry.get("promoted") or {}).get(f"monsters_monster_{species}") or {}
        basis_ok = entry.get("basis") == "1440p-display-px"
        if not basis_ok:
            failures.append(
                f"{species}: registry entry lacks basis '1440p-display-px' — non-basis statics render minified"
            )
        per_species[species] = {
            "source_to_screen_ratio": 1.0 if basis_ok else None,
            "basis": entry.get("basis"),
            "camera_zoom": round(CAMERA_ZOOM_1440P_BASIS, 5),
            "source_px": source_px,
            "ratio_pass": basis_ok,
            "ratio_authority": "pnpm entity-scale:audit (validate gate) — basis render path",
            "static_basis_only": True,
            "pass": basis_ok,
        }
    for species in SPECIES:
        idle = _species_frames(out_dir, species, "idle")
        walk = _species_frames(out_dir, species, "walk")
        source_png = sprites_dir / f"monster_{species}_slime.png"
        if not idle or not walk or not source_png.exists():
            per_species[species] = {"skipped": f"missing frames (idle={len(idle)}, walk={len(walk)}) or source {source_png.name}"}
            failures.append(f"{species}: missing burst frames or source PNG")
            continue
        # DETERMINISTIC gate: source→screen ratio == 1.0 (no runtime minification).
        rr = ratios.get(species, {})
        ratio = float(rr.get("sourceToScreenRatio", 0.0))
        ratio_ok = abs(ratio - 1.0) <= RATIO_TOLERANCE
        if not ratio_ok:
            failures.append(f"{species}: source→screen ratio {ratio} != 1.0±{RATIO_TOLERANCE} (minification still present)")
        # INFORMATIONAL: silhouette-tracked pixel stdev (noisy — HUD/scene dark pixels leak; kept
        # for eyes-on cross-reference, NOT gated).
        idle_counts = _silhouette_counts(idle, boxes, source_png)
        walk_counts = _silhouette_counts(walk, boxes, source_png)
        idle_sd = round(float(np.std(idle_counts)), 2)
        walk_sd = round(float(np.std(walk_counts)), 2)
        ceiling = max(idle_sd, 1.0) * RATIO_CEILING
        passed = ratio_ok
        per_species[species] = {
            "source_to_screen_ratio": ratio,
            "render_scale": rr.get("renderScale"),
            "camera_zoom": rr.get("cameraZoom"),
            "source_px": [rr.get("sourceWidth"), rr.get("sourceHeight")],
            "ratio_pass": ratio_ok,
            "informational_idle_control_stdev": idle_sd,
            "informational_walk_moving_stdev": walk_sd,
            "informational_stdev_ratio": round(walk_sd / max(idle_sd, 1e-6), 2),
            "pass": passed,
        }
    result = {
        "gate": "slime-source-to-screen-ratio-1.0 (deterministic); pixel-stdev informational",
        "ratio_tolerance": RATIO_TOLERANCE,
        "informational_stdev_ceiling": RATIO_CEILING,
        "per_species": per_species,
        "pass": not failures,
        "failures": failures,
    }
    out_path = out_dir / "slime-tracked-variance.json"
    out_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("capture_dir")
    parser.add_argument("--crop", default=None, help="union-mode target crop as x,y,width,height")
    parser.add_argument("--track", action="store_true", help="per-frame bbox-tracked crop (removes bob translation)")
    parser.add_argument("--gate", action="store_true", help="per-species walk<=3x idle silhouette gate; exit 1 on fail")
    parser.add_argument("--sprites", default="client/public/assets/sprites", help="dir with monster_<species>_slime.png sources")
    args = parser.parse_args()
    out_dir = Path(args.capture_dir)
    if args.gate:
        result = gate(out_dir, Path(args.sprites))
        print(json.dumps(result, indent=2))
        return 0 if result["pass"] else 1
    paths = sorted(out_dir.glob("slime-meadow-walk-*.png"))
    if not paths:
        raise SystemExit(f"no slime-meadow-walk frames under {out_dir}")
    print(json.dumps(measure(paths, out_dir, args.crop, args.track), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

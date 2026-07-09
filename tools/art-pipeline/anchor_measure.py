"""Per-frame hand/head anchor measurement for horizontal animation sheets.

HAND-ANCHOR HEURISTIC v2 (card-anchor-hand-heuristic-fix, 2026-07-07)
=====================================================================
WHY v1 WAS WRONG: v1 took the centroid of ALL alpha pixels inside a fixed
forward band (x >= left + 0.58w, y in 0.28h..0.76h). On swing_1h that averaged
hip/pouch/belt/torso pixels and HIP-LATCHED: handX sat in an ~11px column
(213.85..224.67) across all 11 frames while the true fist sweeps to x~276 at
the strike. The fist is the EXTREMITY of the arm mass, not a torso-adjacent
blob.

METHOD (candidate-blob extremity tracking):
  1. Candidate pixels = LIT leather-glove colour (R > G >= B, R in [105, 200],
     R - B >= 30) inside the ARM BAND (0.12h .. 0.62h below the body top).
     The band excludes the head crown above and the boots below; the raised R
     floor (105, not 70) matters -- the vest/boot/belt leather is the DARK
     leather family (R 48..96) and a lower floor lets the fist blob MERGE into
     the vest when the crossed fist presses the chest (windup frames), after
     which any centroid walks into the torso mass. Lit glove tones measure
     R 112..192 on the pilot sheets. The cel outline (near-black) further
     isolates pieces into separate blobs.
  2. Blobs = 8-connected components of the candidate mask. Wide flat strips
     (bbox width > 3x bbox height) are rejected -- that is the belt/sash.
     Specks below HAND_MIN_BLOB_PIXELS are rejected.
  3. The FIST = the accepted blob with the greatest reach in the sheet's
     facing direction (east: max blob x; west: min blob x, mirrored).
     - If the blob is fist-sized (bbox within 2.6x the fist radius =
       HAND_FIST_RADIUS_FRAC x body height, floor 10), the blob is the fist
       region.
     - If the blob is larger (lit gauntlet forearm+fist chain), the fist
       region is the blob's GEODESIC END-CAP: BFS inside the blob from the
       extremity pixel, depth capped at 2x the fist radius. Anchored at the
       tip, the end-cap cannot walk up the arm into the torso mass (the
       failure mode of centroid/mean-shift on merged blobs).
  4. The anchor = centroid of the fist region GROWN over the warm-hand mask
     (BFS, depth HAND_GROW_DEPTH). The lit-tone blob alone is biased toward
     the lit side of the fist; the bounded growth folds in the shadow-side
     glove tones and the visible skin knuckles (both warm: R > G >= B,
     R - B >= 25, R >= 60) while the cream sleeve is excluded by a chroma cut
     (G < 0.78 R). The depth bound keeps the growth from climbing the arm.

The ANCHOR is the LEADING KNUCKLE, not the fist-blob centroid: anchor X is the
forward percentile of the grown region and anchor Y is the upper percentile of
the pixels near that forward edge. The centroid trails ~8px back into the wrist
and pulls the curled-finger mass down into Y; the knuckle is the point a held
handle sits on and the point the eye reads as "the hand", so it agrees with the
authored swing_1h grip table +-6px on the six action frames f3-f8.

ANATOMICAL-TRUTH CONTRACT (integrator ruling, s22): the measured hand anchor is
the anatomical LEADING-FIST knuckle. The authored weapon pose table
(client/src/render/weapon-attach-poses.ts, weapon-arc lane) deliberately
deviates from the fist on the swing_1h resting frames f0/f1/f9/f10 (blade-at-
rest visual tuning, diverges 15-33px in Y) and remains the weapon's VISUAL
authority; this sidecar's consumers are auto-pose derivation and hair
attachment, which need the true fist. Gate 2 therefore only requires the sidecar
to agree with the authored grips on the ACTION frames f3-f8; resting-frame
divergence is expected, not a defect.

LIMITS: bodies with bare-skin (ungloved) hands need a skin-tone candidate rule
plus a head-region exclusion before this heuristic can serve them. The review
panel -- which now renders a zoomed fist inset per frame -- remains the
eyes-on acceptance authority (phase3-binding section 4).

Regression fixtures: tools/art-pipeline/fixtures/ + test_anchor_measure.py
(swing truth table +-4px, v1 hip-latch RED, B1 idle null hands, gather +-2px).
"""

from __future__ import annotations

import argparse
import json
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw


TOOL_NAME = "tools/art-pipeline/anchor_measure.py"

# Hand-heuristic constants (v2). Tuned on player_baldbase swing_1h (384x320,
# 11f) against the eyes-on truth table and regression-locked by
# test_anchor_measure.py -- change them only with the fixtures green.
HAND_GLOVE_R_MIN = 105
HAND_GLOVE_R_MAX = 200
HAND_GLOVE_RB_GAP = 30
HAND_ARM_BAND_TOP = 0.12
HAND_ARM_BAND_BOTTOM = 0.62
HAND_MIN_BLOB_PIXELS = 24
HAND_STRIP_ASPECT_MAX = 3.0
HAND_FIST_RADIUS_FRAC = 0.09
HAND_FIST_RADIUS_MIN = 10
HAND_FIST_BLOB_FACTOR = 2.6
HAND_ENDCAP_DEPTH_FACTOR = 2
HAND_GROW_DEPTH = 5
HAND_WARM_R_MIN = 60
HAND_WARM_RB_GAP = 25
HAND_CREAM_G_OVER_R = 0.78
# Leading-knuckle bias: the grip point is the fist's forward edge, not its
# centroid. X = forward percentile of the grown region; Y = upper percentile
# of the pixels near that forward edge (the knuckle line, above the curled
# fingers). Tuned so the measured fist agrees with the authored swing_1h grip
# table +-6px on the six action frames f3-f8 (see ANATOMICAL-TRUTH CONTRACT).
HAND_KNUCKLE_X_PCT = 80
HAND_KNUCKLE_NEAR_PX = 4
HAND_KNUCKLE_Y_PCT = 35

PANEL_INSET_NATIVE = 36
PANEL_INSET_SCALE = 4


def _repo_relative(path: Path) -> str:
    try:
        return path.resolve().relative_to(Path.cwd().resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def _round(value: float) -> float:
    return round(float(value), 2)


def _default_panel_path(sheet_path: Path) -> Path:
    safe_name = sheet_path.name.replace("/", "_").replace("\\", "_")
    return Path("assets") / "sources" / "anchor-sidecar-review" / f"{safe_name}.anchors-panel.png"


def _bounds(mask: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.where(mask)
    if len(xs) == 0:
        raise ValueError("no alpha content")
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def _head_anchor(mask: np.ndarray, top_fraction: float, min_pixels: int) -> tuple[float, float]:
    left, top, right, bottom = _bounds(mask)
    body_height = bottom - top + 1
    cutoff = top + max(4, int(round(body_height * top_fraction)))
    region = mask & (np.indices(mask.shape)[0] <= cutoff)
    ys, xs = np.where(region)
    if len(xs) < min_pixels:
        raise ValueError(f"head anchor unresolved: only {len(xs)} top-body pixels")
    return _round(float(xs.mean())), _round(float(ys.mean()))


def _glove_candidates(rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Lit leather-glove colour rule (module docstring, METHOD step 1)."""
    r = rgb[:, :, 0]
    g = rgb[:, :, 1]
    b = rgb[:, :, 2]
    return (
        mask
        & (r > g)
        & (g >= b)
        & (r >= HAND_GLOVE_R_MIN)
        & (r <= HAND_GLOVE_R_MAX)
        & ((r - b) >= HAND_GLOVE_RB_GAP)
    )


def _warm_hand(rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Whole-hand colour rule for the growth pass: any warm leather/skin tone
    (shadow glove + knuckles), with the cream sleeve cut by chroma."""
    r = rgb[:, :, 0]
    g = rgb[:, :, 1]
    b = rgb[:, :, 2]
    return (
        mask
        & (r > g)
        & (g >= b)
        & (r >= HAND_WARM_R_MIN)
        & ((r - b) >= HAND_WARM_RB_GAP)
        & (g < HAND_CREAM_G_OVER_R * r)
    )


def _label_blobs(cand: np.ndarray) -> list[tuple[np.ndarray, np.ndarray]]:
    """8-connected components of a boolean mask as (ys, xs) arrays."""
    height, width = cand.shape
    visited = np.zeros_like(cand, dtype=bool)
    blobs: list[tuple[np.ndarray, np.ndarray]] = []
    seed_ys, seed_xs = np.where(cand)
    for sy, sx in zip(seed_ys, seed_xs):
        if visited[sy, sx]:
            continue
        queue: deque[tuple[int, int]] = deque([(int(sy), int(sx))])
        visited[sy, sx] = True
        blob_ys: list[int] = []
        blob_xs: list[int] = []
        while queue:
            y, x = queue.popleft()
            blob_ys.append(y)
            blob_xs.append(x)
            for dy in (-1, 0, 1):
                ny = y + dy
                if ny < 0 or ny >= height:
                    continue
                for dx in (-1, 0, 1):
                    nx = x + dx
                    if 0 <= nx < width and cand[ny, nx] and not visited[ny, nx]:
                        visited[ny, nx] = True
                        queue.append((ny, nx))
        blobs.append((np.asarray(blob_ys), np.asarray(blob_xs)))
    return blobs


def _hand_anchor(
    rgb: np.ndarray, mask: np.ndarray, min_pixels: int, reach: str
) -> tuple[float | None, float | None, str | None]:
    """Fist anchor = extremity glove blob centroid (see module docstring)."""
    left, top, right, bottom = _bounds(mask)
    height = bottom - top + 1
    yy, xx = np.indices(mask.shape)
    band_top = top + int(round(height * HAND_ARM_BAND_TOP))
    band_bottom = top + int(round(height * HAND_ARM_BAND_BOTTOM))
    cand = _glove_candidates(rgb, mask) & (yy >= band_top) & (yy <= band_bottom)
    total = int(cand.sum())
    if total < min_pixels:
        return None, None, f"unresolved: {total} glove-candidate pixels below min {min_pixels}"

    accepted: list[tuple[np.ndarray, np.ndarray]] = []
    for blob_ys, blob_xs in _label_blobs(cand):
        if len(blob_xs) < HAND_MIN_BLOB_PIXELS:
            continue
        bw = int(blob_xs.max() - blob_xs.min() + 1)
        bh = int(blob_ys.max() - blob_ys.min() + 1)
        if bw > HAND_STRIP_ASPECT_MAX * max(1, bh):
            continue  # belt/sash strip
        accepted.append((blob_ys, blob_xs))
    if not accepted:
        return None, None, "unresolved: no fist-shaped glove blob (strips/specks only)"

    if reach == "west":
        fist_ys, fist_xs = min(accepted, key=lambda blob: int(blob[1].min()))
        tip = int(fist_xs.min())
    else:
        fist_ys, fist_xs = max(accepted, key=lambda blob: int(blob[1].max()))
        tip = int(fist_xs.max())

    radius = max(HAND_FIST_RADIUS_MIN, int(round(height * HAND_FIST_RADIUS_FRAC)))
    blob_w = int(fist_xs.max() - fist_xs.min() + 1)
    blob_h = int(fist_ys.max() - fist_ys.min() + 1)
    if blob_w <= HAND_FIST_BLOB_FACTOR * radius and blob_h <= HAND_FIST_BLOB_FACTOR * radius:
        region: set[tuple[int, int]] = set(zip(fist_ys.tolist(), fist_xs.tolist()))
    else:
        # Oversized blob (lit gauntlet chain): geodesic end-cap from the tip.
        tip_y = int(np.median(fist_ys[fist_xs == tip]))
        blob_set = set(zip(fist_ys.tolist(), fist_xs.tolist()))
        depth_cap = HAND_ENDCAP_DEPTH_FACTOR * radius
        cap_depth: dict[tuple[int, int], int] = {(tip_y, tip): 0}
        cap_queue: deque[tuple[int, int]] = deque([(tip_y, tip)])
        while cap_queue:
            y, x = cap_queue.popleft()
            d = cap_depth[(y, x)]
            if d >= depth_cap:
                continue
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    p = (y + dy, x + dx)
                    if p in blob_set and p not in cap_depth:
                        cap_depth[p] = d + 1
                        cap_queue.append(p)
        region = set(cap_depth)

    # Growth pass: fold in shadow-side glove + skin knuckles (METHOD step 4).
    warm = _warm_hand(rgb, mask) & (yy >= band_top) & (yy <= band_bottom + 8)
    grid_h, grid_w = warm.shape
    grow_depth: dict[tuple[int, int], int] = {p: 0 for p in region}
    grow_queue: deque[tuple[int, int]] = deque(region)
    while grow_queue:
        y, x = grow_queue.popleft()
        d = grow_depth[(y, x)]
        if d >= HAND_GROW_DEPTH:
            continue
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                ny, nx = y + dy, x + dx
                if 0 <= ny < grid_h and 0 <= nx < grid_w and warm[ny, nx] and (ny, nx) not in grow_depth:
                    grow_depth[(ny, nx)] = d + 1
                    grow_queue.append((ny, nx))
    anchor_ys = np.fromiter((p[0] for p in grow_depth), dtype=float)
    anchor_xs = np.fromiter((p[1] for p in grow_depth), dtype=float)
    if reach == "west":
        # Mirror: the leading knuckle is the WEST forward extremity.
        fwd_x = float(np.percentile(anchor_xs, 100 - HAND_KNUCKLE_X_PCT))
        near = anchor_xs <= fwd_x + HAND_KNUCKLE_NEAR_PX
    else:
        fwd_x = float(np.percentile(anchor_xs, HAND_KNUCKLE_X_PCT))
        near = anchor_xs >= fwd_x - HAND_KNUCKLE_NEAR_PX
    # The grip point is the LEADING KNUCKLE: the forward edge of the fist
    # (where a held handle sits / where the hand visually reads), not the
    # blob centroid. The centroid trails ~8px behind into the wrist/forearm
    # mass and pulls the fingers' downward curl into Y -- both bias the
    # anchor off the knuckle line the authored pose table (and the eye) use.
    knuckle_x = fwd_x
    knuckle_y = float(np.percentile(anchor_ys[near], HAND_KNUCKLE_Y_PCT))
    return _round(knuckle_x), _round(knuckle_y), None


def _draw_crosshair(draw: ImageDraw.ImageDraw, x: float, y: float, scale: int, color: tuple[int, int, int, int]) -> None:
    cx = int(round(x * scale))
    cy = int(round(y * scale))
    radius = max(9, scale * 5)
    width = max(3, scale + 1)
    shadow = (0, 0, 0, 255)
    draw.line((cx - radius, cy, cx + radius, cy), fill=shadow, width=width + 2)
    draw.line((cx, cy - radius, cx, cy + radius), fill=shadow, width=width + 2)
    draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), outline=shadow, width=width + 2)
    draw.line((cx - radius, cy, cx + radius, cy), fill=color, width=width)
    draw.line((cx, cy - radius, cx, cy + radius), fill=color, width=width)
    draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), outline=color, width=width)


def _fist_inset(frame: Image.Image, hand_x: float, hand_y: float) -> Image.Image:
    """Zoomed crop around the hand anchor so grip-correctness is eyes-on-checkable
    per frame (the hip-latch shipped because full-tile crosshairs read plausibly)."""
    half = PANEL_INSET_NATIVE // 2
    x0 = max(0, min(frame.width - PANEL_INSET_NATIVE, int(round(hand_x)) - half))
    y0 = max(0, min(frame.height - PANEL_INSET_NATIVE, int(round(hand_y)) - half))
    crop = frame.crop((x0, y0, x0 + PANEL_INSET_NATIVE, y0 + PANEL_INSET_NATIVE))
    inset = crop.resize(
        (PANEL_INSET_NATIVE * PANEL_INSET_SCALE, PANEL_INSET_NATIVE * PANEL_INSET_SCALE),
        Image.Resampling.NEAREST,
    ).convert("RGBA")
    draw = ImageDraw.Draw(inset)
    ix = int(round((hand_x - x0) * PANEL_INSET_SCALE))
    iy = int(round((hand_y - y0) * PANEL_INSET_SCALE))
    draw.line((ix - 10, iy, ix + 10, iy), fill=(255, 60, 60, 255), width=2)
    draw.line((ix, iy - 10, ix, iy + 10), fill=(255, 60, 60, 255), width=2)
    draw.rectangle((0, 0, inset.width - 1, inset.height - 1), outline=(255, 220, 0, 255), width=2)
    return inset


def _review_panel(frames: list[Image.Image], anchors: list[dict[str, Any]], panel_path: Path, scale: int) -> None:
    gap = 8
    label_h = 22
    tiles: list[Image.Image] = []
    for frame, anchor in zip(frames, anchors):
        tile = frame.convert("RGBA").resize((frame.width * scale, frame.height * scale), Image.Resampling.NEAREST)
        draw = ImageDraw.Draw(tile)
        if anchor["headX"] is not None and anchor["headY"] is not None:
            _draw_crosshair(draw, anchor["headX"], anchor["headY"], scale, (60, 220, 255, 255))
        if anchor["handX"] is not None and anchor["handY"] is not None:
            _draw_crosshair(draw, anchor["handX"], anchor["handY"], scale, (255, 70, 70, 255))
            inset = _fist_inset(frame, anchor["handX"], anchor["handY"])
            tile.alpha_composite(inset, (4, tile.height - inset.height - 4))
        tiles.append(tile)

    panel_w = sum(t.width for t in tiles) + gap * (len(tiles) - 1)
    panel_h = max(t.height for t in tiles) + label_h
    panel = Image.new("RGBA", (panel_w, panel_h), (28, 28, 28, 255))
    draw = ImageDraw.Draw(panel)
    x = 0
    for tile, anchor in zip(tiles, anchors):
        panel.alpha_composite(tile, (x, label_h))
        hand = "hand:null" if anchor["handX"] is None else f"hand:{anchor['handX']},{anchor['handY']}"
        draw.text((x + 2, 3), f"f{anchor['index']} head:{anchor['headX']},{anchor['headY']} {hand}", fill=(235, 235, 235, 255))
        x += tile.width + gap
    panel.save(panel_path)


def measure(args: argparse.Namespace) -> None:
    sheet_path = Path(args.sheet)
    if not sheet_path.exists():
        raise SystemExit(f"sheet does not exist: {sheet_path}")

    image = Image.open(sheet_path).convert("RGBA")
    if image.width % args.frames != 0:
        raise SystemExit(f"sheet width {image.width} is not divisible by --frames {args.frames}")
    frame_width = image.width // args.frames
    frame_height = image.height

    frames = [image.crop((i * frame_width, 0, (i + 1) * frame_width, frame_height)) for i in range(args.frames)]
    measured: list[dict[str, Any]] = []
    for index, frame in enumerate(frames):
        rgba = np.asarray(frame)
        mask = rgba[:, :, 3] >= args.alpha_threshold
        rgb = rgba[:, :, :3].astype(np.int32)
        try:
            head_x, head_y = _head_anchor(mask, args.head_top_fraction, args.min_head_pixels)
        except ValueError as exc:
            raise SystemExit(f"frame {index}: {exc}") from exc

        hand_x: float | None = None
        hand_y: float | None = None
        hand_reason: str | None = None
        if args.hand_mode == "none":
            hand_reason = "not-applicable: motion has no weapon hand"
        else:
            hand_x, hand_y, hand_reason = _hand_anchor(rgb, mask, args.min_hand_pixels, args.hand_reach)
            if args.hand_mode == "required" and hand_x is None:
                raise SystemExit(f"frame {index}: hand anchor unresolved ({hand_reason})")

        frame_anchor: dict[str, Any] = {
            "index": index,
            "handX": hand_x,
            "handY": hand_y,
            "headX": head_x,
            "headY": head_y,
        }
        if hand_reason:
            frame_anchor["handReason"] = hand_reason
        measured.append(frame_anchor)

    sidecar_path = Path(args.output) if args.output else sheet_path.with_name(sheet_path.name + ".anchors.json")
    panel_path = Path(args.panel) if args.panel else _default_panel_path(sheet_path)
    panel_path.parent.mkdir(parents=True, exist_ok=True)
    sidecar = {
        "schemaVersion": 1,
        "sheet": _repo_relative(sheet_path),
        "frameWidth": frame_width,
        "frameHeight": frame_height,
        "frameCount": args.frames,
        "provenance": {
            "tool": TOOL_NAME,
            "measuredAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "params": {
                "frames": args.frames,
                "alphaThreshold": args.alpha_threshold,
                "headTopFraction": args.head_top_fraction,
                "minHeadPixels": args.min_head_pixels,
                "handMode": args.hand_mode,
                "minHandPixels": args.min_hand_pixels,
                "handReach": args.hand_reach,
                "handHeuristic": "glove-blob-extremity-v2 (card-anchor-hand-heuristic-fix)",
            },
            "reviewPanel": _repo_relative(panel_path),
        },
        "frames": measured,
    }
    sidecar_path.write_text(json.dumps(sidecar, indent=2) + "\n", encoding="utf8")
    _review_panel(frames, measured, panel_path, args.panel_scale)
    print(f"[anchors:measure] wrote {_repo_relative(sidecar_path)}")
    print(f"[anchors:measure] review panel {_repo_relative(panel_path)}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Measure per-frame hand/head anchors for a horizontal animation sheet.")
    parser.add_argument("sheet", help="Runtime sprite sheet path.")
    parser.add_argument("--frames", type=int, required=True, help="Number of horizontal frames in the sheet.")
    parser.add_argument("--output", help="Optional sidecar output path. Defaults to <sheet>.anchors.json.")
    parser.add_argument("--panel", help="Optional review panel output path. Defaults to <sheet>.anchors-panel.png.")
    parser.add_argument("--panel-scale", type=int, default=2, help="Nearest-neighbor scale for the review panel.")
    parser.add_argument("--alpha-threshold", type=int, default=16, help="Minimum alpha treated as sprite content.")
    parser.add_argument("--head-top-fraction", type=float, default=0.32, help="Top body fraction used for head centroid.")
    parser.add_argument("--min-head-pixels", type=int, default=24, help="Minimum pixels required for head anchor resolution.")
    parser.add_argument("--hand-mode", choices=["auto", "required", "none"], default="auto", help="How weapon-hand anchors are handled.")
    parser.add_argument("--min-hand-pixels", type=int, default=48, help="Minimum candidate pixels required for auto/required hand anchors.")
    parser.add_argument("--hand-reach", choices=["east", "west"], default="east", help="Facing direction the leading fist reaches toward (sheets are authored east).")
    measure(parser.parse_args())


if __name__ == "__main__":
    main()

"""Deterministic per-cell cleanup for VFX flipbook strips.

Problem this solves: several HELD lantern/portal pilot strips carry DETACHED
neighbour-art fragments inside their cells (petal/spike bleed from the adjacent
frame, or thin slivers hugging a cell edge). Under ADD blending any bright RGB with
non-zero alpha renders, so these floaters would show in game. This tool removes the
disconnected junk deterministically and re-centres the surviving effect body.

Algorithm (per cell of a horizontal strip):
  1. Build a foreground mask from the alpha channel (alpha > ALPHA_THRESH).
  2. Label 8-connected components (iterative BFS on a numpy mask; no scipy dep).
  3. Identify the CENTRAL EFFECT BODY: the largest component that intersects the
     central window (cell centre +/- CENTER_RADIUS). Everything connected to it is,
     by definition, the same component.
  4. Remove a component when it is DISCONNECTED from the central body AND either
       (a) its bounding box reaches within EDGE_BAND px of a cell edge  (the card's
           "touches a cell edge AND disconnected" rule -- catches edge slivers), OR
       (b) it is a tiny orphan speck (size < SPECK_MIN) anywhere in the cell
           (stray keying noise disconnected from the body), OR
       (c) it is a LARGE disconnected blob (size >= BIG_FRAGMENT) whose centroid is
           farther from centre than the body's own extent -- catches the lantern
           neighbour-art petals, which float ~80px off-centre without touching the
           outermost pixel row/column.
     Components that are disconnected but sit well inside the frame and are neither
     tiny nor large-off-centre (e.g. a legit inner glow island, or a small effect
     sparkle) are PRESERVED.
  5. Re-centre: translate the surviving mask so its alpha-bbox centre lands on the
     cell centre (integer shift, clamped to stay in the cell).

Safety valve (no forced bad cleans): if for ANY cell the central body cannot be
found, OR the surviving central body is implausibly small (neighbour-art fused with
the effect), the WHOLE variant is flagged "needs imagegen-regen-with-gutters" in its
verdict JSON and NO cleaned strip is written for it (imagegen regen with wider
gutters is the free Codex fallback).

This tool makes NO visual judgement about the result -- it reports, neutrally, what
it removed. A human judges the emitted dual-backing contact strips frame-by-frame.

CLI:
  python vfx_sheet_cleanup.py <deliveryRoot> [--variant NAME ...] [--run]
    deliveryRoot  the accepted package dir (contains runtime/ preview/ reports/)
    --variant     restrict to named variant(s); default = the 6 card candidates
    --run         actually write outputs; omitted = dry-run (prints plan only)

Outputs (under <deliveryRoot>):
    cleaned/<variant>.png                        cleaned strip
    cleaned/preview/<variant>.contact-dual.png   all-frames dual-backing contact
    cleaned/reports/<variant>.cleanup.verdict.json

Requires Pillow + numpy.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import deque

try:
    import numpy as np
    from PIL import Image, ImageDraw
except ImportError:
    sys.stderr.write("vfx_sheet_cleanup.py requires Pillow + numpy\n")
    sys.exit(2)

# ---- tunables (documented; deterministic) ----------------------------------
ALPHA_THRESH = 16          # a pixel is foreground when alpha > this
CENTER_RADIUS = 48         # half-size of the central window used to find the body
EDGE_BAND = 40             # bbox within this many px of a cell edge counts as "edge"
SPECK_MIN = 200            # disconnected component below this size = stray speck
BIG_FRAGMENT = 800         # disconnected component >= this size = candidate neighbour-art
# Safety floor: the central effect body is ALWAYS preserved, so a large removal % is
# fine as long as a plausible body survives. We bail (-> regen) only when the surviving
# central body is implausibly small for a cell that clearly had a real effect -- that is
# the signature of neighbour-art ENTANGLED with the body (cannot be cleanly separated).
MIN_BODY_ABS = 150         # a surviving body under this many px = suspect
MIN_BODY_FRAC = 0.20       # ...but only bail if that is < this fraction of pre-clean visible

# The 6 cleanup-first candidates (card scope §2). Portal v02/v05/v06 excluded.
# Tuple: (variant, frameWidth, frameHeight, family, slug). Frame COUNT is derived
# from the strip width (W // frameWidth), never hard-coded here.
DEFAULT_CANDIDATES = [
    ("lantern_burst_cast_v01", 256, 256, "Lantern Burst cast sheet", "lantern_burst_cast"),
    ("lantern_burst_cast_v02", 256, 256, "Lantern Burst cast sheet", "lantern_burst_cast"),
    ("lantern_burst_cast_v03", 256, 256, "Lantern Burst cast sheet", "lantern_burst_cast"),
    ("portal_swirl_loop_board_v01", 256, 256, "Portal swirl loop", "portal_swirl_loop"),
    ("portal_swirl_loop_board_v03", 256, 256, "Portal swirl loop", "portal_swirl_loop"),
    ("portal_swirl_loop_cyan_v04", 256, 256, "Portal swirl loop", "portal_swirl_loop"),
]


def label_cc(mask: np.ndarray) -> tuple[np.ndarray, int]:
    """8-connected component labels for a boolean mask. Iterative BFS, no scipy."""
    h, w = mask.shape
    lab = np.zeros((h, w), np.int32)
    cur = 0
    nb = ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1))
    for sy in range(h):
        for sx in range(w):
            if mask[sy, sx] and lab[sy, sx] == 0:
                cur += 1
                lab[sy, sx] = cur
                dq = deque([(sy, sx)])
                while dq:
                    cy, cx = dq.popleft()
                    for dy, dx in nb:
                        ny, nx = cy + dy, cx + dx
                        if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and lab[ny, nx] == 0:
                            lab[ny, nx] = cur
                            dq.append((ny, nx))
    return lab, cur


def clean_cell(cell: np.ndarray, cw: int, ch: int) -> tuple[np.ndarray, dict]:
    """Clean one RGBA cell. Returns (cleaned_cell, stats). stats['bail'] set on failure."""
    alpha = cell[:, :, 3]
    mask = alpha > ALPHA_THRESH
    vis_before = int(mask.sum())
    stats: dict = {
        "visibleBefore": vis_before,
        "components": 0,
        "removedComponents": 0,
        "removedPixels": 0,
        "removedSizes": [],
        "shift": [0, 0],
        "bail": False,
        "bailReason": None,
    }
    if vis_before == 0:
        stats["bail"] = True
        stats["bailReason"] = "empty cell"
        return cell.copy(), stats

    lab, ncc = label_cc(mask)
    stats["components"] = int(ncc)

    # size + bbox + centroid per component
    comps = {}
    for i in range(1, ncc + 1):
        ys, xs = np.where(lab == i)
        comps[i] = {
            "size": int(len(xs)),
            "x0": int(xs.min()), "x1": int(xs.max()),
            "y0": int(ys.min()), "y1": int(ys.max()),
            "cx": float(xs.mean()), "cy": float(ys.mean()),
        }

    # central body: largest component intersecting the central window
    cx0, cy0 = cw / 2.0, ch / 2.0
    central = None
    best_size = -1
    for i, c in comps.items():
        in_center = (c["x0"] <= cx0 + CENTER_RADIUS and c["x1"] >= cx0 - CENTER_RADIUS and
                     c["y0"] <= cy0 + CENTER_RADIUS and c["y1"] >= cy0 - CENTER_RADIUS)
        if in_center and c["size"] > best_size:
            best_size = c["size"]
            central = i
    if central is None:
        stats["bail"] = True
        stats["bailReason"] = "no central body intersects centre window"
        return cell.copy(), stats

    b = comps[central]
    # body radius (max half-extent) used for the "far off-centre big blob" test
    body_reach = max(abs(b["x1"] - cx0), abs(cx0 - b["x0"]),
                     abs(b["y1"] - cy0), abs(cy0 - b["y0"]))

    remove = set()
    for i, c in comps.items():
        if i == central:
            continue
        near_edge = (c["x0"] < EDGE_BAND or c["x1"] > cw - 1 - EDGE_BAND or
                     c["y0"] < EDGE_BAND or c["y1"] > ch - 1 - EDGE_BAND)
        is_speck = c["size"] < SPECK_MIN
        cdist = ((c["cx"] - cx0) ** 2 + (c["cy"] - cy0) ** 2) ** 0.5
        is_big_off = c["size"] >= BIG_FRAGMENT and cdist > body_reach
        if near_edge or is_speck or is_big_off:
            remove.add(i)

    # Entanglement guard: the central body is always kept, so instead of capping the
    # removed fraction we verify a plausible body actually survives. A body that is both
    # tiny in absolute terms AND a tiny fraction of the original visible area means the
    # neighbour-art was fused with the effect -> flag for regen rather than force it.
    body_px = comps[central]["size"]
    if body_px < MIN_BODY_ABS and body_px < MIN_BODY_FRAC * vis_before:
        stats["bail"] = True
        stats["bailReason"] = (
            f"surviving body {body_px}px < MIN_BODY_ABS={MIN_BODY_ABS} and "
            f"< {MIN_BODY_FRAC:.0%} of {vis_before}px visible -- effect entangled with junk"
        )
        return cell.copy(), stats

    out = cell.copy()
    for i in remove:
        out[lab == i] = (0, 0, 0, 0)
    stats["removedComponents"] = len(remove)
    stats["removedPixels"] = int(sum(comps[i]["size"] for i in remove))
    stats["removedSizes"] = sorted((comps[i]["size"] for i in remove), reverse=True)

    # re-centre surviving body on the cell centre
    surv = out[:, :, 3] > ALPHA_THRESH
    if surv.any():
        ys, xs = np.where(surv)
        bx = (xs.min() + xs.max()) / 2.0
        by = (ys.min() + ys.max()) / 2.0
        sx = int(round(cx0 - 0.5 - bx))
        sy = int(round(cy0 - 0.5 - by))
        # clamp so nothing rolls off the cell
        sx = max(-int(xs.min()), min(sx, cw - 1 - int(xs.max())))
        sy = max(-int(ys.min()), min(sy, ch - 1 - int(ys.max())))
        if sx or sy:
            out = np.roll(out, (sy, sx), axis=(0, 1))
            # np.roll wraps; blank the wrapped border regions to be safe
            if sy > 0:
                out[:sy, :] = 0
            elif sy < 0:
                out[sy:, :] = 0
            if sx > 0:
                out[:, :sx] = 0
            elif sx < 0:
                out[:, sx:] = 0
        stats["shift"] = [sx, sy]

    return out, stats


def make_contact_dual(frames: list[np.ndarray], cw: int, ch: int) -> Image.Image:
    """All-frames dual-backing contact strip: row1 on dark, row2 on light, labelled."""
    n = len(frames)
    pad = 0
    label_h = 22
    dark = (10, 10, 12)
    light = (222, 216, 200)
    strip_w = n * cw
    total_h = 2 * (ch + label_h)
    img = Image.new("RGB", (strip_w, total_h), dark)
    draw = ImageDraw.Draw(img)

    def paste_row(y_off: int, bg: tuple[int, int, int]):
        band = Image.new("RGB", (strip_w, ch + label_h), bg)
        img.paste(band, (0, y_off))
        for idx, fr in enumerate(frames):
            cell_img = Image.fromarray(fr, "RGBA")
            base = Image.new("RGBA", (cw, ch), bg + (255,))
            base.alpha_composite(cell_img)
            img.paste(base.convert("RGB"), (idx * cw, y_off + label_h))

    paste_row(0, dark)
    paste_row(ch + label_h, light)
    # labels
    for idx in range(n):
        draw.text((idx * cw + 6, 4), f"{idx:02d}", fill=(210, 210, 210))
        draw.text((idx * cw + 6, ch + label_h + 4), f"{idx:02d}", fill=(40, 40, 40))
    return img


def process_variant(root: str, name: str, cw: int, ch: int, family: str, slug: str,
                    write: bool) -> dict:
    src = os.path.join(root, "runtime", f"{name}.png")
    im = np.asarray(Image.open(src).convert("RGBA")).copy()
    H, W, _ = im.shape
    ncells = W // cw
    out = im.copy()
    cell_stats = []
    bail = False
    bail_reasons = []
    frames_clean = []
    for c in range(ncells):
        cell = im[:, c * cw:(c + 1) * cw, :]
        cleaned, st = clean_cell(cell, cw, ch)
        cell_stats.append(st)
        frames_clean.append(cleaned)
        if st["bail"]:
            bail = True
            bail_reasons.append(f"cell{c}: {st['bailReason']}")
        out[:, c * cw:(c + 1) * cw, :] = cleaned

    verdict = {
        "variant": name,
        "family": family,
        "slug": slug,
        "sourceSheet": f"assets/sources/accepted/vfx_pilot_sheets/"
                       f"card-vfx-pilot-sheets-20260708/runtime/{name}.png",
        "frameWidth": cw,
        "frameHeight": ch,
        "frameCount": ncells,
        "algorithm": "vfx_sheet_cleanup.py: per-cell 8-cc label; keep central body; "
                     "drop disconnected edge/speck/large-off-centre fragments; re-centre",
        "tunables": {
            "ALPHA_THRESH": ALPHA_THRESH, "CENTER_RADIUS": CENTER_RADIUS,
            "EDGE_BAND": EDGE_BAND, "SPECK_MIN": SPECK_MIN,
            "BIG_FRAGMENT": BIG_FRAGMENT,
            "MIN_BODY_ABS": MIN_BODY_ABS, "MIN_BODY_FRAC": MIN_BODY_FRAC,
        },
        "cells": cell_stats,
        "totalRemovedComponents": int(sum(s["removedComponents"] for s in cell_stats)),
        "totalRemovedPixels": int(sum(s["removedPixels"] for s in cell_stats)),
    }

    if bail:
        verdict["result"] = "needs imagegen-regen-with-gutters"
        verdict["bailReasons"] = bail_reasons
        verdict["cleanedSheet"] = None
        verdict["contactDual"] = None
    else:
        verdict["result"] = "cleaned-strip-emitted-for-owner-frame-review"

    if write:
        cleaned_dir = os.path.join(root, "cleaned")
        prev_dir = os.path.join(cleaned_dir, "preview")
        rep_dir = os.path.join(cleaned_dir, "reports")
        os.makedirs(prev_dir, exist_ok=True)
        os.makedirs(rep_dir, exist_ok=True)
        if not bail:
            Image.fromarray(out, "RGBA").save(os.path.join(cleaned_dir, f"{name}.png"))
            contact = make_contact_dual(frames_clean, cw, ch)
            contact.save(os.path.join(prev_dir, f"{name}.contact-dual.png"))
            verdict["cleanedSheet"] = (
                f"assets/sources/accepted/vfx_pilot_sheets/"
                f"card-vfx-pilot-sheets-20260708/cleaned/{name}.png")
            verdict["contactDual"] = (
                f"assets/sources/accepted/vfx_pilot_sheets/"
                f"card-vfx-pilot-sheets-20260708/cleaned/preview/{name}.contact-dual.png")
        else:
            # still emit a contact strip of the ATTEMPTED clean so a human can see why
            contact = make_contact_dual(frames_clean, cw, ch)
            contact.save(os.path.join(prev_dir, f"{name}.attempted.contact-dual.png"))
            verdict["attemptedContactDual"] = (
                f"assets/sources/accepted/vfx_pilot_sheets/"
                f"card-vfx-pilot-sheets-20260708/cleaned/preview/{name}.attempted.contact-dual.png")
        with open(os.path.join(rep_dir, f"{name}.cleanup.verdict.json"), "w",
                  encoding="utf-8") as fh:
            json.dump(verdict, fh, indent=2)

    return verdict


def main() -> int:
    ap = argparse.ArgumentParser(description="Deterministic VFX flipbook cell cleanup.")
    ap.add_argument("root", help="accepted package dir (has runtime/ preview/ reports/)")
    ap.add_argument("--variant", action="append", default=None,
                    help="restrict to named variant(s); default = 6 card candidates")
    ap.add_argument("--run", action="store_true", help="write outputs (default: dry-run)")
    args = ap.parse_args()

    cands = DEFAULT_CANDIDATES
    if args.variant:
        want = set(args.variant)
        cands = [c for c in DEFAULT_CANDIDATES if c[0] in want]
        missing = want - {c[0] for c in cands}
        if missing:
            sys.stderr.write(f"unknown variant(s): {sorted(missing)}\n")
            return 2

    for name, cw, ch, family, slug in cands:
        v = process_variant(args.root, name, cw, ch, family, slug, write=args.run)
        mode = "WROTE" if args.run else "DRY"
        print(f"[{mode}] {name}: result={v['result']} "
              f"removedComponents={v['totalRemovedComponents']} "
              f"removedPixels={v['totalRemovedPixels']}")
        if v["result"].startswith("needs"):
            for r in v.get("bailReasons", []):
                print(f"        bail: {r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

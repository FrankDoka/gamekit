"""Chroma-fringe detection + despill for game assets.

Problem this solves: assets generated/keyed on a magenta or green background often
keep a coloured HALO in the anti-alias band (0<alpha<255). It is invisible against
some viewer backgrounds and shows as a magenta/green rim on others. This tool detects
that halo and removes it without touching legitimately coloured art.

Detection (classify): an asset NEEDS despill for a hue when it has many off-hue pixels
in the SEMI-TRANSPARENT edge band but its OPAQUE body is essentially not that hue
(e.g. a tan shell with a magenta rim, or a gold tile with a green rim). An asset that
is legitimately purple/green (its opaque body IS the hue) is left alone — its edge
colour is natural anti-alias, not background bleed. The gate also catches large compact interior semi-alpha islands from over-erased matting.

Despill: edge-band only. Magenta (R,B elevated above G) is pulled toward G; green
(G elevated above R,B) toward max(R,B); near-pure bleed fades its alpha. Opaque body
pixels are never modified, so legit colour is preserved.

CLI:
  python fringe.py scan   PATH [--json OUT]      list offenders + folder summary
  python fringe.py check  PATH                   exit 1 if ANY offender (CI gate)
  python fringe.py despill PATH [--backup DIR] [--run]
                                                 dry-run by default; --run overwrites
Requires Pillow (and numpy, for the pink-rim check delegated to rimfix.py).
PATH may be a file or a directory (recursed).
"""
from __future__ import annotations
import argparse
import json
import os
import shutil
import sys
import warnings

warnings.filterwarnings("ignore", message=".*getdata is deprecated.*")

try:
    from PIL import Image, ImageFilter
except ImportError:
    sys.stderr.write("fringe.py requires Pillow: pip install Pillow\n")
    sys.exit(2)


class GateUnavailable(Exception):
    """A required defect-detector dependency (e.g. numpy for the pink-rim check) is
    missing or broken. Callers MUST treat this as a hard failure, never a per-file skip —
    a missing detector is not the same class of problem as one corrupt PNG, and silently
    skipping every file when a detector is missing is exactly how a gate goes fail-open."""

# Halo lives ONLY in the thin band touching transparency. Interior translucency
# (a glowing/ethereal creature's body) must NOT be treated as fringe. BAND_PX is the
# Chebyshev radius from a fully-transparent pixel that we still consider "edge".
BAND_PX = 2
OPAQUE_MAGENTA_RING_THRESHOLD = 150
GREEN_TEAL_FOOT_THRESHOLD = 6
# Foreign-hue opaque-ring calibration (card-anim-opaque-ring-wiring, 2026-07-07).
# A ring pixel counts as a defect only when it is BOTH magenta-lean (a genuine
# keying-despill signature) AND foreign to the frame's own interior palette. Two
# discriminators spare legitimately-pink subjects:
#   1. exact-hue support: the ring pixel's quantized hue bin (+/-1) must be absent
#      from the eroded-interior chromatic histogram; and
#   2. native-magenta family: if the interior is itself broadly magenta-lean (a pink
#      body like monster_blossom_slime or cel_blossom_tree — >= NATIVE frac of interior
#      chromatic px lean magenta), the whole magenta family is native and the ring is
#      spared wholesale. This catches wide-gamut pink subjects whose vivid ring outline
#      falls in a slightly different hue bin than their pastel interior fill.
# Dark-plum cel outlines (glowcrab, wayfarer fallbacks) fall below RING_LEAN_GAP and
# never count. Measured separation: defective 826-962/frame (brown/teal body, 6 interior
# lean px) FAILS; blossom slime / tree / glowcrab / cel sheets 0, B1 idle <=19 PASS.
RING_HUE_BINS = 36            # 10-degree quantized-hue bins
RING_LEAN_GAP = 40           # min(R,B) - G >= this: a magenta-lean ring pixel
RING_SAT_FLOOR = 60          # 0..255 HSV saturation floor for a ring pixel (drop neutral AA)
RING_VAL_FLOOR = 20          # 0..255 HSV value floor (drop near-black, hue is noise there)
RING_INTERIOR_SAT = 25       # sat floor for interior-palette pixels (credits dark cel linework)
RING_INTERIOR_SUPPORT = 0.002  # bin+neighbors must hold >= 0.2% of interior chromatic px to be "supported"
RING_INTERIOR_LEAN_NATIVE = 0.02  # if >= 2% of interior chromatic px are magenta-lean, the ring magenta is native

# Color-parity + dither-noise gate calibration (card-p3-cast-funnel-rebuild, 2026-07-08).
# The cast canary was destroyed by palette quantization WITH dithering: flat cel fields
# (blue sash, cream shirt) became brown-teal speckle and the whole-sheet HSV value collapsed.
# Two gates catch that class, both fail-closed, measured on the silhouette (opaque a>200):
#
#   color-parity: sheet-level mean HSV saturation AND value over the silhouette must each
#   clear a floor. Value is the primary discriminator (dithering crushes value); saturation
#   is the second axis the post-mortem names. Measured: destroyed sheet val 0.395 (per-frame
#   0.386-0.406) FAILS the 0.42 floor; the faithful rebuild 0.453, B1 idle 0.537, swing 0.531
#   all PASS. Saturation floor 0.45 spares the rebuild (0.538) and canon (0.66-0.67); note the
#   destroyed sheet's saturation is INFLATED to 0.626 by speckle, so value carries the gate.
#   The floors are static (not a live canon compare) so a legitimately dimmer GENERATION is not
#   false-failed for processing that faithfully preserved the raw's color.
#
#   dither-noise: per-frame density of 2D local luminance oscillation (a pixel that is a local
#   luminance extremum along BOTH axes with amplitude >= COLOR_DITHER_T -- the checkerboard
#   fingerprint of ordered/error-diffusion dither), aggregated as the sheet MEDIAN so a single
#   busy frame (a sword sweep) cannot fail it while a globally-dithered field does. Measured
#   (x1000 of eroded interior): destroyed median 4.489 FAILS the 3.5 floor; rebuild 1.840,
#   swing 1.850, B1 idle 2.482 PASS.
COLOR_PARITY_SAT_FLOOR = 0.45   # silhouette mean HSV saturation floor (0..1)
COLOR_PARITY_VAL_FLOOR = 0.42   # silhouette mean HSV value floor (0..1) -- primary discriminator
COLOR_DITHER_T = 56             # per-axis luminance amplitude (0..255) for a dither oscillation pixel
COLOR_DITHER_THRESHOLD = 3.5    # sheet-median oscillation density per 1000 eroded-interior px


def _boundary(im):
    """Flat bool list: True where the pixel is non-transparent AND within BAND_PX of a
    fully-transparent pixel (i.e. on the alpha edge), via a fast C-level MinFilter."""
    a = im.getchannel("A")
    size = BAND_PX * 2 + 1
    amin = list(a.filter(ImageFilter.MinFilter(size)).getdata())
    alpha = list(a.getdata())
    return [alpha[i] > 0 and amin[i] == 0 for i in range(len(alpha))]

SKIP_DIRS = {
    "_review", "_sliced", "_cleanup", "_cleanup-backups", "_rejected", "_archive",
    "archive", "_runtime-ready-packs", "_promotion-plans", "thumbs", ".thumbs",
    "_previews", "frames", "node_modules", ".git", "__pycache__",
}

# --- detection ---------------------------------------------------------------

def classify(path):
    """Return dict: do_magenta/do_green booleans + raw counts.

    edge_* = off-hue pixels in the alpha boundary band (candidate halo).
    body_* = off-hue pixels in the INTERIOR (opaque or interior-translucent) = legit colour.
    An asset needs despill for a hue when the boundary carries that hue but the body does not.
    """
    im = Image.open(path).convert("RGBA")
    bnd = _boundary(im)
    data = list(im.getdata())
    edge_m = edge_g = body_m = body_g = body = 0
    for i, (r, g, b, a) in enumerate(data):
        if a == 0:
            continue
        is_m = r > 150 and b > 120 and g < min(r, b) - 50
        is_g = g > 120 and r < g - 40 and b < g - 40
        if bnd[i]:
            if is_m: edge_m += 1
            if is_g: edge_g += 1
        else:
            body += 1
            if is_m: body_m += 1
            if is_g: body_g += 1
    body_cap = max(120, int(0.015 * body))
    do_m = edge_m >= 8 and body_m < body_cap and edge_m > body_m
    do_g = edge_g >= 8 and body_g < body_cap and edge_g > body_g
    return {"do_magenta": do_m, "do_green": do_g, "semi_mag": edge_m, "op_mag": body_m,
            "semi_grn": edge_g, "op_grn": body_g, "opaque": body}


# A full chroma BACKGROUND (not just an edge halo) is a different defect class: the image
# was never keyed out, so a large fraction of its OPAQUE pixels are near-pure magenta/green
# (or black). classify() above only looks at the thin alpha edge band and misses this, which
# is exactly how full-magenta source files slipped through. Threshold is deliberately high so
# legitimately purple/green ART (whose body hue is muted, not #ff00ff) never trips it.
def full_bg(path_or_im, thresh=0.08):
    """Return 'M' | 'G' | '' — a full chroma background covering >= thresh of opaque pixels."""
    im = path_or_im if hasattr(path_or_im, "getchannel") else Image.open(path_or_im).convert("RGBA")
    im = im.convert("RGBA")
    w, h = im.size
    px = im.load()
    opaque = mag = grn = 0
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            r, g, b, a = px[x, y]
            if a > 200:
                opaque += 1
                if r > 180 and b > 180 and g < 100: mag += 1
                elif g > 180 and r < 110 and b < 110: grn += 1
    if not opaque:
        return ""
    if mag / opaque >= thresh: return "M"
    if grn / opaque >= thresh: return "G"
    return ""


def is_opaque(path_or_im):
    """True if the image has NO transparency at all (alpha min == 255) — a sprite/prop/vfx/icon
    with a baked background. Legit for tiles; a defect for cut-out art. Caller applies the policy."""
    im = path_or_im if hasattr(path_or_im, "getchannel") else Image.open(path_or_im).convert("RGBA")
    lo, _ = im.convert("RGBA").getchannel("A").getextrema()
    return lo == 255


PINK_RIM_THRESHOLD = 6.0


def pink_rim(path, threshold=PINK_RIM_THRESHOLD):
    """True if the asset carries the semi-transparent magenta/pink RIM defect that
    classify() intentionally does not catch: a soft chroma bias in translucent silhouette
    edge pixels (0<alpha<250), distinct from the hard edge-halo class classify() targets
    (owner-flagged 2026-07-01, devlog 0185 — this is the "purple border" complaint).
    Delegates to rimfix.rim_stats so there is exactly ONE pink-rim detector, reused by the
    scan/check gate and the server accept/promote gate, instead of a second implementation
    that could drift from rimfix.py's tuned threshold.

    Deliberately does NOT catch ImportError here: if numpy/rimfix are unavailable, this
    raises, and every caller (hard_defect -> defects -> the server's `_hard_defect` probe /
    `assets:check`) already treats a raised exception as fail-closed, not fail-open. A bare
    `except: return False` here would silently reopen the exact hole this function closes.
    """
    try:
        from pathlib import Path as _Path
        from rimfix import rim_stats
    except ImportError as exc:
        raise GateUnavailable(f"pink-rim gate unavailable ({exc}) — install numpy: pip install numpy") from exc
    _, _, _, rim_pink, core_pink = rim_stats(_Path(str(path)))
    # A real pink-rim defect is both absolutely pink/magenta-biased and more pink
    # than the asset core. Strong cyan assets can have a very negative core pink
    # index; a neutral/blue rim should not fail only because it is less cyan.
    return rim_pink >= threshold and (rim_pink - core_pink) >= threshold


# Interior semi-alpha islands are a separate rembg over-erasure defect: the RGB art is
# still present, but a compact component well inside the silhouette has been reduced to
# 10<alpha<200. Edge fringe checks deliberately ignore this area, so detect it by first
# stepping away from transparent pixels, then finding large connected semi-alpha blobs.
INTERIOR_ALPHA_BAND_PX = 4
INTERIOR_ALPHA_MIN_PIXELS = 700
INTERIOR_ALPHA_MAX_WIDTH = 90
INTERIOR_ALPHA_MAX_HEIGHT = 90
INTERIOR_ALPHA_MIN_FILL = 0.20


def _component_stats(mask):
    try:
        import numpy as np
    except ImportError as exc:
        raise GateUnavailable(f"interior-alpha gate unavailable ({exc}) - install numpy: pip install numpy") from exc
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    for y in range(h):
        xs = np.where(mask[y] & ~seen[y])[0]
        for x0 in xs:
            if seen[y, x0] or not mask[y, x0]:
                continue
            stack = [(int(x0), int(y))]
            seen[y, x0] = True
            count = 0
            minx = maxx = int(x0)
            miny = maxy = int(y)
            while stack:
                x, yy = stack.pop()
                count += 1
                minx = min(minx, x); maxx = max(maxx, x)
                miny = min(miny, yy); maxy = max(maxy, yy)
                for nx, ny in ((x + 1, yy), (x - 1, yy), (x, yy + 1), (x, yy - 1)):
                    if 0 <= nx < w and 0 <= ny < h and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((nx, ny))
            width = maxx - minx + 1
            height = maxy - miny + 1
            fill = count / max(1, width * height)
            yield {"pixels": count, "bbox": (minx, miny, maxx, maxy), "width": width, "height": height, "fill": fill}


def interior_alpha(path_or_im):
    """Return the largest compact interior semi-alpha component, or None when clean."""
    try:
        import numpy as np
    except ImportError as exc:
        raise GateUnavailable(f"interior-alpha gate unavailable ({exc}) - install numpy: pip install numpy") from exc
    im = path_or_im if hasattr(path_or_im, "getchannel") else Image.open(path_or_im).convert("RGBA")
    im = im.convert("RGBA")
    alpha = np.array(im.getchannel("A"))
    interior = np.array(im.getchannel("A").filter(ImageFilter.MinFilter(INTERIOR_ALPHA_BAND_PX * 2 + 1))) > 0
    mask = (alpha > 10) & (alpha < 200) & interior
    largest = None
    for comp in _component_stats(mask):
        if comp["pixels"] < INTERIOR_ALPHA_MIN_PIXELS:
            continue
        if comp["width"] > INTERIOR_ALPHA_MAX_WIDTH or comp["height"] > INTERIOR_ALPHA_MAX_HEIGHT:
            continue
        if comp["fill"] < INTERIOR_ALPHA_MIN_FILL:
            continue
        if largest is None or comp["pixels"] > largest["pixels"]:
            largest = comp
    return largest


def _infer_animation_cell(width, height):
    candidates = (384, 256, 512, 320, 192, 128, 96, 64)
    for cell in candidates:
        if width > cell and width % cell == 0 and height <= cell:
            return cell
    return width


def _hsv_arrays(arr, np):
    """Vectorized RGB(A)->HSV. Returns (hue 0..1, sat 0..255, val 0..255) float arrays."""
    r = arr[:, :, 0].astype(np.float32) / 255.0
    g = arr[:, :, 1].astype(np.float32) / 255.0
    b = arr[:, :, 2].astype(np.float32) / 255.0
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    diff = mx - mn
    hue = np.zeros_like(mx)
    m = diff > 1e-6
    idx = m & (mx == r); hue[idx] = ((g[idx] - b[idx]) / diff[idx]) % 6
    idx = m & (mx == g); hue[idx] = ((b[idx] - r[idx]) / diff[idx]) + 2
    idx = m & (mx == b); hue[idx] = ((r[idx] - g[idx]) / diff[idx]) + 4
    hue = (hue / 6.0) % 1.0
    with np.errstate(invalid="ignore", divide="ignore"):
        sat = np.where(mx > 1e-6, diff / mx, 0.0) * 255.0
    return hue, sat, mx * 255.0


def opaque_magenta_ring(path_or_im, threshold=OPAQUE_MAGENTA_RING_THRESHOLD, cell=None):
    """Per-frame count of FOREIGN-HUE opaque magenta ring pixels (calibrated defect gate).

    Catches the binary-alpha video-keying failure where a despill ring hardened to full
    opacity survives as a hard magenta outline (the semi-transparent halo checks never see
    it because the alpha is binary). The naive "magenta-lean edge pixel" count that first
    shipped false-fails legitimately pink subjects, so this uses a FOREIGN-HUE discriminator:

    A ring pixel is a defect only when it is BOTH
      (1) magenta-lean: opaque, on the alpha edge, min(R,B) - G >= RING_LEAN_GAP,
          saturated (>= RING_SAT_FLOOR), non-black (>= RING_VAL_FLOOR); AND
      (2) foreign: its quantized hue bin (+/-1 neighbor) holds < RING_INTERIOR_SUPPORT of
          the frame's own eroded-interior chromatic palette.

    The frame FAILS when > threshold such pixels appear. Measured separation
    (card-anim-opaque-ring-wiring, 2026-07-07): defective swing 962-1329/frame (dark
    magenta with ZERO interior support on a brown/teal body); accepted B1 idle <= 19,
    blossom slime 0 (pink body + plum outline fully supported), glowcrab / wayfarer
    fallbacks 0-6 (dark cel outlines below the lean gap) -- all safely PASS with no
    exemption list needed.

    `cell` is the per-frame width for a sprite SHEET (measure it, never guess); pass None
    (default) for a STILL to score the whole image. GateUnavailable if numpy is missing --
    callers must treat that as a hard failure, never a per-file skip.
    """
    try:
        import numpy as np
    except ImportError as exc:
        raise GateUnavailable(f"opaque-magenta-ring gate unavailable ({exc}) - install numpy: pip install numpy") from exc
    im = path_or_im if hasattr(path_or_im, "getchannel") else Image.open(path_or_im).convert("RGBA")
    im = im.convert("RGBA")
    w, h = im.size
    if cell is None or cell <= 0:
        cell = _infer_animation_cell(w, h)
    if cell <= 0 or w % cell != 0:
        raise ValueError(f"opaque-magenta-ring: sheet width {w} not divisible by cell {cell} - measure the sheet")
    frames = w // cell if cell > 0 else 1
    counts = []
    interior_counts = []
    for idx in range(frames):
        frame = im.crop((idx * cell, 0, (idx + 1) * cell, h))
        arr = np.array(frame)
        a = arr[:, :, 3]
        r = arr[:, :, 0].astype(np.int16)
        g = arr[:, :, 1].astype(np.int16)
        b = arr[:, :, 2].astype(np.int16)
        hue, sat, val = _hsv_arrays(arr, np)
        opaque = a > 250
        amin = np.array(Image.fromarray(a, "L").filter(ImageFilter.MinFilter(BAND_PX * 2 + 1)))
        edge = opaque & (amin == 0)
        hbin = np.clip((hue * RING_HUE_BINS).astype(int), 0, RING_HUE_BINS - 1)
        # Interior palette: eroded (non-edge) opaque chromatic pixels, incl. dark cel linework.
        interior = opaque & ~edge & (sat >= RING_INTERIOR_SAT) & (val >= RING_VAL_FLOOR)
        hist = np.bincount(hbin[interior], minlength=RING_HUE_BINS).astype(np.float32)
        ni = max(1, int(interior.sum()))
        # bin+neighbors support fraction; a hue is "supported" if >= RING_INTERIOR_SUPPORT.
        rolled = hist + np.roll(hist, 1) + np.roll(hist, -1)
        supported = (rolled / ni) >= RING_INTERIOR_SUPPORT
        # Magenta-lean ring pixels: the genuine keying-despill signature.
        lean = (np.minimum(r, b) - g >= RING_LEAN_GAP)
        # Native-magenta family: a pink body (interior broadly magenta-lean) makes its own
        # magenta ring outline native, so spare the whole family (blossom slime/tree).
        native_magenta = (int((interior & lean).sum()) / ni) >= RING_INTERIOR_LEAN_NATIVE
        ring = edge & lean & (sat >= RING_SAT_FLOOR) & (val >= RING_VAL_FLOOR)
        ring_bins = hbin[ring]
        if native_magenta:
            foreign = 0
        else:
            foreign = int(np.sum(~supported[ring_bins])) if ring_bins.size else 0
        counts.append(foreign)
        # Foreign magenta-lean count in the INTERIOR (diagnostic): a real despill ring is an
        # edge phenomenon, so this stays near zero even on the defective sheet.
        interior_ring = interior & lean & (sat >= RING_SAT_FLOOR)
        interior_bins = hbin[interior_ring]
        interior_counts.append(int(np.sum(~supported[interior_bins])) if interior_bins.size else 0)
    max_count = max(counts) if counts else 0
    failing_frames = [idx for idx, count in enumerate(counts) if count > threshold]
    return {
        "threshold": threshold,
        "cell": cell,
        "frames": frames,
        "counts": counts,
        "interiorCounts": interior_counts,
        "max": max_count,
        "failingFrames": failing_frames,
        "fail": bool(failing_frames),
    }


def green_teal_speckle(path_or_im, threshold=GREEN_TEAL_FOOT_THRESHOLD, cell=None, region="foot-band"):
    """Per-frame green/teal residue gate for lower-body video-keying speckles.

    The lower-body band is the fail-closed gate: bottom 20% of the visible body plus 10px.
    Full-silhouette counts are returned as diagnostics only because accepted player sheets
    legitimately contain teal costume pixels above the boots.
    """
    try:
        import numpy as np
    except ImportError as exc:
        raise GateUnavailable(f"green-teal-speckle gate unavailable ({exc}) - install numpy: pip install numpy") from exc
    if region not in {"foot-band", "full"}:
        raise ValueError("green-teal-speckle: region must be foot-band or full")
    im = path_or_im if hasattr(path_or_im, "getchannel") else Image.open(path_or_im).convert("RGBA")
    im = im.convert("RGBA")
    w, h = im.size
    if cell is None or cell <= 0:
        cell = _infer_animation_cell(w, h)
    if cell <= 0 or w % cell != 0:
        raise ValueError(f"green-teal-speckle: sheet width {w} not divisible by cell {cell} - measure the sheet")
    frames = w // cell if cell > 0 else 1
    foot_counts = []
    full_counts = []
    bands = []
    bboxes = []
    for idx in range(frames):
        frame = im.crop((idx * cell, 0, (idx + 1) * cell, h))
        arr = np.array(frame)
        a = arr[:, :, 3]
        r = arr[:, :, 0].astype(np.int16)
        g = arr[:, :, 1].astype(np.int16)
        b = arr[:, :, 2].astype(np.int16)
        visible = a > 8
        ys, xs = np.where(visible)
        if ys.size == 0:
            foot_counts.append(0)
            full_counts.append(0)
            bands.append(None)
            bboxes.append(None)
            continue
        top = int(ys.min())
        bottom = int(ys.max())
        left = int(xs.min())
        right = int(xs.max())
        body_h = bottom - top + 1
        band_top = max(0, bottom - int(np.ceil(body_h * 0.2)))
        band_bottom = min(h - 1, bottom + 10)
        ymask = np.zeros((h, cell), dtype=bool)
        ymask[band_top:band_bottom + 1, :] = True
        speckle = visible & (((g > r + 20) & (g > 60)) | ((b > r + 20) & (g > r) & (b > 60)))
        foot_counts.append(int((speckle & ymask).sum()))
        full_counts.append(int(speckle.sum()))
        bands.append([band_top, band_bottom])
        bboxes.append([left, top, right, bottom])
    counts = foot_counts if region == "foot-band" else full_counts
    max_count = max(counts) if counts else 0
    failing_frames = [idx for idx, count in enumerate(counts) if count > threshold]
    return {
        "threshold": threshold,
        "cell": cell,
        "frames": frames,
        "region": region,
        "counts": counts,
        "footBandCounts": foot_counts,
        "fullCounts": full_counts,
        "max": max_count,
        "failingFrames": failing_frames,
        "bands": bands,
        "bboxes": bboxes,
        "fail": bool(failing_frames),
    }


def color_parity(path_or_im, sat_floor=COLOR_PARITY_SAT_FLOOR, val_floor=COLOR_PARITY_VAL_FLOOR, cell=None):
    """Silhouette colour-parity gate: mean HSV saturation AND value over the opaque body
    must each clear a floor (card-p3-cast-funnel-rebuild, 2026-07-08).

    Catches palette-quantization-with-dither colour death: the destroyed cast sheet's
    whole-silhouette value collapsed to 0.395 while flat cel fields turned to speckle.
    Value is the primary discriminator (dither crushes value AND inflates saturation, so a
    saturation-only check is defeated). Both floors are static, so a legitimately dimmer
    GENERATION whose colour was faithfully preserved is not false-failed. GateUnavailable
    if numpy is missing -- a hard failure, never a per-file skip.
    """
    try:
        import numpy as np
    except ImportError as exc:
        raise GateUnavailable(f"color-parity gate unavailable ({exc}) - install numpy: pip install numpy") from exc
    im = path_or_im if hasattr(path_or_im, "getchannel") else Image.open(path_or_im).convert("RGBA")
    im = im.convert("RGBA")
    arr = np.array(im)
    mask = arr[:, :, 3] > 200
    if not mask.any():
        raise ValueError("color-parity: sheet has no opaque silhouette")
    _hue, sat255, val255 = _hsv_arrays(arr, np)
    sat = sat255 / 255.0
    val = val255 / 255.0
    sat_mean = float(sat[mask].mean())
    val_mean = float(val[mask].mean())
    fail_sat = sat_mean < sat_floor
    fail_val = val_mean < val_floor
    return {
        "satFloor": sat_floor,
        "valFloor": val_floor,
        "satMean": round(sat_mean, 4),
        "valMean": round(val_mean, 4),
        "failSat": bool(fail_sat),
        "failVal": bool(fail_val),
        "fail": bool(fail_sat or fail_val),
    }


def dither_noise(path_or_im, threshold=COLOR_DITHER_THRESHOLD, t=COLOR_DITHER_T, cell=None):
    """Dither-noise gate: sheet-median density of 2D luminance oscillation (card-p3-cast-
    funnel-rebuild, 2026-07-08).

    A dithered field scatters lone pixels that are a local luminance extremum along BOTH
    axes (the checkerboard fingerprint); a flat cel field has monotonic ramps across a
    boundary. Per frame we count eroded-interior opaque pixels that are h- AND v-extrema
    with amplitude >= `t`, as a fraction (x1000) of interior; the SHEET aggregate is the
    MEDIAN so one busy frame (sword sweep) cannot fail a clean sheet while a globally
    dithered field does. Measured: destroyed cast median 4.489 FAILS the 3.5 floor; the
    rebuild 1.840, swing 1.850, B1 idle 2.482 PASS. GateUnavailable if numpy is missing.
    """
    try:
        import numpy as np
    except ImportError as exc:
        raise GateUnavailable(f"dither-noise gate unavailable ({exc}) - install numpy: pip install numpy") from exc
    im = path_or_im if hasattr(path_or_im, "getchannel") else Image.open(path_or_im).convert("RGBA")
    im = im.convert("RGBA")
    w, h = im.size
    if cell is None or cell <= 0:
        cell = _infer_animation_cell(w, h)
    if cell <= 0 or w % cell != 0:
        raise ValueError(f"dither-noise: sheet width {w} not divisible by cell {cell} - measure the sheet")
    frames = w // cell
    densities = []
    for idx in range(frames):
        frame = im.crop((idx * cell, 0, (idx + 1) * cell, h))
        arr = np.array(frame).astype(np.int32)
        a = arr[:, :, 3]
        opaque = a > 200
        interior = np.asarray(Image.fromarray((opaque.astype(np.uint8) * 255), "L").filter(ImageFilter.MinFilter(5))) > 0
        n = int(interior.sum())
        if n == 0:
            densities.append(0.0)
            continue
        lum = 0.299 * arr[:, :, 0] + 0.587 * arr[:, :, 1] + 0.114 * arr[:, :, 2]
        left = np.roll(lum, 1, axis=1); right = np.roll(lum, -1, axis=1)
        up = np.roll(lum, 1, axis=0); down = np.roll(lum, -1, axis=0)
        h_ext = ((lum - left > t) & (lum - right > t)) | ((left - lum > t) & (right - lum > t))
        v_ext = ((lum - up > t) & (lum - down > t)) | ((up - lum > t) & (down - lum > t))
        speck = interior & h_ext & v_ext
        densities.append(int(speck.sum()) / n * 1000.0)
    median = float(np.median(densities)) if densities else 0.0
    return {
        "threshold": threshold,
        "amplitude": t,
        "cell": cell,
        "frames": frames,
        "densities": [round(d, 3) for d in densities],
        "median": round(median, 3),
        "max": round(max(densities), 3) if densities else 0.0,
        "fail": bool(median > threshold),
    }


def defects(path):
    """Unified per-asset defect report used by the scan/check gate and the server accept gate.
    Returns {"fringe": 'M'|'G'|'MG'|'', "full_bg": 'M'|'G'|'', "opaque": bool,
    "pink_rim": bool, "interior_alpha": component-or-None, "opaque_magenta_ring": stats}."""
    im = Image.open(path).convert("RGBA")
    cl = classify(path)
    fr = ("M" if cl["do_magenta"] else "") + ("G" if cl["do_green"] else "")
    return {"fringe": fr, "full_bg": full_bg(im), "opaque": is_opaque(im),
            "pink_rim": pink_rim(path), "interior_alpha": interior_alpha(im),
            "opaque_magenta_ring": opaque_magenta_ring(im)}


# Policy. full_bg + fringe + pink_rim are ALWAYS defects (no legit asset has a #ff00ff/#00ff00
# background, and a translucent-edge pink/magenta bias not present in the asset's own core
# colour is background bleed, not art). interior alpha and opaque (no alpha at all) are only defects for CUT-OUT
# art that must be transparent — sprites, props, vfx, icons, item/monster-loot icons, portraits,
# telegraphs. It is EXPECTED for tiles, terrain, ground, full-tile transitions, UI panels and
# backgrounds, so those never trip it.
_CUTOUT_KINDS = {"sprite", "prop", "icon", "portrait", "vfx"}
_CUTOUT_SIGNALS = (
    "vfx", "icon", "/items/", "sprite", "monster", "/npcs/", "portrait", "telegraph", "/props/",
    "_black_bg", "combat_vfx",
)

def hard_defect(path, rel_lower=None, kind=None):
    """Return a short defect code string ('' if clean) for the validate/server gate.
    Pass `kind` (server has it) for a precise opaque policy; else fall back to path signals."""
    d = defects(path)
    codes = []
    rl = rel_lower if rel_lower is not None else path.replace("\\", "/").lower()
    cutout = (kind in _CUTOUT_KINDS) if kind else any(s in rl for s in _CUTOUT_SIGNALS)
    if d["fringe"]: codes.append("fringe" + d["fringe"])
    if d["full_bg"]: codes.append("bg" + d["full_bg"])
    if d["pink_rim"]: codes.append("pinkrim")
    if d["opaque_magenta_ring"]["fail"]: codes.append("opaquemagring")
    if d["interior_alpha"] and cutout:
        codes.append("interioralpha")
    if d["opaque"] and cutout:
        codes.append("opaque")
    return ",".join(codes)

# --- despill -----------------------------------------------------------------

def _despill_pixel(r, g, b, a, tol, drop_pure, want_m, want_g):
    if want_m:
        m = min(r, b)
        if m > g + tol:
            excess = m - (g + tol)
            nr = r - min(excess, r - g) if r > g else r
            nb = b - min(excess, b - g) if b > g else b
            r, b = max(g, nr), max(g, nb)
            if drop_pure and excess > 90 and a < 160:
                a = max(0, a - int(excess))
    if want_g:
        mx = max(r, b)
        if g > mx + tol:
            excess = g - (mx + tol)
            g = max(mx, g - excess)
            if drop_pure and excess > 90 and a < 160:
                a = max(0, a - int(excess))
    return r, g, b, a

def despill(src, dst, do_magenta=True, do_green=True, tol=6, drop_pure=True):
    im = Image.open(src).convert("RGBA")
    bnd = _boundary(im)               # only the alpha edge band; interior never touched
    data = list(im.getdata())
    changed = 0
    for i, (r, g, b, a) in enumerate(data):
        if a == 0 or not bnd[i]:
            continue
        nr, ng, nb, na = _despill_pixel(r, g, b, a, tol, drop_pure, do_magenta, do_green)
        if (nr, ng, nb, na) != (r, g, b, a):
            data[i] = (nr, ng, nb, na); changed += 1
    if changed:
        im.putdata(data)
    im.save(dst)
    return changed

# --- walking -----------------------------------------------------------------

def _iter_pngs(path, exclude=()):
    skip = SKIP_DIRS | set(exclude)
    if os.path.isfile(path):
        if path.lower().endswith(".png") and not path.lower().endswith(".panel.png"):
            yield path
        return
    for dp, dns, fns in os.walk(path):
        dns[:] = [d for d in dns if d not in skip]
        for fn in fns:
            # *.panel.png = anim-validator acceptance panels (checkerboard
            # backing, intentionally opaque). The anim gate REQUIRES them staged
            # alongside runtime sheets; they are tooling proof artifacts, never
            # game-loaded — scanning them false-fails [opaque] (lr3, 2026-07-07).
            if fn.lower().endswith(".png") and not fn.lower().endswith(".panel.png"):
                yield os.path.join(dp, fn)

def scan(path, exclude=()):
    offenders, scanned = [], 0
    for p in _iter_pngs(path, exclude):
        try:
            cl = classify(p)
        except Exception:
            continue
        scanned += 1
        if cl["do_magenta"] or cl["do_green"]:
            offenders.append((os.path.relpath(p, path if os.path.isdir(path) else os.path.dirname(path)).replace("\\", "/"), cl))
    return scanned, offenders

# --- CLI ---------------------------------------------------------------------

def cmd_scan(args):
    scanned, offenders = scan(args.path, args.exclude)
    from collections import Counter
    byfolder = Counter("/".join(r.split("/")[:3]) for r, _ in offenders)
    print(f"scanned {scanned} PNGs under {args.path}")
    print(f"offenders: {len(offenders)} "
          f"(magenta {sum(1 for _, c in offenders if c['do_magenta'])}, "
          f"green {sum(1 for _, c in offenders if c['do_green'])})")
    for d, n in byfolder.most_common():
        print(f"  {n:4d}  {d}")
    if args.json:
        json.dump({"scanned": scanned, "offenders": [r for r, _ in offenders],
                   "detail": {r: c for r, c in offenders}}, open(args.json, "w"), indent=1)
        print(f"manifest -> {args.json}")
    return 0

RIM_BASELINE_PATH = os.path.join(os.path.dirname(__file__), "rim-baseline.json")


def _sha256_file(path):
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def load_rim_baseline(path=RIM_BASELINE_PATH):
    """Load the pink-rim baseline exemption list: pre-existing shipped assets that carried
    the pinkrim defect the day the gate went hard-fail (R0, 2026-07-02), keyed by POSIX-style
    path relative to the scanned root -> sha256 of the file's bytes at baseline time.

    This is legacy-debt bookkeeping, NOT a lenient threshold: it exempts ONLY the exact
    byte-identical files already in the baseline, and ONLY the 'pinkrim' code (an asset that
    also has fringe/full_bg/opaque stays hard-failed). Any edit to a baselined file changes
    its hash and drops the exemption — the file must then clear the gate for real or be
    re-baselined deliberately. New assets (not in the baseline) always get the full gate.
    The baseline shrinks as R2 regenerates/purges; it must never grow via this loader.
    Missing/unreadable file -> {} (no exemptions, strictest behavior)."""
    try:
        data = json.loads(open(path, encoding="utf-8").read())
        entries = data.get("entries", {})
        return entries if isinstance(entries, dict) else {}
    except Exception:
        return {}


INTERIOR_ALPHA_BASELINE_PATH = os.path.join(os.path.dirname(__file__), "interior-alpha-baseline.json")


def load_interior_alpha_baseline(path=INTERIOR_ALPHA_BASELINE_PATH):
    """Load byte-pinned exemptions for legacy shipped assets with intentional compact
    interior translucency. This applies only to `assets:check` runtime scans; accept and
    promote gates call hard_defect() directly, so new or edited assets must clear it."""
    try:
        data = json.loads(open(path, encoding="utf-8").read())
        entries = data.get("entries", {})
        return entries if isinstance(entries, dict) else {}
    except Exception:
        return {}


def _exempt_code(code, rel, path, rim_baseline=None, interior_alpha_baseline=None):
    parts = code.split(",") if code else []
    changed = False
    if "pinkrim" in parts and rim_baseline and rel in rim_baseline:
        if _sha256_file(path) == rim_baseline[rel]:
            parts.remove("pinkrim")
            changed = True
    if "interioralpha" in parts and interior_alpha_baseline and rel in interior_alpha_baseline:
        if _sha256_file(path) == interior_alpha_baseline[rel]:
            parts.remove("interioralpha")
            changed = True
    return ",".join(parts), changed


def scan_hard(path, exclude=(), rim_baseline=None):
    """Scan for ALL hard defect classes (fringe + full chroma bg + pink rim +
    interior alpha + opaque-no-alpha-where-cutout). Returns (scanned, offenders,
    baseline_exempt) where offenders is [(rel, code)].

    A GateUnavailable (e.g. numpy missing) is NOT swallowed by the per-file try/except below
    — it propagates so callers fail the whole scan instead of silently reporting a clean
    result built from every file being skipped."""
    base = path if os.path.isdir(path) else os.path.dirname(path)
    interior_alpha_baseline = load_interior_alpha_baseline()
    offenders, scanned, exempt = [], 0, 0
    for p in _iter_pngs(path, exclude):
        try:
            code = hard_defect(p)
        except GateUnavailable:
            raise
        except Exception:
            continue
        scanned += 1
        rel = os.path.relpath(p, base).replace("\\", "/")
        code, did_exempt = _exempt_code(code, rel, p, rim_baseline=rim_baseline, interior_alpha_baseline=interior_alpha_baseline)
        if did_exempt:
            exempt += 1
        if code:
            offenders.append((rel, code))
    return scanned, offenders, exempt

def cmd_check(args):
    rim_baseline = load_rim_baseline()
    try:
        scanned, offenders, exempt = scan_hard(args.path, args.exclude, rim_baseline=rim_baseline)
    except GateUnavailable as exc:
        print(f"FAIL: {exc}")
        return 1
    if exempt:
        print(f"[assets] rim-baseline: {exempt} legacy offender(s) pending regeneration (R1/R2) — "
              f"exempted, not fixed. See {os.path.basename(RIM_BASELINE_PATH)}.")
    if offenders:
        print(f"FAIL: {len(offenders)}/{scanned} assets have defects under {args.path}")
        print("  (fringeM/G = edge halo · bgM/G = full chroma background · pinkrim = translucent pink/purple rim · opaquemagring = opaque magenta edge ring >150/frame · interioralpha = compact interior semi-alpha · opaque = cut-out art with no alpha)")
        for r, code in offenders[:50]:
            print(f"  [{code}]  {r}")
        if len(offenders) > 50:
            print(f"  ... and {len(offenders) - 50} more")
        print("Fix fringe: python tools/asset-cleanup/fringe.py despill <path> --run --backup <dir>")
        print("Fix bg/opaque: re-key the background (rembg) or regenerate; never ship a chroma/opaque bg.")
        return 1
    print(f"OK: 0 defective assets in {scanned} scanned under {args.path}")
    return 0

def cmd_audit(args):
    try:
        scanned, offenders, exempt = scan_hard(args.path, args.exclude, rim_baseline=load_rim_baseline())
    except GateUnavailable as exc:
        print(f"FAIL: {exc}")
        return 1
    if exempt:
        print(f"[assets] rim-baseline: {exempt} legacy offender(s) exempted (see {os.path.basename(RIM_BASELINE_PATH)})")
    from collections import Counter
    by_code = Counter()
    for _, code in offenders:
        for c in code.split(","):
            by_code[c] += 1
    print(f"audited {scanned} PNGs under {args.path}")
    print(f"defective: {len(offenders)}  ({dict(by_code)})")
    byfolder = Counter("/".join(r.split("/")[:3]) for r, _ in offenders)
    for d, n in byfolder.most_common(25):
        print(f"  {n:4d}  {d}")
    if args.json:
        json.dump({"scanned": scanned, "offenders": [{"path": r, "code": c} for r, c in offenders]},
                  open(args.json, "w"), indent=1)
        print(f"manifest -> {args.json}")
    return 1 if offenders else 0

def cmd_despill(args):
    processed = skipped = 0
    base = args.path if os.path.isdir(args.path) else os.path.dirname(args.path)
    for p in _iter_pngs(args.path, args.exclude):
        try:
            cl = classify(p)
        except Exception:
            continue
        if not (cl["do_magenta"] or cl["do_green"]):
            continue
        rel = os.path.relpath(p, base).replace("\\", "/")
        tags = ("M" if cl["do_magenta"] else "") + ("G" if cl["do_green"] else "")
        if args.run:
            if args.backup:
                bpath = os.path.join(args.backup, rel)
                os.makedirs(os.path.dirname(bpath), exist_ok=True)
                if not os.path.exists(bpath):
                    shutil.copy2(p, bpath)
            ch = despill(p, p, do_magenta=cl["do_magenta"], do_green=cl["do_green"])
            print(f"  despilled[{tags}] {ch:5d}px  {rel}")
        else:
            print(f"  would despill[{tags}]  {rel}")
        processed += 1
    print(f"{'EXECUTED' if args.run else 'DRY RUN'}: {processed} despilled"
          + ("" if args.run else " (pass --run to apply; --backup DIR to keep originals)"))
    return 0


def cmd_opaque_magenta_ring(args):
    try:
        stats = opaque_magenta_ring(args.path, threshold=args.threshold, cell=args.cell)
    except GateUnavailable as exc:
        print(f"FAIL: {exc}")
        return 1
    except ValueError as exc:
        print(f"FAIL: {exc}")
        return 1
    result = "FAIL" if stats["fail"] else "PASS"
    if args.json:
        json.dump({"path": args.path, "result": result, **stats}, open(args.json, "w", encoding="utf-8"), indent=2)
        print(f"manifest -> {args.json}")
    print(f"{result}: opaque-magenta-ring {args.path} cell={stats['cell']} frames={stats['frames']} "
          f"max={stats['max']} threshold={stats['threshold']} counts={stats['counts']} "
          f"interior={stats['interiorCounts']}")
    return 1 if stats["fail"] else 0


def cmd_green_teal_speckle(args):
    try:
        stats = green_teal_speckle(args.path, threshold=args.threshold, cell=args.cell, region=args.region)
    except GateUnavailable as exc:
        print(f"FAIL: {exc}")
        return 1
    except ValueError as exc:
        print(f"FAIL: {exc}")
        return 1
    result = "FAIL" if stats["fail"] else "PASS"
    if args.json:
        json.dump({"path": args.path, "result": result, **stats}, open(args.json, "w", encoding="utf-8"), indent=2)
        print(f"manifest -> {args.json}")
    print(f"{result}: green-teal-speckle {args.path} cell={stats['cell']} frames={stats['frames']} "
          f"region={stats['region']} max={stats['max']} threshold={stats['threshold']} "
          f"counts={stats['counts']} foot={stats['footBandCounts']} full={stats['fullCounts']}")
    return 1 if stats["fail"] else 0


def cmd_color_parity(args):
    try:
        stats = color_parity(args.path, sat_floor=args.sat_floor, val_floor=args.val_floor)
    except GateUnavailable as exc:
        print(f"FAIL: {exc}")
        return 1
    except ValueError as exc:
        print(f"FAIL: {exc}")
        return 1
    result = "FAIL" if stats["fail"] else "PASS"
    if args.json:
        json.dump({"path": args.path, "result": result, **stats}, open(args.json, "w", encoding="utf-8"), indent=2)
        print(f"manifest -> {args.json}")
    print(f"{result}: color-parity {args.path} sat={stats['satMean']} (floor {stats['satFloor']}) "
          f"val={stats['valMean']} (floor {stats['valFloor']}) failSat={stats['failSat']} failVal={stats['failVal']}")
    return 1 if stats["fail"] else 0


def cmd_dither_noise(args):
    try:
        stats = dither_noise(args.path, threshold=args.threshold, t=args.amplitude, cell=args.cell)
    except GateUnavailable as exc:
        print(f"FAIL: {exc}")
        return 1
    except ValueError as exc:
        print(f"FAIL: {exc}")
        return 1
    result = "FAIL" if stats["fail"] else "PASS"
    if args.json:
        json.dump({"path": args.path, "result": result, **stats}, open(args.json, "w", encoding="utf-8"), indent=2)
        print(f"manifest -> {args.json}")
    print(f"{result}: dither-noise {args.path} cell={stats['cell']} frames={stats['frames']} "
          f"median={stats['median']} max={stats['max']} threshold={stats['threshold']} "
          f"densities={stats['densities']}")
    return 1 if stats["fail"] else 0


def cmd_rim_baseline(args):
    """(Re)generate the pink-rim legacy-debt exemption list. Only ever run this deliberately
    (R0 cutover, or after R1/R2 regenerates a batch and the survivors should drop out) — it
    is NOT part of any gate and must never run automatically from CI or the accept/promote
    path. Captures every PINKRIM-ONLY offender under PATH today; anything with a combined
    defect code, or without one, is excluded (never exempted)."""
    scanned, offenders, _ = scan_hard(args.path, args.exclude, rim_baseline=None)
    entries = {}
    for rel, code in offenders:
        if code != "pinkrim":
            continue
        entries[rel] = _sha256_file(os.path.join(args.path, rel))
    out_path = args.out or RIM_BASELINE_PATH
    payload = {
        "_comment": "Pink-rim legacy-debt exemption list (R0, 2026-07-02 charter). "
                    "Generated by `python fringe.py rim-baseline <path>`. Do NOT hand-edit; "
                    "do NOT regenerate to silence a new offender — only to shrink it after "
                    "R1/R2 regenerates or purges an entry. See rim-baseline docs in fringe.py.",
        "generated_from": args.path,
        "entries": entries,
    }
    json.dump(payload, open(out_path, "w", encoding="utf-8"), indent=1)
    print(f"rim-baseline: {len(entries)} pinkrim-only offender(s) captured from {scanned} scanned -> {out_path}")
    return 0

def main(argv=None):
    ap = argparse.ArgumentParser(description="Chroma-fringe detect + despill")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("scan"); s.add_argument("path"); s.add_argument("--json"); s.add_argument("--exclude", nargs="*", default=[]); s.set_defaults(fn=cmd_scan)
    c = sub.add_parser("check"); c.add_argument("path"); c.add_argument("--exclude", nargs="*", default=[]); c.set_defaults(fn=cmd_check)
    au = sub.add_parser("audit"); au.add_argument("path"); au.add_argument("--json"); au.add_argument("--exclude", nargs="*", default=[]); au.set_defaults(fn=cmd_audit)
    d = sub.add_parser("despill"); d.add_argument("path"); d.add_argument("--backup"); d.add_argument("--exclude", nargs="*", default=[]); d.add_argument("--run", action="store_true"); d.set_defaults(fn=cmd_despill)
    omr = sub.add_parser("opaque-magenta-ring", help="foreign-hue opaque magenta ring gate (sheets: --cell N per-frame; stills: whole-image)")
    omr.add_argument("path"); omr.add_argument("--cell", type=int, default=None, help="per-frame width for a sheet (measure it); omit for a still")
    omr.add_argument("--threshold", type=int, default=OPAQUE_MAGENTA_RING_THRESHOLD); omr.add_argument("--json"); omr.set_defaults(fn=cmd_opaque_magenta_ring)
    gts = sub.add_parser("green-teal-speckle", help="lower-body green/teal video-key residue gate (sheets: --cell N per-frame)")
    gts.add_argument("path"); gts.add_argument("--cell", type=int, default=None, help="per-frame width for a sheet (measure it); omit for a still")
    gts.add_argument("--threshold", type=int, default=GREEN_TEAL_FOOT_THRESHOLD); gts.add_argument("--region", choices=("foot-band", "full"), default="foot-band")
    gts.add_argument("--json"); gts.set_defaults(fn=cmd_green_teal_speckle)
    cp = sub.add_parser("color-parity", help="silhouette colour-parity gate (mean HSV sat+value floors; catches palette/dither colour death)")
    cp.add_argument("path"); cp.add_argument("--sat-floor", type=float, default=COLOR_PARITY_SAT_FLOOR)
    cp.add_argument("--val-floor", type=float, default=COLOR_PARITY_VAL_FLOOR); cp.add_argument("--json")
    cp.set_defaults(fn=cmd_color_parity)
    dn = sub.add_parser("dither-noise", help="dither-noise gate (sheet-median 2D luminance-oscillation density; sheets: --cell N)")
    dn.add_argument("path"); dn.add_argument("--cell", type=int, default=None, help="per-frame width for a sheet (measure it); omit to infer")
    dn.add_argument("--threshold", type=float, default=COLOR_DITHER_THRESHOLD); dn.add_argument("--amplitude", type=int, default=COLOR_DITHER_T)
    dn.add_argument("--json"); dn.set_defaults(fn=cmd_dither_noise)
    rb = sub.add_parser("rim-baseline"); rb.add_argument("path"); rb.add_argument("--out"); rb.add_argument("--exclude", nargs="*", default=[]); rb.set_defaults(fn=cmd_rim_baseline)
    args = ap.parse_args(argv)
    return args.fn(args)

if __name__ == "__main__":
    sys.exit(main())

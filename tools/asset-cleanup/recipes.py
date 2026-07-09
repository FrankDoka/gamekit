"""Mechanical verification recipes — the executable form of
docs/architecture/ai-architecture.md "Integrator Verification Recipes".

Lanes MUST run this before any READY/pilot/re-proof report (playbook 0.5.10) and
attach the JSON verdict. Integrators re-run the same command to confirm.
Exit code 0 = all checks PASS (warnings allowed), 1 = any FAIL, 2 = usage error.

Usage (64-bit python with PIL+numpy, same interpreter as fringe.py):
  python tools/asset-cleanup/recipes.py ground CAND.png --ref REF.png
  python tools/asset-cleanup/recipes.py ground CAND.png --band walkable
  python tools/asset-cleanup/recipes.py piece PIECE.png --master MASTER.png
  python tools/asset-cleanup/recipes.py object CAND.png --ref KEPT_CEL_PROP.png
  python tools/asset-cleanup/recipes.py seed PADDED.png --master MASTER.png --reach low
  python tools/asset-cleanup/recipes.py grey-blotch CAND.png [--max-frac 0.01]
      # colored organic assets only (petals/foliage): achromatic mid-lum pixel
      # fraction floor — means/hue stats are NOT acceptance evidence for recolors
  python tools/asset-cleanup/recipes.py sheet-tone SHEET.png --static STATIC.png --frames N
      # per-frame body tone + vertical squash/drop gate for fixed-anchor attack sheets
  python tools/asset-cleanup/recipes.py sheet-unique CAND.png --against DIR [--against DIR2] [--frames N]
      # fail if CAND byte-md5 or adjacent-frame delta profile matches accepted/live sheets
  python tools/asset-cleanup/recipes.py motion-arc SHEET.png --cell N [--loop]
      # recipe 18: adjacent-frame body-delta profile. --cell is MANDATORY and explicit -
      # NEVER inferred from width (a 1536px sheet mis-split 4x384 vs 6x256 fooled the
      # integrator once). See "motion-arc" thresholds + the ANIMATION-VALIDATOR
      # DOCTRINE block below.
  python tools/asset-cleanup/recipes.py identity-palette SHEET.png --cell N [--canon REF.png --canon-cell M]
      # per-frame quantized garment-swatch histogram vs the sheet's own median frame
      # (internal costume consistency) and, with --canon, vs a reference sheet's
      # median (cross-sheet identity drift). See thresholds + doctrine below.
  python tools/asset-cleanup/recipes.py trans-palette TRANS.png --base-a A.png --base-b B.png [--max-delta 2.0]
      # transition tile: nearest edge band must palette-match EACH base tile
  python tools/asset-cleanup/recipes.py tiles-check DIR      # CI gate: every *.png in
      DIR must wrap (lr,tb <= interior adj) unless byte-identical to an entry in
      tools/asset-cleanup/tile-baseline.json (legacy debt; list may only shrink)
  python tools/asset-cleanup/recipes.py tiles-baseline DIR   # regenerate the baseline
      from current offenders — run DELIBERATELY only when R-wave regen retires entries
Optional: --json OUT.json (default: alongside input, <name>.recipes-verdict.json;
motion-arc and identity-palette default to <name>.motion-arc-verdict.json and
<name>.identity-palette-verdict.json so both can sit next to the same sheet —
the intake fail-closed gate requires exactly those names staged with the sheet).

Thresholds are doctrine, not preferences:
  ground: size exactly 1024x1024; wrap lr,tb <= interior adj (recipe 2);
          flat-vector WARN if adj < 1.0 with std 30-50 (recipe 3 -> side-by-side
          mandatory); tone +-6 lum / +-10 sat vs --ref, or walkable band
          lum >= 165 / sat <= 150 (recipe 4); 128px block-spread <= 1.5x ref's
          own spread (hotspot, recipe 14); mirror-fold corr <= 0.30 (recipe 14).
  piece:  tone |dLum| <= 6 and |dSat| <= 10 on the opaque region vs master
          (recipe 13a; NOTE: whole-region tone is invalid on two-material pieces —
          hue-mask per region, see the ai-architecture toolkit); placeholder FAIL if
          eroded-interior adj < 0.35x master adj AND std < 0.5x master std (recipe
          13c); enclosed alpha-hole FAIL for any alpha<100 component >=150px not
          connected to the border transparent field (ghost holes read as dark
          stamps on dark previews; deliberate semi-transparent strokes at alpha
          ~150+ pass).
  seed:   canvas strictly larger than master both axes; center crop byte-identical
          (recipe 6); subject height fraction 65-85% (--reach low) or 40-60%
          (--reach high) per animation.md reach-scaled padding.
  object: STYLE FLOOR for standalone props/decals/vignettes (added 2026-07-03 after
          the masswave flat-vector batch passed piece 23/23 — second occurrence of
          the R2-HARBOR flat-vector class, so it is now executable, not LOOK-only).
          Interior adj (opaque-eroded, recipe 3 applied to objects) must be
          >= max(5.0, 0.5x the kept reference's own adj). Kept cel refs measure
          ~8.8-10.8; flat-vector icon fills measure ~1.0-2.4. The side-by-side LOOK
          is still mandatory — this floors the unambiguous case only.
  sheet-tone: fixed-anchor attack sheet body pixels (alpha > 200 and lum > 60) must
          stay inside the static body's tone band: |dLum| <= 3, |dSat| <= 10,
          adjacent frame lum jump <= 5, bbox-top drop <= 6 display px, centroid-Y
          drop <= 4 display px, and slime exterior rim must have 0 dark semi-alpha
          pixels by the slime_outline_rebuild.py mask. Use --body-height/
          --display-body-height for the runtime scale; otherwise the full frame
          height is the body-height baseline.
  motion-arc (2026-07-07, card-anim-validators; calibrated on the real full sheets:
          negatives = the reverted B4 set at 2ca585e6, positives = live
          player_blackhair_cel idle/walk/gather/attack + slime attack + accepted B1
          bald-base idle/walk): deltas are mean-abs RGB over the union alpha>50 mask
          of each adjacent frame pair.
          FAIL constant_deltas   max-min < 0.5 (whole-sheet duplicate tiling);
          FAIL duplicate_tiling  ANY adjacent delta < 3.0 (a duplicated-frame run:
                                 B4 block_brace's garbled second half measures
                                 1.4-2.0; every calibrated positive's min is >= 11.8);
          FAIL flat_profile      non-loop max/min < 1.6 (live attack 4.96, slime 2.64);
          FAIL flat_loop         loop max/min < 1.38, WARN band 1.38-1.55 = pass
                                 printed LOUDLY for eyes-on (integrator ruling: thin
                                 margin surfaces, never silently passes). Calibration:
                                 B4 gather 1.31 / sit 1.19 FAIL; live gather 1.44 WARN;
                                 B1 idle ~1.55 boundary; live idle 2.16 / walk 2.25.
  identity-palette (same card/calibration; negatives = the reverted B2 outfit-morph
          set at d373916f): per-frame 3-bit/channel (512-bin) histogram of body
          pixels alpha>200 with 40 < lum < 235 (drops cel outline + specular white).
          FAIL costume_drift     any frame's L1 vs the sheet's own median histogram
                                 >= 0.75 (B2 fixtures 0.83-0.91; every positive
                                 <= 0.64, the slime attack being the widest
                                 legitimate swing; player positives <= 0.55);
          FAIL canon_drift       with --canon: any frame's L1 vs the canon sheet's
                                 median histogram >= 0.95 (B2 vs accepted B1 idle
                                 1.08-1.23; same-character pairs incl. cel
                                 attack-vs-idle <= 0.77; canon must be the SAME
                                 character - cross-entity comparisons blow past 1.9).

  ANIMATION-VALIDATOR DOCTRINE (integrator ruling 2026-07-07, card-anim-validators):
  motion-arc and identity-palette catch duplicate-tiling, flat/loopless motion, and
  costume drift ONLY. Geometric incoherence - plank-rotation deaths, anatomy garble
  (fixtures/b4-negative/player_baldbase_death + _hurt are the canonical examples:
  palette-stable AND healthy motion magnitude, measured inseparable from live
  positives by these two metrics) - is OWNED by the mandatory native-scale
  acceptance panel (anim_panel.py) + adversary/owner eyes-on. Intake enforces that
  layer by requiring the panel artifact alongside both verdicts; the panel is not
  optional precisely because of this boundary. Those two fixtures stay in the suite
  marked known-limitation so a future motion-geometry recipe has its calibration
  targets waiting.
"""
import json
import hashlib
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageFilter


def _stats(a):
    lum = a.mean()
    sat = (a.max(axis=2) - a.min(axis=2)).mean()
    return lum, sat


def _body_mask(arr):
    rgb = arr[:, :, :3]
    lum = rgb.mean(axis=2)
    return (arr[:, :, 3] > 200) & (lum > 60)


def _body_tone_and_geometry(arr):
    mask = _body_mask(arr)
    n = int(mask.sum())
    if n == 0:
        return None
    rgb = arr[:, :, :3]
    lum = rgb.mean(axis=2)
    sat = rgb.max(axis=2) - rgb.min(axis=2)
    ys, xs = np.where(mask)
    return {
        "pixels": n,
        "lum": float(lum[mask].mean()),
        "sat": float(sat[mask].mean()),
        "bboxTop": int(ys.min()),
        "bboxBottom": int(ys.max() + 1),
        "bboxLeft": int(xs.min()),
        "bboxRight": int(xs.max() + 1),
        "centroidY": float(ys.mean()),
    }


def check_ground(path, ref=None, band=None):
    checks = []
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(np.float64)
    checks.append(("size_1024", im.size == (1024, 1024), f"{im.size}"))
    lr = np.abs(a[:, 0] - a[:, -1]).mean()
    tb = np.abs(a[0, :] - a[-1, :]).mean()
    adj = np.abs(a[:, 1:] - a[:, :-1]).mean()
    std = a.std()
    checks.append(("wrap_lr<=adj", lr <= adj, f"lr={lr:.2f} adj={adj:.2f}"))
    checks.append(("wrap_tb<=adj", tb <= adj, f"tb={tb:.2f} adj={adj:.2f}"))
    flat = adj < 1.0 and 30 <= std <= 50
    checks.append(("flat_vector_flag", "WARN" if flat else True,
                   f"adj={adj:.2f} std={std:.1f}" + (" -> SIDE-BY-SIDE MANDATORY" if flat else "")))
    lum, sat = _stats(a)
    if ref is not None:
        r = np.asarray(Image.open(ref).convert("RGB")).astype(np.float64)
        rlum, rsat = _stats(r)
        checks.append(("tone_dLum<=6", abs(lum - rlum) <= 6, f"dLum={lum - rlum:+.1f}"))
        checks.append(("tone_dSat<=10", abs(sat - rsat) <= 10, f"dSat={sat - rsat:+.1f}"))
        L, RL = a.mean(axis=2), r.mean(axis=2)
        bl = [L[y:y + 128, x:x + 128].mean() for y in range(0, 897, 128) for x in range(0, 897, 128)]
        rb = [RL[y:y + 128, x:x + 128].mean() for y in range(0, 897, 128) for x in range(0, 897, 128)]
        spread, rspread = max(bl) - min(bl), max(rb) - min(rb)
        checks.append(("hotspot_spread<=1.5x_ref", spread <= 1.5 * rspread,
                       f"spread={spread:.1f} ref={rspread:.1f}"))
    elif band == "walkable":
        checks.append(("tone_lum>=165", lum >= 165, f"lum={lum:.1f}"))
        checks.append(("tone_sat<=150", sat <= 150, f"sat={sat:.1f}"))
        # QUIET-BRIGHT ceilings (owner walk 2026-07-02, cel grass v1 reject — second
        # ground-style reject): a walkable ground is a low-contrast stage; outlined/
        # high-contrast motifs make assets stop popping AND make every tile repeat
        # read as a seam. Reference: old quiet grass adj=1.2 spread=6.9; the rejected
        # busy cel grass adj=4.4 spread=19.9.
        L_ = a.mean(axis=2)
        bl_ = [L_[y:y + 128, x:x + 128].mean() for y in range(0, 897, 128) for x in range(0, 897, 128)]
        spread_ = max(bl_) - min(bl_)
        checks.append(("quiet_adj<=2.5", adj <= 2.5, f"adj={adj:.2f}"))
        checks.append(("quiet_block_spread<=10", spread_ <= 10, f"spread={spread_:.1f}"))
    else:
        checks.append(("tone_reference", False, "need --ref or --band walkable"))
    L = a.mean(axis=2)
    half = im.size[0] // 2
    mlr = np.corrcoef(L[:, :half].ravel(), np.fliplr(L[:, half:]).ravel())[0, 1]
    mtb = np.corrcoef(L[:half, :].ravel(), np.flipud(L[half:, :]).ravel())[0, 1]
    checks.append(("mirror_fold_corr<=0.30", max(mlr, mtb) <= 0.30, f"L|R={mlr:.2f} T|B={mtb:.2f}"))
    return checks


def check_piece(path, master):
    checks = []
    # circular-QA guard (2026-07-03, masswave reject): tone checks are only meaningful
    # vs a LIVE runtime asset or integrator-approved staged master. A master derived
    # from the candidate's own batch makes the PASS circular — surface it loudly.
    mp = Path(master).resolve().as_posix().lower()
    live = "client/public/assets/" in mp
    checks.append(("master_is_live_asset", True if live else "WARN",
                   f"master={mp}" + ("" if live else " — NOT under client/public/assets; "
                    "integrator must confirm it is an approved kept master, else the tone PASS is circular")))
    im = Image.open(path).convert("RGBA")
    p = np.asarray(im).astype(np.float64)
    m = np.asarray(Image.open(master).convert("RGB")).astype(np.float64)
    op = p[:, :, 3] > 200
    if op.sum() < 500:
        return [("opaque_region", False, f"only {int(op.sum())} opaque px")]
    rgb = p[:, :, :3]
    lum = rgb.mean(axis=2)[op].mean()
    sat = (rgb.max(axis=2) - rgb.min(axis=2))[op].mean()
    mlum, msat = _stats(m)
    checks.append(("tone_dLum<=6", abs(lum - mlum) <= 6, f"dLum={lum - mlum:+.1f}"))
    checks.append(("tone_dSat<=10", abs(sat - msat) <= 10, f"dSat={sat - msat:+.1f}"))
    # placeholder heuristic: interior texture vs master at MATCHED scales (piece px
    # density is unknown, so compare against the master downsampled to 1024/512/256 and
    # fail only if the piece is a flat wash vs ALL of them). This catches unambiguous
    # gradient fills; subtle placeholders can pass tone+this — the side-by-side LOOK
    # (recipe 4/13) remains mandatory and is NOT replaced by this tool.
    interior = np.asarray(im.getchannel("A").filter(ImageFilter.MinFilter(17))).astype(np.float64) > 200
    pairs = interior[:, 1:] & interior[:, :-1]
    if pairs.sum() > 2000:
        gray = rgb.mean(axis=2)
        padj = np.abs(gray[:, 1:] - gray[:, :-1])[pairs].mean()
        pstd = gray[interior].std()
        mim = Image.open(master).convert("L")
        scales = {}
        for s in (1024, 512, 256):
            g = np.asarray(mim.resize((s, s), Image.LANCZOS)).astype(np.float64)
            scales[s] = (np.abs(g[:, 1:] - g[:, :-1]).mean(), g.std())
        below_all = all(padj < 0.35 * a and pstd < 0.5 * sd for a, sd in scales.values())
        detail = (f"piece adj={padj:.2f}/std={pstd:.1f} vs master@scales "
                  + " ".join(f"{s}:{a:.2f}/{sd:.1f}" for s, (a, sd) in scales.items()))
        checks.append(("not_flat_wash", not below_all, detail))
    else:
        checks.append(("not_flat_wash", "WARN", "interior too small after erosion; check by eye"))
    # enclosed alpha-hole detector (2026-07-02, grove_moss_to_stone "stamps" survived
    # THREE reworks and two human looks because they are neither dark art nor stray
    # islands — they are semi-transparent HOLES (alpha ~25-40) punched through the
    # artwork; on dark previews they read as dark squares, in-game the ground shows
    # through. A low-alpha component that does NOT touch the border-connected
    # transparent field is a hole; any hole >= 150 px fails. Threshold alpha < 100:
    # the stamp holes measure ~25-40 while deliberate semi-transparent art strokes
    # (wet_sand_to_water wave arcs) sit at 150-175 and must pass.
    low = np.asarray(im.getchannel("A")).astype(np.int32) < 100
    h, w = low.shape
    outside = np.zeros_like(low, dtype=bool)
    stack = [(y, x) for x in range(w) for y in (0, h - 1) if low[y, x]]
    stack += [(y, x) for y in range(h) for x in (0, w - 1) if low[y, x]]
    for y, x in stack:
        outside[y, x] = True
    while stack:
        y, x = stack.pop()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and low[ny, nx] and not outside[ny, nx]:
                outside[ny, nx] = True
                stack.append((ny, nx))
    holes_mask = low & ~outside
    holes = 0
    visited = np.zeros_like(low, dtype=bool)
    hy, hx = np.where(holes_mask)
    for y0, x0 in zip(hy.tolist(), hx.tolist()):
        if visited[y0, x0]:
            continue
        stack = [(y0, x0)]; visited[y0, x0] = True; size = 0
        while stack:
            y, x = stack.pop(); size += 1
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w and holes_mask[ny, nx] and not visited[ny, nx]:
                    visited[ny, nx] = True
                    stack.append((ny, nx))
        if size >= 150:
            holes += 1
    checks.append(("no_enclosed_alpha_holes", holes == 0,
                   f"{holes} enclosed low-alpha hole(s) >=150px inside the artwork"))
    return checks


def check_seed(path, master, reach="low"):
    checks = []
    p = Image.open(path).convert("RGB")
    m = Image.open(master).convert("RGB")
    pw, ph = p.size
    mw, mh = m.size
    checks.append(("canvas_strictly_larger", pw > mw and ph > mh, f"{p.size} vs {m.size}"))
    ox, oy = (pw - mw) // 2, (ph - mh) // 2
    same = ImageChops.difference(p.crop((ox, oy, ox + mw, oy + mh)), m).getbbox() is None
    checks.append(("center_crop_byte_identical", same, "recipe 6"))
    a = np.asarray(p)
    g = ((a[:, :, 1] > 120) & (a[:, :, 1] > a[:, :, 0].astype(int) + 40)
         & (a[:, :, 1] > a[:, :, 2].astype(int) + 40))
    mg = ((a[:, :, 0] > 150) & (a[:, :, 2] > 150) & (a[:, :, 1] < 120))  # magenta key
    subj = ~(g | mg)
    ys = np.where(subj.any(axis=1))[0]
    frac = (ys.max() - ys.min()) / ph if len(ys) else 0.0
    lo, hi = (0.65, 0.85) if reach == "low" else (0.40, 0.60)
    checks.append((f"subject_fraction_{lo:.0%}-{hi:.0%}", lo <= frac <= hi, f"{frac:.1%} (reach={reach})"))
    return checks


BASELINE = Path(__file__).parent / "tile-baseline.json"


def _tile_offenders(dirpath):
    import hashlib
    out = []
    for p in sorted(Path(dirpath).glob("*.png")):
        a = np.asarray(Image.open(p).convert("RGB")).astype(np.float64)
        lr = np.abs(a[:, 0] - a[:, -1]).mean()
        tb = np.abs(a[0, :] - a[-1, :]).mean()
        adj = np.abs(a[:, 1:] - a[:, :-1]).mean()
        if lr > adj or tb > adj:
            sha = hashlib.sha256(p.read_bytes()).hexdigest()
            out.append((p.name, sha, lr, tb, adj))
    return out


def tiles_check(dirpath):
    baseline = json.loads(BASELINE.read_text()) if BASELINE.exists() else {}
    offenders = _tile_offenders(dirpath)
    hard = [o for o in offenders if baseline.get(o[1]) != o[0]]
    exempt = len(offenders) - len(hard)
    if exempt:
        print(f"[tiles] tile-baseline: {exempt} legacy non-tileable file(s) pending "
              f"regeneration (R2+) - exempted, not fixed. See tile-baseline.json.")
    for name, _sha, lr, tb, adj in hard:
        print(f"  [FAIL] {name}: wrap lr={lr:.2f} tb={tb:.2f} > interior adj={adj:.2f} "
              f"(recipe 2 - non-tileable ground art must not ship)")
    total = len(list(Path(dirpath).glob("*.png")))
    if hard:
        print(f"FAIL: {len(hard)} non-tileable tile(s) in {total} scanned under {dirpath}")
        return 1
    print(f"OK: 0 non-tileable tiles in {total} scanned under {dirpath}")
    return 0


def tiles_baseline(dirpath):
    entries = {sha: name for name, sha, *_ in _tile_offenders(dirpath)}
    BASELINE.write_text(json.dumps(entries, indent=2, sort_keys=True))
    print(f"wrote {len(entries)} baseline entries to {BASELINE} - this list may only SHRINK")
    return 0


def _interior_adj(path):
    """Opaque-eroded interior adjacent-pixel delta + std (recipe 3 for objects)."""
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im).astype(np.float64)
    interior = np.asarray(im.getchannel("A").filter(ImageFilter.MinFilter(9))).astype(np.float64) > 200
    pairs = interior[:, 1:] & interior[:, :-1]
    if pairs.sum() < 800:
        return None, None, int(pairs.sum())
    gray = a[:, :, :3].mean(axis=2)
    adj = np.abs(gray[:, 1:] - gray[:, :-1])[pairs].mean()
    return adj, gray[interior].std(), int(pairs.sum())


def check_grey_blotch(path, max_frac):
    """Grey/desaturated-blotch floor for COLORED organic assets (flowers, petals,
    foliage). Added 2026-07-04 after the SECOND occurrence of the grey-petal class:
    debt-burn wave-1 rejected 2 flower patches for grey petals; the wave-2 recolor
    passed mean-hue stats while leaving grey/black smudges (means average over
    blotches). Measures the fraction of opaque pixels that are achromatic at mid
    luminance (spread < 28, lum 45-205 — excludes cel outlines and white
    highlights). Calibration 2026-07-04: rejects measured 1.66%/2.30%; clean cel
    refs 0.00-0.40% (fish stall's legit grey stone = 0.40%). Default floor 1.0%.
    NOT for assets whose subject is legitimately grey (stone, metal) — scope it
    per-card. The side-by-side LOOK stays mandatory."""
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im).astype(np.float64)
    opaque = a[:, :, 3] >= 128
    rgb = a[:, :, :3]
    spread = rgb.max(axis=2) - rgb.min(axis=2)
    lum = rgb.mean(axis=2)
    grey = opaque & (spread < 28) & (lum >= 45) & (lum <= 205)
    n_op = int(opaque.sum())
    if n_op < 400:
        return [("opaque_region", "WARN", f"only {n_op} opaque px; check by eye")]
    frac = grey.sum() / n_op
    return [("grey_pixel_fraction", frac <= max_frac,
             f"grey {int(grey.sum())}/{n_op} opaque = {frac:.2%}; max {max_frac:.2%}")]


def check_sheet_tone(path, static, frames, body_height=None, display_body_height=None):
    from slime_outline_rebuild import _stats as slime_outline_stats

    sheet = Image.open(path).convert("RGBA")
    if frames <= 0:
        return [("frames_positive", False, f"--frames={frames}")]
    if sheet.size[0] % frames != 0:
        return [("sheet_width_divisible_by_frames", False, f"size={sheet.size} frames={frames}")]
    frame_width = sheet.size[0] // frames
    frame_height = sheet.size[1]
    scale_body = body_height if body_height is not None else frame_height
    scale_display = display_body_height if display_body_height is not None else frame_height
    if scale_body <= 0 or scale_display <= 0:
        return [("display_scale_positive", False,
                 f"bodyHeight={scale_body} displayBodyHeight={scale_display}")]
    display_scale = scale_display / scale_body
    static_arr = np.asarray(Image.open(static).convert("RGBA")).astype(np.float64)
    static_stats = _body_tone_and_geometry(static_arr)
    if static_stats is None:
        return [("static_body_mask", False, "no static body pixels with alpha>200 and lum>60")]

    frame_stats = []
    checks = []
    for idx in range(frames):
        crop = sheet.crop((idx * frame_width, 0, (idx + 1) * frame_width, frame_height))
        stats = _body_tone_and_geometry(np.asarray(crop).astype(np.float64))
        if stats is None:
            checks.append((f"f{idx:02d}_body_mask", False, "no body pixels with alpha>200 and lum>60"))
            continue
        stats["frame"] = idx
        stats["dLum"] = stats["lum"] - static_stats["lum"]
        stats["dSat"] = stats["sat"] - static_stats["sat"]
        frame_stats.append(stats)
        rim_stats = slime_outline_stats(crop)
        dark_rim = int(rim_stats["semi_transparent_dark_outline_pixels_alpha_30_220_lum_lte_95"])
        checks.append((f"f{idx:02d}_dLum<=3", abs(stats["dLum"]) <= 3,
                       f"dLum={stats['dLum']:+.1f} lum={stats['lum']:.1f} static={static_stats['lum']:.1f}"))
        checks.append((f"f{idx:02d}_dSat<=10", abs(stats["dSat"]) <= 10,
                       f"dSat={stats['dSat']:+.1f} sat={stats['sat']:.1f} static={static_stats['sat']:.1f}"))
        checks.append((f"f{idx:02d}_dark_outline_rim_px==0", dark_rim == 0,
                       f"semi-transparent dark outline px={dark_rim}"))

    if len(frame_stats) != frames:
        return checks

    lum_jumps = [abs(frame_stats[i + 1]["lum"] - frame_stats[i]["lum"]) for i in range(frames - 1)]
    max_jump = max(lum_jumps) if lum_jumps else 0.0
    checks.append(("adjacent_lum_jump<=5", max_jump <= 5,
                   f"max={max_jump:.1f}; jumps=" + ",".join(f"{v:.1f}" for v in lum_jumps)))

    first = frame_stats[0]
    top_drops = [(stats["bboxTop"] - first["bboxTop"]) * display_scale for stats in frame_stats]
    centroid_drops = [(stats["centroidY"] - first["centroidY"]) * display_scale for stats in frame_stats]
    max_top_drop = max(top_drops)
    max_centroid_drop = max(centroid_drops)
    checks.append(("bbox_top_drop_display_px<=6", max_top_drop <= 6,
                   f"max={max_top_drop:.2f}px; drops=" + ",".join(f"{v:.2f}" for v in top_drops)))
    checks.append(("centroid_y_drop_display_px<=4", max_centroid_drop <= 4,
                   f"max={max_centroid_drop:.2f}px; drops=" + ",".join(f"{v:.2f}" for v in centroid_drops)))
    checks.append(("sheet_tone_metrics", "WARN", json.dumps({
        "static": static_stats,
        "frameWidth": frame_width,
        "frameHeight": frame_height,
        "displayScale": display_scale,
        "frames": frame_stats,
        "topDropsDisplayPx": top_drops,
        "centroidDropsDisplayPx": centroid_drops,
        "adjacentLumJumps": lum_jumps,
    }, separators=(",", ":"))))
    return checks


FLAG_OPTS = {"--loop"}  # bare flags: present -> True, no value token consumed


def _parse_multi_opts(argv):
    opts = {}
    idx = 3
    while idx < len(argv):
        key = argv[idx]
        if key in FLAG_OPTS:
            opts[key] = True
            idx += 1
            continue
        if not key.startswith("--") or idx + 1 >= len(argv):
            raise ValueError(f"expected option/value pair at {key}")
        value = argv[idx + 1]
        if key in opts:
            if isinstance(opts[key], list):
                opts[key].append(value)
            else:
                opts[key] = [opts[key], value]
        else:
            opts[key] = value
        idx += 2
    return opts


def _md5(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _sheet_delta_profile(path, frames):
    im = Image.open(path).convert("RGBA")
    if frames <= 1 or im.size[0] % frames != 0:
        return None
    frame_width = im.size[0] // frames
    arr = np.asarray(im).astype(np.float64)
    deltas = []
    for idx in range(frames - 1):
        a = arr[:, idx * frame_width:(idx + 1) * frame_width, :]
        b = arr[:, (idx + 1) * frame_width:(idx + 2) * frame_width, :]
        mask = (a[:, :, 3] > 50) | (b[:, :, 3] > 50)
        if int(mask.sum()) == 0:
            deltas.append(0.0)
            continue
        delta = np.abs(a[:, :, :3] - b[:, :, :3]).mean(axis=2)
        deltas.append(float(delta[mask].mean()))
    if not deltas:
        return None
    return {
        "frames": frames,
        "frameWidth": frame_width,
        "frameHeight": im.size[1],
        "mean": round(float(np.mean(deltas)), 1),
        "max": round(float(np.max(deltas)), 1),
        "min": round(float(np.min(deltas)), 1),
        "adjacentDeltas": [round(v, 1) for v in deltas],
    }


def _sheet_unique_candidates(root):
    root = Path(root)
    if root.is_file():
        return [root]
    if not root.exists():
        return []
    paths = set(root.rglob("*.clean.png"))
    if "client/public/assets/sprites" in root.as_posix().replace("\\", "/"):
        paths.update(root.rglob("*.png"))
        paths.update(root.rglob("*.webp"))
    return sorted(paths)


def check_sheet_unique(path, against, frames):
    target = Path(path)
    roots = against if isinstance(against, list) else [against]
    cand_md5 = _md5(target)
    cand_profile = _sheet_delta_profile(target, frames)
    matches = []
    compared = 0
    for root in roots:
        for other in _sheet_unique_candidates(root):
            if other.resolve() == target.resolve():
                continue
            compared += 1
            other_md5 = _md5(other)
            if other_md5 == cand_md5:
                matches.append({"path": other.as_posix(), "reason": "md5", "md5": other_md5})
                continue
            other_profile = _sheet_delta_profile(other, frames)
            if cand_profile is None or other_profile is None:
                continue
            cand_key = (cand_profile["mean"], cand_profile["max"], cand_profile["min"])
            other_key = (other_profile["mean"], other_profile["max"], other_profile["min"])
            if cand_key == other_key:
                matches.append({
                    "path": other.as_posix(),
                    "reason": "adjacent-delta-profile",
                    "candidateProfile": cand_profile,
                    "matchedProfile": other_profile,
                })
    return [
        ("candidate_md5", True, cand_md5),
        ("candidate_adjacent_delta_profile", cand_profile is not None,
         json.dumps(cand_profile, separators=(",", ":")) if cand_profile else "unavailable"),
        ("compared_sheet_count", compared > 0, f"compared={compared}"),
        ("no_md5_or_motion_profile_match", len(matches) == 0,
         json.dumps(matches[:20], separators=(",", ":")) if matches else "no matches"),
    ]


def check_trans_palette(path, base_a, base_b, max_delta):
    """Transition-tile palette adjacency vs its two BASE tiles (2026-07-04,
    mechanized after the SECOND occurrence: debt-burn wave-1 rejected all 3
    transitions for style/palette mismatch with their own bases — tiles-check
    proves tileability, not palette adjacency). Takes the 10%-depth band on each
    of the 4 edges; the band nearest each base's overall mean RGB must sit within
    max_delta mean-abs RGB (default 2.0). Calibration: wave-2 accepted
    transitions measured 0.48-1.30; the rejected legacy ones sit far outside."""
    t = np.asarray(Image.open(path).convert("RGB")).astype(np.float64)
    h, w = t.shape[:2]
    d = max(1, int(min(h, w) * 0.10))
    bands = {
        "top": t[:d], "bottom": t[-d:], "left": t[:, :d], "right": t[:, -d:],
    }
    checks = []
    for label, base in (("base_a", base_a), ("base_b", base_b)):
        m = np.asarray(Image.open(base).convert("RGB")).astype(np.float64).reshape(-1, 3).mean(axis=0)
        deltas = {n: float(np.abs(b.reshape(-1, 3).mean(axis=0) - m).mean()) for n, b in bands.items()}
        band, delta = min(deltas.items(), key=lambda kv: kv[1])
        checks.append((f"palette_match_{label}", delta <= max_delta,
                       f"{Path(base).name}: nearest band '{band}' delta={delta:.2f}; max {max_delta:.2f}"))
    return checks


def check_object(path, ref):
    """Style floor vs a KEPT cel reference prop (2026-07-03, masswave flat-vector reject)."""
    checks = []
    cadj, cstd, cn = _interior_adj(path)
    radj, rstd, rn = _interior_adj(ref)
    if cadj is None:
        return [("interior_region", "WARN", f"only {cn} interior pairs; floor n/a — check by eye")]
    if radj is None:
        return [("reference_region", False, f"reference {ref} has only {rn} interior pairs; pick a bigger kept ref")]
    floor = max(5.0, 0.5 * radj)
    checks.append(("style_floor_adj", cadj >= floor,
                   f"cand adj={cadj:.2f}/std={cstd:.1f} vs ref adj={radj:.2f}/std={rstd:.1f}; floor={floor:.2f}"))
    return checks


def _sheet_frames(path, cell):
    """Split SHEET into frames of explicit --cell width. Returns (frames, err).

    The cell is NEVER inferred from the sheet width (spritesheet protocol:
    measure the asset; a 1536px sheet mis-split 4x384 vs 6x256 fooled the
    integrator once - see .claude/skills/phaser-gamedev spritesheets doc)."""
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    if cell <= 0:
        return None, ("cell_positive", False, f"--cell={cell}")
    if w % cell != 0:
        return None, ("sheet_width_divisible_by_cell", False,
                      f"width={w} cell={cell} (remainder {w % cell}) - measure the sheet, never guess the cell")
    n = w // cell
    if n < 2:
        return None, ("frame_count>=2", False, f"width={w} cell={cell} -> {n} frame(s)")
    return [im.crop((i * cell, 0, (i + 1) * cell, h)) for i in range(n)], None


def _adjacent_body_deltas(frames):
    """Mean-abs RGB delta per adjacent frame pair over the union alpha>50 mask."""
    arrs = [np.asarray(f).astype(np.float64) for f in frames]
    deltas = []
    for a, b in zip(arrs, arrs[1:]):
        mask = (a[:, :, 3] > 50) | (b[:, :, 3] > 50)
        if int(mask.sum()) == 0:
            deltas.append(0.0)
            continue
        deltas.append(float(np.abs(a[:, :, :3] - b[:, :, :3]).mean(axis=2)[mask].mean()))
    return deltas


def check_motion_arc(path, cell, loop, dup_floor=3.0, flat_ratio=1.6,
                     loop_floor=1.38, loop_warn=1.55, const_band=0.5):
    """Recipe 18 (2026-07-07): duplicate-tiling / flat-motion gate. See header
    thresholds + ANIMATION-VALIDATOR DOCTRINE (geometric incoherence is the
    acceptance panel's job, not this metric's)."""
    frames, err = _sheet_frames(path, cell)
    if err:
        return [err]
    deltas = _adjacent_body_deltas(frames)
    dmin, dmax = min(deltas), max(deltas)
    ratio = dmax / dmin if dmin > 1e-6 else float("inf")
    fmt = ",".join(f"{v:.1f}" for v in deltas)
    checks = [
        ("cell_explicit", True, f"cell={cell} frames={len(frames)} ({Image.open(path).size[0]}x{Image.open(path).size[1]})"),
        ("constant_deltas", (dmax - dmin) >= const_band,
         f"max-min={dmax - dmin:.2f} (floor {const_band}); constant deltas = whole-sheet duplicate tiling"),
    ]
    dups = [i for i, v in enumerate(deltas) if v < dup_floor]
    checks.append(("duplicate_tiling", len(dups) == 0,
                   f"adjacent deltas < {dup_floor}: " +
                   (", ".join(f"f{i:02d}->f{i + 1:02d}={deltas[i]:.1f}" for i in dups) if dups
                    else f"none (min={dmin:.1f}; calibrated positive floor 11.8)")))
    if loop:
        if ratio < loop_floor:
            checks.append(("flat_loop", False,
                           f"max/min={ratio:.2f} < {loop_floor} (loop band; B4 gather=1.31 sit=1.19)"))
        elif ratio < loop_warn:
            checks.append(("flat_loop", "WARN",
                           f"max/min={ratio:.2f} in WARN band [{loop_floor},{loop_warn}) - PASSES but is "
                           f"borderline-flat for a loop; EYES-ON the panel before accepting (integrator "
                           f"ruling 2026-07-07: thin margins surface loudly, never silently pass)"))
        else:
            checks.append(("flat_loop", True, f"max/min={ratio:.2f} >= {loop_warn}"))
    else:
        checks.append(("flat_profile", ratio >= flat_ratio,
                       f"max/min={ratio:.2f} (non-loop floor {flat_ratio}; live attack=4.96 slime=2.64)"))
    checks.append(("motion_arc_metrics", "WARN", json.dumps({
        "cell": cell, "frames": len(frames), "loop": bool(loop),
        "adjacentDeltas": [round(v, 1) for v in deltas],
        "min": round(dmin, 1), "max": round(dmax, 1),
        "maxMinRatio": round(ratio, 2) if ratio != float("inf") else None,
    }, separators=(",", ":"))))
    return checks


def _garment_histogram(frame, bits=3, min_body=200):
    """512-bin quantized body-pixel histogram; None if the frame has no body."""
    a = np.asarray(frame).astype(np.int32)
    op = a[:, :, 3] > 200
    rgb = a[:, :, :3]
    lum = rgb.mean(axis=2)
    body = op & (lum > 40) & (lum < 235)
    n = int(body.sum())
    if n < min_body:
        return None, n
    px = rgb[body]
    q = px >> (8 - bits)
    idx = (q[:, 0] << (2 * bits)) | (q[:, 1] << bits) | q[:, 2]
    return np.bincount(idx, minlength=1 << (3 * bits)).astype(np.float64) / n, n


def check_identity_palette(path, cell, canon=None, canon_cell=None,
                           max_drift=0.75, max_canon_drift=0.95):
    """Costume-identity gate (2026-07-07). Internal: every frame's garment-swatch
    histogram must stay within max_drift L1 of the sheet's own median frame
    (catches B2-class per-frame outfit morph). --canon: every frame must stay
    within max_canon_drift L1 of the canon sheet's median (catches B3-class
    drift from the character's locked identity; canon must be the SAME character)."""
    frames, err = _sheet_frames(path, cell)
    if err:
        return [err]
    checks = []
    hists = []
    for i, f in enumerate(frames):
        h, n = _garment_histogram(f)
        if h is None:
            checks.append((f"f{i:02d}_body_region", False,
                           f"only {n} garment-band body px (alpha>200, 40<lum<235); empty/blank frame"))
        else:
            hists.append((i, h))
    if len(hists) < 2:
        checks.append(("frames_with_body>=2", False, f"{len(hists)} usable frame(s)"))
        return checks
    V = np.array([h for _, h in hists])
    med = np.median(V, axis=0)
    drifts = [(i, float(np.abs(h - med).sum())) for i, h in hists]
    worst_i, worst = max(drifts, key=lambda t: t[1])
    checks.append(("costume_drift", worst < max_drift,
                   f"max frame-vs-median L1={worst:.3f} at f{worst_i:02d} (floor {max_drift}; "
                   f"B2 morph fixtures 0.83-0.91, all positives <= 0.64)"))
    detail = {"cell": cell, "frames": len(frames),
              "frameVsMedianL1": {f"f{i:02d}": round(d, 3) for i, d in drifts}}
    if canon is not None:
        ccell = int(canon_cell) if canon_cell is not None else cell
        cframes, cerr = _sheet_frames(canon, ccell)
        if cerr:
            checks.append(("canon_" + cerr[0], False, f"canon {canon}: {cerr[2]}"))
        else:
            chists = [h for h, _ in (_garment_histogram(f) for f in cframes) if h is not None]
            if len(chists) < 2:
                checks.append(("canon_frames_with_body>=2", False, f"canon {canon}: {len(chists)} usable frame(s)"))
            else:
                cmed = np.median(np.array(chists), axis=0)
                cdrifts = [(i, float(np.abs(h - cmed).sum())) for i, h in hists]
                cworst_i, cworst = max(cdrifts, key=lambda t: t[1])
                checks.append(("canon_drift", cworst < max_canon_drift,
                               f"max frame-vs-canon-median L1={cworst:.3f} at f{cworst_i:02d} vs {Path(canon).name} "
                               f"(floor {max_canon_drift}; B2-vs-B1 1.08-1.23, same-character pairs <= 0.77)"))
                detail["frameVsCanonMedianL1"] = {f"f{i:02d}": round(d, 3) for i, d in cdrifts}
                detail["canon"] = str(canon)
    checks.append(("identity_palette_metrics", "WARN", json.dumps(detail, separators=(",", ":"))))
    return checks


MODE_VERDICT_SUFFIX = {
    "motion-arc": ".motion-arc-verdict.json",
    "identity-palette": ".identity-palette-verdict.json",
}


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    mode, target = argv[1], argv[2]
    if mode == "tiles-check":
        return tiles_check(target)
    if mode == "tiles-baseline":
        return tiles_baseline(target)
    try:
        opts = _parse_multi_opts(argv)
    except ValueError as exc:
        print(exc)
        return 2
    if mode == "ground":
        checks = check_ground(target, ref=opts.get("--ref"), band=opts.get("--band"))
    elif mode == "piece":
        if "--master" not in opts:
            print("piece mode requires --master")
            return 2
        checks = check_piece(target, opts["--master"])
    elif mode == "object":
        if "--ref" not in opts:
            print("object mode requires --ref (a KEPT cel reference prop)")
            return 2
        checks = check_object(target, opts["--ref"])
    elif mode == "seed":
        if "--master" not in opts:
            print("seed mode requires --master")
            return 2
        checks = check_seed(target, opts["--master"], opts.get("--reach", "low"))
    elif mode == "grey-blotch":
        checks = check_grey_blotch(target, float(opts.get("--max-frac", "0.01")))
    elif mode == "sheet-tone":
        if "--static" not in opts or "--frames" not in opts:
            print("sheet-tone mode requires --static and --frames")
            return 2
        checks = check_sheet_tone(
            target,
            opts["--static"],
            int(opts["--frames"]),
            int(opts["--body-height"]) if "--body-height" in opts else None,
            int(opts["--display-body-height"]) if "--display-body-height" in opts else None,
        )
    elif mode == "sheet-unique":
        if "--against" not in opts:
            print("sheet-unique mode requires --against <dir-or-file>")
            return 2
        checks = check_sheet_unique(target, opts["--against"], int(opts.get("--frames", "11")))
    elif mode == "trans-palette":
        if "--base-a" not in opts or "--base-b" not in opts:
            print("trans-palette mode requires --base-a and --base-b (the two live base tiles)")
            return 2
        checks = check_trans_palette(target, opts["--base-a"], opts["--base-b"],
                                     float(opts.get("--max-delta", "2.0")))
    elif mode == "motion-arc":
        if "--cell" not in opts:
            print("motion-arc mode requires an EXPLICIT --cell (never inferred from width - "
                  "measure the sheet first, spritesheet protocol)")
            return 2
        checks = check_motion_arc(
            target, int(opts["--cell"]), bool(opts.get("--loop")),
            dup_floor=float(opts.get("--dup-floor", "3.0")),
            flat_ratio=float(opts.get("--flat-ratio", "1.6")),
            loop_floor=float(opts.get("--loop-floor", "1.38")),
            loop_warn=float(opts.get("--loop-warn", "1.55")),
        )
    elif mode == "identity-palette":
        if "--cell" not in opts:
            print("identity-palette mode requires an EXPLICIT --cell (never inferred from width)")
            return 2
        checks = check_identity_palette(
            target, int(opts["--cell"]),
            canon=opts.get("--canon"), canon_cell=opts.get("--canon-cell"),
            max_drift=float(opts.get("--max-drift", "0.75")),
            max_canon_drift=float(opts.get("--max-canon-drift", "0.95")),
        )
    else:
        print(__doc__)
        return 2
    # normalize numpy bools (np.False_ is not False) so FAILs cannot slip the summary
    checks = [(n, s if isinstance(s, str) else bool(s), d) for n, s, d in checks]
    failed = [c for c in checks if c[1] is False]
    verdict = {
        "tool": "recipes.py", "mode": mode, "target": str(target),
        "options": opts, "result": "FAIL" if failed else "PASS",
        "checks": [{"name": n, "status": ("WARN" if s == "WARN" else "PASS" if s else "FAIL"),
                    "detail": d} for n, s, d in checks],
    }
    default_suffix = MODE_VERDICT_SUFFIX.get(mode, ".recipes-verdict.json")
    # Verdicts default alongside the input EXCEPT for runtime-tree targets
    # (client/public/assets): dropping JSONs there dirties the shipped asset dir and
    # trips the B3 visual-proof commit gate (bit the anim-validators intake itself,
    # 2026-07-07). Runtime-target verdicts land in tools/_anim-verdicts/ instead
    # (gitignored scratch); --json always wins.
    default_out = Path(target).with_suffix("").as_posix() + default_suffix
    norm = Path(target).as_posix()
    if "client/public/assets/" in norm and not opts.get("--json"):
        default_out = "tools/_anim-verdicts/" + Path(default_out).name
    out = Path(opts.get("--json") or default_out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(verdict, indent=2))
    width = max(len(n) for n, _, _ in checks)
    for n, s, d in checks:
        tag = "WARN" if s == "WARN" else "PASS" if s else "FAIL"
        print(f"  [{tag}] {n:<{width}}  {d}")
    print(f"{verdict['result']}: {mode} {target} (verdict: {out})")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

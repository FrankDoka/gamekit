# asset-cleanup — chroma-fringe detection + despill

`fringe.py` finds and removes the magenta/green **halo** that survives in the alpha edge
band when an asset is generated/keyed on a chroma background and not properly de-spilled.
It was built after a 2026-06-30 audit found ~1,100 bank assets (and 4 shipping keep-set
assets) with baked-in fringe. Requires Pillow (`pip install Pillow`); the repo's default
`python` already has it.

## How it decides (and why it's safe)

- It looks **only at the alpha boundary band** (pixels within 2px of a fully-transparent
  pixel). Interior translucency — a glowing/ethereal creature's body — is never touched, so
  legitimately green/purple art is not damaged.
- The hard gate also checks for compact **interior semi-alpha islands**: large 10<alpha<200
  blobs away from the silhouette edge, usually caused by rembg over-erasing real prop geometry.
- An asset is flagged for a hue only when the **boundary** carries that hue but the **body**
  does not (e.g. a tan shell with a magenta rim, a gold tile with a green rim). A purple
  crystal or a green slime — whose body *is* the hue — is left alone.
- Despill pulls the off-channels toward the dominant channel in the boundary band only;
  near-pure bleed has its alpha faded. Opaque interior pixels are never modified.

## Commands

```bash
# list offenders under a path (+ folder summary; optional JSON manifest)
python tools/asset-cleanup/fringe.py scan Z:/Assets/items
python tools/asset-cleanup/fringe.py scan Z:/Assets/items --json offenders.json

# CI gate — exit 1 if ANY offender is found. This is exactly what `pnpm assets:check`
# runs (no --exclude: sprites/ IS scanned — package.json is the source of truth).
python tools/asset-cleanup/fringe.py check client/public/assets

# fix — dry-run by default; --run applies; --backup keeps originals
python tools/asset-cleanup/fringe.py despill Z:/Assets/items                       # preview
python tools/asset-cleanup/fringe.py despill Z:/Assets/items --run --backup Z:/Assets/_cleanup-backups/despill-20260630

# rimfix — magenta cast on SOFT-ALPHA rim pixels (despill's classifier misses this class;
# it reads as pink smudging over terrain — devlog 0185). Fix bank + runtime in lockstep.
python tools/asset-cleanup/rimfix.py scan client/public/assets/tiles
python tools/asset-cleanup/rimfix.py fix <paths...> --run --backup <dir>

# resize-prop — re-derive a runtime prop at a new display size from its 1024px bank master
# (1:1 rule: props ship at exact on-screen px; see visual-tuning-playbook "scale sanity")
python tools/asset-cleanup/resize-prop.py harbor_stone_well 170 --run --backup <dir>

# pixelate-npc — derive a runtime NPC/character sprite from its painterly bank master,
# style-matched to the pixel-art player (crop + LANCZOS + sharpen + 48-color quantize +
# hard alpha + 1px outline). Plain resize is NOT enough for characters — devlog 0188.
python tools/asset-cleanup/pixelate-npc.py npc_harbor_warden --run --backup <dir>
```

`PATH` may be a single file or a directory (recursed). Backup/derivative dirs
(`_cleanup*`, `_rejected`, `_archive`, `_sliced`, `thumbs`, …) are skipped automatically;
add more with `--exclude NAME ...`.

## pnpm scripts

- `pnpm assets:scan <path>` — list offenders.
- `pnpm assets:check` — gate the promoted keep-set (`client/public/assets`, excluding
  `sprites/` which the animation pipeline owns). Wired into `pnpm validate`.
- `pnpm assets:despill <path> [--run --backup <dir>]` — despill.

## Scope notes

- **Static bank assets** (items, props, environments, ui, vfx) are the clean fit for despill
  + per-asset visual QA.
- **Character/monster animation assets** are owned by the Pipeline v4 / BiRefNet matte
  process. Use `scan` there as a *guide*, prefer cleaning the **source contact sheet** then
  re-slicing (don't despill `*_sliced` derivative frames), and visually QA each — translucent
  creatures can still be edge-flagged.
- Despill removes a colour *halo*; it does **not** re-cut a bad alpha matte. If the alpha
  itself is wrong, re-matte with rembg/BiRefNet (64-bit Python) instead.

## tint_recolor.py — offline material-family recolor (Phase-3 palette layer)

Palette is **OFFLINE RECOLOR**, not runtime identity tint (animation-economics.md
§10; phase3-binding.md §3). `tint_recolor.py` takes an accepted bald-base sheet
plus a **material-family mask spec** (color families, NOT hand-painted regions)
plus a target palette, and emits a recolored sheet whose diff is **confined** to
the family masks. Any changed pixel outside the union of family masks is *mask
leakage* → verdict `MASK-LEAKAGE`, nonzero exit (recipe-15 style diff-confinement
proof). Recolor is cel-safe: it shifts a family's hue/saturation while
**preserving each pixel's value** (shading structure kept), so all cel shades of
one family move together. It targets families by color (the cel palette
discipline in phase3-binding.md §3 makes skin / cloth-tint families separable);
no tint mask is baked into runtime pixels.

```bash
# built-in selftest (deterministic fixture; stray-pixel count asserted 0,
# value-preserving + idempotent). Wired into `pnpm validate` via
# `pnpm assets:tint-selftest` (test_tint_recolor.py drives it + failure modes).
python tools/asset-cleanup/tint_recolor.py --selftest

# recolor a real sheet by family; verdict JSON + confinement proof
python tools/asset-cleanup/tint_recolor.py recolor <sheet.png> \
    --spec <mask_spec.json> --out <recolored.png> --verdict <verdict.json>
```

Mask spec shape — `families[name] = {source: [hex...], target: hex, tolerance?}`;
`source` swatches come from the accepted-package tint-mask note (per-sheet), and
a pixel belongs to a family iff within `tolerance` (RGB Euclid, default 24) of
any source swatch. Exit 0 = OK (no leakage); 1 = leakage/stray; 2 = bad args.
**Idempotency caveat:** the recolor is idempotent only when the target family is
disjoint (in the tolerance metric) from every source family — a near-identity
same-hue shift can keep bright cels inside the source ball and re-match on a
second pass. Dye to a distinct hue (the real recolor case) for stable output.
It wires **no runtime consumer** — tool + fixtures only.

## frames.py — border-frame / matte-box / sliver artifacts (second defect class)

The 2026-06-30 cleanup surfaced a second artifact beyond chroma fringe: a faint rectangular
**frame / guide box / edge sliver** baked near the canvas border, separated from the subject by
transparency (the "lines on top and sides"). `frames.py` finds and removes them.

```bash
python tools/asset-cleanup/frames.py scan Z:/Assets/items          # list suspects (pnpm assets:frames)
python tools/asset-cleanup/frames.py fix  Z:/Assets/items          # dry-run
python tools/asset-cleanup/frames.py fix  Z:/Assets/items --run --backup Z:/Assets/_cleanup-backups/frames-20260630
```

- **Detection is a heuristic** — a long thin subject (spear, staff) reaching the border is a
  **false positive**. Always confirm visually; do **not** hard-gate on it (kept out of
  `pnpm validate` and the bank accept/promote gate for this reason).
- **`fix` is an assisted auto-fix:** it keeps the largest connected blob (the subject) and
  erases other *border-touching* components smaller than it. This cleanly removes **detached**
  frames/slivers and safely leaves false positives alone (the subject is never erased). It
  **cannot** remove a frame that is *connected* to the subject or fainter than the alpha
  threshold, and it can over-erase legit **detached glow bits (VFX)** — so `fix` reports
  residual `COULD-NOT-FIX` flags, and VFX / glow-heavy art needs a human pass. Backups + a
  per-asset visual check are mandatory.

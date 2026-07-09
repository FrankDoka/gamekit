# Art Pipeline

Automated asset generation pipeline for the game.

This directory is for scripts and helpers. Store asset media according to
[docs/process/asset-storage.md](<repo root>/docs/process/asset-storage.md):
raw intake in `assets/sources/raw/`, accepted rebuild sources in
`assets/sources/accepted/`, temporary candidates in `tmp/`, and browser-ready runtime files
under `client/public/assets/`.

## Setup

```bash
# Install dependencies:
pip install replicate opencv-python-headless Pillow python-dotenv

# Only needed for paid/API generation:
# Create a .env file in this directory (gitignored) with provider keys.
```

## Scripts

| Script | Purpose | Status |
|--------|---------|--------|
| `animate.py` | Generate animation clips via Seedance 2.0 on Replicate | Ready |
| `extract_frames.py` | Extract frames from video (OpenCV) | Ready |
| `remove_bg_birefnet_local.py` | Preferred local BiRefNet matte extraction for animated/gameplay sprites | Ready |
| `remove_bg.py` | Legacy Replicate/chroma background removal path | Ready |
| `make_spritesheet.py` | Pack transparent PNG frames into horizontal WebP sheet | Ready |
| `pipeline.py` | Run the full pipeline end-to-end for one entity+state | Ready |
| `config.py` | Legacy shared paths for local-only raw/frame/sprite scratch | Ready |

## Usage

```bash
# Full pipeline (generates video, extracts, cleans, packs):
python pipeline.py --input monster_mossling.png --entity monster_mossling --state idle

# With manual frame selection:
python pipeline.py --input player_wayfarer.png --entity player_wayfarer --state idle \
  --frame-indices 8,14,20,26 --fps 6

# Skip Seedance (use existing video):
python pipeline.py --entity monster_mossling --state idle --skip-animate \
  --video assets/sources/raw/monster_mossling_idle.mp4

# Dry run (print plan, no API calls):
python pipeline.py --input player_wayfarer.png --entity player_wayfarer --state idle --dry-run

# Run steps individually:
python animate.py --input monster_mossling.png --state idle
python extract_frames.py --video assets/sources/raw/monster_mossling_idle.mp4 --count 60
python remove_bg_birefnet_local.py --input frames/monster_mossling_idle/ --output frames/monster_mossling_idle_alpha/
python make_spritesheet.py --input frames/monster_mossling_idle_clean/
```

For Seedance/video animation, always extract a broad review pool first. A normal 4-5 second
clip should produce about 50-60 frames for Frame Picker review, then the final runtime loop
is downselected from that pool.

## Output Structure

```
<repo root>/
  assets/sources/raw/       # Local raw intake/scratch clips, ignored by Git
  assets/sources/accepted/  # Accepted production source clips/images
  tmp/                      # Candidate frame pools, audits, and generated intermediates
  client/public/assets/     # Browser-ready runtime assets loaded by the game
  tools/art-pipeline/       # Scripts and helpers only
```

Legacy helper scripts may still write local scratch folders such as `frames/` or `sprites/`
inside `tools/art-pipeline/`; do not treat those as accepted production storage.

When promoting manually, copy only game-ready runtime files to `client/public/assets/`.
- `{entity}_{state}.webp` — horizontal sprite sheet
- `{entity}_{state}.json` — metadata (frame size, fps, origin, etc.)
- `{entity}_{state}_preview.png` — contact sheet on multiple backgrounds

## Background Removal

Current rule for future player, NPC, monster, and animated sprite work:

- **local BiRefNet matte**: required for production Seedance/video frames and any asset where edge crawl matters. Check `tmp/birefnet64-venv` first and use `tmp\birefnet64-venv\Scripts\python.exe` for the helper. Verify Torch before production matte work:

  ```powershell
  tmp\birefnet64-venv\Scripts\python.exe -c "import torch; print(torch.__version__, torch.cuda.is_available())"
  ```

  Then run:

  ```powershell
  tmp\birefnet64-venv\Scripts\python.exe tools/art-pipeline/remove_bg_birefnet_local.py --input <selected-frame-dir> --output <matte-output-dir> --model-size 1024 --device cuda --force
  ```

  If the venv, Torch import, model weights/cache, or helper run is missing or fails, stop and report the blocker. Do not continue to final runtime assets from a fallback cleanup.
- **chroma/component cleanup**: quick experiment or preview-comparison fallback only. It is not allowed for production runtime promotion unless the owner explicitly accepts that deviation after seeing the risk.
- **Replicate/API BiRefNet**: legacy/explicit-only path. Do not use it unless the owner approves the paid/API run.

After background removal, run cleanup to zero hidden transparent RGB, remove green/magenta fringe, and remove low-alpha dark edge crawl before promotion.

## Prompt Style Guide

For generating source art with consistent outlines (from Codex research):

```
high-resolution hand-painted game sprite with crisp pixel-clean edges,
strong dark outer contour, outer outline slightly heavier than interior details,
crisp dark brown or near-black internal linework,
readable silhouette at 80-96px display size,
painterly cel-shaded surfaces, not blocky low-res pixel art
```

Avoid: "pixel art", "8-bit", "low resolution", "blocky", "retro sprite"

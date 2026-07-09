"""Shared config for the art pipeline."""

from pathlib import Path

PIPELINE_ROOT = Path(__file__).parent
RAW_DIR = PIPELINE_ROOT / "raw"
FRAMES_DIR = PIPELINE_ROOT / "frames"
SPRITES_DIR = PIPELINE_ROOT / "sprites"

for d in (RAW_DIR, FRAMES_DIR, SPRITES_DIR):
    d.mkdir(exist_ok=True)

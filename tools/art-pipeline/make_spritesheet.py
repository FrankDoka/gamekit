"""Pack transparent PNG frames into a horizontal sprite sheet (WebP)."""

import argparse
import json
from pathlib import Path

from PIL import Image

from config import SPRITES_DIR


def find_content_bbox(frames: list[Image.Image]) -> tuple[int, int, int, int]:
    """Find the tightest bounding box that contains all non-transparent pixels across all frames."""
    min_x, min_y = float("inf"), float("inf")
    max_x, max_y = 0, 0

    for frame in frames:
        bbox = frame.getbbox()
        if bbox:
            min_x = min(min_x, bbox[0])
            min_y = min(min_y, bbox[1])
            max_x = max(max_x, bbox[2])
            max_y = max(max_y, bbox[3])

    if min_x == float("inf"):
        return (0, 0, frames[0].width, frames[0].height)

    pad = 4
    return (
        max(0, min_x - pad),
        max(0, min_y - pad),
        min(frames[0].width, max_x + pad),
        min(frames[0].height, max_y + pad),
    )


def make_spritesheet(
    frames_dir: Path,
    output_image: Path | None = None,
    output_json: Path | None = None,
    max_frames: int | None = None,
    skip_every: int = 1,
) -> tuple[Path, Path]:
    frame_paths = sorted(frames_dir.glob("frame_*.png"))
    if not frame_paths:
        raise ValueError(f"No frame_*.png files found in {frames_dir}")

    if skip_every > 1:
        frame_paths = frame_paths[::skip_every]
    if max_frames and len(frame_paths) > max_frames:
        frame_paths = frame_paths[:max_frames]

    frames = [Image.open(p).convert("RGBA") for p in frame_paths]
    print(f"[spritesheet] {len(frames)} frames loaded from {frames_dir}")

    bbox = find_content_bbox(frames)
    crop_w = bbox[2] - bbox[0]
    crop_h = bbox[3] - bbox[1]
    print(f"[spritesheet] Content bbox: {bbox} -> {crop_w}x{crop_h} per frame")

    cropped = [f.crop(bbox) for f in frames]

    sheet_w = crop_w * len(cropped)
    sheet_h = crop_h
    sheet = Image.new("RGBA", (sheet_w, sheet_h), (0, 0, 0, 0))
    for i, frame in enumerate(cropped):
        sheet.paste(frame, (i * crop_w, 0))

    stem = frames_dir.name
    img_out = output_image or (SPRITES_DIR / f"{stem}.webp")
    json_out = output_json or (SPRITES_DIR / f"{stem}.json")
    img_out.parent.mkdir(parents=True, exist_ok=True)

    sheet.save(img_out, "WEBP", quality=90, lossless=False)

    meta = {
        "name": stem,
        "frameWidth": crop_w,
        "frameHeight": crop_h,
        "frameCount": len(cropped),
        "columns": len(cropped),
        "rows": 1,
        "sheetWidth": sheet_w,
        "sheetHeight": sheet_h,
        "sourceFrameCount": len(list(frames_dir.glob("frame_*.png"))),
        "skipEvery": skip_every,
    }
    json_out.write_text(json.dumps(meta, indent=2))

    size_kb = img_out.stat().st_size / 1024
    print(f"[spritesheet] Saved: {img_out} ({size_kb:.1f} KB, {len(cropped)} frames @ {crop_w}x{crop_h})")
    print(f"[spritesheet] Meta: {json_out}")
    return img_out, json_out


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Pack frames into a sprite sheet")
    parser.add_argument("--input", type=Path, required=True, help="Directory of frame_*.png files")
    parser.add_argument("--output", type=Path, help="Output sprite sheet path (.webp)")
    parser.add_argument("--json", type=Path, help="Output JSON metadata path")
    parser.add_argument("--max-frames", type=int, help="Maximum frames to include")
    parser.add_argument("--skip-every", type=int, default=1, help="Take every Nth frame (default: 1)")
    args = parser.parse_args()
    make_spritesheet(args.input, args.output, args.json, args.max_frames, args.skip_every)

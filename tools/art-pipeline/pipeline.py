"""End-to-end animation pipeline: animate → extract → remove bg → spritesheet.

Usage:
    python pipeline.py --input monster_mossling.png --entity monster_mossling --state idle
    python pipeline.py --input player_wayfarer.png --entity player_wayfarer --state idle --frame-count 60 --fps 6
    python pipeline.py --input monster_mossling.png --entity monster_mossling --state idle --skip-animate --video raw/monster_mossling_idle.mp4
"""

import argparse
import json
from pathlib import Path

from PIL import Image

from config import RAW_DIR, FRAMES_DIR, SPRITES_DIR

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass

ANIM_OUTPUT_DIR = Path(__file__).parent / ".." / ".." / "client" / "public" / "assets" / "sprites" / "animations"


def run_pipeline(
    input_image: Path,
    entity: str,
    state: str = "idle",
    frame_count: int = 4,
    frame_indices: list[int] | None = None,
    fps: int = 6,
    loop: bool = True,
    frame_width: int = 192,
    frame_height: int = 192,
    display_size: int = 80,
    baseline_y: int | None = None,
    matte: str = "birefnet",
    key_color: str = "green",
    duration: int = 4,
    prompt: str | None = None,
    skip_animate: bool = False,
    video: Path | None = None,
    output_dir: Path | None = None,
    dry_run: bool = False,
) -> dict:
    from animate import animate
    from extract_frames import extract_frames
    from remove_bg import remove_bg_batch, check_edge_quality
    from make_spritesheet import make_spritesheet

    tag = f"{entity}_{state}"
    out_dir = output_dir or ANIM_OUTPUT_DIR
    out_dir = out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    if baseline_y is None:
        baseline_y = int(frame_height * 0.85)

    print(f"\n{'='*60}")
    print(f"  Animation Pipeline: {tag}")
    print(f"{'='*60}")
    print(f"  Entity:     {entity}")
    print(f"  State:      {state}")
    print(f"  Frame size: {frame_width}x{frame_height}")
    print(f"  Display:    {display_size}px")
    print(f"  FPS:        {fps}")
    print(f"  Loop:       {loop}")
    print(f"  Matte:      {matte}")
    print(f"  Key color:  {key_color}")
    print(f"{'='*60}\n")

    if dry_run:
        print("[pipeline] DRY RUN — no API calls, no files written.")
        return {"status": "dry_run", "tag": tag}

    # Step 1: Generate animation video
    if skip_animate:
        if not video:
            video = RAW_DIR / f"{tag}.mp4"
        if not video.exists():
            raise FileNotFoundError(f"--skip-animate but video not found: {video}")
        print(f"[pipeline] Step 1: SKIP — using existing video: {video}")
        video_path = video
    else:
        print("[pipeline] Step 1: Generating animation via Seedance...")
        video_path = animate(input_image, state, RAW_DIR / f"{tag}.mp4", prompt, duration)

    # Step 2: Extract frames
    print("\n[pipeline] Step 2: Extracting frames...")
    frames_dir = FRAMES_DIR / tag
    extract_frames(video_path, frames_dir, frame_count, frame_indices)

    # Step 3: Remove background
    print("\n[pipeline] Step 3: Removing background...")
    clean_dir = FRAMES_DIR / f"{tag}_clean"
    remove_bg_batch(frames_dir, clean_dir, matte, key_color)

    # Step 3.5: Edge quality check
    print("\n[pipeline] Step 3.5: Checking edge quality...")
    all_warnings = []
    for f in sorted(clean_dir.glob("frame_*.png")):
        warnings = check_edge_quality(f)
        all_warnings.extend(warnings)
        for w in warnings:
            print(f"  {w}")
    if not all_warnings:
        print("  No edge quality warnings.")

    # Step 4: Make spritesheet
    print("\n[pipeline] Step 4: Building spritesheet...")
    sheet_path = out_dir / f"{tag}.webp"
    meta_path = out_dir / f"{tag}.json"
    make_spritesheet(clean_dir, sheet_path, meta_path)

    # Step 5: Enrich metadata
    meta = json.loads(meta_path.read_text())
    meta.update({
        "schemaVersion": 1,
        "entity": entity,
        "animation": state,
        "sourceVideo": str(video_path),
        "displaySize": display_size,
        "fps": fps,
        "loop": loop,
        "origin": {"x": 0.5, "y": round(baseline_y / frame_height, 2)},
        "baselineY": baseline_y,
        "keyColor": key_color,
        "matteMethod": matte,
    })
    if frame_indices:
        meta["selectedFrames"] = frame_indices
    meta_path.write_text(json.dumps(meta, indent=2))

    # Step 6: Generate preview contact sheet
    print("\n[pipeline] Step 6: Generating preview...")
    preview_path = out_dir / f"{tag}_preview.png"
    generate_preview(clean_dir, preview_path)

    print(f"\n{'='*60}")
    print(f"  Pipeline complete: {tag}")
    print(f"  Sheet:   {sheet_path}")
    print(f"  Meta:    {meta_path}")
    print(f"  Preview: {preview_path}")
    if all_warnings:
        print(f"  ⚠ {len(all_warnings)} edge quality warnings — review preview!")
    print(f"{'='*60}\n")

    return {
        "status": "ok",
        "tag": tag,
        "sheet": str(sheet_path),
        "metadata": str(meta_path),
        "preview": str(preview_path),
        "warnings": all_warnings,
    }


def generate_preview(frames_dir: Path, output: Path):
    """Generate a contact sheet showing frames on multiple backgrounds."""
    frames = sorted(frames_dir.glob("frame_*.png"))
    if not frames:
        print("[preview] No frames to preview.")
        return

    imgs = [Image.open(f).convert("RGBA") for f in frames]
    fw, fh = imgs[0].size

    backgrounds = [
        ("checker", None),
        ("dark", (30, 30, 30)),
        ("light", (220, 220, 220)),
        ("green_check", (0, 255, 0)),
        ("terrain", (90, 110, 70)),
    ]

    padding = 4
    row_w = (fw + padding) * len(imgs) + padding
    total_h = (fh + padding + 16) * len(backgrounds) + padding

    preview = Image.new("RGBA", (row_w, total_h), (40, 40, 40, 255))

    y = padding
    for bg_name, bg_color in backgrounds:
        for i, img in enumerate(imgs):
            x = padding + i * (fw + padding)

            if bg_color:
                bg_tile = Image.new("RGBA", (fw, fh), (*bg_color, 255))
            else:
                bg_tile = Image.new("RGBA", (fw, fh), (200, 200, 200, 255))
                for cx in range(0, fw, 8):
                    for cy in range(0, fh, 8):
                        if (cx // 8 + cy // 8) % 2 == 0:
                            for dx in range(min(8, fw - cx)):
                                for dy in range(min(8, fh - cy)):
                                    bg_tile.putpixel((cx + dx, cy + dy), (160, 160, 160, 255))

            bg_tile.paste(img, (0, 0), img)
            preview.paste(bg_tile, (x, y))

        y += fh + padding + 16

    output.parent.mkdir(parents=True, exist_ok=True)
    preview.save(output, "PNG")
    print(f"[preview] Saved: {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="End-to-end animation pipeline")
    parser.add_argument("--input", type=Path, help="Input character image (for Seedance)")
    parser.add_argument("--entity", type=str, required=True, help="Entity ID (e.g. monster_mossling)")
    parser.add_argument("--state", default="idle", help="Animation state")
    parser.add_argument("--frame-count", type=int, default=60, help="Broad review frames to extract from video before downselection")
    parser.add_argument("--frame-indices", type=str, help="Comma-separated frame indices")
    parser.add_argument("--fps", type=int, default=6, help="Playback FPS")
    parser.add_argument("--no-loop", action="store_true", help="Non-looping animation")
    parser.add_argument("--frame-width", type=int, default=192)
    parser.add_argument("--frame-height", type=int, default=192)
    parser.add_argument("--display-size", type=int, default=96)
    parser.add_argument("--baseline-y", type=int)
    parser.add_argument("--matte", choices=["birefnet", "chroma"], default="birefnet")
    parser.add_argument("--key-color", choices=["green", "magenta"], default="green")
    parser.add_argument("--duration", type=int, default=4, help="Seedance video duration (seconds)")
    parser.add_argument("--prompt", type=str, help="Custom Seedance prompt")
    parser.add_argument("--skip-animate", action="store_true", help="Skip Seedance, use existing video")
    parser.add_argument("--video", type=Path, help="Existing video path (with --skip-animate)")
    parser.add_argument("--output-dir", type=Path, help="Output directory")
    parser.add_argument("--dry-run", action="store_true", help="Print plan without running")
    args = parser.parse_args()

    idx = [int(x) for x in args.frame_indices.split(",")] if args.frame_indices else None
    run_pipeline(
        input_image=args.input,
        entity=args.entity,
        state=args.state,
        frame_count=args.frame_count,
        frame_indices=idx,
        fps=args.fps,
        loop=not args.no_loop,
        frame_width=args.frame_width,
        frame_height=args.frame_height,
        display_size=args.display_size,
        baseline_y=args.baseline_y,
        matte=args.matte,
        key_color=args.key_color,
        duration=args.duration,
        prompt=args.prompt,
        skip_animate=args.skip_animate,
        video=args.video,
        output_dir=args.output_dir,
        dry_run=args.dry_run,
    )

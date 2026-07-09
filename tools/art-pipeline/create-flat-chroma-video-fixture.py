"""Create a local flat-chroma video from an existing runtime spritesheet.

This is a no-API proof-source helper for the animation intake pipeline. It lets us exercise
video intake with real game runtime art when no owner-provided flat-chroma clip exists.
The generated clip is still synthetic evidence, not a replacement for an AI/video-provider
production source.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

from PIL import Image


DEFAULT_KEY = "#ff00ff"


def parse_color(value: str) -> tuple[int, int, int]:
    raw = value.strip()
    aliases = {
        "magenta": "#ff00ff",
        "green": "#00ff00",
        "blue": "#0000ff",
    }
    raw = aliases.get(raw.lower(), raw)
    if raw.startswith("#"):
        raw = raw[1:]
    if len(raw) != 6:
        raise argparse.ArgumentTypeError(f"expected #rrggbb color, got {value!r}")
    try:
        return tuple(int(raw[index : index + 2], 16) for index in (0, 2, 4))
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"expected #rrggbb color, got {value!r}") from exc


def run(command: list[str]) -> None:
    subprocess.run(command, check=True)


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def clean_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def split_sheet(sheet_path: Path, frame_width: int, frame_height: int, frame_count: int) -> list[Image.Image]:
    sheet = Image.open(sheet_path).convert("RGBA")
    if sheet.height < frame_height or sheet.width < frame_width * frame_count:
        raise ValueError(
            f"Sheet {sheet_path} is {sheet.width}x{sheet.height}, too small for "
            f"{frame_count} frames of {frame_width}x{frame_height}"
        )
    frames: list[Image.Image] = []
    for index in range(frame_count):
        left = index * frame_width
        frames.append(sheet.crop((left, 0, left + frame_width, frame_height)))
    return frames


def write_chroma_frames(
    frames: list[Image.Image],
    output_dir: Path,
    key_color: tuple[int, int, int],
    loops: int,
) -> list[Path]:
    clean_dir(output_dir)
    paths: list[Path] = []
    frame_index = 0
    for _ in range(loops):
        for frame in frames:
            background = Image.new("RGBA", frame.size, (*key_color, 255))
            background.alpha_composite(frame)
            rgb = background.convert("RGB")
            path = output_dir / f"frame-{frame_index:04d}.png"
            rgb.save(path)
            paths.append(path)
            frame_index += 1
    return paths


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a flat-chroma MP4 from a runtime spritesheet")
    parser.add_argument("--sheet", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--key-color", default=DEFAULT_KEY)
    parser.add_argument("--loops", type=int, default=3)
    parser.add_argument("--fps", type=int)
    parser.add_argument("--frames-dir", type=Path)
    args = parser.parse_args()

    metadata = read_json(args.metadata)
    frame_width = int(metadata["frameWidth"])
    frame_height = int(metadata["frameHeight"])
    frame_count = int(metadata["frameCount"])
    fps = int(args.fps or metadata.get("fps") or 8)
    if args.loops <= 0:
        raise ValueError("--loops must be positive")

    key_color = parse_color(args.key_color)
    frames_dir = args.frames_dir or args.output.with_suffix("") / "frames"
    source_frames = split_sheet(args.sheet, frame_width, frame_height, frame_count)
    write_chroma_frames(source_frames, frames_dir, key_color, args.loops)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    run(
        [
            "ffmpeg",
            "-hide_banner",
            "-y",
            "-framerate",
            str(fps),
            "-i",
            str(frames_dir / "frame-%04d.png"),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(args.output),
        ]
    )

    summary = {
        "output": str(args.output),
        "sourceSheet": str(args.sheet),
        "metadata": str(args.metadata),
        "frameWidth": frame_width,
        "frameHeight": frame_height,
        "frameCount": frame_count,
        "fps": fps,
        "loops": args.loops,
        "keyColor": args.key_color,
        "framesDir": str(frames_dir),
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()

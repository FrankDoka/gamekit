"""Extract frames from a video file using OpenCV."""

import argparse
from pathlib import Path

import cv2

from config import FRAMES_DIR


def extract_frames(
    video: Path,
    output_dir: Path | None = None,
    count: int | None = None,
    indices: list[int] | None = None,
) -> list[Path]:
    out = output_dir or (FRAMES_DIR / video.stem)
    out.mkdir(parents=True, exist_ok=True)

    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video}")

    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    print(f"[extract] Video: {video.name} — {total} frames, {fps:.1f} fps")

    if indices:
        target_indices = sorted(indices)
    elif count:
        step = max(1, total // count)
        target_indices = [i * step for i in range(count)]
    else:
        target_indices = list(range(total))

    target_indices = [i for i in target_indices if i < total]
    print(f"[extract] Extracting {len(target_indices)} frames: {target_indices[:10]}{'...' if len(target_indices) > 10 else ''}")

    saved = []
    target_set = set(target_indices)
    frame_idx = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx in target_set:
            out_path = out / f"frame_{frame_idx:04d}.png"
            cv2.imwrite(str(out_path), frame)
            saved.append(out_path)
        frame_idx += 1

    cap.release()
    print(f"[extract] Saved {len(saved)} frames to {out}")
    return saved


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract frames from video")
    parser.add_argument("--video", type=Path, required=True, help="Input video file")
    parser.add_argument("--output", type=Path, help="Output directory for frames")
    parser.add_argument("--count", type=int, default=60, help="Number of evenly-spaced review frames to extract; use about 50-60 for Seedance/video sources")
    parser.add_argument("--indices", type=str, help="Comma-separated frame indices (e.g. 8,14,20,26)")
    args = parser.parse_args()

    idx = [int(x) for x in args.indices.split(",")] if args.indices else None
    extract_frames(args.video, args.output, args.count, idx)

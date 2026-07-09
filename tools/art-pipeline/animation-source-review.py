#!/usr/bin/env python3
"""Review a generated animation source sheet before intake.

This is a pre-intake gate. It catches sheets that look nice as still art but are not usable
animation sources because frames are duplicated, too static, off-model, clipped, or dirty.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from statistics import mean, median
from typing import Any

from PIL import Image

KEY_COLORS = {
    "magenta": "#ff00ff",
    "green": "#00ff00",
    "blue": "#0000ff",
}


def parse_color(value: str | None) -> tuple[int, int, int] | None:
    if not value:
        return None
    raw = KEY_COLORS.get(value.lower(), value).strip()
    if raw.startswith("#"):
        raw = raw[1:]
    if len(raw) != 6:
        raise ValueError(f"Invalid color: {value}")
    return int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16)


def remove_key(img: Image.Image, key: tuple[int, int, int] | None, transparent: int, soft: int) -> Image.Image:
    rgba = img.convert("RGBA")
    if key is None:
        return rgba
    kr, kg, kb = key
    spread = max(1, soft - transparent)
    pixels = rgba.load()
    for y in range(rgba.height):
        for x in range(rgba.width):
            r, g, b, a = pixels[x, y]
            d = math.sqrt((r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2)
            if d <= transparent:
                pixels[x, y] = (0, 0, 0, 0)
            elif d <= soft:
                factor = max(0.0, min(1.0, (d - transparent) / spread))
                pixels[x, y] = (r, g, b, round(a * factor))
    return rgba


def alpha_bbox(img: Image.Image, threshold: int = 16) -> tuple[int, int, int, int] | None:
    alpha = img.getchannel("A")
    mask = alpha.point(lambda v: 255 if v > threshold else 0)
    return mask.getbbox()


def prepared_diff_image(img: Image.Image, size: int = 128) -> Image.Image:
    canvas = Image.new("RGBA", img.size, (0, 0, 0, 0))
    canvas.alpha_composite(img)
    bbox = alpha_bbox(canvas)
    if bbox:
        canvas = canvas.crop(bbox)
    square = Image.new("RGBA", (max(canvas.width, canvas.height), max(canvas.width, canvas.height)), (0, 0, 0, 0))
    square.alpha_composite(canvas, ((square.width - canvas.width) // 2, square.height - canvas.height))
    return square.resize((size, size), Image.Resampling.LANCZOS)


def frame_diff(a: Image.Image, b: Image.Image) -> float:
    ai = prepared_diff_image(a)
    bi = prepared_diff_image(b)
    ap = ai.tobytes()
    bp = bi.tobytes()
    total = 0
    for av, bv in zip(ap, bp):
        total += abs(av - bv)
    return total / (len(ap) * 255)


def cell_frames(sheet: Image.Image, columns: int, rows: int, frame_count: int, key: tuple[int, int, int] | None, transparent: int, soft: int) -> list[Image.Image]:
    cell_w = sheet.width // columns
    cell_h = sheet.height // rows
    frames: list[Image.Image] = []
    for index in range(frame_count):
        col = index % columns
        row = index // columns
        crop = sheet.crop((col * cell_w, row * cell_h, (col + 1) * cell_w, (row + 1) * cell_h))
        frames.append(remove_key(crop, key, transparent, soft))
    return frames


def score_from_threshold(value: float, good: float, great: float) -> int:
    if value >= great:
        return 5
    if value >= good:
        return 4
    if value >= good * 0.65:
        return 3
    if value >= good * 0.35:
        return 2
    if value > 0:
        return 1
    return 0


def review(args: argparse.Namespace) -> dict[str, Any]:
    key = parse_color(args.key_color)
    sheet = Image.open(args.input).convert("RGB")
    if sheet.width % args.columns or sheet.height % args.rows:
        raise ValueError("Sheet dimensions must divide evenly by columns/rows for this source review")
    frames = cell_frames(sheet, args.columns, args.rows, args.frame_count, key, args.transparent_threshold, args.soft_threshold)

    boxes = [alpha_bbox(frame) for frame in frames]
    hard_blockers: list[str] = []
    if any(box is None for box in boxes):
        hard_blockers.append("one or more frames have no visible foreground after chroma removal")

    frame_records = []
    for idx, (frame, box) in enumerate(zip(frames, boxes), start=1):
        if box is None:
            record = {"frame": idx, "bbox": None, "width": 0, "height": 0, "bottomY": None}
        else:
            record = {
                "frame": idx,
                "bbox": list(box),
                "width": box[2] - box[0],
                "height": box[3] - box[1],
                "bottomY": box[3] - 1,
            }
        frame_records.append(record)

    pair_diffs = [frame_diff(frames[i], frames[i + 1]) for i in range(len(frames) - 1)]
    loop_diff = frame_diff(frames[-1], frames[0]) if args.loop else None
    all_pair_values = pair_diffs + ([loop_diff] if loop_diff is not None else [])
    duplicate_pairs = [i + 1 for i, value in enumerate(pair_diffs) if value < args.min_pair_diff]
    if args.loop and loop_diff is not None and loop_diff < args.min_pair_diff:
        duplicate_pairs.append(args.frame_count)

    meaningful_pairs = sum(1 for value in all_pair_values if value >= args.min_pair_diff)
    unique_motion_ratio = meaningful_pairs / max(1, len(all_pair_values))
    median_pair_diff = median(all_pair_values) if all_pair_values else 0.0
    max_pair_diff = max(all_pair_values) if all_pair_values else 0.0

    heights = [record["height"] for record in frame_records if record["height"]]
    bottoms = [record["bottomY"] for record in frame_records if record["bottomY"] is not None]
    height_drift = max(heights) - min(heights) if heights else 0
    bottom_drift = max(bottoms) - min(bottoms) if bottoms else 0

    if unique_motion_ratio < args.min_motion_ratio:
        hard_blockers.append(
            f"not enough meaningful motion: {unique_motion_ratio:.2f} ratio below {args.min_motion_ratio:.2f}"
        )
    if len(duplicate_pairs) > args.max_duplicate_pairs:
        hard_blockers.append(
            f"too many near-duplicate adjacent pairs: {len(duplicate_pairs)} exceeds {args.max_duplicate_pairs}"
        )
    if height_drift > args.max_height_drift:
        hard_blockers.append(f"height drift {height_drift}px exceeds {args.max_height_drift}px")
    if bottom_drift > args.max_bottom_drift:
        hard_blockers.append(f"foot/bottom drift {bottom_drift}px exceeds {args.max_bottom_drift}px")

    motion_score = score_from_threshold(median_pair_diff, args.min_pair_diff, args.min_pair_diff * 2.5)
    frame_cleanliness = 5 if not hard_blockers else 3
    if bottom_drift > args.max_bottom_drift * 0.5:
        frame_cleanliness = min(frame_cleanliness, 4)
    framing = 5 if height_drift <= args.max_height_drift and bottom_drift <= args.max_bottom_drift else 3
    continuity = 5 if max_pair_diff <= args.max_jump_diff else 4
    if max_pair_diff > args.max_jump_diff:
        hard_blockers.append(f"largest frame jump {max_pair_diff:.4f} exceeds {args.max_jump_diff:.4f}")

    scores = {
        "motionReadability": motion_score,
        "poseDiversity": motion_score,
        "frameCleanliness": frame_cleanliness,
        "framingCellSafety": framing,
        "identityConsistency": 4,
        "sequenceContinuity": continuity,
        "effectBackgroundCleanliness": 4,
    }
    average_score = round(mean(scores.values()), 2)
    result = "fail" if hard_blockers or average_score < args.min_average_score else "pass"

    return {
        "schemaVersion": 1,
        "kind": "animation-source-review",
        "source": str(args.input).replace("\\", "/"),
        "animation": args.animation,
        "layout": {"columns": args.columns, "rows": args.rows, "frameCount": args.frame_count},
        "thresholds": {
            "minPairDiff": args.min_pair_diff,
            "minMotionRatio": args.min_motion_ratio,
            "maxDuplicatePairs": args.max_duplicate_pairs,
            "maxHeightDrift": args.max_height_drift,
            "maxBottomDrift": args.max_bottom_drift,
            "maxJumpDiff": args.max_jump_diff,
            "minAverageScore": args.min_average_score,
        },
        "metrics": {
            "pairDiffs": [round(v, 5) for v in pair_diffs],
            "loopDiff": round(loop_diff, 5) if loop_diff is not None else None,
            "medianPairDiff": round(median_pair_diff, 5),
            "maxPairDiff": round(max_pair_diff, 5),
            "uniqueMotionRatio": round(unique_motion_ratio, 3),
            "duplicatePairs": duplicate_pairs,
            "heightDrift": height_drift,
            "bottomDrift": bottom_drift,
        },
        "frames": frame_records,
        "scores": scores,
        "averageScore": average_score,
        "hardBlockers": hard_blockers,
        "result": result,
        "manualVisualReviewRequired": True,
        "notes": [
            "This tool is a pre-intake gate. A pass still requires visual review of the sheet/contact preview.",
            "Failing sources must be regenerated/redrawn before sheet intake unless intentionally preserved as a labeled failure artifact.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Review generated source sheets before animation intake")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--animation", required=True)
    parser.add_argument("--columns", type=int, required=True)
    parser.add_argument("--rows", type=int, required=True)
    parser.add_argument("--frame-count", type=int, required=True)
    parser.add_argument("--key-color", default="#ff00ff")
    parser.add_argument("--transparent-threshold", type=int, default=45)
    parser.add_argument("--soft-threshold", type=int, default=125)
    parser.add_argument("--min-pair-diff", type=float, default=0.012)
    parser.add_argument("--min-motion-ratio", type=float, default=0.70)
    parser.add_argument("--max-duplicate-pairs", type=int, default=1)
    parser.add_argument("--max-height-drift", type=int, default=24)
    parser.add_argument("--max-bottom-drift", type=int, default=8)
    parser.add_argument("--max-jump-diff", type=float, default=0.16)
    parser.add_argument("--min-average-score", type=float, default=4.0)
    parser.add_argument("--loop", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    result = review(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))
    if result["result"] != "pass":
        raise SystemExit(2)


if __name__ == "__main__":
    main()

"""Audit Phaser-ready animation sheets for Pipeline v4 promotion.

The audit is deliberately boring: it measures the sheet, checks metadata/finalization
timing, searches for transparent-pixel RGB bleed and chroma fringe, and writes visual
contact sheets for human review.
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw


TRANSPARENT = (0, 0, 0, 0)
ALPHA_BBOX_THRESHOLD = 10


@dataclass
class FrameAudit:
    frame: int
    bbox: list[int] | None
    width: int
    height: int
    bottom_y: int | None
    center_x: float | None
    foot_anchor_x: float | None
    transparent_rgb_pixels: int
    chroma_fringe_pixels: int
    lower_body_blue_pixels: int


def read_json(path: Path | None) -> dict[str, Any] | None:
    if not path:
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def alpha_bbox(img: Image.Image, threshold: int = ALPHA_BBOX_THRESHOLD) -> tuple[int, int, int, int] | None:
    alpha = img.getchannel("A")
    mask = alpha.point(lambda value: 255 if value > threshold else 0)
    return mask.getbbox()


def has_nearby_transparency(img: Image.Image, x: int, y: int, radius: int = 2) -> bool:
    pixels = img.load()
    for yy in range(max(0, y - radius), min(img.height, y + radius + 1)):
        for xx in range(max(0, x - radius), min(img.width, x + radius + 1)):
            if pixels[xx, yy][3] <= ALPHA_BBOX_THRESHOLD:
                return True
    return False


def parse_color_names(value: str) -> set[str]:
    colors: set[str] = set()
    for item in value.split(","):
        name = item.strip().lower()
        if name in {"#ff00ff", "magenta", "purple", "violet"}:
            colors.add("magenta")
        elif name in {"#00ff00", "green"}:
            colors.add("green")
        elif name in {"blue", "cyan"}:
            colors.add("blue")
    return colors


def is_chromaish(r: int, g: int, b: int, a: int, key_colors: set[str]) -> bool:
    if a <= 0:
        return False
    magenta = r > 55 and b > 55 and g < 105 and (r + b) > (g * 2 + 55)
    green = g > 135 and g > r + 35 and g > b + 25 and r < 145 and b < 150
    blue = b > 88 and b > r + 22 and b > g + 14 and r < 135
    return ("magenta" in key_colors and magenta) or ("green" in key_colors and green) or ("blue" in key_colors and blue)


def is_lower_body_blue(r: int, g: int, b: int, a: int) -> bool:
    if a <= ALPHA_BBOX_THRESHOLD:
        return False
    blue = b > 88 and b > r + 22 and b > g + 14 and r < 135
    violet = r > 45 and b > 55 and g < 95 and (r + b) > (g * 2 + 55)
    return blue or violet


def foot_anchor_x(img: Image.Image, bbox: tuple[int, int, int, int] | None, foot_height: int) -> float | None:
    if bbox is None:
        return None
    left, _top, right, bottom = bbox
    anchor_top = max(0, bottom - max(1, foot_height))
    alpha = img.getchannel("A")
    xs: list[int] = []
    for y in range(anchor_top, bottom):
        for x in range(left, right):
            if alpha.getpixel((x, y)) > ALPHA_BBOX_THRESHOLD:
                xs.append(x)
    if not xs:
        return None
    xs.sort()
    return float(xs[len(xs) // 2])


def count_artifacts(img: Image.Image, bbox: tuple[int, int, int, int] | None, key_colors: set[str]) -> tuple[int, int, int]:
    pixels = img.load()
    transparent_rgb = 0
    chroma_fringe = 0
    lower_body_blue = 0

    lower_top = img.height // 2
    lower_bottom = img.height
    lower_left = 0
    lower_right = img.width
    if bbox is not None:
        left, top, right, bottom = bbox
        lower_top = max(top, bottom - round((bottom - top) * 0.45))
        lower_bottom = bottom
        lower_left = max(0, left - 12)
        lower_right = min(img.width, right + 12)

    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = pixels[x, y]
            if a == 0 and (r or g or b):
                transparent_rgb += 1
            if ALPHA_BBOX_THRESHOLD < a < 225 and is_chromaish(r, g, b, a, key_colors) and has_nearby_transparency(img, x, y):
                chroma_fringe += 1
            if (
                lower_left <= x < lower_right
                and lower_top <= y < lower_bottom
                and is_lower_body_blue(r, g, b, a)
                and (a < 245 or has_nearby_transparency(img, x, y))
            ):
                lower_body_blue += 1

    return transparent_rgb, chroma_fringe, lower_body_blue


def split_horizontal_sheet(sheet: Image.Image, frame_width: int, frame_height: int) -> list[Image.Image]:
    if sheet.width % frame_width != 0 or sheet.height % frame_height != 0:
        raise ValueError(
            f"sheet size {sheet.width}x{sheet.height} is not divisible by {frame_width}x{frame_height}"
        )
    return [
        sheet.crop((col * frame_width, 0, (col + 1) * frame_width, frame_height)).convert("RGBA")
        for col in range(sheet.width // frame_width)
    ]


def save_contact_sheet(
    frames: list[Image.Image],
    audits: list[FrameAudit],
    output_path: Path,
    baseline_y: int | None,
) -> None:
    if not frames:
        return
    frame_w, frame_h = frames[0].size
    columns = min(4, len(frames))
    rows = math.ceil(len(frames) / columns)
    pad = 18
    label_h = 54
    sheet = Image.new("RGBA", (columns * (frame_w + pad) + pad, rows * (frame_h + label_h + pad) + pad), (30, 36, 42, 255))
    draw = ImageDraw.Draw(sheet)

    for index, frame in enumerate(frames):
        x = pad + (index % columns) * (frame_w + pad)
        y = pad + (index // columns) * (frame_h + label_h + pad)
        sheet.alpha_composite(frame, (x, y))
        audit = audits[index]
        if audit.bbox:
            left, top, right, bottom = audit.bbox
            draw.rectangle([x + left, y + top, x + right - 1, y + bottom - 1], outline=(255, 80, 80, 255), width=2)
        if baseline_y is not None:
            draw.line([x, y + baseline_y, x + frame_w, y + baseline_y], fill=(120, 255, 120, 255), width=1)
        lines = [
            f"f{audit.frame}: {audit.bbox} h={audit.height}",
            f"fringe={audit.chroma_fringe_pixels} blueLB={audit.lower_body_blue_pixels}",
        ]
        for line_index, line in enumerate(lines):
            draw.text((x, y + frame_h + 6 + line_index * 18), line, fill=(235, 240, 245, 255))

    sheet.save(output_path)


def save_lower_body_zoom(frames: list[Image.Image], audits: list[FrameAudit], output_path: Path) -> None:
    if not frames:
        return
    crop_boxes: list[tuple[int, int, int, int]] = []
    for frame, audit in zip(frames, audits):
        if audit.bbox:
            left, top, right, bottom = audit.bbox
            height = bottom - top
            crop_boxes.append((max(0, left - 18), max(0, bottom - round(height * 0.55)), min(frame.width, right + 18), min(frame.height, bottom + 10)))
        else:
            crop_boxes.append((0, frame.height // 2, frame.width, frame.height))

    crop_w = max(right - left for left, _top, right, _bottom in crop_boxes)
    crop_h = max(bottom - top for _left, top, _right, bottom in crop_boxes)
    scale = 4
    columns = min(4, len(frames))
    rows = math.ceil(len(frames) / columns)
    pad = 18
    label_h = 36
    out = Image.new("RGBA", (columns * (crop_w * scale + pad) + pad, rows * (crop_h * scale + label_h + pad) + pad), (30, 36, 42, 255))
    draw = ImageDraw.Draw(out)

    for index, (frame, box) in enumerate(zip(frames, crop_boxes)):
        left, top, right, bottom = box
        crop = Image.new("RGBA", (crop_w, crop_h), TRANSPARENT)
        crop.alpha_composite(frame.crop(box), (0, 0))
        crop = crop.resize((crop_w * scale, crop_h * scale), Image.Resampling.NEAREST)
        x = pad + (index % columns) * (crop_w * scale + pad)
        y = pad + (index // columns) * (crop_h * scale + label_h + pad)
        out.alpha_composite(crop, (x, y))
        draw.text((x, y + crop_h * scale + 6), f"f{audits[index].frame}", fill=(235, 240, 245, 255))

    out.save(output_path)


def fail_or_warn(kind: str, message: str, failures: list[str], warnings: list[str]) -> None:
    if kind == "fail":
        failures.append(message)
    else:
        warnings.append(message)


def audit(args: argparse.Namespace) -> int:
    sheet = Image.open(args.sheet).convert("RGBA")
    frames = split_horizontal_sheet(sheet, args.frame_width, args.frame_height)
    metadata = read_json(args.metadata)
    finalization = read_json(args.finalization)
    key_colors = parse_color_names(args.key_colors)

    output_dir = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    name = args.name or args.sheet.stem

    frame_audits: list[FrameAudit] = []
    for index, frame in enumerate(frames, start=1):
        bbox = alpha_bbox(frame)
        transparent_rgb, chroma_fringe, lower_body_blue = count_artifacts(frame, bbox, key_colors)
        if bbox is None:
            width = height = 0
            bottom_y = None
            center_x = None
        else:
            left, top, right, bottom = bbox
            width = right - left
            height = bottom - top
            bottom_y = bottom - 1
            center_x = (left + right - 1) / 2
        frame_audits.append(
            FrameAudit(
                frame=index,
                bbox=list(bbox) if bbox else None,
                width=width,
                height=height,
                bottom_y=bottom_y,
                center_x=center_x,
                foot_anchor_x=foot_anchor_x(frame, bbox, args.foot_anchor_height),
                transparent_rgb_pixels=transparent_rgb,
                chroma_fringe_pixels=chroma_fringe,
                lower_body_blue_pixels=lower_body_blue,
            )
        )

    failures: list[str] = []
    warnings: list[str] = []
    if args.expected_frames is not None and len(frames) != args.expected_frames:
        failures.append(f"expected {args.expected_frames} frames, found {len(frames)}")

    if args.expected_fps is not None:
        if metadata and metadata.get("fps") != args.expected_fps:
            failures.append(f"metadata fps {metadata.get('fps')} does not match expected {args.expected_fps}")
        if finalization and finalization.get("fps") != args.expected_fps:
            failures.append(f"finalization fps {finalization.get('fps')} does not match expected {args.expected_fps}")

    if metadata:
        if metadata.get("frameWidth") != args.frame_width or metadata.get("frameHeight") != args.frame_height:
            failures.append("metadata frame dimensions do not match audit dimensions")
        if metadata.get("frameCount") is not None and metadata.get("frameCount") != len(frames):
            failures.append(f"metadata frameCount {metadata.get('frameCount')} does not match sheet frame count {len(frames)}")
    if finalization:
        size = finalization.get("frameSize", {})
        if size.get("width") != args.frame_width or size.get("height") != args.frame_height:
            failures.append("finalization frameSize does not match audit dimensions")
        if finalization.get("frameCount") is not None and finalization.get("frameCount") != len(frames):
            failures.append(f"finalization frameCount {finalization.get('frameCount')} does not match sheet frame count {len(frames)}")

    transparent_rgb_total = sum(frame.transparent_rgb_pixels for frame in frame_audits)
    chroma_fringe_total = sum(frame.chroma_fringe_pixels for frame in frame_audits)
    lower_body_blue_total = sum(frame.lower_body_blue_pixels for frame in frame_audits)
    if transparent_rgb_total > args.max_transparent_rgb:
        failures.append(f"transparent RGB pixels {transparent_rgb_total} exceeds {args.max_transparent_rgb}")
    if chroma_fringe_total > args.max_chroma_fringe:
        fail_or_warn(args.fringe_severity, f"chroma fringe pixels {chroma_fringe_total} exceeds {args.max_chroma_fringe}", failures, warnings)
    if lower_body_blue_total > args.max_lower_body_blue:
        fail_or_warn(args.lower_body_blue_severity, f"lower-body blue/violet pixels {lower_body_blue_total} exceeds {args.max_lower_body_blue}", failures, warnings)

    bottoms = [frame.bottom_y for frame in frame_audits if frame.bottom_y is not None]
    heights = [frame.height for frame in frame_audits if frame.height > 0]
    foot_xs = [frame.foot_anchor_x for frame in frame_audits if frame.foot_anchor_x is not None]
    bottom_drift = (max(bottoms) - min(bottoms)) if bottoms else 0
    height_drift = (max(heights) - min(heights)) if heights else 0
    foot_x_drift = (max(foot_xs) - min(foot_xs)) if foot_xs else 0
    if bottom_drift > args.max_bottom_drift:
        failures.append(f"bottom drift {bottom_drift}px exceeds {args.max_bottom_drift}px")
    if height_drift > args.max_height_drift:
        fail_or_warn(args.height_drift_severity, f"height drift {height_drift}px exceeds {args.max_height_drift}px", failures, warnings)
    if foot_x_drift > args.max_foot_x_drift:
        fail_or_warn(args.foot_x_drift_severity, f"foot anchor x drift {foot_x_drift:.1f}px exceeds {args.max_foot_x_drift}px", failures, warnings)

    save_contact_sheet(frames, frame_audits, output_dir / f"{name}_audit-contact.png", args.baseline_y)
    save_lower_body_zoom(frames, frame_audits, output_dir / f"{name}_audit-lower-body-zoom.png")

    report = {
        "schemaVersion": 1,
        "kind": "animation-audit",
        "sheet": str(args.sheet),
        "frameSize": {"width": args.frame_width, "height": args.frame_height},
        "frameCount": len(frames),
        "expectedFps": args.expected_fps,
        "baselineY": args.baseline_y,
        "keyColors": sorted(key_colors),
        "summary": {
            "transparentRgbPixels": transparent_rgb_total,
            "chromaFringePixels": chroma_fringe_total,
            "lowerBodyBluePixels": lower_body_blue_total,
            "bottomDrift": bottom_drift,
            "heightDrift": height_drift,
            "footAnchorXDrift": round(foot_x_drift, 2),
        },
        "failures": failures,
        "warnings": warnings,
        "frames": [asdict(frame) for frame in frame_audits],
    }
    report_path = output_dir / f"{name}_audit.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print(f"[animation-audit] sheet={args.sheet} frames={len(frames)}")
    print(f"[animation-audit] report={report_path}")
    print(f"[animation-audit] contact={output_dir / f'{name}_audit-contact.png'}")
    print(f"[animation-audit] lower-body={output_dir / f'{name}_audit-lower-body-zoom.png'}")
    for warning in warnings:
        print(f"[animation-audit] WARNING: {warning}")
    for failure in failures:
        print(f"[animation-audit] FAILURE: {failure}")
    return 1 if failures else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Audit Pipeline v4 animation sheets")
    parser.add_argument("--sheet", type=Path, required=True)
    parser.add_argument("--frame-width", type=int, required=True)
    parser.add_argument("--frame-height", type=int, required=True)
    parser.add_argument("--expected-frames", type=int)
    parser.add_argument("--expected-fps", type=float)
    parser.add_argument("--metadata", type=Path)
    parser.add_argument("--finalization", type=Path)
    parser.add_argument("--baseline-y", type=int)
    parser.add_argument("--foot-anchor-height", type=int, default=8)
    parser.add_argument("--max-transparent-rgb", type=int, default=0)
    parser.add_argument("--max-chroma-fringe", type=int, default=250)
    parser.add_argument("--max-lower-body-blue", type=int, default=60)
    parser.add_argument("--max-bottom-drift", type=int, default=2)
    parser.add_argument("--max-height-drift", type=int, default=8)
    parser.add_argument("--max-foot-x-drift", type=float, default=24)
    parser.add_argument("--key-colors", default="magenta,green,blue")
    parser.add_argument("--fringe-severity", choices=["warn", "fail"], default="warn")
    parser.add_argument("--lower-body-blue-severity", choices=["warn", "fail"], default="warn")
    parser.add_argument("--height-drift-severity", choices=["warn", "fail"], default="warn")
    parser.add_argument("--foot-x-drift-severity", choices=["warn", "fail"], default="warn")
    parser.add_argument("--name")
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    raise SystemExit(audit(args))


if __name__ == "__main__":
    main()

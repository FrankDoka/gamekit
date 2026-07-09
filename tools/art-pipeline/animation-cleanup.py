"""Clean promoted animation sheets before Pipeline v4 audit.

This is intentionally narrow: it keeps painterly anti-aliased edges, but removes
hidden RGB from transparent texels and obvious chroma-key fringe near sprite edges.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image


ALPHA_THRESHOLD = 10
TRANSPARENT = (0, 0, 0, 0)


def has_nearby_transparency(img: Image.Image, x: int, y: int, radius: int) -> bool:
    pixels = img.load()
    for yy in range(max(0, y - radius), min(img.height, y + radius + 1)):
        for xx in range(max(0, x - radius), min(img.width, x + radius + 1)):
            if pixels[xx, yy][3] <= ALPHA_THRESHOLD:
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


def is_key_fringe(r: int, g: int, b: int, a: int, key_colors: set[str]) -> bool:
    if a <= ALPHA_THRESHOLD:
        return False
    magenta = r > 55 and b > 55 and g < 105 and (r + b) > (g * 2 + 55)
    green = g > 130 and g > r + 35 and g > b + 25 and r < 145 and b < 150
    blue = b > 88 and b > r + 22 and b > g + 14 and r < 135
    return ("magenta" in key_colors and magenta) or ("green" in key_colors and green) or ("blue" in key_colors and blue)


def replacement_color(
    img: Image.Image,
    x: int,
    y: int,
    radius: int,
    key_colors: set[str],
) -> tuple[int, int, int] | None:
    pixels = img.load()
    candidates: list[tuple[int, int, int]] = []
    for yy in range(max(0, y - radius), min(img.height, y + radius + 1)):
        for xx in range(max(0, x - radius), min(img.width, x + radius + 1)):
            r, g, b, a = pixels[xx, yy]
            if a > 180 and not is_key_fringe(r, g, b, a, key_colors):
                candidates.append((r, g, b))
    if not candidates:
        return None
    candidates.sort()
    return candidates[len(candidates) // 2]


def clean_frame(
    frame: Image.Image,
    fringe_radius: int,
    fringe_alpha_max: int,
    recolor_alpha_min: int,
    key_colors: set[str],
    dark_edge_alpha_max: int,
    dark_edge_luma_max: int,
) -> tuple[Image.Image, dict[str, int]]:
    out = frame.convert("RGBA")
    pixels = out.load()
    counts = {
        "transparentRgbZeroed": 0,
        "nearTransparentPixelsZeroed": 0,
        "fringePixelsRemoved": 0,
        "fringePixelsRecolored": 0,
        "fringePixelsPostRemoved": 0,
        "darkEdgePixelsRemoved": 0,
    }

    fringe_positions: list[tuple[int, int, int]] = []
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = pixels[x, y]
            if a <= ALPHA_THRESHOLD:
                if r or g or b:
                    pixels[x, y] = TRANSPARENT
                    counts["transparentRgbZeroed"] += 1
                elif a:
                    pixels[x, y] = TRANSPARENT
                    counts["nearTransparentPixelsZeroed"] += 1
                continue
            if (
                a <= fringe_alpha_max
                and is_key_fringe(r, g, b, a, key_colors)
                and has_nearby_transparency(out, x, y, fringe_radius)
            ):
                fringe_positions.append((x, y, a))
                continue
            if (
                dark_edge_alpha_max > 0
                and a <= dark_edge_alpha_max
                and (r * 0.2126 + g * 0.7152 + b * 0.0722) <= dark_edge_luma_max
                and has_nearby_transparency(out, x, y, fringe_radius)
            ):
                pixels[x, y] = TRANSPARENT
                counts["darkEdgePixelsRemoved"] += 1

    for x, y, a in fringe_positions:
        if a >= recolor_alpha_min:
            replacement = replacement_color(out, x, y, fringe_radius + 1, key_colors)
            if replacement is not None:
                pixels[x, y] = (*replacement, a)
                counts["fringePixelsRecolored"] += 1
                continue
        pixels[x, y] = TRANSPARENT
        counts["fringePixelsRemoved"] += 1

    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = pixels[x, y]
            if (
                a > ALPHA_THRESHOLD
                and is_key_fringe(r, g, b, a, key_colors)
                and has_nearby_transparency(out, x, y, fringe_radius)
            ):
                pixels[x, y] = TRANSPARENT
                counts["fringePixelsPostRemoved"] += 1
    return out, counts


def split_horizontal_sheet(sheet: Image.Image, frame_width: int, frame_height: int) -> list[Image.Image]:
    if sheet.width % frame_width != 0 or sheet.height % frame_height != 0:
        raise ValueError(
            f"sheet size {sheet.width}x{sheet.height} is not divisible by {frame_width}x{frame_height}"
        )
    return [
        sheet.crop((col * frame_width, 0, (col + 1) * frame_width, frame_height)).convert("RGBA")
        for col in range(sheet.width // frame_width)
    ]


def save_horizontal_sheet(frames: list[Image.Image], output_path: Path) -> None:
    if not frames:
        raise ValueError("No frames to save")
    sheet = Image.new("RGBA", (frames[0].width * len(frames), frames[0].height), TRANSPARENT)
    for index, frame in enumerate(frames):
        sheet.alpha_composite(frame, (index * frame.width, 0))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    save_kwargs = {"lossless": True, "quality": 100, "exact": True} if output_path.suffix.lower() == ".webp" else {}
    sheet.save(output_path, **save_kwargs)


def main() -> None:
    parser = argparse.ArgumentParser(description="Clean a horizontal animation sheet before audit")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--frame-width", type=int, required=True)
    parser.add_argument("--frame-height", type=int, required=True)
    parser.add_argument("--fringe-radius", type=int, default=2)
    parser.add_argument("--fringe-alpha-max", type=int, default=255)
    parser.add_argument("--recolor-alpha-min", type=int, default=221)
    parser.add_argument("--dark-edge-alpha-max", type=int, default=0)
    parser.add_argument("--dark-edge-luma-max", type=int, default=48)
    parser.add_argument("--key-colors", default="magenta,green,blue")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    sheet = Image.open(args.input).convert("RGBA")
    key_colors = parse_color_names(args.key_colors)
    frames = split_horizontal_sheet(sheet, args.frame_width, args.frame_height)
    cleaned_frames: list[Image.Image] = []
    frame_reports: list[dict[str, int]] = []
    for frame in frames:
        cleaned, report = clean_frame(
            frame,
            args.fringe_radius,
            args.fringe_alpha_max,
            args.recolor_alpha_min,
            key_colors,
            args.dark_edge_alpha_max,
            args.dark_edge_luma_max,
        )
        cleaned_frames.append(cleaned)
        frame_reports.append(report)

    save_horizontal_sheet(cleaned_frames, args.output)
    totals = {
        "transparentRgbZeroed": sum(frame["transparentRgbZeroed"] for frame in frame_reports),
        "nearTransparentPixelsZeroed": sum(frame["nearTransparentPixelsZeroed"] for frame in frame_reports),
        "fringePixelsRemoved": sum(frame["fringePixelsRemoved"] for frame in frame_reports),
        "fringePixelsRecolored": sum(frame["fringePixelsRecolored"] for frame in frame_reports),
        "darkEdgePixelsRemoved": sum(frame["darkEdgePixelsRemoved"] for frame in frame_reports),
    }
    report = {
        "schemaVersion": 1,
        "kind": "animation-cleanup",
        "input": str(args.input),
        "output": str(args.output),
        "frameSize": {"width": args.frame_width, "height": args.frame_height},
        "frameCount": len(frames),
        "fringeRadius": args.fringe_radius,
        "fringeAlphaMax": args.fringe_alpha_max,
        "recolorAlphaMin": args.recolor_alpha_min,
        "darkEdgeAlphaMax": args.dark_edge_alpha_max,
        "darkEdgeLumaMax": args.dark_edge_luma_max,
        "keyColors": sorted(key_colors),
        "summary": totals,
        "frames": frame_reports,
    }
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(
        "[animation-cleanup] "
        f"output={args.output} frames={len(frames)} "
        f"transparentRgbZeroed={totals['transparentRgbZeroed']} "
        f"nearTransparentPixelsZeroed={totals['nearTransparentPixelsZeroed']} "
        f"fringePixelsRemoved={totals['fringePixelsRemoved']} "
        f"fringePixelsRecolored={totals['fringePixelsRecolored']} "
        f"darkEdgePixelsRemoved={totals['darkEdgePixelsRemoved']}"
    )


if __name__ == "__main__":
    main()

"""Normalize animation frames into Phaser-ready runtime sheets.

Pipeline C / v3 proof tool.

Inputs can be a directory of PNG frames, a grid/horizontal sprite sheet, or a
pose board that needs foreground-component recovery. The tool removes a chroma
key, aligns each frame to a grounded anchor, and exports:

- cleaned individual PNG frames
- one horizontal WebP sprite sheet
- metadata JSON
- contact-sheet preview PNG
- animated preview GIF
- runtime finalization report with per-frame bounds and dx/dy shifts

Example:
    python tools/art-pipeline/animation-normalize.py \
        --input tmp/anim-fixture/source-frames \
        --input-kind frames \
        --entity player_wayfarer \
        --animation idle \
        --frame-count 8 \
        --key-color "#ff00ff" \
        --frame-width 192 \
        --frame-height 192 \
        --display-size 96 \
        --baseline-y 164 \
        --fps 6 \
        --loop true \
        --output-dir tmp/anim-fixture/out
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, NamedTuple

from PIL import Image, ImageDraw


TRANSPARENT = (0, 0, 0, 0)
DEFAULT_ALPHA_THRESHOLD = 10
PREVIEW_BACKGROUNDS = [
    ("checker", None),
    ("dark", (28, 32, 34)),
    ("light", (226, 224, 212)),
    ("terrain", (59, 86, 56)),
    ("key", None),
]


@dataclass
class FrameRecord:
    frame: str
    source_bbox: tuple[int, int, int, int] | None
    output_bbox: tuple[int, int, int, int] | None
    dx: int
    dy: int


class Component(NamedTuple):
    bbox: tuple[int, int, int, int]
    area: int
    pixels: tuple[int, ...]


def parse_bool(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "y", "loop"}:
        return True
    if normalized in {"0", "false", "no", "n", "once"}:
        return False
    raise argparse.ArgumentTypeError(f"expected true/false, got {value!r}")


def parse_color(value: str | None) -> tuple[int, int, int] | None:
    if not value:
        return None
    raw = value.strip()
    aliases = {
        "magenta": "#ff00ff",
        "green": "#00ff00",
    }
    raw = aliases.get(raw.lower(), raw)
    if raw.startswith("#"):
        raw = raw[1:]
    if len(raw) != 6:
        raise argparse.ArgumentTypeError(f"expected #rrggbb color, got {value!r}")
    try:
        return tuple(int(raw[i : i + 2], 16) for i in (0, 2, 4))
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"expected #rrggbb color, got {value!r}") from exc


def parse_frame_indices(value: str | None) -> list[int] | None:
    if not value:
        return None
    indices = [int(part.strip()) for part in value.split(",") if part.strip()]
    if not indices:
        return None
    if any(index < 0 for index in indices):
        raise argparse.ArgumentTypeError("--frame-indices values must be zero-based and non-negative")
    return indices


def alpha_bbox(img: Image.Image, threshold: int = DEFAULT_ALPHA_THRESHOLD) -> tuple[int, int, int, int] | None:
    alpha = img.getchannel("A")
    mask = alpha.point(lambda value: 255 if value > threshold else 0)
    return mask.getbbox()


def zero_transparent_rgb(img: Image.Image) -> Image.Image:
    out = img.convert("RGBA")
    pixels = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = pixels[x, y]
            if a == 0:
                pixels[x, y] = (0, 0, 0, 0)
            else:
                pixels[x, y] = (r, g, b, a)
    return out


def remove_chroma_key(
    img: Image.Image,
    key_color: tuple[int, int, int] | None,
    transparent_threshold: int,
    soft_threshold: int,
) -> Image.Image:
    out = img.convert("RGBA")
    if key_color is None:
        return zero_transparent_rgb(out)

    pixels = out.load()
    kr, kg, kb = key_color
    spread = max(1, soft_threshold - transparent_threshold)

    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = pixels[x, y]
            distance = math.sqrt((r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2)
            if distance <= transparent_threshold:
                pixels[x, y] = (0, 0, 0, 0)
            elif distance <= soft_threshold:
                factor = min(1.0, max(0.0, (distance - transparent_threshold) / spread))
                new_alpha = round(a * factor)
                if factor > 0:
                    nr = round((r - (1 - factor) * kr) / factor)
                    ng = round((g - (1 - factor) * kg) / factor)
                    nb = round((b - (1 - factor) * kb) / factor)
                    pixels[x, y] = (
                        max(0, min(255, nr)),
                        max(0, min(255, ng)),
                        max(0, min(255, nb)),
                        new_alpha,
                    )
                else:
                    pixels[x, y] = (0, 0, 0, 0)

    return zero_transparent_rgb(out)


def load_frame_paths(input_path: Path) -> list[Path]:
    frame_paths = sorted(
        path
        for path in input_path.iterdir()
        if path.is_file() and path.suffix.lower() in {".png", ".webp"}
    )
    if not frame_paths:
        raise ValueError(f"No PNG/WebP frame files found in {input_path}")
    return frame_paths


def split_sheet(
    sheet_path: Path,
    frame_width: int,
    frame_height: int,
    columns: int | None,
    rows: int | None,
) -> list[Image.Image]:
    sheet = Image.open(sheet_path).convert("RGBA")
    if sheet.width % frame_width != 0 or sheet.height % frame_height != 0:
        raise ValueError(
            f"Sheet {sheet_path} size {sheet.width}x{sheet.height} is not divisible by "
            f"{frame_width}x{frame_height}"
        )

    sheet_columns = sheet.width // frame_width
    sheet_rows = sheet.height // frame_height
    if columns is not None and columns != sheet_columns:
        raise ValueError(f"--columns={columns} but sheet has {sheet_columns} columns")
    if rows is not None and rows != sheet_rows:
        raise ValueError(f"--rows={rows} but sheet has {sheet_rows} rows")

    frames: list[Image.Image] = []
    for row in range(sheet_rows):
        for col in range(sheet_columns):
            left = col * frame_width
            top = row * frame_height
            frames.append(sheet.crop((left, top, left + frame_width, top + frame_height)))
    return frames


def find_alpha_components(
    img: Image.Image,
    alpha_threshold: int,
    min_area: int,
    min_width: int,
    min_height: int,
) -> list[Component]:
    alpha = img.getchannel("A")
    width, height = alpha.size
    alpha_values = alpha.tobytes()
    visited = bytearray(width * height)
    components: list[Component] = []

    for start in range(width * height):
        if visited[start] or alpha_values[start] <= alpha_threshold:
            continue

        stack = [start]
        pixels: list[int] = []
        visited[start] = 1
        area = 0
        min_x = width
        min_y = height
        max_x = -1
        max_y = -1

        while stack:
            index = stack.pop()
            pixels.append(index)
            area += 1
            x = index % width
            y = index // width
            if x < min_x:
                min_x = x
            if y < min_y:
                min_y = y
            if x > max_x:
                max_x = x
            if y > max_y:
                max_y = y

            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if nx < 0 or nx >= width or ny < 0 or ny >= height:
                    continue
                next_index = ny * width + nx
                if visited[next_index] or alpha_values[next_index] <= alpha_threshold:
                    continue
                visited[next_index] = 1
                stack.append(next_index)

        bbox = (min_x, min_y, max_x + 1, max_y + 1)
        bbox_w = bbox[2] - bbox[0]
        bbox_h = bbox[3] - bbox[1]
        if area >= min_area and bbox_w >= min_width and bbox_h >= min_height:
            components.append(Component(bbox=bbox, area=area, pixels=tuple(pixels)))

    return components


def pad_bbox(
    bbox: tuple[int, int, int, int],
    padding: int,
    width: int,
    height: int,
) -> tuple[int, int, int, int]:
    left, top, right, bottom = bbox
    return (
        max(0, left - padding),
        max(0, top - padding),
        min(width, right + padding),
        min(height, bottom + padding),
    )


def save_recovery_contact_sheet(
    board: Image.Image,
    components: list[Component],
    output_path: Path,
) -> None:
    overlay = board.convert("RGBA")
    draw = ImageDraw.Draw(overlay)
    palette = [
        (255, 224, 64, 255),
        (64, 224, 255, 255),
        (128, 255, 96, 255),
        (255, 128, 224, 255),
        (255, 160, 64, 255),
        (192, 160, 255, 255),
        (96, 255, 192, 255),
        (255, 96, 96, 255),
    ]
    for index, component in enumerate(components):
        color = palette[index % len(palette)]
        draw.rectangle(component.bbox, outline=color, width=max(2, round(min(board.size) * 0.004)))
        draw.text((component.bbox[0] + 6, component.bbox[1] + 6), f"{index + 1}", fill=color)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    overlay.convert("RGB").save(output_path)


def order_grid_components(components: list[Component]) -> list[Component]:
    if len(components) <= 1:
        return components

    heights = [component.bbox[3] - component.bbox[1] for component in components]
    sorted_heights = sorted(heights)
    median_height = sorted_heights[len(sorted_heights) // 2]
    row_threshold = max(8, median_height * 0.45)

    rows: list[list[Component]] = []
    row_centers: list[float] = []
    for component in sorted(components, key=lambda item: (item.bbox[1] + item.bbox[3]) / 2):
        center_y = (component.bbox[1] + component.bbox[3]) / 2
        if not rows or abs(center_y - row_centers[-1]) > row_threshold:
            rows.append([component])
            row_centers.append(center_y)
            continue

        rows[-1].append(component)
        row_centers[-1] = sum((item.bbox[1] + item.bbox[3]) / 2 for item in rows[-1]) / len(rows[-1])

    ordered: list[Component] = []
    for row in rows:
        ordered.extend(sorted(row, key=lambda component: component.bbox[0]))
    return ordered


def recover_pose_board_frames(
    board: Image.Image,
    frame_count: int | None,
    output_dir: Path,
    stem: str,
    alpha_threshold: int,
    min_area: int,
    min_width: int,
    min_height: int,
    padding: int,
    component_order: str,
) -> tuple[list[Image.Image], dict[str, object]]:
    components = find_alpha_components(board, alpha_threshold, min_area, min_width, min_height)
    if not components:
        raise ValueError("No foreground components recovered from pose board")

    components = sorted(components, key=lambda component: component.area, reverse=True)
    if frame_count is not None:
        if len(components) < frame_count:
            raise ValueError(
                f"Recovered {len(components)} component(s), fewer than --frame-count={frame_count}"
            )
        components = components[:frame_count]

    if component_order == "horizontal":
        components = sorted(components, key=lambda component: component.bbox[0])
    elif component_order == "vertical":
        components = sorted(components, key=lambda component: component.bbox[1])
    else:
        components = order_grid_components(components)
    recovered_dir = output_dir / f"{stem}_recovered"
    recovered_dir.mkdir(parents=True, exist_ok=True)

    frames: list[Image.Image] = []
    records: list[dict[str, object]] = []
    board_pixels = board.load()
    for index, component in enumerate(components):
        padded = pad_bbox(component.bbox, padding, board.width, board.height)
        padded_left, padded_top, padded_right, padded_bottom = padded
        frame = Image.new("RGBA", (padded_right - padded_left, padded_bottom - padded_top), TRANSPARENT)
        frame_pixels = frame.load()
        for pixel_index in component.pixels:
            x = pixel_index % board.width
            y = pixel_index // board.width
            if padded_left <= x < padded_right and padded_top <= y < padded_bottom:
                frame_pixels[x - padded_left, y - padded_top] = board_pixels[x, y]
        frame = zero_transparent_rgb(frame)
        frame_path = recovered_dir / f"recovered-{index + 1:03d}.png"
        frame.save(frame_path)
        frames.append(frame)
        records.append(
            {
                "frame": frame_path.name,
                "componentBBox": list(component.bbox),
                "paddedBBox": list(padded),
                "area": component.area,
            }
        )

    recovery_preview = output_dir / f"{stem}_recovery-components.png"
    save_recovery_contact_sheet(board, components, recovery_preview)

    report = {
        "schemaVersion": 1,
        "kind": "pose-board-recovery",
        "frameCount": len(frames),
        "recoveredFrames": str(recovered_dir),
        "recoveryPreview": recovery_preview.name,
        "alphaThreshold": alpha_threshold,
        "minArea": min_area,
        "minWidth": min_width,
        "minHeight": min_height,
        "padding": padding,
        "componentOrder": component_order,
        "records": records,
    }
    return frames, report


def select_frames(frames: list[Image.Image], frame_indices: list[int] | None, frame_count: int | None) -> list[Image.Image]:
    if frame_indices is not None:
        try:
            return [frames[index] for index in frame_indices]
        except IndexError as exc:
            raise ValueError(f"--frame-indices contains an index outside 0..{len(frames) - 1}") from exc

    if frame_count is None or frame_count >= len(frames):
        return frames

    if frame_count <= 0:
        raise ValueError("--frame-count must be positive")
    if frame_count == 1:
        return [frames[0]]

    step = (len(frames) - 1) / (frame_count - 1)
    indices = [round(i * step) for i in range(frame_count)]
    return [frames[index] for index in indices]


def normalize_frame(
    img: Image.Image,
    frame_name: str,
    frame_width: int,
    frame_height: int,
    baseline_y: int,
    center_x: int,
    max_content_width: int,
    max_content_height: int,
    allow_upscale: bool,
    anchor_x_policy: str,
    foot_anchor_height: int,
) -> tuple[Image.Image, FrameRecord]:
    source_bbox = alpha_bbox(img)
    output = Image.new("RGBA", (frame_width, frame_height), TRANSPARENT)

    if source_bbox is None:
        record = FrameRecord(frame_name, None, None, 0, 0)
        return output, record

    left, top, right, bottom = source_bbox
    if anchor_x_policy == "preserve" and img.size == (frame_width, frame_height):
        content_width = right - left
        content_height = bottom - top
        if content_width <= max_content_width and content_height <= max_content_height:
            dy = baseline_y - (bottom - 1)
            output.alpha_composite(img, (0, dy))
            output = zero_transparent_rgb(output)
            output_bbox = alpha_bbox(output)
            record = FrameRecord(frame_name, source_bbox, output_bbox, 0, dy)
            return output, record

    content = img.crop(source_bbox)
    content_width = right - left
    content_height = bottom - top
    scale = min(max_content_width / content_width, max_content_height / content_height)
    if not allow_upscale:
        scale = min(1.0, scale)
    if scale <= 0:
        scale = 1.0
    if abs(scale - 1.0) > 0.001:
        resized_size = (
            max(1, round(content_width * scale)),
            max(1, round(content_height * scale)),
        )
        content = content.resize(resized_size, Image.Resampling.LANCZOS)
        content = zero_transparent_rgb(content)

    content_bbox = alpha_bbox(content)
    if content_bbox is None:
        record = FrameRecord(frame_name, source_bbox, None, 0, 0)
        return output, record

    c_left, c_top, c_right, c_bottom = content_bbox
    if anchor_x_policy == "preserve":
        source_center_x = c_left
    elif anchor_x_policy == "foot":
        anchor_top = max(c_top, c_bottom - max(1, foot_anchor_height))
        anchor_pixels: list[int] = []
        alpha = content.getchannel("A")
        for y in range(anchor_top, c_bottom):
            for x in range(c_left, c_right):
                if alpha.getpixel((x, y)) > DEFAULT_ALPHA_THRESHOLD:
                    anchor_pixels.append(x)
        if anchor_pixels:
            anchor_pixels.sort()
            source_center_x = anchor_pixels[len(anchor_pixels) // 2]
        else:
            source_center_x = round((c_left + c_right - 1) / 2)
    else:
        source_center_x = round((c_left + c_right - 1) / 2)
    source_bottom_y = c_bottom - 1
    if anchor_x_policy == "preserve":
        dx = left - c_left
    else:
        dx = center_x - source_center_x
    dy = baseline_y - source_bottom_y

    output.alpha_composite(content, (dx, dy))
    output = zero_transparent_rgb(output)
    output_bbox = alpha_bbox(output)
    record = FrameRecord(frame_name, source_bbox, output_bbox, dx, dy)
    return output, record


def save_horizontal_sheet(frames: list[Image.Image], output_path: Path) -> None:
    if not frames:
        raise ValueError("No frames to save")
    sheet = Image.new("RGBA", (frames[0].width * len(frames), frames[0].height), TRANSPARENT)
    for index, frame in enumerate(frames):
        sheet.alpha_composite(frame, (index * frame.width, 0))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    save_kwargs = {"lossless": True, "quality": 100, "exact": True} if output_path.suffix.lower() == ".webp" else {}
    sheet.save(output_path, **save_kwargs)


def checker_background(size: tuple[int, int], tile_size: int = 12) -> Image.Image:
    bg = Image.new("RGB", size, (168, 168, 168))
    draw = ImageDraw.Draw(bg)
    for y in range(0, size[1], tile_size):
        for x in range(0, size[0], tile_size):
            if ((x // tile_size) + (y // tile_size)) % 2 == 0:
                draw.rectangle((x, y, x + tile_size - 1, y + tile_size - 1), fill=(112, 112, 112))
    return bg


def save_contact_sheet(
    frames: list[Image.Image],
    output_path: Path,
    key_color: tuple[int, int, int] | None,
) -> None:
    if not frames:
        raise ValueError("No frames to preview")

    frame_w, frame_h = frames[0].size
    label_h = 22
    cell_w = frame_w
    cell_h = frame_h + label_h
    sheet = Image.new("RGB", (cell_w * len(frames), cell_h * len(PREVIEW_BACKGROUNDS)), (20, 20, 20))
    draw = ImageDraw.Draw(sheet)

    for row, (label, color) in enumerate(PREVIEW_BACKGROUNDS):
        if label == "checker":
            bg = checker_background((frame_w, frame_h))
        elif label == "key" and key_color:
            bg = Image.new("RGB", (frame_w, frame_h), key_color)
        elif label == "key":
            bg = Image.new("RGB", (frame_w, frame_h), (255, 0, 255))
        else:
            bg = Image.new("RGB", (frame_w, frame_h), color or (0, 0, 0))

        for col, frame in enumerate(frames):
            x = col * cell_w
            y = row * cell_h
            sheet.paste(bg, (x, y + label_h))
            sheet.paste(frame, (x, y + label_h), frame)
            draw.rectangle((x, y, x + cell_w, y + label_h), fill=(18, 18, 18))
            draw.text((x + 6, y + 6), f"{label} f{col}", fill=(240, 240, 240))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output_path)


def save_preview_gif(frames: list[Image.Image], output_path: Path, fps: int, loop: bool) -> None:
    duration_ms = max(1, round(1000 / max(1, fps)))
    paletted = []
    for frame in frames:
        bg = checker_background(frame.size)
        bg.paste(frame, (0, 0), frame)
        paletted.append(bg.convert("P", palette=Image.Palette.ADAPTIVE))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    paletted[0].save(
        output_path,
        save_all=True,
        append_images=paletted[1:],
        duration=duration_ms,
        loop=0 if loop else 1,
        disposal=2,
    )


def bbox_to_list(bbox: tuple[int, int, int, int] | None) -> list[int] | None:
    return list(bbox) if bbox is not None else None


def records_to_json(records: Iterable[FrameRecord]) -> list[dict[str, object]]:
    return [
        {
            "frame": record.frame,
            "sourceBBox": bbox_to_list(record.source_bbox),
            "outputBBox": bbox_to_list(record.output_bbox),
            "dx": record.dx,
            "dy": record.dy,
        }
        for record in records
    ]


def write_json(path: Path, data: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def normalize(args: argparse.Namespace) -> dict[str, Path]:
    key_color = parse_color(args.key_color)
    output_dir = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{args.entity}_{args.animation}"
    recovery_report: dict[str, object] | None = None

    if args.input_kind == "frames":
        raw_frames = [Image.open(path).convert("RGBA") for path in load_frame_paths(args.input)]
    elif args.input_kind == "sheet":
        raw_frames = split_sheet(args.input, args.source_frame_width or args.frame_width, args.source_frame_height or args.frame_height, args.columns, args.rows)
    elif args.input_kind == "pose-board":
        board = Image.open(args.input).convert("RGBA")
        cleaned_board = remove_chroma_key(board, key_color, args.transparent_threshold, args.soft_threshold)
        raw_frames, recovery_report = recover_pose_board_frames(
            cleaned_board,
            None if args.frame_indices else args.frame_count,
            output_dir,
            stem,
            args.component_alpha_threshold,
            args.component_min_area,
            args.component_min_width,
            args.component_min_height,
            args.recovery_padding,
            args.component_order,
        )
        if args.recovery_only:
            recovery_report_path = output_dir / f"{stem}_recovery.json"
            now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            recovery_report["createdAt"] = now
            recovery_report["source"] = str(args.input)
            write_json(recovery_report_path, recovery_report)
            print(f"[animation-normalize] Recovered {len(raw_frames)} pose-board component(s)")
            print(f"[animation-normalize] Recovery: {recovery_report_path}")
            print(f"[animation-normalize] Recovered frames: {recovery_report['recoveredFrames']}")
            print(f"[animation-normalize] Recovery preview: {output_dir / str(recovery_report['recoveryPreview'])}")
            return {
                "recovery": recovery_report_path,
                "frames": Path(str(recovery_report["recoveredFrames"])),
                "preview": output_dir / str(recovery_report["recoveryPreview"]),
            }
    else:
        raise ValueError(f"Unsupported --input-kind {args.input_kind!r}; v0 supports frames, sheet, and pose-board")

    selected = select_frames(raw_frames, parse_frame_indices(args.frame_indices), args.frame_count)
    if not selected:
        raise ValueError("No frames selected")

    if args.input_kind == "pose-board":
        cleaned_frames = selected
    else:
        cleaned_frames = [
            remove_chroma_key(frame, key_color, args.transparent_threshold, args.soft_threshold)
            for frame in selected
        ]

    baseline_y = args.baseline_y if args.baseline_y is not None else args.frame_height - 1
    center_x = args.center_x if args.center_x is not None else args.frame_width // 2
    max_content_width = args.max_content_width if args.max_content_width is not None else args.frame_width - 16
    max_content_height = (
        args.max_content_height
        if args.max_content_height is not None
        else min(args.frame_height - 16, args.display_size * 2)
    )
    normalized_frames: list[Image.Image] = []
    records: list[FrameRecord] = []
    frames_dir = output_dir / f"{args.entity}_{args.animation}_frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    for index, frame in enumerate(cleaned_frames):
        frame_name = f"frame-{index + 1:03d}.png"
        normalized, record = normalize_frame(
            frame,
            frame_name,
            args.frame_width,
            args.frame_height,
            baseline_y,
            center_x,
            max_content_width,
            max_content_height,
            args.allow_upscale,
            args.anchor_x_policy,
            args.foot_anchor_height,
        )
        normalized.save(frames_dir / frame_name)
        normalized_frames.append(normalized)
        records.append(record)

    sheet_path = output_dir / f"{stem}.webp"
    metadata_path = output_dir / f"{stem}.metadata.json"
    preview_path = output_dir / f"{stem}_preview.png"
    preview_gif_path = output_dir / f"{stem}_preview.gif"
    finalize_path = output_dir / f"{stem}_finalize-runtime.json"
    recovery_report_path = output_dir / f"{stem}_recovery.json" if recovery_report else None

    save_horizontal_sheet(normalized_frames, sheet_path)
    save_contact_sheet(normalized_frames, preview_path, key_color)
    save_preview_gif(normalized_frames, preview_gif_path, args.fps, args.loop)

    reference_dx = records[0].dx
    reference_dy = records[0].dy
    max_abs_dx = max(abs(record.dx - reference_dx) for record in records)
    max_abs_dy = max(abs(record.dy - reference_dy) for record in records)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    metadata = {
        "schemaVersion": 1,
        "entity": args.entity,
        "animation": args.animation,
        "source": str(args.input),
        "sourceKind": args.input_kind,
        "sheet": sheet_path.name,
        "preview": preview_path.name,
        "previewGif": preview_gif_path.name,
        "runtimeFinalization": finalize_path.name,
        "frameWidth": args.frame_width,
        "frameHeight": args.frame_height,
        "displaySize": args.display_size,
        "bodyHeight": args.body_height if args.body_height is not None else max_content_height,
        "frameCount": len(normalized_frames),
        "fps": args.fps,
        "loop": args.loop,
        "origin": {"x": 0.5, "y": round(baseline_y / args.frame_height, 4)},
        "baselineY": baseline_y,
        "centerX": center_x,
        "maxContentWidth": max_content_width,
        "maxContentHeight": max_content_height,
        "allowUpscale": args.allow_upscale,
        "anchorXPolicy": args.anchor_x_policy,
        "footAnchorHeight": args.foot_anchor_height,
        "keyColor": args.key_color,
        "selectedFrames": parse_frame_indices(args.frame_indices),
        "createdAt": now,
    }
    if args.display_body_height is not None:
        metadata["displayBodyHeight"] = args.display_body_height
    if recovery_report_path:
        metadata["recoveryReport"] = recovery_report_path.name
    write_json(metadata_path, metadata)

    finalize_report = {
        "schemaVersion": 1,
        "kind": "runtime-finalization",
        "createdAt": now,
        "entity": args.entity,
        "animation": args.animation,
        "sourceKind": args.input_kind,
        "anchorPolicy": args.anchor_policy,
        "anchorXPolicy": args.anchor_x_policy,
        "footAnchorHeight": args.foot_anchor_height,
        "requestedAnchorPolicy": args.anchor_policy,
        "frameSize": {"width": args.frame_width, "height": args.frame_height},
        "frameCount": len(normalized_frames),
        "fps": args.fps,
        "targetBottomY": baseline_y,
        "targetCenterX": center_x,
        "maxContentWidth": max_content_width,
        "maxContentHeight": max_content_height,
        "referenceDx": reference_dx,
        "referenceDy": reference_dy,
        "framesAdjusted": sum(1 for record in records if record.dx != reference_dx or record.dy != reference_dy),
        "maxAbsDx": max_abs_dx,
        "maxAbsDy": max_abs_dy,
        "records": records_to_json(records),
    }
    if recovery_report_path:
        finalize_report["recoveryReport"] = recovery_report_path.name
    if recovery_report and recovery_report_path:
        recovery_report["createdAt"] = now
        recovery_report["source"] = str(args.input)
        write_json(recovery_report_path, recovery_report)
    write_json(finalize_path, finalize_report)

    print(f"[animation-normalize] Loaded {len(raw_frames)} frame(s); selected {len(selected)}")
    if recovery_report_path:
        print(f"[animation-normalize] Recovery: {recovery_report_path}")
    print(f"[animation-normalize] Frames: {frames_dir}")
    print(f"[animation-normalize] Sheet: {sheet_path}")
    print(f"[animation-normalize] Metadata: {metadata_path}")
    print(f"[animation-normalize] Preview: {preview_path}")
    print(f"[animation-normalize] Preview GIF: {preview_gif_path}")
    print(f"[animation-normalize] Finalization: {finalize_path}")
    print(f"[animation-normalize] Max shift: dx={max_abs_dx}px dy={max_abs_dy}px")

    if max_abs_dy > args.warn_drift_px:
        print(
            f"WARNING: max vertical alignment shift {max_abs_dy}px exceeds --warn-drift-px={args.warn_drift_px}",
            file=sys.stderr,
        )

    paths = {
        "frames": frames_dir,
        "sheet": sheet_path,
        "metadata": metadata_path,
        "preview": preview_path,
        "preview_gif": preview_gif_path,
        "finalize": finalize_path,
    }
    if recovery_report_path:
        paths["recovery"] = recovery_report_path
    return paths


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Normalize Pipeline C animation frames")
    parser.add_argument("--input", type=Path, required=True, help="Input frame directory, sprite sheet, or pose board")
    parser.add_argument("--input-kind", choices=["frames", "sheet", "pose-board", "video"], required=True)
    parser.add_argument("--entity", required=True, help="Entity ID, e.g. player_wayfarer")
    parser.add_argument("--animation", required=True, help="Animation name, e.g. idle")
    parser.add_argument("--frame-count", type=int, help="Number of frames to sample")
    parser.add_argument("--frame-indices", help="Zero-based comma-separated frame indices; overrides even sampling")
    parser.add_argument("--key-color", help="Chroma key color, e.g. #ff00ff, #00ff00, magenta, green")
    parser.add_argument("--frame-width", type=int, required=True)
    parser.add_argument("--frame-height", type=int, required=True)
    parser.add_argument("--source-frame-width", type=int, help="Source sheet frame width if different from output")
    parser.add_argument("--source-frame-height", type=int, help="Source sheet frame height if different from output")
    parser.add_argument("--columns", type=int, help="Expected source sheet columns")
    parser.add_argument("--rows", type=int, help="Expected source sheet rows")
    parser.add_argument("--display-size", type=int, required=True)
    parser.add_argument("--body-height", type=int, help="Runtime body-height reference used for exact-size scaling")
    parser.add_argument("--display-body-height", type=int, help="Runtime display body height for exact-size scaling")
    parser.add_argument("--baseline-y", type=int, help="Grounded baseline y in output frame")
    parser.add_argument("--center-x", type=int, help="Grounded center x in output frame")
    parser.add_argument("--max-content-width", type=int, help="Max visible content width inside output frame")
    parser.add_argument("--max-content-height", type=int, help="Max visible content height inside output frame")
    parser.add_argument("--allow-upscale", action="store_true", help="Allow small source frames to scale up")
    parser.add_argument("--fps", type=int, default=6)
    parser.add_argument("--loop", type=parse_bool, default=True)
    parser.add_argument("--anchor-policy", default="grounded")
    parser.add_argument("--anchor-x-policy", choices=["center", "foot", "preserve"], default="center")
    parser.add_argument("--foot-anchor-height", type=int, default=8)
    parser.add_argument("--transparent-threshold", type=int, default=12)
    parser.add_argument("--soft-threshold", type=int, default=70)
    parser.add_argument("--component-alpha-threshold", type=int, default=24, help="Alpha threshold for pose-board component recovery")
    parser.add_argument("--component-min-area", type=int, default=500, help="Minimum recovered component area in pixels")
    parser.add_argument("--component-min-width", type=int, default=16, help="Minimum recovered component width")
    parser.add_argument("--component-min-height", type=int, default=16, help="Minimum recovered component height")
    parser.add_argument("--recovery-padding", type=int, default=12, help="Padding added around recovered pose components")
    parser.add_argument("--recovery-only", action="store_true", help="For pose-board input, stop after recovered frames and recovery report")
    parser.add_argument(
        "--component-order",
        choices=["grid", "horizontal", "vertical"],
        default="grid",
        help="Ordering for recovered pose components before runtime packing",
    )
    parser.add_argument("--warn-drift-px", type=int, default=24)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if args.input_kind == "video":
        parser.error("video input is reserved for a later wrapper; use frames, sheet, or pose-board for v0")
    if args.recovery_only and args.input_kind != "pose-board":
        parser.error("--recovery-only is only valid with --input-kind pose-board")
    if not args.input.exists():
        parser.error(f"--input does not exist: {args.input}")
    normalize(args)


if __name__ == "__main__":
    main()

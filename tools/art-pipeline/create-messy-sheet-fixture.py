"""Create a local messy generated-sheet fixture from an existing runtime spritesheet.

This is a no-API stress fixture for sheet intake. It simulates the common AI-generated
sheet failure where the visible character spills across implied cell boundaries, making
exact grid crops unreliable while full-sheet foreground component recovery still works.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw


DEFAULT_KEY = "#ff00ff"


def parse_color(value: str) -> tuple[int, int, int]:
    raw = value.strip()
    aliases = {"magenta": "#ff00ff", "green": "#00ff00", "blue": "#0000ff"}
    raw = aliases.get(raw.lower(), raw)
    if raw.startswith("#"):
        raw = raw[1:]
    if len(raw) != 6:
        raise argparse.ArgumentTypeError(f"expected #rrggbb color, got {value!r}")
    try:
        return tuple(int(raw[index : index + 2], 16) for index in (0, 2, 4))
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"expected #rrggbb color, got {value!r}") from exc


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def clean_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def alpha_bbox(image: Image.Image) -> tuple[int, int, int, int]:
    bbox = image.getchannel("A").getbbox()
    if bbox is None:
        raise ValueError("source frame has no visible alpha")
    return bbox


def split_components(sheet_path: Path, frame_width: int, frame_height: int, frame_count: int) -> list[Image.Image]:
    sheet = Image.open(sheet_path).convert("RGBA")
    if sheet.width < frame_width * frame_count or sheet.height < frame_height:
        raise ValueError(f"Sheet {sheet_path} is too small for {frame_count} frames of {frame_width}x{frame_height}")
    components: list[Image.Image] = []
    for index in range(frame_count):
        frame = sheet.crop((index * frame_width, 0, (index + 1) * frame_width, frame_height))
        bbox = alpha_bbox(frame)
        components.append(frame.crop(bbox))
    return components


def write_fixture(args: argparse.Namespace) -> dict[str, Any]:
    metadata = read_json(args.metadata)
    frame_width = int(metadata["frameWidth"])
    frame_height = int(metadata["frameHeight"])
    frame_count = int(args.frame_count or metadata["frameCount"])
    key = parse_color(args.key_color)
    components = split_components(args.sheet, frame_width, frame_height, frame_count)
    output_dir = args.output_dir
    clean_dir(output_dir)

    sheet_width = args.cell_width * frame_count
    sheet_height = frame_height
    canvas = Image.new("RGBA", (sheet_width, sheet_height), (*key, 255))
    draw = ImageDraw.Draw(canvas)

    records: list[dict[str, int | str]] = []
    for index, component in enumerate(components):
        cell_left = index * args.cell_width
        cell_center = cell_left + args.cell_width // 2
        if args.offset_pattern == "right":
            spill_offset = args.spill_px
        elif args.offset_pattern == "left":
            spill_offset = -args.spill_px
        else:
            # Alternate offsets so some frames cross the left edge and some cross the right edge.
            spill_offset = args.spill_px if index % 2 == 0 else -args.spill_px
        x = cell_center - component.width // 2 + spill_offset
        y = args.baseline_y - component.height + 1
        canvas.alpha_composite(component, (x, y))
        if args.draw_grid:
            draw.rectangle(
                (cell_left, 0, cell_left + args.cell_width - 1, sheet_height - 1),
                outline=(255, 180, 40, 255),
                width=1,
            )
        records.append(
            {
                "frame": f"frame-{index + 1:04d}",
                "componentWidth": component.width,
                "componentHeight": component.height,
                "cellLeft": cell_left,
                "cellRight": cell_left + args.cell_width - 1,
                "placedX": x,
                "placedY": y,
                "spillLeftPx": max(0, cell_left - x),
                "spillRightPx": max(0, (x + component.width - 1) - (cell_left + args.cell_width - 1)),
            }
        )

    sheet_path = output_dir / f"{args.name}.png"
    report_path = output_dir / f"{args.name}.json"
    canvas.save(sheet_path)
    report = {
        "schemaVersion": 1,
        "kind": "messy-sheet-fixture",
        "sourceSheet": str(args.sheet),
        "sourceMetadata": str(args.metadata),
        "sheet": str(sheet_path),
        "keyColor": args.key_color,
        "frameCount": frame_count,
        "cellWidth": args.cell_width,
        "cellHeight": frame_height,
        "baselineY": args.baseline_y,
        "spillPx": args.spill_px,
        "offsetPattern": args.offset_pattern,
        "drawGrid": args.draw_grid,
        "records": records,
    }
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create a messy generated-sheet fixture from a runtime spritesheet")
    parser.add_argument("--sheet", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--name", default="messy-sheet-fixture")
    parser.add_argument("--key-color", default=DEFAULT_KEY)
    parser.add_argument("--cell-width", type=int, default=72)
    parser.add_argument("--spill-px", type=int, default=18)
    parser.add_argument("--offset-pattern", choices=["alternate", "right", "left"], default="alternate")
    parser.add_argument("--draw-grid", action="store_true")
    parser.add_argument("--baseline-y", type=int, default=164)
    parser.add_argument("--frame-count", type=int)
    argv = sys.argv[1:]
    if argv and argv[0] == "--":
        argv = argv[1:]
    return parser.parse_args(argv)


def main() -> None:
    report = write_fixture(parse_args())
    print(json.dumps({"sheet": report["sheet"], "frameCount": report["frameCount"]}, indent=2))


if __name__ == "__main__":
    main()

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageChops


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--pad-x", type=int, default=512)
    parser.add_argument("--pad-y", type=int, default=128)
    parser.add_argument("--bg")
    parser.add_argument("--proof", type=Path, required=True)
    args = parser.parse_args()

    src = Image.open(args.input).convert("RGBA")
    if args.bg:
        bg = args.bg.lstrip("#")
        color = tuple(int(bg[i : i + 2], 16) for i in (0, 2, 4)) + (255,)
    else:
        color = src.getpixel((0, 0))

    out = Image.new("RGBA", (src.width + args.pad_x * 2, src.height + args.pad_y * 2), color)
    out.paste(src, (args.pad_x, args.pad_y))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    out.save(args.output)

    center = out.crop((args.pad_x, args.pad_y, args.pad_x + src.width, args.pad_y + src.height))
    unchanged = ImageChops.difference(center, src).getbbox() is None
    args.proof.parent.mkdir(parents=True, exist_ok=True)
    args.proof.write_text(
        "\n".join(
            [
                f"input={args.input.as_posix()}",
                f"output={args.output.as_posix()}",
                f"source_size={src.width}x{src.height}",
                f"output_size={out.width}x{out.height}",
                f"pad_x={args.pad_x}",
                f"pad_y={args.pad_y}",
                f"center_crop_unchanged={str(unchanged).lower()}",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    if not unchanged:
        raise SystemExit("center crop differs from source")


if __name__ == "__main__":
    main()

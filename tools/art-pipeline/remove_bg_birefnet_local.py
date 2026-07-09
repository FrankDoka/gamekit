"""Remove animation-frame backgrounds with local BiRefNet.

This is the no-Replicate path. It loads BiRefNet from Hugging Face into a local
PyTorch runtime and writes RGBA PNGs with the predicted matte as alpha.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import torch
from PIL import Image
from torchvision import transforms
from transformers import AutoModelForImageSegmentation


def frame_files(input_dir: Path) -> list[Path]:
    files = sorted(
        path
        for path in input_dir.iterdir()
        if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
    )
    if not files:
        raise ValueError(f"No image frames found in {input_dir}")
    return files


def matte_to_alpha(
    model: torch.nn.Module,
    image: Image.Image,
    device: torch.device,
    model_size: int,
) -> Image.Image:
    rgb = image.convert("RGB")
    transform = transforms.Compose(
        [
            transforms.Resize((model_size, model_size), interpolation=transforms.InterpolationMode.BILINEAR),
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ]
    )
    tensor = transform(rgb).unsqueeze(0).to(device)
    with torch.inference_mode():
        output = model(tensor)
        if isinstance(output, (tuple, list)):
            output = output[-1]
        mask = output.sigmoid().detach().cpu()[0].squeeze()
    alpha = transforms.ToPILImage()(mask).resize(rgb.size, Image.Resampling.BICUBIC)
    rgba = rgb.convert("RGBA")
    rgba.putalpha(alpha)
    return rgba


def main() -> None:
    parser = argparse.ArgumentParser(description="Local BiRefNet background removal for frame directories")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", default="ZhengPeng7/BiRefNet")
    parser.add_argument("--model-size", type=int, default=1024)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    device = torch.device(args.device if args.device == "cpu" or torch.cuda.is_available() else "cpu")
    torch.set_float32_matmul_precision("high")
    print(f"[birefnet-local] loading {args.model} on {device}")
    model = AutoModelForImageSegmentation.from_pretrained(args.model, trust_remote_code=True)
    model.to(device).eval()

    args.output.mkdir(parents=True, exist_ok=True)
    files = frame_files(args.input)
    print(f"[birefnet-local] processing {len(files)} frame(s)")
    for index, source in enumerate(files, start=1):
        target = args.output / source.with_suffix(".png").name
        if target.exists() and not args.force:
            print(f"  [{index}/{len(files)}] skip {target.name}")
            continue
        image = Image.open(source)
        result = matte_to_alpha(model, image, device, args.model_size)
        result.save(target)
        print(f"  [{index}/{len(files)}] wrote {target}")


if __name__ == "__main__":
    main()

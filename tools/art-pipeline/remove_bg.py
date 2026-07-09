"""Remove green-screen background from frames.

Supports two methods:
  - birefnet: GPU-accelerated via Replicate API (default, best quality)
  - chroma:   local color-keying fallback (no API needed)
"""

import argparse
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from config import FRAMES_DIR

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass


def remove_bg_chroma(
    frame_path: Path,
    output_path: Path,
    key_color: str = "green",
    tolerance: int = 40,
) -> Path:
    img = cv2.imread(str(frame_path))
    if img is None:
        raise RuntimeError(f"Cannot read: {frame_path}")

    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

    if key_color == "green":
        lower = np.array([35, 80, 80])
        upper = np.array([85, 255, 255])
    elif key_color == "magenta":
        lower1 = np.array([140, 80, 80])
        upper1 = np.array([180, 255, 255])
        lower2 = np.array([0, 80, 80])
        upper2 = np.array([10, 255, 255])
        mask1 = cv2.inRange(hsv, lower1, upper1)
        mask2 = cv2.inRange(hsv, lower2, upper2)
        bg_mask = cv2.bitwise_or(mask1, mask2)
        alpha = cv2.bitwise_not(bg_mask)
        rgba = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
        rgba[:, :, 3] = alpha
        output_path.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(output_path), rgba)
        return output_path
    else:
        raise ValueError(f"Unsupported key color: {key_color}")

    bg_mask = cv2.inRange(hsv, lower, upper)

    kernel = np.ones((3, 3), np.uint8)
    bg_mask = cv2.morphologyEx(bg_mask, cv2.MORPH_CLOSE, kernel, iterations=1)
    bg_mask = cv2.morphologyEx(bg_mask, cv2.MORPH_OPEN, kernel, iterations=1)

    alpha = cv2.bitwise_not(bg_mask)

    rgba = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
    rgba[:, :, 3] = alpha

    output_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output_path), rgba)
    return output_path


def remove_bg_birefnet(
    frame_path: Path,
    output_path: Path,
) -> Path:
    import replicate

    print(f"[remove_bg] BiRefNet processing {frame_path.name}...")

    result = replicate.run(
        "men1scus/birefnet",
        input={
            "image": open(frame_path, "rb"),
        },
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)

    if hasattr(result, "read"):
        output_path.write_bytes(result.read())
    elif isinstance(result, str):
        import urllib.request
        urllib.request.urlretrieve(result, output_path)
    else:
        import urllib.request
        urllib.request.urlretrieve(str(result), output_path)

    return output_path


def remove_bg_batch(
    input_dir: Path,
    output_dir: Path | None = None,
    method: str = "birefnet",
    key_color: str = "green",
) -> list[Path]:
    out = output_dir or (input_dir.parent / f"{input_dir.name}_clean")
    out.mkdir(parents=True, exist_ok=True)

    frames = sorted(input_dir.glob("frame_*.png"))
    if not frames:
        raise ValueError(f"No frame_*.png files in {input_dir}")

    print(f"[remove_bg] Processing {len(frames)} frames via {method}...")
    results = []

    for frame_path in frames:
        out_path = out / frame_path.name
        if method == "birefnet":
            remove_bg_birefnet(frame_path, out_path)
        elif method == "chroma":
            remove_bg_chroma(frame_path, out_path, key_color)
        else:
            raise ValueError(f"Unknown method: {method}")
        results.append(out_path)
        print(f"  [{len(results)}/{len(frames)}] {frame_path.name}")

    print(f"[remove_bg] Done — {len(results)} clean frames in {out}")
    return results


def check_edge_quality(frame_path: Path) -> list[str]:
    """Check a cleaned frame for edge halos or residual background."""
    img = Image.open(frame_path).convert("RGBA")
    data = np.array(img)

    warnings = []

    alpha = data[:, :, 3]
    semi_transparent = np.sum((alpha > 10) & (alpha < 240))
    total_visible = np.sum(alpha > 10)
    if total_visible > 0:
        ratio = semi_transparent / total_visible
        if ratio > 0.15:
            warnings.append(f"WARNING: {frame_path.name} has {ratio:.0%} semi-transparent pixels — possible edge halo")

    visible = alpha > 30
    if np.any(visible):
        green_channel = data[:, :, 1].astype(float)
        red_channel = data[:, :, 0].astype(float)
        blue_channel = data[:, :, 2].astype(float)
        green_excess = green_channel[visible] - np.maximum(red_channel[visible], blue_channel[visible])
        green_fringe = np.sum(green_excess > 50)
        if green_fringe > 20:
            warnings.append(f"WARNING: {frame_path.name} has {green_fringe} pixels with green fringe")

    return warnings


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Remove background from animation frames")
    parser.add_argument("--input", type=Path, required=True, help="Directory of frame_*.png files")
    parser.add_argument("--output", type=Path, help="Output directory for cleaned frames")
    parser.add_argument("--method", choices=["birefnet", "chroma"], default="birefnet", help="Background removal method")
    parser.add_argument("--key-color", choices=["green", "magenta"], default="green", help="Key color for chroma method")
    args = parser.parse_args()
    remove_bg_batch(args.input, args.output, args.method, args.key_color)

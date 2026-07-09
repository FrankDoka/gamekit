from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter, ImageSequence


def is_magenta_background(rgb: np.ndarray) -> np.ndarray:
    r = rgb[:, :, 0].astype(np.int16)
    g = rgb[:, :, 1].astype(np.int16)
    b = rgb[:, :, 2].astype(np.int16)
    return (r > 135) & (b > 135) & (g < 120) & ((r - g) > 55) & ((b - g) > 55)


def foreground_metrics(img: Image.Image) -> tuple[float, float, float]:
    arr = np.array(img.convert("RGBA")).astype(np.float32)
    mask = arr[:, :, 3] > 20
    if not mask.any():
        return 0.0, 0.0, 0.0
    rgb = arr[:, :, :3][mask]
    lum = float(rgb.mean())
    sat = float((rgb.max(axis=1) - rgb.min(axis=1)).mean())
    area_proxy = float(np.sqrt(mask.sum()))
    return area_proxy, lum, sat


def body_tone_metrics(img: Image.Image) -> tuple[float, float]:
    arr = np.array(img.convert("RGBA")).astype(np.float32)
    rgb = arr[:, :, :3]
    lum_map = rgb.mean(axis=2)
    mask = (arr[:, :, 3] > 200) & (lum_map > 60)
    if not mask.any():
        return 0.0, 0.0
    selected = rgb[mask]
    lum = float(lum_map[mask].mean())
    sat = float((selected.max(axis=1) - selected.min(axis=1)).mean())
    return lum, sat


def harden_alpha(img: Image.Image) -> Image.Image:
    arr = np.array(img.convert("RGBA"))
    keep = arr[:, :, 3] > 20
    arr[keep, 3] = 255
    arr[~keep, :] = 0
    return Image.fromarray(arr, "RGBA")


def purple_shadow_mask(arr: np.ndarray) -> np.ndarray:
    r = arr[:, :, 0].astype(np.int16)
    g = arr[:, :, 1].astype(np.int16)
    b = arr[:, :, 2].astype(np.int16)
    a = arr[:, :, 3]
    return (a > 50) & (r > 120) & (b > 120) & (g < r - 40) & (g < b - 40)


def magenta_lean_mask(arr: np.ndarray) -> np.ndarray:
    r = arr[:, :, 0].astype(np.int16)
    g = arr[:, :, 1].astype(np.int16)
    b = arr[:, :, 2].astype(np.int16)
    a = arr[:, :, 3]
    return (a > 250) & (r > g + 25) & (b > g + 25)


def alpha_edge_band(alpha: np.ndarray, radius: int = 2) -> np.ndarray:
    alpha_img = Image.fromarray(alpha, "L")
    edge = np.array(alpha_img.filter(ImageFilter.MinFilter(radius * 2 + 1)))
    return (alpha > 250) & (edge == 0)


def neutralize_magenta_edge_ring(img: Image.Image) -> Image.Image:
    arr = np.array(img.convert("RGBA"))
    alpha_before = arr[:, :, 3].copy()
    ring = magenta_lean_mask(arr) & alpha_edge_band(arr[:, :, 3])
    if not ring.any():
        return Image.fromarray(arr, "RGBA")
    r = arr[:, :, 0].astype(np.int16)
    g = arr[:, :, 1].astype(np.int16)
    b = arr[:, :, 2].astype(np.int16)
    neutral = np.clip((r + g + b) // 3, 0, 255).astype(np.uint8)
    arr[:, :, 0][ring] = neutral[ring]
    arr[:, :, 1][ring] = neutral[ring]
    arr[:, :, 2][ring] = neutral[ring]

    if not np.array_equal(alpha_before, arr[:, :, 3]):
        raise AssertionError("magenta edge-ring neutralization changed alpha")
    return Image.fromarray(arr, "RGBA")


def scrub_purple_shadow(img: Image.Image) -> Image.Image:
    arr = np.array(img.convert("RGBA"))
    arr[purple_shadow_mask(arr), :] = 0
    arr[arr[:, :, 3] == 0, :3] = 0
    return Image.fromarray(arr, "RGBA")


def match_tone(img: Image.Image, target_lum: float, target_sat: float) -> Image.Image:
    arr = np.array(img.convert("RGBA")).astype(np.float32)
    mask = arr[:, :, 3] > 20
    if not mask.any():
        return img
    rgb = arr[:, :, :3]
    for _ in range(3):
        selected = rgb[mask]
        lum = np.maximum(selected.mean(axis=1, keepdims=True), 1.0)
        gray = np.repeat(lum, 3, axis=1)
        body_lum, body_sat = body_tone_metrics(Image.fromarray(arr.astype(np.uint8), "RGBA"))
        if body_lum <= 0 or body_sat <= 0:
            break
        selected = gray + (selected - gray) * (target_sat / body_sat)
        selected *= target_lum / max(body_lum, 1.0)
        rgb[mask] = np.clip(selected, 0, 255)
        arr[:, :, :3] = rgb
    arr[:, :, :3] = rgb
    return Image.fromarray(arr.astype(np.uint8), "RGBA")


def clean_frame(
    path: Path,
    frame_width: int,
    frame_height: int,
    body_height: int,
    baseline_y: int,
    center_x: int,
    target_area_proxy: float | None,
    target_lum: float | None,
    target_sat: float | None,
) -> tuple[Image.Image, dict[str, int | str]]:
    src = Image.open(path).convert("RGBA")
    arr = np.array(src)
    bg = is_magenta_background(arr[:, :, :3])
    arr[bg, 3] = 0
    arr[arr[:, :, 3] == 0, :3] = 0

    alpha = arr[:, :, 3] > 20
    ys, xs = np.where(alpha)
    if len(xs) == 0:
        raise ValueError(f"no foreground found in {path}")
    left, right = int(xs.min()), int(xs.max()) + 1
    top, bottom = int(ys.min()), int(ys.max()) + 1
    crop = scrub_purple_shadow(harden_alpha(Image.fromarray(arr, "RGBA").crop((left, top, right, bottom))))
    if target_area_proxy:
        effective_target_area_proxy = target_area_proxy + 0.8
        source_area_proxy, _lum, _sat = foreground_metrics(crop)
        scale = effective_target_area_proxy / max(source_area_proxy, 1.0)
    else:
        effective_target_area_proxy = None
        scale = body_height / crop.height
    new_size = (max(1, round(crop.width * scale)), max(1, round(crop.height * scale)))
    crop = crop.resize(new_size, Image.Resampling.LANCZOS)
    crop = scrub_purple_shadow(harden_alpha(crop))
    if effective_target_area_proxy:
        current_area_proxy, _lum, _sat = foreground_metrics(crop)
        if current_area_proxy > 0 and abs(current_area_proxy - effective_target_area_proxy) > 0.5:
            refine = effective_target_area_proxy / current_area_proxy
            refined_size = (max(1, round(crop.width * refine)), max(1, round(crop.height * refine)))
            crop = scrub_purple_shadow(harden_alpha(crop.resize(refined_size, Image.Resampling.LANCZOS)))
    if target_lum is not None and target_sat is not None:
        crop = match_tone(crop, target_lum, target_sat)
        crop = scrub_purple_shadow(harden_alpha(crop))

    out = Image.new("RGBA", (frame_width, frame_height), (0, 0, 0, 0))
    x = center_x - crop.width // 2
    y = baseline_y - crop.height + 1
    out.alpha_composite(crop, (x, y))
    out_arr = np.array(out)
    shadow = purple_shadow_mask(out_arr)
    out_arr[shadow, :] = 0
    out_arr[out_arr[:, :, 3] == 0, :3] = 0
    out = Image.fromarray(out_arr, "RGBA")
    out = neutralize_magenta_edge_ring(out)
    return out, {
        "source": path.as_posix(),
        "sourceBBox": f"{left},{top},{right},{bottom}",
        "sourceWidth": right - left,
        "sourceHeight": bottom - top,
        "scalePermille": round(scale * 1000),
        "outputX": x,
        "outputY": y,
        "outputWidth": crop.width,
        "outputHeight": crop.height,
    }


def save_gif(frames: list[Image.Image], path: Path, fps: int) -> None:
    duration = max(1, round(1000 / fps))
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=duration, loop=0, disposal=2)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--selected-dir", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--stem", required=True)
    parser.add_argument("--frame-width", type=int, default=384)
    parser.add_argument("--frame-height", type=int, default=320)
    parser.add_argument("--body-height", type=int, default=222)
    parser.add_argument("--baseline-y", type=int, default=318)
    parser.add_argument("--center-x", type=int, default=192)
    parser.add_argument("--fps", type=int, default=22)
    parser.add_argument("--master", type=Path)
    args = parser.parse_args()

    selected = sorted(args.selected_dir.glob("*.png"))
    if not selected:
        raise SystemExit(f"no PNG frames found under {args.selected_dir}")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    frames_dir = args.out_dir / f"{args.stem}_frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    frames: list[Image.Image] = []
    records = []
    target_area_proxy = target_lum = target_sat = None
    if args.master:
        master = Image.open(args.master).convert("RGBA")
        bbox = master.getchannel("A").point(lambda value: 255 if value > 20 else 0).getbbox()
        if bbox is None:
            raise SystemExit(f"master has no alpha foreground: {args.master}")
        target_area_proxy, _foreground_lum, _foreground_sat = foreground_metrics(master.crop(bbox))
        target_lum, target_sat = body_tone_metrics(master.crop(bbox))
    for index, path in enumerate(selected):
        frame, record = clean_frame(
            path,
            args.frame_width,
            args.frame_height,
            args.body_height,
            args.baseline_y,
            args.center_x,
            target_area_proxy,
            target_lum,
            target_sat,
        )
        frame.save(frames_dir / f"frame-{index + 1:03d}.png")
        frames.append(frame)
        records.append(record)

    sheet = Image.new("RGBA", (args.frame_width * len(frames), args.frame_height), (0, 0, 0, 0))
    for index, frame in enumerate(frames):
        sheet.alpha_composite(frame, (index * args.frame_width, 0))
    sheet_path = args.out_dir / f"{args.stem}.clean.png"
    sheet.save(sheet_path)
    sheet.save(args.out_dir / f"{args.stem}_cleaned.webp", lossless=True)

    preview = Image.new("RGBA", (args.frame_width * len(frames), args.frame_height), (255, 0, 255, 255))
    for index, frame in enumerate(frames):
        preview.alpha_composite(frame, (index * args.frame_width, 0))
    preview.save(args.out_dir / f"{args.stem}_preview.png")
    save_gif(frames, args.out_dir / f"{args.stem}_preview.gif", args.fps)
    save_gif(frames, args.out_dir / f"{args.stem}_slow4fps.gif", 4)

    metadata = {
        "schemaVersion": 1,
        "entity": "player_baldbase",
        "animation": "swing_1h",
        "frameWidth": args.frame_width,
        "frameHeight": args.frame_height,
        "frames": len(frames),
        "fps": args.fps,
        "loop": False,
        "bodyHeight": args.body_height,
        "baselineY": args.baseline_y,
        "centerX": args.center_x,
        "nativeFacesRight": True,
        "sourceFrames": [p.as_posix() for p in selected],
        "records": records,
    }
    (args.out_dir / f"{args.stem}.metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()

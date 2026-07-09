"""Generate animation clips via Seedance 2.0 on Replicate.

Requires REPLICATE_API_TOKEN env var or .env file in this directory.
"""

import argparse
import os
import urllib.request
from pathlib import Path

from config import RAW_DIR

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass


def animate(
    input_image: Path,
    state: str = "idle",
    output: Path | None = None,
    prompt: str | None = None,
    duration: int = 4,
) -> Path:
    import replicate

    if not prompt:
        prompt = get_default_prompt(state)

    output_path = output or (RAW_DIR / f"{input_image.stem}_{state}.mp4")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"[animate] Generating {state} animation for {input_image.name}...")
    print(f"[animate] Prompt: {prompt[:120]}...")
    print(f"[animate] Duration: {duration}s")

    # Provider standard (owner, 2026-07-03): seedance-2.0 MINI @ 720p / 4s for ALL
    # clip generation. Per-run owner cost sign-off still required (pipeline rule).
    result = replicate.run(
        "bytedance/seedance-2.0-mini",
        input={
            "image": open(input_image, "rb"),
            "prompt": prompt,
            "duration": duration,
            "resolution": "720p",
            "aspect_ratio": "3:4",
            "generate_audio": False,
        },
    )

    if hasattr(result, "read"):
        output_path.write_bytes(result.read())
    elif isinstance(result, str):
        urllib.request.urlretrieve(result, output_path)
    else:
        url = str(result)
        urllib.request.urlretrieve(url, output_path)

    size_kb = output_path.stat().st_size / 1024
    print(f"[animate] Saved: {output_path} ({size_kb:.1f} KB)")
    return output_path


def get_default_prompt(state: str) -> str:
    camera = (
        "Static tripod shot. Locked camera, zero camera shake. "
        "No close-up, no face crop, no zoom, no cuts, no reframing."
    )
    background = (
        "Keep the character centered on a flat solid green (#00ff00) background. "
        "Do not turn the background into a floor, room, horizon, outdoor scene, "
        "perspective grid, shadow plane, or environment."
    )
    preserve = (
        "Preserve exact identity, proportions, palette, costume, silhouette, "
        "and outline from the input image."
    )

    prompts = {
        "idle": (
            f"Wide shot, full body head to toe, single character idle animation. "
            f"Subtle breathing only. Feet stay planted. Minimal arm sway. "
            f"{camera} {background} {preserve}"
        ),
        "walk": (
            f"Wide shot, full body head to toe, single character walk cycle in place. "
            f"Small looping in-place walk facing right. Subtle vertical bobbing, "
            f"alternating leg steps, light clothing sway, minimal arm swing. "
            f"Feet remain visible, character does not translate across frame. "
            f"{camera} {background} {preserve}"
        ),
        "attack": (
            f"Wide shot, full body head to toe, single character attack animation. "
            f"Quick forward strike or slash. Feet stay planted. "
            f"One swift motion then return to neutral stance. "
            f"{camera} {background} {preserve}"
        ),
        "cast": (
            f"Wide shot, full body head to toe, single character spell-casting animation. "
            f"Hands move forward as magical energy builds. Small release at the end. "
            f"Feet stay planted. No forward lunge. "
            f"{camera} {background} {preserve}"
        ),
        "hit": (
            f"Wide shot, full body head to toe, single character hit reaction animation. "
            f"Brief flinch or recoil backward, then return to neutral stance. "
            f"Feet stay planted. "
            f"{camera} {background} {preserve}"
        ),
        "death": (
            f"Wide shot, full body head to toe, single character death animation. "
            f"Character staggers then collapses to the ground. "
            f"{camera} {background} {preserve}"
        ),
    }
    return prompts.get(state, prompts["idle"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate animation via Seedance 2.0")
    parser.add_argument("--input", type=Path, required=True, help="Input character image")
    parser.add_argument("--state", default="idle", help="Animation state (idle/walk/attack/cast/hit/death)")
    parser.add_argument("--output", type=Path, help="Output video path (.mp4)")
    parser.add_argument("--prompt", type=str, help="Custom prompt (overrides default)")
    parser.add_argument("--duration", type=int, default=4, help="Video duration in seconds (default: 4)")
    args = parser.parse_args()
    animate(args.input, args.state, args.output, args.prompt, args.duration)

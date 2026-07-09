"""Static-asset dark-rim shimmer metric (card-shimmer-npc-revert-fix, 2026-07-07).

Root cause of the green-vs-blue slime shimmer asymmetry is a PER-ASSET rim property,
not a renderer difference: both slimes render through the same code at the same runtime
minification (~3.3x down from ~224px source to ~67px display), so the sprite with the
thicker / higher-frequency dark outline aliases far more against the light green ground
as sub-pixel camera motion shifts sampling. Measurement (2026-07-07):

  green (monster_meadow_slime): dark outline 12894px = 40.4% of body, avg thickness 11.45px
  blue  (monster_dew_slime):    dark outline  3367px = 10.2% of body, avg thickness  5.47px

This deterministic static-asset metric is the regression guard: it needs no browser and
directly measures the shimmer-driving property. The gate asserts the green slime's dark-rim
burden is at/below the blue slime's band (the card success criterion "green slime ... at/below
blue's band"). It FAILS UNTIL the green-slime rim is re-derived by the Codex art lane — that
is intended: the code lane reverts and measures; the asset lane owns the rim rebuild.

Usage:
  python tools/asset-cleanup/slime_rim_shimmer_metric.py client/public/assets/sprites [--out DIR] [--gate]

--gate exits non-zero if the green slime's dark-rim fraction exceeds the blue slime's band
(blue fraction * TOLERANCE). Without --gate it only reports (used inside the proof leg so a
red asset does not block the code lane's own gates).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# Dark-outline luminance ceiling — matches slime_burst_variance.py's _dark_mask (lum <= 92).
DARK_LUM_MAX = 92
# Green may exceed blue's dark-rim fraction by at most this factor and still pass the gate.
GATE_TOLERANCE = 1.15

GREEN_KEY = "monster_meadow_slime"
BLUE_KEY = "monster_dew_slime"
# One NPC tracked for regression alongside the slimes (harbor warden is the NPC the
# reverted treatment hit; its soft feathered rim must not regress back to a hard rim).
NPC_KEY = "npc_harbor_warden"


def _erode1(mask: np.ndarray) -> np.ndarray:
    """4-neighbour binary erosion (no scipy dependency in this env)."""
    up = np.zeros_like(mask); up[:-1, :] = mask[1:, :]
    down = np.zeros_like(mask); down[1:, :] = mask[:-1, :]
    left = np.zeros_like(mask); left[:, :-1] = mask[:, 1:]
    right = np.zeros_like(mask); right[:, 1:] = mask[:, :-1]
    return mask & up & down & left & right


def rim_profile(path: Path) -> dict[str, object]:
    arr = np.asarray(Image.open(path).convert("RGBA"))
    alpha = arr[:, :, 3]
    rgb = arr[:, :, :3].astype(np.int16)
    lum = rgb.mean(axis=2)
    solid = alpha > 8
    solid_px = int(solid.sum())
    dark = solid & (lum <= DARK_LUM_MAX)
    dark_px = int(dark.sum())
    perim = solid & ~_erode1(solid)
    perim_px = int(perim.sum())
    return {
        "path": path.name,
        "size": f"{arr.shape[1]}x{arr.shape[0]}",
        "solid_px": solid_px,
        "perimeter_px": perim_px,
        "dark_outline_px": dark_px,
        "dark_frac_of_solid": round(dark_px / solid_px, 4) if solid_px else None,
        "avg_dark_thickness_px": round(dark_px / perim_px, 2) if perim_px else None,
    }


def measure(sprite_dir: Path) -> dict[str, object]:
    profiles: dict[str, dict[str, object]] = {}
    for key in (GREEN_KEY, BLUE_KEY, NPC_KEY):
        path = sprite_dir / f"{key}.png"
        if not path.exists():
            raise SystemExit(f"missing asset for shimmer metric: {path}")
        profiles[key] = rim_profile(path)
    green_frac = profiles[GREEN_KEY]["dark_frac_of_solid"]
    blue_frac = profiles[BLUE_KEY]["dark_frac_of_solid"]
    blue_band = round(float(blue_frac) * GATE_TOLERANCE, 4) if blue_frac is not None else None
    green_within_blue_band = (
        green_frac is not None and blue_band is not None and float(green_frac) <= blue_band
    )
    return {
        "kind": "slime-rim-shimmer-metric",
        "dark_lum_max": DARK_LUM_MAX,
        "gate_tolerance": GATE_TOLERANCE,
        "profiles": profiles,
        "green_dark_frac": green_frac,
        "blue_dark_frac": blue_frac,
        "blue_band_ceiling": blue_band,
        "green_within_blue_band": green_within_blue_band,
        "note": (
            "green_within_blue_band == false is EXPECTED until the Codex art lane re-derives "
            "the meadow-slime rim; the code lane reverts + measures only."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("sprite_dir")
    parser.add_argument("--out", default=None, help="directory to write slime-rim-shimmer-metric.json")
    parser.add_argument("--gate", action="store_true", help="exit non-zero if green exceeds blue's band")
    args = parser.parse_args()
    result = measure(Path(args.sprite_dir))
    print(json.dumps(result, indent=2))
    if args.out:
        out_dir = Path(args.out)
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "slime-rim-shimmer-metric.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    if args.gate and not result["green_within_blue_band"]:
        print("GATE FAIL: green slime dark-rim fraction exceeds blue slime's band", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

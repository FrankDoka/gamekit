"""rimfix — remove magenta/pink cast from soft-alpha rim pixels.

The despill classifier in fringe.py targets hard chroma fringe; it does NOT flag the subtler
failure this tool fixes: semi-transparent silhouette pixels whose chroma is magenta-biased
(pink index (R+B)/2 - G strongly positive vs the art's core), which reads as pink smudging
wherever the asset overlays terrain (owner-flagged 2026-07-01, devlog 0185).

Usage:
  python tools/asset-cleanup/rimfix.py scan <path...>                 # report rim pink index
  python tools/asset-cleanup/rimfix.py fix <path...> --backup <dir>   # dry-run
  python tools/asset-cleanup/rimfix.py fix <path...> --backup <dir> --run

Fix: for rim pixels (0 < alpha < 250) with pink index > threshold (default 6), subtract the
per-pixel excess from R and B, landing rim chroma at core-like values while preserving warmth.
Apply to the bank source AND the runtime copy in the same pass (lockstep rule,
docs/process/visual-tuning-playbook.md).
"""
import argparse
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image


def rim_stats(path: Path):
    arr = np.array(Image.open(path).convert("RGBA"), dtype=np.float32)
    r, g, b, a = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2], arr[:, :, 3]
    rim = (a > 0) & (a < 250)
    core = a >= 250
    pink = (r + b) / 2 - g
    rim_pink = float(pink[rim].mean()) if rim.any() else 0.0
    core_pink = float(pink[core].mean()) if core.any() else 0.0
    return arr, rim, pink, rim_pink, core_pink


def fix(path: Path, threshold: float, run: bool, backup: Path | None) -> None:
    arr, rim, pink, rim_pink, core_pink = rim_stats(path)
    offenders = rim & (pink > threshold)
    n = int(offenders.sum())
    # A real pink-rim defect is both absolutely pink/magenta-biased and more pink
    # than the asset core. Blue/cyan water can have a very negative core pink index;
    # a neutral or blue rim must not fail merely for being "less cyan" than the core.
    verdict = "PINK-RIM" if rim_pink >= threshold and rim_pink - core_pink >= threshold else "OK"
    print(f"{verdict:9s} {path}  rim={rim_pink:+5.1f} core={core_pink:+5.1f} offenders={n}")
    if verdict == "OK" or not run:
        return
    if backup:
        backup.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, backup / path.name)
    excess = np.where(offenders, pink - 2, 0)  # leave a hair of warmth
    arr[:, :, 0] = np.clip(arr[:, :, 0] - excess, 0, 255)
    arr[:, :, 2] = np.clip(arr[:, :, 2] - excess, 0, 255)
    Image.fromarray(arr.astype(np.uint8), "RGBA").save(path)
    _, _, _, after, _ = rim_stats(path)
    print(f"  FIXED -> rim pink now {after:+5.1f}")


def collect(paths: list[str]) -> list[Path]:
    out: list[Path] = []
    for raw in paths:
        p = Path(raw)
        if p.is_dir():
            out.extend(sorted(p.rglob("*.png")))
        elif p.suffix.lower() == ".png":
            out.append(p)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["scan", "fix"])
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--threshold", type=float, default=6.0)
    ap.add_argument("--run", action="store_true", help="apply changes (fix is dry-run by default)")
    ap.add_argument("--backup", type=Path, default=None)
    args = ap.parse_args()
    if args.command == "fix" and args.run and not args.backup:
        print("refusing to fix --run without --backup <dir>", file=sys.stderr)
        return 2
    for path in collect(args.paths):
        if args.command == "scan":
            _, _, _, rim_pink, core_pink = rim_stats(path)
            flag = "PINK-RIM" if rim_pink >= args.threshold and rim_pink - core_pink >= args.threshold else "ok"
            print(f"{flag:9s} {path}  rim={rim_pink:+5.1f} core={core_pink:+5.1f}")
        else:
            fix(path, args.threshold, args.run, args.backup)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

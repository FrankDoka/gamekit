"""resize-prop — re-derive a runtime prop PNG at a new display size, 1:1-rule compliant.

Props ship at their exact on-screen pixel size (scale 1, zoom fixed 1.0 — devlogs 0141/0185).
To change how big a prop reads, you re-derive the runtime file, preferably from its 1024px
bank master (crisp LANCZOS downscale), never by scaling at runtime. This tool automates that,
using promoted-registry.json to find the bank master.

Usage:
  python tools/asset-cleanup/resize-prop.py <targetName> <size> [--backup <dir>] [--run]
  python tools/asset-cleanup/resize-prop.py harbor_stone_well 170 --backup Z:/Assets/_cleanup-backups/x --run

Scale guidance (player is 96px tall — visual-tuning-playbook "relative-scale sanity"):
person < bench/well (140-180) < lamp/signpost (175-235) < stall/boat (300+).

After resizing: run `pnpm assets:check` (resampling can surface fringe — despill/rimfix if
flagged), re-run editor Auto shape for the prop's collision if it was authored at the old
size, and capture:zone the closeup-inspect framing.
"""
import argparse
import json
import os
import shutil
import sys
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parents[2]
# External asset data bank. Mirrors toolkit-config.ts: override with ASSETS_ROOT;
# default matches its <GAME_ROOT>/assets-bank so the tool is portable off Z:/Assets.
ASSETS_BANK = Path(os.environ.get("ASSETS_ROOT", str(REPO / "assets-bank")))
RUNTIME_ROOT = REPO / "client" / "public" / "assets"
REGISTRY = RUNTIME_ROOT / "promoted-registry.json"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("target_name")
    ap.add_argument("size", type=int)
    ap.add_argument("--backup", type=Path, default=None)
    ap.add_argument("--run", action="store_true", help="apply (dry-run by default)")
    args = ap.parse_args()

    runtime = next(RUNTIME_ROOT.rglob(f"{args.target_name}.png"), None)
    if runtime is None:
        print(f"runtime file for {args.target_name} not found under {RUNTIME_ROOT}", file=sys.stderr)
        return 2

    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    source_rel = next(
        (e.get("sourcePath", "") for e in registry["promoted"].values() if e.get("targetName") == args.target_name),
        "",
    )
    master = ASSETS_BANK / source_rel if source_rel else None
    use_master = master is not None and master.exists()
    src = master if use_master else runtime
    src_img = Image.open(src).convert("RGBA")
    current = Image.open(runtime).size[0]

    print(f"{args.target_name}: {current}px -> {args.size}px  (source: {'bank master ' + str(src_img.size[0]) + 'px' if use_master else 'RUNTIME UPSCALE — re-promote a 1024px master when possible'})")
    if not args.run:
        print("dry-run; pass --run --backup <dir> to apply")
        return 0
    if not args.backup:
        print("refusing --run without --backup <dir>", file=sys.stderr)
        return 2
    args.backup.mkdir(parents=True, exist_ok=True)
    shutil.copy2(runtime, args.backup / runtime.name)
    src_img.resize((args.size, args.size), Image.LANCZOS).save(runtime)
    print(f"written {runtime} — now run: pnpm assets:check, then capture:zone closeup-inspect")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

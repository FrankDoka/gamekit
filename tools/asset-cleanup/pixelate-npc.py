"""pixelate-npc — derive a runtime NPC/character sprite from its bank master, style-matched.

Why this exists (devlog 0188): player sprites are true pixel art; NPC masters are painterly
high-res illustrations. A plain LANCZOS downscale of a painting is a small soft painting —
it reads blurry/low-quality next to the player. Characters that ship as runtime sprites get
this full derivation, not just a resize:

  alpha-bbox crop -> square pad (feet flush bottom) -> LANCZOS to target px
  -> unsharp mask -> saturation/contrast lift -> median-cut palette quantize
  -> hard alpha threshold -> 1px dark silhouette outline

Usage:
  python tools/asset-cleanup/pixelate-npc.py <targetName> [--size 112] [--master <path>] [--backup <dir>] [--run]
  python tools/asset-cleanup/pixelate-npc.py npc_harbor_warden --run --backup Z:/Assets/_cleanup-backups/x

Without --master, the bank master is resolved from promoted-registry.json (same as
resize-prop.py). Size default 112 = the NPC standard (player body is 88px; playbook says
NPCs ~108-112px). After running: `pnpm assets:check`, then capture:zone closeup-inspect.
"""
import argparse
import json
import os
import shutil
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageEnhance, ImageFilter

REPO = Path(__file__).resolve().parents[2]
# External asset data bank. Mirrors toolkit-config.ts: override with ASSETS_ROOT;
# default matches its <GAME_ROOT>/assets-bank so the tool is portable off Z:/Assets.
ASSETS_BANK = Path(os.environ.get("ASSETS_ROOT", str(REPO / "assets-bank")))
RUNTIME_ROOT = REPO / "client" / "public" / "assets"
REGISTRY = RUNTIME_ROOT / "promoted-registry.json"

OUTLINE_COLOR = (28, 22, 18, 255)


def derive(master: Path, size: int) -> Image.Image:
    im = Image.open(master).convert("RGBA")
    bbox = im.getchannel("A").getbbox()
    if bbox is None:
        raise SystemExit(f"{master} is fully transparent")
    body = im.crop(bbox)
    side = max(body.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(body, ((side - body.width) // 2, side - body.height))
    scaled = square.resize((size, size), Image.LANCZOS)

    rgb = scaled.convert("RGB").filter(ImageFilter.UnsharpMask(radius=1.2, percent=90, threshold=2))
    rgb = ImageEnhance.Color(rgb).enhance(1.12)
    rgb = ImageEnhance.Contrast(rgb).enhance(1.06)
    quant = rgb.quantize(colors=48, method=Image.MEDIANCUT, dither=Image.Dither.NONE).convert("RGB")

    alpha = scaled.getchannel("A").point(lambda v: 255 if v >= 128 else 0)
    flat = quant.convert("RGBA")
    flat.putalpha(alpha)

    grown = alpha.filter(ImageFilter.MaxFilter(3))
    ring = ImageChops.subtract(grown, alpha)
    out = Image.new("RGBA", flat.size, (0, 0, 0, 0))
    edge = Image.new("RGBA", flat.size, OUTLINE_COLOR)
    out.paste(edge, (0, 0), ring)
    out.alpha_composite(flat)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("target_name")
    ap.add_argument("--size", type=int, default=112)
    ap.add_argument("--master", type=Path, default=None, help="bank master (default: promoted-registry lookup)")
    ap.add_argument("--backup", type=Path, default=None)
    ap.add_argument("--run", action="store_true", help="apply (dry-run by default)")
    args = ap.parse_args()

    runtime = next(RUNTIME_ROOT.rglob(f"{args.target_name}.png"), None)
    if runtime is None:
        print(f"runtime file for {args.target_name} not found under {RUNTIME_ROOT}", file=sys.stderr)
        return 2

    master = args.master
    if master is None:
        registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
        source_rel = next(
            (e.get("sourcePath", "") for e in registry["promoted"].values() if e.get("targetName") == args.target_name),
            "",
        )
        master = ASSETS_BANK / source_rel if source_rel else None
    if master is None or not master.exists():
        print(f"no bank master found for {args.target_name}; pass --master <path>", file=sys.stderr)
        return 2

    print(f"{args.target_name}: {master} -> {runtime} @ {args.size}px (pixel-style derivation)")
    if not args.run:
        print("dry-run; pass --run --backup <dir> to apply")
        return 0
    if not args.backup:
        print("refusing --run without --backup <dir>", file=sys.stderr)
        return 2
    args.backup.mkdir(parents=True, exist_ok=True)
    shutil.copy2(runtime, args.backup / runtime.name)
    derive(master, args.size).save(runtime)
    print(f"written {runtime} — now run: pnpm assets:check, then capture:zone closeup-inspect")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

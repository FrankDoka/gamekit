#!/usr/bin/env python3
"""Zone display-size audit: true on-screen size of every placement, basis-aware.

Second-occurrence gate (owner standing order 2026-07-02): sizing defects shipped
twice through eyeball review — (1) the V3 prop set landed 1.3-1.9x oversized past a
lane self-check and an integrator ordering-rule review; (2) the integrator's own
reference-recalibration mis-measured every 1440p-basis asset by 2.5x because the
"_NNNpx" filename convention is SCREEN px at basis zoom, not world px. This tool
makes the measurement mechanical so neither can recur.

WORLD px = opaque-bbox height x layout scale            (plain assets)
         = opaque-bbox height x layout scale x 0.39722  (PROMOTED_1440P_BASIS_ASSETS)
x_player = world px / 88  (PLAYER_BODY_DISPLAY_HEIGHT)

Usage:
  python tools/asset-cleanup/display-audit.py content/zones/<map>.layout.json \
      [--assets client/public/assets] [--max-prop 4.8] [--max-decal 1.2] \
      [--strict-resolution]

Exit 1 if any placement exceeds its ceiling (landmark max 4.8x for props;
decals above ~1.2x player are ground-cover masquerading as set dressing).
Reviews cite the printed table instead of eyeballing captures (recipe 9).

RESOLUTION CHECK (third basis-semantics failure class, 2026-07-02): after R0.5
the camera magnifies world px by ~2.52 on a 1440p display, so a runtime derived
at WORLD-px size ships a file that is upsampled ~2.5x on screen (the owner's
"why does it look way lower quality in game" stall). Crisp = file opaque px >=
on-screen px at the 1440p reference, i.e. derive runtimes at world px x 2.517
and register basis: "1440p-display-px". The `res` column prints the upsample
factor (1.00 = pixel-perfect); --strict-resolution fails any placement above
1.15. Strict is OPT-IN until the cel restyle wave replaces the current library
(every pre-wave asset fails it by construction); the pilot and all regen
intakes MUST run with --strict-resolution.
"""
import argparse, json, os, sys
from PIL import Image

ASSET_BASIS_SCALE = 88 * 6.5 / 1440  # keep in sync with client/src/config/constants.ts
PLAYER = 88.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("layout")
    ap.add_argument("--assets", default="client/public/assets")
    ap.add_argument("--max-prop", type=float, default=4.8)
    ap.add_argument("--max-decal", type=float, default=1.2)
    ap.add_argument("--strict-resolution", action="store_true",
                    help="fail placements upsampled >1.15x on a 1440p display")
    args = ap.parse_args()

    lay = json.load(open(args.layout))
    reg = json.load(open(os.path.join(args.assets, "promoted-registry.json")))
    entries = {e["targetName"]: e for e in reg["promoted"].values()}

    # key -> (world-px height at scale 1, file opaque-px height); (-1, -1) = missing
    heights: dict[str, tuple[float, float]] = {}

    def measure(key: str) -> tuple[float, float]:
        if key not in heights:
            ent = entries.get(key)
            rel = ent["targetPath"].split("assets/", 1)[-1] if ent else None
            candidates = [rel] if rel else []
            candidates += [f"props/{key}.png", f"decals/{key}.png", f"tilesets/{key}.png"]
            path = next((os.path.join(args.assets, c) for c in candidates
                         if c and os.path.exists(os.path.join(args.assets, c))), None)
            if path is None:
                heights[key] = (-1.0, -1.0)
            else:
                bb = Image.open(path).convert("RGBA").getchannel("A").getbbox()
                file_h = float(bb[3] - bb[1]) if bb else 0.0
                world_h = file_h
                if ent and ent.get("basis") == "1440p-display-px":
                    world_h *= ASSET_BASIS_SCALE
                heights[key] = (world_h, file_h)
        return heights[key]

    failures = 0
    soft = 0
    rows = []
    for section, ceiling in (("props", args.max_prop), ("decals", args.max_decal)):
        seen: dict[str, tuple[float, float, int]] = {}
        for it in lay.get(section, []):
            key = it["assetKey"]
            world_h, file_h = measure(key)
            if world_h < 0:
                rows.append((section, key, 1, None, None, "MISSING FILE"))
                failures += 1
                continue
            wh = world_h * it.get("scale", 1)
            x = wh / PLAYER
            # on-screen px at the 1440p reference zoom vs pixels the file actually has
            res = (wh / ASSET_BASIS_SCALE) / file_h if file_h else float("inf")
            if key in seen:
                seen[key] = (seen[key][0], seen[key][1], seen[key][2] + 1)
            else:
                seen[key] = (x, res, 1)
        for key, (x, res, n) in sorted(seen.items(), key=lambda kv: -kv[1][0]):
            verdict = "ok"
            if x > ceiling:
                verdict = "FAIL"
                failures += 1
            elif res > 1.15:
                soft += 1
                if args.strict_resolution:
                    verdict = "FAIL-RES"
                    failures += 1
                else:
                    verdict = "soft"
            rows.append((section, key, n, x, res, verdict))

    w = max((len(r[1]) for r in rows), default=20)
    print(f"{'section':7} {'assetKey':{w}} {'n':>3} {'x_player':>8} {'res':>5}  verdict")
    for section, key, n, x, res, verdict in rows:
        xs = f"{x:8.2f}" if x is not None else "     ???"
        rs = f"{res:5.2f}" if res is not None else "  ???"
        print(f"{section:7} {key:{w}} {n:>3} {xs} {rs}  {verdict}")
    print(f"\n{'FAIL' if failures else 'OK'}: {failures} violation(s); "
          f"ceilings prop<={args.max_prop}x decal<={args.max_decal}x player; "
          f"basis-set assets scaled by {ASSET_BASIS_SCALE:.5f}")
    if soft:
        mode = "FAILED (strict)" if args.strict_resolution else "soft-flagged"
        print(f"resolution: {soft} asset(s) upsampled >1.15x on a 1440p display {mode}; "
              f"crisp = derive at world px x {1/ASSET_BASIS_SCALE:.3f} + register "
              f'basis "1440p-display-px" (mandatory for restyle-wave intakes)')
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

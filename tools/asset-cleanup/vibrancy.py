"""Vibrancy-profile WARNING check for game assets.

This is deliberately advisory, not a gate: the art-direction brief's "chroma floor" /
"value floor" doctrines (docs/design/art-direction-brief.md section 2.3) are a strict,
subjective review call ("dull is a rejection, not a note") that stays with the human/AI
reviewer. This tool only flags candidates for that review — it never blocks accept or
promote, and it is never wired into hard_defect()/assets:check.

Method: mean HSV saturation + value over OPAQUE pixels only (background/alpha-edge pixels
would skew the read). Compared against a floor derived from the brief's chroma/value floor
language, not per-zone hue matching (that call needs a human eyeballing the zone, not a
per-pixel average).

CLI:
  python vibrancy.py scan PATH [--json OUT]   report dull-flagged assets (never fails CI)
"""
from __future__ import annotations
import argparse
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore", message=".*getdata is deprecated.*")

try:
    from PIL import Image
except ImportError:
    sys.stderr.write("vibrancy.py requires Pillow: pip install Pillow\n")
    sys.exit(2)

# Floors derived from art-direction-brief.md section 2.3 ("High-key + high-chroma, never
# muddy"): base hues are vivid (meadow #7CCB4E-#9ADB5A, plaza tan #EFC27E-#E8B066, honey wood
# #C98F52-#A9713C, sea #41B7E0-#79D4F2 all sit at HSV S >= ~0.35, V >= ~0.55), and "no large
# surface below mid-value except deliberate shadow accents". Deliberately generous (a WARNING
# threshold, not the strict per-zone rubric) so this only flags genuinely washed-out/muddy
# candidates, not every asset with a shadow tone or a desaturated UI chrome element.
SATURATION_FLOOR = 0.22
VALUE_FLOOR = 0.32

SKIP_DIRS = {
    "_review", "_sliced", "_cleanup", "_cleanup-backups", "_rejected", "_archive",
    "archive", "_runtime-ready-packs", "_promotion-plans", "thumbs", ".thumbs",
    "_previews", "frames", "node_modules", ".git", "__pycache__",
}


def profile(path):
    """Return {"mean_saturation": float, "mean_value": float, "opaque_px": int} over
    opaque (alpha >= 250) pixels only. Returns None if the image has no opaque pixels
    (nothing to judge)."""
    im = Image.open(path).convert("RGBA")
    hsv = im.convert("RGB").convert("HSV")
    a = im.getchannel("A")
    h_data, s_data, v_data = hsv.split()
    s_list, v_list, a_list = list(s_data.getdata()), list(v_data.getdata()), list(a.getdata())
    total_s = total_v = n = 0
    for s, v, alpha in zip(s_list, v_list, a_list):
        if alpha < 250:
            continue
        total_s += s
        total_v += v
        n += 1
    if n == 0:
        return None
    return {"mean_saturation": (total_s / n) / 255.0, "mean_value": (total_v / n) / 255.0, "opaque_px": n}


def warn_reasons(path):
    """Return a list of warning strings (empty if the asset clears the floors)."""
    p = profile(path)
    if p is None:
        return []
    reasons = []
    if p["mean_saturation"] < SATURATION_FLOOR:
        reasons.append(f"low chroma (mean saturation {p['mean_saturation']:.2f} < floor {SATURATION_FLOOR}) — "
                        f"may read as washed out/dull against the vibrancy bible (docs/design/art-direction-brief.md)")
    if p["mean_value"] < VALUE_FLOOR:
        reasons.append(f"low value (mean brightness {p['mean_value']:.2f} < floor {VALUE_FLOOR}) — "
                        f"may read as muddy against the vibrancy bible (docs/design/art-direction-brief.md)")
    return reasons


def _iter_pngs(path, exclude=()):
    skip = SKIP_DIRS | set(exclude)
    if os.path.isfile(path):
        if path.lower().endswith(".png"):
            yield path
        return
    for dp, dns, fns in os.walk(path):
        dns[:] = [d for d in dns if d not in skip]
        for fn in fns:
            if fn.lower().endswith(".png"):
                yield os.path.join(dp, fn)


def cmd_scan(args):
    base = args.path if os.path.isdir(args.path) else os.path.dirname(args.path)
    scanned = 0
    flagged = []
    for p in _iter_pngs(args.path, args.exclude):
        try:
            reasons = warn_reasons(p)
        except Exception:
            continue
        scanned += 1
        if reasons:
            rel = os.path.relpath(p, base).replace("\\", "/")
            flagged.append((rel, reasons))
    print(f"scanned {scanned} PNGs under {args.path}")
    print(f"vibrancy warnings: {len(flagged)} (advisory only — never fails CI)")
    for rel, reasons in flagged[:50]:
        print(f"  [dull]  {rel}")
        for r in reasons:
            print(f"      {r}")
    if len(flagged) > 50:
        print(f"  ... and {len(flagged) - 50} more")
    if args.json:
        json.dump({"scanned": scanned, "flagged": [{"path": r, "reasons": rs} for r, rs in flagged]},
                   open(args.json, "w"), indent=1)
        print(f"manifest -> {args.json}")
    return 0  # advisory: never a CI failure


def main(argv=None):
    ap = argparse.ArgumentParser(description="Vibrancy-profile WARNING scan (advisory, non-gating)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("scan")
    s.add_argument("path")
    s.add_argument("--json")
    s.add_argument("--exclude", nargs="*", default=[])
    s.set_defaults(fn=cmd_scan)
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())

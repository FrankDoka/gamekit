"""tint_recolor — offline material-family recolor for Phase-3 base sheets.

Route ruling: palette = OFFLINE RECOLOR, never runtime tint for identity
(animation-economics.md §10; phase3-binding.md §3). This tool takes an accepted
bald-base sheet plus a material-family mask spec (color families, NOT hand-
painted regions) plus a target palette, and emits a recolored sheet whose
diff is CONFINED to the family masks. Any changed pixel outside the union of
family masks is "mask leakage" -> verdict FAIL, nonzero exit (recipe-15 style
diff-confinement proof).

Why family masks (not painted masks): the base is authored with cel palette
discipline (phase3-binding.md §3) so skin / cloth-tint families occupy distinct
cel swatch families with no shared mid-tones. That separability is exactly what
lets an offline recolor target `by color family`. This tool consumes the
per-sheet tint-mask note (family name -> source swatches) that ships with each
accepted package.

Recolor model (cel-safe, luminance-preserving):
  For a family, the source swatches define a reference base hue/sat. A pixel
  belongs to the family iff it lies within `tolerance` (RGB Euclid) of ANY of
  that family's source swatches. Belonging pixels are recolored by applying the
  family's HUE + SATURATION delta (source-swatch mean -> target hue) while
  PRESERVING per-pixel VALUE (shading). Cel shades of one family move together,
  keeping the shadow/highlight structure intact.

Determinism / idempotency: recolor is a pure function of (sheet, spec). It is
idempotent when target families do not re-enter any source family's tolerance
ball (the selftest asserts a byte-identical second pass).

Usage:
  python tools/asset-cleanup/tint_recolor.py --selftest
  python tools/asset-cleanup/tint_recolor.py recolor <sheet.png> \
      --spec <mask_spec.json> --out <recolored.png> [--verdict <verdict.json>]

Exit codes: 0 = OK (no leakage); 1 = mask leakage / stray pixels; 2 = bad args.

Mask spec JSON shape:
  {
    "families": {
      "skin":       {"source": ["#e8b98f", "#c98a63"], "target": "#d59a76", "tolerance": 28},
      "cloth_tint": {"source": ["#2f8f8a"],            "target": "#7a4fbf", "tolerance": 28}
    }
  }
`tolerance` is optional per-family (default 24). `source` swatches are the cel
family swatches from the accepted-package tint-mask note; `target` is the new
base hue for that family.
"""
from __future__ import annotations

import argparse
import colorsys
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image

DEFAULT_TOLERANCE = 24


def _hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.strip().lstrip("#")
    if len(h) != 6:
        raise ValueError(f"bad hex color {h!r} (expected 6 hex digits)")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _load_rgba(path: Path) -> np.ndarray:
    return np.array(Image.open(path).convert("RGBA"), dtype=np.uint8)


def _family_mask(rgb: np.ndarray, alpha: np.ndarray, swatches: list, tol: float) -> np.ndarray:
    """Boolean mask of visible pixels within `tol` RGB Euclid of ANY swatch."""
    mask = np.zeros(rgb.shape[:2], dtype=bool)
    visible = alpha > 0
    rgbf = rgb.astype(np.float32)
    tol2 = float(tol) * float(tol)
    for sw in swatches:
        sr, sg, sb = _hex_to_rgb(sw)
        d2 = (rgbf[:, :, 0] - sr) ** 2 + (rgbf[:, :, 1] - sg) ** 2 + (rgbf[:, :, 2] - sb) ** 2
        mask |= (d2 <= tol2) & visible
    return mask


def _swatch_mean_hsv(swatches: list) -> tuple[float, float, float]:
    hs, ss, vs = [], [], []
    for sw in swatches:
        r, g, b = _hex_to_rgb(sw)
        h, s, v = colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)
        hs.append(h)
        ss.append(s)
        vs.append(v)
    return float(np.mean(hs)), float(np.mean(ss)), float(np.mean(vs))


def _recolor_family(rgb: np.ndarray, mask: np.ndarray, src_swatches: list, target_hex: str) -> np.ndarray:
    """Return a new RGB array with `mask` pixels shifted to the target hue/sat,
    preserving each pixel's VALUE (shading). Non-mask pixels are untouched."""
    out = rgb.copy()
    if not mask.any():
        return out
    src_h, src_s, _ = _swatch_mean_hsv(src_swatches)
    tr, tg, tb = _hex_to_rgb(target_hex)
    tgt_h, tgt_s, _ = colorsys.rgb_to_hsv(tr / 255.0, tg / 255.0, tb / 255.0)
    dh = tgt_h - src_h
    # saturation delta as a ratio (guard div-by-zero for near-gray sources)
    s_ratio = (tgt_s / src_s) if src_s > 1e-6 else 1.0

    ys, xs = np.where(mask)
    px = rgb[ys, xs].astype(np.float32) / 255.0
    for i in range(px.shape[0]):
        h, s, v = colorsys.rgb_to_hsv(px[i, 0], px[i, 1], px[i, 2])
        nh = (h + dh) % 1.0
        ns = min(1.0, max(0.0, s * s_ratio))
        nr, ng, nb = colorsys.hsv_to_rgb(nh, ns, v)  # v preserved -> shading kept
        out[ys[i], xs[i]] = (
            round(nr * 255.0),
            round(ng * 255.0),
            round(nb * 255.0),
        )
    return out


def recolor(sheet_path: Path, spec: dict, out_path: Path | None) -> dict:
    """Recolor a sheet by family. Returns a verdict dict; also writes `out_path`
    if given. Mask leakage (changed px outside the family mask union) => FAIL."""
    arr = _load_rgba(sheet_path)
    rgb = arr[:, :, :3].copy()
    alpha = arr[:, :, 3]

    families = spec.get("families") or {}
    if not families:
        raise ValueError("spec has no 'families'")

    union_mask = np.zeros(rgb.shape[:2], dtype=bool)
    family_reports = {}
    out_rgb = rgb.copy()
    for name, fam in families.items():
        src = fam.get("source") or []
        target = fam.get("target")
        if not src or not target:
            raise ValueError(f"family {name!r} needs non-empty 'source' and a 'target'")
        tol = float(fam.get("tolerance", DEFAULT_TOLERANCE))
        mask = _family_mask(rgb, alpha, src, tol)
        union_mask |= mask
        out_rgb = _recolor_family(out_rgb, mask, src, target)
        family_reports[name] = {"pixels": int(mask.sum()), "tolerance": tol}

    # Diff-confinement proof: every pixel that changed must lie inside union_mask.
    changed = np.any(out_rgb != rgb, axis=2)
    stray = changed & ~union_mask
    stray_count = int(stray.sum())
    verdict = "OK" if stray_count == 0 else "MASK-LEAKAGE"

    out_arr = arr.copy()
    out_arr[:, :, :3] = out_rgb
    if out_path is not None and verdict == "OK":
        out_path.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(out_arr, "RGBA").save(out_path)

    return {
        "verdict": verdict,
        "sheet": str(sheet_path),
        "out": str(out_path) if out_path else None,
        "changed_pixels": int(changed.sum()),
        "mask_pixels": int(union_mask.sum()),
        "stray_pixels": stray_count,
        "families": family_reports,
        "_out_arr": out_arr,  # in-memory result for callers/selftest (not serialized)
    }


def _write_verdict(verdict: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    serializable = {k: v for k, v in verdict.items() if not k.startswith("_")}
    with path.open("w", encoding="utf-8") as fh:
        json.dump(serializable, fh, indent=2, sort_keys=True)


# --------------------------------------------------------------------------- #
# Selftest                                                                     #
# --------------------------------------------------------------------------- #

def _build_selftest_fixture(path: Path) -> dict:
    """Deterministic 32x32 cel fixture with two SEPARABLE families (a skin
    family and a cloth-tint family), each authored as a base cel + a shadow cel
    + a highlight cel (distinct values, one hue). A transparent gap and an
    unrelated 'metal' region (NOT in any family) sit between them to catch
    leakage. Written into the family-mask fixture dir."""
    size = 32
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = im.load()
    # skin family (warm tan): base / shadow / highlight cels — one hue, 3 values
    skin_cels = [(232, 185, 143, 255), (201, 138, 99, 255), (245, 214, 182, 255)]
    # cloth-tint family (teal): base / shadow / highlight cels
    cloth_cels = [(47, 143, 138, 255), (30, 96, 92, 255), (96, 190, 185, 255)]
    # unrelated 'metal' gray — must NEVER be recolored (proves confinement)
    metal = (128, 128, 130, 255)
    for y in range(size):
        for x in range(size):
            if 4 <= x < 12 and 4 <= y < 28:
                px[x, y] = skin_cels[(y - 4) // 8 % 3]
            elif 14 <= x < 18 and 4 <= y < 28:
                px[x, y] = metal
            elif 20 <= x < 28 and 4 <= y < 28:
                px[x, y] = cloth_cels[(y - 4) // 8 % 3]
            # else transparent
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path)
    # Targets are chosen HUE-FAR from every source family so recolored output
    # leaves all source tolerance balls -> the recolor is provably idempotent.
    # (A near-identity same-hue shift can keep bright cels inside the source
    # ball; that is a real property of color-family recolor, not a tool bug, so
    # the selftest exercises the disjoint-target case the idempotency guarantee
    # actually covers.)
    spec = {
        "families": {
            "skin": {
                "source": ["#e8b98f", "#c98a63", "#f5d6b6"],
                "target": "#3f8f4a",
                "tolerance": 20,
            },
            "cloth_tint": {
                "source": ["#2f8f8a", "#1e605c", "#60beb9"],
                "target": "#c94f2f",
                "tolerance": 20,
            },
        }
    }
    return spec


def selftest() -> int:
    here = Path(__file__).resolve().parent
    fix_dir = here / "_fixtures" / "tint-recolor"
    fixture = fix_dir / "cel_families_32.png"
    spec = _build_selftest_fixture(fixture)
    spec_path = fix_dir / "cel_families_32.spec.json"
    with spec_path.open("w", encoding="utf-8") as fh:
        json.dump(spec, fh, indent=2, sort_keys=True)

    failures = []

    v = recolor(fixture, spec, out_path=None)
    print(f"[selftest] pass1 verdict={v['verdict']} changed={v['changed_pixels']} "
          f"mask={v['mask_pixels']} stray={v['stray_pixels']}")

    # 1. stray-pixel count MUST be 0 (card gate: diff confined to family mask)
    if v["stray_pixels"] != 0:
        failures.append(f"stray pixels != 0 (got {v['stray_pixels']})")

    # 2. verdict OK
    if v["verdict"] != "OK":
        failures.append(f"verdict != OK (got {v['verdict']})")

    # 3. both families actually recolored something (spec targets real pixels)
    for fam in ("skin", "cloth_tint"):
        if v["families"][fam]["pixels"] <= 0:
            failures.append(f"family {fam} matched 0 pixels")

    # 4. the unrelated 'metal' region is UNTOUCHED (explicit confinement proof)
    src = _load_rgba(fixture)[:, :, :3]
    out = v["_out_arr"][:, :, :3]
    metal_changed = int(np.any(out[4:28, 14:18] != src[4:28, 14:18], axis=2).sum())
    if metal_changed != 0:
        failures.append(f"metal region changed {metal_changed}px (leakage)")

    # 5. per-pixel VALUE preserved within a family (shading kept, cel-safe)
    #    check the skin base cel row: HSV value must be unchanged after recolor
    import colorsys as _cs
    s0 = src[6, 6] / 255.0
    o0 = out[6, 6] / 255.0
    v_before = _cs.rgb_to_hsv(*s0)[2]
    v_after = _cs.rgb_to_hsv(*o0)[2]
    if abs(v_before - v_after) > 1.5 / 255.0:
        failures.append(f"value not preserved on skin cel ({v_before:.3f}->{v_after:.3f})")

    # 6. idempotency: recoloring the OUTPUT with the same spec changes nothing new
    out_fixture = fix_dir / "cel_families_32.recolored.png"
    out_fixture.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(v["_out_arr"], "RGBA").save(out_fixture)
    v2 = recolor(out_fixture, spec, out_path=None)
    if not np.array_equal(v["_out_arr"], v2["_out_arr"]):
        failures.append("not idempotent: second recolor pass changed pixels")
    print(f"[selftest] pass2 (idempotency) changed={v2['changed_pixels']} "
          f"identical={np.array_equal(v['_out_arr'], v2['_out_arr'])}")

    if failures:
        for f in failures:
            print(f"[selftest] FAIL: {f}", file=sys.stderr)
        print("[selftest] RESULT: FAIL", file=sys.stderr)
        return 1
    print("[selftest] RESULT: PASS (stray=0, confined, value-preserving, idempotent)")
    return 0


def main(argv: list | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = ap.add_subparsers(dest="command")
    ap.add_argument("--selftest", action="store_true", help="run the built-in fixture selftest")

    p_re = sub.add_parser("recolor", help="recolor a sheet by material family")
    p_re.add_argument("sheet", type=Path)
    p_re.add_argument("--spec", type=Path, required=True, help="mask-spec JSON")
    p_re.add_argument("--out", type=Path, default=None, help="output PNG (written only if OK)")
    p_re.add_argument("--verdict", type=Path, default=None, help="verdict JSON output path")

    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()

    if args.command == "recolor":
        with args.spec.open("r", encoding="utf-8") as fh:
            spec = json.load(fh)
        v = recolor(args.sheet, spec, args.out)
        if args.verdict:
            _write_verdict(v, args.verdict)
        printable = {k: v[k] for k in ("verdict", "changed_pixels", "mask_pixels", "stray_pixels")}
        print(json.dumps(printable))
        return 0 if v["verdict"] == "OK" else 1

    ap.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

"""Regression proof for tint_recolor — the Phase-3 offline material-family
recolor tool (card-p3-tint-recolor-tool).

Covers the tool's contract AND its failure modes:
  - selftest() returns 0 (stray=0, confined, value-preserving, idempotent)
  - a legitimate recolor confines its diff to the family mask (stray=0, OK)
  - MASK LEAKAGE is detected and returns a nonzero exit: when a recolor is
    forced to change a pixel outside the family mask, the verdict is
    MASK-LEAKAGE and the CLI exits 1 (recipe-15 style fail-closed proof)
  - bad args (missing source/target) raise; recolor without a spec exits 2

  python tools/asset-cleanup/test_tint_recolor.py

Exit 0 = every mode behaved as specified; nonzero = a regression. Verdicts and
outputs are written to a temp dir — this test never dirties the repo.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import tint_recolor as tr  # noqa: E402


def _fail(msg: str) -> None:
    print(f"[test_tint_recolor] FAIL: {msg}", file=sys.stderr)


def test_selftest_passes() -> bool:
    code = tr.selftest()
    if code != 0:
        _fail(f"selftest returned {code}, expected 0")
        return False
    return True


def test_confinement_ok(tmp: str) -> bool:
    # two-family fixture, hue-far targets -> clean confinement
    fixture = os.path.join(tmp, "clean.png")
    spec = tr._build_selftest_fixture  # reuse the deterministic fixture builder
    s = spec(__import__("pathlib").Path(fixture))
    v = tr.recolor(__import__("pathlib").Path(fixture), s, out_path=None)
    ok = v["verdict"] == "OK" and v["stray_pixels"] == 0 and v["changed_pixels"] > 0
    if not ok:
        _fail(f"expected OK/stray=0/changed>0, got {v['verdict']}/"
              f"{v['stray_pixels']}/{v['changed_pixels']}")
    return ok


def test_mask_leakage_detected(tmp: str) -> bool:
    """Force leakage: a family whose SOURCE swatch matches nothing, but we also
    hand-craft an image where recolor would change an out-of-mask pixel. We
    simulate leakage by monkeypatching _recolor_family to also touch a pixel
    outside the mask, then assert the confinement check catches it and the CLI
    exits nonzero."""
    from pathlib import Path

    fixture = Path(os.path.join(tmp, "leak.png"))
    spec = tr._build_selftest_fixture(fixture)

    orig = tr._recolor_family

    def leaky(rgb, mask, src, target):
        out = orig(rgb, mask, src, target)
        out[0, 0] = (255, 0, 0)  # change a pixel guaranteed OUTSIDE any family mask
        return out

    tr._recolor_family = leaky
    try:
        v = tr.recolor(fixture, spec, out_path=None)
    finally:
        tr._recolor_family = orig

    caught = v["verdict"] == "MASK-LEAKAGE" and v["stray_pixels"] >= 1
    if not caught:
        _fail(f"leakage NOT caught: verdict={v['verdict']} stray={v['stray_pixels']}")
        return False

    # and the CLI must exit nonzero on leakage
    tr._recolor_family = leaky
    spec_path = os.path.join(tmp, "leak.spec.json")
    with open(spec_path, "w", encoding="utf-8") as fh:
        json.dump(spec, fh)
    try:
        code = tr.main(["recolor", str(fixture), "--spec", spec_path,
                        "--verdict", os.path.join(tmp, "leak.verdict.json")])
    finally:
        tr._recolor_family = orig
    if code != 1:
        _fail(f"CLI exit on leakage was {code}, expected 1")
        return False
    return True


def test_bad_spec_rejected(tmp: str) -> bool:
    from pathlib import Path
    fixture = Path(os.path.join(tmp, "bad.png"))
    tr._build_selftest_fixture(fixture)
    ok = True
    # missing target
    try:
        tr.recolor(fixture, {"families": {"skin": {"source": ["#e8b98f"]}}}, None)
        _fail("missing 'target' did not raise")
        ok = False
    except ValueError:
        pass
    # empty families
    try:
        tr.recolor(fixture, {"families": {}}, None)
        _fail("empty families did not raise")
        ok = False
    except ValueError:
        pass
    # recolor CLI without --spec -> argparse error (SystemExit), not exit 0.
    # argparse prints a usage line to stderr on error; swallow it so this
    # expected negative path stays quiet inside the `pnpm validate` gate.
    import contextlib
    import io
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            tr.main(["recolor", str(fixture)])
        _fail("recolor without --spec did not error")
        ok = False
    except SystemExit as e:
        if e.code == 0:
            _fail("recolor without --spec exited 0")
            ok = False
    return ok


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        results = {
            "selftest_passes": test_selftest_passes(),
            "confinement_ok": test_confinement_ok(tmp),
            "mask_leakage_detected": test_mask_leakage_detected(tmp),
            "bad_spec_rejected": test_bad_spec_rejected(tmp),
        }
    for name, ok in results.items():
        print(f"[test_tint_recolor] {name}: {'PASS' if ok else 'FAIL'}")
    if all(results.values()):
        print("[test_tint_recolor] RESULT: PASS")
        return 0
    print("[test_tint_recolor] RESULT: FAIL", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

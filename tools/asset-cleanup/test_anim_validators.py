"""Regression proof for the animation validators (card-anim-validators, 2026-07-07).

Drives fixtures/manifest.json: every named FAIL mode must fire on its named
fixture (the REAL reverted B4/B2 garbage sheets, byte-identical from git
history) and every live positive must PASS - motion-arc, identity-palette
(internal + canon where paired), plus the anim_panel generator and the
explicit-cell trap (wrong --cell on a real sheet must fail divisibility,
never silently mis-split).

  python tools/asset-cleanup/test_anim_validators.py

Wired into `pnpm validate` as assets:anim-fixtures. Exit 0 = every fixture
behaved as specified; non-zero = a validator regression. Verdicts are written
to a temp dir - this test never dirties the repo.

Known-limitation fixtures (b4 death/hurt) are asserted to PASS both metrics:
that is the documented boundary (geometric incoherence is owned by the panel
+ eyes-on layer - see the recipes.py ANIMATION-VALIDATOR DOCTRINE block). If
one ever starts FAILING here, a metric got sharper; move it to a real
negative expectation deliberately, do not silence the test.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))
FIXTURES_DIR = os.path.join(HERE, "fixtures")

sys.path.insert(0, HERE)
import anim_panel  # noqa: E402
import fringe  # noqa: E402
import recipes  # noqa: E402


def run_recipe(argv, verdict_path):
    code = recipes.main(argv)
    with open(verdict_path, "r", encoding="utf-8") as fh:
        verdict = json.load(fh)
    return code, verdict


def failing_checks(verdict):
    return {c["name"] for c in verdict["checks"] if c["status"] == "FAIL"}


def assert_expectation(failures, label, code, verdict, expect):
    """expect: 'PASS' or 'FAIL:<check-name>'."""
    if expect == "PASS":
        if code != 0 or verdict["result"] != "PASS":
            failures.append(f"{label}: expected PASS, got exit={code} result={verdict['result']} "
                            f"failing={sorted(failing_checks(verdict))}")
    else:
        want = expect.split(":", 1)[1]
        if code == 0 or verdict["result"] != "FAIL":
            failures.append(f"{label}: expected FAIL:{want}, got exit={code} result={verdict['result']}")
        elif want not in failing_checks(verdict):
            failures.append(f"{label}: expected the named reason '{want}' to FAIL, "
                            f"got failing={sorted(failing_checks(verdict))}")


def sheet_missing_skip(sheet, fid, label, failures):
    """Handle a missing fixture. A fixture bundled with the toolkit (under fixtures/) that is
    missing is a real regression -> failure. A fixture that resolves into the game tree
    (client/public/assets, ...) is an absent game asset -> skip: a tools-only template has no
    game sprites, and a wired game re-activates the check. Returns True to `continue`."""
    if os.path.exists(sheet):
        return False
    if os.path.abspath(sheet).startswith(os.path.abspath(FIXTURES_DIR) + os.sep):
        failures.append(f"{fid}{label}: fixture sheet missing: {sheet}")
    else:
        print(f"[anim-validators] skip {fid}{label}: game asset absent ({sheet})")
    return True


def main():
    failures = []
    with open(os.path.join(FIXTURES_DIR, "manifest.json"), "r", encoding="utf-8") as fh:
        manifest = json.load(fh)

    with tempfile.TemporaryDirectory(prefix="gamekit-anim-validators-") as tmp:
        for fx in manifest["fixtures"]:
            fid = fx["id"]
            sheet = os.path.normpath(os.path.join(FIXTURES_DIR, fx["file"]))
            if sheet_missing_skip(sheet, fid, "", failures):
                continue
            cell = str(fx["cell"])

            argv = ["recipes.py", "motion-arc", sheet, "--cell", cell,
                    "--json", os.path.join(tmp, f"{fid}.motion-arc.json")]
            if fx.get("loop"):
                argv.insert(5, "--loop")
            code, verdict = run_recipe(argv, argv[-1])
            assert_expectation(failures, f"{fid} motion-arc", code, verdict, fx["expect"]["motionArc"])

            argv = ["recipes.py", "identity-palette", sheet, "--cell", cell,
                    "--json", os.path.join(tmp, f"{fid}.identity.json")]
            code, verdict = run_recipe(argv, argv[-1])
            assert_expectation(failures, f"{fid} identity-palette", code, verdict,
                               fx["expect"]["identityPalette"])

            if fx.get("canon"):
                canon = os.path.normpath(os.path.join(REPO_ROOT, fx["canon"]))
                if not os.path.exists(canon):
                    print(f"[anim-validators] skip {fid} identity-palette --canon: game canon absent ({canon})")
                else:
                    argv = ["recipes.py", "identity-palette", sheet, "--cell", cell,
                            "--canon", canon, "--canon-cell", str(fx["canonCell"]),
                            "--json", os.path.join(tmp, f"{fid}.identity-canon.json")]
                    code, verdict = run_recipe(argv, argv[-1])
                    assert_expectation(failures, f"{fid} identity-palette --canon", code, verdict,
                                       fx["expectCanon"])

        # Opaque-ring foreign-hue gate (card-anim-opaque-ring-wiring): the defective
        # video-keyed swing must fire RED; the dark-plum cel outline (B1 idle) and the
        # legitimately-PINK blossom slime (the naive-count false-positive trap) must pass
        # GREEN. Stills (cell=null) score whole-image; sheets pass their measured cell.
        for fx in manifest.get("opaqueRingFixtures", []):
            fid = fx["id"]
            sheet = os.path.normpath(os.path.join(FIXTURES_DIR, fx["file"]))
            if sheet_missing_skip(sheet, fid, " opaque-ring", failures):
                continue
            stats = fringe.opaque_magenta_ring(sheet, cell=fx.get("cell"))
            got = "FAIL" if stats["fail"] else "PASS"
            if got != fx["expectOpaqueRing"]:
                failures.append(f"{fid} opaque-ring: expected {fx['expectOpaqueRing']}, got {got} "
                                f"(max {stats['max']}/frame, threshold {stats['threshold']}, "
                                f"counts {stats['counts']})")

        # Lower-body green/teal video-key residue gate: dirty cast must fire RED; accepted
        # swing and B1 idle lower-body bands must stay GREEN. Full silhouette is diagnostic
        # only because teal costume/scarf pixels are legitimate.
        for fx in manifest.get("greenTealSpeckleFixtures", []):
            fid = fx["id"]
            sheet = os.path.normpath(os.path.join(FIXTURES_DIR, fx["file"]))
            if sheet_missing_skip(sheet, fid, " green-teal-speckle", failures):
                continue
            stats = fringe.green_teal_speckle(
                sheet,
                cell=fx.get("cell"),
                threshold=fx.get("threshold", 6),
                region=fx.get("region", "foot-band"),
            )
            got = "FAIL" if stats["fail"] else "PASS"
            if got != fx["expectGreenTealSpeckle"]:
                failures.append(f"{fid} green-teal-speckle: expected {fx['expectGreenTealSpeckle']}, got {got} "
                                f"(region {stats['region']}, max {stats['max']}/frame, "
                                f"threshold {stats['threshold']}, counts {stats['counts']})")

        # Silhouette colour-parity gate: the palette-quantized+dithered cast sheet must fire
        # RED (whole-silhouette HSV value collapsed below the floor); accepted B1 idle and swing
        # must stay GREEN. Floors are static, so a legitimately dim generation is not false-failed.
        for fx in manifest.get("colorParityFixtures", []):
            fid = fx["id"]
            sheet = os.path.normpath(os.path.join(FIXTURES_DIR, fx["file"]))
            if sheet_missing_skip(sheet, fid, " color-parity", failures):
                continue
            stats = fringe.color_parity(sheet)
            got = "FAIL" if stats["fail"] else "PASS"
            if got != fx["expectColorParity"]:
                failures.append(f"{fid} color-parity: expected {fx['expectColorParity']}, got {got} "
                                f"(sat {stats['satMean']}/{stats['satFloor']}, val {stats['valMean']}/{stats['valFloor']})")

        # Dither-noise gate: the dithered cast sheet must fire RED (sheet-median 2D luminance
        # oscillation over the floor); accepted swing (one sword-sweep frame spikes but median
        # stays clean) and B1 idle must stay GREEN. Sheets pass their measured cell.
        for fx in manifest.get("ditherNoiseFixtures", []):
            fid = fx["id"]
            sheet = os.path.normpath(os.path.join(FIXTURES_DIR, fx["file"]))
            if sheet_missing_skip(sheet, fid, " dither-noise", failures):
                continue
            stats = fringe.dither_noise(sheet, cell=fx.get("cell"))
            got = "FAIL" if stats["fail"] else "PASS"
            if got != fx["expectDitherNoise"]:
                failures.append(f"{fid} dither-noise: expected {fx['expectDitherNoise']}, got {got} "
                                f"(median {stats['median']}, max {stats['max']}, threshold {stats['threshold']})")

        # Explicit-cell trap: the live attack sheet is 4224x320 (11 x 384). Feeding the
        # habitual 256 must FAIL divisibility loudly - this is the exact mis-split class
        # (4x384 vs 6x256 on a 1536px sheet) that fooled the integrator.
        # These validate against a game's real player sprites. In a tools-only template those
        # assets are absent, so skip them; a wired game with client/public/assets re-activates them.
        attack = os.path.join(REPO_ROOT, "client/public/assets/sprites/player_blackhair_cel_attack_east_384x320.webp")
        gather = os.path.join(REPO_ROOT, "client/public/assets/sprites/player_blackhair_cel_gather_east_256.png")
        if not (os.path.exists(attack) and os.path.exists(gather)):
            print("[anim-validators] skipping live-sprite motion-arc/panel traps — game sprites absent (tools-only template)")
        else:
            code, verdict = run_recipe(
                ["recipes.py", "motion-arc", attack, "--cell", "256",
                 "--json", os.path.join(tmp, "wrong-cell.json")],
                os.path.join(tmp, "wrong-cell.json"))
            assert_expectation(failures, "attack wrong --cell 256", code, verdict,
                               "FAIL:sheet_width_divisible_by_cell")

            # Panel generator: correct geometry, and the same wrong-cell trap refuses.
            panel_out = os.path.join(tmp, "gather.panel.png")
            code = anim_panel.main(["anim_panel.py", gather, "--cell", "256", "--out", panel_out])
            if code != 0 or not os.path.exists(panel_out):
                failures.append(f"anim_panel gather: expected exit 0 + panel file, got exit={code}")
            else:
                from PIL import Image
                w, h = Image.open(panel_out).size
                want_w = 8 * 256 * 2 + 9 * anim_panel.GAP
                # dual-row (dark + light backing): HEADER + 2 rows + 3 gaps
                want_h = anim_panel.HEADER + 2 * (256 * 2) + 3 * anim_panel.GAP
                if (w, h) != (want_w, want_h):
                    failures.append(f"anim_panel gather: panel {w}x{h}, expected {want_w}x{want_h}")
            code = anim_panel.main(["anim_panel.py", attack, "--cell", "256", "--out",
                                    os.path.join(tmp, "bad.panel.png")])
            if code == 0:
                failures.append("anim_panel wrong --cell 256 on 4224px sheet: expected non-zero exit")

    if failures:
        print("FAIL: animation-validator fixture regression")
        for f in failures:
            print(f"  - {f}")
        return 1
    n = len(manifest["fixtures"])
    nr = len(manifest.get("opaqueRingFixtures", []))
    ng = len(manifest.get("greenTealSpeckleFixtures", []))
    ncp = len(manifest.get("colorParityFixtures", []))
    ndn = len(manifest.get("ditherNoiseFixtures", []))
    print(f"OK: all {n} manifest fixtures + {nr} opaque-ring + {ng} green-teal + {ncp} color-parity "
          f"+ {ndn} dither-noise fixtures + cell-trap + panel geometry behaved as specified")
    return 0


if __name__ == "__main__":
    sys.exit(main())

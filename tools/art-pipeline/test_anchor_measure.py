"""Regression suite for the hand-anchor heuristic (card-anchor-hand-heuristic-fix).

Run standalone (repo has no pytest on the pinned 3.11): `python
tools/art-pipeline/test_anchor_measure.py` -> exits 0 GREEN / 1 RED. Wired into
`pnpm validate` as `anchors:fixtures`.

Four locks, each cited to committed fixtures in tools/art-pipeline/fixtures/:

  1. SWING truth table (GREEN): the fixed glove-blob-extremity heuristic lands
     within +-4px of the eyes-on-verified leading-fist knuckle on all 11
     swing_1h frames. Truth table = swing_1h_truth_table.json (each point
     eyes-on-verified on the leading fist glove at max zoom, s22).
  2. HIP-LATCH regression (RED fixture): the OLD (v1) sidecar hip-latched --
     handX clustered in an ~11px column (213.85..224.67) while the true fist
     sweeps to x~275 at strike. Assert the NEW output DIFFERS from that stale
     cluster on the strike frame (>= 40px) so the defect can never silently
     return. Fixture = swing_1h_hiplatch_v1.anchors.json.
  3. B1 idle null-hands: the bald-base idle has no weapon hand; `--hand-mode
     none` must yield null hand anchors on every frame (the declared contract
     for hand-less motions is preserved).
  4. GATHER stability (+-2px): the v2 tool's gather output is locked to the
     eyes-on-verified leading-hand baseline (gather_v2_baseline.anchors.json).
     NOTE: the previously-accepted v1 gather sidecar sat on the TRAILING wrist
     (pixel-proven off the leading hand, s22); v2 is anatomically more correct,
     so the baseline was re-cut to v2 and this lock guards v2 stability, not
     agreement with the superseded v1 output. See the closeout note.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "tools" / "art-pipeline" / "anchor_measure.py"
FIXTURES = Path(__file__).resolve().parent / "fixtures"

# Self-contained bald-base calibration copies (the player_baldbase source tree was
# removed with the backburnered animation program, card-baldbase-removal; these two
# sheets are kept verbatim as anchor-gate calibration fixtures).
SWING_SHEET = ROOT / "tools/asset-cleanup/fixtures/positives-baldbase/player_baldbase_swing_1h.clean.png"
GATHER_SHEET = ROOT / "client/public/assets/sprites/player_blackhair_cel_gather_east_256.png"
IDLE_SHEET = ROOT / "tools/asset-cleanup/fixtures/positives-baldbase/player_baldbase_idle_east_256.clean.png"

SWING_TRUTH_TOL = 4.0
GATHER_TOL = 2.0
HIP_LATCH_MIN_STRIKE_DELTA = 40.0


def _measure(sheet: Path, frames: int, hand_mode: str) -> list[dict]:
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "sidecar.json"
        panel = Path(tmp) / "panel.png"
        result = subprocess.run(
            [
                sys.executable,
                str(TOOL),
                str(sheet),
                "--frames",
                str(frames),
                "--hand-mode",
                hand_mode,
                "--output",
                str(out),
                "--panel",
                str(panel),
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise RuntimeError(f"anchor_measure failed on {sheet.name}: {result.stderr or result.stdout}")
        return json.loads(out.read_text(encoding="utf8"))["frames"]


def _load(name: str) -> list[dict]:
    return json.loads((FIXTURES / name).read_text(encoding="utf8"))["frames"]


def check_swing_truth_table(failures: list[str]) -> None:
    truth = _load("swing_1h_truth_table.json")
    measured = _measure(SWING_SHEET, 11, "required")
    for t, m in zip(truth, measured):
        if m["handX"] is None or m["handY"] is None:
            failures.append(f"swing f{t['index']}: hand unresolved (expected leading fist)")
            continue
        dx = abs(m["handX"] - t["handX"])
        dy = abs(m["handY"] - t["handY"])
        if dx > SWING_TRUTH_TOL or dy > SWING_TRUTH_TOL:
            failures.append(
                f"swing f{t['index']}: measured ({m['handX']},{m['handY']}) is "
                f"({dx:.1f},{dy:.1f})px from truth ({t['handX']},{t['handY']}) > {SWING_TRUTH_TOL}px"
            )


def check_hip_latch_regression(failures: list[str]) -> None:
    stale = {f["index"]: f for f in _load("swing_1h_hiplatch_v1.anchors.json")}
    measured = {f["index"]: f for f in _measure(SWING_SHEET, 11, "required")}
    # The strike frame (f6) is where the hip-latch was most wrong: v1 sat at
    # x~216 while the real leading fist reaches x~275.
    old = stale[6]
    new = measured[6]
    delta = abs(new["handX"] - old["handX"])
    if delta < HIP_LATCH_MIN_STRIKE_DELTA:
        failures.append(
            f"hip-latch regression: strike-frame handX only moved {delta:.1f}px "
            f"from the stale v1 cluster (old {old['handX']} -> new {new['handX']}); "
            f"the hip-latch may have returned (need >= {HIP_LATCH_MIN_STRIKE_DELTA}px)"
        )
    # And the new strike fist must actually reach forward (east of center 192).
    if new["handX"] < 260:
        failures.append(
            f"hip-latch regression: strike-frame handX {new['handX']} does not reach "
            f"the true forward fist (expected >= 260, sheet center 192)"
        )


def check_idle_null_hands(failures: list[str]) -> None:
    measured = _measure(IDLE_SHEET, 8, "none")
    for f in measured:
        if f["handX"] is not None or f["handY"] is not None:
            failures.append(
                f"idle f{f['index']}: hand should be null for a hand-less motion, got "
                f"({f['handX']},{f['handY']})"
            )


def check_gather_stability(failures: list[str]) -> None:
    # Validates against a game's real gather sheet. Absent in a tools-only template -> skip;
    # a wired game with client/public/assets re-activates the check.
    if not GATHER_SHEET.exists():
        print(f"[anchor-measure] skip check_gather_stability: game asset absent ({GATHER_SHEET})")
        return
    baseline = _load("gather_v2_baseline.anchors.json")
    measured = _measure(GATHER_SHEET, 8, "required")
    for b, m in zip(baseline, measured):
        if m["handX"] is None or m["handY"] is None:
            failures.append(f"gather f{b['index']}: hand unresolved (expected leading hand)")
            continue
        dx = abs(m["handX"] - b["handX"])
        dy = abs(m["handY"] - b["handY"])
        if dx > GATHER_TOL or dy > GATHER_TOL:
            failures.append(
                f"gather f{b['index']}: measured ({m['handX']},{m['handY']}) drifted "
                f"({dx:.1f},{dy:.1f})px from baseline ({b['handX']},{b['handY']}) > {GATHER_TOL}px"
            )


def main() -> int:
    failures: list[str] = []
    for check in (
        check_swing_truth_table,
        check_hip_latch_regression,
        check_idle_null_hands,
        check_gather_stability,
    ):
        try:
            check(failures)
        except Exception as exc:  # noqa: BLE001 - surface any setup failure as RED
            failures.append(f"{check.__name__}: {exc}")

    if failures:
        print("FAIL: anchor-measure hand-heuristic regression")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("OK: swing truth table +-4px, hip-latch RED regression, idle null hands, gather +-2px")
    return 0


if __name__ == "__main__":
    sys.exit(main())

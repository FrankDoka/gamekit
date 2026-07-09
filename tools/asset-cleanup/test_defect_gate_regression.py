"""Regression proof for the R0 defect-gate hardening (2026-07-02 charter, item 4).

Proves the known-bad fixtures in _fixtures/known-bad/ (see make_fixtures.py) CANNOT enter a
bank via the real accept path — not just that the low-level detector functions classify them
correctly, but that POSTing an accept decision against a live, scratch (throwaway) instance of
the Node Asset Bank server refuses them, exactly as a real reviewer session would hit it.

  python test_defect_gate_regression.py

Exit 0 = every fixture behaved as specified; non-zero = a regression. Spins up a real server
subprocess bound to a temp --assets-root/--metadata-root (never touches Z:/Assets), and tears
it down on exit either way.

Scope note: this proves the Node bank server's /api/review accept gate and the shared
fringe.py/vibrancy.py detectors it and `pnpm assets:check` both call. The DevKit
:8787 editor-promote route (tools/src/devkit.ts handlePromoteAsset) was the confirmed hole
this charter closes; its gate shells out to the exact same `fringe.py check <file>` CLI
command exercised here (checkAssetDefectGate in devkit.ts), so this test transitively covers
its command contract. It does not spin up a live :8787 Node server — no existing test harness
covers tools/src/devkit.ts today, and standing one up is out of scope for this regression
proof (flagged in the R0 closeout as a follow-up, not silently skipped).
"""
from __future__ import annotations
import json
import os
import shutil
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))
FIXTURES_DIR = os.path.join(HERE, "_fixtures", "known-bad")
SERVER_SCRIPT = os.path.join(REPO_ROOT, "tools", "src", "asset-bank-server.ts")
TSX_CLI = os.path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs")

FIXTURES = {
    # filename -> (bank subdir, expect_accept, expect_vibrancy_warning)
    "purple_rim.png": ("props", False, False),
    "crop_artifact.png": ("props", False, False),
    "dull_gray_tile.png": ("environments", True, True),
}


def _get(url):
    with urllib.request.urlopen(url, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _post(url, payload):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8"))


def _norm(path):
    return os.path.normcase(os.path.abspath(path))


def main():
    failures = []
    tmp = tempfile.mkdtemp(prefix="gamekit-scratch-bank-")
    assets_root = os.path.join(tmp, "Assets")
    metadata_root = os.path.join(tmp, "Assets-metadata")
    os.makedirs(assets_root, exist_ok=True)
    for fname, (subdir, _, _) in FIXTURES.items():
        dest_dir = os.path.join(assets_root, subdir)
        os.makedirs(dest_dir, exist_ok=True)
        shutil.copy2(os.path.join(FIXTURES_DIR, fname), os.path.join(dest_dir, fname))

    node = shutil.which("node") or shutil.which("node.exe")
    if not node:
        failures.append("node not found on PATH")
        return 1
    if not os.path.exists(TSX_CLI):
        failures.append(f"tsx CLI not installed at {TSX_CLI}; run pnpm install")
        return 1
    proc = subprocess.Popen(
        [node, TSX_CLI, SERVER_SCRIPT, "0", "--assets-root", assets_root, "--metadata-root", metadata_root],
        cwd=REPO_ROOT,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    base = None
    startup_log = []
    try:
        for _ in range(100):
            line = proc.stdout.readline() if proc.stdout else ""
            if line:
                startup_log.append(line.rstrip())
                match = re.search(r"Node Asset Bank: http://127\.0\.0\.1:(\d+)/", line)
                if match:
                    base = f"http://127.0.0.1:{match.group(1)}"
                    break
            if proc.poll() is not None:
                break
            time.sleep(0.1)
        if not base:
            failures.append(f"server did not report an assigned scratch port; output: {startup_log}")
            raise SystemExit(1)

        # Wait for health and prove this is the scratch instance, not a stray bank.
        for _ in range(50):
            try:
                health = _get(f"{base}/api/health")
                if _norm(str(health.get("root", ""))) != _norm(assets_root):
                    failures.append(f"scratch server identity mismatch: expected root {assets_root}, got {health}")
                    raise SystemExit(1)
                break
            except SystemExit:
                raise
            except Exception:
                time.sleep(0.2)
        else:
            failures.append(f"server never became healthy at {base}; output: {startup_log}")
            raise SystemExit(1)

        rescan = _post(f"{base}/api/catalog/rescan", {})[1]
        if not rescan.get("ok") or rescan.get("total", 0) < len(FIXTURES):
            failures.append(f"rescan did not pick up fixtures: {rescan}")

        data = _get(f"{base}/api/data")
        by_name = {}
        for a in data.get("assets", []):
            for fname in FIXTURES:
                if a.get("path", "").replace("\\", "/").endswith(fname):
                    by_name[fname] = a

        for fname, (subdir, expect_accept, expect_warning) in FIXTURES.items():
            asset = by_name.get(fname)
            if not asset:
                failures.append(f"{fname}: not found in rescanned catalog")
                continue
            status, resp = _post(f"{base}/api/review", {"id": asset["id"], "decision": "accepted", "notes": "regression fixture"})
            accepted = bool(resp.get("ok"))
            if accepted != expect_accept:
                failures.append(f"{fname}: expected accept={expect_accept}, got ok={accepted} (status {status}, resp {resp})")
                continue
            if expect_accept:
                warned = bool(resp.get("vibrancyWarnings"))
                if warned != expect_warning:
                    failures.append(f"{fname}: expected vibrancyWarnings={expect_warning}, got {resp.get('vibrancyWarnings')}")
            else:
                if not resp.get("fringe"):
                    failures.append(f"{fname}: refused but not flagged fringe=true ({resp})")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)

    if failures:
        print("FAIL: known-bad fixture regression")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"OK: all {len(FIXTURES)} known-bad fixtures behaved as specified against a live scratch bank")
    return 0


if __name__ == "__main__":
    sys.exit(main())

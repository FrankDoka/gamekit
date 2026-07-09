from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[2]
REFINISH = ROOT / "tools" / "art-pipeline" / "cel-refinish.py"


def _p95_h(rgba: np.ndarray) -> float:
    r, g, b, a = (rgba[:, :, i].astype(np.float64) for i in range(4))
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    grad = np.abs(np.diff(lum, axis=1))
    mask = a[:, 1:] > 64
    v = grad[mask]
    return float(np.percentile(v, 95)) if v.size else 0.0


def _make_soft_sheet(path: Path, cell: int, frames: int) -> None:
    sheet = Image.new("RGBA", (cell * frames, cell), (0, 0, 0, 0))
    for index in range(frames):
        frame = Image.new("RGBA", (cell, cell), (0, 0, 0, 0))
        draw = ImageDraw.Draw(frame)
        # a mid-contrast figure with fine internal detail, then blur the COLOR soft
        # while keeping the alpha silhouette crisp (mimics a video-native finish).
        draw.rectangle((cell // 3, cell // 5, 2 * cell // 3, 4 * cell // 5), fill=(160, 130, 95, 255))
        for y in range(cell // 5 + 3, 4 * cell // 5, 6):
            draw.rectangle((cell // 3, y, 2 * cell // 3, y + 2), fill=(60, 45, 30, 255))
        for x in range(cell // 3 + 3, 2 * cell // 3, 6):
            draw.rectangle((x, cell // 5, x + 2, 4 * cell // 5), fill=(220, 200, 160, 255))
        orig_alpha = np.asarray(frame)[:, :, 3]
        blurred = frame.filter(ImageFilter.GaussianBlur(0.9))
        arr = np.asarray(blurred).copy()
        arr[:, :, 3] = orig_alpha
        arr[orig_alpha == 0, :3] = 0
        sheet.alpha_composite(Image.fromarray(arr, "RGBA"), (index * cell, 0))
    sheet.save(path)


def test_cel_refinish_raises_sharpness_zero_halo_and_preserves_alpha() -> None:
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        cell = 96
        frames = 4
        src = tmp / "soft.clean.png"
        _make_soft_sheet(src, cell, frames)

        out_sheet = tmp / "refined.clean.png"
        report = tmp / "report.json"
        result = subprocess.run(
            [
                sys.executable,
                str(REFINISH),
                "--sheet",
                str(src),
                "--cell",
                str(cell),
                "--out-sheet",
                str(out_sheet),
                "--report",
                str(report),
            ],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        assert result.returncode == 0, result.stdout

        src_arr = np.asarray(Image.open(src).convert("RGBA"))
        out_arr = np.asarray(Image.open(out_sheet).convert("RGBA"))

        # 1. sharpness rose
        assert _p95_h(out_arr) > _p95_h(src_arr)

        # 2. alpha byte-identical (0px anchor drift guarantee)
        src_hard = np.where(src_arr[:, :, 3] >= 128, 255, 0).astype(np.uint8)
        assert np.array_equal(out_arr[:, :, 3], src_hard)

        # 3. no opaque pixel outside the source alpha +1px (halo == 0)
        report_data = json.loads(report.read_text(encoding="utf8"))
        assert report_data["summary"]["maxHaloPixels"] == 0
        for frame in report_data["perFrame"]:
            assert frame["p95After"] >= frame["p95Before"]


def test_cel_refinish_amount_env_override() -> None:
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        cell = 96
        src = tmp / "soft.clean.png"
        _make_soft_sheet(src, cell, 2)
        out_sheet = tmp / "refined.clean.png"
        report = tmp / "report.json"
        import os

        result = subprocess.run(
            [
                sys.executable,
                str(REFINISH),
                "--sheet",
                str(src),
                "--cell",
                str(cell),
                "--out-sheet",
                str(out_sheet),
                "--amount",
                "0.7",
                "--report",
                str(report),
            ],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
            env={**os.environ, "CEL_REFINISH_AMOUNT": "0.2"},
        )
        assert result.returncode == 0, result.stdout
        report_data = json.loads(report.read_text(encoding="utf8"))
        assert report_data["params"]["amount"] == 0.2
        assert report_data["amountEnvOverride"] == "0.2"


if __name__ == "__main__":
    test_cel_refinish_raises_sharpness_zero_halo_and_preserves_alpha()
    test_cel_refinish_amount_env_override()
    print("[test_cel_refinish] PASS")

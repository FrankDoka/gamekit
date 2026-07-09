from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[2]
FRAMES_QA = ROOT / "tools" / "art-pipeline" / "frames-qa.py"


def draw_blob(
    path: Path,
    *,
    y_offset: int = 0,
    scale: float = 1.0,
    color: tuple[int, int, int] = (80, 180, 25),
    mark: int = 0,
) -> None:
    img = Image.new("RGBA", (96, 96), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    w = round(46 * scale)
    h = round(34 * scale)
    x0 = 48 - w // 2
    y1 = 74 + y_offset
    draw.ellipse((x0, y1 - h, x0 + w, y1), fill=(*color, 255), outline=(20, 40, 10, 255), width=3)
    if mark == 1:
        draw.rectangle((x0 + 4, y1 - h + 8, x0 + 24, y1 - h + 28), fill=(230, 250, 80, 255))
    elif mark == 2:
        draw.rectangle((x0 + w - 24, y1 - h + 9, x0 + w - 4, y1 - h + 29), fill=(230, 250, 80, 255))
    img.save(path)


def split_sheet(sheet: Path, frames: Path, frame_width: int, frame_height: int) -> None:
    frames.mkdir(parents=True, exist_ok=True)
    for existing in frames.glob("*.png"):
        existing.unlink()
    img = Image.open(sheet).convert("RGBA")
    for index in range(img.width // frame_width):
        img.crop((index * frame_width, 0, (index + 1) * frame_width, frame_height)).save(frames / f"f{index:02d}.png")


def run_gate(
    frames: Path,
    master: Path,
    out: Path,
    *,
    expected_count: int = 3,
    extra_args: list[str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(FRAMES_QA),
            "--frames",
            str(frames),
            "--master",
            str(master),
            "--expected-count",
            str(expected_count),
            "--out",
            str(out),
            "--palette-threshold",
            "1.2",
        ]
        + (extra_args or []),
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def test_frames_qa_accepts_stable_frames_and_rejects_broken_set() -> None:
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        master = tmp / "master.png"
        good = tmp / "good"
        bad = tmp / "bad"
        good.mkdir()
        bad.mkdir()
        draw_blob(master)
        for index in range(3):
            draw_blob(good / f"f{index:02d}.png", mark=index)
        draw_blob(bad / "f00.png")
        draw_blob(bad / "f01.png", y_offset=9)
        draw_blob(bad / "f02.png", scale=1.25)

        good_out = tmp / "good.json"
        bad_out = tmp / "bad.json"
        good_result = run_gate(good, master, good_out)
        bad_result = run_gate(bad, master, bad_out)

        assert good_result.returncode == 0, good_result.stdout
        assert json.loads(good_out.read_text(encoding="utf8"))["verdict"] == "PASS"
        assert bad_result.returncode != 0, bad_result.stdout
        bad_json = json.loads(bad_out.read_text(encoding="utf8"))
        assert bad_json["verdict"] == "FAIL"
        assert any("baseline wobble" in failure or "scale delta" in failure for failure in bad_json["failures"])


def test_idle_motion_class_accepts_live_idle_and_rejects_identical_cycle() -> None:
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        sheet = ROOT / "client" / "public" / "assets" / "sprites" / "player_blackhair_cel_idle_east_256.webp"
        live = tmp / "live"
        identical = tmp / "identical"
        split_sheet(sheet, live, 256, 256)
        split_sheet(sheet, identical, 256, 256)
        first = Image.open(identical / "f00.png").convert("RGBA")
        for path in sorted(identical.glob("*.png")):
            first.save(path)

        live_out = tmp / "live.json"
        identical_out = tmp / "identical.json"
        idle_args = ["--motion-class", "idle", "--baseline-tolerance-px", "20", "--scale-tolerance-px", "20"]
        live_result = run_gate(live, live / "f00.png", live_out, expected_count=10, extra_args=idle_args)
        identical_result = run_gate(identical, live / "f00.png", identical_out, expected_count=10, extra_args=idle_args)

        assert live_result.returncode == 0, live_result.stdout
        live_json = json.loads(live_out.read_text(encoding="utf8"))
        assert live_json["summary"]["minAdjacentPHash"] == 1
        assert live_json["summary"]["fullCyclePHashSpread"] == 9
        assert identical_result.returncode != 0, identical_result.stdout
        identical_json = json.loads(identical_out.read_text(encoding="utf8"))
        assert any("idle adjacent pHash" in failure for failure in identical_json["failures"])
        assert any("full-cycle pHash spread" in failure for failure in identical_json["failures"])


def _draw_sharp(path: Path, jitter: int = 0) -> None:
    """A hard-edged, high-contrast blob: interior p95 well above the 75 floor."""
    img = Image.new("RGBA", (96, 96), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rectangle((30, 20 + jitter, 66, 74 + jitter), fill=(240, 240, 240, 255))
    # hard black stripes -> steep luminance gradients
    for x in range(34, 66, 6):
        draw.rectangle((x, 24 + jitter, x + 2, 70 + jitter), fill=(10, 10, 10, 255))
    img.save(path)


def _draw_soft(path: Path, jitter: int = 0) -> None:
    """A blurred blob: interior gradients stay low, below the floor."""
    img = Image.new("RGBA", (96, 96), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rectangle((30, 20 + jitter, 66, 74 + jitter), fill=(150, 150, 150, 255))
    for x in range(34, 66, 6):
        draw.rectangle((x, 24 + jitter, x + 2, 70 + jitter), fill=(120, 120, 120, 255))
    img.save(path.with_suffix(".tmp.png"))
    Image.open(path.with_suffix(".tmp.png")).filter(ImageFilter.GaussianBlur(3)).save(path)
    path.with_suffix(".tmp.png").unlink()


def test_sharpness_floor_fails_soft_passes_sharp_and_env_bypasses() -> None:
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        sharp = tmp / "sharp"
        soft = tmp / "soft"
        sharp.mkdir()
        soft.mkdir()
        master = tmp / "master.png"
        _draw_sharp(master)
        for index in range(3):
            _draw_sharp(sharp / f"f{index:02d}.png", jitter=index)
            _draw_soft(soft / f"f{index:02d}.png", jitter=index)

        # This test isolates the sharpness floor: neutralize the unrelated pHash,
        # palette, and geometry checks (last --flag wins over run_gate's default).
        floor_args = [
            "--min-interior-p95",
            "75",
            "--scale-tolerance-px",
            "50",
            "--baseline-tolerance-px",
            "50",
            "--phash-duplicate-distance",
            "-1",
            "--palette-threshold",
            "5.0",
        ]
        sharp_out = tmp / "sharp.json"
        soft_out = tmp / "soft.json"
        sharp_result = run_gate(sharp, master, sharp_out, extra_args=floor_args)
        soft_result = run_gate(soft, master, soft_out, extra_args=floor_args)

        # Sharp frames clear the floor; soft frames fail on the sharpness gate.
        assert sharp_result.returncode == 0, sharp_result.stdout
        sharp_json = json.loads(sharp_out.read_text(encoding="utf8"))
        assert sharp_json["summary"]["minInteriorP95Observed"] >= 75
        assert soft_result.returncode != 0, soft_result.stdout
        soft_json = json.loads(soft_out.read_text(encoding="utf8"))
        assert any("interior sharpness p95" in failure for failure in soft_json["failures"])

        # Loud env escape hatch downgrades the FAIL to a warning (never silent).
        bypass_out = tmp / "bypass.json"
        bypass_result = subprocess.run(
            [
                sys.executable,
                str(FRAMES_QA),
                "--frames",
                str(soft),
                "--master",
                str(master),
                "--expected-count",
                "3",
                "--out",
                str(bypass_out),
                "--palette-threshold",
                "1.2",
            ]
            + floor_args,
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
            env={**os.environ, "FRAMES_QA_ALLOW_SOFT": "1"},
        )
        assert bypass_result.returncode == 0, bypass_result.stdout
        bypass_json = json.loads(bypass_out.read_text(encoding="utf8"))
        assert bypass_json["verdict"] == "PASS"
        assert any("interior sharpness p95" in warn for warn in bypass_json["warnings"])

        # Default (no --min-interior-p95): soft frames still pass (floor disabled).
        # Neutralize the unrelated checks so this isolates the floor being off.
        default_out = tmp / "default.json"
        default_result = run_gate(
            soft,
            master,
            default_out,
            extra_args=[
                "--scale-tolerance-px",
                "50",
                "--baseline-tolerance-px",
                "50",
                "--phash-duplicate-distance",
                "-1",
                "--palette-threshold",
                "5.0",
            ],
        )
        assert default_result.returncode == 0, default_result.stdout
        default_json = json.loads(default_out.read_text(encoding="utf8"))
        # floor disabled -> no sharpness failure even though frames are soft
        assert not any("interior sharpness" in failure for failure in default_json["failures"])
        assert default_json["summary"]["minInteriorP95Observed"] < 75


if __name__ == "__main__":
    test_frames_qa_accepts_stable_frames_and_rejects_broken_set()
    test_idle_motion_class_accepts_live_idle_and_rejects_identical_cycle()
    test_sharpness_floor_fails_soft_passes_sharp_and_env_bypasses()
    print("[test_frames_qa] PASS")

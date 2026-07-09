"""Create Pipeline v4 animation candidates from local video clips.

This tool is intentionally local-only. It does not call Seedance, Replicate, or any
other paid/API provider. It turns an already-downloaded video into review artifacts,
then feeds selected frames into animation-normalize.py.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont


SCRIPT_DIR = Path(__file__).resolve().parent
NORMALIZER = SCRIPT_DIR / "animation-normalize.py"
CLEANUP = SCRIPT_DIR / "animation-cleanup.py"
AUDIT = SCRIPT_DIR / "animation-audit.py"
DEFAULT_OUTPUT_ROOT = Path("tmp") / "animation-video-intake"
VIDEO_SUFFIXES = {".mp4", ".webm", ".mov", ".m4v"}


def parse_bool(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "y"}:
        return True
    if normalized in {"0", "false", "no", "n"}:
        return False
    raise argparse.ArgumentTypeError(f"expected true/false, got {value!r}")


def parse_indices(value: str | None) -> list[int] | None:
    if not value:
        return None
    indices = [int(part.strip()) for part in value.split(",") if part.strip()]
    if not indices:
        return None
    if any(index < 0 for index in indices):
        raise argparse.ArgumentTypeError("selected indices must be zero-based and non-negative")
    return indices


def run_command(command: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=check, text=True, capture_output=True)



def parse_rate(value: str | None) -> float | None:
    if not value or value == "0/0":
        return None
    if "/" in value:
        numerator, denominator = value.split("/", 1)
        try:
            den = float(denominator)
            return None if den == 0 else float(numerator) / den
        except ValueError:
            return None
    try:
        return float(value)
    except ValueError:
        return None


def clean_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def maybe_extract_frames(args: argparse.Namespace, raw_dir: Path) -> bool:
    existing = frame_paths(raw_dir) if raw_dir.exists() else []
    if args.selected_indices and existing and not args.force_extract:
        return False
    clean_dir(raw_dir)
    extract_frames(args.input, raw_dir, args.sample_fps, args.start, args.end)
    return True


def stem_for(args: argparse.Namespace) -> str:
    return f"{args.entity}_{args.animation}"


def split_sheet_to_frames(sheet_path: Path, frame_width: int, frame_height: int, output_dir: Path) -> list[Path]:
    sheet = Image.open(sheet_path).convert("RGBA")
    if sheet.width % frame_width != 0 or sheet.height % frame_height != 0:
        raise ValueError(
            f"Sheet {sheet_path} size {sheet.width}x{sheet.height} is not divisible by "
            f"{frame_width}x{frame_height}"
        )
    clean_dir(output_dir)
    paths: list[Path] = []
    for index in range(sheet.width // frame_width):
        frame = sheet.crop((index * frame_width, 0, (index + 1) * frame_width, frame_height))
        path = output_dir / f"cleaned-{index:03d}.png"
        frame.save(path)
        paths.append(path)
    return paths


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def relative_to_output(path: Path, output_dir: Path) -> str:
    try:
        return path.relative_to(output_dir).as_posix()
    except ValueError:
        return str(path)


def ffprobe(input_path: Path) -> dict[str, Any]:
    result = run_command(
        [
            "ffprobe",
            "-hide_banner",
            "-v",
            "error",
            "-show_entries",
            "format=duration,size",
            "-show_entries",
            "stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate",
            "-of",
            "json",
            str(input_path),
        ]
    )
    return json.loads(result.stdout)


def extract_frames(input_path: Path, raw_dir: Path, sample_fps: float, start: float | None, end: float | None) -> None:
    raw_dir.mkdir(parents=True, exist_ok=True)
    output_pattern = raw_dir / "frame-%04d.png"
    command = ["ffmpeg", "-hide_banner", "-y"]
    if start is not None:
        command.extend(["-ss", str(start)])
    command.extend(["-i", str(input_path)])
    if end is not None:
        duration_args = []
        if start is not None:
            if end <= start:
                raise ValueError("--end must be greater than --start")
            duration_args = ["-t", str(end - start)]
        else:
            duration_args = ["-to", str(end)]
        command.extend(duration_args)
    command.extend(["-vf", f"fps={sample_fps}", str(output_pattern)])
    run_command(command)


def frame_paths(frame_dir: Path) -> list[Path]:
    return sorted(path for path in frame_dir.iterdir() if path.suffix.lower() == ".png")


def choose_indices(
    total: int,
    target_count: int,
    explicit_indices: list[int] | None,
    loop_start_index: int | None = None,
    loop_end_index: int | None = None,
) -> list[int]:
    if total <= 0:
        raise ValueError("No frames were extracted from the video")
    if explicit_indices is not None:
        out_of_range = [index for index in explicit_indices if index >= total]
        if out_of_range:
            raise ValueError(f"Selected frame indices out of range for {total} extracted frames: {out_of_range}")
        return explicit_indices
    if target_count <= 0:
        raise ValueError("--target-frames must be positive")

    selection_start = 0
    selection_end = total - 1
    if loop_start_index is not None or loop_end_index is not None:
        if loop_start_index is None or loop_end_index is None:
            raise ValueError("Provide both --loop-start-index and --loop-end-index")
        if loop_start_index < 0 or loop_end_index < 0:
            raise ValueError("Loop indices must be zero-based and non-negative")
        if loop_start_index >= total or loop_end_index >= total:
            raise ValueError(f"Loop window out of range for {total} extracted frames")
        if loop_end_index <= loop_start_index:
            raise ValueError("--loop-end-index must be greater than --loop-start-index")
        selection_start = loop_start_index
        selection_end = loop_end_index

    span = selection_end - selection_start + 1
    if target_count >= span:
        return list(range(selection_start, selection_end + 1))
    if target_count == 1:
        return [selection_start + span // 2]
    return [round(selection_start + index * (span - 1) / (target_count - 1)) for index in range(target_count)]


def selection_method(args: argparse.Namespace, explicit_indices: list[int] | None) -> str:
    if explicit_indices is not None:
        return "manual-explicit-indices"
    if args.loop_start_index is not None and args.loop_end_index is not None:
        return "loop-window-distributed"
    return "broad-distributed-review-only"


def selection_review_required(args: argparse.Namespace, explicit_indices: list[int] | None) -> bool:
    return bool(args.loop and explicit_indices is None and (args.loop_start_index is None or args.loop_end_index is None))


def copy_selected_frames(raw_frames: list[Path], indices: list[int], selected_dir: Path) -> list[Path]:
    clean_dir(selected_dir)
    selected_paths: list[Path] = []
    for output_index, source_index in enumerate(indices):
        source = raw_frames[source_index]
        target = selected_dir / f"selected-{output_index:03d}-source-{source_index:04d}.png"
        shutil.copy2(source, target)
        selected_paths.append(target)
    return selected_paths


def load_font() -> ImageFont.ImageFont:
    try:
        return ImageFont.truetype("arial.ttf", 14)
    except OSError:
        return ImageFont.load_default()


def make_contact_sheet(
    sources: list[Path],
    output_path: Path,
    thumb_size: int,
    columns: int,
    title: str,
    selected_indices: set[int] | None = None,
) -> None:
    if not sources:
        raise ValueError("Cannot create a contact sheet with no frames")
    selected_indices = selected_indices or set()
    font = load_font()
    columns = max(1, min(columns, len(sources)))
    rows = math.ceil(len(sources) / columns)
    pad = 10
    label_h = 22
    title_h = 34
    sheet_w = pad + columns * (thumb_size + pad)
    sheet_h = title_h + pad + rows * (thumb_size + label_h + pad)
    sheet = Image.new("RGB", (sheet_w, sheet_h), (32, 36, 38))
    draw = ImageDraw.Draw(sheet)
    draw.text((pad, 8), title, fill=(235, 238, 230), font=font)

    for index, source in enumerate(sources):
        frame = Image.open(source).convert("RGB")
        frame.thumbnail((thumb_size, thumb_size), Image.Resampling.LANCZOS)
        cell_x = pad + (index % columns) * (thumb_size + pad)
        cell_y = title_h + pad + (index // columns) * (thumb_size + label_h + pad)
        bg = (48, 54, 58) if index not in selected_indices else (86, 70, 34)
        draw.rectangle([cell_x, cell_y, cell_x + thumb_size - 1, cell_y + thumb_size + label_h - 1], fill=bg)
        image_x = cell_x + (thumb_size - frame.width) // 2
        image_y = cell_y + (thumb_size - frame.height) // 2
        sheet.paste(frame, (image_x, image_y))
        outline = (255, 190, 80) if index in selected_indices else (90, 98, 104)
        draw.rectangle([cell_x, cell_y, cell_x + thumb_size - 1, cell_y + thumb_size - 1], outline=outline, width=2)
        draw.text((cell_x + 4, cell_y + thumb_size + 3), f"{index:04d}", fill=(238, 238, 232), font=font)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output_path)


def make_preview_gif(selected_frames: list[Path], output_path: Path, fps: int) -> None:
    images = [Image.open(path).convert("RGBA") for path in selected_frames]
    if not images:
        return
    duration_ms = max(1, round(1000 / max(1, fps)))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    images[0].save(
        output_path,
        save_all=True,
        append_images=images[1:],
        duration=duration_ms,
        loop=0,
        disposal=2,
    )


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def normalize_selected_frames(args: argparse.Namespace, selected_dir: Path, runtime_dir: Path) -> None:
    clean_dir(runtime_dir)
    command = [
        sys.executable,
        str(NORMALIZER),
        "--input",
        str(selected_dir),
        "--input-kind",
        "frames",
        "--entity",
        args.entity,
        "--animation",
        args.animation,
        "--frame-count",
        str(args.target_frames),
        "--frame-width",
        str(args.frame_width),
        "--frame-height",
        str(args.frame_height),
        "--display-size",
        str(args.display_size),
        "--fps",
        str(args.fps),
        "--loop",
        "true" if args.loop else "false",
        "--anchor-x-policy",
        args.anchor_x_policy,
        "--output-dir",
        str(runtime_dir),
    ]
    if args.key_color:
        command.extend(["--key-color", args.key_color])
    command.extend(["--transparent-threshold", str(args.transparent_threshold)])
    command.extend(["--soft-threshold", str(args.soft_threshold)])
    if args.baseline_y is not None:
        command.extend(["--baseline-y", str(args.baseline_y)])
    if args.center_x is not None:
        command.extend(["--center-x", str(args.center_x)])
    if args.max_content_width is not None:
        command.extend(["--max-content-width", str(args.max_content_width)])
    if args.max_content_height is not None:
        command.extend(["--max-content-height", str(args.max_content_height)])
    if args.allow_upscale:
        command.append("--allow-upscale")
    run_command(command)



def cleanup_and_audit(args: argparse.Namespace, output_dir: Path, runtime_dir: Path, cleaned_dir: Path, reports_dir: Path, selected_count: int) -> dict[str, Any]:
    if not CLEANUP.exists():
        raise SystemExit(f"Missing cleanup tool: {CLEANUP}")
    if not AUDIT.exists():
        raise SystemExit(f"Missing audit tool: {AUDIT}")

    reports_dir.mkdir(parents=True, exist_ok=True)
    stem = stem_for(args)
    runtime_sheet = runtime_dir / f"{stem}.webp"
    metadata = runtime_dir / f"{stem}.metadata.json"
    finalization = runtime_dir / f"{stem}_finalize-runtime.json"
    cleaned_sheet = runtime_dir / f"{stem}_cleaned.webp"
    cleanup_report = reports_dir / "cleanup-report.json"
    audit_dir = reports_dir / "audit"

    if not runtime_sheet.exists():
        raise ValueError(f"Normalizer did not produce expected sheet: {runtime_sheet}")

    cleanup_result = run_command(
        [
            sys.executable,
            str(CLEANUP),
            "--input",
            str(runtime_sheet),
            "--output",
            str(cleaned_sheet),
            "--frame-width",
            str(args.frame_width),
            "--frame-height",
            str(args.frame_height),
            "--key-colors",
            args.cleanup_key_colors,
            "--report",
            str(cleanup_report),
        ]
    )
    split_sheet_to_frames(cleaned_sheet, args.frame_width, args.frame_height, cleaned_dir)

    audit_result = run_command(
        [
            sys.executable,
            str(AUDIT),
            "--sheet",
            str(cleaned_sheet),
            "--frame-width",
            str(args.frame_width),
            "--frame-height",
            str(args.frame_height),
            "--expected-frames",
            str(selected_count),
            "--expected-fps",
            str(args.fps),
            "--metadata",
            str(metadata),
            "--finalization",
            str(finalization),
            "--output-dir",
            str(audit_dir),
            "--name",
            stem,
            "--key-colors",
            args.cleanup_key_colors,
            *( ["--baseline-y", str(args.baseline_y)] if args.baseline_y is not None else [] ),
        ],
        check=False,
    )
    audit_report = audit_dir / f"{stem}_audit.json"
    if not audit_report.exists():
        raise ValueError(f"Audit did not produce expected report: {audit_report}")
    audit_json = read_json(audit_report)

    return {
        "cleanupReport": cleanup_report,
        "auditReport": audit_report,
        "cleanedSheet": cleaned_sheet,
        "cleanedFrames": cleaned_dir,
        "cleanupExitCode": cleanup_result.returncode,
        "auditExitCode": audit_result.returncode,
        "auditFailures": audit_json.get("failures", []),
        "auditWarnings": audit_json.get("warnings", []),
        "auditSummary": audit_json.get("summary", {}),
    }


def default_output_dir(entity: str, animation: str, input_path: Path) -> Path:
    stem = input_path.stem.replace(" ", "-")
    return DEFAULT_OUTPUT_ROOT / entity / animation / stem


def write_review_notes(path: Path, manifest: dict[str, Any], normalized: bool) -> None:
    failures = manifest.get("audit", {}).get("failures", [])
    warnings = manifest.get("audit", {}).get("warnings", [])
    lines = [
        f"# {manifest['entity']} {manifest['animation']} Candidate",
        "",
        "Status: candidate review package.",
        "",
        "## Source",
        "",
        f"- source: `{manifest['sourcePath']}`",
        f"- duration: `{manifest['source'].get('durationSeconds')}` seconds",
        f"- source size: `{manifest['source'].get('width')}x{manifest['source'].get('height')}`",
        f"- sampled frames: `{manifest['sampledFrameCount']}`",
        f"- selected indices: `{manifest['selectedFrameIndices']}`",
        f"- selection method: `{manifest.get('selectionMethod')}`",
        f"- loop window: `{manifest.get('loopWindow')}`",
        "",
        "## Review Checklist",
        "",
        "- [ ] broad contact sheet inspected",
        "- [ ] motion start identified from the first meaningful pose/foot/body change",
        "- [ ] loop end identified where the pose returns to the start phase",
        "- [ ] selected an action-appropriate frame count inside that loop window (short/simple loops often 5-12; longer/complex actions may need 6-30)",
        "- [ ] every in-window frame compared against its neighbors for visible pose/foot/body deviation",
        "- [ ] near-duplicate frames removed unless they are needed for timing/hold readability",
        "- [ ] jumpy/off-model frames rejected even if they are evenly spaced",
        "- [ ] selected-only playback inspected and selection iterated until motion reads smoothly",
        "- [ ] selected frames inspect cleanly",
        "- [ ] loop preview inspected, including the last-frame to first-frame seam",
        "- [ ] chroma/matte cleanup quality accepted",
        "- [ ] baseline/foot stability accepted",
        "- [ ] no shrunken or melted outlier frame",
        "- [ ] runtime normalization report inspected",
        "- [ ] actual promoted runtime sheet audited before promotion",
        "",
        "## Cleanup And Audit",
        "",
        f"- cleanup report: `{manifest.get('reports', {}).get('cleanup')}`",
        f"- audit report: `{manifest.get('reports', {}).get('audit')}`",
        f"- hard blockers: `{len(failures)}`",
        f"- warnings: `{len(warnings)}`",
        "",
    ]
    if failures:
        lines.extend(["### Hard Blockers", ""])
        lines.extend(f"- {failure}" for failure in failures)
        lines.append("")
    if warnings:
        lines.extend(["### Warnings", ""])
        lines.extend(f"- {warning}" for warning in warnings)
        lines.append("")
    if manifest.get("selectionReviewRequired"):
        lines.extend(
            [
                "## Selection Warning",
                "",
                "The selected frames were distributed across the broad frame pool without a reviewed loop window. Treat this as review scaffolding only: inspect the numbered contact sheet, identify the true motion start/end loop window, compare neighboring in-window frames, remove near-duplicates, reject jumpy/off-model poses, then rerun with `--selected-indices` or `--loop-start-index` / `--loop-end-index`.",
                "",
            ]
        )
    if not normalized:
        lines.extend(
            [
                "## Notes",
                "",
                "Runtime normalization was skipped for this run.",
                "",
            ]
        )
    path.write_text("\n".join(lines), encoding="utf-8")


def build_manifest(
    args: argparse.Namespace,
    output_dir: Path,
    probe: dict[str, Any],
    sampled_count: int,
    selected_indices: list[int],
    normalized: bool,
    extracted_frames: bool,
    integration: dict[str, Any] | None,
) -> dict[str, Any]:
    video_stream = next((stream for stream in probe.get("streams", []) if stream.get("codec_type") == "video"), {})
    duration = probe.get("format", {}).get("duration")
    size = probe.get("format", {}).get("size")
    source_frame_rate = parse_rate(video_stream.get("avg_frame_rate") or video_stream.get("r_frame_rate"))
    stem = stem_for(args)
    reports: dict[str, str | None] = {"intake": "reports/intake-report.json", "cleanup": None, "audit": None}
    artifacts: dict[str, str | None] = {
        "rawFrames": "frames/raw",
        "selectedFrames": "frames/selected",
        "cleanedFrames": None,
        "broadContact": "preview/contact-broad.png",
        "numberedContact": "preview/contact-numbered.png",
        "selectedContact": "preview/contact-selected.png",
        "selectedPreviewGif": "preview/selected-preview.gif",
        "runtimeSheet": f"runtime/{stem}.webp" if normalized else None,
        "cleanedRuntimeSheet": None,
        "runtimeMetadata": f"runtime/{stem}.metadata.json" if normalized else None,
        "runtimePreview": f"runtime/{stem}_preview.png" if normalized else None,
        "runtimePreviewGif": f"runtime/{stem}_preview.gif" if normalized else None,
        "runtimeFinalization": f"runtime/{stem}_finalize-runtime.json" if normalized else None,
        "reviewNotes": "review-notes.md",
    }
    audit = {"failures": [], "warnings": [], "summary": {}}
    if integration:
        reports["cleanup"] = relative_to_output(integration["cleanupReport"], output_dir)
        reports["audit"] = relative_to_output(integration["auditReport"], output_dir)
        artifacts["cleanedFrames"] = relative_to_output(integration["cleanedFrames"], output_dir)
        artifacts["cleanedRuntimeSheet"] = relative_to_output(integration["cleanedSheet"], output_dir)
        audit = {
            "failures": integration.get("auditFailures", []),
            "warnings": integration.get("auditWarnings", []),
            "summary": integration.get("auditSummary", {}),
            "exitCode": integration.get("auditExitCode"),
        }

    source_duration = float(duration) if duration is not None else None
    return {
        "schemaVersion": 1,
        "kind": "animation-video-intake-candidate",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "entity": args.entity,
        "animation": args.animation,
        "sourceKind": "local-video",
        "sourcePath": str(args.input),
        "sourceArtPath": None,
        "sourceArtProvider": None,
        "provider": None,
        "model": None,
        "paidRunApprovedByOwner": False,
        "estimatedCostUsd": 0,
        "actualCostUsd": None,
        "prompt": None,
        "negativePrompt": None,
        "keyColor": args.key_color,
        "sourceFrameRate": source_frame_rate,
        "sourceDurationSeconds": source_duration,
        "selectedFrameIndices": selected_indices,
        "selectionMethod": selection_method(args, parse_indices(args.selected_indices)),
        "selectionReviewRequired": selection_review_required(args, parse_indices(args.selected_indices)),
        "loopWindow": {
            "startIndex": args.loop_start_index,
            "endIndex": args.loop_end_index,
        } if args.loop_start_index is not None or args.loop_end_index is not None else None,
        "cleanupMethod": "chroma" if integration else None,
        "matteFallback": None,
        "matteRuntime": None,
        "status": "candidate",
        "decision": "pending-review",
        "sampleFps": args.sample_fps,
        "targetFrames": args.target_frames,
        "sampledFrameCount": sampled_count,
        "selectedFrameCount": len(selected_indices),
        "extractedFramesThisRun": extracted_frames,
        "frameSize": {"width": args.frame_width, "height": args.frame_height},
        "baselineY": args.baseline_y,
        "fps": args.fps,
        "loop": args.loop,
        "anchorXPolicy": args.anchor_x_policy,
        "normalized": normalized,
        "outputDir": str(output_dir),
        "source": {
            "durationSeconds": source_duration,
            "sizeBytes": int(size) if size is not None else None,
            "codec": video_stream.get("codec_name"),
            "width": video_stream.get("width"),
            "height": video_stream.get("height"),
            "frameRate": video_stream.get("avg_frame_rate") or video_stream.get("r_frame_rate"),
        },
        "reports": reports,
        "audit": audit,
        "artifacts": artifacts,
    }


def build_intake_report(
    args: argparse.Namespace,
    output_dir: Path,
    raw_count: int,
    selected_indices: list[int],
    extracted_frames: bool,
    normalized: bool,
    integration: dict[str, Any] | None,
) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "kind": "animation-video-intake-report",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "input": str(args.input),
        "outputDir": str(output_dir),
        "sampleFps": args.sample_fps,
        "start": args.start,
        "end": args.end,
        "rawFrameCount": raw_count,
        "selectedFrameIndices": selected_indices,
        "selectedFrameCount": len(selected_indices),
        "selectionMethod": selection_method(args, parse_indices(args.selected_indices)),
        "selectionReviewRequired": selection_review_required(args, parse_indices(args.selected_indices)),
        "loopWindow": {
            "startIndex": args.loop_start_index,
            "endIndex": args.loop_end_index,
        } if args.loop_start_index is not None or args.loop_end_index is not None else None,
        "extractedFramesThisRun": extracted_frames,
        "normalized": normalized,
        "cleanupRan": bool(integration),
        "auditExitCode": integration.get("auditExitCode") if integration else None,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Create Pipeline v4 candidate artifacts from a local video")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--entity", required=True)
    parser.add_argument("--animation", required=True)
    parser.add_argument("--key-color")
    parser.add_argument("--frame-width", type=int, required=True)
    parser.add_argument("--frame-height", type=int, required=True)
    parser.add_argument("--baseline-y", type=int)
    parser.add_argument("--center-x", type=int)
    parser.add_argument("--display-size", type=int, required=True)
    parser.add_argument("--fps", type=int, default=6)
    parser.add_argument("--loop", type=parse_bool, default=True)
    parser.add_argument("--target-frames", type=int, default=8)
    parser.add_argument("--selected-indices")
    parser.add_argument("--loop-start-index", type=int)
    parser.add_argument("--loop-end-index", type=int)
    parser.add_argument(
        "--sample-fps",
        type=float,
        default=12,
        help="Broad review extraction rate. Default 12fps yields about 50-60 frames from a typical 4-5s Seedance clip.",
    )
    parser.add_argument("--start", type=float)
    parser.add_argument("--end", type=float)
    parser.add_argument("--anchor-x-policy", choices=["center", "foot", "preserve"], default="center")
    parser.add_argument("--max-content-width", type=int)
    parser.add_argument("--max-content-height", type=int)
    parser.add_argument("--allow-upscale", action="store_true")
    parser.add_argument("--transparent-threshold", type=int, default=12)
    parser.add_argument("--soft-threshold", type=int, default=70)
    parser.add_argument("--contact-thumb-size", type=int, default=160)
    parser.add_argument("--contact-columns", type=int, default=8)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--skip-normalize", action="store_true")
    parser.add_argument("--skip-cleanup-audit", action="store_true")
    parser.add_argument("--cleanup-key-colors", default="magenta,green,blue")
    parser.add_argument("--force-extract", action="store_true")
    args = parser.parse_args()

    if args.input.suffix.lower() not in VIDEO_SUFFIXES:
        raise SystemExit(f"Input does not look like a supported video: {args.input}")
    if not args.input.exists():
        raise SystemExit(f"Input does not exist: {args.input}")
    if not NORMALIZER.exists():
        raise SystemExit(f"Missing normalizer: {NORMALIZER}")
    if args.skip_cleanup_audit and args.skip_normalize:
        pass

    output_dir = args.output_dir or default_output_dir(args.entity, args.animation, args.input)
    raw_dir = output_dir / "frames" / "raw"
    selected_dir = output_dir / "frames" / "selected"
    cleaned_dir = output_dir / "frames" / "cleaned"
    preview_dir = output_dir / "preview"
    runtime_dir = output_dir / "runtime"
    reports_dir = output_dir / "reports"

    preview_dir.mkdir(parents=True, exist_ok=True)
    reports_dir.mkdir(parents=True, exist_ok=True)
    probe = ffprobe(args.input)
    extracted_frames = maybe_extract_frames(args, raw_dir)
    raw_frames = frame_paths(raw_dir)
    explicit_indices = parse_indices(args.selected_indices)
    selected_indices = choose_indices(
        len(raw_frames),
        args.target_frames,
        explicit_indices,
        args.loop_start_index,
        args.loop_end_index,
    )
    selected_paths = copy_selected_frames(raw_frames, selected_indices, selected_dir)

    selected_index_set = set(selected_indices)
    make_contact_sheet(
        raw_frames,
        preview_dir / "contact-broad.png",
        args.contact_thumb_size,
        args.contact_columns,
        f"{args.entity} {args.animation} broad frame pool",
        selected_index_set,
    )
    make_contact_sheet(
        raw_frames,
        preview_dir / "contact-numbered.png",
        args.contact_thumb_size,
        args.contact_columns,
        "numbered extracted frames",
        selected_index_set,
    )
    make_contact_sheet(
        selected_paths,
        preview_dir / "contact-selected.png",
        args.contact_thumb_size,
        min(args.contact_columns, max(1, len(selected_paths))),
        "selected frames",
        set(range(len(selected_paths))),
    )
    make_preview_gif(selected_paths, preview_dir / "selected-preview.gif", args.fps)

    normalized = not args.skip_normalize
    integration: dict[str, Any] | None = None
    if normalized:
        normalize_selected_frames(args, selected_dir, runtime_dir)
        if not args.skip_cleanup_audit:
            integration = cleanup_and_audit(args, output_dir, runtime_dir, cleaned_dir, reports_dir, len(selected_indices))

    manifest = build_manifest(args, output_dir, probe, len(raw_frames), selected_indices, normalized, extracted_frames, integration)
    write_json(output_dir / "candidate-run.json", manifest)
    write_json(output_dir / "source-info.json", probe)
    write_json(reports_dir / "intake-report.json", build_intake_report(args, output_dir, len(raw_frames), selected_indices, extracted_frames, normalized, integration))
    write_review_notes(output_dir / "review-notes.md", manifest, normalized)
    print(json.dumps({"outputDir": str(output_dir), "selectedFrameIndices": selected_indices}, indent=2))


if __name__ == "__main__":
    main()

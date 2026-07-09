"""Create Pipeline v4 animation candidates from generated image sheets.

This tool is the image-sheet counterpart to animation-video-intake.py. It treats a generated
or existing sheet as a frame pool, preserves review artifacts, and optionally runs the same
normalization/cleanup/audit path used by video candidates.
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
DEFAULT_OUTPUT_ROOT = Path("tmp") / "animation-sheet-intake"


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
    if any(index < 0 for index in indices):
        raise argparse.ArgumentTypeError("selected indices must be zero-based and non-negative")
    return indices or None


def run(command: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, check=False, text=True, capture_output=True)
    if check and result.returncode != 0:
        detail = "\n".join(part for part in [result.stdout, result.stderr] if part)
        raise RuntimeError(f"Command failed with exit {result.returncode}: {' '.join(command)}\n{detail}")
    return result


def clean_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def load_font() -> ImageFont.ImageFont:
    try:
        return ImageFont.truetype("arial.ttf", 14)
    except OSError:
        return ImageFont.load_default()


def frame_paths(frame_dir: Path) -> list[Path]:
    return sorted(path for path in frame_dir.iterdir() if path.suffix.lower() == ".png")


def split_grid(args: argparse.Namespace, raw_dir: Path) -> list[Path]:
    sheet = Image.open(args.input).convert("RGBA")
    source_width = args.source_frame_width or args.frame_width
    source_height = args.source_frame_height or args.frame_height
    columns = args.columns or (sheet.width // source_width)
    rows = args.rows or (sheet.height // source_height)
    if columns <= 0 or rows <= 0:
        raise ValueError("columns and rows must be positive")
    if sheet.width < columns * source_width or sheet.height < rows * source_height:
        raise ValueError(
            f"Sheet {args.input} size {sheet.width}x{sheet.height} cannot provide "
            f"{columns}x{rows} cells of {source_width}x{source_height}"
        )

    clean_dir(raw_dir)
    paths: list[Path] = []
    index = 0
    for row in range(rows):
        for column in range(columns):
            if args.frame_count is not None and index >= args.frame_count:
                return paths
            left = column * source_width
            top = row * source_height
            frame = sheet.crop((left, top, left + source_width, top + source_height))
            path = raw_dir / f"frame-{index + 1:04d}.png"
            frame.save(path)
            paths.append(path)
            index += 1
    return paths


def recover_components(args: argparse.Namespace, raw_dir: Path, recovery_dir: Path) -> tuple[list[Path], Path]:
    clean_dir(raw_dir)
    clean_dir(recovery_dir)
    stem = f"{args.entity}_{args.animation}"
    command = [
        "python",
        str(NORMALIZER),
        "--input",
        str(args.input),
        "--input-kind",
        "pose-board",
        "--entity",
        args.entity,
        "--animation",
        args.animation,
        "--frame-count",
        str(args.frame_count or args.target_frames),
        "--frame-width",
        str(args.frame_width),
        "--frame-height",
        str(args.frame_height),
        "--display-size",
        str(args.display_size),
        "--fps",
        str(args.fps),
        "--loop",
        str(args.loop).lower(),
        "--anchor-x-policy",
        args.anchor_x_policy,
        "--component-alpha-threshold",
        str(args.component_alpha_threshold),
        "--component-min-area",
        str(args.component_min_area),
        "--component-min-width",
        str(args.component_min_width),
        "--component-min-height",
        str(args.component_min_height),
        "--recovery-padding",
        str(args.recovery_padding),
        "--component-order",
        args.component_order,
        "--recovery-only",
        "--output-dir",
        str(recovery_dir),
    ]
    if args.key_color:
        command.extend(["--key-color", args.key_color])
    if args.baseline_y is not None:
        command.extend(["--baseline-y", str(args.baseline_y)])
    run(command)
    recovery_report = recovery_dir / f"{stem}_recovery.json"
    report = json.loads(recovery_report.read_text(encoding="utf-8"))
    recovered_dir = Path(str(report["recoveredFrames"]))
    if not recovered_dir.is_absolute() and not recovered_dir.exists():
        recovered_dir = recovery_dir / recovered_dir
    recovered_paths = frame_paths(recovered_dir)
    if not recovered_paths:
        raise ValueError("Component recovery produced no frame crops")
    paths: list[Path] = []
    for index, source in enumerate(recovered_paths):
        target = raw_dir / f"frame-{index + 1:04d}.png"
        shutil.copy2(source, target)
        paths.append(target)
    return paths, recovery_report


def choose_indices(total: int, target_count: int, explicit_indices: list[int] | None) -> list[int]:
    if total <= 0:
        raise ValueError("No frames were recovered from the sheet")
    if explicit_indices is not None:
        out_of_range = [index for index in explicit_indices if index >= total]
        if out_of_range:
            raise ValueError(f"Selected frame indices out of range for {total} recovered frames: {out_of_range}")
        return explicit_indices
    if target_count >= total:
        return list(range(total))
    if target_count == 1:
        return [total // 2]
    return [round(index * (total - 1) / (target_count - 1)) for index in range(target_count)]


def copy_selected(raw_frames: list[Path], selected_dir: Path, indices: list[int]) -> list[Path]:
    clean_dir(selected_dir)
    paths: list[Path] = []
    for output_index, source_index in enumerate(indices):
        target = selected_dir / f"selected-{output_index:03d}-source-{source_index:04d}.png"
        shutil.copy2(raw_frames[source_index], target)
        paths.append(target)
    return paths


def make_contact_sheet(
    sources: list[Path],
    output_path: Path,
    thumb_size: int,
    columns: int,
    title: str,
    selected_indices: set[int] | None = None,
) -> None:
    selected_indices = selected_indices or set()
    font = load_font()
    columns = max(1, min(columns, len(sources)))
    rows = math.ceil(len(sources) / columns)
    pad = 10
    label_h = 22
    title_h = 34
    sheet = Image.new("RGB", (pad + columns * (thumb_size + pad), title_h + pad + rows * (thumb_size + label_h + pad)), (32, 36, 38))
    draw = ImageDraw.Draw(sheet)
    draw.text((pad, 8), title, fill=(235, 238, 230), font=font)
    for index, source in enumerate(sources):
        col = index % columns
        row = index // columns
        x = pad + col * (thumb_size + pad)
        y = title_h + pad + row * (thumb_size + label_h + pad)
        bg = (50, 82, 130) if index in selected_indices else (214, 214, 214)
        draw.rectangle((x, y, x + thumb_size, y + thumb_size + label_h), fill=bg)
        img = Image.open(source).convert("RGBA")
        img.thumbnail((thumb_size - 12, thumb_size - 12), Image.Resampling.LANCZOS)
        px = x + (thumb_size - img.width) // 2
        py = y + (thumb_size - img.height) // 2
        cell = Image.new("RGBA", (thumb_size, thumb_size), (214, 214, 214, 255))
        cell.alpha_composite(img, (px - x, py - y))
        sheet.paste(cell.convert("RGB"), (x, y))
        draw.text((x + 5, y + thumb_size + 3), f"frame-{index + 1:04d}", fill=(245, 245, 245), font=font)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output_path)


def make_preview_gif(frames: list[Path], output_path: Path, fps: int) -> None:
    images = [Image.open(path).convert("RGBA") for path in frames]
    output_path.parent.mkdir(parents=True, exist_ok=True)
    images[0].save(
        output_path,
        save_all=True,
        append_images=images[1:],
        duration=max(20, round(1000 / fps)),
        loop=0,
        disposal=2,
    )


def normalize(args: argparse.Namespace, selected_dir: Path, runtime_dir: Path) -> None:
    runtime_dir.mkdir(parents=True, exist_ok=True)
    command = [
        "python",
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
        str(args.loop).lower(),
        "--anchor-x-policy",
        args.anchor_x_policy,
        "--output-dir",
        str(runtime_dir),
    ]
    if args.key_color:
        command.extend(["--key-color", args.key_color])
    if args.baseline_y is not None:
        command.extend(["--baseline-y", str(args.baseline_y)])
    run(command)


def cleanup_and_audit(args: argparse.Namespace, output_dir: Path, runtime_dir: Path) -> dict[str, Any]:
    stem = f"{args.entity}_{args.animation}"
    sheet = runtime_dir / f"{stem}.webp"
    metadata = runtime_dir / f"{stem}.metadata.json"
    finalization = runtime_dir / f"{stem}_finalize-runtime.json"
    cleaned = runtime_dir / f"{stem}_cleaned.webp"
    cleanup_report = output_dir / "reports" / "cleanup-report.json"
    audit_dir = output_dir / "reports" / "audit"
    run(
        [
            "python",
            str(CLEANUP),
            "--input",
            str(sheet),
            "--output",
            str(cleaned),
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
    audit = run(
        [
            "python",
            str(AUDIT),
            "--sheet",
            str(cleaned),
            "--frame-width",
            str(args.frame_width),
            "--frame-height",
            str(args.frame_height),
            "--expected-frames",
            str(args.target_frames),
            "--expected-fps",
            str(args.fps),
            "--metadata",
            str(metadata),
            "--finalization",
            str(finalization),
            "--baseline-y",
            str(args.baseline_y or args.frame_height - 1),
            "--key-colors",
            args.cleanup_key_colors,
            "--name",
            stem,
            "--output-dir",
            str(audit_dir),
        ],
        check=False,
    )
    audit_report = audit_dir / f"{stem}_audit.json"
    report = json.loads(audit_report.read_text(encoding="utf-8"))
    return {
        "cleanedSheet": cleaned,
        "cleanupReport": cleanup_report,
        "auditReport": audit_report,
        "auditExitCode": audit.returncode,
        "auditFailures": report.get("failures", []),
        "auditWarnings": report.get("warnings", []),
        "auditSummary": report.get("summary", {}),
    }


def rel(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return str(path)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def write_notes(path: Path, manifest: dict[str, Any]) -> None:
    audit = manifest["audit"]
    lines = [
        f"# {manifest['entity']} {manifest['animation']} Sheet Candidate",
        "",
        "Status: candidate review package.",
        "",
        "## Source",
        "",
        f"- source sheet: `{manifest['sourcePath']}`",
        f"- recovered frames: `{manifest['sampledFrameCount']}`",
        f"- selected indices: `{manifest['selectedFrameIndices']}`",
        "",
        "## Source Motion Checklist",
        "",
        "- [ ] source sheet rating gate passed before intake",
        "- [ ] no hard blockers: clipped body/feet, off-screen poses, pasted parts, block patches, incoherent artifacts",
        "- [ ] action readability, frame cleanliness, and framing/cell safety each scored at least 4/5",
        "- [ ] source sheet has clear action beats before frame picking",
        "- [ ] wind-up / anticipation pose is visibly different from ready",
        "- [ ] contact / impact pose is visibly different from wind-up and recovery",
        "- [ ] recovery / settle pose returns intentionally without looking like a duplicate run",
        "- [ ] near-identical anchor warps are rejected as a failed motion source, even if intake succeeds",
        "- [ ] sheet-source frame pool was reviewed before normalization/promotion dry-run",
        "",
        "## Cleanup And Audit",
        "",
        f"- hard blockers: `{len(audit['failures'])}`",
        f"- warnings: `{len(audit['warnings'])}`",
    ]
    if audit["failures"]:
        lines.extend(["", "### Hard Blockers", ""])
        lines.extend(f"- {failure}" for failure in audit["failures"])
    if audit["warnings"]:
        lines.extend(["", "### Warnings", ""])
        lines.extend(f"- {warning}" for warning in audit["warnings"])
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def build_manifest(
    args: argparse.Namespace,
    output_dir: Path,
    raw_count: int,
    selected_indices: list[int],
    integration: dict[str, Any] | None,
    recovery_report: Path | None,
) -> dict[str, Any]:
    stem = f"{args.entity}_{args.animation}"
    reports = {"intake": "reports/intake-report.json", "recovery": None, "cleanup": None, "audit": None}
    artifacts: dict[str, str | None] = {
        "rawFrames": "frames/raw",
        "selectedFrames": "frames/selected",
        "cleanedFrames": None,
        "broadContact": "preview/contact-broad.png",
        "numberedContact": "preview/contact-numbered.png",
        "selectedContact": "preview/contact-selected.png",
        "selectedPreviewGif": "preview/selected-preview.gif",
        "runtimeSheet": f"runtime/{stem}.webp",
        "cleanedRuntimeSheet": None,
        "runtimeMetadata": f"runtime/{stem}.metadata.json",
        "runtimePreview": f"runtime/{stem}_preview.png",
        "runtimePreviewGif": f"runtime/{stem}_preview.gif",
        "runtimeFinalization": f"runtime/{stem}_finalize-runtime.json",
        "reviewNotes": "review-notes.md",
    }
    if recovery_report:
        reports["recovery"] = rel(recovery_report, output_dir)
        artifacts["recoveryPreview"] = f"reports/recovery/{stem}_recovery-components.png"
    audit = {"failures": [], "warnings": [], "summary": {}, "exitCode": None}
    if integration:
        reports["cleanup"] = rel(integration["cleanupReport"], output_dir)
        reports["audit"] = rel(integration["auditReport"], output_dir)
        artifacts["cleanedRuntimeSheet"] = rel(integration["cleanedSheet"], output_dir)
        audit = {
            "failures": integration["auditFailures"],
            "warnings": integration["auditWarnings"],
            "summary": integration["auditSummary"],
            "exitCode": integration["auditExitCode"],
        }
    return {
        "schemaVersion": 1,
        "kind": "animation-sheet-intake-candidate",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "entity": args.entity,
        "animation": args.animation,
        "sourceKind": "image-sheet",
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
        "sourceFrameRate": None,
        "sourceDurationSeconds": None,
        "selectedFrameIndices": selected_indices,
        "cleanupMethod": "chroma" if integration else None,
        "recoveryMode": args.recovery_mode,
        "matteFallback": None,
        "matteRuntime": None,
        "status": "candidate",
        "decision": "pending-review",
        "sampleFps": None,
        "targetFrames": args.target_frames,
        "sampledFrameCount": raw_count,
        "selectedFrameCount": len(selected_indices),
        "extractedFramesThisRun": True,
        "frameSize": {"width": args.frame_width, "height": args.frame_height},
        "baselineY": args.baseline_y,
        "fps": args.fps,
        "loop": args.loop,
        "anchorXPolicy": args.anchor_x_policy,
        "normalized": True,
        "outputDir": str(output_dir),
        "source": {
            "width": Image.open(args.input).width,
            "height": Image.open(args.input).height,
            "columns": args.columns,
            "rows": args.rows,
        },
        "reports": reports,
        "audit": audit,
        "artifacts": artifacts,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create Pipeline v4 candidate artifacts from an image sheet")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--entity", required=True)
    parser.add_argument("--animation", required=True)
    parser.add_argument("--key-color")
    parser.add_argument("--frame-width", type=int, required=True)
    parser.add_argument("--frame-height", type=int, required=True)
    parser.add_argument("--source-frame-width", type=int)
    parser.add_argument("--source-frame-height", type=int)
    parser.add_argument("--columns", type=int)
    parser.add_argument("--rows", type=int)
    parser.add_argument("--frame-count", type=int)
    parser.add_argument("--recovery-mode", choices=["exact-grid", "components"], default="exact-grid")
    parser.add_argument("--component-alpha-threshold", type=int, default=24)
    parser.add_argument("--component-min-area", type=int, default=500)
    parser.add_argument("--component-min-width", type=int, default=16)
    parser.add_argument("--component-min-height", type=int, default=16)
    parser.add_argument("--recovery-padding", type=int, default=12)
    parser.add_argument("--component-order", choices=["grid", "horizontal", "vertical"], default="grid")
    parser.add_argument("--baseline-y", type=int)
    parser.add_argument("--display-size", type=int, required=True)
    parser.add_argument("--fps", type=int, default=8)
    parser.add_argument("--loop", type=parse_bool, default=True)
    parser.add_argument("--target-frames", type=int, default=8)
    parser.add_argument("--selected-indices")
    parser.add_argument("--anchor-x-policy", choices=["center", "foot", "preserve"], default="center")
    parser.add_argument("--contact-thumb-size", type=int, default=160)
    parser.add_argument("--contact-columns", type=int, default=8)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--cleanup-key-colors", default="magenta,green,blue")
    argv = sys.argv[1:]
    if argv and argv[0] == "--":
        argv = argv[1:]
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()
    output_dir = args.output_dir or DEFAULT_OUTPUT_ROOT / args.entity / args.animation / args.input.stem
    raw_dir = output_dir / "frames" / "raw"
    selected_dir = output_dir / "frames" / "selected"
    runtime_dir = output_dir / "runtime"
    preview_dir = output_dir / "preview"
    recovery_report = None
    if args.recovery_mode == "components":
        raw_frames, recovery_report = recover_components(args, raw_dir, output_dir / "reports" / "recovery")
    else:
        raw_frames = split_grid(args, raw_dir)
    selected_indices = choose_indices(len(raw_frames), args.target_frames, parse_indices(args.selected_indices))
    selected = copy_selected(raw_frames, selected_dir, selected_indices)
    make_contact_sheet(raw_frames, preview_dir / "contact-broad.png", args.contact_thumb_size, args.contact_columns, "recovered sheet frames")
    make_contact_sheet(raw_frames, preview_dir / "contact-numbered.png", args.contact_thumb_size, args.contact_columns, "numbered sheet frames", set(selected_indices))
    make_contact_sheet(selected, preview_dir / "contact-selected.png", args.contact_thumb_size, args.contact_columns, "selected sheet frames")
    make_preview_gif(selected, preview_dir / "selected-preview.gif", args.fps)
    normalize(args, selected_dir, runtime_dir)
    integration = cleanup_and_audit(args, output_dir, runtime_dir)
    manifest = build_manifest(args, output_dir, len(raw_frames), selected_indices, integration, recovery_report)
    write_json(output_dir / "candidate-run.json", manifest)
    write_json(
        output_dir / "reports" / "intake-report.json",
        {
            "schemaVersion": 1,
            "kind": "animation-sheet-intake-report",
            "recoveryMode": args.recovery_mode,
            "selectedFrameIndices": selected_indices,
            "rawFrameCount": len(raw_frames),
            "outputDir": str(output_dir),
            "recoveryReport": rel(recovery_report, output_dir) if recovery_report else None,
        },
    )
    write_notes(output_dir / "review-notes.md", manifest)
    print(json.dumps({"outputDir": str(output_dir), "selectedFrameIndices": selected_indices}, indent=2))


if __name__ == "__main__":
    main()

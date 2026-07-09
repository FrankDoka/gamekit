import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

type SourceKind = "video" | "sheet";

type AnimationJob = {
  jobId: string;
  entity: string;
  character?: string;
  outputRoot?: string;
  animations: JobAnimation[];
};

type JobAnimation = {
  state: string;
  direction: string;
  animation?: string;
  nativeFacing?: string;
  source: {
    kind: SourceKind;
    path: string;
    keyColor?: string | null;
    cleanupKeyColors?: string;
  };
  frameWidth: number;
  frameHeight: number;
  sourceFrameWidth?: number;
  sourceFrameHeight?: number;
  columns?: number;
  rows?: number;
  frameCount?: number;
  baselineY: number;
  displaySize: number;
  fps: number;
  loop?: boolean;
  targetFrames: number;
  selectedIndices?: number[];
  sampleFps?: number;
  anchorXPolicy?: "center" | "foot" | "preserve";
  targetName?: string;
};

const args = process.argv.slice(2);

function argValue(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return args.includes(name);
}

function requireArg(name: string): string {
  const value = argValue(name);
  if (!value) throw new Error(`Missing required argument ${name}`);
  return value;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function selectedIndicesArg(indices: number[] | undefined): string | undefined {
  return indices?.length ? indices.join(",") : undefined;
}

function pushArg(command: string[], name: string, value: string | number | boolean | null | undefined): void {
  if (value === undefined || value === null) return;
  command.push(name, String(value));
}

async function run(command: string, commandArgs: string[], cwd: string): Promise<{ code: number; output: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command, commandArgs, { cwd, shell: process.platform === "win32" });
    const chunks: string[] = [];
    child.stdout.on("data", (data) => chunks.push(String(data)));
    child.stderr.on("data", (data) => chunks.push(String(data)));
    child.on("error", (error) => resolve({ code: 1, output: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, output: chunks.join("") }));
  });
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function intakeCommand(animation: JobAnimation, candidateDir: string, entity: string): string[] {
  const script =
    animation.source.kind === "video"
      ? "tools/art-pipeline/animation-video-intake.py"
      : "tools/art-pipeline/animation-sheet-intake.py";
  const command = [script];
  pushArg(command, "--input", animation.source.path);
  pushArg(command, "--entity", entity);
  pushArg(command, "--animation", animation.animation ?? `${animation.state}_${animation.direction}`);
  pushArg(command, "--key-color", animation.source.keyColor);
  pushArg(command, "--frame-width", animation.frameWidth);
  pushArg(command, "--frame-height", animation.frameHeight);
  pushArg(command, "--baseline-y", animation.baselineY);
  pushArg(command, "--display-size", animation.displaySize);
  pushArg(command, "--fps", animation.fps);
  pushArg(command, "--loop", animation.loop ?? true);
  pushArg(command, "--target-frames", animation.targetFrames);
  pushArg(command, "--selected-indices", selectedIndicesArg(animation.selectedIndices));
  pushArg(command, "--anchor-x-policy", animation.anchorXPolicy ?? "center");
  pushArg(command, "--cleanup-key-colors", animation.source.cleanupKeyColors ?? "magenta,green,blue");
  pushArg(command, "--output-dir", candidateDir);

  if (animation.source.kind === "video") {
    pushArg(command, "--sample-fps", animation.sampleFps ?? 12);
  } else {
    pushArg(command, "--source-frame-width", animation.sourceFrameWidth);
    pushArg(command, "--source-frame-height", animation.sourceFrameHeight);
    pushArg(command, "--columns", animation.columns);
    pushArg(command, "--rows", animation.rows);
    pushArg(command, "--frame-count", animation.frameCount);
  }
  return command;
}

function resultsMarkdown(job: AnimationJob, rows: ResultRow[]): string {
  const lines = [
    `# Animation Job Results - ${job.jobId}`,
    "",
    `Entity: \`${job.entity}\``,
    `Character: \`${job.character ?? job.entity}\``,
    "",
    "## Animations",
    "",
    "| Key | Source | Candidate | Status | Review | Promotion |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.key} | ${row.sourceKind} | \`${row.candidateDir}\` | ${row.status} | \`${row.reviewNotes}\` | \`${row.promotionReport}\` |`,
    );
  }
  lines.push("", "## Notes", "", "- Provider/API generation is not run by this orchestrator.", "- Live runtime promotion still requires owner confirmation and `animation-promote --apply`.");
  return `${lines.join("\n")}\n`;
}

type ResultRow = {
  key: string;
  sourceKind: SourceKind;
  candidateDir: string;
  status: string;
  reviewNotes: string;
  promotionReport: string;
};

async function main(): Promise<void> {
  const jobPath = path.resolve(requireArg("--job"));
  const dryRun = hasFlag("--dry-run");
  const cwd = process.cwd();
  const job = await readJson<AnimationJob>(jobPath);
  if (!job.animations?.length) throw new Error("Job must include at least one animation");

  const outputRoot = path.resolve(job.outputRoot ?? path.join("tmp", "animation-jobs", slug(job.jobId)));
  const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(outputRoot, "job-plan.json"), `${JSON.stringify(job, null, 2)}\n`, "utf8");

  const rows: ResultRow[] = [];
  const commandLog: Array<{ step: string; command: string[]; code?: number; output?: string }> = [];

  for (const animation of job.animations) {
    const animationName = animation.animation ?? `${animation.state}_${animation.direction}`;
    const key = `${job.character ?? job.entity}-${animation.state}-${animation.direction}`;
    const candidateDir = path.join(outputRoot, slug(animationName));
    const intake = intakeCommand(animation, candidateDir, job.entity);
    commandLog.push({ step: `${key}: intake`, command: ["python", ...intake] });

    if (!dryRun) {
      const intakeResult = await run("python", intake, cwd);
      commandLog[commandLog.length - 1] = { ...commandLog[commandLog.length - 1], ...intakeResult };
      if (intakeResult.code !== 0) throw new Error(`Intake failed for ${key}; see command-log.json`);

      const indexArgs = [
        "animation-index",
        "--candidate",
        candidateDir,
        "--character",
        job.character ?? job.entity,
        "--state",
        animation.state,
        "--direction",
        animation.direction,
        "--native-facing",
        animation.nativeFacing ?? animation.direction,
      ];
      commandLog.push({ step: `${key}: candidate index`, command: ["pnpm", ...indexArgs] });
      const indexResult = await run(packageManager, indexArgs, cwd);
      commandLog[commandLog.length - 1] = { ...commandLog[commandLog.length - 1], ...indexResult };
      if (indexResult.code !== 0) throw new Error(`Candidate index failed for ${key}; see command-log.json`);

      const promoteArgs = [
        "animation-promote",
        "--candidate",
        candidateDir,
        "--target-name",
        animation.targetName ?? slug(key),
      ];
      commandLog.push({ step: `${key}: promotion dry-run`, command: ["pnpm", ...promoteArgs] });
      const promoteResult = await run(packageManager, promoteArgs, cwd);
      commandLog[commandLog.length - 1] = { ...commandLog[commandLog.length - 1], ...promoteResult };
      if (promoteResult.code !== 0) throw new Error(`Promotion dry-run failed for ${key}; see command-log.json`);
    }

    rows.push({
      key,
      sourceKind: animation.source.kind,
      candidateDir,
      status: dryRun ? "planned" : "candidate-ready",
      reviewNotes: path.join(candidateDir, "review-notes.md"),
      promotionReport: path.join(candidateDir, "promotion", "promotion-report.md"),
    });
  }

  await writeFile(path.join(outputRoot, "command-log.json"), `${JSON.stringify(commandLog, null, 2)}\n`, "utf8");
  await writeFile(path.join(outputRoot, "results.md"), resultsMarkdown(job, rows), "utf8");
  console.log(JSON.stringify({ outputRoot, dryRun, animations: rows.length, results: path.join(outputRoot, "results.md") }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

type CandidateRun = {
  schemaVersion: number;
  entity: string;
  animation: string;
  sourceKind: string;
  sourcePath: string;
  keyColor: string | null;
  selectedFrameIndices: number[];
  frameSize: { width: number; height: number };
  fps: number;
  loop: boolean;
  status: string;
  normalized: boolean;
  reports?: { intake?: string; cleanup?: string | null; audit?: string | null };
  audit?: { failures?: string[]; warnings?: string[]; summary?: Record<string, unknown> };
  artifacts: {
    rawFrames: string;
    selectedFrames: string;
    cleanedFrames?: string | null;
    broadContact?: string | null;
    numberedContact?: string | null;
    selectedContact?: string | null;
    selectedPreviewGif?: string | null;
    runtimeSheet?: string | null;
    cleanedRuntimeSheet?: string | null;
    runtimeMetadata?: string | null;
    runtimePreview?: string | null;
    runtimePreviewGif?: string | null;
    runtimeFinalization?: string | null;
    reviewNotes?: string | null;
  };
};

type RuntimeMetadata = {
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  fps: number;
  loop: boolean;
  bodyHeight?: number;
  baselineY?: number;
  centerX?: number;
  displaySize?: number;
  maxContentWidth?: number;
  maxContentHeight?: number;
  displayBodyHeight?: number;
  anchorXPolicy?: string;
};

type RuntimeFinalization = {
  maxAbsDy?: number;
};

type AuditSummary = {
  bottomDrift?: number;
  footAnchorXDrift?: number;
};

type FrameSelection = {
  selectedFrameIndices?: number[];
  selectedFrameNames?: string[];
};

const args = process.argv.slice(2);

function argValue(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requireArg(name: string): string {
  const value = argValue(name);
  if (!value) {
    throw new Error(`Missing required argument ${name}`);
  }
  return value;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return await readJson<T>(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

function sameNumbers(a: number[] | undefined, b: number[] | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

async function namesForIndices(candidateDir: string, sourceFrameDir: string, indices: number[]): Promise<string[]> {
  const names = (await readdir(path.join(candidateDir, sourceFrameDir)))
    .filter((name) => name.toLowerCase().endsWith(".png"))
    .sort();
  return indices.map((index) => names[index] ?? `missing-source-index-${index}`);
}

function statusFor(run: CandidateRun): string {
  if (!run.normalized) return "selected";
  if ((run.audit?.failures ?? []).length > 0) return "audited";
  return run.reports?.audit ? "audited" : "normalized";
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hardMonsterAnchorFailures(run: CandidateRun, finalization: RuntimeFinalization | null): string[] {
  if (!run.entity.startsWith("monster_")) return [];
  const failures: string[] = [];
  const summary = (run.audit?.summary ?? {}) as AuditSummary;
  const bottomDrift = numeric(summary.bottomDrift);
  const footAnchorXDrift = numeric(summary.footAnchorXDrift);
  if (bottomDrift !== null && bottomDrift > 2) failures.push(`monster bottom drift ${bottomDrift}px exceeds 2px`);
  if (footAnchorXDrift !== null && footAnchorXDrift > 24) {
    failures.push(`monster foot anchor x drift ${footAnchorXDrift}px exceeds 24px`);
  }
  const maxAbsDy = numeric(finalization?.maxAbsDy);
  if (maxAbsDy !== null && maxAbsDy > 64) failures.push(`monster vertical alignment shift ${maxAbsDy}px exceeds 64px`);
  return failures;
}

async function main(): Promise<void> {
  const candidateDir = path.resolve(requireArg("--candidate"));
  const character = requireArg("--character");
  const state = requireArg("--state");
  const direction = requireArg("--direction");
  const nativeFacing = argValue("--native-facing") ?? direction;
  const outputArg = argValue("--output");
  const outputPath = path.resolve(outputArg ?? path.join(candidateDir, "manifests", "index.json"));

  const run = await readJson<CandidateRun>(path.join(candidateDir, "candidate-run.json"));
  const selection = await readJsonIfExists<FrameSelection>(path.join(candidateDir, "frame-selection.json"));
  const metadataPath = run.artifacts.runtimeMetadata;
  if (!metadataPath) {
    throw new Error("candidate-run.json does not point to a runtime metadata artifact");
  }
  const metadata = await readJson<RuntimeMetadata>(path.join(candidateDir, metadataPath));
  const finalization = run.artifacts.runtimeFinalization
    ? await readJsonIfExists<RuntimeFinalization>(path.join(candidateDir, run.artifacts.runtimeFinalization))
    : null;
  const sourceSelectedFrameIndices = run.selectedFrameIndices;
  const sourceSelectedFrameNames = await namesForIndices(candidateDir, run.artifacts.rawFrames, sourceSelectedFrameIndices);
  const pendingManualSelection =
    Boolean(selection?.selectedFrameIndices?.length) &&
    !sameNumbers(selection?.selectedFrameIndices, sourceSelectedFrameIndices);

  const key = `${character}-${state}-${direction}`;
  const sheetPath = run.artifacts.cleanedRuntimeSheet ?? run.artifacts.runtimeSheet;
  if (!sheetPath) {
    throw new Error("candidate-run.json does not point to a runtime sheet artifact");
  }
  const auditFailures = [...(run.audit?.failures ?? []), ...hardMonsterAnchorFailures(run, finalization)];

  const index = {
    meta: {
      version: 1,
      kind: "candidate-animation-index",
      root: candidateDir,
      generatedAt: new Date().toISOString(),
      promotedRuntimeIndex: "client/public/assets/index.json",
    },
    animations: {
      [key]: {
        character,
        state,
        direction,
        nativeFacing,
        path: sheetPath,
        atlasSize: {
          width: metadata.frameWidth * metadata.frameCount,
          height: metadata.frameHeight,
        },
        frameSize: {
          width: metadata.frameWidth,
          height: metadata.frameHeight,
        },
        columns: metadata.frameCount,
        rows: 1,
        frameCount: metadata.frameCount,
        runtimeFrameCount: metadata.frameCount,
        fps: metadata.fps ?? run.fps,
        loop: metadata.loop ?? run.loop,
        runtimeFrameOrder: range(metadata.frameCount),
        sourceSelectedFrameIndices,
        sourceSelectedFrameNames,
        status: statusFor(run),
        promotionBlocked: auditFailures.length > 0,
        sourceKind: run.sourceKind,
        sourcePath: run.sourcePath,
        keyColor: run.keyColor,
        review: {
          contactSheet: run.artifacts.selectedContact,
          broadContactSheet: run.artifacts.broadContact,
          numberedContactSheet: run.artifacts.numberedContact,
          previewGif: run.artifacts.selectedPreviewGif,
          runtimePreview: run.artifacts.runtimePreview,
          runtimePreviewGif: run.artifacts.runtimePreviewGif,
          reviewNotes: run.artifacts.reviewNotes,
          selectionPath: selection ? "frame-selection.json" : null,
          pendingManualSelection,
          cleanupReport: run.reports?.cleanup ?? null,
          auditReport: run.reports?.audit ?? null,
          finalizationReport: run.artifacts.runtimeFinalization,
        },
        anchor: {
          bodyHeight: metadata.bodyHeight ?? metadata.maxContentHeight ?? null,
          displayBodyHeight: metadata.displayBodyHeight ?? null,
          baselineY: metadata.baselineY ?? null,
          centerX: metadata.centerX ?? null,
          displaySize: metadata.displaySize ?? null,
          anchorXPolicy: metadata.anchorXPolicy ?? null,
        },
        audit: {
          failures: auditFailures,
          warnings: run.audit?.warnings ?? [],
          summary: run.audit?.summary ?? {},
        },
      },
    },
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outputPath, key, pendingManualSelection }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

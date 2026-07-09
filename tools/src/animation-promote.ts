import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type CandidateIndex = {
  meta: { root: string };
  animations: Record<string, CandidateAnimation>;
};

type CandidateAnimation = {
  character: string;
  state: string;
  direction: string;
  nativeFacing: string;
  path: string;
  atlasSize: { width: number; height: number };
  frameSize: { width: number; height: number };
  columns: number;
  rows: number;
  frameCount: number;
  fps: number;
  loop: boolean;
  runtimeFrameOrder: number[];
  sourceSelectedFrameIndices: number[];
  sourceSelectedFrameNames: string[];
  status: string;
  promotionBlocked: boolean;
  sourceKind: string;
  sourcePath: string;
  keyColor: string | null;
  review: Record<string, unknown>;
  anchor: Record<string, unknown>;
  audit: { failures: string[]; warnings: string[]; summary: Record<string, unknown> };
};

type PromotedIndex = {
  meta: {
    version: number;
    root: string;
    generatedAt: string;
    defaultFrameSize?: { width: number; height: number };
    defaultShootFps?: number;
    defaultWalkFps?: number;
  };
  animations: Record<string, PromotedAnimation>;
};

type PromotedAnimation = Omit<CandidateAnimation, "path" | "status" | "promotionBlocked"> & {
  path: string;
  metadataPath: string | null;
  status: "promoted";
  promotedAt: string;
  candidateRoot: string;
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

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function publicPath(assetRoot: string, filePath: string): string {
  return path.relative(assetRoot, filePath).split(path.sep).join("/");
}

function metadataNameFor(sheetName: string): string {
  return sheetName.replace(/\.[^.]+$/, ".metadata.json");
}

function reportMarkdown(details: {
  key: string;
  apply: boolean;
  blocked: string[];
  warnings: string[];
  targetSheet: string;
  targetMetadata: string | null;
  targetIndex: string;
  candidateRoot: string;
  sourceSheet: string;
}): string {
  const lines = [
    "# Animation Promotion Proposal",
    "",
    `Candidate: \`${details.key}\``,
    `Mode: ${details.apply ? "apply" : "dry-run"}`,
    "",
    "## Targets",
    "",
    `- Sheet: \`${details.targetSheet}\``,
    `- Metadata: ${details.targetMetadata ? `\`${details.targetMetadata}\`` : "none"}`,
    `- Runtime index: \`${details.targetIndex}\``,
    "",
    "## Source",
    "",
    `- Candidate root: \`${details.candidateRoot}\``,
    `- Runtime sheet: \`${details.sourceSheet}\``,
    "",
    "## Audit",
    "",
    details.blocked.length ? `Blocked:\n${details.blocked.map((item) => `- ${item}`).join("\n")}` : "Blocked: none",
    "",
    details.warnings.length ? `Warnings:\n${details.warnings.map((item) => `- ${item}`).join("\n")}` : "Warnings: none",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const candidateDir = path.resolve(requireArg("--candidate"));
  const keyArg = argValue("--key");
  const assetRoot = path.resolve(argValue("--asset-root") ?? "client/public/assets");
  const indexPath = path.resolve(argValue("--index") ?? path.join(assetRoot, "index.json"));
  const targetDir = path.resolve(argValue("--target-dir") ?? path.join(assetRoot, "sprites"));
  const targetNameArg = argValue("--target-name");
  const apply = hasFlag("--apply");
  const overwrite = hasFlag("--overwrite");

  const candidateIndex = await readJson<CandidateIndex>(path.join(candidateDir, "manifests", "index.json"));
  const keys = Object.keys(candidateIndex.animations);
  const key = keyArg ?? keys[0];
  if (!key || !candidateIndex.animations[key]) {
    throw new Error(`Candidate animation key not found. Available: ${keys.join(", ")}`);
  }

  const candidate = candidateIndex.animations[key];
  const candidateRoot = candidateIndex.meta.root || candidateDir;
  const sourceSheet = path.resolve(candidateRoot, candidate.path);
  const sourceMetadata = path.resolve(
    candidateRoot,
    String(candidate.review.finalizationReport ?? "").replace(/_finalize-runtime\.json$/, ".metadata.json"),
  );
  const targetBaseName = targetNameArg ?? key.replace(/[^a-z0-9_-]+/gi, "_");
  const targetSheet = path.join(targetDir, `${targetBaseName}${path.extname(candidate.path) || ".webp"}`);
  const targetMetadata = path.join(targetDir, metadataNameFor(path.basename(targetSheet)));
  const promotionDir = path.join(candidateDir, "promotion");
  const proposedIndexPath = path.join(promotionDir, "proposed-index.json");
  const reportPath = path.join(promotionDir, "promotion-report.md");
  const now = new Date().toISOString();

  const blocked: string[] = [];
  if (candidate.promotionBlocked) blocked.push("candidate index marks promotionBlocked=true");
  if (candidate.review.pendingManualSelection) blocked.push("frame-selection.json differs from the current runtime sheet");
  for (const failure of candidate.audit.failures ?? []) blocked.push(`audit failure: ${failure}`);
  if (!(await exists(sourceSheet))) blocked.push(`runtime sheet missing: ${sourceSheet}`);
  const metadataExists = await exists(sourceMetadata);
  if (!metadataExists) blocked.push(`runtime metadata missing: ${sourceMetadata}`);
  if (!overwrite && (await exists(targetSheet))) blocked.push(`target sheet already exists: ${targetSheet}`);
  if (!overwrite && (await exists(targetMetadata))) blocked.push(`target metadata already exists: ${targetMetadata}`);

  const existingIndex = (await readJsonIfExists<PromotedIndex>(indexPath)) ?? {
    meta: {
      version: 1,
      root: publicPath(path.dirname(assetRoot), assetRoot),
      generatedAt: now,
      defaultFrameSize: { width: candidate.frameSize.width, height: candidate.frameSize.height },
      defaultShootFps: 10,
      defaultWalkFps: 8,
    },
    animations: {},
  };

  const { path: _candidatePath, status: _candidateStatus, promotionBlocked: _candidatePromotionBlocked, ...candidateFields } =
    candidate;
  const promoted: PromotedAnimation = {
    ...candidateFields,
    path: publicPath(assetRoot, targetSheet),
    metadataPath: metadataExists ? publicPath(assetRoot, targetMetadata) : null,
    status: "promoted",
    promotedAt: now,
    candidateRoot: path.relative(process.cwd(), candidateDir).split(path.sep).join("/"),
  };
  const proposedIndex: PromotedIndex = {
    ...existingIndex,
    meta: {
      ...existingIndex.meta,
      generatedAt: now,
    },
    animations: {
      ...existingIndex.animations,
      [key]: promoted,
    },
  };

  await mkdir(promotionDir, { recursive: true });
  await writeFile(proposedIndexPath, `${JSON.stringify(proposedIndex, null, 2)}\n`, "utf8");
  await writeFile(
    reportPath,
    reportMarkdown({
      key,
      apply,
      blocked,
      warnings: candidate.audit.warnings ?? [],
      targetSheet,
      targetMetadata: metadataExists ? targetMetadata : null,
      targetIndex: indexPath,
      candidateRoot,
      sourceSheet,
    }),
    "utf8",
  );

  if (apply) {
    if (blocked.length > 0) {
      throw new Error(`Promotion blocked; see ${reportPath}`);
    }
    await mkdir(targetDir, { recursive: true });
    await copyFile(sourceSheet, targetSheet);
    if (metadataExists) await copyFile(sourceMetadata, targetMetadata);
    await writeFile(indexPath, `${JSON.stringify(proposedIndex, null, 2)}\n`, "utf8");
  }

  console.log(
    JSON.stringify(
      {
        key,
        mode: apply ? "apply" : "dry-run",
        blocked,
        reportPath,
        proposedIndexPath,
        targetSheet,
        targetIndex: indexPath,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

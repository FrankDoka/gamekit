import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assetsRoot as defaultAssetsRoot } from "./toolkit-config.js";

type RegistryEntry = {
  sourcePath?: string;
  targetPath?: string;
};

export type ArchiveResolvedMove = {
  batchRoot: string;
  archiveTarget: string;
  finalFiles: string[];
};

type ArchivePlan = {
  moves: ArchiveResolvedMove[];
  skipped: Array<{ batchRoot: string; reason: string; finalFiles: string[]; missing: string[] }>;
};

const finalExt = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp3", ".wav", ".ogg", ".mp4", ".webm"]);

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function walk(dir: string, visit: (filePath: string) => Promise<void>): Promise<void> {
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith("_") && !entry.name.startsWith("_incoming")) continue;
      await walk(full, visit);
    } else if (entry.isFile()) {
      await visit(full);
    }
  }
}

function batchRootForFinalFile(assetsRoot: string, filePath: string): string | undefined {
  const relParts = path.relative(assetsRoot, filePath).replaceAll("\\", "/").split("/");
  const finalIndex = relParts.lastIndexOf("final");
  if (finalIndex <= 0) return undefined;
  return path.join(assetsRoot, ...relParts.slice(0, finalIndex));
}

export async function planArchiveResolved(options: {
  assetsRoot: string;
  archiveRoot: string;
  publicAssetsRoot: string;
  registry: { promoted?: Record<string, RegistryEntry> };
}): Promise<ArchivePlan> {
  const batches = new Map<string, string[]>();
  await walk(options.assetsRoot, async (filePath) => {
    if (!finalExt.has(path.extname(filePath).toLowerCase())) return;
    const root = batchRootForFinalFile(options.assetsRoot, filePath);
    if (!root) return;
    const list = batches.get(root) ?? [];
    list.push(path.relative(options.assetsRoot, filePath).replaceAll("\\", "/"));
    batches.set(root, list);
  });

  const entries = Object.values(options.registry.promoted ?? {});
  const moves: ArchiveResolvedMove[] = [];
  const skipped: ArchivePlan["skipped"] = [];
  for (const [batchRoot, finalFiles] of batches) {
    const missing = finalFiles.filter((rel) => {
      const entry = entries.find((candidate) => candidate.sourcePath === rel);
      if (!entry?.targetPath) return true;
      return !existsSync(path.join(options.publicAssetsRoot, entry.targetPath.replace(/^assets\//, "")));
    });
    if (missing.length) {
      skipped.push({ batchRoot, reason: "not every final file has a live promoted runtime target", finalFiles, missing });
      continue;
    }
    const archiveTarget = path.join(options.archiveRoot, path.relative(options.assetsRoot, batchRoot));
    moves.push({ batchRoot, archiveTarget, finalFiles });
  }
  moves.sort((a, b) => a.batchRoot.localeCompare(b.batchRoot));
  skipped.sort((a, b) => a.batchRoot.localeCompare(b.batchRoot));
  return { moves, skipped };
}

async function applyArchivePlan(plan: ArchivePlan): Promise<void> {
  for (const move of plan.moves) {
    await mkdir(path.dirname(move.archiveTarget), { recursive: true });
    if (existsSync(move.archiveTarget)) {
      throw new Error(`archive target already exists: ${move.archiveTarget}`);
    }
    await rename(move.batchRoot, move.archiveTarget);
  }
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(argValue("--repo-root") ?? ".");
  const assetsRoot = path.resolve(argValue("--assets-root") ?? defaultAssetsRoot());
  // Archive root defaults to a sibling of the assets root (mirrors <assetsRoot>-metadata),
  // so it tracks ASSETS_ROOT instead of hardcoding a machine-specific path. Override with
  // --archive-root or the ASSETS_ARCHIVE_ROOT env var.
  const archiveRoot = path.resolve(argValue("--archive-root") ?? process.env.ASSETS_ARCHIVE_ROOT ?? `${assetsRoot}-archive`);
  const publicAssetsRoot = path.resolve(argValue("--public-assets-root") ?? path.join(repoRoot, "client", "public", "assets"));
  const registryPath = path.resolve(argValue("--registry") ?? path.join(publicAssetsRoot, "promoted-registry.json"));
  const apply = process.argv.includes("--apply");
  const json = process.argv.includes("--json");
  const registry = await readJson<{ promoted?: Record<string, RegistryEntry> }>(registryPath, { promoted: {} });
  const plan = await planArchiveResolved({ assetsRoot, archiveRoot, publicAssetsRoot, registry });
  if (apply) await applyArchivePlan(plan);
  const payload = { ok: true, apply, assetsRoot, archiveRoot, moves: plan.moves, skipped: plan.skipped };
  if (json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else {
    console.log(`${apply ? "Archived" : "Would archive"} ${plan.moves.length} resolved batch(es).`);
    for (const move of plan.moves) {
      console.log(`- ${move.batchRoot} -> ${move.archiveTarget} (${move.finalFiles.length} final file(s))`);
    }
    if (plan.skipped.length) console.log(`Skipped ${plan.skipped.length} unresolved batch(es).`);
  }
  if (apply) {
    const stampPath = path.join(archiveRoot, "archive-resolved-last-run.json");
    await mkdir(path.dirname(stampPath), { recursive: true });
    await writeFile(stampPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

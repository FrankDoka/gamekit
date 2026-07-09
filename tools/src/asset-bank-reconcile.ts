import { existsSync, readdirSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type JsonRecord = Record<string, unknown>;

export type CatalogAsset = JsonRecord & { id?: string; path?: string; category?: string; kind?: string; status?: string };
export type ReviewRecord = JsonRecord & { id?: string; decision?: string; status?: string; notes?: string; path?: string };
export type PromotedEntry = {
  assetId?: string;
  sourcePath?: string;
  targetPath?: string;
  targetName?: string;
  type?: string;
  category?: string;
  kind?: string;
};

export type ReconcileOptions = {
  repoRoot: string;
  assetsRoot: string;
  metadataRoot: string;
  dataPath?: string;
  statusPath?: string;
  registryPath?: string;
  outputPath?: string;
  apply?: boolean;
  reportOnly?: boolean;
  now?: Date;
};

export type ReconcileVerdict = {
  ok: boolean;
  driftCount: number;
  changedReviews: Array<{ id: string; from?: ReviewRecord; to: ReviewRecord; reason: string }>;
  normalizedReviews: Array<{ id: string; from: string; to: string }>;
  ingestedAssets: CatalogAsset[];
  orphans: {
    inGameNoBankEntry: Array<{ runtimePath: string; registryKey?: string; sourcePath?: string; reason: string }>;
    bankPromotedNotInGame: Array<{ id: string; path?: string; reason: string }>;
  };
  references: { runtimePaths: string[]; targetNames: string[] };
  wrote?: { dataPath?: string; statusPath?: string; verdictPath?: string };
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const supportedRuntimeExt = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp3", ".ogg", ".wav", ".json"]);
const runtimeDirs = ["sprites", "audio", "tiles", "tilesets", "props", "decals", "ui", "vfx", "loading"];
const allowedReviewStatus = new Set(["candidate", "accepted", "rejected", "needs-cleanup", "promote-later", "considered", "later", "pending-related", "hidden", "broken-preview", "promoted"]);

function isoSeconds(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "");
}

function slash(value: string): string {
  return value.replace(/\\/g, "/");
}

function runtimeRelFromPublicAssets(rel: string): string {
  return slash(rel).replace(/^assets\//, "");
}

function assetIdFromPath(relativePath: string): string {
  return slash(relativePath).replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase();
}

function normalizedReviewStatus(status: unknown, decision: unknown): string {
  if (decision === "runtime-promoted") return "promoted";
  if (typeof status === "string") {
    const lower = status.toLowerCase();
    if (allowedReviewStatus.has(lower)) return lower;
  }
  if (decision === "accepted") return "accepted";
  return "candidate";
}

export function normalizeReviewRecord(review: ReviewRecord): { review: ReviewRecord; changed?: { from: string; to: string } } {
  const from = typeof review.status === "string" ? review.status : "";
  const to = normalizedReviewStatus(review.status, review.decision);
  if (from === to) return { review };
  return { review: { ...review, status: to }, changed: { from, to } };
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  if (existsSync(filePath)) await copyFile(filePath, `${filePath}.prev`).catch(() => undefined);
  const tmp = path.join(path.dirname(filePath), `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    await rename(tmp, filePath);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function withReviewLock<T>(reviewRoot: string, work: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
  await mkdir(reviewRoot, { recursive: true });
  const lockPath = path.join(reviewRoot, ".review.lock");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number((await readFile(lockPath, "utf8").catch(() => "-1")).trim() || "-1");
      if (holder > 0 && !pidAlive(holder)) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) throw new Error(`review lock held by live pid ${holder} after ${timeoutMs / 1000}s`);
      await sleep(25);
    }
  }
  try {
    return await work();
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

export async function updateReviewStatusFile(
  statusPath: string,
  mutate: (status: { reviews: ReviewRecord[]; [key: string]: unknown }) => void | Promise<void>,
): Promise<{ reviews: ReviewRecord[]; [key: string]: unknown }> {
  const reviewRoot = path.dirname(statusPath);
  return withReviewLock(reviewRoot, async () => {
    const status = await readJson<{ reviews: ReviewRecord[]; [key: string]: unknown }>(statusPath, { reviews: [] });
    status.reviews = Array.isArray(status.reviews) ? status.reviews : [];
    await mutate(status);
    const normalized: ReviewRecord[] = [];
    const byId = new Map<string, ReviewRecord>();
    for (const review of status.reviews) {
      if (!review.id) continue;
      const { review: clean } = normalizeReviewRecord(review);
      byId.set(review.id, clean);
    }
    normalized.push(...byId.values());
    status.reviews = normalized;
    status.generated_at = isoSeconds();
    await writeJsonAtomic(statusPath, status);
    return status;
  });
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

async function referencedRuntimeAssets(repo: string, registry: Record<string, PromotedEntry>): Promise<{ runtimePaths: Set<string>; targetNames: Set<string> }> {
  const publicRoot = path.join(repo, "client", "public", "assets");
  const runtimePaths = new Set<string>();
  const targetNames = new Set<string>();
  for (const entry of Object.values(registry)) {
    if (entry.targetPath) runtimePaths.add(runtimeRelFromPublicAssets(entry.targetPath));
    if (entry.targetName) targetNames.add(entry.targetName);
  }
  const scanRoots = [path.join(repo, "content"), path.join(repo, "client", "src", "config")];
  for (const root of scanRoots) {
    for (const file of await walkFiles(root)) {
      if (![".json", ".ts"].includes(path.extname(file).toLowerCase())) continue;
      const text = await readFile(file, "utf8").catch(() => "");
      for (const match of text.matchAll(/assets\/[a-z0-9_./-]+\.(?:png|webp|jpg|jpeg|gif|mp3|ogg|wav|json)/gi)) {
        runtimePaths.add(runtimeRelFromPublicAssets(match[0]));
      }
      for (const target of targetNames) if (text.includes(target)) runtimePaths.add(runtimeRelFromPublicAssets(registryEntryByTarget(registry, target)?.targetPath ?? ""));
    }
  }
  for (const rel of await walkRuntime(publicRoot)) runtimePaths.add(rel);
  runtimePaths.delete("");
  return { runtimePaths, targetNames };
}

function registryEntryByTarget(registry: Record<string, PromotedEntry>, targetName: string): PromotedEntry | undefined {
  return Object.values(registry).find((entry) => entry.targetName === targetName);
}

async function walkRuntime(publicRoot: string): Promise<string[]> {
  const out: string[] = [];
  for (const dir of runtimeDirs) {
    const root = path.join(publicRoot, dir);
    for (const file of await walkFiles(root)) {
      if (!supportedRuntimeExt.has(path.extname(file).toLowerCase())) continue;
      out.push(slash(path.relative(publicRoot, file)));
    }
  }
  return out.sort();
}

function buildCatalogIndexes(assets: CatalogAsset[]): {
  byId: Map<string, CatalogAsset>;
  byPath: Map<string, CatalogAsset>;
  byBasename: Map<string, CatalogAsset[]>;
} {
  const byId = new Map<string, CatalogAsset>();
  const byPath = new Map<string, CatalogAsset>();
  const byBasename = new Map<string, CatalogAsset[]>();
  for (const asset of assets) {
    if (asset.id) byId.set(asset.id, asset);
    if (asset.path) {
      const rel = slash(asset.path).toLowerCase();
      byPath.set(rel, asset);
      const base = path.basename(rel);
      byBasename.set(base, [...(byBasename.get(base) ?? []), asset]);
    }
  }
  return { byId, byPath, byBasename };
}

function catalogMatchForRuntime(runtimeRel: string, registryEntry: PromotedEntry | undefined, indexes: ReturnType<typeof buildCatalogIndexes>): CatalogAsset | undefined {
  const sourcePath = registryEntry?.sourcePath ? slash(registryEntry.sourcePath).toLowerCase() : "";
  if (sourcePath && indexes.byPath.has(sourcePath)) return indexes.byPath.get(sourcePath);
  if (registryEntry?.assetId && indexes.byId.has(registryEntry.assetId)) return indexes.byId.get(registryEntry.assetId);
  const runtimeBase = path.basename(runtimeRel).toLowerCase();
  const byBase = indexes.byBasename.get(runtimeBase);
  if (byBase?.length === 1) return byBase[0];
  return undefined;
}

function runtimeOnlyCategory(runtimeRel: string): string {
  const lower = runtimeRel.toLowerCase();
  const seg0 = lower.split("/")[0] ?? "";
  const name = lower.split("/").pop() ?? "";
  if ([".mp3", ".wav", ".ogg"].some((ext) => lower.endsWith(ext)) || seg0 === "audio") return "audio";
  if (seg0 === "sprites") {
    if (name.startsWith("npc_")) return "npcs";
    if (name.startsWith("monster_")) return "monsters";
    if (name.startsWith("player")) return "players";
    return "unknown";
  }
  if (seg0 === "tiles" || seg0 === "tilesets") return "tilesets";
  if (seg0 === "props") return "props";
  if (seg0 === "decals") return "decals";
  if (seg0 === "vfx") return "vfx";
  if (seg0 === "ui" || seg0 === "loading") return lower.includes("portrait") ? "portraits" : "ui";
  if (seg0 === "icons") return "icons";
  return "unknown";
}

function runtimeOnlyCatalogAsset(runtimeRel: string, registryEntry: PromotedEntry | undefined): CatalogAsset | undefined {
  if (runtimeRel.toLowerCase().endsWith(".json")) return undefined; // manifests/registries are not assets
  // Reuse the promoted-registry asset id when it exists: zone packs, collections, and
  // entity profiles reference that id — a fresh id would strand them (owner report
  // 2026-07-06: archived props left zone-pack tiles dangling grey).
  const id = registryEntry?.assetId ?? assetIdFromPath(runtimeRel);
  const category = runtimeOnlyCategory(runtimeRel);
  return {
    id,
    name: id,
    path: `runtime-only/${runtimeRel}`,
    category,
    kind: category === "audio" ? "audio" : "sprite",
    status: "candidate",
    tags: ["runtime-only-source"],
  };
}

export async function reconcileAssetBank(options: ReconcileOptions): Promise<ReconcileVerdict> {
  const reviewRoot = path.join(options.metadataRoot, "_review");
  const dataPath = options.dataPath ?? path.join(reviewRoot, "asset-review-data.json");
  const statusPath = options.statusPath ?? path.join(reviewRoot, "asset-review-status.json");
  const registryPath = options.registryPath ?? path.join(options.repoRoot, "client", "public", "assets", "promoted-registry.json");
  const data = await readJson<{ assets: CatalogAsset[]; [key: string]: unknown }>(dataPath, { assets: [] });
  const status = await readJson<{ reviews: ReviewRecord[]; [key: string]: unknown }>(statusPath, { reviews: [] });
  const registry = await readJson<{ promoted?: Record<string, PromotedEntry> }>(registryPath, { promoted: {} });
  data.assets = Array.isArray(data.assets) ? data.assets : [];
  status.reviews = Array.isArray(status.reviews) ? status.reviews : [];

  const registryEntries = registry.promoted ?? {};
  const registryByRuntime = new Map<string, [string, PromotedEntry]>();
  for (const [key, entry] of Object.entries(registryEntries)) {
    if (entry.targetPath) registryByRuntime.set(runtimeRelFromPublicAssets(entry.targetPath), [key, entry]);
  }
  const references = await referencedRuntimeAssets(options.repoRoot, registryEntries);
  const indexes = buildCatalogIndexes(data.assets);
  const reviewById = new Map(status.reviews.filter((review) => review.id).map((review) => [review.id!, review]));
  const changedReviews: ReconcileVerdict["changedReviews"] = [];
  const normalizedReviews: ReconcileVerdict["normalizedReviews"] = [];
  const ingestedAssets: CatalogAsset[] = [];
  const inGameNoBankEntry: ReconcileVerdict["orphans"]["inGameNoBankEntry"] = [];

  for (const review of status.reviews) {
    const normalized = normalizeReviewRecord(review);
    if (normalized.changed && review.id) normalizedReviews.push({ id: review.id, ...normalized.changed });
  }

  for (const runtimeRel of references.runtimePaths) {
    const [registryKey, entry] = registryByRuntime.get(runtimeRel) ?? [];
    const match = catalogMatchForRuntime(runtimeRel, entry, indexes);
    if (!match?.id) {
      const ingest = runtimeOnlyCatalogAsset(runtimeRel, entry);
      if (ingest && !indexes.byId.has(ingest.id!)) {
        ingestedAssets.push(ingest);
        indexes.byId.set(ingest.id!, ingest);
        indexes.byPath.set(String(ingest.path).toLowerCase(), ingest);
        inGameNoBankEntry.push({ runtimePath: runtimeRel, registryKey, sourcePath: entry?.sourcePath, reason: `runtime ${ingest.category} had no bank source; registered runtime-only-source` });
      } else {
        inGameNoBankEntry.push({ runtimePath: runtimeRel, registryKey, sourcePath: entry?.sourcePath, reason: "runtime referenced but no catalog source matched" });
      }
      continue;
    }
    const existing = reviewById.get(match.id);
    if (existing?.decision === "runtime-promoted" && normalizedReviewStatus(existing.status, existing.decision) === "promoted") continue;
    const to: ReviewRecord = {
      ...(existing ?? {}),
      id: match.id,
      path: match.path,
      decision: "runtime-promoted",
      status: "promoted",
      priority: "normal",
      notes: `Reconcile: runtime references ${runtimeRel}${entry?.sourcePath ? ` from ${entry.sourcePath}` : ""}.`,
      updated_at: isoSeconds(options.now),
    };
    changedReviews.push({ id: match.id, from: existing, to, reason: "catalog asset is live in-game" });
    reviewById.set(match.id, to);
  }

  const bankPromotedNotInGame: ReconcileVerdict["orphans"]["bankPromotedNotInGame"] = [];
  for (const review of status.reviews) {
    if (review.decision !== "runtime-promoted" || !review.id) continue;
    const asset = indexes.byId.get(review.id);
    const entry = Object.values(registryEntries).find((candidate) => candidate.assetId === review.id || candidate.sourcePath === asset?.path);
    const runtimeRel = entry?.targetPath ? runtimeRelFromPublicAssets(entry.targetPath) : "";
    if (!runtimeRel || !references.runtimePaths.has(runtimeRel)) {
      bankPromotedNotInGame.push({ id: review.id, path: asset?.path ?? review.path, reason: "review says runtime-promoted but no current runtime reference matched" });
    }
  }

  const driftCount = changedReviews.length + normalizedReviews.length + ingestedAssets.length + inGameNoBankEntry.length + bankPromotedNotInGame.length;
  const verdict: ReconcileVerdict = {
    ok: inGameNoBankEntry.length === 0 && bankPromotedNotInGame.length === 0,
    driftCount,
    changedReviews,
    normalizedReviews,
    ingestedAssets,
    orphans: { inGameNoBankEntry, bankPromotedNotInGame },
    references: { runtimePaths: [...references.runtimePaths].sort(), targetNames: [...references.targetNames].sort() },
  };

  if (options.apply && !options.reportOnly) {
    await withReviewLock(path.dirname(statusPath), async () => {
      const freshStatus = await readJson<{ reviews: ReviewRecord[]; [key: string]: unknown }>(statusPath, { reviews: [] });
      const byId = new Map((Array.isArray(freshStatus.reviews) ? freshStatus.reviews : []).filter((review) => review.id).map((review) => [review.id!, normalizeReviewRecord(review).review]));
      for (const change of changedReviews) byId.set(change.id, change.to);
      freshStatus.reviews = [...byId.values()];
      freshStatus.generated_at = isoSeconds(options.now);
      await writeJsonAtomic(statusPath, freshStatus);
      if (ingestedAssets.length) {
        const freshData = await readJson<{ assets: CatalogAsset[]; [key: string]: unknown }>(dataPath, { assets: [] });
        const existing = new Set((freshData.assets ?? []).map((asset) => asset.id));
        freshData.assets = [...(freshData.assets ?? []), ...ingestedAssets.filter((asset) => asset.id && !existing.has(asset.id))];
        freshData.generated_at = isoSeconds(options.now);
        await writeJsonAtomic(dataPath, freshData);
      }
    });
    verdict.wrote = { dataPath: ingestedAssets.length ? dataPath : undefined, statusPath };
  }

  if (options.outputPath) {
    await writeJsonAtomic(options.outputPath, verdict);
    verdict.wrote = { ...(verdict.wrote ?? {}), verdictPath: options.outputPath };
  }
  return verdict;
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const metadataRoot = path.resolve(argValue(args, "--metadata-root") ?? path.join(repoRoot, "tmp", "asset-bank-reconcile-fixture", "Assets-metadata"));
  const outputPath = path.resolve(argValue(args, "--out") ?? path.join(os.tmpdir(), `asset-bank-reconcile-${Date.now()}.json`));
  const verdict = await reconcileAssetBank({
    repoRoot: path.resolve(argValue(args, "--repo-root") ?? repoRoot),
    assetsRoot: path.resolve(argValue(args, "--assets-root") ?? path.join(repoRoot, "tmp", "asset-bank-reconcile-fixture", "Assets")),
    metadataRoot,
    dataPath: argValue(args, "--data"),
    statusPath: argValue(args, "--status"),
    registryPath: argValue(args, "--registry"),
    outputPath,
    apply: args.includes("--apply"),
    reportOnly: args.includes("--report-only"),
  });
  console.log(JSON.stringify({ ok: verdict.ok, driftCount: verdict.driftCount, orphans: verdict.orphans, changed: verdict.changedReviews.length, normalized: verdict.normalizedReviews.length, ingested: verdict.ingestedAssets.length, verdictPath: outputPath }, null, 2));
  if (!verdict.ok && !args.includes("--report-only")) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { readRegistryStrict, unpromoteEntry } from "./promoted-registry.js";
import { promoteKeyFromPath } from "./promote-key.js";
import { byteRangeFor } from "./http-range.js";
import { promotionOverwriteDecision } from "./promotion-overwrite-guard.js";
import { promoteToRuntime } from "./lib/promote-to-runtime.js";
import { repointEntityProfiles } from "./assets-repoint-entities.js";
import { reconcileAssetBank, updateReviewStatusFile } from "./asset-bank-reconcile.js";
import { type RepoRoot, isRepoSourceDeliverable, repoCatalogPath, repoCategory, repoKind, repoRootFingerprint, walkRepoRoot } from "./bank-repo-roots.js";

const execFileAsync = promisify(execFile);

type JsonRecord = Record<string, unknown>;
type AssetRecord = JsonRecord & {
  id?: string;
  name?: string;
  path?: string;
  category?: string;
  kind?: string;
  subcategory?: string;
  status?: string;
  /** "bank" (Z:/Assets), "repo-runtime", or "repo-source". Absent === legacy "bank". */
  origin?: string;
  tags?: string[];
  image?: { width?: number; height?: number } | null;
  review?: { decision?: string; hidden?: boolean };
};

/** A repo-origin row is READ-ONLY to the bank (no promote/accept/remove); it is already downstream of the pipeline. */
function isRepoOrigin(asset: AssetRecord | undefined): boolean {
  return asset?.origin === "repo-runtime" || asset?.origin === "repo-source";
}
type ReviewRecord = JsonRecord & { id?: string; decision?: string; status?: string; notes?: string; path?: string };
type RuntimeAssetResolveOptions = {
  repoRoot: string;
  exists?: (filePath: string) => boolean;
};

export type AssetBankConfig = {
  repoRoot: string;
  assetsRoot: string;
  metadataRoot: string;
  /** Repo asset roots catalogued alongside assetsRoot, READ-ONLY (see bank-repo-roots.ts). */
  repoRoots?: RepoRoot[];
  sessionToken: string;
  sendJson(response: ServerResponse, statusCode: number, payload: unknown): void;
  sendText(response: ServerResponse, statusCode: number, text: string): void;
  readRequestJson(request: IncomingMessage): Promise<Record<string, unknown>>;
};

const allowedReviewDecisions = new Set([
  "accepted",
  "rejected",
  "needs-cleanup",
  "promote-later",
  "considered",
  "later",
  "pending-related",
  "hidden",
  "broken-preview",
  "runtime-promoted",
  "unreviewed",
]);
const allowedReviewStatuses = new Set(["candidate", "accepted", "rejected", "needs-cleanup", "promote-later", "considered", "later", "pending-related", "hidden", "broken-preview", "promoted"]);

const imageExt = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const fringeGateExt = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const supportedExt = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp3", ".wav", ".ogg", ".mp4", ".mov", ".webm", ".md", ".json", ".txt"]);
const skipDirs = new Set([
  "node_modules",
  ".git",
  "__pycache__",
  "dist",
  ".venv",
  "_review",
  "_sliced",
  "archive",
  "_archive",
  "thumbs",
  ".thumbs",
  "_promotion-plans",
  "frames",
  "_cleanup",
  "_cleanup-backups",
  "_deleted",
  "_rejected",
  "_runtime-ready-packs",
  "_previews",
  // Non-asset artifact roots (2026-07-02): capture proofs, session staging, and QA
  // sheets polluted the review grid as 479 "unknown" assets + fake "Backgrounds".
  "_captures",
  "_staging",
  "qa",
  "_qa",
  "qa_cleanup",
  "matte-test",
  "_structural-reference",
  // Owner/AI sandbox evidence (2026-07-08): owner_testing held FAILED hair-conformance
  // candidates + clip rejects; the bank indexed 166 of them as assets and the owner
  // judged rejected material believing it current. Evidence space is never catalog input.
  "owner_testing",
]);

// Any directory whose name starts with one of these is quarantine/recovery space, never
// catalog input (a `_rejected-flat-vector` quarantine bypassed the literal `_rejected`
// match and surfaced rejected art as unreviewed props).
const skipDirPrefixes = ["_rejected", "_archive", "_deleted"];

function isSkippedDir(name: string): boolean {
  return skipDirs.has(name) || skipDirPrefixes.some((p) => name.startsWith(p));
}
const qualityLimits: Record<string, { maxW?: number; maxH?: number; maxBytes?: number; formats?: Set<string> }> = {
  tile: { maxW: 512, maxH: 512, formats: new Set([".png"]) },
  decal: { maxW: 512, maxH: 512, formats: new Set([".png"]) },
  prop: { maxW: 512, maxH: 512, formats: new Set([".png"]) },
  sprite: { maxW: 512, maxH: 512, formats: new Set([".png"]) },
  icon: { maxW: 128, maxH: 128, formats: new Set([".png"]) },
  portrait: { maxW: 512, maxH: 512, formats: new Set([".png"]) },
  vfx: { maxW: 1024, maxH: 1024, formats: new Set([".png"]) },
  audio: { maxBytes: 10 * 1024 * 1024, formats: new Set([".ogg", ".mp3", ".wav"]) },
  bgm: { maxBytes: 10 * 1024 * 1024, formats: new Set([".ogg", ".mp3", ".wav"]) },
  ambience: { maxBytes: 10 * 1024 * 1024, formats: new Set([".ogg", ".mp3", ".wav"]) },
};
const assetTypeDirs: Record<string, string> = {
  tile: "tiles",
  ground_tiles: "tiles",
  decal: "decals",
  prop: "props",
  sprite: "sprites",
  icon: "sprites",
  portrait: "sprites",
  vfx: "vfx",
  audio: "audio",
  bgm: "audio/music",
  ambience: "audio/ambience",
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
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

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "asset";
}

function pathAssetId(relativePath: string): string {
  return relativePath.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
}

function normalizedAssetRelPath(value: unknown): string {
  return typeof value === "string" ? value.replace(/\\/g, "/").toLowerCase() : "";
}

function isoSeconds(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "");
}

function normalizedReviewStatus(status: unknown, decision: unknown): string {
  if (decision === "runtime-promoted") return "promoted";
  if (typeof status === "string" && allowedReviewStatuses.has(status.toLowerCase())) return status.toLowerCase();
  if (decision === "accepted") return "accepted";
  return "candidate";
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".ogg": "audio/ogg",
      ".woff2": "font/woff2",
    }[ext] ?? "application/octet-stream"
  );
}

export function resolveRuntimeAssetPath(id: string, options: RuntimeAssetResolveOptions): string | undefined {
  const exists = options.exists ?? existsSync;
  const root = path.join(options.repoRoot, "client", "public", "assets");
  const normalized = id.replace(/\\/g, "/");
  if (normalized.startsWith("assets/")) {
    const target = path.resolve(options.repoRoot, "client", "public", normalized);
    if (isInside(target, path.join(options.repoRoot, "client", "public")) && exists(target)) return target;
  }

  const base = normalized.replace(/\.(png|webp|jpe?g|gif|mp3|ogg|wav|webm)$/i, "");
  if (!base || base.includes("/") || base.includes("\\") || base.includes("..")) return undefined;
  const imgDirs = ["sprites", "sprites/fallback/wayfarer", "ui/portraits", "ui/icons", "ui/cursors", "ui/frames", "props", "decals", "tiles", "loading", "vfx"];
  const imgExts = ["png", "webp", "jpg", "jpeg", "gif"];
  for (const d of imgDirs) for (const e of imgExts) {
    const p = path.join(root, ...d.split("/"), `${base}.${e}`);
    if (exists(p)) return p;
  }

  const audioRoot = path.join(root, "audio");
  const audioExts = ["mp3", "ogg", "wav"];
  const stack = [audioRoot];
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
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (audioExts.includes(ext) && path.basename(entry.name, path.extname(entry.name)) === base && exists(full)) return full;
    }
  }
  return undefined;
}

async function readJsonLoose<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function readJsonStrict(filePath: string, required: Record<string, "array" | "object">): Promise<JsonRecord> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    // A store that has never been written yet is a healthy empty state, not corruption.
    // Synthesize the required shape so callers (e.g. the health report) don't 500 on a fresh
    // bank where no review/related-group has been saved. A present-but-malformed file still throws.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const skeleton: JsonRecord = {};
      for (const [key, shape] of Object.entries(required)) skeleton[key] = shape === "array" ? [] : {};
      return skeleton;
    }
    throw error;
  }
  const data = JSON.parse(raw) as unknown;
  if (!isRecord(data)) throw new Error(`${path.basename(filePath)} must contain a JSON object`);
  for (const [key, shape] of Object.entries(required)) {
    const value = data[key];
    if (shape === "array" && !Array.isArray(value)) throw new Error(`${path.basename(filePath)} missing ${key} array`);
    if (shape === "object" && !isRecord(value)) throw new Error(`${path.basename(filePath)} missing ${key} object`);
  }
  return data;
}

async function readJsonRmw<T>(filePath: string, fallback: T): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const quarantine = `${filePath}.corrupt-${stamp}`;
    await copyFile(filePath, quarantine).catch(() => undefined);
    throw new Error(
      `${path.basename(filePath)} is corrupt (${(error as Error).message}); quarantined a copy as ${path.basename(quarantine)}. Restore from it or a .prev backup — refusing to overwrite.`,
    );
  }
}

async function atomicWrite(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  if (existsSync(filePath)) {
    for (const [older, newer] of [
      [".prev3", ".prev2"],
      [".prev2", ".prev"],
    ] as const) {
      const src = `${filePath}${newer}`;
      if (existsSync(src)) await rename(src, `${filePath}${older}`).catch(() => undefined);
    }
    await copyFile(filePath, `${filePath}.prev`).catch(() => undefined);
  }
  const tmp = path.join(path.dirname(filePath), `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, filePath);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

export class AssetBank {
  private readonly reviewRoot: string;
  private readonly dataPath: string;
  private readonly statusPath: string;
  private readonly plansDir: string;
  private readonly packsDir: string;
  private readonly queuesDir: string;
  private readonly relatedGroupsPath: string;
  private readonly entityProfilesPath: string;
  private readonly zonePacksPath: string;
  private readonly collectionsPath: string;
  private readonly lockPath: string;
  private lockDepth = 0;
  private lastRescanFingerprint: string | null = null;
  private lastReconcileDriftCount = 0;

  private get repoRoots(): RepoRoot[] {
    return this.config.repoRoots ?? [];
  }

  constructor(private readonly config: AssetBankConfig) {
    this.reviewRoot = path.join(config.metadataRoot, "_review");
    this.dataPath = path.join(this.reviewRoot, "asset-review-data.json");
    this.statusPath = path.join(this.reviewRoot, "asset-review-status.json");
    this.plansDir = path.join(config.metadataRoot, "_promotion-plans", "generated");
    this.packsDir = path.join(this.plansDir, "packs");
    this.queuesDir = path.join(this.reviewRoot, "queues");
    this.relatedGroupsPath = path.join(this.reviewRoot, "related-groups.json");
    this.entityProfilesPath = path.join(this.reviewRoot, "entity-profiles.json");
    this.zonePacksPath = path.join(this.reviewRoot, "zone-packs.json");
    this.collectionsPath = path.join(this.reviewRoot, "asset-collections.json");
    this.lockPath = path.join(this.reviewRoot, ".review.lock");
  }

  async init(): Promise<void> {
    await mkdir(this.reviewRoot, { recursive: true });
    await mkdir(this.plansDir, { recursive: true });
    await mkdir(this.packsDir, { recursive: true });
    await this.sweepStaleTmp();
    await writeFile(path.join(this.reviewRoot, ".session-token"), this.config.sessionToken, "utf8").catch(() => undefined);
  }

  registerRoutes(routes: Map<string, (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void>>): void {
    const get = (route: string, handler: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void>) => routes.set(`GET ${route}`, handler);
    const post = (route: string, handler: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void>) => routes.set(`POST ${route}`, handler);

    get("/api/asset-bank-node/health", async (_request, response) => this.json(response, 200, { ok: true, mounted: true, root: this.config.assetsRoot }));
    get("/api/asset-bank/health", async (_request, response) => this.handleAssetBankHealth(response));
    get("/api/health", async (_request, response) => this.json(response, 200, { ok: true, root: this.config.assetsRoot, time: isoSeconds() }));
    get("/api/data", async (_request, response) => this.handleData(response));
    get("/api/status", async (_request, response) => this.json(response, 200, await this.readStatus()));
    get("/api/assets", async (_request, response, url) => this.handleAssetsSearch(response, url));
    get("/api/asset/image", async (request, response, url) => this.handleAssetImage(request, response, url));
    get("/api/asset/thumb", async (request, response, url) => this.handleAssetThumb(request, response, url));
    get("/api/asset/fringe-overlay", async (_request, response, url) => this.handleAssetFringeOverlay(response, url));
    get("/api/asset/refresh-fringe", async (_request, response, url) => this.handleAssetRefreshFringe(response, url));
    post("/api/asset/fringe-overlay", async (_request, response, url) => this.handleAssetFringeOverlay(response, url));
    post("/api/asset/refresh-fringe", async (request, response, url) => this.handleAssetRefreshFringe(response, url, await this.config.readRequestJson(request)));
    get("/api/asset/diagnostics", async (_request, response, url) => this.handleAssetDiagnostics(response, url));
    get("/api/stats", async (_request, response) => this.handleStats(response));
    get("/api/related-groups", async (_request, response) => this.json(response, 200, await this.readRelated()));
    get("/api/queues", async (_request, response) => this.handleQueues(response));
    get("/api/promotion-plan", async (_request, response, url) => this.json(response, 200, await this.makePlan(url.searchParams.get("id") ?? "")));
    get("/api/entity-profiles", async (_request, response) => this.json(response, 200, await this.readEntityProfiles()));
    get("/api/zone-packs", async (_request, response) => this.json(response, 200, await this.readZonePacks()));
    get("/api/collections", async (_request, response) => this.json(response, 200, await this.readCollections()));
    get("/api/coverage-report", async (_request, response) => this.handleCoverageReport(response));
    get("/api/promoted", async (_request, response) => this.handlePromoted(response));
    get("/api/reconcile", async (_request, response) => this.handleReconcile(response, false));

    post("/api/review", async (request, response) => this.handleReview(response, await this.config.readRequestJson(request)));
    post("/api/reviews/bulk", async (request, response) => this.handleBulkReview(response, await this.config.readRequestJson(request)));
    post("/api/asset/update", async (request, response) => this.handleAssetUpdate(response, await this.config.readRequestJson(request)));
    post("/api/catalog/rescan", async (_request, response) => this.handleCatalogRescan(response));
    post("/api/reconcile", async (_request, response) => this.handleReconcile(response, true));
    post("/api/catalog/recategorize", async (request, response) => this.handleRecategorize(response, await this.config.readRequestJson(request)));
    post("/api/asset-bank/repair", async (request, response) => this.handleAssetBankRepair(response, await this.config.readRequestJson(request)));
    post("/api/quality-check", async (request, response) => this.handleQualityCheck(response, await this.config.readRequestJson(request)));
    post("/api/promote", async (request, response) => this.handlePromote(response, await this.config.readRequestJson(request)));
    post("/api/unpromote", async (request, response) => this.handleUnpromote(response, await this.config.readRequestJson(request)));
    post("/api/asset/open-location", async (request, response) => this.handleOpenLocation(response, await this.config.readRequestJson(request)));
    post("/api/asset/remove-from-bank", async (request, response) => this.handleRemoveFromBank(response, await this.config.readRequestJson(request)));
    post("/api/generate-promotion-plan", async (request, response) => this.handleGeneratePlan(response, await this.config.readRequestJson(request)));
    post("/api/generate-promotion-pack", async (request, response) => this.handleGeneratePack(response, await this.config.readRequestJson(request)));
    post("/api/related-groups", async (request, response) => this.handleRelatedGroupSave(response, await this.config.readRequestJson(request)));
    post("/api/related-group/save", async (request, response) => this.handleRelatedGroupSave(response, await this.config.readRequestJson(request)));
    post("/api/related-groups/delete", async (request, response) => this.handleRelatedGroupDelete(response, await this.config.readRequestJson(request)));
    post("/api/related-group/delete", async (request, response) => this.handleRelatedGroupDelete(response, await this.config.readRequestJson(request)));
    post("/api/entity-profile/save", async (request, response) => this.handleEntitySave(response, await this.config.readRequestJson(request)));
    post("/api/entity-profile/bind", async (request, response) => this.handleEntityBind(response, await this.config.readRequestJson(request)));
    post("/api/entity-profile/unbind", async (request, response) => this.handleEntityUnbind(response, await this.config.readRequestJson(request)));
    post("/api/entity-profile/delete", async (request, response) => this.handleEntityDelete(response, await this.config.readRequestJson(request)));
    post("/api/zone-pack/save", async (request, response) => this.handleZoneSave(response, await this.config.readRequestJson(request)));
    post("/api/zone-pack/delete", async (request, response) => this.handleZoneDelete(response, await this.config.readRequestJson(request)));
    post("/api/zone-pack/add-asset", async (request, response) => this.handleZoneAddAsset(response, await this.config.readRequestJson(request)));
    post("/api/zone-pack/remove-asset", async (request, response) => this.handleZoneRemoveAsset(response, await this.config.readRequestJson(request)));
    post("/api/collection/save", async (request, response) => this.handleCollectionSave(response, await this.config.readRequestJson(request)));
    post("/api/collection/add-asset", async (request, response) => this.handleCollectionAddAsset(response, await this.config.readRequestJson(request)));
    post("/api/collection/bind", async (request, response) => this.handleCollectionBind(response, await this.config.readRequestJson(request)));
  }

  async serveStatic(response: ServerResponse, urlPath: string): Promise<boolean> {
    if (urlPath === "/" || urlPath === "/_review/asset-review-server.html") {
      await this.sendFile(response, path.join(this.config.repoRoot, "tools", "devkit", "asset-review-server.html"));
      return true;
    }
    if (urlPath === "/tokens.css") {
      await this.sendFile(response, path.join(this.config.repoRoot, "client", "src", "ui", "tokens.css"), "text/css; charset=utf-8");
      return true;
    }
    if (urlPath.startsWith("/assets/fonts/")) {
      const fontsRoot = path.join(this.config.repoRoot, "client", "public", "assets", "fonts");
      const target = path.resolve(fontsRoot, decodeURIComponent(urlPath.slice("/assets/fonts/".length)));
      if (!isInside(target, fontsRoot)) {
        this.config.sendText(response, 403, "Forbidden");
        return true;
      }
      await this.sendFile(response, target);
      return true;
    }
    return false;
  }

  private async acquireLock(timeoutMs = 15_000): Promise<void> {
    if (this.lockDepth > 0) {
      this.lockDepth += 1;
      return;
    }
    await mkdir(this.reviewRoot, { recursive: true });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await writeFile(this.lockPath, String(process.pid), { flag: "wx" });
        this.lockDepth = 1;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let holder = -1;
        try {
          holder = Number((await readFile(this.lockPath, "utf8")).trim() || "-1");
        } catch {
          holder = -1;
        }
        if (holder > 0 && !pidAlive(holder)) {
          await unlink(this.lockPath).catch(() => undefined);
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(`review lock held by live pid ${holder} after ${timeoutMs / 1000}s — not stealing. Retry, or remove ${this.lockPath} if you are certain no writer is running.`);
        }
        await sleep(50);
      }
    }
  }

  private async releaseLock(): Promise<void> {
    if (this.lockDepth <= 0) return;
    this.lockDepth -= 1;
    if (this.lockDepth > 0) return;
    await unlink(this.lockPath).catch(() => undefined);
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    await this.acquireLock();
    try {
      return await work();
    } finally {
      await this.releaseLock();
    }
  }

  private async updateJson<T>(filePath: string, fallback: T, mutate: (data: T) => void | Promise<void>): Promise<T> {
    return this.withLock(async () => {
      const data = await readJsonRmw(filePath, fallback);
      await mutate(data);
      await atomicWrite(filePath, data);
      return data;
    });
  }

  private async updateReviewStatus(mutate: (status: { reviews: ReviewRecord[]; [key: string]: unknown }) => void | Promise<void>): Promise<{ reviews: ReviewRecord[]; [key: string]: unknown }> {
    return updateReviewStatusFile(this.statusPath, mutate);
  }

  private json(response: ServerResponse, statusCode: number, payload: unknown): void {
    this.config.sendJson(response, statusCode, payload);
  }

  private async sendFile(response: ServerResponse, filePath: string, contentType = contentTypeFor(filePath), rangeHeader?: string): Promise<void> {
    try {
      const info = await stat(filePath);
      const range = byteRangeFor(rangeHeader, info.size);
      if (range.kind === "unsatisfiable") {
        response.writeHead(range.statusCode, { ...range.headers, "cache-control": "no-store" });
        response.end();
        return;
      }
      const body = await readFile(filePath);
      response.writeHead(range.statusCode, { ...range.headers, "content-type": contentType, "cache-control": "no-store" });
      response.end(range.kind === "partial" ? body.subarray(range.start, range.end + 1) : body);
    } catch {
      this.config.sendText(response, 404, "Not found");
    }
  }

  private async sweepStaleTmp(): Promise<void> {
    try {
      const entries = await readdir(this.reviewRoot);
      await Promise.all(entries.filter((name) => name.endsWith(".tmp")).map((name) => unlink(path.join(this.reviewRoot, name)).catch(() => undefined)));
    } catch {
      // No review folder yet.
    }
  }

  private async readData(): Promise<{ assets: AssetRecord[]; [key: string]: unknown }> {
    return readJsonLoose(this.dataPath, { assets: [] });
  }

  private reviewIndexes(status: { reviews?: ReviewRecord[] }): { byId: Map<string, ReviewRecord>; byPath: Map<string, ReviewRecord> } {
    const byId = new Map<string, ReviewRecord>();
    const byPath = new Map<string, ReviewRecord>();
    for (const review of status.reviews ?? []) {
      if (typeof review.id === "string") byId.set(review.id, review);
      const rel = normalizedAssetRelPath(review.path);
      if (rel) byPath.set(rel, review);
    }
    return { byId, byPath };
  }

  private reviewForAsset(asset: AssetRecord, indexes: { byId: Map<string, ReviewRecord>; byPath: Map<string, ReviewRecord> }): ReviewRecord | undefined {
    const candidates = [asset.id ? indexes.byId.get(asset.id) : undefined, indexes.byPath.get(normalizedAssetRelPath(asset.path))].filter(Boolean) as ReviewRecord[];
    return candidates.find((review) => review.decision === "runtime-promoted") ?? candidates[0];
  }

  private async handleData(response: ServerResponse): Promise<void> {
    const data = await this.readData();
    const indexes = this.reviewIndexes(await this.readStatus());
    const assets = data.assets.map((asset) => {
      const review = this.reviewForAsset(asset, indexes);
      return review ? { ...asset, review, review_decision: review } : asset;
    });
    this.json(response, 200, { ...data, assets });
  }

  private async readStatus(): Promise<{ reviews: ReviewRecord[]; [key: string]: unknown }> {
    return readJsonLoose(this.statusPath, { reviews: [] });
  }

  private async readRelated(): Promise<{ groups: Record<string, JsonRecord>; asset_to_group: Record<string, string>; [key: string]: unknown }> {
    return readJsonLoose(this.relatedGroupsPath, { groups: {}, asset_to_group: {} });
  }

  private async readEntityProfiles(): Promise<{ entities: Record<string, JsonRecord> }> {
    return readJsonLoose(this.entityProfilesPath, { entities: {} });
  }

  private async readZonePacks(): Promise<{ zones: Record<string, JsonRecord> }> {
    return readJsonLoose(this.zonePacksPath, { zones: {} });
  }

  private async readCollections(): Promise<{ collections: Record<string, JsonRecord> }> {
    return readJsonLoose(this.collectionsPath, { collections: {} });
  }

  private async assetById(assetId: unknown): Promise<AssetRecord | undefined> {
    if (typeof assetId !== "string") return undefined;
    const data = await this.readData();
    return data.assets.find((asset) => asset.id === assetId);
  }

  private assetPath(asset: AssetRecord): string {
    return path.resolve(this.config.assetsRoot, asset.path ?? "");
  }

  private safeAssetPath(asset: AssetRecord): string | undefined {
    // Reconcile-ingested AND repo-runtime rows live in the RUNTIME tree (client/public/assets),
    // not the bank tree — resolve their `runtime-only/` prefix there so previews/thumbs work.
    const rel = String(asset.path ?? "");
    if (rel.startsWith("runtime-only/")) {
      const runtimeRoot = path.resolve(this.config.repoRoot, "client", "public", "assets");
      const resolved = path.resolve(runtimeRoot, rel.slice("runtime-only/".length));
      return isInside(resolved, runtimeRoot) ? resolved : undefined;
    }
    // repo-source rows live under assets/sources/accepted.
    if (rel.startsWith("repo-source/")) {
      const source = this.repoRoots.find((entry) => entry.origin === "repo-source");
      if (!source) return undefined;
      const resolved = path.resolve(source.root, rel.slice("repo-source/".length));
      return isInside(resolved, source.root) ? resolved : undefined;
    }
    const resolved = this.assetPath(asset);
    if (!isInside(resolved, this.config.assetsRoot)) return undefined;
    return resolved;
  }

  private async runPython(script: string, args: string[], timeoutMs = 30_000): Promise<{ ok: boolean; output: string }> {
    try {
      const result = await execFileAsync("python", [script, ...args], {
        cwd: this.config.repoRoot,
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { ok: true, output: `${result.stdout}${result.stderr}`.trim() };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || err.message || String(error) };
    }
  }

  private async checkDefectGate(source: string): Promise<{ ok: boolean; output: string }> {
    return this.runPython(path.join("tools", "asset-cleanup", "fringe.py"), ["check", source], 45_000);
  }

  private async vibrancyWarnings(source: string): Promise<string[]> {
    const result = await this.runPython(path.join("tools", "asset-cleanup", "vibrancy.py"), ["scan", source], 30_000);
    if (!result.ok || !result.output.includes("vibrancy warnings:")) return [];
    return result.output.split(/\r?\n/).filter((line) => line.includes("low chroma") || line.includes("[dull]"));
  }

  private async fringeBlock(payload: JsonRecord): Promise<string | undefined> {
    if (payload.decision !== "accepted" || payload.allowFringe === true) return undefined;
    const asset = await this.assetById(payload.id);
    if (!asset) return undefined;
    const source = this.safeAssetPath(asset);
    if (!source || !existsSync(source) || !fringeGateExt.has(path.extname(source).toLowerCase())) return undefined;
    const gate = await this.checkDefectGate(source);
    if (!gate.ok) {
      return `asset defect detected or gate unavailable: ${gate.output || "fringe.py check failed"} Fix: despill (fringe) or re-key the background (rembg) — never accept a chroma/opaque/bg/pink-rim asset.`;
    }
    return undefined;
  }

  private async reviewPayloadError(payload: JsonRecord): Promise<string | undefined> {
    const decision = payload.decision;
    if (typeof decision === "string" && !allowedReviewDecisions.has(decision)) return `unknown review decision: ${decision}`;
    return undefined;
  }

  private async mergeReview(payload: JsonRecord): Promise<{ reviews: ReviewRecord[] }> {
    const assetId = typeof payload.id === "string" ? payload.id : "";
    if (!assetId) return this.readStatus();
    const now = isoSeconds();
    return this.updateReviewStatus((status) => {
      const reviews = Array.isArray(status.reviews) ? status.reviews : [];
      const matches = reviews.filter((review) => review.id === assetId);
      let found = matches[0];
      if (!found) {
        found = { id: assetId };
        reviews.push(found);
      } else if (matches.length > 1) {
        status.reviews = reviews.filter((review) => review.id !== assetId);
        status.reviews.push(found);
      } else {
        status.reviews = reviews;
      }
      for (const key of ["decision", "status", "priority", "notes", "path"]) {
        if (key in payload) found[key] = payload[key] as never;
      }
      found.status = normalizedReviewStatus(found.status, found.decision);
      found.updated_at = now;
      status.generated_at = now;
    });
  }

  private async handleReview(response: ServerResponse, payload: JsonRecord): Promise<void> {
    const reviewError = await this.reviewPayloadError(payload);
    if (reviewError) {
      this.json(response, 400, { ok: false, error: reviewError });
      return;
    }
    const target = await this.assetById(payload.id);
    if (isRepoOrigin(target)) {
      this.json(response, 409, { ok: false, error: `${target!.origin} assets are read-only — review decisions are not stored for repo-origin rows (they are already in the pipeline)`, origin: target!.origin });
      return;
    }
    const block = await this.fringeBlock(payload);
    if (block) {
      this.json(response, 409, { ok: false, error: block, fringe: true });
      return;
    }
    await this.mergeReview(payload);
    const asset = await this.assetById(payload.id);
    const warnings = payload.decision === "accepted" && asset ? await this.vibrancyWarnings(this.assetPath(asset)) : [];
    this.json(response, 200, { ok: true, status_path: this.statusPath, review: payload, vibrancyWarnings: warnings });
  }

  private async handleBulkReview(response: ServerResponse, payload: JsonRecord): Promise<void> {
    const reviews = Array.isArray(payload.reviews) ? payload.reviews.filter(isRecord) : [];
    let count = 0;
    const blocked: Array<{ id: unknown; error: string }> = [];
    const warningsById: Record<string, string[]> = {};
    for (const item of reviews) {
      const target = await this.assetById(item.id);
      if (isRepoOrigin(target)) {
        blocked.push({ id: item.id, error: `${target!.origin} assets are read-only (repo-origin, already in the pipeline)` });
        continue;
      }
      const reviewError = await this.reviewPayloadError(item);
      const block = reviewError ?? (await this.fringeBlock(item));
      if (block) {
        blocked.push({ id: item.id, error: block });
        continue;
      }
      await this.mergeReview(item);
      count += 1;
      const asset = await this.assetById(item.id);
      if (item.decision === "accepted" && asset?.id) {
        const warnings = await this.vibrancyWarnings(this.assetPath(asset));
        if (warnings.length) warningsById[asset.id] = warnings;
      }
    }
    this.json(response, 200, { ok: true, saved: count, blocked, vibrancyWarnings: warningsById });
  }

  private async handleAssetsSearch(response: ServerResponse, url: URL): Promise<void> {
    const data = await this.readData();
    const status = await this.readStatus();
    const decisions = this.reviewIndexes(status);
    const category = url.searchParams.get("category");
    const kind = url.searchParams.get("kind");
    const decision = url.searchParams.get("decision");
    const statusFilter = url.searchParams.get("status");
    const q = url.searchParams.get("q")?.toLowerCase();
    const unreviewed = url.searchParams.get("unreviewed");
    const limit = Math.max(0, Number(url.searchParams.get("limit") ?? "100"));
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0"));
    const results: AssetRecord[] = [];
    for (const asset of data.assets) {
      if (category && asset.category !== category) continue;
      if (kind && asset.kind !== kind) continue;
      if (statusFilter && asset.status !== statusFilter) continue;
      const review = this.reviewForAsset(asset, decisions);
      if (decision) {
        const currentDecision = review?.decision ?? "unreviewed";
        if (currentDecision !== decision) continue;
      }
      if (unreviewed && review?.decision) continue;
      if (q) {
        const searchable = `${asset.name ?? ""} ${asset.path ?? ""} ${asset.id ?? ""} ${(asset.tags ?? []).join(" ")}`.toLowerCase();
        if (!searchable.includes(q)) continue;
      }
      results.push(review ? { ...asset, review_decision: review } : asset);
    }
    this.json(response, 200, { total: results.length, offset, limit, count: results.slice(offset, offset + limit).length, assets: results.slice(offset, offset + limit) });
  }

  private async handleAssetImage(request: IncomingMessage | undefined, response: ServerResponse, url: URL): Promise<void> {
    const id = url.searchParams.get("id");
    const asset = await this.assetById(id);
    if (asset) {
      const source = this.safeAssetPath(asset);
      if (source && existsSync(source)) {
        await this.sendFile(response, source, contentTypeFor(source), request?.headers.range);
        return;
      }
    }
    // Runtime fallback: entity-profile slots may bind to a RUNTIME asset NAME (e.g.
    // "monster_blossom_slime", "player_blackhair_cel_idle_east_256") which is not a bank
    // catalog id — the keyed final lives in client/public/assets, not Z:/Assets. Resolve
    // it there so the entity/detail view shows the real in-game asset instead of a broken
    // "?" (regression from the 2026-07-05 reconcile that repointed entities to runtime names).
    const runtime = id ? this.resolveRuntimeAssetPath(id) : undefined;
    if (runtime) {
      await this.sendFile(response, runtime, contentTypeFor(runtime), request?.headers.range);
      return;
    }
    this.json(response, 404, { ok: false, error: "asset not found" });
  }

  /** Resolve a bare runtime asset name to a file under client/public/assets by basename. */
  private resolveRuntimeAssetPath(id: string): string | undefined {
    return resolveRuntimeAssetPath(id, { repoRoot: this.config.repoRoot });
  }

  private async handleAssetThumb(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const asset = await this.assetById(url.searchParams.get("id"));
    if (!asset) {
      this.json(response, 404, { ok: false, error: "asset not found" });
      return;
    }
    const source = this.safeAssetPath(asset);
    if (!source || !existsSync(source)) {
      this.json(response, 404, { ok: false, error: "file not found" });
      return;
    }
    if (!imageExt.has(path.extname(source).toLowerCase())) {
      await this.sendFile(response, source, contentTypeFor(source), request.headers.range);
      return;
    }
    const info = await stat(source);
    const cacheRoot = path.join(this.reviewRoot, "thumbs", "auto");
    await mkdir(cacheRoot, { recursive: true });
    const crop = url.searchParams.get("crop") === "alpha" ? "crop" : "fit";
    const key = createHash("sha1").update(asset.id ?? source).digest("hex");
    const cache = path.join(cacheRoot, `${key}_${Math.floor(info.mtimeMs)}_${info.size}_${crop}.webp`);
    if (!existsSync(cache)) {
      const script = [
        "from PIL import Image",
        "import sys",
        "src,dst,crop=sys.argv[1],sys.argv[2],sys.argv[3]=='crop'",
        "im=Image.open(src)",
        "im=im.convert('RGBA') if im.mode not in ('RGB','RGBA') else im",
        "bbox=im.getchannel('A').getbbox() if crop and im.mode=='RGBA' else None",
        "im=im.crop((max(0,bbox[0]-6),max(0,bbox[1]-6),min(im.width,bbox[2]+6),min(im.height,bbox[3]+6))) if bbox else im",
        "im.thumbnail((320,320), Image.Resampling.LANCZOS)",
        "im.save(dst,'WEBP',quality=82,method=4)",
      ].join("; ");
      const result = await execFileAsync("python", ["-c", script, source, cache, crop], { cwd: this.config.repoRoot, windowsHide: true }).catch(() => undefined);
      if (!result) {
        await this.sendFile(response, source, contentTypeFor(source), request.headers.range);
        return;
      }
    }
    await this.sendFile(response, cache, "image/webp", request.headers.range);
  }

  private async handleAssetRefreshFringe(response: ServerResponse, url: URL, payload?: JsonRecord): Promise<void> {
    const assetId = typeof payload?.id === "string" ? payload.id : url.searchParams.get("id") ?? "";
    if (!assetId) {
      this.json(response, 400, { ok: false, error: "missing id parameter" });
      return;
    }
    const result = await this.refreshFringeRecord(assetId);
    this.json(response, result.ok ? 200 : 400, result);
  }

  private async refreshFringeRecord(assetId: string): Promise<JsonRecord & { ok: boolean }> {
    let result: JsonRecord & { ok: boolean } = { ok: false, error: "asset not found" };
    await this.updateJson(this.dataPath, { assets: [] as AssetRecord[], generated_at: "" }, async (data) => {
      const asset = data.assets.find((candidate) => candidate.id === assetId);
      if (!asset) return;
      const source = this.safeAssetPath(asset);
      if (!source || !existsSync(source)) {
        result = { ok: false, error: "file not found" };
        return;
      }
      if (!fringeGateExt.has(path.extname(source).toLowerCase())) {
        result = { ok: false, error: "fringe audit unavailable" };
        return;
      }
      const gate = await this.checkDefectGate(source);
      asset.fringe = !gate.ok;
      asset.fringe_kind = gate.ok ? "" : "defect";
      asset.fringe_mtime = asset.modified;
      asset.fringe_audit_version = "node-cli-check";
      data.generated_at = isoSeconds();
      result = { ok: true, id: assetId, fringe: asset.fringe, fringe_kind: asset.fringe_kind, asset };
    });
    return result;
  }

  private async handleAssetFringeOverlay(response: ServerResponse, url: URL): Promise<void> {
    await this.handleAssetImage(undefined, response, url);
  }

  private async handleAssetDiagnostics(response: ServerResponse, url: URL): Promise<void> {
    const asset = await this.assetById(url.searchParams.get("id"));
    if (!asset) {
      this.json(response, 404, { ok: false, error: "asset not found" });
      return;
    }
    const source = this.safeAssetPath(asset);
    if (!source || !existsSync(source)) {
      this.json(response, 404, { ok: false, error: "file not found" });
      return;
    }
    const info = await stat(source);
    this.json(response, 200, { ok: true, id: asset.id, path: asset.path, bytes: info.size, modified: isoSeconds(info.mtime), media: imageExt.has(path.extname(source).toLowerCase()) ? "image" : "non-image", metadata_image: asset.image });
  }

  private async handleStats(response: ServerResponse): Promise<void> {
    const data = await this.readData();
    const status = await this.readStatus();
    const decisions = new Map(status.reviews.map((review) => [review.id, review]));
    const byCategory: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    const byDecision: Record<string, number> = { unreviewed: 0 };
    for (const asset of data.assets) {
      byCategory[asset.category ?? "unknown"] = (byCategory[asset.category ?? "unknown"] ?? 0) + 1;
      byKind[asset.kind ?? "unknown"] = (byKind[asset.kind ?? "unknown"] ?? 0) + 1;
      const decision = decisions.get(asset.id)?.decision;
      byDecision[decision ?? "unreviewed"] = (byDecision[decision ?? "unreviewed"] ?? 0) + 1;
    }
    const reviewed = data.assets.length - (byDecision.unreviewed ?? 0);
    this.json(response, 200, { total: data.assets.length, reviewed, unreviewed: byDecision.unreviewed ?? 0, review_percent: data.assets.length ? Math.round((reviewed / data.assets.length) * 1000) / 10 : 0, by_category: byCategory, by_kind: byKind, by_decision: byDecision, reconcile_drift_count: this.lastReconcileDriftCount });
  }

  private async handleQueues(response: ServerResponse): Promise<void> {
    const queues: Record<string, unknown> = {};
    try {
      const entries = await readdir(this.queuesDir);
      for (const file of entries.filter((item) => item.endsWith(".json")).sort()) {
        queues[path.basename(file, ".json")] = await readJsonLoose(path.join(this.queuesDir, file), {});
      }
    } catch {
      // Missing queues directory is fine.
    }
    this.json(response, 200, { queues });
  }

  private async handleCatalogRescan(response: ServerResponse): Promise<void> {
    this.json(response, 200, { ok: true, ...(await this.rescanCatalog()) });
  }

  private async reconcileReportOnly(): Promise<number> {
    const verdict = await reconcileAssetBank({
      repoRoot: this.config.repoRoot,
      assetsRoot: this.config.assetsRoot,
      metadataRoot: this.config.metadataRoot,
      reportOnly: true,
    });
    this.lastReconcileDriftCount = verdict.driftCount;
    return verdict.driftCount;
  }

  private async handleReconcile(response: ServerResponse, apply: boolean): Promise<void> {
    try {
      const verdict = await reconcileAssetBank({
        repoRoot: this.config.repoRoot,
        assetsRoot: this.config.assetsRoot,
        metadataRoot: this.config.metadataRoot,
        apply,
        reportOnly: !apply,
      });
      this.lastReconcileDriftCount = verdict.driftCount;
      this.json(response, apply && !verdict.ok ? 409 : 200, verdict);
    } catch (error) {
      this.json(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Auto-rescan: the catalog does not watch the filesystem, and a forgotten manual
   * rescan left the owner staring at a stale bank (2026-07-04). The server now polls
   * a cheap fingerprint of the assets tree and rescans itself when it changes —
   * POST /api/catalog/rescan stays for immediate refreshes. */
  startAutoRescan(intervalMs = 120_000): void {
    const tick = async (): Promise<void> => {
      try {
        const fingerprint = await this.assetsFingerprint();
        if (fingerprint === this.lastRescanFingerprint) return;
        const first = this.lastRescanFingerprint === null;
        const result = await this.rescanCatalog();
        this.lastRescanFingerprint = fingerprint;
        if (!first && (result.added || result.removed || result.reclassified)) {
          console.log(`[asset-bank] auto-rescan: +${result.added} added, -${result.removed} removed, ~${result.reclassified} reclassified (total ${result.total})`);
        }
        const drift = await this.reconcileReportOnly();
        if (!first && drift) console.log(`[asset-bank] reconcile drift: ${drift}`);
      } catch (error) {
        console.warn(`[asset-bank] auto-rescan failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref();
  }

  private async assetsFingerprint(): Promise<string> {
    let count = 0;
    let bytes = 0;
    let maxMtimeMs = 0;
    await this.walkAssets(this.config.assetsRoot, async (filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      if (!supportedExt.has(ext)) return;
      const info = await stat(filePath).catch(() => undefined);
      if (!info) return;
      count += 1;
      bytes += info.size;
      if (info.mtimeMs > maxMtimeMs) maxMtimeMs = info.mtimeMs;
    });
    // Fold in the repo roots so a repo-side delivery (the whole point of this fix) also
    // trips the auto-rescan poll, not just a Z:/Assets change.
    const repoParts: string[] = [];
    for (const repo of this.repoRoots) repoParts.push(`${repo.origin}=${await repoRootFingerprint(repo.root)}`);
    return `${count}:${bytes}:${Math.round(maxMtimeMs)}|${repoParts.join("|")}`;
  }

  private async rescanCatalog(): Promise<{ total: number; added: number; reclassified: number; removed: number }> {
    const existing = await this.readData();
    const existingIds = new Set(existing.assets.map((asset) => asset.id).filter(Boolean));
    const existingById = new Map(existing.assets.filter((asset) => asset.id).map((asset) => [asset.id, asset]));
    const newAssets = [...existing.assets];
    let added = 0;
    let reclassified = 0;
    await this.walkAssets(this.config.assetsRoot, async (filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      if (!supportedExt.has(ext)) return;
      const name = path.basename(filePath).toLowerCase();
      if (name.endsWith(".tmp") || name.endsWith(".prev") || name.includes(".bak") || name.includes("before-move") || name.includes("_preview") || name.includes("_3x3_preview") || name.includes("_2x2_preview")) return;
      const rel = path.relative(this.config.assetsRoot, filePath).replaceAll("\\", "/");
      const assetId = pathAssetId(rel);
      if (existingIds.has(assetId)) {
        const current = existingById.get(assetId);
        if (current) {
          const detectedKind = this.detectKind(ext, rel);
          if ((!current.kind || current.kind === "image" || current.kind === "sprite") && ["contact_sheet", "source_sheet"].includes(detectedKind)) {
            current.kind = detectedKind;
            reclassified += 1;
          }
          // Audio taxonomy self-heal: pull existing audio rows back under the audio
          // category with a folder-family subcategory (older rows leaked to ui/monsters/players).
          const sub = this.detectAudioSubcategory(rel);
          if (sub) {
            if (current.category !== "audio") { current.category = "audio"; reclassified += 1; }
            if (current.subcategory !== sub) { current.subcategory = sub; reclassified += 1; }
          }
        }
        return;
      }
      const info = await stat(filePath);
      const entry: AssetRecord = {
        id: assetId,
        name: path.basename(filePath),
        path: rel,
        path_from_review_html: `../${rel}`,
        category: this.detectCategory(rel),
        kind: this.detectKind(ext, rel),
        status: "unknown",
        tags: [`ext:${ext.slice(1)}`],
        bytes: info.size,
        modified: isoSeconds(info.mtime),
      };
      const lower = rel.toLowerCase();
      if (lower.includes("_incoming") || lower.includes("unsorted")) entry.tags = [...(entry.tags ?? []), "intake:unsorted"];
      const audioSub = this.detectAudioSubcategory(rel);
      if (audioSub) entry.subcategory = audioSub;
      if (imageExt.has(ext)) entry.image = await this.readImageSize(filePath);
      newAssets.push(entry);
      existingIds.add(assetId);
      added += 1;
    });

    // Repo roots (post-cel-pivot deliverables): client/public/assets + assets/sources/accepted.
    // READ-ONLY — see bank-repo-roots.ts. Load the promoted-registry once to stamp `in-game`
    // status/tags on runtime rows that are live in the game.
    const registryByRuntimeRel = await this.registryByRuntimeRel();
    const repoAdded = await this.scanRepoRoots(newAssets, existingById, existingIds, registryByRuntimeRel);
    added += repoAdded.added;
    reclassified += repoAdded.reclassified;

    const beforePrune = newAssets.length;
    const filtered = newAssets.filter((asset) => {
      const rel = asset.path ?? "";
      if (!rel) return false;
      if (rel.startsWith("runtime-only/")) {
        // Reconcile-ingested AND repo-runtime rows live in the runtime tree, not assetsRoot —
        // keep them while their runtime file exists, else this prune silently undoes every
        // reconcile ingestion / repo-root scan.
        return existsSync(path.join(this.config.repoRoot, "client", "public", "assets", rel.slice("runtime-only/".length)));
      }
      if (asset.origin === "repo-source") {
        const source = this.repoRoots.find((entry) => entry.origin === "repo-source");
        const sourceRel = rel.slice("repo-source/".length);
        // Non-deliverable evidence rows (frames/calibration/source-*) prune even though
        // their files exist — the scan no longer produces them (owner escalation #2).
        return Boolean(source) && isRepoSourceDeliverable(sourceRel) && existsSync(path.join(source!.root, sourceRel));
      }
      return existsSync(path.join(this.config.assetsRoot, rel)) && !this.isExcludedRel(rel);
    });
    // Rows whose file no longer exists (or became excluded) are dropped here so the
    // review UI stops rendering "No preview / Retry" ghosts.
    const removed = beforePrune - filtered.length;
    const data = { generated_at: isoSeconds(), root: this.config.assetsRoot, assets: filtered };
    await this.withLock(async () => atomicWrite(this.dataPath, data));
    return { total: filtered.length, added, reclassified, removed };
  }

  /**
   * Index the promoted-registry by runtime-relative targetPath (`assets/sprites/x.png` ->
   * `sprites/x.png`) so a repo-runtime scan can stamp `status:"promoted"` + `in-game` on rows
   * that are live in the game, and reuse the registry's canonical assetId (keeping zone
   * packs / collections / entity profiles resolving after a source batch is archived).
   * Registry-unreadable is non-fatal here — the scan proceeds without promoted stamps.
   */
  private async registryByRuntimeRel(): Promise<Map<string, { key: string; targetName: string }>> {
    const index = new Map<string, { key: string; targetName: string }>();
    try {
      const registry = await readRegistryStrict();
      for (const [key, entry] of Object.entries(registry.promoted)) {
        const rel = String(entry.targetPath).replace(/^assets[\\/]/, "").replaceAll("\\", "/").toLowerCase();
        if (rel) index.set(rel, { key, targetName: entry.targetName });
      }
    } catch {
      // Corrupt/locked registry: proceed without promoted stamps rather than fail the scan.
    }
    return index;
  }

  /**
   * Scan the READ-ONLY repo roots into the catalog. repo-runtime reuses the
   * `runtime-only/<rel>` path scheme so a bank scan and a reconcile ingest CONVERGE on one
   * row (registry assetId reused when present); repo-source uses a `repo-source/<rel>` prefix.
   * Existing rows are refreshed in place (origin/promoted stamp) rather than duplicated.
   */
  private async scanRepoRoots(
    newAssets: AssetRecord[],
    existingById: Map<string | undefined, AssetRecord>,
    existingIds: Set<string | undefined>,
    registryByRuntimeRel: Map<string, { key: string; targetName: string }>,
  ): Promise<{ added: number; reclassified: number }> {
    let added = 0;
    let reclassified = 0;
    for (const repo of this.repoRoots) {
      for (const rel of await walkRepoRoot(repo.root)) {
        // repo-source: only runtime/ deliverables are catalog rows (frames/calibration/
        // source-* evidence buried the real sheets — owner escalation #2, 2026-07-07).
        if (repo.origin === "repo-source" && !isRepoSourceDeliverable(rel)) continue;
        // repo-runtime: skip the promoted-registry file + runtime index (data, not assets).
        if (repo.origin === "repo-runtime") {
          const relLower = rel.toLowerCase();
          if (relLower === "promoted-registry.json" || relLower === "index.json") continue;
          if (path.extname(relLower) === ".json") continue; // runtime manifests are not assets
        }
        const catalogPath = repoCatalogPath(repo.prefix, rel);
        const registryHit = repo.origin === "repo-runtime" ? registryByRuntimeRel.get(rel.toLowerCase()) : undefined;
        // Reuse the registry assetId for promoted runtime rows so downstream refs resolve;
        // otherwise a stable path-derived id (non-colliding thanks to the root prefix).
        const assetId = registryHit?.key ?? pathAssetId(catalogPath);
        const promoted = Boolean(registryHit);

        const current = existingById.get(assetId) ?? newAssets.find((asset) => asset.path === catalogPath);
        if (current) {
          // Refresh origin + promoted stamp on rows that predate repo-root scanning
          // (e.g. reconcile-ingested runtime-only rows) so the UI shows origin/in-game.
          if (current.origin !== repo.origin) { current.origin = repo.origin; reclassified += 1; }
          if (promoted) {
            if (current.status !== "promoted") { current.status = "promoted"; reclassified += 1; }
            if (!(current.tags ?? []).includes("in-game")) current.tags = [...new Set([...(current.tags ?? []), "in-game"])];
          }
          continue;
        }

        const abs = path.join(repo.root, rel);
        const info = await stat(abs).catch(() => undefined);
        if (!info) continue;
        const ext = path.extname(rel).toLowerCase();
        const entry: AssetRecord = {
          id: assetId,
          name: registryHit?.targetName ?? path.basename(rel),
          path: catalogPath,
          origin: repo.origin,
          category: repoCategory(repo.origin, rel),
          kind: repoKind(rel),
          status: promoted ? "promoted" : "candidate",
          tags: [`ext:${ext.slice(1)}`, `origin:${repo.origin}`, ...(promoted ? ["in-game"] : [])],
          bytes: info.size,
          modified: isoSeconds(info.mtime),
        };
        if (imageExt.has(ext)) entry.image = await this.readImageSize(abs);
        const audioSub = this.detectAudioSubcategory(rel);
        if (audioSub) entry.subcategory = audioSub;
        newAssets.push(entry);
        existingIds.add(assetId);
        existingById.set(assetId, entry);
        added += 1;
      }
    }
    return { added, reclassified };
  }

  private async walkAssets(dir: string, visit: (filePath: string) => Promise<void>): Promise<void> {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isSkippedDir(entry.name)) continue;
        await this.walkAssets(full, visit);
      } else if (entry.isFile()) {
        await visit(full);
      }
    }
  }

  private isExcludedRel(rel: string): boolean {
    const parts = rel.replaceAll("\\", "/").split("/");
    if (parts.some((part) => isSkippedDir(part))) return true;
    const lower = rel.toLowerCase();
    return lower.endsWith(".tmp") || lower.endsWith(".prev") || lower.includes("_preview") || lower.includes(".bak") || lower.includes("before-move");
  }

  private async readImageSize(filePath: string): Promise<{ width: number; height: number } | null> {
    const header = await readFile(filePath).then((buf) => buf.subarray(0, 32)).catch(() => Buffer.alloc(0));
    if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
    }
    if (header[0] === 0xff && header[1] === 0xd8) return { width: 0, height: 0 };
    return null;
  }

  private detectKind(ext: string, rel: string): string {
    if ([".mp3", ".wav", ".ogg"].includes(ext)) return "audio";
    if ([".mp4", ".webm", ".mov"].includes(ext)) return "video";
    if ([".md", ".json", ".txt"].includes(ext) || !imageExt.has(ext)) return "document";
    const relLower = rel.toLowerCase();
    const nameLower = path.basename(rel, path.extname(rel)).toLowerCase();
    const words = nameLower.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const parts = relLower.split("/");
    if (parts.slice(0, -1).includes("qa") || nameLower.startsWith("qa-") || nameLower.startsWith("qa_")) return "contact_sheet";
    if (parts.includes("interaction_props") || nameLower.startsWith("prop_")) return "prop";
    const folderKind = parts.slice(0, -1).includes("props") ? "prop" : parts.slice(0, -1).includes("vfx") ? "vfx" : parts.slice(0, -1).includes("audio") ? "audio" : parts.slice(0, -1).includes("animation") ? "spritesheet" : parts.slice(0, -1).includes("portraits") ? "portrait" : undefined;
    if (words.includes("contact") || words.includes("review_contact")) return "contact_sheet";
    if (words.includes("source_sheet") || words.includes("source_master") || words.includes("master_sheet")) return "source_sheet";
    if (["walk", "idle", "attack", "cast"].some((word) => nameLower.includes(word)) && ["sheet", "strip", "frames"].some((word) => nameLower.includes(word))) return "spritesheet";
    if (["portrait", "headshot", "bust"].some((word) => nameLower.includes(word))) return "portrait";
    if (["icon", "badge", "emblem"].some((word) => nameLower.includes(word))) return "icon";
    if (["tile", "ground", "floor"].some((word) => nameLower.includes(word)) && (parts.includes("environments") || parts.includes("tilesets"))) return "tile";
    if (parts.includes("tilesets") && parts.includes("ground")) return "tile";
    if (["decal", "litter", "pebble", "smear"].some((word) => nameLower.includes(word))) return "decal";
    if (["vfx", "particle", "glow", "aura"].some((word) => nameLower.includes(word))) return "vfx";
    if (["barrel", "crate", "fence", "rock", "stump", "log", "bush", "tree", "mushroom", "lantern", "sign", "bench", "chest"].some((word) => nameLower.includes(word))) return "prop";
    return folderKind ?? "sprite";
  }

  private detectCategory(rel: string): string {
    const lower = rel.replaceAll("\\", "/").toLowerCase();
    const name = path.basename(lower);
    // Audio is keyed by its own folder tree, not by incidental "ui"/"monster"/"player"
    // substrings inside an sfx path (e.g. audio/sfx/ui, audio/sfx/monsters/<id>).
    if ([".mp3", ".wav", ".ogg"].includes(path.extname(lower)) || lower.split("/")[0] === "audio") return "audio";
    if (lower.includes("/npcs/") || lower.includes("settlement-pack") || lower.includes("-npcs-") || lower.includes("/npc/")) return "npcs";
    if (lower.includes("/player/") || lower.includes("/players/") || lower.includes("/player-") || name.includes("class_")) return "players";
    if (lower.includes("monster-animation-source") || lower.includes("/monsters/") || lower.includes("monster-masters") || lower.includes("monster-candidates") || (!lower.includes("monster-loot") && lower.includes("/monster/"))) return "monsters";
    if (lower.includes("/interaction_props/") || name.startsWith("prop_")) return "props";
    for (const cat of ["environments", "tilesets", "decals", "ui", "vfx", "items", "props", "icons", "portraits", "backgrounds", "audio", "animation", "monsters", "npcs", "players", "characters"]) {
      if (lower.includes(cat)) return cat;
    }
    return "unknown";
  }

  /**
   * Derive a review-UI subcategory for an audio asset from its folder family:
   * `audio/bgm/*` -> "bgm", `audio/sfx/combat/*` -> "sfx/combat",
   * `audio/sfx/monsters/<id>/*` -> "sfx/monsters/<id>", `audio/sfx/ui/*` -> "sfx/ui".
   * Returns undefined for non-audio paths (no subcategory applied).
   */
  private detectAudioSubcategory(rel: string): string | undefined {
    const parts = rel.replaceAll("\\", "/").toLowerCase().split("/").filter(Boolean);
    if (parts[0] !== "audio" || parts.length < 2) return undefined;
    const family = parts[1];
    if (family === "bgm" || family === "music") return "bgm";
    if (family === "ambience") return "ambience";
    if (family === "sfx") {
      const group = parts[2] ?? "misc";
      if (group === "monsters" && parts[3]) return `sfx/monsters/${parts[3]}`;
      return `sfx/${group}`;
    }
    if (family === "_candidates" || family === "candidates") return "candidates";
    return family;
  }

  private async handleAssetUpdate(response: ServerResponse, payload: JsonRecord): Promise<void> {
    const assetId = typeof payload.id === "string" ? payload.id : "";
    if (!assetId) {
      this.json(response, 400, { ok: false, error: "missing id" });
      return;
    }
    let result: JsonRecord = { ok: false, error: "asset not found" };
    await this.updateJson(this.dataPath, { assets: [] as AssetRecord[], generated_at: "" }, (data) => {
      let found = data.assets.find((asset) => asset.id === assetId);
      if (!found && typeof payload.path === "string") {
        found = { id: assetId, name: typeof payload.name === "string" ? payload.name : path.basename(payload.path), path: payload.path, path_from_review_html: `../${payload.path}`, category: "unknown", kind: "sprite", status: "unknown", tags: [], bytes: 0, modified: isoSeconds() };
        data.assets.push(found);
        result = { ok: true, id: assetId, created: true, asset: found };
      }
      if (!found) return;
      const updated: string[] = [];
      for (const key of ["category", "status", "name", "kind", "path", "path_from_review_html", "bytes", "modified", "image"]) {
        if (key in payload) {
          found[key] = payload[key] as never;
          updated.push(key);
        }
      }
      if (Array.isArray(payload.tags)) {
        const existing = new Set(found.tags ?? []);
        if (payload.tags_mode === "add") for (const tag of payload.tags) existing.add(String(tag));
        else if (payload.tags_mode === "remove") for (const tag of payload.tags) existing.delete(String(tag));
        else {
          existing.clear();
          for (const tag of payload.tags) existing.add(String(tag));
        }
        found.tags = [...existing].sort();
        updated.push("tags");
      }
      data.generated_at = isoSeconds();
      result = { ok: true, id: assetId, updated, asset: found };
    });
    this.json(response, result.ok ? 200 : 404, result);
  }

  private async handleRecategorize(response: ServerResponse, payload: JsonRecord): Promise<void> {
    const onlyFrom = new Set(Array.isArray(payload.only_from) ? payload.only_from.map(String) : ["characters"]);
    let changed = 0;
    const data = await this.updateJson(this.dataPath, { assets: [] as AssetRecord[], generated_at: "" }, (catalog) => {
      for (const asset of catalog.assets) {
        if (!onlyFrom.has(asset.category ?? "")) continue;
        const next = this.detectCategory(asset.path ?? "");
        if (next !== asset.category) {
          asset.category = next;
          changed += 1;
        }
      }
    });
    const byCategory: Record<string, number> = {};
    for (const asset of data.assets) byCategory[asset.category ?? "unknown"] = (byCategory[asset.category ?? "unknown"] ?? 0) + 1;
    this.json(response, 200, { ok: true, changed, scoped_to: [...onlyFrom].sort(), by_category: byCategory });
  }

  private async qualityCheck(asset: AssetRecord, promoteType: string): Promise<{ passed: boolean; warnings: string[]; errors: string[] }> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const source = this.safeAssetPath(asset);
    if (!source || !existsSync(source)) return { passed: false, warnings, errors: [`Source file not found: ${asset.path ?? ""}`] };
    const ext = path.extname(source).toLowerCase();
    const limits = qualityLimits[promoteType] ?? {};
    if (limits.formats && !limits.formats.has(ext)) errors.push(`Format ${ext} not allowed for ${promoteType} (need ${[...limits.formats].join(", ")})`);
    const info = await stat(source);
    if (limits.maxBytes && info.size > limits.maxBytes) errors.push(`File too large: ${Math.floor(info.size / 1024)}KB (max ${Math.floor(limits.maxBytes / 1024)}KB)`);
    const image = asset.image ?? {};
    if (limits.maxW && (image.width ?? 0) > limits.maxW) warnings.push(`Width ${image.width}px exceeds recommended ${limits.maxW}px`);
    if (limits.maxH && (image.height ?? 0) > limits.maxH) warnings.push(`Height ${image.height}px exceeds recommended ${limits.maxH}px`);
    if ([".jpg", ".jpeg"].includes(ext) && ["sprite", "tile", "decal", "prop", "icon", "vfx"].includes(promoteType)) errors.push("JPEG not supported for sprites/tiles (no transparency)");
    if (["sprite", "tile", "decal", "prop", "icon", "vfx"].includes(promoteType) && fringeGateExt.has(ext)) {
      const gate = await this.checkDefectGate(source);
      if (!gate.ok) errors.push(`defect gate failed or detected defects: ${gate.output}`);
    }
    return { passed: errors.length === 0, warnings, errors };
  }

  private async handleQualityCheck(response: ServerResponse, payload: JsonRecord): Promise<void> {
    const asset = await this.assetById(payload.assetId);
    if (!asset) {
      this.json(response, typeof payload.assetId === "string" ? 404 : 400, { ok: false, error: typeof payload.assetId === "string" ? "asset not found" : "missing assetId" });
      return;
    }
    const result = await this.qualityCheck(asset, typeof payload.type === "string" ? payload.type : "sprite");
    this.json(response, 200, { ok: true, ...result });
  }

  private async handlePromote(response: ServerResponse, payload: JsonRecord): Promise<void> {
    const asset = await this.assetById(payload.assetId);
    if (!asset) {
      this.json(response, typeof payload.assetId === "string" ? 404 : 400, { ok: false, error: typeof payload.assetId === "string" ? "asset not found" : "missing assetId" });
      return;
    }
    if (isRepoOrigin(asset)) {
      this.json(response, 409, { ok: false, error: `${asset.origin} assets are read-only — already in the repo pipeline; the bank does not promote them`, origin: asset.origin });
      return;
    }
    const promoteType = typeof payload.type === "string" ? payload.type : "sprite";
    const quality = await this.qualityCheck(asset, promoteType);
    if (!quality.passed) {
      this.json(response, 400, { ok: false, error: "Quality check failed", errors: quality.errors, warnings: quality.warnings });
      return;
    }
    const source = this.safeAssetPath(asset);
    if (!source) {
      this.json(response, 400, { ok: false, error: "source outside root" });
      return;
    }
    const ext = path.extname(source).toLowerCase();
    const subdir = assetTypeDirs[promoteType] ?? "misc";
    // Derive the default target key with the shared canonical normalizer so a bank-side
    // promote yields the SAME registry key + runtime filename as the DevKit editor for the
    // same asset (tool-suite-unify; DevKit's normalization is authoritative). An explicit
    // caller-supplied targetName still wins.
    const targetName = typeof payload.targetName === "string" && payload.targetName ? payload.targetName : promoteKeyFromPath(source);
    const targetDir = path.join(this.config.repoRoot, "client", "public", "assets", subdir);
    await mkdir(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, `${targetName}${ext}`);
    const force = payload.force === true;
    const relTarget = `assets/${subdir}/${targetName}${ext}`;
    // Single promotion route: overwrite guard + copy + canonical registry write are shared
    // with the DevKit editor via promoteToRuntime (tools/src/lib/promote-to-runtime.ts).
    let result: Awaited<ReturnType<typeof promoteToRuntime>>;
    try {
      result = await promoteToRuntime({
        sourceAbs: source,
        destAbs: targetPath,
        force,
        assetId: asset.id,
        sourcePath: asset.path ?? "",
        targetPath: relTarget,
        targetName,
        type: promoteType,
        context: typeof payload.context === "string" ? payload.context : "",
        kind: asset.kind ?? "",
        category: asset.category ?? "",
        image: asset.image ?? null,
        warnings: quality.warnings,
      });
    } catch (error) {
      this.json(response, 500, { ok: false, error: `registry write failed: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    if (result.status === "refused") {
      this.json(response, 409, { ok: false, error: result.reason, targetExisted: result.targetExisted, targetPath: relTarget });
      return;
    }
    const targetExisted = result.targetExisted;
    const registryKey = result.registryKey;
    let entityRepointed = 0;
    try {
      entityRepointed = await this.repointEntitiesForPromotion(asset.id ?? "", asset.path ?? "", registryKey);
    } catch (error) {
      quality.warnings.push(`entity repoint skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.mergeReview({ id: asset.id, path: asset.path, decision: "runtime-promoted", status: "promoted", priority: "normal", notes: `Promoted to ${relTarget}` });
    this.json(response, 200, { ok: true, promoted: { assetId: asset.id, targetPath: relTarget, targetName, warnings: quality.warnings, targetExisted, entityRepointed } });
  }

  private async repointEntitiesForPromotion(assetId: string, sourcePath: string, registryKey: string): Promise<number> {
    const registry = await readRegistryStrict();
    const profiles = await this.readEntityProfiles();
    const result = repointEntityProfiles(profiles, registry.promoted, { sourceAssetId: assetId, sourcePath });
    const changes = result.changes.filter((change) => change.registryKey === registryKey);
    if (!changes.length) return 0;
    await this.withLock(async () => atomicWrite(this.entityProfilesPath, result.profiles));
    return changes.length;
  }

  private async handlePromoted(response: ServerResponse): Promise<void> {
    try {
      this.json(response, 200, await readRegistryStrict());
    } catch (error) {
      this.json(response, 500, { ok: false, error: `registry unreadable: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private async handleUnpromote(response: ServerResponse, payload: JsonRecord): Promise<void> {
    const assetId = typeof payload.assetId === "string" ? payload.assetId : "";
    if (!assetId) {
      this.json(response, 400, { ok: false, error: "missing assetId" });
      return;
    }
    let entry: Awaited<ReturnType<typeof unpromoteEntry>> | undefined;
    try {
      const registry = await readRegistryStrict();
      entry = registry.promoted[assetId];
      if (!entry) {
        this.json(response, 404, { ok: false, error: "not in promoted registry" });
        return;
      }
      const usedBy = await this.zoneUsage(entry.targetName);
      await unpromoteEntry(assetId);
      const asset = await this.assetById(assetId);
      await this.mergeReview({
        id: assetId,
        path: asset?.path ?? "",
        decision: "accepted",
        status: "accepted",
        priority: "normal",
        notes: usedBy.length ? `Unpromoted from registry; still referenced by ${usedBy.map((item) => item.file).join(", ")}` : "Unpromoted from registry.",
      });
      this.json(response, 200, { ok: true, removed: assetId, key: entry.targetName, removedFile: null, targetPath: entry.targetPath, stillReferencedBy: usedBy });
    } catch (error) {
      this.json(response, 500, { ok: false, error: `registry write failed: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
  }

  private async zoneUsage(targetName: string): Promise<Array<{ file: string; count: number }>> {
    const zonesDir = path.join(this.config.repoRoot, "content", "zones");
    const usedBy: Array<{ file: string; count: number }> = [];
    let files: string[] = [];
    try {
      files = (await readdir(zonesDir)).filter((file) => file.endsWith(".layout.json"));
    } catch {
      return usedBy;
    }
    for (const file of files) {
      const raw = await readJsonLoose<JsonRecord>(path.join(zonesDir, file), {});
      let count = 0;
      for (const layer of ["ground", "decals", "props"]) {
        const items = raw[layer];
        if (!Array.isArray(items)) continue;
        count += items.filter((item) => isRecord(item) && item.assetKey === targetName).length;
      }
      if (count) usedBy.push({ file, count });
    }
    return usedBy;
  }

  private async handleOpenLocation(response: ServerResponse, payload: JsonRecord): Promise<void> {
    const asset = await this.assetById(payload.id ?? payload.assetId);
    if (!asset) {
      this.json(response, 404, { ok: false, error: "asset not found" });
      return;
    }
    const source = this.safeAssetPath(asset);
    if (!source || !existsSync(source)) {
      this.json(response, 404, { ok: false, error: "file not found" });
      return;
    }
    await execFileAsync(process.platform === "win32" ? "explorer" : "xdg-open", process.platform === "win32" ? [`/select,${source}`] : [path.dirname(source)]).catch(() => undefined);
    this.json(response, 200, { ok: true, path: source });
  }

  private async handleRemoveFromBank(response: ServerResponse, payload: JsonRecord): Promise<void> {
    const assetId = typeof payload.id === "string" ? payload.id : "";
    if (!assetId) {
      this.json(response, 400, { ok: false, error: "missing id" });
      return;
    }
    const result = await this.withLock(async () => {
      const data = await readJsonRmw(this.dataPath, { assets: [] as AssetRecord[], generated_at: "" });
      const asset = data.assets.find((candidate) => candidate.id === assetId);
      if (!asset) return { ok: false, status: 404, error: "asset not found" };
      if (isRepoOrigin(asset)) return { ok: false, status: 409, error: `${asset.origin} assets are read-only — their files belong to the repo, not the bank; remove via the repo, not the bank recycle bin` };
      const source = this.safeAssetPath(asset);
      if (!source || !existsSync(source)) return { ok: false, status: 400, error: "asset file is missing or outside Asset Bank root" };
      const status = await readJsonRmw(this.statusPath, { reviews: [] as ReviewRecord[], generated_at: "" });
      const review = status.reviews.find((candidate) => candidate.id === assetId);
      const registry = await readRegistryStrict();
      if (((review?.decision ?? asset.review?.decision) === "runtime-promoted" || registry.promoted[assetId]) && payload.force !== true) {
        return { ok: false, status: 409, error: "asset is runtime-promoted; unpromote it before removing it from the bank" };
      }
      const deletedRoot = path.join(this.config.assetsRoot, "_deleted", new Date().toISOString().slice(0, 10).replace(/-/g, ""));
      let target = path.resolve(deletedRoot, asset.path ?? slug(assetId));
      if (!isInside(target, path.join(this.config.assetsRoot, "_deleted"))) target = path.resolve(deletedRoot, slug(assetId));
      await mkdir(path.dirname(target), { recursive: true });
      let finalTarget = target;
      let index = 1;
      while (existsSync(finalTarget)) {
        finalTarget = path.join(path.dirname(target), `${path.basename(target, path.extname(target))}-${index}${path.extname(target)}`);
        index += 1;
      }
      await rename(source, finalTarget);
      const beforeAssets = data.assets.length;
      const beforeReviews = status.reviews.length;
      data.assets = data.assets.filter((candidate) => candidate.id !== assetId);
      status.reviews = status.reviews.filter((candidate) => candidate.id !== assetId);
      data.generated_at = isoSeconds();
      status.generated_at = data.generated_at;
      await atomicWrite(this.dataPath, data);
      await atomicWrite(this.statusPath, status);
      const referenceCounts = await this.pruneReferences(assetId, data.generated_at);
      return { ok: true, id: assetId, movedTo: path.relative(this.config.assetsRoot, finalTarget).replaceAll("\\", "/"), removed: { assets: beforeAssets - data.assets.length, reviews: beforeReviews - status.reviews.length, ...referenceCounts } };
    });
    this.json(response, result.ok ? 200 : Number(result.status ?? 400), result);
  }

  private async pruneReferences(assetId: string, generatedAt: string): Promise<JsonRecord> {
    const related = await readJsonRmw(this.relatedGroupsPath, { groups: {}, asset_to_group: {} } as { groups: Record<string, JsonRecord>; asset_to_group: Record<string, string>; generated_at?: string; group_count?: number; asset_count?: number });
    const newGroups: Record<string, JsonRecord> = {};
    const newAssetToGroup: Record<string, string> = {};
    const beforeGroups = Object.keys(related.groups ?? {}).length;
    let relatedItems = 0;
    for (const [groupId, group] of Object.entries(related.groups ?? {})) {
      const items = Array.isArray(group.items) ? group.items.filter((item) => isRecord(item) && item.id !== assetId) : [];
      relatedItems += (Array.isArray(group.items) ? group.items.length : 0) - items.length;
      if (!items.length) continue;
      newGroups[groupId] = { ...group, items, count: items.length };
      for (const item of items) if (typeof item.id === "string") newAssetToGroup[item.id] = groupId;
    }
    related.groups = newGroups;
    related.asset_to_group = newAssetToGroup;
    related.group_count = Object.keys(newGroups).length;
    related.asset_count = Object.keys(newAssetToGroup).length;
    related.generated_at = generatedAt;
    await atomicWrite(this.relatedGroupsPath, related);

    const profiles = await readJsonRmw(this.entityProfilesPath, { entities: {} } as { entities: Record<string, JsonRecord>; generated_at?: string });
    let profileSlots = 0;
    for (const entity of Object.values(isRecord(profiles.entities) ? profiles.entities : {})) {
      const slots = isRecord(entity.slots) ? entity.slots : {};
      for (const [slot, value] of Object.entries(slots)) {
        const boundId = isRecord(value) ? value.assetId : value;
        if (boundId === assetId) {
          slots[slot] = null;
          profileSlots += 1;
        }
      }
    }
    profiles.generated_at = generatedAt;
    await atomicWrite(this.entityProfilesPath, profiles);

    const zones = await readJsonRmw(this.zonePacksPath, { zones: {} } as { zones: Record<string, JsonRecord>; generated_at?: string });
    let zoneRefs = 0;
    for (const zone of Object.values(isRecord(zones.zones) ? zones.zones : {})) {
      const layers = isRecord(zone.layers) ? zone.layers : {};
      for (const [layer, ids] of Object.entries(layers)) {
        if (!Array.isArray(ids)) continue;
        const kept = ids.filter((id) => id !== assetId);
        zoneRefs += ids.length - kept.length;
        layers[layer] = kept;
      }
    }
    zones.generated_at = generatedAt;
    await atomicWrite(this.zonePacksPath, zones);

    const collections = await readJsonRmw(this.collectionsPath, { collections: {} } as { collections: Record<string, JsonRecord>; generated_at?: string });
    let collectionRefs = 0;
    for (const collection of Object.values(isRecord(collections.collections) ? collections.collections : {})) {
      if (Array.isArray(collection.assetIds)) {
        const kept = collection.assetIds.filter((id) => id !== assetId);
        collectionRefs += collection.assetIds.length - kept.length;
        collection.assetIds = kept;
      }
      const bindings = isRecord(collection.bindings) ? collection.bindings : {};
      for (const [key, value] of Object.entries(bindings)) {
        const boundId = isRecord(value) ? value.assetId : value;
        if (key === assetId || boundId === assetId) {
          delete bindings[key];
          collectionRefs += 1;
        }
      }
    }
    collections.generated_at = generatedAt;
    await atomicWrite(this.collectionsPath, collections);
    return { relatedItems, relatedGroups: beforeGroups - Object.keys(newGroups).length, profileSlots, zoneRefs, collectionRefs };
  }

  private async handleAssetBankHealth(response: ServerResponse): Promise<void> {
    try {
      const state = {
        data: await readJsonStrict(this.dataPath, { assets: "array" }),
        status: await readJsonStrict(this.statusPath, { reviews: "array" }),
        related: await readJsonStrict(this.relatedGroupsPath, { groups: "object", asset_to_group: "object" }),
      };
      const profiles = await this.readEntityProfiles();
      const entities = isRecord(profiles.entities) ? (profiles.entities as Record<string, JsonRecord>) : {};
      this.json(response, 200, this.assetBankHealthReport(state, entities));
    } catch (error) {
      this.json(response, 500, { ok: false, error: `health read failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private assetBankHealthReport(state: { data: JsonRecord; status: JsonRecord; related: JsonRecord }, entities: Record<string, JsonRecord>): JsonRecord {
    const assets = Array.isArray(state.data.assets) ? state.data.assets.filter(isRecord) : [];
    const reviews = Array.isArray(state.status.reviews) ? state.status.reviews.filter(isRecord) : [];
    const assetIds = new Set(assets.map((asset) => asset.id).filter((id): id is string => typeof id === "string"));
    const reviewIds = reviews.map((review) => review.id).filter((id): id is string => typeof id === "string");
    const orphanReviewIds = reviewIds.filter((id) => !assetIds.has(id));

    // Stale entity-profile bindings: a slot bound to an assetId absent from the catalog.
    let boundSlots = 0;
    let staleBindings = 0;
    const staleBindingExamples: string[] = [];
    for (const [entityId, entity] of Object.entries(entities)) {
      const slots = isRecord(entity.slots) ? entity.slots : {};
      for (const [slot, value] of Object.entries(slots)) {
        const assetId = isRecord(value) ? value.assetId : value;
        if (typeof assetId !== "string" || !assetId) continue;
        boundSlots += 1;
        if (!assetIds.has(assetId)) {
          staleBindings += 1;
          if (staleBindingExamples.length < 10) staleBindingExamples.push(`${entityId}.${slot}=${assetId}`);
        }
      }
    }

    // Catalog rows whose backing file no longer exists on disk (the "No preview" ghosts).
    // Resolve through the origin-aware path so repo-runtime/repo-source rows check their own
    // roots, not Z:/Assets (else every repo row would read as a missing-file ghost).
    const missingFileAssets = assets.filter((asset) => {
      if (typeof asset.path !== "string") return false;
      const resolved = this.safeAssetPath(asset as AssetRecord);
      return !resolved || !existsSync(resolved);
    });

    const warnings: string[] = [];
    if (staleBindings) warnings.push(`${staleBindings} entity-profile bindings point at assets missing from the catalog`);
    if (missingFileAssets.length) warnings.push(`${missingFileAssets.length} catalog rows point at files missing on disk (run POST /api/catalog/rescan)`);
    if (orphanReviewIds.length) warnings.push(`${orphanReviewIds.length} review rows have no matching catalog asset (run prune-orphan-reviews)`);

    return {
      ok: true,
      catalog: { total: assets.length, uniqueAssetIds: assetIds.size, duplicateAssetIds: assets.length - assetIds.size },
      reviews: { total: reviews.length, uniqueReviewIds: new Set(reviewIds).size, orphanReviewIds: orphanReviewIds.length, missingDecisions: assets.length - reviewIds.length, examples: { orphanReviewIds: orphanReviewIds.slice(0, 10) } },
      bindings: { total: boundSlots, stale: staleBindings, examples: staleBindingExamples },
      missingFiles: { total: missingFileAssets.length, examples: missingFileAssets.slice(0, 10).map((asset) => asset.id) },
      warnings,
      safeRepairActions: ["prune-orphan-reviews", "prune-stale-related-groups"],
      manualRepairNeeded: ["accepted-still-incoming", "rejected-outside-rejected-folder", "unknown-status-normalization"],
    };
  }

  private async handleAssetBankRepair(response: ServerResponse, payload: JsonRecord): Promise<void> {
    const rawActions = payload.actions === "safe" ? ["prune-orphan-reviews", "prune-stale-related-groups"] : payload.actions;
    if (!Array.isArray(rawActions)) {
      this.json(response, 400, { ok: false, error: "actions must be a list or 'safe'" });
      return;
    }
    const actions = rawActions.map(String);
    const unknown = actions.filter((action) => !["prune-orphan-reviews", "prune-stale-related-groups"].includes(action));
    if (unknown.length) {
      this.json(response, 400, { ok: false, error: "unknown repair action", actions: unknown });
      return;
    }
    const result: JsonRecord = { ok: true, actions: {} };
    await this.withLock(async () => {
      const data = await readJsonStrict(this.dataPath, { assets: "array" });
      const assetIds = new Set((data.assets as JsonRecord[]).map((asset) => asset.id).filter((id): id is string => typeof id === "string"));
      if (actions.includes("prune-orphan-reviews")) {
        const status = await readJsonRmw(this.statusPath, { reviews: [] as ReviewRecord[], generated_at: "" });
        const before = status.reviews.length;
        status.reviews = status.reviews.filter((review) => review.id && assetIds.has(review.id));
        status.generated_at = isoSeconds();
        await atomicWrite(this.statusPath, status);
        (result.actions as JsonRecord)["prune-orphan-reviews"] = { removed: before - status.reviews.length };
      }
      if (actions.includes("prune-stale-related-groups")) {
        const related = await readJsonRmw(this.relatedGroupsPath, { groups: {}, asset_to_group: {} } as { groups: Record<string, JsonRecord>; asset_to_group: Record<string, string>; generated_at?: string; group_count?: number; asset_count?: number });
        const beforeGroups = Object.keys(related.groups ?? {}).length;
        let removedItems = 0;
        const newGroups: Record<string, JsonRecord> = {};
        const newAssetToGroup: Record<string, string> = {};
        for (const [groupId, group] of Object.entries(related.groups ?? {})) {
          const sourceItems = Array.isArray(group.items) ? group.items : [];
          const items = sourceItems.filter((item) => isRecord(item) && typeof item.id === "string" && assetIds.has(item.id));
          removedItems += sourceItems.length - items.length;
          if (!items.length) continue;
          newGroups[groupId] = { ...group, items, count: items.length };
          for (const item of items) if (typeof item.id === "string") newAssetToGroup[item.id] = groupId;
        }
        related.groups = newGroups;
        related.asset_to_group = newAssetToGroup;
        related.group_count = Object.keys(newGroups).length;
        related.asset_count = Object.keys(newAssetToGroup).length;
        related.generated_at = isoSeconds();
        await atomicWrite(this.relatedGroupsPath, related);
        (result.actions as JsonRecord)["prune-stale-related-groups"] = { removedItems, removedGroups: beforeGroups - Object.keys(newGroups).length };
      }
    });
    this.json(response, 200, result);
  }

  private async handleGeneratePlan(response: ServerResponse, payload: JsonRecord): Promise<void> {
    const plan = await this.makePlan(typeof payload.id === "string" ? payload.id : "", payload);
    const output = path.join(this.plansDir, `${slug(String(plan.asset_id ?? "asset"))}-promotion-plan.json`);
    await this.withLock(async () => atomicWrite(output, plan));
    this.json(response, 200, { ok: true, path: output, plan });
  }

  private async handleGeneratePack(response: ServerResponse, payload: JsonRecord): Promise<void> {
    const ids = Array.isArray(payload.ids) ? payload.ids.map(String) : [];
    const pack = await this.makePack(ids, payload);
    const output = path.join(this.packsDir, `${slug(typeof payload.name === "string" ? payload.name : "accepted-promotion-pack")}-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}.json`);
    await this.withLock(async () => atomicWrite(output, pack));
    this.json(response, 200, { ok: true, path: output, pack });
  }

  private async makePlan(assetId: string, overrides: JsonRecord = {}): Promise<JsonRecord> {
    const asset = (await this.assetById(assetId)) ?? {};
    const category = asset.category ?? "assets";
    const filename = path.basename(asset.path ?? (assetId || "asset"));
    const runtimeType = ({ ui: "ui", vfx: "vfx", items: "icons/items", props: "props", environments: "maps/candidates", characters: "sprites/candidates", audio: "audio/candidates", animation: "sprites/candidates" } as Record<string, string>)[category] ?? "misc";
    const acceptedGroup = typeof overrides.accepted_group === "string" ? overrides.accepted_group : `${category}/${assetId || "asset"}`;
    return {
      schema: "gamekit-asset-promotion-plan-v1",
      created_at: isoSeconds(),
      asset_id: assetId,
      source_path: `${this.config.assetsRoot}/${asset.path ?? ""}`,
      current_status: (asset.status ?? "unknown"),
      review_decision: overrides.decision ?? "accepted",
      runtime_destination: `${this.config.repoRoot}/client/public/assets/${runtimeType}/${filename}`,
      accepted_source_destination: `${this.config.repoRoot}/assets/sources/accepted/${acceptedGroup}/`,
      required_updates: ["Copy only the reviewed runtime-ready file into client/public/assets.", "Preserve source/prompt/license notes in assets/sources/accepted.", "Update client/public/assets/index.json or relevant runtime config if the asset is loaded by code.", "Run visual or audio review after integration."],
      notes: overrides.notes ?? "Generated from the Node Asset Bank; review before applying.",
      asset,
    };
  }

  private async makePack(ids: string[], overrides: JsonRecord = {}): Promise<JsonRecord> {
    const assets = (await this.readData()).assets.filter((asset) => asset.id && ids.includes(asset.id));
    const byCategory: Record<string, number> = {};
    for (const asset of assets) byCategory[asset.category ?? "unknown"] = (byCategory[asset.category ?? "unknown"] ?? 0) + 1;
    return { schema: "gamekit-asset-promotion-pack-v1", created_at: isoSeconds(), name: overrides.name ?? "accepted-promotion-pack", source_root: this.config.assetsRoot, count: assets.length, by_category: byCategory, items: assets.map((asset) => ({ id: asset.id, path: asset.path, category: asset.category, kind: asset.kind, status: asset.status })), plans: await Promise.all(assets.map((asset) => this.makePlan(asset.id ?? "", overrides))) };
  }

  private async handleRelatedGroupSave(response: ServerResponse, payload: JsonRecord): Promise<void> {
    const groupId = typeof payload.id === "string" ? payload.id : "";
    if (!groupId) {
      this.json(response, 400, { ok: false, error: "missing id" });
      return;
    }
    await this.updateJson(this.relatedGroupsPath, { groups: {}, asset_to_group: {} } as { groups: Record<string, JsonRecord>; asset_to_group: Record<string, string>; group_count?: number; asset_count?: number; generated_at?: string }, async (data) => {
      const existing = data.groups[groupId] ?? {};
      let items = Array.isArray(payload.items) ? payload.items : undefined;
      if (!items) {
        const roles = isRecord(payload.roles) ? payload.roles : {};
        items = await Promise.all((Array.isArray(payload.assetIds) ? payload.assetIds.map(String) : []).map(async (assetId) => {
          const asset = (await this.assetById(assetId)) ?? {};
          return { id: assetId, name: asset.name ?? assetId, path: asset.path ?? "", kind: asset.kind ?? "unknown", category: asset.category ?? "unknown", role: roles[assetId] ?? asset.kind ?? "asset" };
        }));
      }
      data.groups[groupId] = { ...existing, ...Object.fromEntries(["label", "status", "tags", "source"].filter((key) => key in payload).map((key) => [key, payload[key]])), id: groupId, items, count: items.length };
      for (const assetId of Array.isArray(payload.replaceAssetIds) ? payload.replaceAssetIds.map(String) : []) if (data.asset_to_group[assetId] === groupId) delete data.asset_to_group[assetId];
      for (const item of items) if (isRecord(item) && typeof item.id === "string") data.asset_to_group[item.id] = groupId;
      data.group_count = Object.keys(data.groups).length;
      data.asset_count = Object.keys(data.asset_to_group).length;
      data.generated_at = isoSeconds();
    });
    this.json(response, 200, { ok: true, id: groupId });
  }

  private async handleRelatedGroupDelete(response: ServerResponse, payload: JsonRecord): Promise<void> {
    const groupId = typeof payload.id === "string" ? payload.id : "";
    if (!groupId) {
      this.json(response, 400, { ok: false, error: "missing id" });
      return;
    }
    await this.updateJson(this.relatedGroupsPath, { groups: {}, asset_to_group: {} } as { groups: Record<string, JsonRecord>; asset_to_group: Record<string, string>; generated_at?: string; group_count?: number; asset_count?: number }, (data) => {
      delete data.groups[groupId];
      for (const [assetId, current] of Object.entries(data.asset_to_group)) if (current === groupId) delete data.asset_to_group[assetId];
      data.group_count = Object.keys(data.groups).length;
      data.asset_count = Object.keys(data.asset_to_group).length;
      data.generated_at = isoSeconds();
    });
    this.json(response, 200, { ok: true, id: groupId });
  }

  private async mutateObjectFile(filePath: string, fallback: JsonRecord, mutate: (data: JsonRecord) => void): Promise<JsonRecord> {
    return this.updateJson(filePath, fallback, mutate);
  }

  private async handleEntitySave(response: ServerResponse, payload: JsonRecord): Promise<void> {
    const id = typeof payload.id === "string" ? payload.id : "";
    if (!id) {
      this.json(response, 400, { ok: false, error: "missing id" });
      return;
    }
    const data = await this.mutateObjectFile(this.entityProfilesPath, { entities: {} }, (profiles) => {
      const entities = isRecord(profiles.entities) ? profiles.entities : {};
      const entity = isRecord(entities[id]) ? entities[id] : {};
      for (const key of ["type", "gameId", "gameIdType", "label"]) if (key in payload) entity[key] = payload[key];
      entity.id = id;
      entity.slots = isRecord(payload.slots) ? payload.slots : isRecord(entity.slots) ? entity.slots : {};
      entities[id] = entity;
      profiles.entities = entities;
    });
    this.json(response, 200, { ok: true, entity: (data.entities as JsonRecord)[id] });
  }

  private async handleEntityBind(response: ServerResponse, payload: JsonRecord): Promise<void> {
    const entityId = String(payload.entityId ?? "");
    const slot = String(payload.slot ?? "");
    const assetId = String(payload.assetId ?? "");
    if (!entityId || !slot || !assetId) {
      this.json(response, 400, { ok: false, error: "missing entityId, slot, or assetId" });
      return;
    }
    const asset = await this.assetById(assetId);
    if (!asset) {
      this.json(response, 404, { ok: false, error: "asset not found" });
      return;
    }
    const source = this.safeAssetPath(asset);
    if (!source || !existsSync(source)) {
      this.json(response, 400, { ok: false, error: "source file not found or outside root" });
      return;
    }
    let missing = false;
    let bindError = "";
    let audioPromotion: JsonRecord | undefined;
    const data = await this.mutateObjectFile(this.entityProfilesPath, { entities: {} }, async (profiles) => {
      const entities = isRecord(profiles.entities) ? profiles.entities : {};
      const entity = isRecord(entities[entityId]) ? entities[entityId] : undefined;
      if (!entity) {
        missing = true;
        return;
      }
      const status = await this.readStatus();
      const decision = status.reviews.find((review) => review.id === assetId)?.decision ?? "unreviewed";
      entity.slots = isRecord(entity.slots) ? entity.slots : {};
      const slots = entity.slots as JsonRecord;
      const previousSlot = isRecord(slots[slot]) ? slots[slot] : {};
      const runtimeTargetPath = typeof previousSlot.runtimeTargetPath === "string" ? previousSlot.runtimeTargetPath : "";
      if (slot.includes("audio") && runtimeTargetPath) {
        const quality = await this.qualityCheck(asset, "audio");
        if (!quality.passed) {
          bindError = `audio quality check failed: ${quality.errors.join("; ")}`;
          return;
        }
        const normalizedTarget = runtimeTargetPath.replace(/\\/g, "/");
        if (!normalizedTarget.startsWith("assets/audio/")) {
          bindError = `audio runtime target must stay under assets/audio: ${runtimeTargetPath}`;
          return;
        }
        const targetPath = path.resolve(this.config.repoRoot, "client", "public", normalizedTarget);
        const publicRoot = path.join(this.config.repoRoot, "client", "public");
        if (!isInside(targetPath, publicRoot)) {
          bindError = `audio runtime target outside client/public: ${runtimeTargetPath}`;
          return;
        }
        const sourceExt = path.extname(source).toLowerCase();
        const targetExt = path.extname(targetPath).toLowerCase();
        if (sourceExt !== targetExt) {
          bindError = `assigned audio extension ${sourceExt} does not match runtime target ${targetExt}`;
          return;
        }
        await mkdir(path.dirname(targetPath), { recursive: true });
        const overwrite = await promotionOverwriteDecision(source, targetPath, true);
        await copyFile(source, targetPath);
        audioPromotion = {
          runtimeTargetPath: normalizedTarget,
          assignedAssetId: assetId,
          assignedAssetPath: asset.path ?? "",
          targetExisted: overwrite.targetExisted,
        };
        slots[slot] = {
          ...previousSlot,
          assetId: normalizedTarget,
          status: "runtime-promoted",
          bound_at: isoSeconds(),
          runtimeTargetPath: normalizedTarget,
          assignedAssetId: assetId,
          assignedAssetPath: asset.path ?? "",
          assignedDecision: decision,
          targetExisted: overwrite.targetExisted,
        };
        return;
      }
      slots[slot] = { assetId, status: decision, bound_at: isoSeconds() };
    });
    if (bindError) {
      this.json(response, 400, { ok: false, error: bindError });
      return;
    }
    this.json(
      response,
      missing ? 404 : 200,
      missing ? { ok: false, error: "entity not found" } : { ok: true, entity: (data.entities as JsonRecord)[entityId], audioPromotion },
    );
  }

  private async handleEntityUnbind(response: ServerResponse, payload: JsonRecord): Promise<void> {
    await this.handleEntitySlotMutation(response, payload, null);
  }

  private async handleEntityDelete(response: ServerResponse, payload: JsonRecord): Promise<void> {
    const id = String(payload.id ?? "");
    if (!id) {
      this.json(response, 400, { ok: false, error: "missing id" });
      return;
    }
    await this.mutateObjectFile(this.entityProfilesPath, { entities: {} }, (profiles) => {
      if (isRecord(profiles.entities)) delete profiles.entities[id];
    });
    this.json(response, 200, { ok: true, id });
  }

  private async handleEntitySlotMutation(response: ServerResponse, payload: JsonRecord, value: unknown): Promise<void> {
    const entityId = String(payload.entityId ?? "");
    const slot = String(payload.slot ?? "");
    if (!entityId || !slot) {
      this.json(response, 400, { ok: false, error: "missing entityId or slot" });
      return;
    }
    let missing = false;
    const data = await this.mutateObjectFile(this.entityProfilesPath, { entities: {} }, (profiles) => {
      const entities = isRecord(profiles.entities) ? profiles.entities : {};
      const entity = isRecord(entities[entityId]) ? entities[entityId] : undefined;
      if (!entity) {
        missing = true;
        return;
      }
      entity.slots = isRecord(entity.slots) ? entity.slots : {};
      (entity.slots as JsonRecord)[slot] = value;
    });
    this.json(response, missing ? 404 : 200, missing ? { ok: false, error: "entity not found" } : { ok: true, entity: (data.entities as JsonRecord)[entityId] });
  }

  private async handleZoneSave(response: ServerResponse, payload: JsonRecord): Promise<void> {
    const id = String(payload.id ?? "");
    if (!id) {
      this.json(response, 400, { ok: false, error: "missing id" });
      return;
    }
    const data = await this.mutateObjectFile(this.zonePacksPath, { zones: {} }, (packs) => {
      const zones = isRecord(packs.zones) ? packs.zones : {};
      const zone = isRecord(zones[id]) ? zones[id] : {};
      zone.id = id;
      for (const key of ["label", "mapIds"]) if (key in payload) zone[key] = payload[key];
      zone.layers = isRecord(payload.layers) ? payload.layers : isRecord(zone.layers) ? zone.layers : {};
      zones[id] = zone;
      packs.zones = zones;
    });
    this.json(response, 200, { ok: true, zone: (data.zones as JsonRecord)[id] });
  }

  private async handleZoneDelete(response: ServerResponse, payload: JsonRecord): Promise<void> {
    const id = String(payload.id ?? "");
    if (!id) {
      this.json(response, 400, { ok: false, error: "missing id" });
      return;
    }
    let missing = false;
    await this.mutateObjectFile(this.zonePacksPath, { zones: {} }, (packs) => {
      const zones = isRecord(packs.zones) ? packs.zones : {};
      if (!isRecord(zones[id])) {
        missing = true;
        return;
      }
      delete zones[id];
      packs.zones = zones;
    });
    this.json(response, missing ? 404 : 200, missing ? { ok: false, error: "zone not found" } : { ok: true, deleted: id });
  }

  private async handleZoneAddAsset(response: ServerResponse, payload: JsonRecord): Promise<void> {
    await this.handleLayerAssetMutation(response, this.zonePacksPath, "zones", String(payload.zoneId ?? ""), String(payload.layer ?? ""), String(payload.assetId ?? ""), true, "zone");
  }

  private async handleZoneRemoveAsset(response: ServerResponse, payload: JsonRecord): Promise<void> {
    await this.handleLayerAssetMutation(response, this.zonePacksPath, "zones", String(payload.zoneId ?? ""), String(payload.layer ?? ""), String(payload.assetId ?? ""), false, "zone");
  }

  private async handleLayerAssetMutation(response: ServerResponse, filePath: string, rootKey: string, id: string, layer: string, assetId: string, add: boolean, label: string): Promise<void> {
    if (!id || !layer || !assetId) {
      this.json(response, 400, { ok: false, error: `missing ${label}Id, layer, or assetId` });
      return;
    }
    let missing = false;
    const data = await this.mutateObjectFile(filePath, { [rootKey]: {} }, (root) => {
      const group = isRecord(root[rootKey]) ? root[rootKey] : {};
      const target = isRecord(group[id]) ? group[id] : undefined;
      if (!target) {
        missing = true;
        return;
      }
      target.layers = isRecord(target.layers) ? target.layers : {};
      const layers = target.layers as JsonRecord;
      const list = Array.isArray(layers[layer]) ? layers[layer] as string[] : [];
      layers[layer] = add ? [...new Set([...list, assetId])] : list.filter((item) => item !== assetId);
    });
    this.json(response, missing ? 404 : 200, missing ? { ok: false, error: `${label} not found` } : { ok: true, [label]: (data[rootKey] as JsonRecord)[id] });
  }

  private async handleCollectionSave(response: ServerResponse, payload: JsonRecord): Promise<void> {
    const id = String(payload.id ?? "");
    if (!id) {
      this.json(response, 400, { ok: false, error: "missing id" });
      return;
    }
    const data = await this.mutateObjectFile(this.collectionsPath, { collections: {} }, (root) => {
      const collections = isRecord(root.collections) ? root.collections : {};
      const collection = isRecord(collections[id]) ? collections[id] : {};
      collection.id = id;
      for (const key of ["label", "category", "assetIds", "bindings"]) if (key in payload) collection[key] = payload[key];
      if (!Array.isArray(collection.assetIds)) collection.assetIds = [];
      if (!isRecord(collection.bindings)) collection.bindings = {};
      collections[id] = collection;
      root.collections = collections;
    });
    this.json(response, 200, { ok: true, collection: (data.collections as JsonRecord)[id] });
  }

  private async handleCollectionAddAsset(response: ServerResponse, payload: JsonRecord): Promise<void> {
    const collectionId = String(payload.collectionId ?? "");
    const assetId = String(payload.assetId ?? "");
    if (!collectionId || !assetId) {
      this.json(response, 400, { ok: false, error: "missing collectionId or assetId" });
      return;
    }
    let missing = false;
    const data = await this.mutateObjectFile(this.collectionsPath, { collections: {} }, (root) => {
      const collections = isRecord(root.collections) ? root.collections : {};
      const collection = isRecord(collections[collectionId]) ? collections[collectionId] : undefined;
      if (!collection) {
        missing = true;
        return;
      }
      const list = Array.isArray(collection.assetIds) ? collection.assetIds as string[] : [];
      collection.assetIds = [...new Set([...list, assetId])];
    });
    this.json(response, missing ? 404 : 200, missing ? { ok: false, error: "collection not found" } : { ok: true, collection: (data.collections as JsonRecord)[collectionId] });
  }

  private async handleCollectionBind(response: ServerResponse, payload: JsonRecord): Promise<void> {
    const collectionId = String(payload.collectionId ?? "");
    const gameId = String(payload.gameId ?? "");
    const assetId = String(payload.assetId ?? "");
    if (!collectionId || !gameId || !assetId) {
      this.json(response, 400, { ok: false, error: "missing collectionId, gameId, or assetId" });
      return;
    }
    let missing = false;
    const data = await this.mutateObjectFile(this.collectionsPath, { collections: {} }, (root) => {
      const collections = isRecord(root.collections) ? root.collections : {};
      const collection = isRecord(collections[collectionId]) ? collections[collectionId] : undefined;
      if (!collection) {
        missing = true;
        return;
      }
      collection.bindings = isRecord(collection.bindings) ? collection.bindings : {};
      (collection.bindings as JsonRecord)[gameId] = assetId;
    });
    this.json(response, missing ? 404 : 200, missing ? { ok: false, error: "collection not found" } : { ok: true, collection: (data.collections as JsonRecord)[collectionId] });
  }

  private async handleCoverageReport(response: ServerResponse): Promise<void> {
    const profiles = await this.readEntityProfiles();
    const packs = await this.readZonePacks();
    this.json(response, 200, { ok: true, generated_at: isoSeconds(), entities: { count: Object.keys(profiles.entities).length, details: profiles.entities }, zones: { count: Object.keys(packs.zones).length, details: packs.zones } });
  }
}

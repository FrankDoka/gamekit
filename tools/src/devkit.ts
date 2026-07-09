import { exec, execFile, spawn, execSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assetsRoot as defaultAssetsRoot, assetsMetadataRoot as defaultAssetsMetadataRoot } from "./toolkit-config.js";
import {
  AssetEditorMetadata,
  AssetPlacementDefaults,
  assetPlacementDefaultsFor,
  resolveAssetPlacement,
  ZoneLayout,
} from "@gamekit/game-contract";
import { unpromoteEntry, readRegistryStrict } from "./promoted-registry.js";
import { promoteKeyFromPath } from "./promote-key.js";
import { promoteToRuntime } from "./lib/promote-to-runtime.js";
import { computeLayoutExportDrift } from "./check-layout-export-drift.js";
import { repointEntityProfiles } from "./assets-repoint-entities.js";
import { DevkitHub } from "./devkit-hub.js";
import { verifyRouteDocs } from "./api-docs.js";
import { createDevkitRoutes } from "./devkit-routes.js";
import { createStaticHandlers, isInside } from "./devkit-static.js";
import { createZoneCommandHandlers } from "./devkit-zone-command-handlers.js";
import { generateDungeon, WALL, FLOOR } from "@gamekit/game-contract";
import { emitLayout } from "@gamekit/game-contract";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/** Run a repo command off the event loop; concatenates stdout+stderr on failure
 * (fixes the `a ?? "" + b` precedence bug that silently dropped stderr). */
async function runRepoCommand(command: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execAsync(command, { cwd: repoRoot, encoding: "utf8", timeout: timeoutMs });
    return { ok: true, output: `${stdout}${stderr}` };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` || (e.message ?? String(err)) };
  }
}

/** FAIL-CLOSED defect gate for the editor auto-promote route. `handlePromoteAsset` used to
 * copy bank files straight into the runtime with no check at all — the confirmed hole that
 * let purple-rim/fringe assets ship (charter R0, 2026-07-02; devlogs 0191/0192 promoted
 * grove/harbor assets through exactly this route). Shells out to the same fringe.py gate
 * the bank server and `pnpm assets:check` use (tools/asset-cleanup/fringe.py, now covers
 * hard chroma fringe, full chroma bg, pink/purple rim, and opaque cut-outs) so there is one
 * defect-detection implementation, not a second one that could drift. A non-zero exit
 * (defect found, OR python/Pillow/numpy missing, OR any other failure) refuses promotion —
 * "promoted" must always mean "gated", the same contract the bank server already enforces. */
async function checkAssetDefectGate(sourceAbs: string): Promise<{ ok: boolean; output: string }> {
  // No shell: pass the source path as a discrete argv entry so paths containing shell
  // metacharacters (&, ^, %, spaces, parens on Windows) can't mis-parse and wrongly refuse
  // a clean asset. Non-zero exit (defect, or python/Pillow/numpy missing) still fails closed.
  try {
    const { stdout, stderr } = await execFileAsync(
      "python",
      ["tools/asset-cleanup/fringe.py", "check", sourceAbs],
      { cwd: repoRoot, encoding: "utf8", timeout: 30000 },
    );
    return { ok: true, output: `${stdout}${stderr}` };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` || (e.message ?? String(err)) };
  }
}

type QueueSummary = {
  name: string;
  count: number;
  liveCount: number;
  staleCount: number;
  path: string;
};

type FramePickerCandidate = {
  path: string;
  frameCount: number;
  hasSelection: boolean;
  modifiedMs: number;
};

const args = process.argv.slice(2);

function argValue(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const devkitRoot = path.join(repoRoot, "tools", "devkit");
const assetEditorMetadataPath = path.join(repoRoot, "content", "asset-editor-metadata.json");
const assetsRoot = path.resolve(argValue("--assets-root") ?? defaultAssetsRoot());
const assetsMetadataRoot = path.resolve(argValue("--assets-metadata-root") ?? defaultAssetsMetadataRoot());
// Single canonical review-metadata folder. The asset-bank server reads AND writes
// decisions here (launched with --metadata-root), so the editor pipeline reads the
// SAME folder — UI and pipeline can never drift apart. See docs/process/asset-bank-workflow.md.
const reviewRoot = path.join(assetsMetadataRoot, "_review");
const port = Number(argValue("--port") ?? "8787");
const assetBankPort = Number(argValue("--asset-bank-port") ?? "8765");
const framePickerPort = Number(argValue("--frame-picker-port") ?? "5217");

// Session token — "invisible token" auth (owner-ratified 2026-07-01). Served pages fetch it
// same-origin; local CLI reads the file; cross-origin browser POSTs without it are rejected.
const sessionToken = randomBytes(24).toString("hex");
const sessionTokenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "devkit", ".session-token");

function isLoopbackOrigin(origin: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendText(response: ServerResponse, statusCode: number, text: string): void {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(text);
}

async function readRequestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readJson(pathName: string, fallback: unknown): Promise<unknown> {
  try {
    return JSON.parse(await readFile(pathName, "utf8"));
  } catch {
    return fallback;
  }
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonStable(value: unknown): string {
  return JSON.stringify(sortJsonValue(value), null, 2);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJsonValue(value[key])]));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readTextWithInfo(filePath: string): Promise<{ text: string; hash: string; modifiedMs: number }> {
  const text = await readFile(filePath, "utf8");
  const info = await stat(filePath);
  return { text, hash: hashText(text), modifiedMs: info.mtimeMs };
}

function requireFreshFile(
  response: ServerResponse,
  current: { hash: string; modifiedMs: number },
  payload: Record<string, unknown>,
): boolean {
  const baseHash = typeof payload.baseHash === "string" ? payload.baseHash : "";
  const baseModifiedMs = typeof payload.baseModifiedMs === "number" ? payload.baseModifiedMs : undefined;
  if (!baseHash || typeof baseModifiedMs !== "number") {
    sendJson(response, 400, { ok: false, error: "baseHash and baseModifiedMs required" });
    return false;
  }
  if (current.hash !== baseHash) {
    sendJson(response, 409, { ok: false, error: "stale file: hash changed" });
    return false;
  }
  if (Math.abs(current.modifiedMs - baseModifiedMs) > 1) {
    sendJson(response, 409, { ok: false, error: "stale file: mtime changed" });
    return false;
  }
  return true;
}

async function loadAssetEditorMetadata(): Promise<{
  metadata: AssetEditorMetadata;
  hash: string;
  modifiedMs: number;
  text: string;
}> {
  const file = await readTextWithInfo(assetEditorMetadataPath);
  const parsedJson = JSON.parse(file.text);
  const parsed = AssetEditorMetadata.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`asset-editor-metadata.json schema invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  return { metadata: parsed.data, hash: file.hash, modifiedMs: file.modifiedMs, text: file.text };
}

type PlacementLayer = "props" | "decals";
type ZoneLoopStepName = "save" | "sync" | "export" | "build" | "restart" | "reload" | "redress";

type ZoneLoopStep = {
  name: ZoneLoopStepName;
  label: string;
  ok: boolean;
  dryRun?: boolean;
  output: string;
};

function placementKindForLayer(layer: PlacementLayer): "prop" | "decal" {
  return layer === "props" ? "prop" : "decal";
}

function coercePlacementLayer(value: unknown): PlacementLayer | undefined {
  return value === "props" || value === "decals" ? value : undefined;
}

function sanitizePlacementInstance(layer: PlacementLayer, value: unknown): unknown {
  const object = isPlainRecord(value) ? value : {};
  const allowedKeys =
    layer === "props"
      ? ["instanceId", "assetKey", "x", "y", "zIndex", "scale", "rotation", "origin", "opacity", "shadow", "reflection", "collision", "legacyPixelCollision"]
      : ["instanceId", "assetKey", "x", "y", "zIndex", "scale", "rotation", "origin", "opacity"];
  return Object.fromEntries(Object.entries(object).filter(([key]) => allowedKeys.includes(key)));
}

function sanitizePlacementDefaults(value: unknown, assetKey: string, layer: PlacementLayer): unknown {
  const object = isPlainRecord(value) ? value : {};
  const allowedKeys = [
    "assetKey",
    "bankAssetId",
    "promotedRegistryKey",
    "placementKind",
    "sourceSize",
    "defaultScale",
    "origin",
    "rotation",
    "opacity",
    "zIndex",
    "collision",
    "shadow",
    "reflection",
    "placementTags",
    "placementNotes",
  ];
  const defaults = Object.fromEntries(Object.entries(object).filter(([key]) => allowedKeys.includes(key)));
  defaults.assetKey = assetKey;
  defaults.placementKind = placementKindForLayer(layer);
  if (layer === "decals") {
    delete defaults.shadow;
    delete defaults.reflection;
  }
  return defaults;
}

function valueAtPath(source: unknown, dottedPath: string): unknown {
  return dottedPath.split(".").reduce<unknown>((value, part) => {
    if (!isPlainRecord(value)) return undefined;
    return value[part];
  }, source);
}

function fieldSource(instance: unknown, defaults: unknown, instancePath: string, defaultPath?: string): "overridden" | "inherited" | "fallback" {
  if (valueAtPath(instance, instancePath) !== undefined) return "overridden";
  if (valueAtPath(defaults, defaultPath ?? instancePath) !== undefined) return "inherited";
  return "fallback";
}

function placementFieldSources(instance: unknown, defaults: unknown): Record<string, "overridden" | "inherited" | "fallback"> {
  return {
    scale: fieldSource(instance, defaults, "scale", "defaultScale"),
    origin: fieldSource(instance, defaults, "origin"),
    "origin.x": fieldSource(instance, defaults, "origin.x"),
    "origin.y": fieldSource(instance, defaults, "origin.y"),
    rotation: fieldSource(instance, defaults, "rotation"),
    opacity: fieldSource(instance, defaults, "opacity"),
    zIndex: fieldSource(instance, defaults, "zIndex"),
    collision: fieldSource(instance, defaults, "collision"),
    shadow: fieldSource(instance, defaults, "shadow"),
    reflection: fieldSource(instance, defaults, "reflection"),
  };
}

function diffObjects(before: unknown, after: unknown): Array<{ path: string; before: unknown; after: unknown }> {
  const changes: Array<{ path: string; before: unknown; after: unknown }> = [];
  const visit = (pathName: string, left: unknown, right: unknown): void => {
    if (jsonStable(left) === jsonStable(right)) return;
    if (isPlainRecord(left) && isPlainRecord(right)) {
      const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
      for (const key of [...keys].sort()) visit(pathName ? `${pathName}.${key}` : key, left[key], right[key]);
      return;
    }
    changes.push({ path: pathName || "(root)", before: left, after: right });
  };
  visit("", before, after);
  return changes;
}

async function handleAssetPlacementDefaults(response: ServerResponse): Promise<void> {
  try {
    const { metadata, hash, modifiedMs } = await loadAssetEditorMetadata();
    sendJson(response, 200, { metadata, hash, modifiedMs, file: "content/asset-editor-metadata.json" });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleAssetPlacementDefaultsPreview(response: ServerResponse, request: IncomingMessage): Promise<void> {
  const payload = await readRequestJson(request);
  const layer = coercePlacementLayer(payload.layer);
  const assetKey = typeof payload.assetKey === "string" ? payload.assetKey : "";
  if (!assetKey || !layer) {
    sendJson(response, 400, { ok: false, error: "assetKey and layer props|decals required" });
    return;
  }
  const { metadata, hash, modifiedMs } = await loadAssetEditorMetadata();
  const before = metadata.assets[assetKey];
  const candidateInput = payload.defaults === undefined ? before : sanitizePlacementDefaults(payload.defaults, assetKey, layer);
  const parsedDefaults = candidateInput === undefined ? undefined : AssetPlacementDefaults.safeParse(candidateInput);
  if (parsedDefaults && !parsedDefaults.success) {
    sendJson(response, 400, { ok: false, error: "placement defaults invalid", issues: parsedDefaults.error.issues });
    return;
  }
  const nextDefaults = parsedDefaults?.data;
  const instance = sanitizePlacementInstance(layer, payload.instance);
  // Resolve against the SAME class-merged defaults the exporter uses
  // (assetPlacementDefaultsFor layers the per-asset `assets` entry over the matching
  // placementClass). The old code resolved against `metadata.assets[assetKey]` only,
  // so `resolved.collision` came back undefined for any asset whose collision comes
  // from a glob class (`*_stall*`, `*barrel*`, trees) — the editor then showed
  // "no collision" on props that block in-game. `before`/`after`/`diff` stay per-asset
  // because that is exactly the layer a Save-global writes.
  const metadataForResolve =
    nextDefaults === undefined
      ? metadata
      : { ...metadata, assets: { ...metadata.assets, [assetKey]: nextDefaults } };
  const effectiveDefaults = assetPlacementDefaultsFor(metadataForResolve, assetKey);
  const resolved = resolveAssetPlacement(
    { ...(isPlainRecord(instance) ? instance : {}), assetKey },
    effectiveDefaults,
  );
  sendJson(response, 200, {
    ok: true,
    file: "content/asset-editor-metadata.json",
    hash,
    modifiedMs,
    before,
    after: nextDefaults,
    diff: diffObjects(before ?? null, nextDefaults ?? null),
    resolved,
    sources: placementFieldSources(instance, effectiveDefaults),
  });
}

async function handleAssetPlacementDefaultsSave(response: ServerResponse, request: IncomingMessage): Promise<void> {
  const payload = await readRequestJson(request);
  const layer = coercePlacementLayer(payload.layer);
  const assetKey = typeof payload.assetKey === "string" ? payload.assetKey : "";
  if (!assetKey || !layer || payload.defaults === undefined) {
    sendJson(response, 400, { ok: false, error: "assetKey, layer props|decals, and defaults required" });
    return;
  }

  const loaded = await loadAssetEditorMetadata();
  if (!requireFreshFile(response, loaded, payload)) return;

  const sanitized = sanitizePlacementDefaults(payload.defaults, assetKey, layer);
  const parsedDefaults = AssetPlacementDefaults.safeParse(sanitized);
  if (!parsedDefaults.success) {
    sendJson(response, 400, { ok: false, error: "placement defaults invalid", issues: parsedDefaults.error.issues });
    return;
  }

  const nextMetadata: AssetEditorMetadata = {
    // Spread the loaded metadata FIRST so top-level fields survive a per-asset save.
    // Rebuilding as only {schemaVersion, assets} silently dropped `placementClasses`
    // (the prop-collision rule classes) on every real save — a data-loss bug that wiped
    // ~85 lines of collision rules whenever an editor placement default changed.
    ...loaded.metadata,
    assets: { ...loaded.metadata.assets, [assetKey]: parsedDefaults.data },
  };
  const parsedMetadata = AssetEditorMetadata.safeParse(nextMetadata);
  if (!parsedMetadata.success) {
    sendJson(response, 400, { ok: false, error: "asset metadata invalid", issues: parsedMetadata.error.issues });
    return;
  }

  const diff = diffObjects(loaded.metadata.assets[assetKey] ?? null, parsedDefaults.data);
  if (diff.length === 0) {
    sendJson(response, 200, {
      ok: true,
      file: "content/asset-editor-metadata.json",
      hash: loaded.hash,
      modifiedMs: loaded.modifiedMs,
      before: loaded.metadata.assets[assetKey],
      after: parsedDefaults.data,
      diff,
      unchanged: true,
    });
    return;
  }

  const outputText = JSON.stringify(parsedMetadata.data, null, 2) + "\n";
  await writeFile(assetEditorMetadataPath, outputText, "utf8");
  const nextInfo = await stat(assetEditorMetadataPath);
  sendJson(response, 200, {
    ok: true,
    file: "content/asset-editor-metadata.json",
    hash: hashText(outputText),
    modifiedMs: nextInfo.mtimeMs,
    before: loaded.metadata.assets[assetKey],
    after: parsedDefaults.data,
    diff,
  });
}

async function health(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(750) });
    return response.ok;
  } catch {
    return false;
  }
}

function commandName(name: string): string {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function startDetached(command: string, commandArgs: string[], cwd: string, env?: NodeJS.ProcessEnv): number | null {
  // shell:true is REQUIRED on Windows/Node 22+ — spawning a .cmd/.bat launcher (pnpm.cmd) without
  // it throws EINVAL, which was silently swallowed by stdio:"ignore" (Frame Picker + audio review
  // never actually launched). The world/dev-server smoke harness uses the same shell:true pattern.
  const child = spawn(command, commandArgs, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: true,
  });
  child.on("error", (err) => console.error(`[devkit] failed to launch ${command}:`, err.message));
  child.unref();
  return child.pid ?? null;
}

const localRoot = path.join(repoRoot, ".local");

// Launch a repo tool server detached, WITHOUT a shell, streaming stdout+stderr to a log file.
// Two wins over startDetached for long-lived tool servers: (1) no `cmd.exe /c` wrapper, so no
// console window flashes on Windows; (2) a real log to tail, so a crash (e.g. EADDRINUSE) is
// diagnosable instead of vanishing into stdio:"ignore". Mirrors the hub's spawnTracked pattern.
function spawnToolServerLogged(scriptRel: string, scriptArgs: string[], logPath: string, env?: NodeJS.ProcessEnv): number | null {
  const logFd = openSync(logPath, "a");
  const child = spawn(process.execPath, [path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), scriptRel, ...scriptArgs], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  // The detached child inherited its own dup of logFd via stdio; close the parent's copy
  // so a devkit that restarts tool servers repeatedly does not leak one fd per launch.
  closeSync(logFd);
  child.on("error", (err) => console.error(`[devkit] failed to launch ${scriptRel}:`, err.message));
  child.unref();
  return child.pid ?? null;
}

// TCP-level "is something listening on this loopback port". Complements the HTTP health probe:
// a port can be held (so a fresh listen would EADDRINUSE) by a process that never answers
// /api/health. We must not blind-spawn onto an occupied port.
function tcpPortListening(portNumber: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: portNumber });
    const done = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitForHealthy(url: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await health(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

async function tailLogLines(filePath: string, lines: number): Promise<string[]> {
  if (!existsSync(filePath)) return [];
  try {
    const text = await readFile(filePath, "utf8");
    return text.split(/\r?\n/).filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

function assertLocalPath(value: string): string {
  const resolved = path.resolve(value);
  if (!isInside(resolved, repoRoot) && !isInside(resolved, assetsRoot)) {
    throw new Error(`Path must be inside ${repoRoot} or ${assetsRoot}`);
  }
  return resolved;
}

async function queueSummaries(): Promise<QueueSummary[]> {
  const canonicalQueueDir = path.join(reviewRoot, "queues");
  const legacyQueueDir = path.join(assetsRoot, "_review", "queues");
  const queueDir = existsSync(canonicalQueueDir) ? canonicalQueueDir : legacyQueueDir;
  let files: string[] = [];
  try {
    files = await readdir(queueDir);
  } catch {
    return [];
  }
  const catalog = (await readJson(path.join(reviewRoot, "asset-review-data.json"), { assets: [] })) as {
    assets?: Array<{ id?: string; path?: string }>;
  };
  const assets = catalog.assets ?? [];
  const liveIds = new Set(assets.map((asset) => asset.id).filter((id): id is string => Boolean(id)));
  const livePaths = new Set(
    assets.map((asset) => asset.path?.replace(/\\/g, "/").toLowerCase()).filter((item): item is string => Boolean(item)),
  );
  const resolveQueueItem = (item: unknown): boolean => {
    if (typeof item === "string") return liveIds.has(item);
    if (!item || typeof item !== "object") return false;
    const record = item as { id?: unknown; assetId?: unknown; asset_id?: unknown; path?: unknown };
    const id = [record.id, record.assetId, record.asset_id].find((value): value is string => typeof value === "string");
    if (id && liveIds.has(id)) return true;
    if (typeof record.path !== "string") return false;
    return livePaths.has(record.path.replace(/\\/g, "/").toLowerCase());
  };
  const summaries: QueueSummary[] = [];
  for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
    const filePath = path.join(queueDir, file);
    const payload = (await readJson(filePath, {})) as { items?: unknown[]; count?: number };
    const items = Array.isArray(payload.items) ? payload.items : [];
    const rawCount = items.length || Number(payload.count ?? 0);
    const liveCount = items.filter(resolveQueueItem).length;
    summaries.push({
      name: path.basename(file, ".json"),
      count: rawCount,
      liveCount,
      staleCount: Math.max(0, rawCount - liveCount),
      path: filePath,
    });
  }
  return summaries;
}

async function countAssets(): Promise<{ total: number; visible: number; hidden: number }> {
  const payload = (await readJson(path.join(reviewRoot, "asset-review-data.json"), { assets: [] })) as {
    assets?: Array<{ review?: { hidden?: boolean }; tags?: string[] }>;
  };
  const assets = payload.assets ?? [];
  const hidden = assets.filter((asset) => asset.review?.hidden || asset.tags?.includes("review:hidden")).length;
  return { total: assets.length, visible: assets.length - hidden, hidden };
}

async function walkForFrameCandidates(root: string, out: FramePickerCandidate[], depth = 0): Promise<void> {
  if (out.length >= 80 || depth > 6) return;
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  const rawDir = path.join(root, "frames", "raw");
  try {
    const frames = (await readdir(rawDir)).filter((name) => /\.(png|jpe?g|webp)$/i.test(name));
    if (frames.length > 0) {
      const info = await stat(root);
      out.push({
        path: root,
        frameCount: frames.length,
        hasSelection: existsSync(path.join(root, "frame-selection.json")),
        modifiedMs: info.mtimeMs,
      });
      if (out.length >= 80) return;
    }
  } catch {
    // Not a Frame Picker candidate folder.
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (["node_modules", ".git", "dist", "client", "server"].includes(entry.name)) continue;
    await walkForFrameCandidates(path.join(root, entry.name), out, depth + 1);
    if (out.length >= 80) return;
  }
}

async function framePickerCandidates(): Promise<FramePickerCandidate[]> {
  const candidates: FramePickerCandidate[] = [];
  const roots = [
    path.join(repoRoot, "tmp"),
    path.join(repoRoot, "assets", "sources"),
    path.join(assetsRoot, "animation"),
    path.join(assetsRoot, "characters"),
  ];
  for (const root of roots) {
    await walkForFrameCandidates(root, candidates);
  }
  return candidates.sort((a, b) => b.modifiedMs - a.modifiedMs);
}

async function handleStatus(response: ServerResponse): Promise<void> {
  const queues = await queueSummaries();
  sendJson(response, 200, {
    repoRoot,
    assetsRoot,
    port,
    assetBank: {
      url: `http://127.0.0.1:${assetBankPort}/_review/asset-review-server.html`,
      running: await health(`http://127.0.0.1:${assetBankPort}/api/health`),
    },
    framePicker: {
      url: `http://127.0.0.1:${framePickerPort}/`,
      running: await health(`http://127.0.0.1:${framePickerPort}/api/candidate`),
    },
    audio: {
      reviewHtml: path.join(assetsRoot, "audio", "generated", "audio-review.html"),
      reviewExists: existsSync(path.join(assetsRoot, "audio", "generated", "audio-review.html")),
    },
    assetCounts: await countAssets(),
    queues,
  });
}

function killPort(portNumber: number): boolean {
  // Windows-first (this project runs on win32); best-effort POSIX fallback.
  try {
    if (process.platform === "win32") {
      const out = execSync(`netstat -ano -p tcp | findstr ":${portNumber} " | findstr LISTENING`, { encoding: "utf8" });
      const pids = new Set(out.trim().split(/\r?\n/).map((l) => l.trim().split(/\s+/).pop()).filter((p): p is string => Boolean(p) && p !== "0"));
      for (const pid of pids) { try { execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" }); } catch { /* already gone */ } }
      return pids.size > 0;
    }
    execSync(`lsof -ti tcp:${portNumber} | xargs -r kill -9`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function handleStartAssetBank(response: ServerResponse, request: IncomingMessage): Promise<void> {
  const payload = (await readRequestJson(request).catch(() => ({}))) as Record<string, unknown>;
  const restart = payload.restart === true;
  const url = `http://127.0.0.1:${assetBankPort}/_review/asset-review-server.html`;
  const healthUrl = `http://127.0.0.1:${assetBankPort}/api/health`;
  const alive = await health(healthUrl);

  if (payload.dryRun === true) {
    // Side-effect-free: report what a real call would do so the smoke gate can assert the
    // contract without leaving a spawned server running.
    sendJson(response, 200, { ok: true, dryRun: true, alreadyRunning: alive, wouldRestart: alive && restart, port: assetBankPort, url });
    return;
  }

  // Healthy + plain start => surface "already running", do NOT spawn. Spawning onto a live
  // port is exactly what made a second launch EADDRINUSE-crash and flash a console (backlog p0).
  if (alive && !restart) {
    sendJson(response, 200, { ok: true, alreadyRunning: true, hint: "pass {\"restart\":true} to reload code changes", url });
    return;
  }

  let killed = false;
  if (restart && (alive || (await tcpPortListening(assetBankPort)))) {
    killed = killPort(assetBankPort);
    await new Promise((r) => setTimeout(r, 700));
  }

  // Refuse to spawn onto an occupied port. Without this the child would hit EADDRINUSE; with the
  // new server.on("error") it now exits loudly, but pre-empting the doomed launch gives the panel
  // a clear message instead of a launch-then-die cycle.
  if (await tcpPortListening(assetBankPort)) {
    sendJson(response, 200, {
      ok: false,
      error: `Port ${assetBankPort} is still in use and could not be freed. Close the process holding it (or retry) before starting the Asset Bank.`,
      killed,
      url,
    });
    return;
  }

  // Launch the Node Asset Bank server. It serves the historical :8765 API/UI while sharing
  // DevKit's invisible token. Shell-less + logged so it can't flash a console and a failed boot
  // is diagnosable (see spawnToolServerLogged).
  const logPath = path.join(localRoot, "asset-bank.log");
  await mkdir(localRoot, { recursive: true });
  const pid = spawnToolServerLogged(
    "tools/src/asset-bank-server.ts",
    [String(assetBankPort), "--assets-root", assetsRoot, "--metadata-root", assetsMetadataRoot],
    logPath,
    { DEVKIT_SESSION_TOKEN: sessionToken },
  );
  if (!pid) {
    sendJson(response, 200, { ok: false, error: "Failed to launch the Asset Bank process.", url });
    return;
  }

  // Verify it actually came up rather than reporting an optimistic success the panel can't back up.
  const up = await waitForHealthy(healthUrl, 10_000);
  if (!up) {
    const logTail = await tailLogLines(logPath, 20);
    sendJson(response, 200, {
      ok: false,
      error: `Asset Bank launched (pid ${pid}) but did not become healthy on :${assetBankPort} within 10s. See log tail for the cause.`,
      pid,
      killed,
      logTail,
      logPath: path.relative(repoRoot, logPath).replaceAll("\\", "/"),
      url,
    });
    return;
  }
  sendJson(response, 200, { ok: true, started: !alive, restarted: restart && killed, pid, url });
}

async function handleStartFramePicker(response: ServerResponse, request: IncomingMessage): Promise<void> {
  const payload = await readRequestJson(request).catch(() => ({} as Record<string, unknown>));
  const url = `http://127.0.0.1:${framePickerPort}/`;
  const healthUrl = `http://127.0.0.1:${framePickerPort}/api/candidate`;
  // assertLocalPath pins the path inside repo/assets roots, but startDetached runs with
  // shell:true (required for pnpm.cmd on Windows) where args are joined unquoted — so a
  // path segment containing shell metacharacters would execute. Reject those outright.
  if (typeof payload.candidate === "string" && /[&|^%<>()"'`;$]/.test(payload.candidate)) {
    sendJson(response, 400, { ok: false, error: "candidate path contains shell metacharacters" });
    return;
  }
  const alive = await health(healthUrl);
  if (payload.dryRun === true) {
    sendJson(response, 200, { ok: true, dryRun: true, alreadyRunning: alive, port: framePickerPort, url });
    return;
  }
  // Already-running guard: a second launch would EADDRINUSE-crash the detached server and
  // flash a console (same class as the Asset Bank silent-fail). Surface the running instance.
  if (alive) {
    sendJson(response, 200, { ok: true, alreadyRunning: true, url });
    return;
  }
  const candidate = typeof payload.candidate === "string" ? assertLocalPath(payload.candidate) : path.join(repoRoot, "tmp", "frame-picker", "empty-candidate");
  const pid = startDetached(commandName("pnpm"), ["frame-picker", "--", "--candidate", candidate, "--port", String(framePickerPort)], repoRoot);
  if (!pid) {
    sendJson(response, 200, { ok: false, error: "Failed to launch the Frame Picker process.", candidate, url });
    return;
  }
  const up = await waitForHealthy(healthUrl, 12_000);
  sendJson(response, 200, up
    ? { ok: true, started: true, pid, candidate, url }
    : { ok: false, error: `Frame Picker launched (pid ${pid}) but did not become ready on :${framePickerPort} within 12s.`, pid, candidate, url });
}

async function handleRefreshAudio(response: ServerResponse): Promise<void> {
  const root = path.join(assetsRoot, "audio", "generated");
  await mkdir(root, { recursive: true });
  const pid = startDetached(commandName("pnpm"), ["audio:review", "--", "--root", root], repoRoot);
  sendJson(response, 200, { ok: true, pid, path: path.join(root, "audio-review.html"), url: "/assets-file/audio/generated/audio-review.html" });
}

async function handleRuntimeAssetsCategorized(response: ServerResponse): Promise<void> {
  const runtimeRoot = path.join(repoRoot, "client", "public", "assets");
  const categories: Record<string, Array<{ key: string; path: string; url: string }>> = {};

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (![".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].includes(ext)) continue;
        const relPath = path.relative(runtimeRoot, full).replaceAll("\\", "/");
        const category = relPath.includes("/") ? relPath.split("/")[0] : "uncategorized";
        const key = path.basename(entry.name, ext);
        if (!categories[category]) categories[category] = [];
        categories[category].push({
          key,
          path: relPath,
          url: `/runtime-asset/${relPath}`,
        });
      }
    }
  }

  await walk(runtimeRoot);
  // Sort each category's assets by key
  for (const cat of Object.keys(categories)) {
    categories[cat].sort((a, b) => a.key.localeCompare(b.key));
  }
  sendJson(response, 200, { categories });
}

async function handleRuntimeAssets(response: ServerResponse): Promise<void> {
  const runtimeRoot = path.join(repoRoot, "client", "public", "assets");
  const results: Array<{ path: string; size: number; ext: string }> = [];

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        const info = await stat(full);
        results.push({
          path: path.relative(runtimeRoot, full).replaceAll("\\", "/"),
          size: info.size,
          ext: path.extname(entry.name).toLowerCase(),
        });
      }
    }
  }

  await walk(runtimeRoot);
  sendJson(response, 200, {
    root: runtimeRoot,
    count: results.length,
    assets: results,
  });
}

type BankAsset = {
  id?: string;
  name?: string;
  path?: string;
  category?: string;
  kind?: string;
  image?: { width?: number; height?: number } | null;
  review?: { decision?: string };
};

type BankAssetPickerItem = {
  id?: string;
  name: string;
  path: string;
  url: string;
  width?: number;
  height?: number;
  suggestedScale?: number;
  zoneLayer?: string;
};

type BankContextLayer = "tiles" | "decals" | "props" | "transitions" | "npcs" | "monsters";

type ZonePack = {
  id?: string;
  label?: string;
  mapIds?: string[];
  layers?: Partial<Record<BankContextLayer | "ground_tiles", string[]>>;
};

type EntityProfile = {
  id?: string;
  type?: string;
  gameId?: string;
  gameIdType?: string;
  label?: string;
  slots?: Record<string, { assetId?: string; status?: string } | null>;
};

const USABLE_DECISIONS = new Set(["accepted", "runtime-promoted"]);
const PICKER_IMAGE_EXT = new Set([".png", ".webp", ".jpg", ".jpeg"]);

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

async function loadBankFiles(): Promise<{
  status: { reviews?: Array<{ id?: string; decision?: string }> };
  data: { assets?: BankAsset[] };
}> {
  async function pick(file: string): Promise<unknown> {
    // Canonical first (where the bank server writes), assetsRoot only as a
    // legacy fallback during migration.
    const primary = path.join(reviewRoot, file);
    const fallback = path.join(assetsRoot, "_review", file);
    let raw = await readJson(primary, null);
    if (raw === null) raw = await readJson(fallback, null);
    return raw;
  }
  const status = ((await pick("asset-review-status.json")) ?? { reviews: [] }) as {
    reviews?: Array<{ id?: string; decision?: string }>;
  };
  const data = ((await pick("asset-review-data.json")) ?? { assets: [] }) as { assets?: BankAsset[] };
  return { status, data };
}

async function fetchAssetBankJson<T>(pathName: string): Promise<T | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${assetBankPort}${pathName}`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function bankAssetToPickerItem(asset: BankAsset, zoneLayer?: string): BankAssetPickerItem | null {
  const assetPath = typeof asset.path === "string" ? asset.path : "";
  if (!assetPath) return null;
  const ext = path.extname(assetPath).toLowerCase();
  if (!PICKER_IMAGE_EXT.has(ext)) return null;

  const width = asset.image?.width;
  const height = asset.image?.height;
  const maxDim = width && height ? Math.max(width, height) : 0;
  let suggestedScale: number | undefined;
  if (asset.kind === "prop") suggestedScale = maxDim ? round2(96 / maxDim) : 0.15;
  else if (asset.kind === "decal") suggestedScale = maxDim ? round2(56 / maxDim) : 0.5;

  const item: BankAssetPickerItem = {
    id: asset.id,
    name: asset.name ?? path.basename(assetPath),
    path: assetPath,
    url: `/assets-file/${assetPath}`,
  };
  if (typeof width === "number") item.width = width;
  if (typeof height === "number") item.height = height;
  if (suggestedScale !== undefined) item.suggestedScale = suggestedScale;
  if (zoneLayer) item.zoneLayer = zoneLayer;
  return item;
}

async function handleBankAssets(response: ServerResponse): Promise<void> {
  try {
    const { status, data } = await loadBankFiles();
    const decisionById = new Map<string, string>();
    for (const review of status.reviews ?? []) {
      if (review?.id && typeof review.decision === "string") decisionById.set(review.id, review.decision);
    }

    const kindToCategory: Record<string, "tiles" | "decals" | "props"> = {
      tile: "tiles",
      decal: "decals",
      prop: "props",
    };
    const categories: Record<"tiles" | "decals" | "props", Array<Record<string, unknown>>> = {
      tiles: [],
      decals: [],
      props: [],
    };
    const seen: Record<string, Set<string>> = { tiles: new Set(), decals: new Set(), props: new Set() };

    for (const asset of data.assets ?? []) {
      const assetPath = typeof asset.path === "string" ? asset.path : "";
      if (!assetPath) continue;
      const editorCat = asset.kind ? kindToCategory[asset.kind] : undefined;
      if (!editorCat) continue;
      if (asset.category === "audio") continue;
      const ext = path.extname(assetPath).toLowerCase();
      if (!PICKER_IMAGE_EXT.has(ext)) continue;
      const decision = (asset.id && decisionById.get(asset.id)) ?? asset.review?.decision;
      if (!decision || !USABLE_DECISIONS.has(decision)) continue;
      if (seen[editorCat].has(assetPath)) continue;
      seen[editorCat].add(assetPath);

      const width = asset.image?.width;
      const height = asset.image?.height;
      const maxDim = width && height ? Math.max(width, height) : 0;
      let suggestedScale: number | undefined;
      if (editorCat === "props") suggestedScale = maxDim ? round2(96 / maxDim) : 0.15;
      else if (editorCat === "decals") suggestedScale = maxDim ? round2(56 / maxDim) : 0.5;
      else suggestedScale = undefined;

      const item: Record<string, unknown> = {
        id: asset.id,
        name: asset.name ?? path.basename(assetPath),
        path: assetPath,
        url: `/assets-file/${assetPath}`,
      };
      if (typeof width === "number") item.width = width;
      if (typeof height === "number") item.height = height;
      if (suggestedScale !== undefined) item.suggestedScale = suggestedScale;
      categories[editorCat].push(item);
    }

    for (const cat of Object.keys(categories) as Array<"tiles" | "decals" | "props">) {
      categories[cat].sort((a, b) => String(a.name).localeCompare(String(b.name)));
      if (categories[cat].length > 500) categories[cat] = categories[cat].slice(0, 500);
    }
    sendJson(response, 200, { categories });
  } catch (error) {
    sendJson(response, 200, {
      categories: { tiles: [], decals: [], props: [] },
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function loadZonePacks(): Promise<{ zones: Record<string, ZonePack>; source: string }> {
  const viaApi = await fetchAssetBankJson<{ zones?: Record<string, ZonePack> }>("/api/zone-packs");
  if (viaApi?.zones) return { zones: viaApi.zones, source: "asset-bank-api" };
  const viaFile = (await readJson(path.join(reviewRoot, "zone-packs.json"), { zones: {} })) as {
    zones?: Record<string, ZonePack>;
  };
  return { zones: viaFile.zones ?? {}, source: "metadata-file" };
}

async function loadEntityProfiles(): Promise<{ entities: Record<string, EntityProfile>; source: string }> {
  const viaApi = await fetchAssetBankJson<{ entities?: Record<string, EntityProfile> }>("/api/entity-profiles");
  if (viaApi?.entities) return { entities: viaApi.entities, source: "asset-bank-api" };
  const viaFile = (await readJson(path.join(reviewRoot, "entity-profiles.json"), { entities: {} })) as {
    entities?: Record<string, EntityProfile>;
  };
  return { entities: viaFile.entities ?? {}, source: "metadata-file" };
}

function normalizeZoneLayer(layer: string): "tiles" | "decals" | "props" | "npcs" | "monsters" | null {
  if (layer === "ground_tiles") return "tiles";
  if (layer === "transitions") return "decals";
  if (layer === "decals" || layer === "props" || layer === "npcs" || layer === "monsters") return layer;
  return null;
}

function entityMatchesMapProfile(id: string, entity: EntityProfile, mapId: string): boolean {
  const haystack = [id, entity.id, entity.gameId, entity.label].filter(Boolean).join(" ").toLowerCase();
  if (mapId === "map_harbor_outskirts") {
    return /\bharbor\b|crab|shell|saltglass|fishmonger|dock/.test(haystack);
  }
  return false;
}

async function handleBankContext(response: ServerResponse, mapId: string): Promise<void> {
  const [{ zones, source: zoneSource }, { entities, source: entitySource }, { status, data }] = await Promise.all([
    loadZonePacks(),
    loadEntityProfiles(),
    loadBankFiles(),
  ]);

  const zoneEntry = Object.entries(zones).find(([, zone]) => (zone.mapIds ?? []).includes(mapId));
  const [zoneId, zone] = zoneEntry ?? [null, null];
  const decisionById = new Map<string, string>();
  for (const review of status.reviews ?? []) {
    if (review?.id && typeof review.decision === "string") decisionById.set(review.id, review.decision);
  }
  const assetById = new Map<string, BankAsset>();
  for (const asset of data.assets ?? []) {
    if (asset.id) assetById.set(asset.id, asset);
  }

  const categories: Record<"tiles" | "decals" | "props", BankAssetPickerItem[]> = {
    tiles: [],
    decals: [],
    props: [],
  };
  const rawLayerCounts: Record<string, number> = {};
  const missingAssets: Array<{ layer: string; assetId: string }> = [];

  for (const [rawLayer, assetIds] of Object.entries(zone?.layers ?? {})) {
    const ids = Array.isArray(assetIds) ? assetIds.filter((id): id is string => typeof id === "string") : [];
    rawLayerCounts[rawLayer] = ids.length;
    const pickerLayer = normalizeZoneLayer(rawLayer);
    if (!pickerLayer || pickerLayer === "npcs" || pickerLayer === "monsters") continue;
    for (const assetId of ids) {
      const asset = assetById.get(assetId);
      if (!asset) {
        missingAssets.push({ layer: rawLayer, assetId });
        continue;
      }
      const decision = (asset.id && decisionById.get(asset.id)) ?? asset.review?.decision;
      if (!decision || !USABLE_DECISIONS.has(decision)) continue;
      const item = bankAssetToPickerItem(asset, rawLayer);
      if (!item) continue;
      categories[pickerLayer].push(item);
    }
  }

  const entityProfiles = { npcs: [] as EntityProfile[], monsters: [] as EntityProfile[] };
  for (const [id, entity] of Object.entries(entities)) {
    const type = entity.type === "npc" ? "npcs" : entity.type === "monster" ? "monsters" : null;
    if (!type) continue;
    const inZoneLayer = Boolean(zone?.layers?.[type]?.includes(id) || (entity.gameId && zone?.layers?.[type]?.includes(entity.gameId)));
    if (!inZoneLayer && !entityMatchesMapProfile(id, entity, mapId)) continue;
    entityProfiles[type].push({ ...entity, id: entity.id ?? id });
  }
  entityProfiles.npcs.sort((a, b) => String(a.gameId ?? a.id).localeCompare(String(b.gameId ?? b.id)));
  entityProfiles.monsters.sort((a, b) => String(a.gameId ?? a.id).localeCompare(String(b.gameId ?? b.id)));

  for (const category of Object.keys(categories) as Array<keyof typeof categories>) {
    const seen = new Set<string>();
    categories[category] = categories[category].filter((item) => {
      if (seen.has(item.path)) return false;
      seen.add(item.path);
      return true;
    });
  }

  sendJson(response, 200, {
    ok: true,
    mapId,
    zoneId,
    zone: zone
      ? {
          id: zoneId,
          label: zone.label ?? zoneId,
          mapIds: zone.mapIds ?? [],
          layerCounts: rawLayerCounts,
        }
      : null,
    source: { zones: zoneSource, entities: entitySource },
    categories,
    entityProfiles,
    emptyState: {
      npcs: (zone?.layers?.npcs ?? []).length === 0,
      monsters: (zone?.layers?.monsters ?? []).length === 0,
    },
    missingAssets,
  });
}

async function handlePromoteAsset(response: ServerResponse, request: IncomingMessage): Promise<void> {
  const payload = await readRequestJson(request);
  const sourceRel = typeof payload.path === "string" ? payload.path : "";
  const targetType = typeof payload.targetType === "string" ? payload.targetType : "";
  if (!sourceRel || !["tiles", "decals", "props"].includes(targetType)) {
    sendJson(response, 400, { ok: false, error: "path and valid targetType required" });
    return;
  }

  const sourceAbs = path.resolve(assetsRoot, sourceRel);
  if (!isInside(sourceAbs, assetsRoot)) {
    sendJson(response, 403, { ok: false, error: "Source path must be inside the asset bank" });
    return;
  }

  const gate = await checkAssetDefectGate(sourceAbs);
  if (!gate.ok) {
    sendJson(response, 409, {
      ok: false,
      error: "Asset defect gate refused promotion (chroma fringe, full chroma background, " +
        "pink/purple rim, or opaque cut-out — or the gate itself is unavailable). Fix with " +
        "tools/asset-cleanup/fringe.py despill or tools/asset-cleanup/rimfix.py fix, then retry.",
      gateOutput: gate.output,
    });
    return;
  }

  const cleanKey = promoteKeyFromPath(sourceRel);
  const ext = path.extname(sourceRel).toLowerCase() || ".png";
  const destSub = targetType;
  const targetName = cleanKey;
  const targetPath = `assets/${destSub}/${cleanKey}${ext}`;
  const destAbs = path.join(repoRoot, "client", "public", "assets", destSub, `${cleanKey}${ext}`);

  const force = payload.force === true;

  const typeForRegistry = ({ tiles: "tile", decals: "decal", props: "prop" } as const)[
    targetType as "tiles" | "decals" | "props"
  ];

  // Read dims + the bank asset id from the bank data file by matching path, so the
  // registry key matches what the bank-side promote route would use for the same asset.
  let image: { width?: number; height?: number } | null = null;
  let bankAssetId: string | undefined;
  try {
    const { data } = await loadBankFiles();
    const match = (data.assets ?? []).find((a) => a.path === sourceRel);
    if (match?.image?.width && match.image.height) {
      image = { width: match.image.width, height: match.image.height };
    }
    if (typeof match?.id === "string" && match.id) bankAssetId = match.id;
  } catch {
    image = null;
  }

  // Single promotion route: overwrite guard + copy + canonical registry write are shared
  // with the Asset Bank server via promoteToRuntime (tools/src/lib/promote-to-runtime.ts).
  await mkdir(path.dirname(destAbs), { recursive: true });
  let result: Awaited<ReturnType<typeof promoteToRuntime>>;
  try {
    result = await promoteToRuntime({
      sourceAbs,
      destAbs,
      force,
      assetId: bankAssetId,
      sourcePath: sourceRel,
      targetPath,
      targetName,
      type: typeForRegistry,
      kind: typeForRegistry,
      category: targetType,
      image,
    });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (result.status === "refused") {
    sendJson(response, 409, { ok: false, error: result.reason, targetExisted: result.targetExisted, targetPath });
    return;
  }
  const alreadyExisted = result.targetExisted;
  let entityRepointed = 0;
  let entityRepointWarning: string | undefined;
  try {
    entityRepointed = await repointEntitiesAfterPromotion(bankAssetId, sourceRel);
  } catch (error) {
    entityRepointWarning = error instanceof Error ? error.message : String(error);
  }
  sendJson(response, 200, { ok: true, key: cleanKey, registryKey: result.registryKey, replacedKeys: result.replacedKeys, targetPath, alreadyExisted, entityRepointed, entityRepointWarning });
}

async function repointEntitiesAfterPromotion(assetId: string | undefined, sourcePath: string): Promise<number> {
  const registry = await readRegistryStrict();
  const profilesPath = path.join(reviewRoot, "entity-profiles.json");
  const profiles = (await readJson(profilesPath, { entities: {} })) as Record<string, unknown>;
  const result = repointEntityProfiles(profiles, registry.promoted, { sourceAssetId: assetId, sourcePath });
  if (!result.changes.length) return 0;
  await writeFile(profilesPath, JSON.stringify(result.profiles, null, 2) + "\n", "utf8");
  return result.changes.length;
}

async function handleSyncPromoted(response: ServerResponse): Promise<void> {
  const result = await runRepoCommand("pnpm promoted-asset-sync", 30000);
  sendJson(response, 200, { ok: result.ok, output: result.output });
}

type PromotedEntry = {
  assetId?: string;
  sourcePath?: string;
  targetPath?: string;
  targetName?: string;
  type?: string;
  context?: string;
  kind?: string;
  category?: string;
  image?: unknown;
  promotedAt?: string;
  warnings?: unknown;
};

async function handlePromotedAssets(response: ServerResponse): Promise<void> {
  let registry: { promoted?: Record<string, PromotedEntry> };
  try {
    registry = await readRegistryStrict();
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const promoted: Array<{ key: string; type: string; sourcePath: string; targetPath: string; url: string }> = [];
  for (const entry of Object.values(registry.promoted ?? {})) {
    if (!entry?.targetName || !entry.targetPath) continue;
    promoted.push({
      key: entry.targetName,
      type: entry.type ?? "",
      sourcePath: entry.sourcePath ?? "",
      targetPath: entry.targetPath,
      url: `/runtime-asset/${entry.targetPath.replace(/^assets\//, "")}`,
    });
  }
  promoted.sort((a, b) => a.key.localeCompare(b.key));
  sendJson(response, 200, { promoted });
}

async function handleUnpromoteAsset(response: ServerResponse, request: IncomingMessage): Promise<void> {
  const payload = await readRequestJson(request);
  const key = typeof payload.key === "string" ? payload.key : "";
  if (!key) {
    sendJson(response, 400, { ok: false, error: "key required" });
    return;
  }

  let registry: { promoted: Record<string, PromotedEntry> };
  try {
    registry = await readRegistryStrict();
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    return;
  }

  const found = Object.entries(registry.promoted).find(([, e]) => e?.targetName === key);
  if (!found) {
    sendJson(response, 200, { ok: false, error: "not promoted" });
    return;
  }
  const [registryKey, entry] = found;

  // SAFETY GUARD: refuse if any zone layout still references this assetKey.
  const zonesDir = path.join(repoRoot, "content", "zones");
  const usedBy: Array<{ file: string; count: number }> = [];
  let zoneFiles: string[] = [];
  try {
    zoneFiles = (await readdir(zonesDir)).filter((f) => f.endsWith(".layout.json"));
  } catch {
    zoneFiles = [];
  }
  for (const file of zoneFiles) {
    let raw: { ground?: unknown; decals?: unknown; props?: unknown };
    try {
      raw = JSON.parse(await readFile(path.join(zonesDir, file), "utf8"));
    } catch {
      continue;
    }
    let count = 0;
    for (const arrName of ["ground", "decals", "props"] as const) {
      const arr = raw[arrName];
      if (!Array.isArray(arr)) continue;
      for (const el of arr) {
        if (el && typeof el === "object" && (el as { assetKey?: unknown }).assetKey === key) count++;
      }
    }
    if (count > 0) usedBy.push({ file, count });
  }
  if (usedBy.length > 0) {
    sendJson(response, 200, { ok: false, error: "in use", usedBy });
    return;
  }

  // Delete the runtime file (handle missing gracefully).
  const targetPath = entry.targetPath ?? "";
  if (targetPath) {
    const destAbs = path.join(repoRoot, "client", "public", targetPath);
    try {
      await unlink(destAbs);
    } catch {
      // already gone — ignore
    }
  }

  try {
    await unpromoteEntry(registryKey);
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    return;
  }

  // Regenerate promoted-assets.ts without the removed key (non-fatal if it fails).
  await runRepoCommand("pnpm promoted-asset-sync", 30000);

  sendJson(response, 200, { ok: true, key, removedFile: targetPath });
}

async function handleWriteBridge(response: ServerResponse): Promise<void> {
  const bridgeDir = path.join(assetsRoot, "_devkit");
  await mkdir(bridgeDir, { recursive: true });
  await writeFile(
    path.join(bridgeDir, "start-devkit.ps1"),
    `Set-Location -LiteralPath '${repoRoot.replaceAll("'", "''")}'\n` +
      `pnpm devkit -- --assets-root '${assetsRoot.replaceAll("'", "''")}' --port ${port}\n`,
    "utf8",
  );
  await writeFile(
    path.join(bridgeDir, "README.md"),
    `# GameKit Dev Kit Bridge\n\nCanonical Dev Kit source now lives in \`${repoRoot}/tools/devkit\` and runs with:\n\n\`\`\`powershell\ncd ${repoRoot}\npnpm devkit\n\`\`\`\n\nThis folder remains as an owner-side launcher near the external asset data bank.\n`,
    "utf8",
  );
  sendJson(response, 200, { ok: true, bridgeDir });
}

async function handleZoneLayouts(response: ServerResponse): Promise<void> {
  const zonesDir = path.join(repoRoot, "content", "zones");
  let files: string[] = [];
  try {
    files = (await readdir(zonesDir)).filter((f) => f.endsWith(".layout.json"));
  } catch {
    sendJson(response, 200, { layouts: [] });
    return;
  }
  const layouts: Array<{ file: string; mapId: string; data: unknown; hash: string; modifiedMs: number }> = [];
  for (const file of files.sort()) {
    const filePath = path.join(zonesDir, file);
    const rawText = await readFile(filePath, "utf8");
    const raw = JSON.parse(rawText);
    const info = await stat(filePath);
    layouts.push({
      file,
      mapId: raw.mapId ?? path.basename(file, ".layout.json"),
      data: raw,
      hash: hashText(rawText),
      modifiedMs: info.mtimeMs,
    });
  }
  sendJson(response, 200, { layouts });
}

async function readZoneLayouts(): Promise<Array<{ file: string; mapId: string; data: ZoneLayout; hash: string; modifiedMs: number }>> {
  const zonesDir = path.join(repoRoot, "content", "zones");
  let files: string[] = [];
  try {
    files = (await readdir(zonesDir)).filter((f) => f.endsWith(".layout.json"));
  } catch {
    return [];
  }
  const layouts: Array<{ file: string; mapId: string; data: ZoneLayout; hash: string; modifiedMs: number }> = [];
  for (const file of files.sort()) {
    const filePath = path.join(zonesDir, file);
    const rawText = await readFile(filePath, "utf8");
    const parsed = ZoneLayout.safeParse(JSON.parse(rawText));
    if (!parsed.success) continue;
    const info = await stat(filePath);
    layouts.push({
      file,
      mapId: parsed.data.mapId,
      data: parsed.data,
      hash: hashText(rawText),
      modifiedMs: info.mtimeMs,
    });
  }
  return layouts;
}

function safeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "capture";
}

async function listPngCaptures(root: string, urlPrefix: string): Promise<Array<{ file: string; label: string; path: string; url: string; sizeBytes: number; modifiedAt: string }>> {
  const captures: Array<{ file: string; label: string; path: string; url: string; sizeBytes: number; modifiedAt: string }> = [];
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (path.extname(entry.name).toLowerCase() !== ".png") continue;
      const info = await stat(full);
      const rel = path.relative(root, full).replaceAll("\\", "/");
      captures.push({
        file: entry.name,
        label: rel.replace(/\.png$/i, ""),
        path: path.relative(repoRoot, full).replaceAll("\\", "/"),
        url: `${urlPrefix}/${rel}`,
        sizeBytes: info.size,
        modifiedAt: info.mtime.toISOString(),
      });
    }
  }
  await walk(root);
  return captures.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
}

async function handleCaptureGallery(response: ServerResponse): Promise<void> {
  const roots = [
    { kind: "zone", root: path.join(repoRoot, "tools", "_capture"), urlPrefix: "/capture-file/zone" },
    { kind: "editor", root: path.join(repoRoot, "tools", "_editor-captures"), urlPrefix: "/capture-file/editor" },
  ];
  const groups = await Promise.all(
    roots.map(async (source) => ({
      ...source,
      captures: (await listPngCaptures(source.root, source.urlPrefix)).slice(0, 80),
    })),
  );
  sendJson(response, 200, {
    ok: true,
    groups: groups.map((group) => ({
      kind: group.kind,
      root: path.relative(repoRoot, group.root).replaceAll("\\", "/"),
      count: group.captures.length,
      captures: group.captures,
    })),
  });
}

async function handleWorldDashboard(response: ServerResponse): Promise<void> {
  const layouts = await readZoneLayouts();
  const serverHealth = await fetch("http://127.0.0.1:2567/matchmake/world", { signal: AbortSignal.timeout(1200) })
    .then(async (res) => ({ reachable: true, status: res.status, body: await res.text().catch(() => "") }))
    .catch((error) => ({ reachable: false, status: 0, body: error instanceof Error ? error.message : String(error) }));
  const maps = layouts.map((entry) => ({
    mapId: entry.mapId,
    file: entry.file,
    bounds: entry.data.bounds,
    spawnPoints: entry.data.spawnPoints,
    npcCount: entry.data.npcs.length,
    npcs: entry.data.npcs.map((npc) => ({ npcId: npc.npcId, x: npc.x, y: npc.y, radius: npc.radius })),
    monsterSpawnCount: entry.data.monsterSpawns.length,
    monsterSpawns: entry.data.monsterSpawns.map((spawn) => ({
      monsterId: spawn.monsterId,
      x: spawn.x,
      y: spawn.y,
      width: spawn.width,
      height: spawn.height,
      maxAlive: spawn.maxAlive,
      respawnMs: spawn.respawnMs,
    })),
    portalCount: entry.data.portals.length,
    portalIds: entry.data.portals.map((portal) => portal.portalId),
  }));
  sendJson(response, 200, {
    ok: true,
    online: {
      serverReachable: serverHealth.reachable,
      matchmakeStatus: serverHealth.status,
      detail: serverHealth.body.slice(0, 500),
    },
    totals: {
      maps: maps.length,
      spawnPoints: maps.reduce((sum, map) => sum + map.spawnPoints.length, 0),
      npcs: maps.reduce((sum, map) => sum + map.npcCount, 0),
      monsterSpawns: maps.reduce((sum, map) => sum + map.monsterSpawnCount, 0),
      portals: maps.reduce((sum, map) => sum + map.portalCount, 0),
    },
    maps,
  });
}

async function handlePipelineView(response: ServerResponse): Promise<void> {
  const [bankAssets, promotedPayload, layouts] = await Promise.all([
    loadBankFiles().catch(() => ({ status: { reviews: [] }, data: { assets: [] } })),
    readRegistryStrict().catch(() => ({ promoted: {} })),
    readZoneLayouts(),
  ]);
  const decisionById = new Map<string, string>();
  for (const review of bankAssets.status.reviews ?? []) {
    if (review?.id && typeof review.decision === "string") decisionById.set(review.id, review.decision);
  }
  const accepted = (bankAssets.data.assets ?? []).filter((asset) => {
    const decision = (asset.id && decisionById.get(asset.id)) ?? asset.review?.decision;
    return Boolean(decision && USABLE_DECISIONS.has(decision));
  });
  const promoted = Object.values(promotedPayload.promoted ?? {}) as Array<{ targetName?: string; targetType?: string; sourcePath?: string; promotedAt?: string }>;
  const placedKeys = new Map<string, Array<{ mapId: string; layer: "ground" | "decals" | "props"; instanceId: string }>>();
  for (const layout of layouts) {
    for (const item of layout.data.ground) {
      const list = placedKeys.get(item.assetKey) ?? [];
      list.push({ mapId: layout.mapId, layer: "ground", instanceId: item.instanceId });
      placedKeys.set(item.assetKey, list);
    }
    for (const item of layout.data.decals) {
      const list = placedKeys.get(item.assetKey) ?? [];
      list.push({ mapId: layout.mapId, layer: "decals", instanceId: item.instanceId });
      placedKeys.set(item.assetKey, list);
    }
    for (const item of layout.data.props) {
      const list = placedKeys.get(item.assetKey) ?? [];
      list.push({ mapId: layout.mapId, layer: "props", instanceId: item.instanceId });
      placedKeys.set(item.assetKey, list);
    }
  }
  const rows = promoted
    .map((entry) => ({
      key: entry.targetName ?? "",
      type: entry.targetType ?? "",
      sourcePath: entry.sourcePath ?? "",
      promotedAt: entry.promotedAt,
      placements: placedKeys.get(entry.targetName ?? "") ?? [],
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  sendJson(response, 200, {
    ok: true,
    counts: {
      accepted: accepted.length,
      promoted: rows.length,
      placedPromoted: rows.filter((row) => row.placements.length > 0).length,
      maps: layouts.length,
    },
    rows,
  });
}

async function handleApplyStatus(response: ServerResponse): Promise<void> {
  // Single apply-status card (A7 quick-win 7): last apply/export freshness from LIVE sources —
  // per-map layout→compiled drift (reuses the cohesion gate's computeLayoutExportDrift, so the
  // card and `pnpm cohesion:check` can never disagree), plus the promoted-registry and the
  // generated promoted-assets.ts timestamps. No new state store.
  const maps = computeLayoutExportDrift().map((row) => ({
    mapId: row.mapId,
    fresh: row.fresh,
    status: row.fresh ? "in-sync" : "stale",
    detail: row.error,
    layoutPath: row.layoutPath,
    layoutHash: row.layoutHash,
    compiledHash: row.compiledHash,
  }));
  const registryPath = path.join(repoRoot, "client", "public", "assets", "promoted-registry.json");
  const generatedPath = path.join(repoRoot, "client", "src", "config", "promoted-assets.ts");
  const [registryStat, generatedStat, registry] = await Promise.all([
    stat(registryPath).catch(() => undefined),
    stat(generatedPath).catch(() => undefined),
    readRegistryStrict().catch(() => ({ promoted: {} as Record<string, unknown> })),
  ]);
  const registryCount = Object.keys(registry.promoted ?? {}).length;
  const generatedStale = Boolean(registryStat && generatedStat && generatedStat.mtimeMs < registryStat.mtimeMs);
  sendJson(response, 200, {
    ok: true,
    maps: {
      total: maps.length,
      stale: maps.filter((m) => !m.fresh).length,
      rows: maps.sort((a, b) => a.mapId.localeCompare(b.mapId)),
    },
    promotedRegistry: {
      count: registryCount,
      updatedAt: registryStat ? new Date(registryStat.mtimeMs).toISOString() : undefined,
    },
    generatedAssets: {
      path: "client/src/config/promoted-assets.ts",
      updatedAt: generatedStat ? new Date(generatedStat.mtimeMs).toISOString() : undefined,
      // Stale when the generated module predates the registry — run `pnpm promoted-asset-sync`.
      stale: generatedStale,
    },
  });
}

async function handleZoneLoop(response: ServerResponse, request: IncomingMessage): Promise<void> {
  const payload: Record<string, unknown> = await readRequestJson(request).catch(() => ({}));
  const mapId = typeof payload.mapId === "string" && payload.mapId ? payload.mapId : undefined;
  const dryRun = payload.dryRun === true;
  const mode = payload.mode === "dev" ? "dev" : "prod";
  const restartServer = payload.restartServer !== false;
  if (mapId !== undefined && !/^map_[a-z0-9_]+$/.test(mapId)) {
    sendJson(response, 400, { ok: false, error: `Invalid mapId: ${JSON.stringify(mapId)}` });
    return;
  }
  const steps: ZoneLoopStep[] = [];
  async function addCommandStep(name: ZoneLoopStepName, label: string, command: string, timeoutMs: number): Promise<boolean> {
    if (dryRun) {
      steps.push({ name, label, ok: true, dryRun: true, output: command });
      return true;
    }
    const result = await runRepoCommand(command, timeoutMs);
    steps.push({ name, label, ok: result.ok, output: result.output });
    return result.ok;
  }
  const mapArg = mapId ? ` --zone=${mapId}` : "";
  if (!(await addCommandStep("save", "Validate saved layout", "pnpm zone:validate", 30_000))) {
    sendJson(response, 200, { ok: false, mapId, dryRun, steps });
    return;
  }
  if (!(await addCommandStep("sync", "Sync promoted assets", "pnpm promoted-asset-sync", 30_000))) {
    sendJson(response, 200, { ok: false, mapId, dryRun, steps });
    return;
  }
  if (!(await addCommandStep("export", "Export zone", `pnpm zone:export${mapArg}`, 30_000))) {
    sendJson(response, 200, { ok: false, mapId, dryRun, steps });
    return;
  }
  if (mode === "dev") {
    steps.push({ name: "redress", label: "Live re-dress", ok: true, dryRun, output: "Skipped client build; Vite HMR applies changed map JSON in the running dev client." });
    sendJson(response, 200, { ok: steps.every((step) => step.ok), mapId, dryRun, mode, steps });
    return;
  }
  if (!(await addCommandStep("build", "Build client", "pnpm build:client", 180_000))) {
    sendJson(response, 200, { ok: false, mapId, dryRun, steps });
    return;
  }
  const restart = restartServer
    ? await hub.restartServerForZoneLoop(dryRun)
    : { ok: true, dryRun, output: "Skipped; draft-vs-compiled diff does not touch server-read data." };
  steps.push({ name: "restart", label: restartServer ? "Restart server" : "Skip server restart", ok: restart.ok, dryRun: restart.dryRun, output: restart.output });
  const reloadUrl = `http://127.0.0.1:5173/${mapId ? `?map=${encodeURIComponent(mapId)}` : ""}`;
  steps.push({ name: "reload", label: "Reload client", ok: restart.ok, dryRun, output: reloadUrl });
  sendJson(response, 200, { ok: steps.every((step) => step.ok), mapId, dryRun, reloadUrl, steps });
}

async function handleEditorCaptureSave(response: ServerResponse, request: IncomingMessage): Promise<void> {
  const payload = await readRequestJson(request);
  const mapId = safeFileSegment(typeof payload.mapId === "string" ? payload.mapId : "unknown_map");
  const label = safeFileSegment(typeof payload.label === "string" ? payload.label : "view");
  const imageData = typeof payload.imageData === "string" ? payload.imageData : "";
  const match = /^data:image\/png;base64,([a-zA-Z0-9+/=]+)$/.exec(imageData);
  if (!match) {
    sendJson(response, 400, { ok: false, error: "imageData must be a PNG data URL" });
    return;
  }
  const outputDir = path.join(repoRoot, "tools", "_editor-captures");
  await mkdir(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${stamp}_${mapId}_${label}.png`;
  const filePath = path.join(outputDir, fileName);
  await writeFile(filePath, Buffer.from(match[1], "base64"));
  sendJson(response, 200, { ok: true, file: path.relative(repoRoot, filePath).replace(/\\/g, "/") });
}

async function handleZoneLayoutSave(response: ServerResponse, request: IncomingMessage): Promise<void> {
  const payload = await readRequestJson(request);
  const mapId = payload.mapId as string;
  const data = payload.data;
  const baseHash = typeof payload.baseHash === "string" ? payload.baseHash : undefined;
  const baseModifiedMs = typeof payload.baseModifiedMs === "number" ? payload.baseModifiedMs : undefined;
  if (!mapId || !data) {
    sendJson(response, 400, { ok: false, error: "mapId and data required" });
    return;
  }
  const parsed = ZoneLayout.safeParse(data);
  if (!parsed.success) {
    sendJson(response, 400, { ok: false, error: "layout schema invalid", issues: parsed.error.issues });
    return;
  }
  if (parsed.data.mapId !== mapId) {
    sendJson(response, 400, { ok: false, error: `layout mapId "${parsed.data.mapId}" does not match "${mapId}"` });
    return;
  }
  const zonesDir = path.join(repoRoot, "content", "zones");
  await mkdir(zonesDir, { recursive: true });
  const filePath = path.join(zonesDir, `${mapId}.layout.json`);
  let previousText = "";
  try {
    previousText = await readFile(filePath, "utf8");
  } catch {
    // New layouts still validate below; stale checks only apply when the caller has a base.
  }
  if (previousText) {
    // Stale guard is MANDATORY for existing layouts — a caller without base info could
    // otherwise silently clobber another session's save.
    if (!baseHash || typeof baseModifiedMs !== "number") {
      sendJson(response, 400, { ok: false, error: "baseHash and baseModifiedMs required when overwriting an existing layout" });
      return;
    }
    if (hashText(previousText) !== baseHash) {
      sendJson(response, 409, { ok: false, error: "stale layout: hash changed since load" });
      return;
    }
    const previousInfo = await stat(filePath);
    if (Math.abs(previousInfo.mtimeMs - baseModifiedMs) > 1) {
      sendJson(response, 409, { ok: false, error: "stale layout: mtime changed since load" });
      return;
    }
  }

  const outputText = JSON.stringify(parsed.data, null, 2) + "\n";
  await writeFile(filePath, outputText, "utf8");
  const validation = await runRepoCommand("pnpm zone:validate", 15000);
  if (!validation.ok) {
    // Invalid layouts must not land: restore the previous on-disk state.
    if (previousText) await writeFile(filePath, previousText, "utf8");
    else await unlink(filePath).catch(() => undefined);
    sendJson(response, 400, { ok: false, error: "layout failed zone:validate; previous file restored", output: validation.output });
    return;
  }
  const nextInfo = await stat(filePath);
  sendJson(response, 200, {
    ok: true,
    file: `${mapId}.layout.json`,
    hash: hashText(outputText),
    modifiedMs: nextInfo.mtimeMs,
    output: validation.output,
  });
}

async function handleZoneLayoutInstanceOverrideSave(response: ServerResponse, request: IncomingMessage): Promise<void> {
  const payload = await readRequestJson(request);
  const mapId = typeof payload.mapId === "string" ? payload.mapId : "";
  const layer = coercePlacementLayer(payload.layer);
  const instanceId = typeof payload.instanceId === "string" ? payload.instanceId : "";
  const instanceInput = payload.instance ?? payload.override;
  if (!mapId || !layer || !instanceId || instanceInput === undefined) {
    sendJson(response, 400, { ok: false, error: "mapId, layer props|decals, instanceId, and instance required" });
    return;
  }

  const zonesDir = path.join(repoRoot, "content", "zones");
  const filePath = path.join(zonesDir, `${mapId}.layout.json`);
  let current;
  try {
    current = await readTextWithInfo(filePath);
  } catch {
    sendJson(response, 404, { ok: false, error: `layout not found for ${mapId}` });
    return;
  }
  if (!requireFreshFile(response, current, payload)) return;

  const parsedLayout = ZoneLayout.safeParse(JSON.parse(current.text));
  if (!parsedLayout.success) {
    sendJson(response, 400, { ok: false, error: "layout schema invalid", issues: parsedLayout.error.issues });
    return;
  }
  if (parsedLayout.data.mapId !== mapId) {
    sendJson(response, 400, { ok: false, error: `layout mapId "${parsedLayout.data.mapId}" does not match "${mapId}"` });
    return;
  }

  const instances = parsedLayout.data[layer];
  const index = instances.findIndex((item) => item.instanceId === instanceId);
  if (index < 0) {
    sendJson(response, 404, { ok: false, error: `instance "${instanceId}" not found in ${layer}` });
    return;
  }

  const sanitized = sanitizePlacementInstance(layer, instanceInput);
  if (!isPlainRecord(sanitized) || sanitized.instanceId !== instanceId) {
    sendJson(response, 400, { ok: false, error: "instance payload must include the selected instanceId" });
    return;
  }
  if (jsonStable(instances[index]) === jsonStable(sanitized)) {
    sendJson(response, 200, {
      ok: true,
      file: `${mapId}.layout.json`,
      layer,
      instanceId,
      hash: current.hash,
      modifiedMs: current.modifiedMs,
      unchanged: true,
      output: "",
    });
    return;
  }
  instances[index] = sanitized as (typeof instances)[number];

  const parsedNext = ZoneLayout.safeParse(parsedLayout.data);
  if (!parsedNext.success) {
    sendJson(response, 400, { ok: false, error: "layout instance invalid", issues: parsedNext.error.issues });
    return;
  }

  const outputText = JSON.stringify(parsedNext.data, null, 2) + "\n";
  await writeFile(filePath, outputText, "utf8");
  const validation = await runRepoCommand("pnpm zone:validate", 15000);
  if (!validation.ok) {
    // Invalid overrides must not land: restore the previous on-disk state.
    await writeFile(filePath, current.text, "utf8");
    sendJson(response, 400, { ok: false, error: "override failed zone:validate; previous file restored", output: validation.output });
    return;
  }
  const nextInfo = await stat(filePath);
  sendJson(response, 200, {
    ok: true,
    file: `${mapId}.layout.json`,
    layer,
    instanceId,
    hash: hashText(outputText),
    modifiedMs: nextInfo.mtimeMs,
    output: validation.output,
  });
}

async function handleMapManifests(response: ServerResponse): Promise<void> {
  const mapsDir = path.join(repoRoot, "content", "maps");
  let files: string[] = [];
  try {
    files = (await readdir(mapsDir)).filter((f) => f.endsWith(".json"));
  } catch {
    sendJson(response, 200, { maps: [] });
    return;
  }
  const maps: Array<{ id: string; file: string; data: unknown; hash: string; modifiedMs: number }> = [];
  for (const file of files.sort()) {
    const fullPath = path.join(mapsDir, file);
    const rawText = await readFile(fullPath, "utf8");
    const raw = JSON.parse(rawText);
    const info = await stat(fullPath);
    maps.push({ id: raw.id ?? path.basename(file, ".json"), file, data: raw, hash: hashText(rawText), modifiedMs: info.mtimeMs });
  }
  sendJson(response, 200, { maps });
}

async function handleAvailableAssetKeys(response: ServerResponse): Promise<void> {
  const keys: string[] = [];
  const runtimeDir = path.join(repoRoot, "client", "public", "assets");
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries: import("node:fs").Dirent[] = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(dir, e.name), `${prefix}${e.name}/`);
      else if (/\.(png|jpe?g|webp)$/i.test(e.name)) keys.push(path.basename(e.name, path.extname(e.name)));
    }
  }
  await walk(runtimeDir, "");
  sendJson(response, 200, { keys });
}

async function handleContentIds(response: ServerResponse): Promise<void> {
  const result: Record<string, string[]> = {};
  // dir name -> response key (loot tables live in content/loot but the client expects `lootTables`)
  const kinds: Array<{ dir: string; key: string }> = [
    { dir: "npcs", key: "npcs" },
    { dir: "monsters", key: "monsters" },
    { dir: "portals", key: "portals" },
    { dir: "maps", key: "maps" },
    { dir: "loot", key: "lootTables" },
  ];
  for (const { dir, key } of kinds) {
    const dirPath = path.join(repoRoot, "content", dir);
    try {
      const files = (await readdir(dirPath)).filter((f) => f.endsWith(".json"));
      result[key] = files.map((f) => path.basename(f, ".json")).sort();
    } catch {
      result[key] = [];
    }
  }
  sendJson(response, 200, result);
}

// Procgen preview: run the ported dungeon generator server-side and return a compact
// render payload for the read-only DevKit preview tab (card-procgen-port scope 4). This
// exercises the REAL module (server/src/procgen), so the toy can never drift from the
// shipped generator. Read-only: no writes, no gameplay wiring.
function clampInt(value: string | null, def: number, lo: number, hi: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

async function handleProcgenGenerate(response: ServerResponse, url: URL): Promise<void> {
  const seed = clampInt(url.searchParams.get("seed"), 12345, 0, 0xffffffff);
  const roomCount = clampInt(url.searchParams.get("roomCount"), 24, 4, 60);
  const loopChanceRaw = Number(url.searchParams.get("loopChance"));
  const loopChance = Number.isFinite(loopChanceRaw) ? Math.max(0, Math.min(1, loopChanceRaw)) : 0.3;
  try {
    const d = generateDungeon({ seed, roomCount, loopChance });
    // Pack the grid as a base64 string of the raw cell bytes so the canvas can draw it
    // without shipping a W*H JSON array.
    const gridB64 = Buffer.from(d.grid).toString("base64");
    // Emit the layout too so the preview can show the collision/spawn counts the runtime
    // would consume (tileSize 32, MVP-0 slime tiers).
    const layout = emitLayout(d, {
      mapId: "map_dungeon_preview",
      tileSize: 32,
      monsterByTier: { 1: "monster_meadow_slime", 2: "monster_dew_slime", 3: "monster_blossom_slime" },
    });
    sendJson(response, 200, {
      ok: true,
      seed,
      params: { seed, roomCount, loopChance },
      valid: d.valid,
      W: d.W,
      H: d.H,
      gridB64,
      FLOOR,
      WALL,
      rooms: d.rooms.map((r) => ({ id: r.id, cx: r.cx, cy: r.cy, w: r.w, h: r.h, type: r.type, depth: r.depth })),
      edges: d.edges.map((e) => ({ a: e.a, b: e.b, isLoop: e.isLoop, isCritical: e.isCritical })),
      spawns: d.spawns.map((s) => ({ x: s.x, y: s.y, tier: s.tier })),
      entrance: d.entrance,
      boss: d.boss,
      stats: d.stats,
      layoutSummary: {
        boundsPx: layout.bounds,
        blockedTiles: layout.collision.blocked.length,
        monsterSpawns: layout.monsterSpawns.length,
      },
    });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

const { handleZoneValidate, handleZoneExport, handleBuildClient } = createZoneCommandHandlers({
  runRepoCommand,
  readRequestJson,
  sendJson,
});

const routes = createDevkitRoutes({
  sendJson,
  handleStatus,
  queueSummaries,
  framePickerCandidates,
  handleStartAssetBank,
  handleStartFramePicker,
  handleRefreshAudio,
  handleRuntimeAssets,
  handleRuntimeAssetsCategorized,
  handleBankAssets,
  handleBankContext,
  handleAssetPlacementDefaults,
  handleAssetPlacementDefaultsPreview,
  handleAssetPlacementDefaultsSave,
  handlePromoteAsset,
  handleSyncPromoted,
  handlePromotedAssets,
  handleUnpromoteAsset,
  handleZoneLayouts,
  handleCaptureGallery,
  handleWorldDashboard,
  handlePipelineView,
  handleApplyStatus,
  handleZoneLoop,
  handleEditorCaptureSave,
  handleZoneLayoutSave,
  handleZoneLayoutInstanceOverrideSave,
  handleZoneValidate,
  handleZoneExport,
  handleBuildClient,
  handleMapManifests,
  handleAvailableAssetKeys,
  handleContentIds,
  handleWriteBridge,
  handleProcgenGenerate,
});

const hub = new DevkitHub({ repoRoot, port, sendJson, readRequestJson });
hub.registerRoutes(routes);
// Fail closed: refuse to boot when the route table and the generated API docs drift.
verifyRouteDocs(["devkit", "hub"], routes.keys());
const { serveStatic, serveRuntimeAsset, serveAssetFile, serveCaptureFile } = createStaticHandlers({
  repoRoot,
  devkitRoot,
  assetsRoot,
  sendText,
});

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  void (async () => {
    try {
      // --- Local-safety gate (browser CSRF protection for a loopback dev tool) ---
      // Browsers ALWAYS send Origin on cross-site fetch/XHR/form POSTs; local CLI tools
      // (curl, smoke tests, capture harness) send none. So: no Origin => trusted local
      // client; loopback Origin => CORS-reflected, but POSTs must carry the session
      // token; non-loopback Origin => rejected outright.
      const origin = request.headers.origin;
      if (typeof origin === "string") {
        if (!isLoopbackOrigin(origin)) {
          sendJson(response, 403, { ok: false, error: "forbidden origin" });
          return;
        }
        response.setHeader("access-control-allow-origin", origin);
        response.setHeader("vary", "Origin");
        response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
        response.setHeader("access-control-allow-headers", "content-type,x-devkit-token");
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/session-token") {
        // Same-origin/CLI only: DevKit's own pages and local tools may read the token;
        // other loopback pages may not (that would defeat the token).
        const selfOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
        if (origin === undefined || selfOrigins.includes(origin)) {
          sendJson(response, 200, { token: sessionToken });
        } else {
          sendJson(response, 403, { ok: false, error: "session token is same-origin only" });
        }
        return;
      }
      if (request.method === "POST" && typeof origin === "string" && request.headers["x-devkit-token"] !== sessionToken) {
        sendJson(response, 401, {
          ok: false,
          error: "missing/invalid x-devkit-token (DevKit pages fetch /api/session-token; CLI reads tools/devkit/.session-token)",
        });
        return;
      }
      const handler = routes.get(`${request.method} ${url.pathname}`);
      if (handler) {
        await handler(request, response, url);
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/runtime-asset/")) {
        await serveRuntimeAsset(response, url.pathname);
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/capture-file/")) {
        await serveCaptureFile(response, url.pathname);
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/assets-file/")) {
        await serveAssetFile(response, url.pathname);
        return;
      }
      if (request.method === "GET") {
        await serveStatic(response, url.pathname);
        return;
      }
      sendText(response, 405, "Method not allowed");
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  })();
});

// Bind to loopback only — the DevKit exposes unauthenticated state-changing endpoints
// (promote/export/build). Binding 0.0.0.0 would make them reachable from the LAN.
server.listen(port, "127.0.0.1", () => {
  // Token file for local CLI callers (gitignored). Pages get it via /api/session-token.
  void writeFile(sessionTokenPath, sessionToken, "utf8").catch((err) =>
    console.error(`[devkit] could not write session token file: ${err instanceof Error ? err.message : String(err)}`),
  );
  console.log(`GameKit Dev Kit: http://127.0.0.1:${port}/`);
  console.log(`Repo: ${repoRoot}`);
  console.log(`Assets: ${assetsRoot}`);
  void hub.init().catch((error) => console.error(`[devkit] hub init failed: ${error instanceof Error ? error.message : String(error)}`));
});

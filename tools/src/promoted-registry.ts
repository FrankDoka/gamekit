import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Canonical promoted-registry writer — the ONLY code allowed to write
 * client/public/assets/promoted-registry.json.
 *
 * DevKit (:8787) uses it in-process; the Asset Bank (:8765, Python) shells out to
 * promoted-registry-cli.ts. One implementation = no split-brain key schemes and no
 * unlocked read-modify-write (the 2026-06-30 clobber class).
 *
 * Guarantees:
 * - Cross-process exclusive lockfile (O_EXCL create, PID-validated; a lock held by a
 *   LIVE process is never stolen; timeout errors instead of stealing).
 * - Strict reads: a corrupt registry is quarantined to *.corrupt-<stamp>, never
 *   silently replaced by `{}`.
 * - Atomic writes (temp + rename) with rolling .prev1..prev3 backups.
 * - One canonical key scheme + a unique-targetPath invariant so two writers can
 *   never register different keys over the same runtime file.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REGISTRY_PATH = path.join(repoRoot, "client", "public", "assets", "promoted-registry.json");
const LOCK_PATH = REGISTRY_PATH + ".lock";
const BACKUP_COUNT = 3;

export const PromotedEntry = z
  .object({
    assetId: z.string().min(1),
    sourcePath: z.string().min(1),
    targetPath: z.string().min(1),
    targetName: z.string().min(1),
    type: z.string(),
    context: z.string().optional().default(""),
    kind: z.string().optional().default(""),
    category: z.string().optional().default(""),
    image: z.union([z.object({ width: z.number().optional(), height: z.number().optional() }), z.null()]).optional(),
    promotedAt: z.string(),
    warnings: z.array(z.unknown()).optional().default([]),
  })
  .passthrough();

export const PromotedRegistry = z
  .object({
    promoted: z.record(z.string(), PromotedEntry),
    meta: z.object({ lastUpdated: z.string().optional(), count: z.number().optional() }).passthrough(),
  })
  .passthrough();

export type PromotedEntryT = z.infer<typeof PromotedEntry>;
export type PromotedRegistryT = z.infer<typeof PromotedRegistry>;

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but not ours; ESRCH = gone.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Acquire the registry lock. Never steals from a live process; errors on timeout. */
async function acquireLock(timeoutMs = 15_000): Promise<void> {
  await mkdir(path.dirname(LOCK_PATH), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await writeFile(LOCK_PATH, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: "wx" });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let holderPid = NaN;
      try {
        holderPid = Number((JSON.parse(await readFile(LOCK_PATH, "utf8")) as { pid?: unknown }).pid);
      } catch {
        // Unreadable/partial lockfile — treat as stale only if it stays unreadable past the deadline.
      }
      if (!Number.isNaN(holderPid) && !pidAlive(holderPid)) {
        // Crash recovery: holder is provably dead.
        try {
          await unlink(LOCK_PATH);
        } catch {
          // Someone else cleaned it up first — retry the create.
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `promoted-registry lock held by live pid ${Number.isNaN(holderPid) ? "unknown" : holderPid} after ${timeoutMs}ms — NOT stealing. Retry, or remove ${LOCK_PATH} if you are sure no writer is running.`,
        );
      }
      await sleep(50);
    }
  }
}

async function releaseLock(): Promise<void> {
  try {
    await unlink(LOCK_PATH);
  } catch {
    // Already gone — releasing twice is harmless.
  }
}

/**
 * Strict read. Missing file → fresh empty registry. Unparseable/schema-invalid file →
 * quarantined copy + throw (the caller must surface this; we NEVER overwrite a
 * recoverable file with an empty one).
 */
export async function readRegistryStrict(): Promise<PromotedRegistryT> {
  let raw: string;
  try {
    raw = await readFile(REGISTRY_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { promoted: {}, meta: {} };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const quarantine = `${REGISTRY_PATH}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(REGISTRY_PATH, quarantine);
    throw new Error(
      `promoted-registry.json is corrupt (${(err as Error).message}). Quarantined a copy to ${path.basename(quarantine)} — restore from it or a .prev backup; refusing to overwrite.`,
    );
  }
  const result = PromotedRegistry.safeParse(parsed);
  if (!result.success) {
    const quarantine = `${REGISTRY_PATH}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(REGISTRY_PATH, quarantine);
    throw new Error(
      `promoted-registry.json failed schema validation: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}. Quarantined a copy to ${path.basename(quarantine)}.`,
    );
  }
  return result.data;
}

async function writeRegistryAtomic(registry: PromotedRegistryT): Promise<void> {
  registry.meta.lastUpdated = new Date().toISOString();
  registry.meta.count = Object.keys(registry.promoted).length;
  const validated = PromotedRegistry.parse(registry);
  // Rotate backups: .prev2 -> .prev3, .prev1 -> .prev2, current -> .prev1.
  for (let i = BACKUP_COUNT - 1; i >= 1; i--) {
    const from = `${REGISTRY_PATH}.prev${i}`;
    const to = `${REGISTRY_PATH}.prev${i + 1}`;
    if (existsSync(from)) {
      try {
        await rename(from, to);
      } catch {
        // Backup rotation is best-effort; the atomic write below is what matters.
      }
    }
  }
  if (existsSync(REGISTRY_PATH)) {
    try {
      await copyFile(REGISTRY_PATH, `${REGISTRY_PATH}.prev1`);
    } catch {
      // Best-effort backup.
    }
  }
  const tmp = `${REGISTRY_PATH}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(validated, null, 2) + "\n", "utf8");
  await rename(tmp, REGISTRY_PATH);
}

/** Run a read-modify-write under the cross-process lock. */
export async function updateRegistry<T>(mutate: (registry: PromotedRegistryT) => T | Promise<T>): Promise<T> {
  await acquireLock();
  try {
    const registry = await readRegistryStrict();
    const result = await mutate(registry);
    await writeRegistryAtomic(registry);
    return result;
  } finally {
    await releaseLock();
  }
}

export function registryEntriesMissingRuntimeFiles(
  registry: PromotedRegistryT,
  publicAssetsRoot: string,
): string[] {
  return Object.entries(registry.promoted)
    .filter(([, entry]) => {
      const rel = entry.targetPath.replace(/^assets[\\/]/, "");
      return !existsSync(path.join(publicAssetsRoot, rel));
    })
    .map(([key]) => key)
    .sort();
}

export async function pruneRegistryEntriesMissingRuntimeFiles(
  publicAssetsRoot = path.join(repoRoot, "client", "public", "assets"),
): Promise<{ removed: string[]; kept: number }> {
  return updateRegistry((registry) => {
    const removed = registryEntriesMissingRuntimeFiles(registry, publicAssetsRoot);
    for (const key of removed) delete registry.promoted[key];
    return { removed, kept: Object.keys(registry.promoted).length };
  });
}

/**
 * Canonical registry key: the bank assetId when known, else `<category>_<targetName>`
 * (the historical DevKit scheme), sanitized to the content-ID grammar.
 */
export function canonicalKey(entry: { assetId?: string; category: string; targetName: string }): string {
  const base = entry.assetId && entry.assetId.trim() ? entry.assetId : `${entry.category}_${entry.targetName}`;
  return base.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

export type PromoteInput = {
  assetId?: string;
  sourcePath: string;
  targetPath: string;
  targetName: string;
  type: string;
  context?: string;
  kind?: string;
  category: string;
  image?: { width?: number; height?: number } | null;
  /**
   * Render basis. "1440p-display-px" marks a runtime authored at world px × 2.517
   * (D3-v2 resolution contract) that the client renders back down via ASSET_BASIS_SCALE —
   * promoted-asset-sync collects these into PROMOTED_1440P_BASIS_ASSETS. Omit for plain
   * world-px assets. First-class here so restyle-wave intakes register basis through the
   * canonical writer instead of hand-editing the JSON.
   */
  basis?: string;
  warnings?: unknown[];
};

/**
 * Insert/replace a promotion. Enforces the unique-targetPath invariant: any existing
 * entry (under any key scheme) pointing at the same targetPath or sourcePath is
 * replaced, so the two historical key schemes converge instead of double-registering.
 */
export async function promoteEntry(input: PromoteInput): Promise<{ key: string; replacedKeys: string[] }> {
  const key = canonicalKey(input);
  if (!key) throw new Error(`cannot derive a registry key from ${JSON.stringify(input.targetName)}`);
  const entry: PromotedEntryT = PromotedEntry.parse({
    assetId: input.assetId && input.assetId.trim() ? input.assetId : key,
    sourcePath: input.sourcePath,
    targetPath: input.targetPath,
    targetName: input.targetName,
    type: input.type,
    context: input.context ?? "",
    kind: input.kind ?? "",
    category: input.category ?? "",
    image: input.image ?? null,
    ...(input.basis ? { basis: input.basis } : {}),
    promotedAt: new Date().toISOString(),
    warnings: input.warnings ?? [],
  });
  return updateRegistry((registry) => {
    const replacedKeys: string[] = [];
    for (const [existingKey, existing] of Object.entries(registry.promoted)) {
      if (existingKey === key) continue;
      if (existing.targetPath === entry.targetPath || existing.sourcePath === entry.sourcePath) {
        delete registry.promoted[existingKey];
        replacedKeys.push(existingKey);
      }
    }
    registry.promoted[key] = entry;
    return { key, replacedKeys };
  });
}

/** Remove a promotion by registry key OR targetName. Returns the removed entry, if any. */
export async function unpromoteEntry(keyOrTargetName: string): Promise<PromotedEntryT | null> {
  return updateRegistry((registry) => {
    const direct = registry.promoted[keyOrTargetName];
    if (direct) {
      delete registry.promoted[keyOrTargetName];
      return direct;
    }
    const found = Object.entries(registry.promoted).find(([, entry]) => entry.targetName === keyOrTargetName);
    if (!found) return null;
    delete registry.promoted[found[0]];
    return found[1];
  });
}

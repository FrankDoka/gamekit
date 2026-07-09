import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Repo asset roots the Asset Bank catalogs ALONGSIDE Z:/Assets.
 *
 * Since the cel pivot (~2026-07-02) generation lanes deliver into the REPO, not into
 * Z:/Assets — so a bank that only scanned Z:/Assets went blind to everything recent
 * (owner escalation 2026-07-07: "a lot of stuff is missing"). These roots are the fix.
 *
 * Repo roots are READ-ONLY to the bank: it browses/reviews them, but never promotes,
 * accepts, or removes their files. Review decisions still write only to Z:/Assets-metadata;
 * the repo files are already downstream of the pipeline. Every repo row carries an `origin`
 * of "repo-runtime" or "repo-source" so the UI, the mutation guards, and the anti-drift gate
 * can tell them apart from bank-origin rows.
 */

export type AssetOrigin = "bank" | "repo-runtime" | "repo-source";

export type RepoRoot = {
  origin: Exclude<AssetOrigin, "bank">;
  /** Absolute path to the root on disk. */
  root: string;
  /** Root-relative catalog path prefix (keeps ids/paths non-colliding across roots). */
  prefix: string;
};

const supportedExt = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp3", ".wav", ".ogg", ".mp4", ".mov", ".webm", ".md", ".json", ".txt"]);

// Directories that are pipeline noise / regenerable intermediates, never catalog input.
// Mirrors the bank-side skip list but scoped to what the repo trees actually carry.
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
  "frames",
  "reports",
  "raw",
  "_raw",
  "qa",
  "_qa",
  "retired",
]);
const skipDirPrefixes = ["_rejected", "_archive", "_deleted"];

function isSkippedDir(name: string): boolean {
  return skipDirs.has(name) || skipDirPrefixes.some((p) => name.startsWith(p));
}

/** repo-source packages: only the runtime/ deliverables are browsable assets — the rest
 * of a package (frames/, gate-calibration/, source-*, candidates/, previews) is rebuild
 * evidence and buried the real deliverables under hundreds of rows (owner escalation #2,
 * 2026-07-07: bald-base invisible under 245 intermediate rows). */
export function isRepoSourceDeliverable(rel: string): boolean {
  const parts = rel.toLowerCase().split("/");
  return parts.includes("runtime");
}

function isNoiseFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".tmp") ||
    lower.endsWith(".prev") ||
    lower.includes(".bak") ||
    lower.includes("before-move") ||
    lower.includes("_preview") ||
    lower.includes("_3x3_preview") ||
    lower.includes("_2x2_preview")
  );
}

/** Resolve the two default repo roots for a game worktree. Missing roots are dropped. */
export function defaultRepoRoots(repoRoot: string): RepoRoot[] {
  const roots: RepoRoot[] = [
    { origin: "repo-runtime", root: path.join(repoRoot, "client", "public", "assets"), prefix: "runtime-only" },
    { origin: "repo-source", root: path.join(repoRoot, "assets", "sources", "accepted"), prefix: "repo-source" },
  ];
  return roots.filter((entry) => existsSync(entry.root));
}

/** Walk a root, yielding root-relative POSIX paths for supported, non-noise asset files. */
export async function walkRepoRoot(rootAbs: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [rootAbs];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!isSkippedDir(entry.name)) stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isNoiseFile(entry.name)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!supportedExt.has(ext)) continue;
      out.push(path.relative(rootAbs, full).replaceAll("\\", "/"));
    }
  }
  return out.sort();
}

/**
 * The catalog path a repo file gets, prefixed by its root so ids never collide with
 * Z:/Assets rows or the other repo root. repo-runtime reuses `runtime-only/<rel>` — the
 * SAME scheme reconcile ingests under — so a bank scan and a reconcile ingest converge on
 * one row instead of double-registering (owner report 2026-07-06: archived props must keep
 * their registry-derived id so zone packs/collections/entity profiles keep resolving).
 */
export function repoCatalogPath(rootPrefix: string, rel: string): string {
  return `${rootPrefix}/${rel.replaceAll("\\", "/")}`;
}

/**
 * Category for a repo asset, derived from its ROOT-RELATIVE path (repo path conventions).
 * repo-runtime: `sprites/<player|monster|npc>_*`, `tiles`, `props`, `decals`, `vfx`, `ui`,
 * `audio`, portraits by filename. repo-source: category from the entity-id / package folder
 * (`monster_*` -> monsters, `npc_*` -> npcs, `player_*` -> players, `ui*` -> ui, etc.).
 */
export function repoCategory(origin: RepoRoot["origin"], rel: string): string {
  const lower = rel.replaceAll("\\", "/").toLowerCase();
  const parts = lower.split("/").filter(Boolean);
  const name = parts.at(-1) ?? "";
  const ext = path.extname(name);
  if ([".mp3", ".wav", ".ogg"].includes(ext) || parts.includes("audio")) return "audio";

  if (origin === "repo-runtime") {
    const seg0 = parts[0] ?? "";
    if (seg0 === "sprites") {
      if (name.startsWith("npc_")) return "npcs";
      if (name.startsWith("monster_")) return "monsters";
      if (name.startsWith("player") || name.includes("class_")) return "players";
      if (name.includes("portrait")) return "portraits";
      if (name.includes("icon")) return "icons";
      return "sprites";
    }
    if (seg0 === "tiles" || seg0 === "tilesets") return "tilesets";
    if (seg0 === "props") return "props";
    if (seg0 === "decals") return "decals";
    if (seg0 === "vfx") return "vfx";
    if (seg0 === "icons") return "icons";
    if (seg0 === "ui" || seg0 === "loading") return name.includes("portrait") ? "portraits" : "ui";
    if (seg0 === "generated") {
      // Unresolved regen candidates keyed by filename family.
      if (name.startsWith("npc_")) return "npcs";
      if (name.startsWith("monster_")) return "monsters";
      if (name.startsWith("player") || name.includes("class_")) return "players";
      return "unknown";
    }
    return "unknown";
  }

  // repo-source: assets/sources/accepted/<entity-or-system>/...
  const seg0 = parts[0] ?? "";
  if (seg0.startsWith("monster_")) return "monsters";
  if (seg0.startsWith("npc_")) return "npcs";
  if (seg0.startsWith("player_") || seg0.startsWith("class_")) return "players";
  if (seg0.startsWith("vfx")) return "vfx";
  if (seg0 === "ui" || seg0 === "ui_interact_prompt" || seg0.startsWith("ui_")) return "ui";
  if (seg0 === "map_visuals") return "environments";
  if (name.includes("portrait")) return "portraits";
  if (name.includes("icon")) return "icons";
  // Pre-convention packages (e.g. r1_harbor_vibrancy_pilot_20260702) don't carry an
  // entity-prefix seg0 — they lay assets out as `<pkg>/final/<type>/<file>`. Fall back to a
  // known asset-type folder anywhere in the path so those rows get a sensible category instead
  // of `unknown`. Kept last so the entity-prefix conventions above always win.
  const typeFolder: Record<string, string> = {
    decals: "decals",
    props: "props",
    tiles: "tilesets",
    tilesets: "tilesets",
    vfx: "vfx",
    icons: "icons",
    portraits: "portraits",
    backgrounds: "backgrounds",
    environments: "environments",
    sprites: "sprites",
  };
  for (const part of parts) {
    const mapped = typeFolder[part];
    if (mapped) return mapped;
  }
  return "unknown";
}

/** Kind for a repo asset (image vs audio vs document vs spritesheet), path/name derived. */
export function repoKind(rel: string): string {
  const lower = rel.replaceAll("\\", "/").toLowerCase();
  const ext = path.extname(lower);
  if ([".mp3", ".wav", ".ogg"].includes(ext)) return "audio";
  if ([".mp4", ".webm", ".mov"].includes(ext)) return "video";
  if ([".md", ".json", ".txt"].includes(ext)) return "document";
  const name = path.basename(lower, ext);
  if (["sheet", "strip", "frames", "walk", "attack", "idle", "cast", "gather"].some((w) => name.includes(w))) return "spritesheet";
  if (name.includes("contact")) return "contact_sheet";
  if (name.includes("portrait") || name.includes("bust") || name.includes("headshot")) return "portrait";
  if (name.includes("icon")) return "icon";
  return "sprite";
}

export { supportedExt as repoSupportedExt };

/**
 * A cheap fingerprint over one root (count:bytes:maxMtime), used by the auto-rescan poll.
 * Combining per-root fingerprints lets the poll notice a repo-side delivery, not just a
 * Z:/Assets change.
 */
export async function repoRootFingerprint(rootAbs: string): Promise<string> {
  let count = 0;
  let bytes = 0;
  let maxMtimeMs = 0;
  for (const rel of await walkRepoRoot(rootAbs)) {
    const info = await stat(path.join(rootAbs, rel)).catch(() => undefined);
    if (!info) continue;
    count += 1;
    bytes += info.size;
    if (info.mtimeMs > maxMtimeMs) maxMtimeMs = info.mtimeMs;
  }
  return `${count}:${bytes}:${Math.round(maxMtimeMs)}`;
}

/** Convenience for tools that need the repo root from this module's location. */
export function repoRootFromModule(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

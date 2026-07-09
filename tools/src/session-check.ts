import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { gameRoot, assetsRoot as defaultAssetsRoot, integrationBranch } from "./toolkit-config.js";

const CANONICAL_ROOT = gameRoot();
const REUSABLE_WORKTREE = process.env.INTEGRATOR_WORKTREE ?? `${gameRoot()}-integrator`;
const IDLE_BRANCH = "codex/integrator-standby";
const MAIN_BRANCH = integrationBranch();

const ROOT = process.cwd();

const normalizePath = (value: string): string => value.trim().replace(/\\/g, "/").replace(/\/$/, "");
const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const gitMaybe = (cwd: string, args: string[]): string => {
  try {
    return git(cwd, args);
  } catch {
    return "";
  }
};

const unique = (values: string[]): string[] => [...new Set(values)].sort();
const lines = (text: string): string[] => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const rawLines = (text: string): string[] => text.split(/\r?\n/).filter((line) => line.length > 0);
const statusPath = (line: string): string => {
  const match = /^(?:..|[ MADRCU?!])\s+(.+)$/.exec(line);
  const raw = match ? match[1] : line.trim();
  const renamed = raw.split(" -> ");
  return renamed[renamed.length - 1].replace(/^"|"$/g, "");
};
const hasAny = (files: string[], patterns: RegExp[]): boolean => files.some((file) => patterns.some((pattern) => pattern.test(file)));
const archiveFinalExt = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp3", ".wav", ".ogg", ".mp4", ".webm"]);

function countArchiveResolvedCandidates(): number {
  const assetsRoot = defaultAssetsRoot();
  const publicAssetsRoot = join(ROOT, "client", "public", "assets");
  const registryPath = join(publicAssetsRoot, "promoted-registry.json");
  if (!existsSync(assetsRoot) || !existsSync(registryPath)) return 0;
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as { promoted?: Record<string, { sourcePath?: string; targetPath?: string }> };
  const entries = Object.values(registry.promoted ?? {});
  const batches = new Map<string, string[]>();
  const walk = (dir: string): void => {
    const entriesInDir = (() => {
      try {
        return readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
      } catch {
        return [];
      }
    })();
    for (const entry of entriesInDir) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith("_") && !entry.name.startsWith("_incoming")) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile() || !archiveFinalExt.has(extname(entry.name).toLowerCase())) continue;
      const rel = relative(assetsRoot, full).replaceAll("\\", "/");
      const parts = rel.split("/");
      const finalIndex = parts.lastIndexOf("final");
      if (finalIndex <= 0) continue;
      const batch = parts.slice(0, finalIndex).join("/");
      const list = batches.get(batch) ?? [];
      list.push(rel);
      batches.set(batch, list);
    }
  };
  walk(assetsRoot);
  let resolved = 0;
  for (const finals of batches.values()) {
    const allLive = finals.every((finalPath) => {
      const promoted = entries.find((entry) => entry.sourcePath === finalPath);
      if (!promoted?.targetPath) return false;
      return existsSync(join(publicAssetsRoot, promoted.targetPath.replace(/^assets[\\/]/, "")));
    });
    if (allLive) resolved += 1;
  }
  return resolved;
}

const topLevel = normalizePath(git(ROOT, ["rev-parse", "--show-toplevel"]));
const branch = git(ROOT, ["branch", "--show-current"]) || "(detached)";
const head = git(ROOT, ["rev-parse", "--short", "HEAD"]);
const masterHead = gitMaybe(ROOT, ["rev-parse", "--short", MAIN_BRANCH]);
const porcelain = rawLines(gitMaybe(ROOT, ["status", "--short"]));
const dirtyFiles = porcelain.map(statusPath);
const branchFiles = branch === MAIN_BRANCH ? [] : lines(gitMaybe(ROOT, ["diff", "--name-only", `${MAIN_BRANCH}...HEAD`]));
const changedFiles = unique([...dirtyFiles, ...branchFiles]);
const unpushedCommits = branch === MAIN_BRANCH ? [] : lines(gitMaybe(ROOT, ["log", "--oneline", `${MAIN_BRANCH}..HEAD`]));

const worktreeText = gitMaybe(ROOT, ["worktree", "list"]);
const worktrees = lines(worktreeText).map((line) => {
  const match = /^(\S+)\s+\S+(?:\s+\[(.+?)\])?/.exec(line);
  return match ? { path: normalizePath(match[1]), branch: match[2] ?? "(detached)" } : undefined;
}).filter((entry): entry is { path: string; branch: string } => Boolean(entry));
const reusable = worktrees.find((entry) => entry.path === REUSABLE_WORKTREE);

const validationSuggestions = new Set<string>();
if (changedFiles.length > 0) validationSuggestions.add("pnpm validate");
if (hasAny(changedFiles, [/^(client\/src|client\/index\.html|client\/public\/assets)\//, /^shared\/src\//])) {
  validationSuggestions.add("pnpm build:client");
  validationSuggestions.add("pnpm smoke:client");
}
if (hasAny(changedFiles, [/^server\/src\//, /^shared\/src\//, /^server\/migrations\//])) {
  validationSuggestions.add("pnpm smoke:persistence if local PostgreSQL/Docker is available");
}
if (hasAny(changedFiles, [/^docs\//, /^AGENTS\.md$/, /^CLAUDE\.md$/, /^README\.md$/])) {
  validationSuggestions.add("pnpm docs:budget");
}
if (hasAny(changedFiles, [/^client\/public\/assets\/index\.json$/, /^client\/public\/assets\//])) {
  validationSuggestions.add("pnpm animation-sync-client if animation index/assets changed");
}

const touchedDevlog = changedFiles.some((file) => /^docs\/devlog\/\d+-.+\.md$/.test(file));
const touchedHotState = changedFiles.some((file) => /^docs\/state\/(session-brief|handoff|project-memory|active-sessions)\.md$/.test(file));
const touchedCodeOrTooling = hasAny(changedFiles, [/^(client|server|shared|tools)\/src\//, /^package\.json$/, /^pnpm-lock\.yaml$/]);
const touchedDocs = hasAny(changedFiles, [/^docs\//, /^AGENTS\.md$/, /^CLAUDE\.md$/, /^README\.md$/]);

const notes: string[] = [];
if (topLevel === normalizePath(CANONICAL_ROOT) && worktrees.some((entry) => entry.path !== normalizePath(CANONICAL_ROOT))) {
  notes.push("Canonical tree is active while side worktrees exist; edit work should normally happen in a role worktree.");
}
if (topLevel === REUSABLE_WORKTREE && branch === IDLE_BRANCH && porcelain.length > 0) {
  notes.push(`${REUSABLE_WORKTREE} is on standby but dirty; park/start helpers expect standby to stay clean.`);
}
if (topLevel === REUSABLE_WORKTREE && branch !== IDLE_BRANCH && porcelain.length === 0 && unpushedCommits.length === 0) {
  notes.push("Reusable integrator worktree is on a task branch with no changes; park it if the task is abandoned.");
}
if (touchedCodeOrTooling && !touchedDevlog) {
  notes.push("Code/tooling changed without a devlog in this branch diff; substantive commits normally include one.");
}
if ((touchedCodeOrTooling || touchedDocs) && !touchedHotState) {
  notes.push("Consider whether session-brief, handoff, or project-memory need a concise current-state update.");
}
if (branch !== MAIN_BRANCH && unpushedCommits.length > 0) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", branch, MAIN_BRANCH], { cwd: ROOT, stdio: "ignore" });
  } catch {
    notes.push(`Branch ${branch} is not merged into ${MAIN_BRANCH} yet; merge before parking.`);
  }
}
if (reusable && reusable.branch !== IDLE_BRANCH && normalizePath(ROOT) !== REUSABLE_WORKTREE) {
  notes.push(`Reusable integrator worktree is currently busy on ${reusable.branch}.`);
}
if (existsSync(join(ROOT, "tools", "src", "assets-archive-resolved.ts"))) {
  try {
    const count = countArchiveResolvedCandidates();
    if (count > 0) notes.push(`Asset Bank has ${count} resolved batch(es) eligible for archive; run pnpm assets:archive-resolved, then --apply after review.`);
  } catch (error) {
    notes.push(`Asset archive-resolved advisory unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log("[session:check] location");
console.log(`  root:    ${topLevel}`);
console.log(`  branch:  ${branch}`);
console.log(`  head:    ${head}`);
if (masterHead) console.log(`  ${MAIN_BRANCH}:  ${masterHead}`);
console.log(`  status:  ${porcelain.length === 0 ? "clean" : `${porcelain.length} changed item(s)`}`);

console.log("\n[session:check] worktrees");
for (const entry of worktrees) {
  console.log(`  ${entry.path}  [${entry.branch}]`);
}

console.log("\n[session:check] changed files");
if (changedFiles.length === 0) {
  console.log("  none");
} else {
  for (const file of changedFiles.slice(0, 40)) console.log(`  ${file}`);
  if (changedFiles.length > 40) console.log(`  ... ${changedFiles.length - 40} more`);
}

console.log("\n[session:check] suggested closeout gates");
if (validationSuggestions.size === 0) {
  console.log("  none from changed paths");
} else {
  for (const suggestion of validationSuggestions) console.log(`  ${suggestion}`);
}

console.log("\n[session:check] hygiene notes");
if (notes.length === 0) {
  console.log("  none");
} else {
  for (const note of notes) console.log(`  ${note}`);
}

if (topLevel === REUSABLE_WORKTREE) {
  const canPark = branch !== IDLE_BRANCH && porcelain.length === 0 && unpushedCommits.length > 0;
  console.log("\n[session:check] reusable integrator closeout");
  if (branch === IDLE_BRANCH) {
    console.log("  parked on standby");
  } else if (canPark) {
    console.log(`  after merging to ${MAIN_BRANCH}, run: pnpm integrator:park`);
  } else {
    console.log("  finish/stage/commit/merge before parking");
  }
}

const activeSessionsPath = join(ROOT, "docs", "state", "active-sessions.md");
if (!existsSync(activeSessionsPath)) {
  console.log("\n[session:check] warning: docs/state/active-sessions.md not found from this root");
}

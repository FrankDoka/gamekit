/**
 * lane-close — the integrator's mandatory lane-closure mechanism (owner, 2026-07-03).
 * "A session is done when the integrator says it is" — and saying it DONE now means
 * running this. From the primary worktree only, removes the worktree, deletes the
 * merged branch, prunes, deletes the target folder, and re-syncs the roster.
 * `--sweep` explicitly attempts every Z:/gamekit-* folder that is no longer a
 * registered primary-repo worktree (husk cleanup) and reports locked ones.
 * `--park` keeps a lane in the registry but marks it inactive/ignored by the
 * board lifecycle.
 *
 * Usage:
 *   pnpm lane:close <worktree-path> [branch] [--force]   # close one lane
 *   pnpm lane:close --sweep                    # retry all husk folders
 *   pnpm lane:close --park <lane|worktree|branch>
 */
import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { gameRoot, integrationBranch } from "./toolkit-config.js";
import { ensureLanesDir, lanesDir, updateLaneRegistry } from "./lane-registry";

const ROOT = process.cwd();
const MAIN_BRANCH = integrationBranch();
const PRIMARY_ROOT = (process.env.LANE_CLOSE_PRIMARY_ROOT ?? gameRoot()).replace(/\\/g, "/").replace(/\/+$/, "");
const LANES_JSON = join(PRIMARY_ROOT, "tools", "_lanes", "lanes.json");
const INTEGRATOR_LOCK = join(lanesDir(PRIMARY_ROOT), ".integrator.lock");

type IntegratorLock = {
  pid: number;
  acquired_at: string;
};

function sh(cmd: string): string {
  return execSync(cmd, { cwd: PRIMARY_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Robust git runner. `execFileSync("git", …)` does NO shell resolution, so it throws
 * `spawnSync git ENOENT` whenever `git` is not directly resolvable on the tool's spawn
 * PATH — which bit lane-close twice from the tsx spawn env even though `sh()` (which
 * DOES use a shell) found git fine (masterplan 1.2). The fix: attempt the plain
 * execFile first (identical behavior when git is on PATH — same exit codes, same throws
 * for real git failures), and ONLY on a spawn-level ENOENT fall back to a shell that
 * resolves git the way `sh()` does. Args are passed to the shell as a single argv-safe
 * string; every current caller passes literal, whitespace-free git tokens.
 */
function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Spawn could not locate the git binary — retry through a shell (PATH lookup like sh()).
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    }).trim();
  }
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function laneFromBranch(branch: string): string | null {
  const match = /^codex\/card-(.+)$/.exec(branch);
  return match ? match[1] : null;
}

function laneFromWorktree(wt: string): string {
  const base = wt.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? wt;
  return base.replace(/^gamekit-/, "");
}

function assertPrimaryCwd(): boolean {
  let primaryTop: string;
  let currentTop: string;
  try {
    primaryTop = git(PRIMARY_ROOT, ["rev-parse", "--show-toplevel"]).replace(/\\/g, "/");
  } catch (error) {
    console.error(`[lane-close] BLOCKED: primary repo cannot be resolved at ${PRIMARY_ROOT}: ${(error as Error).message.split("\n")[0]}`);
    return false;
  }
  try {
    currentTop = git(ROOT, ["rev-parse", "--show-toplevel"]).replace(/\\/g, "/");
  } catch (error) {
    console.error(`[lane-close] BLOCKED: cwd is not inside a git repo: ${ROOT} (${(error as Error).message.split("\n")[0]})`);
    return false;
  }
  if (normalizePath(currentTop) !== normalizePath(primaryTop)) {
    console.error(`[lane-close] BLOCKED: lane-close must run from the primary repo worktree.`);
    console.error(`[lane-close] primary=${primaryTop}`);
    console.error(`[lane-close] current=${currentTop}`);
    return false;
  }
  return true;
}

function tryRm(dir: string): boolean {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return !fs.existsSync(dir);
  } catch {
    return false;
  }
}

function archiveLaneDebris(lane: string): void {
  const dir = lanesDir(PRIMARY_ROOT);
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((name) => {
    if (!name.startsWith(`${lane}-`)) return false;
    return name.endsWith(".jsonl") || name.endsWith(".err") || name === `${lane}-stderr.txt`;
  });
  if (!files.length) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveDir = join(dir, "archive", `${lane}-${stamp}`);
  fs.mkdirSync(archiveDir, { recursive: true });
  for (const file of files) {
    fs.renameSync(join(dir, file), join(archiveDir, file));
  }
  console.log(`[lane-close] archived ${files.length} lane log file(s): ${archiveDir}`);
}

function composeFileExists(dir: string): boolean {
  return fs.existsSync(join(dir, "docker-compose.yml")) || fs.existsSync(join(dir, "compose.yml")) || fs.existsSync(join(dir, "docker-compose.yaml")) || fs.existsSync(join(dir, "compose.yaml"));
}

function composeProjectName(wt: string): string {
  return wt.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "";
}

function sweepComposeProject(wt: string): void {
  if (!composeFileExists(wt)) return;
  const project = composeProjectName(wt);
  if (!project) return;
  try {
    execFileSync("docker", ["compose", "-p", project, "down"], { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    console.log(`[lane-close] compose project swept: ${project}`);
  } catch (error) {
    console.log(`[lane-close] compose sweep failed for ${project}: ${(error as Error).message.split("\n")[0]}`);
  }
}

function pidIsLive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readIntegratorLock(): IntegratorLock | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(INTEGRATOR_LOCK, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      Number.isInteger((parsed as Record<string, unknown>).pid) &&
      typeof (parsed as Record<string, unknown>).acquired_at === "string"
    ) {
      return parsed as IntegratorLock;
    }
  } catch {
    // A corrupt lock cannot prove liveness, so it is treated as stale below.
  }
  return null;
}

function acquireIntegratorLock(): boolean {
  ensureLanesDir(PRIMARY_ROOT);
  const lock: IntegratorLock = { pid: process.pid, acquired_at: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(INTEGRATOR_LOCK, "wx");
      fs.writeFileSync(fd, JSON.stringify(lock, null, 2) + "\n", "utf8");
      fs.closeSync(fd);
      console.log(`[lane-close] integrator lock acquired: pid=${lock.pid}`);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const existing = readIntegratorLock();
      if (existing && pidIsLive(existing.pid)) {
        console.error(`[lane-close] BLOCKED: live integrator lock held by pid=${existing.pid} since ${existing.acquired_at}`);
        console.error(`[lane-close] lock file: ${INTEGRATOR_LOCK}`);
        return false;
      }
      try {
        fs.rmSync(INTEGRATOR_LOCK, { force: true });
        console.log(`[lane-close] stale integrator lock stolen: ${existing ? `pid=${existing.pid}` : "unreadable lock"}`);
      } catch (removeError) {
        console.error(`[lane-close] BLOCKED: could not remove stale integrator lock (${(removeError as Error).message})`);
        return false;
      }
    }
  }
  return false;
}

function releaseIntegratorLock(): void {
  const existing = readIntegratorLock();
  if (!existing || existing.pid !== process.pid) return;
  fs.rmSync(INTEGRATOR_LOCK, { force: true });
  console.log("[lane-close] integrator lock released");
}

function registeredWorktrees(): string[] {
  return sh("git worktree list --porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).replace(/\\/g, "/"));
}

function primaryBranchExists(branch: string): boolean {
  try {
    git(PRIMARY_ROOT, ["rev-parse", "--verify", "--quiet", branch]);
    return true;
  } catch {
    return false;
  }
}

function branchTip(branch: string): string | null {
  try {
    return git(PRIMARY_ROOT, ["rev-parse", "--verify", branch]);
  } catch {
    return null;
  }
}

function checkedOutBranch(dir: string): string | null {
  try {
    const branch = git(dir, ["branch", "--show-current"]);
    return branch || null;
  } catch {
    return null;
  }
}

/**
 * Uncommitted work in a lane worktree is invisible to the merge guard: the lane
 * contract stages the deliverable + writes .commit-msg.txt without committing, so
 * the branch tip stays at the master base and merge-base --is-ancestor passes even
 * though the ENTIRE deliverable lives only in the index/working tree (s22
 * p3-weapon-arc data loss, 2026-07-07). Any porcelain output — staged, unstaged, or
 * untracked-non-ignored — means unsaved work. .commit-msg.txt is gitignored, so it
 * never appears here; the staged deliverable files do.
 */
function worktreeDirtyFiles(dir: string): string[] {
  let porcelain: string;
  try {
    porcelain = git(dir, ["status", "--porcelain"]);
  } catch (error) {
    // If status cannot be read we cannot prove the tree is clean; treat as dirty —
    // and SAY WHY (a swallowed cause hid the real probe failure, 2026-07-08).
    const detail = error instanceof Error ? error.message : String(error);
    const stderr = (error as { stderr?: Buffer | string })?.stderr?.toString().trim();
    return [`<status --porcelain failed in ${dir} — cannot prove clean: ${stderr || detail}>`];
  }
  return porcelain
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

/**
 * Returns true when the close may proceed. A dirty worktree BLOCKS (returns false)
 * unless --force-dirty is passed, in which case it echoes the abandoned file list
 * loudly and proceeds. A clean worktree returns true silently.
 */
function passesDirtyGuard(wt: string, forceDirty: boolean): boolean {
  const dirty = worktreeDirtyFiles(wt);
  if (!dirty.length) return true;
  if (forceDirty) {
    console.error(`[lane-close] WARNING: --force-dirty discarding ${dirty.length} uncommitted change(s) in ${wt}:`);
    for (const line of dirty) console.error(`[lane-close]   ${line}`);
    console.error("[lane-close] these files are being DELETED with the worktree and cannot be recovered.");
    return true;
  }
  console.error(`[lane-close] BLOCKED: ${wt} has ${dirty.length} uncommitted change(s) — closing would DELETE them:`);
  for (const line of dirty) console.error(`[lane-close]   ${line}`);
  console.error(`[lane-close] recover with: pnpm intake ${checkedOutBranch(wt) ?? resolveCheckedOutBranch(wt) ?? "<branch>"}`);
  console.error("[lane-close] or, if this work is genuinely abandoned, rerun with --force-dirty");
  return false;
}

function resolveCheckedOutBranch(dir: string): string | null {
  try {
    const branch = git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    return branch || null;
  } catch {
    return null;
  }
}

function sweep(forceDirty: boolean): number {
  const reg = new Set(registeredWorktrees().map((p) => p.toLowerCase()));
  // TODO: parameterize — worktree-husk sweep scans the drive parent for `<prefix>-*` dirs.
  // Both the parent dir and the husk prefix are deployment-specific; env-overridable with the
  // historical defaults until the toolkit models a worktree-root config.
  const parent = process.env.LANE_WORKTREE_PARENT ?? "Z:/";
  const huskPrefix = (process.env.LANE_WORKTREE_PREFIX ?? "gamekit-").toLowerCase();
  const candidates = fs
    .readdirSync(parent)
    .filter((n) => n.toLowerCase().startsWith(huskPrefix))
    .map((n) => parent + n)
    .filter((p) => !reg.has(p.toLowerCase().replace(/\\/g, "/")));
  const husks: string[] = [];
  let dirtySkipped = 0;
  for (const candidate of candidates) {
    const branch = checkedOutBranch(candidate);
    if (branch && primaryBranchExists(branch)) {
      console.log(`[lane-close] SKIP live-branch folder ${candidate} (${branch} still exists in primary repo)`);
      continue;
    }
    if (!passesDirtyGuard(candidate, forceDirty)) {
      dirtySkipped++;
      continue;
    }
    husks.push(candidate);
  }
  if (husks.length) {
    console.log("[lane-close] sweep would-delete:");
    for (const h of husks) console.log(`  - ${h}`);
  }
  let locked = 0;
  for (const h of husks) {
    if (tryRm(h)) console.log(`[lane-close] deleted husk ${h}`);
    else {
      locked++;
      console.log(`[lane-close] LOCKED ${h} — a process (likely a terminal/server) holds it; close it and rerun: pnpm lane:close --sweep`);
    }
    archiveLaneDebris(laneFromWorktree(h));
  }
  if (dirtySkipped) {
    console.log(`[lane-close] ${dirtySkipped} folder(s) SKIPPED with uncommitted work — intake or rerun --sweep --force-dirty`);
  }
  if (!husks.length && !dirtySkipped) console.log("[lane-close] no husk folders found");
  return locked + dirtySkipped;
}

function deleteBranchIfMergedToMaster(branch: string): void {
  try {
    git(PRIMARY_ROOT, ["merge-base", "--is-ancestor", branch, MAIN_BRANCH]);
  } catch {
    console.log(`[lane-close] branch ${branch} not deleted — verify it is merged to ${MAIN_BRANCH}`);
    return;
  }
  try {
    git(PRIMARY_ROOT, ["branch", "-D", branch]);
    console.log(`[lane-close] branch deleted: ${branch}`);
  } catch {
    console.log(`[lane-close] branch ${branch} not deleted — git branch -D refused`);
  }
}

function verifyLaneBranchMerged(wt: string, force: boolean): { ok: true; branch: string; tip: string } | { ok: false } {
  const branch = resolveCheckedOutBranch(wt);
  if (!branch) {
    console.error(`[lane-close] REFUSED: cannot resolve checked-out branch for ${wt} (detached HEAD or missing worktree branch)`);
    return { ok: false };
  }
  const tip = branchTip(branch);
  if (!tip) {
    console.error(`[lane-close] REFUSED: checked-out branch ${branch} is missing from the primary repo`);
    return { ok: false };
  }
  try {
    git(PRIMARY_ROOT, ["merge-base", "--is-ancestor", branch, MAIN_BRANCH]);
    return { ok: true, branch, tip };
  } catch {
    if (!force) {
      console.error(`[lane-close] branch=${branch}`);
      console.error(`[lane-close] tip=${tip}`);
      console.error("[lane-close] REFUSED: branch not merged (use --force)");
      return { ok: false };
    }
    console.error(`[lane-close] WARNING: forcing close of unmerged branch ${branch} at ${tip}`);
    return { ok: true, branch, tip };
  }
}

function pruneLaneRegistry(wt: string, branch?: string): void {
  if (!fs.existsSync(LANES_JSON)) return;
  const normalizedWt = wt.toLowerCase();
  let before = 0;
  const next = updateLaneRegistry(PRIMARY_ROOT, (entries) => {
    before = entries.length;
    return entries.filter((entry) => {
      return entry.worktree !== wt && entry.worktree.toLowerCase() !== normalizedWt && (!branch || entry.branch !== branch);
    });
  });
  if (next.length !== before) {
    console.log(`[lane-close] lanes registry pruned: ${before}->${next.length}`);
  }
}

function parkLane(target: string): number {
  const normalizedTarget = normalizePath(target);
  const laneCandidate = laneFromBranch(target) ?? laneFromWorktree(target);
  let changed = 0;
  const now = new Date().toISOString();
  updateLaneRegistry(PRIMARY_ROOT, (entries) =>
    entries.map((entry) => {
      const matches =
        entry.lane === target ||
        entry.lane === laneCandidate ||
        entry.branch === target ||
        normalizePath(entry.worktree) === normalizedTarget;
      if (!matches) return entry;
      if (entry.state !== "parked") changed++;
      return { ...entry, state: "parked", updated_at: now };
    }),
  );
  if (changed === 0) {
    console.log(`[lane-close] no registry entry changed for ${target}`);
  } else {
    console.log(`[lane-close] parked ${changed} registry entr${changed === 1 ? "y" : "ies"} for ${target}`);
  }
  return changed;
}

function main(): number {
  const rawArgs = process.argv.slice(2);
  const force = rawArgs.includes("--force");
  const forceDirty = rawArgs.includes("--force-dirty");
  const park = rawArgs.includes("--park");
  const args = rawArgs.filter((arg) => arg !== "--force" && arg !== "--force-dirty" && arg !== "--park");
  if (!args.length) {
    console.log("usage: pnpm lane:close <worktree-path> [branch] [--force] [--force-dirty] | --sweep [--force-dirty] | --park <lane|worktree|branch>");
    return 2;
  }
  if (!assertPrimaryCwd()) return 1;
  if (!acquireIntegratorLock()) return 1;
  try {
    if (park) {
      parkLane(args[0]);
    } else if (args[0] !== "--sweep") {
      const wt = args[0].replace(/\\/g, "/");
      const requestedBranch = args[1];
      if (!passesDirtyGuard(wt, forceDirty)) return 1;
      const mergeCheck = verifyLaneBranchMerged(wt, force);
      if (!mergeCheck.ok) return 1;
      const branch = requestedBranch ?? mergeCheck.branch;
      if (requestedBranch && requestedBranch !== mergeCheck.branch) {
        console.log(`[lane-close] requested branch ${requestedBranch} differs from checked-out branch ${mergeCheck.branch}; using checked-out branch`);
      }
      try {
        sweepComposeProject(wt);
        sh(`git worktree remove "${wt}" --force`);
        console.log(`[lane-close] worktree removed: ${wt}`);
      } catch (e) {
        console.log(`[lane-close] worktree remove failed (${(e as Error).message.split("\n")[0]}) — continuing`);
      }
      if (branch) {
        deleteBranchIfMergedToMaster(branch);
      }
      sh("git worktree prune");
      if (fs.existsSync(wt) && !tryRm(wt)) {
        console.log(`[lane-close] LOCKED ${wt} — close the terminal/process inside it, then: pnpm lane:close --sweep`);
      } else if (!fs.existsSync(wt)) {
        console.log(`[lane-close] folder gone: ${wt}`);
      }
      pruneLaneRegistry(wt, branch);
      archiveLaneDebris(laneFromBranch(branch) ?? laneFromWorktree(wt));
    }
    const locked = !park && args[0] === "--sweep" ? sweep(forceDirty) : 0;
    try {
      sh("npx tsx tools/src/sessions-sync.ts --write");
      console.log("[lane-close] roster synced");
    } catch {
      console.log("[lane-close] roster sync failed — run sessions-sync manually");
    }
    return locked ? 1 : 0;
  } finally {
    releaseIntegratorLock();
  }
}

process.exit(main());

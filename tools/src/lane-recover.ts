/**
 * lane-recover — rebuild a lost/empty tools/_lanes/lanes.json from disk truth.
 *
 * WHY (masterplan 1.2, mechanizes orchestration-mechanics.md recovery runbook):
 * when lanes.json is lost/corrupt, the roster used to be reconstructed by hand —
 * `git worktree list` for the `codex/*` worktrees, then grepping
 * the `~/.codex/sessions` rollout JSONLs for the `session_meta` whose `cwd`
 * matches each worktree to recover its `thread_id`. This tool does exactly that,
 * DIFF-BEFORE-WRITE: with no flag it prints the proposed lanes.json diff vs the
 * current file and writes NOTHING (exit 0); with `--apply` it commits the rebuild
 * through `updateLaneRegistry` so `auditLaneRegistry` reconciles the result to disk
 * (entries with no branch AND no worktree are dropped).
 *
 * Rollout header shape (CONFIRMED against a real file, 2026-07-09): each rollout's
 * first line is `{"type":"session_meta","payload":{"id":"<thread_id>","cwd":"<abs>",…}}`
 * — `cwd` and the thread `id` both live under `payload`, NOT at top level. The parser
 * tolerates a top-level `cwd`/`id` too, in case the platform shape shifts.
 *
 * Usage:
 *   pnpm lane:recover               # print the diff, write nothing (exit 0)
 *   pnpm lane:recover --apply       # write the rebuilt lanes.json
 *   pnpm lane:recover --root <dir>  # override primary repo (default: the game repo root)
 */
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import { gameRoot } from "./toolkit-config.js";
import { execFileSync } from "node:child_process";
import {
  lanesJsonPath,
  makeLaneEntry,
  readLaneRegistry,
  updateLaneRegistry,
  type LaneEntry,
} from "./lane-registry";

const DEFAULT_ROOT = (process.env.LANE_RECOVER_PRIMARY_ROOT ?? gameRoot()).replace(/\\/g, "/").replace(/\/+$/, "");

type Args = { apply: boolean; root: string };

function parseArgs(argv: string[]): Args {
  let apply = false;
  let root = DEFAULT_ROOT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--root") root = (argv[++i] ?? root).replace(/\\/g, "/").replace(/\/+$/, "");
  }
  return { apply, root };
}

/** Normalize a filesystem path for cross-worktree comparison (slashes + case). */
function normPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true }).trim();
  }
}

type WorktreeInfo = { worktree: string; branch: string };

/**
 * Parse `git worktree list --porcelain` into codex-lane worktrees. Each record is a
 * `worktree <path>` line followed by an optional `branch refs/heads/<name>` line.
 * Keeps only worktrees whose branch is `codex/*` (the lane branches).
 */
function laneWorktrees(root: string): WorktreeInfo[] {
  const out: WorktreeInfo[] = [];
  let current: { worktree?: string; branch?: string } = {};
  const flush = () => {
    if (current.worktree && current.branch && current.branch.startsWith("codex/")) {
      out.push({ worktree: current.worktree.replace(/\\/g, "/"), branch: current.branch });
    }
    current = {};
  };
  for (const line of git(root, ["worktree", "list", "--porcelain"]).split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current.worktree = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (line.trim() === "") {
      flush();
    }
  }
  flush();
  return out;
}

/**
 * Walk ~/.codex/sessions once and build a map from normalized cwd -> newest
 * (by rollout mtime) session thread_id. Reuses the imagegen-extract walker shape.
 * Reads ONLY each rollout's first line (the session_meta header) for speed.
 */
async function buildCwdToThreadIndex(): Promise<Map<string, string>> {
  const root = path.join(os.homedir(), ".codex", "sessions");
  const index = new Map<string, string>();
  if (!existsSync(root)) return index;

  const rollouts: { p: string; mtime: number }[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (name.startsWith("rollout-") && name.endsWith(".jsonl")) rollouts.push({ p: full, mtime: st.mtimeMs });
    }
  };
  walk(root);
  // Oldest first so a newer rollout for the same cwd overwrites the older thread_id.
  rollouts.sort((a, b) => a.mtime - b.mtime);

  for (const { p } of rollouts) {
    const header = await readFirstLine(p);
    if (!header) continue;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(header) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (evt.type !== "session_meta") continue;
    const payload = (evt.payload ?? {}) as Record<string, unknown>;
    // CONFIRMED shape: cwd + id under payload. Tolerate top-level fallbacks.
    const cwd = typeof payload.cwd === "string" ? payload.cwd : typeof evt.cwd === "string" ? evt.cwd : "";
    const threadId = typeof payload.id === "string" ? payload.id : typeof evt.id === "string" ? evt.id : "";
    if (!cwd || !threadId) continue;
    index.set(normPath(cwd), threadId);
  }
  return index;
}

function readFirstLine(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }) });
    let done = false;
    rl.on("line", (line) => {
      if (done) return;
      done = true;
      resolve(line);
      rl.close();
    });
    rl.on("close", () => {
      if (!done) resolve(null);
    });
    rl.on("error", () => {
      if (!done) {
        done = true;
        resolve(null);
      }
    });
  });
}

function laneNameFromBranch(branch: string): string {
  const m = /^codex\/card-(.+)$/.exec(branch);
  if (m) return m[1];
  // Fall back to the last path segment of the worktree-style branch name.
  return branch.replace(/^codex\//, "");
}

/**
 * Merge a freshly-derived entry with any existing registry entry for the same lane,
 * preserving the richer existing state (state, box counts, timestamps, acked events)
 * and only filling in a recovered thread_id when the existing one is null.
 */
function mergeEntry(fresh: LaneEntry, existing: LaneEntry | undefined): LaneEntry {
  if (!existing) return fresh;
  return {
    ...existing,
    branch: fresh.branch,
    worktree: fresh.worktree,
    engine: existing.engine,
    thread_id: existing.thread_id ?? fresh.thread_id,
  };
}

function buildProposed(root: string, cwdIndex: Map<string, string>): LaneEntry[] {
  const existing = readLaneRegistry(root);
  const byLane = new Map(existing.map((e) => [e.lane, e]));
  const worktrees = laneWorktrees(root);
  const proposed: LaneEntry[] = [];
  for (const wt of worktrees) {
    const lane = laneNameFromBranch(wt.branch);
    const threadId = cwdIndex.get(normPath(wt.worktree)) ?? null;
    const prior = byLane.get(lane);
    const fresh = makeLaneEntry({
      root,
      lane,
      branch: wt.branch,
      worktree: wt.worktree,
      // A recovered thread_id implies a codex-driven session; agent lanes stay agent.
      engine: prior?.engine ?? (threadId ? "codex" : "agent"),
      threadId,
      card: prior?.card ?? path.posix.join("docs", "tasks", `card-${lane}.md`),
      state: prior?.state,
    });
    proposed.push(mergeEntry(fresh, prior));
  }
  return proposed.sort((a, b) => a.lane.localeCompare(b.lane));
}

function summarizeEntry(e: LaneEntry): string {
  return `${e.lane} [${e.engine}] branch=${e.branch} thread=${e.thread_id ?? "null"} state=${e.state} wt=${e.worktree}`;
}

/** Human-readable line diff of the registry contents keyed by lane. */
function printDiff(current: LaneEntry[], proposed: LaneEntry[]): { added: number; removed: number; changed: number } {
  const cur = new Map(current.map((e) => [e.lane, e]));
  const next = new Map(proposed.map((e) => [e.lane, e]));
  const lanes = [...new Set([...cur.keys(), ...next.keys()])].sort();
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const lane of lanes) {
    const a = cur.get(lane);
    const b = next.get(lane);
    if (a && !b) {
      removed++;
      console.log(`- ${summarizeEntry(a)}`);
    } else if (!a && b) {
      added++;
      console.log(`+ ${summarizeEntry(b)}`);
    } else if (a && b) {
      const sa = summarizeEntry(a);
      const sb = summarizeEntry(b);
      if (sa !== sb) {
        changed++;
        console.log(`- ${sa}`);
        console.log(`+ ${sb}`);
      }
    }
  }
  return { added, removed, changed };
}

async function main(): Promise<number> {
  const { apply, root } = parseArgs(process.argv.slice(2).filter((a) => a !== "--"));
  if (!existsSync(root)) {
    console.error(`[lane-recover] primary root not found: ${root}`);
    return 1;
  }
  const current = readLaneRegistry(root);
  const cwdIndex = await buildCwdToThreadIndex();
  const proposed = buildProposed(root, cwdIndex);

  console.log(`[lane-recover] primary=${root}`);
  console.log(`[lane-recover] rollout cwd->thread entries indexed: ${cwdIndex.size}`);
  console.log(`[lane-recover] current lanes: ${current.length} -> proposed: ${proposed.length}`);
  console.log(`[lane-recover] lanes.json: ${lanesJsonPath(root)}`);
  console.log("[lane-recover] diff (current -> proposed):");
  const { added, removed, changed } = printDiff(current, proposed);
  if (!added && !removed && !changed) console.log("[lane-recover]   (no changes)");
  else console.log(`[lane-recover] summary: +${added} -${removed} ~${changed}`);

  if (!apply) {
    console.log("[lane-recover] DIFF-ONLY (no --apply): wrote nothing.");
    return 0;
  }

  const written = updateLaneRegistry(root, () => proposed);
  console.log(`[lane-recover] APPLIED: lanes.json rebuilt with ${written.length} entr${written.length === 1 ? "y" : "ies"}.`);
  return 0;
}

// Only auto-run when invoked as a script (not when imported by the test suite).
if (process.argv[1] && /lane-recover\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) {
  main().then((code) => process.exit(code));
}

export { buildProposed, buildCwdToThreadIndex, laneWorktrees, parseArgs, main };

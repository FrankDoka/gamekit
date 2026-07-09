/**
 * lanes-board — read-only snapshot of active orchestration lanes.
 *
 * Usage:
 *   pnpm lanes:board
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { countCardBoxes, readLaneRegistry } from "./lane-registry";
import type { LaneEntry } from "./lane-registry";
import { detectDeadLane, laneEventFiles, markDeadLaneBlocked } from "./lanes-dead";

const ROOT = process.cwd();

interface BoardRow {
  source: string;
  lane: string;
  branch: string;
  engine: string;
  state: string;
  tail: string;
  ahead: string;
  dirty: string;
  gates: string;
  lastCommitAge: string;
}

/** What the lane's OWN event stream says its life ended with — the registry
 * `state` only records what the integrator last wrote, and three finished
 * lanes sat masked as "working" on 2026-07-04 (READY acked-but-unread, token
 * exhaustion with no final message, closeout without a READY prefix).
 * `…` = mid-turn; READY/BLOCKED = self-reported; ENDED = turn over, LOOK. */
function tailStatus(lane: string): string {
  let lastMsg: string | null = null;
  let lastType: string | null = null;
  for (const file of laneEventFiles(ROOT, lane)) {
    let text: string;
    try {
      text = readFileSync(file.path, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const evt = JSON.parse(trimmed) as { type?: string; item?: { type?: string; text?: string } };
        lastType = evt.type ?? lastType;
        if (evt.type === "thread.started" || evt.type === "turn.started") lastMsg = null;
        if (evt.type === "item.completed" && evt.item?.type === "agent_message" && typeof evt.item.text === "string") {
          lastMsg = evt.item.text;
        }
      } catch {
        // Ignore partial JSONL writes.
      }
    }
  }
  if (lastType === null) return "-";
  if (lastType !== "turn.completed") return "…";
  if (!lastMsg) return "ENDED(no-msg)";
  const head = lastMsg.trimStart().slice(0, 40).toUpperCase();
  if (head.startsWith("READY")) return "READY";
  if (head.startsWith("BLOCKED")) return "BLOCKED";
  return "ENDED(msg)";
}

/**
 * Agent lanes write no JSONL, so tailStatus() would always show a bare "-".
 * Derive a first-class tail from signals we DO have: gate boxes + branch commits
 * ahead of master. READY = all boxes checked; WORKING = has commits or partial
 * boxes; SPAWNED = nothing yet. The registry `state` column still carries the
 * authoritative stalled/blocked verdict written by the watcher.
 */
function agentTail(lane: string, branch: string): string {
  const counts = countCardBoxes(ROOT, `docs/tasks/card-${lane}.md`);
  if (counts.total > 0 && counts.checked >= counts.total) return "READY";
  const ahead = Number(aheadOfMaster(branch));
  if (Number.isFinite(ahead) && ahead > 0) return "WORKING";
  if (counts.checked > 0) return "WORKING";
  return "SPAWNED";
}

function shOk(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function worktrees(): { worktree: string; branch: string }[] {
  const out = shOk(ROOT, ["worktree", "list", "--porcelain"]) ?? "";
  const rows: { worktree: string; branch: string }[] = [];
  let current: { worktree: string; branch: string } | null = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) rows.push(current);
      current = { worktree: line.slice("worktree ".length).replace(/\\/g, "/"), branch: "" };
    } else if (current && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    }
  }
  if (current) rows.push(current);
  return rows.filter((row) => row.branch.startsWith("codex/"));
}

function laneFromBranch(branch: string): string {
  const m = /^codex\/card-(.+)$/.exec(branch);
  return m ? m[1] : branch.replace(/^codex\//, "").replace(/[^\w.-]+/g, "-");
}

function laneFromWorktree(worktree: string): string {
  const base = worktree.replace(/\\/g, "/").split("/").pop() ?? worktree;
  return base.replace(/^gamekit-/, "");
}

function gateSummary(lane: string): string {
  const counts = countCardBoxes(ROOT, `docs/tasks/card-${lane}.md`);
  return `${counts.checked}/${counts.total}`;
}

function aheadOfMaster(branch: string): string {
  return shOk(ROOT, ["rev-list", "--count", `master..${branch}`]) ?? "n/a";
}

function dirty(worktree: string): string {
  if (!existsSync(worktree)) return "n/a";
  const out = shOk(worktree, ["status", "--short"]);
  if (out === null) return "n/a";
  return out ? "yes" : "no";
}

function lastCommitAge(branch: string): string {
  const unix = shOk(ROOT, ["log", "-1", "--format=%ct", branch]);
  if (!unix) return "n/a";
  const ageMs = Date.now() - Number(unix) * 1000;
  if (!Number.isFinite(ageMs) || ageMs < 0) return "n/a";
  const mins = Math.floor(ageMs / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function printTable(rows: BoardRow[]): void {
  const headers = ["source", "lane", "branch", "engine", "state", "tail", "ahead", "dirty", "gates", "last-commit"];
  const body = rows.map((r) => [r.source, r.lane, r.branch, r.engine, r.state, r.tail, r.ahead, r.dirty, r.gates, r.lastCommitAge]);
  const widths = headers.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(fmt(headers));
  console.log(fmt(widths.map((w) => "-".repeat(w))));
  for (const row of body) console.log(fmt(row));
}

function main(): number {
  let entries: LaneEntry[] = [];
  try {
    entries = readLaneRegistry(ROOT);
  } catch (error) {
    console.error(`[lanes-board] ${(error as Error).message}`);
    return 1;
  }
  const byKey = new Map<string, BoardRow>();
  const deadByLane = new Map<string, ReturnType<typeof detectDeadLane>>();

  for (const wt of worktrees()) {
    const lane = laneFromBranch(wt.branch) || laneFromWorktree(wt.worktree);
    const dead = detectDeadLane(ROOT, { lane, branch: wt.branch, worktree: wt.worktree });
    if (dead) deadByLane.set(lane, dead);
    byKey.set(`${lane}|${wt.branch}`, {
      source: "worktree",
      lane,
      branch: wt.branch,
      engine: "unknown",
      state: dead ? `DEAD(${dead.reason})` : "unknown",
      tail: tailStatus(lane),
      ahead: aheadOfMaster(wt.branch),
      dirty: dirty(wt.worktree),
      gates: gateSummary(lane),
      lastCommitAge: lastCommitAge(wt.branch),
    });
  }

  for (const entry of entries) {
    const dead = deadByLane.get(entry.lane) ?? detectDeadLane(ROOT, entry);
    if (dead) {
      deadByLane.set(entry.lane, dead);
      entries = markDeadLaneBlocked(ROOT, entries, dead);
    }
    const key = `${entry.lane}|${entry.branch}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.source = "worktree+registry";
      existing.engine = entry.engine;
      existing.state = dead ? `DEAD(${dead.reason})` : entry.state;
      existing.gates = `${entry.boxes_checked}/${entry.boxes_total}`;
      // Agent lanes have no JSONL — replace the bare "-" tail with a derived one.
      if (entry.engine === "agent" && (existing.tail === "-" || existing.tail === "")) {
        existing.tail = agentTail(entry.lane, entry.branch);
      }
      continue;
    }
    byKey.set(key, {
      source: "registry",
      lane: entry.lane,
      branch: entry.branch,
      engine: entry.engine,
      state: dead ? `DEAD(${dead.reason})` : entry.state,
      tail: entry.engine === "agent" ? agentTail(entry.lane, entry.branch) : tailStatus(entry.lane),
      ahead: aheadOfMaster(entry.branch),
      dirty: dirty(entry.worktree),
      gates: `${entry.boxes_checked}/${entry.boxes_total}`,
      lastCommitAge: lastCommitAge(entry.branch),
    });
  }

  const rows = [...byKey.values()].sort((a, b) => a.lane.localeCompare(b.lane));
  if (!rows.length) {
    console.log("(no codex lanes)");
    return 0;
  }
  printTable(rows);
  return 0;
}

process.exit(main());

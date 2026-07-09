/**
 * lanes-watch — mechanizes the Integrator Conductor Loop's watcher ritual
 * (docs/architecture/ai-architecture.md "The Integrator Conductor Loop" §3).
 *
 * Usage:
 *   pnpm lanes:watch [--interval 30] [--timeout-mins 240] [--stall-mins 45] [--events ready]
 *
 * Single foreground process that polls, every `--interval` seconds:
 *   (a) every codex/* branch tip (git for-each-ref) for a commit change,
 *   (b) every lanes.json codex lane's JSONL for new turn.completed/turn.failed events,
 *   (c) `git worktree list` for worktree appearances/disappearances,
 *   (d) every lanes.json AGENT lane (which writes no JSONL) for a stall: branch
 *       tip unmoved past its baseline AND updated_at heartbeat older than the
 *       stall window (E1 fix — agent-lane lifecycle parity).
 *
 * On ANY event: print ONE structured line `EVENT <kind> <lane/branch> <detail>` and
 * EXIT 0 (the orchestrator's harness notifies on exit; re-arm by re-running). On
 * timeout with no events: print a TIMEOUT line and EXIT 1.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gameRoot } from "./toolkit-config.js";
import { acknowledgeLaneEvents, lanesJsonPath, readLaneRegistry, refreshLaneBoxes, setLaneState, updateLaneRegistry } from "./lane-registry";
import type { LaneEntry } from "./lane-registry";
import { detectDeadLane, detectUnseenCompletedTurn, laneEventCounts, laneEventFiles, markDeadLaneBlocked } from "./lanes-dead";

const ROOT = process.cwd();
const PRIMARY_ROOT = process.env.LANES_WATCH_PRIMARY_ROOT ?? gameRoot();
const LANES_JSON = lanesJsonPath(ROOT);
// Context exhaustion is documented in ai-architecture.md §6c(l); warn before
// resumes fail from an overfull thread.
const CONTEXT_PRESSURE_INPUT_TOKENS = 6_000_000;

type EventsMode = "all" | "ready";

function parseArgs(argv: string[]): { intervalSec: number; timeoutMins: number; stallMins: number; eventsMode: EventsMode } {
  let intervalSec = 30;
  let timeoutMins = 240;
  let stallMins = 45;
  let eventsMode: EventsMode = "all";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--interval") intervalSec = Number(argv[++i]);
    else if (a === "--timeout-mins") timeoutMins = Number(argv[++i]);
    else if (a === "--stall-mins") stallMins = Number(argv[++i]);
    else if (a === "--events") {
      const value = argv[++i];
      if (value !== "ready") throw new Error(`--events must be "ready", got ${value}`);
      eventsMode = value;
    }
  }
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
    throw new Error(`--interval must be a positive number, got ${intervalSec}`);
  }
  if (!Number.isFinite(timeoutMins) || timeoutMins <= 0) {
    throw new Error(`--timeout-mins must be a positive number, got ${timeoutMins}`);
  }
  if (!Number.isFinite(stallMins) || stallMins <= 0) {
    throw new Error(`--stall-mins must be a positive number, got ${stallMins}`);
  }
  return { intervalSec, timeoutMins, stallMins, eventsMode };
}

/** Runs git, swallowing failures (and their stderr noise) — used for lookups that are
 * expected to fail routinely, e.g. a branch named in lanes.json that hasn't landed yet. */
function shOk(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function assertPrimaryCwd(): boolean {
  const primary = (() => {
    try {
      return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: PRIMARY_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  })();
  const current = shOk(["rev-parse", "--show-toplevel"]);
  if (!primary || !current || normalizePath(primary) !== normalizePath(current)) {
    console.error("[lanes-watch] BLOCKED: lanes-watch writes the lane registry and must run from the primary repo worktree.");
    console.error(`[lanes-watch] primary=${primary ?? "(unresolved)"}`);
    console.error(`[lanes-watch] current=${current ?? "(unresolved)"}`);
    return false;
  }
  return true;
}

function codexBranches(): string[] {
  const out = shOk(["for-each-ref", "--format=%(refname:short)", "refs/heads/codex/"]);
  return out ? out.split("\n").filter(Boolean) : [];
}

function branchTip(branch: string): string {
  return shOk(["rev-parse", branch]) ?? "none";
}

function laneFromBranch(branch: string): string {
  const m = /^codex\/card-(.+)$/.exec(branch);
  return m ? m[1] : branch.replace(/^codex\//, "").replace(/[^\w.-]+/g, "-");
}

function openGateBoxesForLane(lane: string): number {
  const cardPath = join(ROOT, "docs", "tasks", `card-${lane}.md`);
  if (!existsSync(cardPath)) return 1;
  try {
    const card = readFileSync(cardPath, "utf8");
    const matches = card.match(/^\s*-\s+\[\s\]/gm);
    return matches ? matches.length : 0;
  } catch {
    return 1;
  }
}

function refreshRegistryBoxes(entries: LaneEntry[]): { entries: LaneEntry[]; changedLanes: Set<string>; persisted: boolean } {
  const changedLanes = new Set<string>();
  const now = new Date().toISOString();
  const next = entries.map((entry) => {
    const refreshed = refreshLaneBoxes(ROOT, entry, now);
    if (refreshed.changed) {
      changedLanes.add(entry.lane);
    }
    return refreshed.entry;
  });
  if (changedLanes.size || (existsSync(LANES_JSON) && JSON.stringify(next) !== JSON.stringify(entries))) {
    const updated = updateLaneRegistry(ROOT, (fresh) =>
      fresh.map((entry) => {
        const refreshed = refreshLaneBoxes(ROOT, entry, now);
        return refreshed.entry;
      }),
    );
    return { entries: updated, changedLanes, persisted: true };
  }
  return { entries: next, changedLanes, persisted: false };
}

function setContextWarned(entries: LaneEntry[], laneName: string): LaneEntry[] {
  if (!entries.some((entry) => entry.lane === laneName && !entry.context_warned)) return entries;
  return updateLaneRegistry(ROOT, (fresh) => {
    const now = new Date().toISOString();
    return fresh.map((entry) => {
      if (entry.lane !== laneName || entry.context_warned) return entry;
      return { ...entry, context_warned: true, updated_at: now };
    });
  });
}

function laneEntryForBranch(entries: LaneEntry[], branch: string): LaneEntry | undefined {
  const lane = laneFromBranch(branch);
  return entries.find((entry) => entry.branch === branch || entry.lane === lane);
}

function worktreeList(): string[] {
  const out = shOk(["worktree", "list", "--porcelain"]) ?? "";
  return out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim());
}

type TerminalEvent = {
  kind: "turn.completed" | "turn.failed";
  detail: string;
  inputTokens: number | null;
};

function inputTokensFromEvent(evt: Record<string, unknown>): number | null {
  const usage = evt.usage;
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  const value = record.input_tokens ?? record.inputTokens;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Scan a lane's JSONL file for turn.completed/turn.failed events beyond a known offset. */
function newTerminalEvents(
  path: string,
  seenCount: number,
): { events: TerminalEvent[]; nextSeen: number; rotated: boolean } {
  const empty = { events: [], nextSeen: seenCount, rotated: false };
  if (!existsSync(path)) return empty;
  const text = readFileSync(path, "utf8");
  const parsed: Record<string, unknown>[] = [];
  const found: TerminalEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      parsed.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // ignore malformed line
    }
  }
  const rotated = parsed.length < seenCount;
  const start = rotated ? 0 : seenCount;
  for (let i = start; i < parsed.length; i++) {
    try {
      const evt = parsed[i];
      if (evt.type === "turn.completed" || evt.type === "turn.failed") {
        found.push({ kind: evt.type, detail: JSON.stringify(evt).slice(0, 200), inputTokens: inputTokensFromEvent(evt) });
      }
    } catch {
      // ignore malformed line
    }
  }
  return { events: found, nextSeen: parsed.length, rotated };
}

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function main(): number {
  const { intervalSec, timeoutMins, stallMins, eventsMode } = parseArgs(process.argv.slice(2));
  if (!assertPrimaryCwd()) return 1;
  const iterations = Math.ceil((timeoutMins * 60) / intervalSec);
  const stallMs = stallMins * 60 * 1000;

  let laneEntries: LaneEntry[];
  try {
    laneEntries = readLaneRegistry(ROOT);
  } catch (error) {
    console.error(`[lanes-watch] BLOCKED: ${(error as Error).message}`);
    return 1;
  }
  const initialRefresh = refreshRegistryBoxes(laneEntries);
  laneEntries = initialRefresh.entries;
  const codexLanes = laneEntries.filter((l) => l.engine === "codex");
  // Agent lanes write NO events JSONL (lane-spawn --engine agent records the
  // entry but launches no process), so the JSONL-based dead/unseen paths above
  // cannot see them. They are watched on branch-tip + heartbeat signals instead
  // (agent-lane stall sweep below). This is ADDITIVE — codex behaviour is
  // unchanged; the JSONL loops keep iterating codexLanes only.
  const agentLaneNames = new Set(laneEntries.filter((l) => l.engine === "agent").map((l) => l.lane));

  for (const lane of codexLanes) {
    const dead = detectDeadLane(ROOT, lane);
    if (dead) {
      laneEntries = markDeadLaneBlocked(ROOT, laneEntries, dead);
      console.log(`EVENT dead-lane ${lane.lane} ${dead.reason}`);
      return 0;
    }
    const unseen = detectUnseenCompletedTurn(ROOT, lane);
    if (unseen) {
      laneEntries = acknowledgeLaneEvents(ROOT, lane.lane, laneEventCounts(ROOT, lane.lane));
      console.log(`EVENT unseen-turn ${lane.lane} ${unseen.inputTokens ?? "unknown"}`);
      return 0;
    }
  }

  // Baseline branch tips: every codex/* branch that exists now, plus every branch
  // named in lanes.json (baseline "none" catches not-yet-created branches so
  // queued-but-unspawned lanes fire on branch CREATION).
  const branchSet = new Set<string>([...codexBranches(), ...laneEntries.map((l) => l.branch)]);
  const baseTips = new Map<string, string>();
  for (const br of branchSet) baseTips.set(br, branchTip(br));
  const lastChangedAt = new Map<string, number>();
  for (const br of branchSet) lastChangedAt.set(br, Date.now());
  const lastBoxChangedAt = new Map<string, number>();
  for (const entry of laneEntries) lastBoxChangedAt.set(entry.lane, Date.now());

  // Baseline JSONL line counts per codex lane.
  const baseLineCounts = new Map<string, Record<string, number>>();
  for (const lane of codexLanes) {
    baseLineCounts.set(lane.lane, laneEventCounts(ROOT, lane.lane));
  }

  // Baseline worktree set.
  let baseWorktrees = new Set(worktreeList());

  console.log(
    `[lanes-watch] armed: ${branchSet.size} branch(es), ${codexLanes.length} codex JSONL(s), ${agentLaneNames.size} agent lane(s), ${baseWorktrees.size} worktree(s); interval=${intervalSec}s timeout=${timeoutMins}m stall=${stallMins}m events=${eventsMode}`,
  );

  for (let i = 0; i < iterations; i++) {
    sleepSync(intervalSec * 1000);

    // (a) branch tip changes
    for (const br of branchSet) {
      const cur = branchTip(br);
      if (cur !== baseTips.get(br)) {
        const lane = laneFromBranch(br);
        const entryBeforeUpdate = laneEntryForBranch(laneEntries, br);
        laneEntries = setLaneState(ROOT, laneEntries, lane, "working");
        console.log(`EVENT branch-change ${br} ${baseTips.get(br)}->${cur}`);
        baseTips.set(br, cur);
        lastChangedAt.set(br, Date.now());
        if (eventsMode === "ready" && entryBeforeUpdate && entryBeforeUpdate.state !== "ready") {
          continue;
        }
        return 0;
      }
    }

    // (b) codex JSONL terminal events
    for (const lane of codexLanes) {
      const laneCounts = baseLineCounts.get(lane.lane) ?? {};
      for (const file of laneEventFiles(ROOT, lane.lane)) {
        const seen = laneCounts[file.basename] ?? 0;
        const result = newTerminalEvents(file.path, seen);
        laneCounts[file.basename] = result.nextSeen;
        baseLineCounts.set(lane.lane, laneCounts);
        if (result.rotated) {
          console.log(`EVENT jsonl-rotated ${lane.lane} ${file.basename} seen-reset=${seen}->0`);
          return 0;
        }
        if (result.events.length) {
          laneEntries = acknowledgeLaneEvents(ROOT, lane.lane, { [file.basename]: result.nextSeen });
          const pressure = result.events.find(
            (e) => e.kind === "turn.completed" && e.inputTokens !== null && e.inputTokens > CONTEXT_PRESSURE_INPUT_TOKENS,
          );
          const currentEntry = laneEntries.find((entry) => entry.lane === lane.lane);
          if (pressure?.inputTokens !== undefined && pressure.inputTokens !== null && !currentEntry?.context_warned) {
            laneEntries = setContextWarned(laneEntries, lane.lane);
            console.log(`EVENT context-pressure ${lane.lane} input=${pressure.inputTokens}`);
            return 0;
          }
          const e = result.events[0];
          laneEntries = setLaneState(ROOT, laneEntries, lane.lane, e.kind === "turn.failed" ? "blocked" : "working");
          console.log(`EVENT ${e.kind} ${lane.lane} ${e.detail}`);
          return 0;
        }
      }
    }

    const refreshed = refreshRegistryBoxes(laneEntries);
    laneEntries = refreshed.entries;
    const now = Date.now();
    for (const lane of refreshed.changedLanes) lastBoxChangedAt.set(lane, now);
    for (const entry of laneEntries) {
      const openBoxes = Math.max(0, entry.boxes_total - entry.boxes_checked);
      if (openBoxes <= 0) continue;
      const staleFor = now - (lastBoxChangedAt.get(entry.lane) ?? now);
      if (staleFor >= stallMs) {
        laneEntries = setLaneState(ROOT, laneEntries, entry.lane, "stalled");
        console.log(`EVENT stall ${entry.lane} open-boxes=${openBoxes} box-stale-mins=${Math.floor(staleFor / 60000)}`);
        return 0;
      }
    }

    // Agent-lane stall sweep (E1 fix): agent lanes emit NO JSONL, so the codex
    // dead/unseen paths never see them. An agent lane is STALLED when its branch
    // tip has NOT moved past its spawn/reviewed baseline AND its updated_at
    // heartbeat is older than the stall window. The heartbeat age is read from
    // the PERSISTED updated_at (not the watcher's runtime clock), so a lane that
    // was already stale before this watcher armed fires within ONE sweep. Guarded
    // on engine === "agent" — codex behaviour is untouched.
    for (const entry of laneEntries) {
      if (!agentLaneNames.has(entry.lane)) continue;
      if (entry.state === "ready" || entry.state === "closed" || entry.state === "blocked" || entry.state === "stalled") continue;
      const cur = branchTip(entry.branch);
      const baseline = entry.reviewed_tip ?? baseTips.get(entry.branch) ?? "none";
      if (cur !== baseline && cur !== "none") continue; // branch advanced past baseline → progress, not stalled
      const heartbeat = Date.parse(entry.updated_at);
      const heartbeatAge = Number.isFinite(heartbeat) ? now - heartbeat : 0;
      if (heartbeatAge < stallMs) continue;
      const openBoxes = Math.max(0, entry.boxes_total - entry.boxes_checked);
      laneEntries = setLaneState(ROOT, laneEntries, entry.lane, "stalled");
      console.log(
        `EVENT stall ${entry.lane} agent-lane quiet ${Math.floor(heartbeatAge / 60000)}min, no branch commit open-boxes=${openBoxes}`,
      );
      return 0;
    }

    // Legacy fallback for codex/* branches not present in lanes.json yet.
    for (const br of branchSet) {
      const cur = branchTip(br);
      const quietFor = Date.now() - (lastChangedAt.get(br) ?? Date.now());
      if (cur !== "none" && quietFor >= stallMs) {
        const lane = laneFromBranch(br);
        const openBoxes = openGateBoxesForLane(lane);
        if (openBoxes > 0) {
          console.log(`EVENT stall ${lane} open-boxes=${openBoxes} quiet-mins=${Math.floor(quietFor / 60000)}`);
          return 0;
        }
      }
    }

    // (c) worktree list changes
    const curWorktrees = new Set(worktreeList());
    for (const w of curWorktrees) {
      if (!baseWorktrees.has(w)) {
        console.log(`EVENT worktree-added ${w} appeared`);
        return 0;
      }
    }
    for (const w of baseWorktrees) {
      if (!curWorktrees.has(w)) {
        console.log(`EVENT worktree-removed ${w} disappeared`);
        return 0;
      }
    }
    baseWorktrees = curWorktrees;
  }

  console.log(`TIMEOUT ${timeoutMins}m: no lane events`);
  return 1;
}

process.exit(main());

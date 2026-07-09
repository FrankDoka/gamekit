import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { lanesDir, setLaneState } from "./lane-registry";
import type { LaneEntry } from "./lane-registry";

export type DeadLaneProbe = {
  lane: string;
  branch: string;
  worktree?: string;
};

export type DeadLaneDetection = {
  lane: string;
  reason: string;
  detail: string;
  eventLine: number;
  eventsPath: string;
};

export type UnseenTurnDetection = {
  lane: string;
  inputTokens: number | null;
  eventLine: number;
  eventsPath: string;
};

export type LaneEventFile = {
  path: string;
  basename: string;
};

function shOk(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function messageFromEvent(evt: Record<string, unknown>): string {
  const direct = evt.message;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const error = evt.error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return JSON.stringify(evt).slice(0, 200);
}

export function deadLaneReason(message: string): string {
  const normalized = message.toLowerCase();
  if (/\b(usage limit|quota|credits?)\b/.test(normalized)) return "usage-limit";
  return message.replace(/\s+/g, " ").trim().slice(0, 40) || "failed";
}

export function laneEventFiles(root: string, lane: string): LaneEventFile[] {
  const dir = lanesDir(root);
  if (!existsSync(dir)) return [];
  const prefix = `${lane}-events.jsonl`;
  return readdirSync(dir)
    .filter((name) => name === prefix || name.startsWith(`${prefix}.`))
    .sort()
    .map((name) => ({ path: join(dir, name), basename: name }));
}

export function countParsedEvents(path: string): number {
  if (!existsSync(path)) return 0;
  let count = 0;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
      count++;
    } catch {
      // Ignore partial JSONL writes.
    }
  }
  return count;
}

export function laneEventCounts(root: string, lane: string): Record<string, number> {
  return Object.fromEntries(laneEventFiles(root, lane).map((file) => [file.basename, countParsedEvents(file.path)]));
}

function lastDeadTerminal(files: LaneEventFile[]): { line: number; reason: string; detail: string; eventsPath: string } | null {
  let last: { line: number; type: string; reason: string; detail: string; eventsPath: string } | null = null;
  for (const file of files) {
    if (!existsSync(file.path)) continue;
    const lines = readFileSync(file.path, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const evt = JSON.parse(line) as Record<string, unknown>;
        if (evt.type === "turn.completed" || evt.type === "turn.failed" || evt.type === "error") {
          const message = messageFromEvent(evt);
          last = { line: i + 1, type: String(evt.type), reason: deadLaneReason(message), detail: message, eventsPath: file.path };
        } else if (
          evt.type === "thread.started" || evt.type === "turn.started" ||
          evt.type === "item.started" || evt.type === "item.completed"
        ) {
          // A new thread/turn AFTER a failure means the lane was resumed or
          // respawned — the old failure no longer marks it dead (false-positive
          // fix 2026-07-04: respawned editor-decomp-2 flagged DEAD mid-turn).
          // item.* activity AFTER an error means the stream RECOVERED inside the
          // same turn (false-positive fix 2026-07-04 evening: imagegen-debt-burn
          // wave-3 logged "Reconnecting... 5/5 (stream disconnected" then kept
          // executing items; only an error with NO activity after it is dead).
          if (last && (last.type === "turn.failed" || last.type === "error")) last = null;
        }
      } catch {
        // Ignore partial JSONL writes.
      }
    }
  }
  if (!last || (last.type !== "turn.failed" && last.type !== "error")) return null;
  return { line: last.line, reason: last.reason, detail: last.detail, eventsPath: last.eventsPath };
}

function lastUnseenCompletedTurn(
  eventsPath: string,
  ackedCount: number,
): { line: number; count: number; inputTokens: number | null } | null {
  if (!existsSync(eventsPath)) return null;
  const lines = readFileSync(eventsPath, "utf8").split(/\r?\n/);
  let parsedCount = 0;
  let last: { line: number; count: number; inputTokens: number | null } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const evt = JSON.parse(line) as Record<string, unknown>;
      parsedCount++;
      if (evt.type === "turn.completed") {
        last = { line: i + 1, count: parsedCount, inputTokens: inputTokensFromEvent(evt) };
      } else {
        last = null;
      }
    } catch {
      // Ignore partial JSONL writes.
    }
  }
  if (!last || last.count <= ackedCount) return null;
  return last;
}

function inputTokensFromEvent(evt: Record<string, unknown>): number | null {
  const usage = evt.usage;
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  const value = record.input_tokens ?? record.inputTokens;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function branchHasCommitAfter(cwd: string, branch: string, unixSeconds: number): boolean {
  const latest = shOk(cwd, ["log", "-1", "--format=%ct", branch]);
  if (!latest) return false;
  const latestSeconds = Number(latest);
  return Number.isFinite(latestSeconds) && latestSeconds > unixSeconds;
}

export function detectDeadLane(root: string, probe: DeadLaneProbe): DeadLaneDetection | null {
  const terminal = lastDeadTerminal(laneEventFiles(root, probe.lane));
  if (!terminal) return null;
  const eventMtimeSeconds = statSync(terminal.eventsPath).mtimeMs / 1000;
  const gitCwd = probe.worktree && existsSync(probe.worktree) ? probe.worktree : root;
  if (branchHasCommitAfter(gitCwd, probe.branch, eventMtimeSeconds)) return null;
  return {
    lane: probe.lane,
    reason: terminal.reason,
    detail: terminal.detail,
    eventLine: terminal.line,
    eventsPath: terminal.eventsPath,
  };
}

export function markDeadLaneBlocked(root: string, entries: LaneEntry[], detection: DeadLaneDetection): LaneEntry[] {
  return setLaneState(root, entries, detection.lane, "blocked");
}

export function detectUnseenCompletedTurn(root: string, probe: DeadLaneProbe & Pick<LaneEntry, "state">): UnseenTurnDetection | null {
  // "blocked" also suppresses: an integrator parks a lane as blocked precisely
  // when its last completed turn WAS seen and acted on (e.g. waiting on an
  // owner input) — re-flagging it on every arm is noise (2026-07-04).
  if (probe.state === "ready" || probe.state === "closed" || probe.state === "blocked") return null;
  const acked = "acked_events" in probe ? (probe as Pick<LaneEntry, "acked_events">).acked_events ?? {} : {};
  for (const file of laneEventFiles(root, probe.lane)) {
    const terminal = lastUnseenCompletedTurn(file.path, acked[file.basename] ?? 0);
    if (!terminal) continue;
    const eventMtimeSeconds = statSync(file.path).mtimeMs / 1000;
    const gitCwd = probe.worktree && existsSync(probe.worktree) ? probe.worktree : root;
    if (branchHasCommitAfter(gitCwd, probe.branch, eventMtimeSeconds)) continue;
    return {
      lane: probe.lane,
      inputTokens: terminal.inputTokens,
      eventLine: terminal.line,
      eventsPath: file.path,
    };
  }
  return null;
}

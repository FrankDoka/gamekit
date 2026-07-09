import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export const LANE_STATES = ["spawned", "working", "ready", "merging", "closed", "blocked", "stalled", "parked"] as const;
export type LaneState = (typeof LANE_STATES)[number];

export type LaneEntry = {
  lane: string;
  branch: string;
  worktree: string;
  engine: "codex" | "agent";
  thread_id: string | null;
  state: LaneState;
  card: string;
  boxes_total: number;
  boxes_checked: number;
  reviewed_tip: string | null;
  updated_at: string;
  started_at?: string;
  context_warned?: boolean;
  acked_events?: Record<string, number>;
  /**
   * Optional owner-lease marker (DB-8 prep — a FIELD, not a system). Defaults to
   * null on write; no reader depends on it yet. Persisted through the atomic
   * write + audit path like every other field.
   */
  owner_lease?: string | null;
};

export type GateCounts = {
  checked: number;
  total: number;
};

type RegistryLock = {
  pid: number;
  acquired_at: string;
};

export type LaneRegistryUpdateOptions = {
  log?: Pick<Console, "log" | "warn">;
};

export function lanesDir(root: string): string {
  return join(root, "tools", "_lanes");
}

export function lanesJsonPath(root: string): string {
  return join(lanesDir(root), "lanes.json");
}

function registryLockPath(root: string): string {
  return join(lanesDir(root), ".registry.lock");
}

export function ensureLanesDir(root: string): void {
  const dir = lanesDir(root);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
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

function readRegistryLock(root: string): RegistryLock | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(registryLockPath(root), "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      Number.isInteger((parsed as Record<string, unknown>).pid) &&
      typeof (parsed as Record<string, unknown>).acquired_at === "string"
    ) {
      return parsed as RegistryLock;
    }
  } catch {
    // A corrupt lock cannot prove liveness, so it is treated as stale below.
  }
  return null;
}

function acquireRegistryLock(root: string): void {
  ensureLanesDir(root);
  const lockPath = registryLockPath(root);
  const lock: RegistryLock = { pid: process.pid, acquired_at: new Date().toISOString() };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, JSON.stringify(lock, null, 2) + "\n", "utf8");
      closeSync(fd);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const existing = readRegistryLock(root);
      if (!existing || !pidIsLive(existing.pid)) {
        rmSync(lockPath, { force: true });
        continue;
      }
      sleepSync(100);
    }
  }
  const existing = readRegistryLock(root);
  throw new Error(
    `lane registry lock busy: ${lockPath}${existing ? ` held by pid=${existing.pid} since ${existing.acquired_at}` : ""}`,
  );
}

function releaseRegistryLock(root: string): void {
  const existing = readRegistryLock(root);
  if (!existing || existing.pid !== process.pid) return;
  rmSync(registryLockPath(root), { force: true });
}

function isLaneState(value: unknown): value is LaneState {
  return typeof value === "string" && (LANE_STATES as readonly string[]).includes(value);
}

function normalizeAckedEvents(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key, count]) => key.length > 0 && Number.isInteger(count) && Number(count) >= 0)
    .map(([key, count]) => [key, Number(count)] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function normalizeCardPath(root: string, card: string | undefined, lane: string): string {
  const fallback = join("docs", "tasks", `card-${lane}.md`).replace(/\\/g, "/");
  if (!card) return fallback;
  const normalized = card.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    const rel = relative(root, normalized).replace(/\\/g, "/");
    return rel && !rel.startsWith("..") ? rel : normalized;
  }
  return normalized.replace(/^\.?\//, "");
}

export function countCardBoxes(root: string, card: string): GateCounts {
  const cardPath = /^[A-Za-z]:[\\/]/.test(card) ? card : join(root, card);
  if (!existsSync(cardPath)) return { checked: 0, total: 1 };
  const text = readFileSync(cardPath, "utf8");
  const checked = (text.match(/^\s*-\s+\[[xX]\]/gm) ?? []).length;
  const open = (text.match(/^\s*-\s+\[\s\]/gm) ?? []).length;
  return { checked, total: checked + open };
}

function normalizeLaneEntry(root: string, value: unknown): LaneEntry {
  if (!value || typeof value !== "object") {
    throw new Error("entry is not an object");
  }
  const record = value as Record<string, unknown>;
  const lane = record.lane;
  const branch = record.branch;
  const worktree = record.worktree;
  const engine = record.engine;
  if (typeof lane !== "string" || !lane) throw new Error("entry.lane must be a non-empty string");
  if (typeof branch !== "string" || !branch) throw new Error(`entry ${lane}: branch must be a non-empty string`);
  if (typeof worktree !== "string" || !worktree) throw new Error(`entry ${lane}: worktree must be a non-empty string`);
  if (engine !== "codex" && engine !== "agent") throw new Error(`entry ${lane}: engine must be codex or agent`);

  const card = normalizeCardPath(root, typeof record.card === "string" ? record.card : undefined, lane);
  const counts = countCardBoxes(root, card);
  return {
    lane,
    branch,
    worktree,
    engine,
    thread_id: typeof record.thread_id === "string" ? record.thread_id : null,
    state: isLaneState(record.state) ? record.state : "spawned",
    card,
    boxes_total: Number.isInteger(record.boxes_total) ? Number(record.boxes_total) : counts.total,
    boxes_checked: Number.isInteger(record.boxes_checked) ? Number(record.boxes_checked) : counts.checked,
    reviewed_tip: typeof record.reviewed_tip === "string" ? record.reviewed_tip : null,
    updated_at: typeof record.updated_at === "string" ? record.updated_at : new Date().toISOString(),
    started_at: typeof record.started_at === "string" ? record.started_at : undefined,
    context_warned: record.context_warned === true ? true : undefined,
    acked_events: normalizeAckedEvents(record.acked_events),
    owner_lease: typeof record.owner_lease === "string" ? record.owner_lease : null,
  };
}

export function readLaneRegistry(root: string): LaneEntry[] {
  const path = lanesJsonPath(root);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`corrupt lanes registry ${path}: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`corrupt lanes registry ${path}: expected a JSON array`);
  }
  return parsed.map((entry) => normalizeLaneEntry(root, entry));
}

function branchExists(root: string, branch: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", branch], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function auditLaneRegistry(root: string, entries: LaneEntry[], log: Pick<Console, "warn"> = console): LaneEntry[] {
  return entries.filter((entry) => {
    if (branchExists(root, entry.branch) || existsSync(entry.worktree)) return true;
    log.warn(
      `[lane-registry] DROPPED resurrected lane ${entry.lane}: branch missing (${entry.branch}) and worktree gone (${entry.worktree})`,
    );
    return false;
  });
}

function writeLaneRegistryAtomic(root: string, entries: LaneEntry[]): void {
  ensureLanesDir(root);
  const path = lanesJsonPath(root);
  const tmp = join(lanesDir(root), `.lanes.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export function updateLaneRegistry(
  root: string,
  mutator: (entries: LaneEntry[]) => LaneEntry[],
  options: LaneRegistryUpdateOptions = {},
): LaneEntry[] {
  acquireRegistryLock(root);
  try {
    const current = readLaneRegistry(root);
    const next = auditLaneRegistry(root, mutator(current), options.log ?? console);
    writeLaneRegistryAtomic(root, next);
    return next;
  } finally {
    releaseRegistryLock(root);
  }
}

export function writeLaneRegistry(root: string, entries: LaneEntry[]): void {
  updateLaneRegistry(root, () => entries);
}

export function setLaneState(root: string, entries: LaneEntry[], laneName: string, state: LaneState): LaneEntry[] {
  if (!entries.some((entry) => entry.lane === laneName && entry.state !== state)) return entries;
  return updateLaneRegistry(root, (fresh) => {
    const now = new Date().toISOString();
    return fresh.map((entry) => {
      if (entry.lane !== laneName || entry.state === state) return entry;
      return { ...entry, state, updated_at: now };
    });
  });
}

export function acknowledgeLaneEvents(root: string, laneName: string, counts: Record<string, number>): LaneEntry[] {
  const incoming = Object.entries(counts).filter(([, count]) => Number.isInteger(count) && count >= 0);
  if (!incoming.length) return readLaneRegistry(root);
  return updateLaneRegistry(root, (fresh) => {
    const now = new Date().toISOString();
    return fresh.map((entry) => {
      if (entry.lane !== laneName) return entry;
      const acked = { ...(entry.acked_events ?? {}) };
      let changed = false;
      for (const [basename, count] of incoming) {
        const previous = acked[basename] ?? 0;
        if (count > previous) {
          acked[basename] = count;
          changed = true;
        }
      }
      return changed ? { ...entry, acked_events: acked, updated_at: now } : entry;
    });
  });
}

export function makeLaneEntry(opts: {
  root: string;
  lane: string;
  branch: string;
  worktree: string;
  engine: "codex" | "agent";
  threadId: string | null;
  card: string;
  state?: LaneState;
  now?: string;
}): LaneEntry {
  const card = normalizeCardPath(opts.root, opts.card, opts.lane);
  const counts = countCardBoxes(opts.root, card);
  const now = opts.now ?? new Date().toISOString();
  return {
    lane: opts.lane,
    branch: opts.branch,
    worktree: opts.worktree,
    engine: opts.engine,
    thread_id: opts.threadId,
    state: opts.state ?? "spawned",
    card,
    boxes_total: counts.total,
    boxes_checked: counts.checked,
    reviewed_tip: null,
    updated_at: now,
    started_at: now,
    owner_lease: null,
  };
}

export function refreshLaneBoxes(root: string, entry: LaneEntry, now = new Date().toISOString()): { entry: LaneEntry; changed: boolean } {
  const counts = countCardBoxes(root, entry.card);
  const state = counts.total > 0 && counts.checked >= counts.total ? "ready" : entry.state === "ready" ? "working" : entry.state;
  const changed = counts.checked !== entry.boxes_checked || counts.total !== entry.boxes_total || state !== entry.state;
  return {
    entry: {
      ...entry,
      boxes_checked: counts.checked,
      boxes_total: counts.total,
      state,
      updated_at: changed ? now : entry.updated_at,
    },
    changed,
  };
}

/**
 * funnel-report — telemetry read over the append-only `gameplay_events` log (card-leaderboards-funnel,
 * v2 = card-session-telemetry).
 *
 * v2 change: WorldRoom now emits `session.start` / `session.end` events on join/leave
 * (EconomyService.recordEvent, migration 014 log). When those exist this tool reports a TRUE
 * dwell-time funnel from real session durations — an idle player who trades/loots nothing is now
 * visible. When they do NOT exist (older data / guest-only DB) it falls back to the original
 * event-span proxy with its lower-bound warning.
 *
 * Prints:
 *   1. A session dwell funnel: fraction of sessions that lasted >= +1 / +10 / +30 minutes
 *      (true dwell from session events; event-span proxy in fallback mode).
 *   2. Per-day event-type counts across gameplay_events.
 *
 * session.end carries a `durationMs` payload (null when the matching session.start was lost, e.g. a
 * server restart between join and leave); such sessions are counted as span-unknown and excluded from
 * the funnel denominator rather than counted as 0-length. A session.start with no matching session.end
 * (server still running, or crash) is likewise span-unknown.
 *
 * Exits NON-ZERO on: no DATABASE_URL, unreachable DB, or an empty event log — so it fails loudly in
 * CI/scripts rather than printing a misleading all-zeros report.
 *
 * Usage: DATABASE_URL=... tsx tools/src/funnel-report.ts
 */
import { fileURLToPath } from "node:url";
import { createPersistenceHandle } from "@gamekit/game-contract";

const MINUTE_MS = 60_000;
export const FUNNEL_MARKS_MIN = [1, 10, 30] as const;

/** Coerce a DB timestamp column (Date | string | number) to epoch ms. */
function toMs(value: unknown): number {
  return new Date(value as string | number | Date).getTime();
}

// --- Pure funnel math (unit-tested in funnel-report.test.ts; no DB access here). ---

export type EventRow = {
  eventType: string;
  characterId: string | null;
  at: unknown;
  /** Present only for session.end rows; null when the session.start was lost. */
  durationMs?: number | null;
};

export type FunnelResult = {
  mode: "session" | "event-span";
  /** Sessions/characters with a MEASURABLE span (denominator of the funnel). */
  measured: number;
  /** Rows recognized but not measurable (session.start with no end, or end with null duration). */
  unknown: number;
  reached: Array<{ min: number; count: number }>;
};

/**
 * True dwell funnel from session events. Each completed session = one session.end row carrying a
 * non-null durationMs. `measured` counts those; `unknown` counts session.end rows with null duration
 * PLUS session.start rows that never got a matching end (open/crashed sessions), so the caller can
 * report instrumentation completeness. Returns null when there are no session events at all (caller
 * falls back to the event-span proxy).
 */
export function sessionDwellFunnel(rows: EventRow[]): FunnelResult | null {
  const starts = rows.filter((r) => r.eventType === "session.start");
  const ends = rows.filter((r) => r.eventType === "session.end");
  if (starts.length === 0 && ends.length === 0) return null;

  const durations: number[] = [];
  let unknown = 0;
  for (const end of ends) {
    if (typeof end.durationMs === "number" && Number.isFinite(end.durationMs) && end.durationMs >= 0) {
      durations.push(end.durationMs);
    } else {
      unknown += 1; // session.end whose matching start was lost (null duration)
    }
  }
  // session.start rows with no corresponding session.end are open/crashed sessions: recognized but
  // not measurable. Approximate the count as (starts - ends), floored at 0.
  unknown += Math.max(0, starts.length - ends.length);

  const measured = durations.length;
  const reached = FUNNEL_MARKS_MIN.map((min) => ({
    min,
    count: durations.filter((d) => d >= min * MINUTE_MS).length,
  }));
  return { mode: "session", measured, unknown, reached };
}

/**
 * Fallback proxy: per-character activity span (last event - first event). Lower bound on real
 * engagement (a player idling with no economy events looks shorter than they were). Used only when
 * no session events exist. Returns null on empty input.
 */
export function eventSpanFunnel(rows: EventRow[]): FunnelResult | null {
  const attributed = rows.filter((r) => r.characterId != null);
  if (attributed.length === 0) return null;

  const spanByChar = new Map<string, { first: number; last: number }>();
  for (const r of attributed) {
    const t = toMs(r.at);
    const cur = spanByChar.get(r.characterId!);
    if (!cur) spanByChar.set(r.characterId!, { first: t, last: t });
    else {
      if (t < cur.first) cur.first = t;
      if (t > cur.last) cur.last = t;
    }
  }
  const spans = [...spanByChar.values()].map((s) => s.last - s.first);
  const reached = FUNNEL_MARKS_MIN.map((min) => ({
    min,
    count: spans.filter((d) => d >= min * MINUTE_MS).length,
  }));
  return { mode: "event-span", measured: spans.length, unknown: 0, reached };
}

/**
 * Prefer the true session-event dwell funnel; fall back to the event-span proxy. Returns null only
 * when neither has any measurable rows (caller treats as empty log).
 */
export function computeFunnel(rows: EventRow[]): FunnelResult | null {
  return sessionDwellFunnel(rows) ?? eventSpanFunnel(rows);
}

/** Per-day (UTC) event-type counts. */
export function eventTypeCountsPerDay(rows: EventRow[]): Map<string, Map<string, number>> {
  const perDay = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const day = new Date(toMs(row.at)).toISOString().slice(0, 10);
    const byType = perDay.get(day) ?? new Map<string, number>();
    byType.set(row.eventType, (byType.get(row.eventType) ?? 0) + 1);
    perDay.set(day, byType);
  }
  return perDay;
}

/** Render the funnel result to console (extracted so the shape is obvious and testable-by-eye). */
export function printFunnel(result: FunnelResult): void {
  if (result.mode === "session") {
    console.log("=== Session dwell funnel (true session.start/session.end events) ===");
  } else {
    console.log("=== Session retention funnel (event-span proxy — NO session events found) ===");
  }
  console.log(`measurable sessions: ${result.measured}` + (result.unknown ? `  (span-unknown, excluded: ${result.unknown})` : ""));
  for (const { min, count } of result.reached) {
    const pct = result.measured > 0 ? ((count / result.measured) * 100).toFixed(1) : "0.0";
    console.log(`  lasted >= minute ${String(min).padStart(2)}: ${count} (${pct}%)`);
  }
  if (result.mode === "event-span") {
    console.log(
      "\n[funnel-report] NOTE: no session.start/session.end event found in this DB; the funnel is an " +
        "event-span lower bound. Once WorldRoom join/leave has emitted session events, this becomes a " +
        "true dwell-time funnel automatically.",
    );
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("[funnel-report] DATABASE_URL is not set. Set it to the dev database and re-run.");
    process.exitCode = 1;
    return;
  }

  const handle = createPersistenceHandle();
  const db = handle.db;
  if (!db) {
    console.error("[funnel-report] no database handle (DATABASE_URL empty/invalid).");
    process.exitCode = 1;
    return;
  }

  try {
    // Stream the full event log once; it is small enough (MVP-0 volumes) and both the funnel and the
    // per-day counts read from it. payload is parsed for the session.end durationMs.
    const raw = await db
      .selectFrom("gameplay_events")
      .select(["at", "event_type as eventType", "character_id as characterId", "payload"])
      .execute();

    if (raw.length === 0) {
      console.error(
        "[funnel-report] gameplay_events is empty — nothing to report. " +
          "Play the game (log in, trade/loot/clear a stage) against this DB, or point DATABASE_URL at a populated database.",
      );
      process.exitCode = 1;
      return;
    }

    const rows: EventRow[] = raw.map((r) => {
      let durationMs: number | null | undefined;
      if (r.eventType === "session.end") {
        const payload = (r.payload ?? {}) as Record<string, unknown>;
        durationMs = typeof payload.durationMs === "number" ? payload.durationMs : null;
      }
      return { eventType: r.eventType, characterId: r.characterId, at: r.at, durationMs };
    });

    const funnel = computeFunnel(rows);
    if (funnel) {
      printFunnel(funnel);
    } else {
      console.log("=== Session funnel ===");
      console.log("no character-attributed or session-event rows to measure.");
    }

    console.log("\n=== Event-type counts per day ===");
    const perDay = eventTypeCountsPerDay(rows);
    for (const day of [...perDay.keys()].sort().reverse()) {
      console.log(`${day}:`);
      const byType = perDay.get(day)!;
      for (const type of [...byType.keys()].sort()) {
        console.log(`  ${type.padEnd(20)} ${byType.get(type)}`);
      }
    }
  } finally {
    await handle.close();
  }
}

// Run only when invoked directly (not when imported by the test suite).
const invokedDirectly =
  process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error("[funnel-report] FATAL:", err);
    process.exitCode = 1;
  });
}

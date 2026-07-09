import { describe, expect, it } from "vitest";
import {
  computeFunnel,
  eventSpanFunnel,
  eventTypeCountsPerDay,
  sessionDwellFunnel,
  type EventRow,
} from "./funnel-report";

const MIN = 60_000;
const AT = "2026-07-08T00:00:00.000Z"; // `at` is irrelevant to the session funnel (duration is explicit)

function sessionStart(characterId: string, at = AT): EventRow {
  return { eventType: "session.start", characterId, at };
}
function sessionEnd(characterId: string, durationMs: number | null, at = AT): EventRow {
  return { eventType: "session.end", characterId, at, durationMs };
}

describe("sessionDwellFunnel", () => {
  it("returns null when there are no session events (caller falls back)", () => {
    expect(sessionDwellFunnel([{ eventType: "loot.pickup", characterId: "c1", at: AT }])).toBeNull();
  });

  it("counts each session.end durationMs against the +1/+10/+30 marks", () => {
    const rows: EventRow[] = [
      sessionStart("c1"),
      sessionEnd("c1", 5 * MIN), // reaches +1, not +10
      sessionStart("c2"),
      sessionEnd("c2", 12 * MIN), // reaches +1, +10, not +30
      sessionStart("c3"),
      sessionEnd("c3", 40 * MIN), // reaches all three
      sessionStart("c4"),
      sessionEnd("c4", 30 * MIN), // exactly +30 (>= boundary)
    ];
    const res = sessionDwellFunnel(rows)!;
    expect(res.mode).toBe("session");
    expect(res.measured).toBe(4);
    expect(res.unknown).toBe(0);
    expect(res.reached).toEqual([
      { min: 1, count: 4 },
      { min: 10, count: 3 },
      { min: 30, count: 2 },
    ]);
  });

  it("excludes null-duration ends (lost start) from the denominator and counts them as unknown", () => {
    const rows: EventRow[] = [
      sessionStart("c1"),
      sessionEnd("c1", 20 * MIN),
      sessionEnd("c2", null), // server restart lost the matching start
    ];
    const res = sessionDwellFunnel(rows)!;
    expect(res.measured).toBe(1);
    expect(res.unknown).toBe(1);
    expect(res.reached).toEqual([
      { min: 1, count: 1 },
      { min: 10, count: 1 },
      { min: 30, count: 0 },
    ]);
  });

  it("counts unmatched session.start rows (open/crashed sessions) as unknown", () => {
    const rows: EventRow[] = [
      sessionStart("c1"),
      sessionStart("c2"), // still online, no end yet
      sessionEnd("c1", 15 * MIN),
    ];
    const res = sessionDwellFunnel(rows)!;
    expect(res.measured).toBe(1);
    expect(res.unknown).toBe(1); // one start without an end
  });

  it("treats negative or non-finite durations as unknown, never as 0", () => {
    const rows: EventRow[] = [
      sessionEnd("c1", -5),
      sessionEnd("c2", Number.NaN as unknown as number),
      sessionEnd("c3", 2 * MIN),
    ];
    const res = sessionDwellFunnel(rows)!;
    expect(res.measured).toBe(1);
    expect(res.unknown).toBe(2);
    expect(res.reached[0]).toEqual({ min: 1, count: 1 });
  });
});

describe("eventSpanFunnel (fallback proxy)", () => {
  it("measures each character's first->last event span", () => {
    const t0 = new Date("2026-07-08T00:00:00.000Z").getTime();
    const rows: EventRow[] = [
      { eventType: "loot.pickup", characterId: "c1", at: new Date(t0).toISOString() },
      { eventType: "shop.buy", characterId: "c1", at: new Date(t0 + 12 * MIN).toISOString() },
      { eventType: "loot.pickup", characterId: "c2", at: new Date(t0).toISOString() },
      // c2 has only one event -> span 0, reaches nothing
    ];
    const res = eventSpanFunnel(rows)!;
    expect(res.mode).toBe("event-span");
    expect(res.measured).toBe(2);
    expect(res.reached).toEqual([
      { min: 1, count: 1 },
      { min: 10, count: 1 },
      { min: 30, count: 0 },
    ]);
  });

  it("ignores null-character rows and returns null when nothing is attributed", () => {
    expect(eventSpanFunnel([{ eventType: "stage.cleared", characterId: null, at: AT }])).toBeNull();
  });
});

describe("computeFunnel", () => {
  it("prefers session events when present", () => {
    const rows: EventRow[] = [
      sessionStart("c1"),
      sessionEnd("c1", 15 * MIN),
      { eventType: "loot.pickup", characterId: "c1", at: AT }, // would be a 0-span proxy row
    ];
    expect(computeFunnel(rows)!.mode).toBe("session");
  });

  it("falls back to event-span when there are no session events", () => {
    const t0 = new Date(AT).getTime();
    const rows: EventRow[] = [
      { eventType: "loot.pickup", characterId: "c1", at: new Date(t0).toISOString() },
      { eventType: "shop.sell", characterId: "c1", at: new Date(t0 + 2 * MIN).toISOString() },
    ];
    expect(computeFunnel(rows)!.mode).toBe("event-span");
  });

  it("returns null when there is nothing measurable at all", () => {
    expect(computeFunnel([{ eventType: "stage.failed", characterId: null, at: AT }])).toBeNull();
  });
});

describe("eventTypeCountsPerDay", () => {
  it("buckets counts by UTC day and event type", () => {
    const rows: EventRow[] = [
      { eventType: "session.start", characterId: "c1", at: "2026-07-08T01:00:00.000Z" },
      { eventType: "session.end", characterId: "c1", at: "2026-07-08T02:00:00.000Z", durationMs: MIN },
      { eventType: "session.start", characterId: "c2", at: "2026-07-07T23:00:00.000Z" },
    ];
    const perDay = eventTypeCountsPerDay(rows);
    expect(perDay.get("2026-07-08")!.get("session.start")).toBe(1);
    expect(perDay.get("2026-07-08")!.get("session.end")).toBe(1);
    expect(perDay.get("2026-07-07")!.get("session.start")).toBe(1);
  });
});

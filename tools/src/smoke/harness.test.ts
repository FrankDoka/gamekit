import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  reserveOpenPort,
  serverOutputProvesOwnership,
  type PortReservation,
} from "./harness";

// These tests pin the two mechanisms card-capture-port-lock adds to the shared
// smoke/capture harness:
//   1. reserveOpenPort holds an OS binding across selection so parallel runs
//      cannot pick the same free port (closes the probe-then-spawn TOCTOU race).
//   2. serverOutputProvesOwnership only accepts a server whose boot log echoes
//      THIS run's unique id, so a foreign/stale server on the same port is a
//      loud fail, never a silent reuse.

const openReservations: PortReservation[] = [];

afterEach(() => {
  for (const reservation of openReservations.splice(0)) reservation.release();
});

function track(reservation: PortReservation): PortReservation {
  openReservations.push(reservation);
  return reservation;
}

async function pickFreeRangeBase(): Promise<number> {
  // Ask the OS for an ephemeral port, then use a small range around it that is
  // very unlikely to collide with anything else on the box.
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const addr = probe.address();
      const base = typeof addr === "object" && addr ? addr.port : 0;
      probe.close(() => resolve(base));
    });
  });
}

describe("reserveOpenPort (Scope 1: parallel isolation by construction)", () => {
  it("hands out distinct ports to concurrent callers over the same range", async () => {
    const base = await pickFreeRangeBase();
    const first = base + 1;
    const last = base + 12;

    // Reserve the whole range concurrently. Because each reservation HOLDS its
    // binding, no two callers can be handed the same port.
    const reservations = await Promise.all(
      Array.from({ length: last - first + 1 }, () => reserveOpenPort(first, last).then(track)),
    );

    const ports = reservations.map((r) => r.port);
    const unique = new Set(ports);
    expect(unique.size).toBe(ports.length);
    for (const port of ports) expect(port).toBeGreaterThanOrEqual(first);
    for (const port of ports) expect(port).toBeLessThanOrEqual(last);
  });

  it("throws (does not silently reuse) when the whole range is held", async () => {
    const base = await pickFreeRangeBase();
    const first = base + 1;
    const last = base + 2;

    // Hold every port in the range, then a further request must fail loudly.
    track(await reserveOpenPort(first, last));
    track(await reserveOpenPort(first, last));
    await expect(reserveOpenPort(first, last)).rejects.toThrow(/No open smoke-test port/);
  });

  it("never hands out a port already held by a foreign listener (stale-server sim)", async () => {
    const base = await pickFreeRangeBase();
    const first = base + 1;
    const last = base + 2; // exactly two candidates
    // Simulate a stale/foreign server squatting the FIRST candidate. The
    // reservation must skip it and pick the other port, never reuse the foreign
    // listener. Time-boxed + torn down in finally so the fixture cannot leak.
    const foreign = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        foreign.once("error", reject);
        foreign.listen({ host: "127.0.0.1", port: first, exclusive: true }, () => resolve());
      });
      const reservation = track(await reserveOpenPort(first, last));
      expect(reservation.port).not.toBe(first);
      expect(reservation.port).toBe(last);
    } finally {
      foreign.close();
    }
  });

  it("a released port becomes reusable", async () => {
    const base = await pickFreeRangeBase();
    const first = base + 1;
    const last = base + 1; // single-port range
    const held = await reserveOpenPort(first, last);
    expect(held.port).toBe(first);
    held.release();
    // Give the OS a tick to reclaim the just-closed listener.
    await new Promise((resolve) => setTimeout(resolve, 25));
    track(await reserveOpenPort(first, last));
  });
});

describe("serverOutputProvesOwnership (Scope 2: no foreign-server reuse)", () => {
  const runId = "11111111-2222-3333-4444-555555555555";

  it("accepts a boot log that echoes this run's id", () => {
    const log = `{"level":30,"port":27101,"smokeRunId":"${runId}","msg":"server listening"}`;
    expect(serverOutputProvesOwnership(log, runId)).toBe(true);
  });

  it("rejects a foreign server (no runId in its log)", () => {
    const foreign = `{"level":30,"port":27101,"msg":"server listening"}`;
    expect(serverOutputProvesOwnership(foreign, runId)).toBe(false);
  });

  it("rejects a server that echoes a DIFFERENT run's id", () => {
    const other = `{"level":30,"port":27101,"smokeRunId":"99999999-0000-0000-0000-000000000000","msg":"server listening"}`;
    expect(serverOutputProvesOwnership(other, runId)).toBe(false);
  });

  it("never proves ownership with an empty run id", () => {
    expect(serverOutputProvesOwnership('"smokeRunId":""', "")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { evaluateDbIdentity, isRecoverableLogRotationError, nextWatchdogFailureState, parseDockerJsonLines, watchdogDelayMs } from "./devkit-hub.js";

describe("devkit hub docker identity guard", () => {
  it("requires the 5432 owner to be the current compose db container", () => {
    const expected = parseDockerJsonLines('{"Name":"gamekit-db-1","Service":"db"}');
    const owners = parseDockerJsonLines('{"Names":"decoy-db-1","Labels":"com.docker.compose.project=decoy,com.docker.compose.service=db","Ports":"0.0.0.0:5432->5432/tcp"}');

    const result = evaluateDbIdentity(expected, owners);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("expected compose db container gamekit-db-1");
    expect(result.owners[0]).toMatchObject({ name: "decoy-db-1", project: "decoy", service: "db" });
  });

  it("accepts the main compose db container as the 5432 owner", () => {
    const expected = parseDockerJsonLines('{"Name":"gamekit-db-1","Service":"db"}');
    const owners = parseDockerJsonLines('{"Names":"gamekit-db-1","Labels":"com.docker.compose.project=gamekit,com.docker.compose.service=db","Ports":"0.0.0.0:5432->5432/tcp"}');

    expect(evaluateDbIdentity(expected, owners)).toMatchObject({ ok: true, expectedContainer: "gamekit-db-1" });
  });
});

describe("devkit hub watchdog backoff", () => {
  it("backs off exponentially and caps retry delay", () => {
    expect(watchdogDelayMs(1)).toBe(30_000);
    expect(watchdogDelayMs(2)).toBe(60_000);
    expect(watchdogDelayMs(10)).toBe(300_000);
  });

  it("enters gave-up state after bounded restart failures", () => {
    let state = undefined;
    for (let i = 0; i < 4; i++) state = nextWatchdogFailureState(state, "restart failed", 1_700_000_000_000);
    expect(state).toMatchObject({ failures: 4, gaveUp: true, lastError: "restart failed" });
  });
});

describe("devkit hub log rotation tolerance", () => {
  it("treats EBUSY and EPERM as recoverable rotation failures", () => {
    expect(isRecoverableLogRotationError(Object.assign(new Error("busy"), { code: "EBUSY" }))).toBe(true);
    expect(isRecoverableLogRotationError(Object.assign(new Error("denied"), { code: "EPERM" }))).toBe(true);
    expect(isRecoverableLogRotationError(Object.assign(new Error("missing"), { code: "ENOENT" }))).toBe(false);
  });
});

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { detectDeadLane, detectUnseenCompletedTurn, markDeadLaneBlocked } from "./lanes-dead";
import { readLaneRegistry, writeLaneRegistry } from "./lane-registry";
import type { LaneEntry } from "./lane-registry";

// Git scratch-repo integration suite: generous timeout — these time out under
// parallel lane gate-battery load (2x flaked 2026-07-07: lane-close, lanes-dead).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const FIXTURE = join(process.cwd(), "tools", "fixtures", "lanes", "editor-decomp-2-events-first4.jsonl");
const TSX = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const LANES_WATCH = join(process.cwd(), "tools", "src", "lanes-watch.ts");

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "gamekit-dead-lane-"));
  git(root, ["init", "-b", "master"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Dead Lane Test"]);
  writeFileSync(join(root, "README.md"), "fixture\n", "utf8");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "fixture"]);
  git(root, ["checkout", "-b", "codex/card-editor-decomp-2"]);
  return root;
}

function entry(root: string): LaneEntry {
  return {
    lane: "editor-decomp-2",
    branch: "codex/card-editor-decomp-2",
    worktree: root,
    engine: "codex",
    thread_id: "fixture-thread",
    state: "working",
    card: "docs/tasks/card-editor-decomp-2.md",
    boxes_total: 1,
    boxes_checked: 0,
    reviewed_tip: null,
    updated_at: "2026-07-04T00:00:00.000Z",
  };
}

function writeEvents(root: string, jsonl: string): void {
  mkdirSync(join(root, "tools", "_lanes"), { recursive: true });
  writeFileSync(join(root, "tools", "_lanes", "editor-decomp-2-events.jsonl"), jsonl, "utf8");
}

function writeResumeEvents(root: string, jsonl: string): void {
  mkdirSync(join(root, "tools", "_lanes"), { recursive: true });
  writeFileSync(join(root, "tools", "_lanes", "editor-decomp-2-events.jsonl.resume1"), jsonl, "utf8");
}

function runWatch(root: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [TSX, LANES_WATCH, "--interval", "1", "--timeout-mins", "0.001"], {
    cwd: root,
    env: { ...process.env, LANES_WATCH_PRIMARY_ROOT: root },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("dead lane detection", () => {
  it("detects the real quota-failure JSONL fixture and marks the registry blocked", () => {
    const root = makeRepo();
    mkdirSync(join(root, "tools", "_lanes"), { recursive: true });
    writeFileSync(join(root, "tools", "_lanes", "editor-decomp-2-events.jsonl"), readFileSync(FIXTURE, "utf8"), "utf8");
    const entries = [entry(root)];
    writeLaneRegistry(root, entries);

    const detection = detectDeadLane(root, entries[0]);
    expect(detection).toMatchObject({ lane: "editor-decomp-2", reason: "usage-limit", eventLine: 4 });

    markDeadLaneBlocked(root, readLaneRegistry(root), detection!);
    expect(readLaneRegistry(root)[0].state).toBe("blocked");
  });

  it("does not classify a respawned lane as dead (thread.started after the failure)", () => {
    const root = makeRepo();
    mkdirSync(join(root, "tools", "_lanes"), { recursive: true });
    // Real incident shape 2026-07-04: quota failure, then the integrator
    // respawned a fresh thread in the same lane — mid-turn, no terminal event
    // yet, no commit yet. Must NOT be dead.
    const jsonl =
      readFileSync(FIXTURE, "utf8").trimEnd() +
      '\n{"type": "thread.started", "thread_id": "respawn-thread"}\n{"type": "turn.started"}\n';
    writeFileSync(join(root, "tools", "_lanes", "editor-decomp-2-events.jsonl"), jsonl, "utf8");

    expect(detectDeadLane(root, entry(root))).toBeNull();
  });

  it("does not classify a resumed lane as dead when the restart is in a resume JSONL file", () => {
    const root = makeRepo();
    mkdirSync(join(root, "tools", "_lanes"), { recursive: true });
    writeFileSync(join(root, "tools", "_lanes", "editor-decomp-2-events.jsonl"), readFileSync(FIXTURE, "utf8"), "utf8");
    writeFileSync(
      join(root, "tools", "_lanes", "editor-decomp-2-events.jsonl.resume1"),
      '{"type": "thread.started", "thread_id": "resume-thread"}\n{"type": "turn.started"}\n',
      "utf8",
    );

    expect(detectDeadLane(root, entry(root))).toBeNull();
  });

  it("does not classify a recovered stream disconnect as dead (item activity after the error, same turn)", () => {
    const root = makeRepo();
    mkdirSync(join(root, "tools", "_lanes"), { recursive: true });
    // Real incident shape 2026-07-04 evening: imagegen-debt-burn wave-3 logged
    // an error ("Reconnecting... 5/5 (stream disconnected") mid-turn, the stream
    // recovered, and the thread kept executing items WITHOUT a new turn.started.
    // Must NOT be dead — only an error with no activity after it is terminal.
    const jsonl =
      readFileSync(FIXTURE, "utf8").trimEnd() +
      '\n{"type": "item.started", "item": {"id": "item_24", "type": "command_execution"}}\n' +
      '{"type": "item.completed", "item": {"id": "item_24", "type": "command_execution"}}\n';
    writeFileSync(join(root, "tools", "_lanes", "editor-decomp-2-events.jsonl"), jsonl, "utf8");

    expect(detectDeadLane(root, entry(root))).toBeNull();
  });

  it("does not classify a lane as dead after a later branch commit", () => {
    const root = makeRepo();
    mkdirSync(join(root, "tools", "_lanes"), { recursive: true });
    writeFileSync(join(root, "tools", "_lanes", "editor-decomp-2-events.jsonl"), readFileSync(FIXTURE, "utf8"), "utf8");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
    writeFileSync(join(root, "recovery.txt"), "recovered\n", "utf8");
    git(root, ["add", "recovery.txt"]);
    git(root, ["commit", "-m", "recover lane"]);

    expect(detectDeadLane(root, entry(root))).toBeNull();
  });
});

describe("unseen completed-turn backscan", () => {
  it("detects a completed turn at the JSONL tail when the registry is still working", () => {
    const root = makeRepo();
    const entries = [entry(root)];
    writeLaneRegistry(root, entries);
    writeEvents(root, '{"type":"turn.completed","usage":{"input_tokens":12345}}\n');

    expect(detectUnseenCompletedTurn(root, entries[0])).toMatchObject({
      lane: "editor-decomp-2",
      eventLine: 1,
      inputTokens: 12345,
    });
  });

  it("arms and emits EVENT unseen-turn for a completed tail in a scratch registry", () => {
    const root = makeRepo();
    writeLaneRegistry(root, [entry(root)]);
    writeEvents(root, '{"type":"turn.completed","usage":{"input_tokens":12345}}\n');

    const result = runWatch(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("EVENT unseen-turn editor-decomp-2 12345");
  });

  it("does not re-emit the same unseen-turn after the watcher acknowledges it", () => {
    const root = makeRepo();
    writeLaneRegistry(root, [entry(root)]);
    writeEvents(root, '{"type":"turn.completed","usage":{"input_tokens":12345}}\n');

    const first = runWatch(root);
    const second = runWatch(root);

    expect(first.status).toBe(0);
    expect(first.stdout).toContain("EVENT unseen-turn editor-decomp-2 12345");
    expect(readLaneRegistry(root)[0].acked_events?.["editor-decomp-2-events.jsonl"]).toBe(1);
    expect(second.status).toBe(1);
    expect(second.stdout).toContain("[lanes-watch] armed:");
    expect(second.stdout).toContain("TIMEOUT 0.001m: no lane events");
    expect(second.stdout).not.toContain("EVENT unseen-turn");
  });

  it("detects a completed turn appended to a resume JSONL file once", () => {
    const root = makeRepo();
    writeLaneRegistry(root, [entry(root)]);
    writeEvents(root, '{"type":"thread.started","thread_id":"base-thread"}\n');
    writeResumeEvents(root, '{"type":"turn.completed","usage":{"input_tokens":67890}}\n');

    const first = runWatch(root);
    const second = runWatch(root);

    expect(first.status).toBe(0);
    expect(first.stdout).toContain("EVENT unseen-turn editor-decomp-2 67890");
    expect(readLaneRegistry(root)[0].acked_events?.["editor-decomp-2-events.jsonl.resume1"]).toBe(1);
    expect(second.status).toBe(1);
    expect(second.stdout).toContain("TIMEOUT 0.001m: no lane events");
    expect(second.stdout).not.toContain("EVENT unseen-turn");
  });

  it("does not emit after a later thread.started resumes the lane", () => {
    const root = makeRepo();
    writeLaneRegistry(root, [entry(root)]);
    writeEvents(
      root,
      '{"type":"turn.completed","usage":{"input_tokens":12345}}\n{"type":"thread.started","thread_id":"resumed-thread"}\n',
    );

    const result = runWatch(root);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("[lanes-watch] armed:");
    expect(result.stdout).toContain("TIMEOUT 0.001m: no lane events");
    expect(result.stdout).not.toContain("EVENT unseen-turn");
  });

  it("leaves healthy live lanes on the normal arm-and-poll path", () => {
    const root = makeRepo();
    writeLaneRegistry(root, [entry(root)]);
    writeEvents(root, '{"type":"thread.started","thread_id":"live-thread"}\n{"type":"turn.started"}\n');

    const result = runWatch(root);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("[lanes-watch] armed:");
    expect(result.stdout).toContain("TIMEOUT 0.001m: no lane events");
    expect(result.stdout).not.toContain("EVENT unseen-turn");
  });
});

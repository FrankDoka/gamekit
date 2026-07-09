import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { readLaneRegistry, writeLaneRegistry } from "./lane-registry";
import type { LaneEntry } from "./lane-registry";

// Git scratch-repo integration suite: generous timeout to match lanes-dead.test.ts,
// which flakes under parallel gate-battery load (2026-07-07).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const TSX = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const LANES_WATCH = join(process.cwd(), "tools", "src", "lanes-watch.ts");

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "gamekit-agent-lane-"));
  git(root, ["init", "-b", "master"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Agent Lane Test"]);
  writeFileSync(join(root, "README.md"), "fixture\n", "utf8");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "fixture"]);
  // The lane branch exists but has NO commit past master (no branch work landed).
  git(root, ["branch", "codex/card-agent-stall"]);
  return root;
}

// An agent lane whose updated_at heartbeat is far past any sane stall window and
// whose branch has no commit — the exact E1 shape (crashed/stalled agent lane).
function staleAgentEntry(root: string): LaneEntry {
  return {
    lane: "agent-stall",
    branch: "codex/card-agent-stall",
    worktree: root,
    engine: "agent",
    thread_id: null,
    state: "working",
    card: "docs/tasks/card-agent-stall.md",
    boxes_total: 1,
    boxes_checked: 0,
    reviewed_tip: null,
    updated_at: "2020-01-01T00:00:00.000Z",
    started_at: "2020-01-01T00:00:00.000Z",
    owner_lease: null,
  };
}

function runWatch(root: string, extraArgs: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [TSX, LANES_WATCH, "--interval", "1", "--timeout-mins", "0.001", "--stall-mins", "45", ...extraArgs],
    {
      cwd: root,
      env: { ...process.env, LANES_WATCH_PRIMARY_ROOT: root },
      encoding: "utf8",
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("agent-lane stall detection (E1 lifecycle parity)", () => {
  it("reports a stale agent lane as stalled within one sweep and persists the state", () => {
    const root = makeRepo();
    writeLaneRegistry(root, [staleAgentEntry(root)]);

    const result = runWatch(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("EVENT stall agent-stall");
    expect(result.stdout).toContain("agent-lane quiet");
    expect(result.stdout).toContain("no branch commit");
    // The watcher armed with the agent lane counted.
    expect(result.stdout).toMatch(/agent lane\(s\)/);
    // Registry state was flipped to stalled.
    expect(readLaneRegistry(root)[0].state).toBe("stalled");
  });

  it("does NOT stall a fresh-heartbeat agent lane (guards against false positives)", () => {
    const root = makeRepo();
    const fresh = { ...staleAgentEntry(root), updated_at: new Date().toISOString() };
    writeLaneRegistry(root, [fresh]);

    const result = runWatch(root);

    // No stall event; the short-timeout watcher simply times out (exit 1).
    expect(result.stdout).not.toContain("EVENT stall agent-stall");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("TIMEOUT 0.001m: no lane events");
  });
});

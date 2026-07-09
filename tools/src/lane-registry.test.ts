import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lanesJsonPath, readLaneRegistry, setLaneState, updateLaneRegistry, writeLaneRegistry } from "./lane-registry";
import type { LaneEntry } from "./lane-registry";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "gamekit-lane-registry-"));
  git(root, ["init", "-b", "master"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Lane Registry Test"]);
  writeFileSync(join(root, "README.md"), "fixture\n", "utf8");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "fixture"]);
  return root;
}

function makeEntry(lane: string, worktree: string): LaneEntry {
  return {
    lane,
    branch: `codex/card-${lane}`,
    worktree,
    engine: "codex",
    thread_id: "fixture-thread",
    state: "working",
    card: `docs/tasks/card-${lane}.md`,
    boxes_total: 1,
    boxes_checked: 0,
    reviewed_tip: null,
    updated_at: "2026-07-04T00:00:00.000Z",
  };
}

describe("lane registry atomic writes", () => {
  it("keeps a closed lane pruned when a watcher writes from a stale read window", () => {
    const root = makeRepo();
    git(root, ["branch", "codex/card-watch-lane"]);
    git(root, ["branch", "codex/card-closed-lane"]);
    const watchWorktree = join(root, "watch-worktree");
    const closedWorktree = join(root, "closed-worktree");
    mkdirSync(watchWorktree);
    mkdirSync(closedWorktree);
    const watchLane = makeEntry("watch-lane", watchWorktree);
    const closedLane = makeEntry("closed-lane", closedWorktree);
    writeLaneRegistry(root, [closedLane, watchLane]);

    const staleWatcherSnapshot = readLaneRegistry(root);

    git(root, ["branch", "-D", closedLane.branch]);
    rmSync(closedWorktree, { recursive: true, force: true });
    writeLaneRegistry(root, [watchLane]);

    if (process.env.LANE_REGISTRY_LEGACY_TEST_WRITER === "1") {
      const legacyNext = staleWatcherSnapshot.map((entry) =>
        entry.lane === watchLane.lane ? { ...entry, state: "ready" as const, updated_at: new Date().toISOString() } : entry,
      );
      writeFileSync(lanesJsonPath(root), JSON.stringify(legacyNext, null, 2) + "\n", "utf8");
    } else {
      setLaneState(root, staleWatcherSnapshot, watchLane.lane, "ready");
    }

    expect(readLaneRegistry(root).map((entry) => ({ lane: entry.lane, state: entry.state }))).toEqual([
      { lane: "watch-lane", state: "ready" },
    ]);
  });

  it("drops branchless worktree-less entries during transactional writes with a loud audit line", () => {
    const root = makeRepo();
    git(root, ["branch", "codex/card-live-lane"]);
    const liveWorktree = join(root, "live-worktree");
    mkdirSync(liveWorktree);
    const liveLane = makeEntry("live-lane", liveWorktree);
    const ghostLane = makeEntry("ghost-lane", join(root, "missing-worktree"));
    const auditLines: string[] = [];

    updateLaneRegistry(root, () => [liveLane, ghostLane], { log: { log: () => undefined, warn: (line) => auditLines.push(line) } });

    expect(readLaneRegistry(root).map((entry) => entry.lane)).toEqual(["live-lane"]);
    expect(auditLines).toEqual([
      `[lane-registry] DROPPED resurrected lane ghost-lane: branch missing (codex/card-ghost-lane) and worktree gone (${ghostLane.worktree})`,
    ]);
  });
});

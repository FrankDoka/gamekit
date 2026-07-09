import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Git scratch-repo integration suite: generous timeout — these time out under
// parallel lane gate-battery load (2x flaked 2026-07-07: lane-close, lanes-dead).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "gamekit-lane-close-guard-"));
  git(root, ["init", "-b", "master"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Lane Close Guard Test"]);
  writeFileSync(join(root, "README.md"), "base\n", "utf8");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "base"]);
  return root;
}

function runLaneClose(root: string, args: string[]): { exit: number; output: string } {
  const script = join(process.cwd(), "tools", "src", "lane-close.ts");
  const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const env = { ...process.env, LANE_CLOSE_PRIMARY_ROOT: root };
  const result = spawnSync(process.execPath, [tsxCli, script, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    exit: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function makeLaneFixture(root: string, lane: string): { worktree: string } {
  const branch = `guard-${lane}`;
  const worktree = join(root, `${lane}-wt`);
  git(root, ["branch", branch]);
  git(root, ["worktree", "add", worktree, branch]);
  writeFileSync(join(worktree, "branch.txt"), `${lane}\n`, "utf8");
  git(worktree, ["add", "branch.txt"]);
  git(worktree, ["commit", "-m", "branch commit"]);
  return { worktree };
}

function porcelainHasWorktree(root: string, worktree: string): boolean {
  return git(root, ["worktree", "list", "--porcelain"]).includes(worktree.replace(/\\/g, "/"));
}

/**
 * The exact s22 p3-weapon-arc data-loss shape: a lane worktree whose branch tip is
 * the master base commit (so the merge guard passes — merge-base --is-ancestor is
 * trivially true), carrying the ENTIRE deliverable as staged-but-uncommitted files
 * plus a gitignored .commit-msg.txt. This is what EVERY ready lane looks like under
 * the "stage + .commit-msg.txt, integrator commits" contract.
 */
function makeIncidentFixture(root: string, lane: string): { worktree: string; branch: string } {
  const branch = `guard-${lane}`;
  const worktree = join(root, `${lane}-wt`);
  // Branch off master base — tip stays at the master commit (no lane commit).
  git(root, ["branch", branch]);
  git(root, ["worktree", "add", worktree, branch]);
  // Deliverable staged but NOT committed.
  writeFileSync(join(worktree, "deliverable.txt"), `${lane} deliverable\n`, "utf8");
  writeFileSync(join(worktree, "second.txt"), "more work\n", "utf8");
  git(worktree, ["add", "deliverable.txt", "second.txt"]);
  // Gitignored intake handoff file — must NOT appear in porcelain output.
  writeFileSync(join(worktree, ".gitignore"), ".commit-msg.txt\n", "utf8");
  git(worktree, ["add", ".gitignore"]);
  writeFileSync(join(worktree, ".commit-msg.txt"), "feat: the deliverable\n", "utf8");
  return { worktree, branch };
}

describe("lane-close merge guard", () => {
  it("refuses to close an unmerged branch, then succeeds once merged", () => {
    const root = makeRepo();
    try {
      const { worktree } = makeLaneFixture(root, "unmerged");

      const refused = runLaneClose(root, [worktree]);
      expect(refused.exit).toBe(1);
      expect(refused.output).toContain("branch=guard-unmerged");
      expect(refused.output).toContain("REFUSED: branch not merged (use --force)");
      expect(porcelainHasWorktree(root, worktree)).toBe(true);

      git(root, ["checkout", "master"]);
      git(root, ["merge", "--ff-only", "guard-unmerged"]);

      const closed = runLaneClose(root, [worktree]);
      expect(closed.exit).toBe(0);
      expect(closed.output).toContain(`worktree removed: ${worktree.replace(/\\/g, "/")}`);
      expect(closed.output).toContain("branch deleted: guard-unmerged");
      expect(git(root, ["branch", "--list", "guard-unmerged"])).toBe("");
      expect(porcelainHasWorktree(root, worktree)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("forces an unmerged close with a warning and leaves the branch behind", () => {
    const root = makeRepo();
    try {
      const { worktree } = makeLaneFixture(root, "force");

      const forced = runLaneClose(root, [worktree, "--force"]);
      expect(forced.exit).toBe(0);
      expect(forced.output).toContain("WARNING: forcing close of unmerged branch guard-force");
      expect(forced.output).toContain("branch guard-force not deleted");
      expect(git(root, ["branch", "--list", "guard-force"])).not.toBe("");
      expect(porcelainHasWorktree(root, worktree)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("survives a fast-forward-aborted merge followed by a close attempt", () => {
    const root = makeRepo();
    try {
      const { worktree } = makeLaneFixture(root, "nearmiss");

      git(root, ["checkout", "master"]);
      writeFileSync(join(root, "master.txt"), "master diverges\n", "utf8");
      git(root, ["add", "master.txt"]);
      git(root, ["commit", "-m", "master commit"]);

      const merge = spawnSync("git", ["-C", root, "merge", "--ff-only", "guard-nearmiss"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const close = runLaneClose(root, [worktree]);

      expect(merge.status).toBe(128);
      expect(`${merge.stdout ?? ""}${merge.stderr ?? ""}`).toContain("Not possible to fast-forward, aborting.");
      expect(close.exit).toBe(1);
      expect(close.output).toContain("REFUSED: branch not merged (use --force)");
      expect(porcelainHasWorktree(root, worktree)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("lane-close dirty-worktree guard", () => {
  it("BLOCKS the s22 incident shape: staged deliverable, tip == master base", () => {
    const root = makeRepo();
    try {
      // Reproduce the exact loss: the branch is trivially merged (tip == master),
      // so the merge guard alone would let the delete proceed.
      const { worktree, branch } = makeIncidentFixture(root, "incident");
      // Prove the pre-existing merge guard alone would NOT block: tip is an
      // ancestor of master (--is-ancestor exits 0, git() returns "" not a throw).
      expect(() => git(root, ["merge-base", "--is-ancestor", branch, "master"])).not.toThrow();

      const blocked = runLaneClose(root, [worktree]);

      expect(blocked.exit).toBe(1);
      expect(blocked.output).toContain("BLOCKED:");
      expect(blocked.output).toContain("uncommitted change(s)");
      // Staged deliverable files are named in the loud list.
      expect(blocked.output).toContain("deliverable.txt");
      expect(blocked.output).toContain("second.txt");
      // Gitignored intake file must NOT leak into the porcelain list.
      expect(blocked.output).not.toContain(".commit-msg.txt");
      // Recovery hint points at intake with the resolved branch.
      expect(blocked.output).toContain(`pnpm intake ${branch}`);
      // Nothing was deleted.
      expect(porcelainHasWorktree(root, worktree)).toBe(true);
      expect(existsSync(join(worktree, "deliverable.txt"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("BLOCKS a worktree with only untracked (non-ignored) work", () => {
    const root = makeRepo();
    try {
      const { worktree } = makeLaneFixture(root, "untracked");
      // Merge the lane so ONLY the dirty guard — not the merge guard — can block.
      git(root, ["checkout", "master"]);
      git(root, ["merge", "--ff-only", "guard-untracked"]);
      writeFileSync(join(worktree, "scratch.txt"), "untracked work\n", "utf8");

      const blocked = runLaneClose(root, [worktree]);

      expect(blocked.exit).toBe(1);
      expect(blocked.output).toContain("BLOCKED:");
      expect(blocked.output).toContain("scratch.txt");
      expect(porcelainHasWorktree(root, worktree)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("closes a clean merged worktree unaffected by the guard", () => {
    const root = makeRepo();
    try {
      const { worktree } = makeLaneFixture(root, "cleanpath");
      git(root, ["checkout", "master"]);
      git(root, ["merge", "--ff-only", "guard-cleanpath"]);

      const closed = runLaneClose(root, [worktree]);

      expect(closed.exit).toBe(0);
      expect(closed.output).not.toContain("BLOCKED:");
      expect(closed.output).toContain(`worktree removed: ${worktree.replace(/\\/g, "/")}`);
      expect(porcelainHasWorktree(root, worktree)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--force-dirty discards the staged deliverable with a loud echo and closes", () => {
    const root = makeRepo();
    try {
      const { worktree, branch } = makeIncidentFixture(root, "forcedirty");

      const forced = runLaneClose(root, [worktree, "--force-dirty"]);

      expect(forced.exit).toBe(0);
      expect(forced.output).toContain("WARNING: --force-dirty discarding");
      // The abandoned files are echoed loudly before deletion.
      expect(forced.output).toContain("deliverable.txt");
      expect(forced.output).toContain("cannot be recovered");
      // Branch tip == master base, so it deletes and the worktree is gone.
      expect(porcelainHasWorktree(root, worktree)).toBe(false);
      // Merged-to-master (tip == base) branch is cleaned up too.
      expect(git(root, ["branch", "--list", branch])).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

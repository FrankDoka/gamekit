import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Git scratch-repo integration suite — generous timeout to match the sibling
// lane-close suite under parallel gate-battery load.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, ["init", "-b", "master"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Lane Recover Test"]);
  writeFileSync(join(root, "README.md"), "base\n", "utf8");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "base"]);
  return root;
}

/** Add a `codex/card-<lane>` worktree with one lane commit, returning its path. */
function addLaneWorktree(root: string, lane: string): string {
  const branch = `codex/card-${lane}`;
  const worktree = join(root, `wt-${lane}`);
  git(root, ["branch", branch]);
  git(root, ["worktree", "add", worktree, branch]);
  writeFileSync(join(worktree, "work.txt"), `${lane}\n`, "utf8");
  git(worktree, ["add", "work.txt"]);
  git(worktree, ["commit", "-m", "lane work"]);
  return worktree;
}

/**
 * Plant a fake Codex session rollout under <fakeHome>/.codex/sessions whose
 * session_meta header carries the given cwd + thread_id — the exact shape
 * confirmed against a real rollout (payload.cwd + payload.id).
 */
function plantRollout(fakeHome: string, cwd: string, threadId: string): void {
  const dir = join(fakeHome, ".codex", "sessions", "2026", "07", "09");
  mkdirSync(dir, { recursive: true });
  const header = JSON.stringify({
    timestamp: "2026-07-09T00:00:00.000Z",
    type: "session_meta",
    payload: { id: threadId, session_id: "sess-1", cwd, originator: "Codex Desktop" },
  });
  const body = JSON.stringify({ timestamp: "2026-07-09T00:00:01.000Z", type: "event_msg", payload: { type: "task_started" } });
  writeFileSync(join(dir, `rollout-2026-07-09T00-00-00-${threadId}.jsonl`), `${header}\n${body}\n`, "utf8");
}

function runRecover(root: string, fakeHome: string, args: string[]): { exit: number; output: string } {
  const script = join(process.cwd(), "tools", "src", "lane-recover.ts");
  const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const env = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome };
  const result = spawnSync(process.execPath, [tsxCli, script, "--root", root, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { exit: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function lanesJson(root: string): Array<Record<string, unknown>> {
  const p = join(root, "tools", "_lanes", "lanes.json");
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, "utf8"));
}

describe("lane-recover", () => {
  it("DIFF-ONLY (no flag) prints the rebuild and writes nothing (exit 0)", () => {
    const root = makeRepo("gamekit-lane-recover-diff-");
    const fakeHome = mkdtempSync(join(tmpdir(), "gamekit-fakehome-"));
    try {
      const wt = addLaneWorktree(root, "alpha");
      plantRollout(fakeHome, wt, "thread-alpha");

      const res = runRecover(root, fakeHome, []);
      expect(res.exit).toBe(0);
      expect(res.output).toContain("+ alpha");
      expect(res.output).toContain("thread=thread-alpha");
      expect(res.output).toContain("DIFF-ONLY");
      // Nothing written.
      expect(existsSync(join(root, "tools", "_lanes", "lanes.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("rebuilds a LOST lanes.json in one command with --apply, recovering thread_id from the rollout", () => {
    // The s24 incident: lanes.json is empty/lost but the worktree + its Codex
    // rollout survive on disk. One `lane:recover --apply` must reconstruct the
    // entry AND recover its thread_id from session_meta.cwd.
    const root = makeRepo("gamekit-lane-recover-apply-");
    const fakeHome = mkdtempSync(join(tmpdir(), "gamekit-fakehome-"));
    try {
      const wt = addLaneWorktree(root, "beta");
      plantRollout(fakeHome, wt, "thread-beta-999");
      // lanes.json is genuinely lost (does not exist).
      expect(existsSync(join(root, "tools", "_lanes", "lanes.json"))).toBe(false);

      const res = runRecover(root, fakeHome, ["--apply"]);
      expect(res.exit).toBe(0);
      expect(res.output).toContain("APPLIED");

      const entries = lanesJson(root);
      const beta = entries.find((e) => e.lane === "beta");
      expect(beta).toBeTruthy();
      expect(beta?.branch).toBe("codex/card-beta");
      expect(beta?.engine).toBe("codex"); // a recovered thread_id implies codex
      expect(beta?.thread_id).toBe("thread-beta-999");
      expect(String(beta?.worktree).replace(/\\/g, "/")).toBe(wt.replace(/\\/g, "/"));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("marks a worktree with no matching rollout as an agent lane (thread_id null)", () => {
    const root = makeRepo("gamekit-lane-recover-agent-");
    const fakeHome = mkdtempSync(join(tmpdir(), "gamekit-fakehome-"));
    try {
      addLaneWorktree(root, "gamma"); // no rollout planted
      const res = runRecover(root, fakeHome, ["--apply"]);
      expect(res.exit).toBe(0);
      const gamma = lanesJson(root).find((e) => e.lane === "gamma");
      expect(gamma?.engine).toBe("agent");
      expect(gamma?.thread_id).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

/**
 * lane-close git() ENOENT regression. The original bug: `execFileSync("git", …)`
 * does no shell/PATHEXT resolution, so in a spawn env where git is reachable only
 * as `git.cmd` (Windows PATHEXT) or via the shell, the bare call throws
 * `spawnSync git ENOENT` and lane-close BLOCKS at assertPrimaryCwd. The fix retries
 * with shell:true on ENOENT. This drives the REAL lane-close end-to-end under a PATH
 * that contains only a forwarding `git.cmd` shim (no git.exe) — the exact shape.
 */
describe("lane-close git ENOENT fallback (masterplan 1.2)", () => {
  const isWin = process.platform === "win32";

  it.runIf(isWin)("resolves git via the shell fallback when only git.cmd is on PATH", () => {
    const root = makeRepo("gamekit-lane-close-enoent-");
    const shimDir = mkdtempSync(join(tmpdir(), "gamekit-gitshim-"));
    try {
      const realGit = execFileSync("where", ["git"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
      // Forwarding shim: cmd.exe resolves git.cmd via PATHEXT; bare execFile does NOT.
      writeFileSync(join(shimDir, "git.cmd"), `@"${realGit}" %*\r\n`, "utf8");

      // Sanity: this env reproduces the bug shape — plain execFile ENOENTs, shell OK.
      const shimEnv = { ...process.env, PATH: shimDir, Path: shimDir };
      const plain = spawnSync("git", ["--version"], { env: shimEnv, encoding: "utf8" });
      expect((plain.error as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
      const viaShell = spawnSync("git", ["--version"], { env: shimEnv, shell: true, encoding: "utf8" });
      expect(viaShell.status).toBe(0);

      // A merged clean lane so ONLY the git() wrapper (not a guard) decides the outcome.
      const branch = "codex/card-enoent";
      const worktree = join(root, "wt-enoent");
      git(root, ["branch", branch]);
      git(root, ["worktree", "add", worktree, branch]);
      writeFileSync(join(worktree, "w.txt"), "x\n", "utf8");
      git(worktree, ["add", "w.txt"]);
      git(worktree, ["commit", "-m", "lane"]);
      git(root, ["checkout", "master"]);
      git(root, ["merge", "--ff-only", branch]);

      const script = join(process.cwd(), "tools", "src", "lane-close.ts");
      const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
      const env = { ...process.env, PATH: shimDir, Path: shimDir, LANE_CLOSE_PRIMARY_ROOT: root };
      const result = spawnSync(process.execPath, [tsxCli, script, worktree], {
        cwd: root,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      // With the ENOENT fix, lane-close proceeds past assertPrimaryCwd and closes;
      // WITHOUT it, output would contain "primary repo cannot be resolved".
      expect(output).not.toContain("primary repo cannot be resolved");
      expect(result.status).toBe(0);
      expect(output).toContain("worktree removed:");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(shimDir, { recursive: true, force: true });
    }
  });
});

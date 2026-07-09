import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { gameRoot, integrationBranch } from "./toolkit-config.js";

const REUSABLE_WORKTREE = process.env.INTEGRATOR_WORKTREE ?? `${gameRoot()}-integrator`;
const CANONICAL_ROOT = gameRoot();
const IDLE_BRANCH = "codex/integrator-standby";
const MAIN_BRANCH = integrationBranch();

const branch = process.argv[2];
if (!branch) {
  console.error("usage: pnpm integrator:start <codex/task-branch>");
  process.exit(1);
}
if (!branch.startsWith("codex/")) {
  console.error(`integrator:start: branch must use codex/ prefix, got ${branch}`);
  process.exit(1);
}

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const gitQuiet = (cwd: string, args: string[]): boolean => {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

if (!existsSync(REUSABLE_WORKTREE)) {
  console.error(`integrator:start: missing reusable worktree ${REUSABLE_WORKTREE}`);
  process.exit(1);
}

const topLevel = git(REUSABLE_WORKTREE, ["rev-parse", "--show-toplevel"]);
if (topLevel.replace(/\\/g, "/") !== REUSABLE_WORKTREE) {
  console.error(`integrator:start: expected top-level ${REUSABLE_WORKTREE}, got ${topLevel}`);
  process.exit(1);
}

const status = git(REUSABLE_WORKTREE, ["status", "--short"]);
if (status) {
  console.error(`integrator:start: reusable worktree is not clean:\n${status}`);
  process.exit(1);
}

const currentBranch = git(REUSABLE_WORKTREE, ["branch", "--show-current"]);
if (currentBranch !== IDLE_BRANCH) {
  console.error(`integrator:start: reusable worktree must be parked on ${IDLE_BRANCH}, got ${currentBranch}`);
  process.exit(1);
}

if (gitQuiet(REUSABLE_WORKTREE, ["rev-parse", "--verify", branch])) {
  console.error(`integrator:start: branch already exists: ${branch}`);
  process.exit(1);
}

const masterHead = git(CANONICAL_ROOT, ["rev-parse", MAIN_BRANCH]);
const reusableHead = git(REUSABLE_WORKTREE, ["rev-parse", "HEAD"]);
if (masterHead !== reusableHead) {
  console.error(`integrator:start: ${IDLE_BRANCH} is not at current ${MAIN_BRANCH}; run pnpm integrator:park after ${MAIN_BRANCH} is updated`);
  console.error(`  ${MAIN_BRANCH}:   ${masterHead}`);
  console.error(`  reusable: ${reusableHead}`);
  process.exit(1);
}

git(REUSABLE_WORKTREE, ["switch", "-c", branch, MAIN_BRANCH]);
console.log("[integrator:start] ready");
console.log(`  worktree: ${REUSABLE_WORKTREE}`);
console.log(`  branch:   ${branch}`);
console.log(`  status:   ${git(REUSABLE_WORKTREE, ["status", "--short"]) || "clean"}`);
console.log(`  root:     ${git(REUSABLE_WORKTREE, ["rev-parse", "--show-toplevel"])}`);
console.log("Run the edit-target hard stop before editing: pwd, branch, status, top-level.");
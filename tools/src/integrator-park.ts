import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { gameRoot } from "./toolkit-config.js";

const REUSABLE_WORKTREE = process.env.INTEGRATOR_WORKTREE ?? `${gameRoot()}-integrator`;
const IDLE_BRANCH = "codex/integrator-standby";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const gitRun = (cwd: string, args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "inherit" });
};
const gitQuiet = (cwd: string, args: string[]): boolean => {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

if (!existsSync(REUSABLE_WORKTREE)) {
  console.error(`integrator:park: missing reusable worktree ${REUSABLE_WORKTREE}`);
  process.exit(1);
}

const topLevel = git(REUSABLE_WORKTREE, ["rev-parse", "--show-toplevel"]);
if (topLevel.replace(/\\/g, "/") !== REUSABLE_WORKTREE) {
  console.error(`integrator:park: expected top-level ${REUSABLE_WORKTREE}, got ${topLevel}`);
  process.exit(1);
}

const status = git(REUSABLE_WORKTREE, ["status", "--short"]);
if (status) {
  console.error(`integrator:park: reusable worktree is not clean:\n${status}`);
  process.exit(1);
}

const currentBranch = git(REUSABLE_WORKTREE, ["branch", "--show-current"]);
if (currentBranch !== IDLE_BRANCH) {
  if (!gitQuiet(REUSABLE_WORKTREE, ["merge-base", "--is-ancestor", currentBranch, "master"])) {
    console.error(`integrator:park: ${currentBranch} is not merged into master; merge before parking`);
    process.exit(1);
  }
  gitRun(REUSABLE_WORKTREE, ["switch", IDLE_BRANCH]);
}

gitRun(REUSABLE_WORKTREE, ["merge", "--ff-only", "master"]);
if (currentBranch !== IDLE_BRANCH) {
  gitRun(REUSABLE_WORKTREE, ["branch", "-d", currentBranch]);
}
const finalStatus = git(REUSABLE_WORKTREE, ["status", "--short"]);
if (finalStatus) {
  console.error(`integrator:park: worktree became dirty:\n${finalStatus}`);
  process.exit(1);
}
console.log("[integrator:park] parked");
console.log(`  worktree: ${REUSABLE_WORKTREE}`);
console.log(`  branch:   ${git(REUSABLE_WORKTREE, ["branch", "--show-current"])}`);
console.log(`  head:     ${git(REUSABLE_WORKTREE, ["rev-parse", "--short", "HEAD"])}`);
console.log("  status:   clean");


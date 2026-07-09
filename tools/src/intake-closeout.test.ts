import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeLaneRegistry } from "./lane-registry";
import type { LaneEntry } from "./lane-registry";

// Git scratch-repo integration suite: generous timeout — these time out under
// parallel lane gate-battery load (2x flaked 2026-07-07: lane-close, lanes-dead).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const TSX = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const INTAKE = join(process.cwd(), "tools", "src", "intake.ts");
const SECURITY_SCAN = join(process.cwd(), "tools", "src", "lane-security-scan.ts");
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const roots: string[] = [];

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function writePackage(root: string): void {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        scripts: {
          validate: "node -e \"console.log('validate ok')\"",
          typecheck: "node -e \"console.log('typecheck ok')\"",
          test: "node -e \"console.log('test ok')\"",
          "build:client": "node -e \"console.log('build ok')\"",
          "smoke:client": "node -e \"setTimeout(()=>{},0)\"",
          "lane:security-scan": `node ${JSON.stringify(TSX)} ${JSON.stringify(SECURITY_SCAN)}`,
          intake: `node ${JSON.stringify(TSX)} ${JSON.stringify(INTAKE)}`,
        },
        devDependencies: {},
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

// cardBody is written as the tracked card file at the initial commit, so it
// lands on the lane branch (and thus in the worktree checkout intake reads).
function makePrimary(name: string, cardBody: string): string {
  const root = mkdtempSync(join(tmpdir(), `gamekit-closeout-${name}-`));
  roots.push(root);
  git(root, ["init", "-b", "master"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Closeout Test"]);
  writeFileSync(join(root, "README.md"), "fixture\n", "utf8");
  writePackage(root);
  mkdirSync(join(root, "docs", "tasks"), { recursive: true });
  writeFileSync(join(root, "docs", "tasks", "card-fixture.md"), cardBody, "utf8");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture"]);
  return root;
}

function makeLane(primary: string, lane = "fixture"): string {
  const branch = `codex/card-${lane}`;
  git(primary, ["branch", branch]);
  const worktree = join(primary, "..", `${lane}-wt-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  git(primary, ["worktree", "add", worktree, branch]);
  roots.push(worktree);
  const entry: LaneEntry = {
    lane,
    branch,
    worktree,
    engine: "codex",
    thread_id: "fixture-thread",
    state: "ready",
    card: "docs/tasks/card-fixture.md",
    boxes_total: 1,
    boxes_checked: 0,
    reviewed_tip: null,
    updated_at: "2026-07-07T00:00:00.000Z",
  };
  writeLaneRegistry(primary, [entry]);
  return worktree;
}

function runIntake(primary: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(PNPM, ["intake", "fixture"], {
    cwd: primary,
    env: { ...process.env, ...extraEnv, INTAKE_PRIMARY_ROOT: primary, INTAKE_SKIP_REBASE: "1", INTAKE_LOCK_TIMEOUT_MS: "30000" },
    encoding: "utf8",
    shell: process.platform === "win32",
  });
}

function verdict(primary: string) {
  return JSON.parse(readFileSync(join(primary, "tools", "_lanes", "fixture-intake.json"), "utf8")) as {
    commit: { created: boolean; hash: string | null };
    gates: Array<{ name: string; status: string; output_tail?: string }>;
    security_scan: { status: string } | null;
  };
}

afterEach(() => {
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

const NO_CLOSEOUT = "# fixture\n\n## Gates\n\n- [ ] fixture\n";
const CLOSEOUT_UNCHECKED = "# fixture\n\n## Gates\n\n- [ ] fixture\n\n## Closeout\n\n- [ ] not yet done\n";
const CLOSEOUT_FILLED = "# fixture\n\n## Gates\n\n- [ ] fixture\n\n## Closeout\n\n- [x] fixture closeout filled\n";

describe("intake closeout-presence gate", () => {
  it("BLOCKS with exit 2 when the branch card has no ## Closeout section", () => {
    const primary = makePrimary("no-closeout", NO_CLOSEOUT);
    const worktree = makeLane(primary);
    writeFileSync(join(worktree, "change.txt"), "changed\n", "utf8");
    writeFileSync(join(worktree, ".commit-msg.txt"), "Build(tooling): fixture no closeout\n\nTask: TEST\n", "utf8");

    const result = runIntake(primary);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("missing closeout — return-contract violation");
    expect(result.stderr).toContain("docs/tasks/card-fixture.md");
    expect(result.stderr).toContain("no ## Closeout section");
    const data = verdict(primary);
    expect(data.gates).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "card closeout present", status: "fail" })]),
    );
    // rebase/gates never ran past the fail-closed leg
    expect(data.gates.map((gate) => gate.name)).not.toContain("pnpm validate");
  }, 30000);

  it("BLOCKS with exit 2 when the closeout heading exists but has no checked box", () => {
    const primary = makePrimary("unchecked", CLOSEOUT_UNCHECKED);
    const worktree = makeLane(primary);
    writeFileSync(join(worktree, "change.txt"), "changed\n", "utf8");
    writeFileSync(join(worktree, ".commit-msg.txt"), "Build(tooling): fixture unchecked closeout\n\nTask: TEST\n", "utf8");

    const result = runIntake(primary);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("missing closeout — return-contract violation");
    expect(result.stderr).toContain("no checked box");
    expect(verdict(primary).commit.created).toBe(true); // commit happens before the gate; nothing merges past it
  }, 30000);

  it("PASSES the closeout leg when the branch card has a checked closeout box", () => {
    const primary = makePrimary("filled", CLOSEOUT_FILLED);
    const worktree = makeLane(primary);
    writeFileSync(join(worktree, "change.txt"), "changed\n", "utf8");
    writeFileSync(join(worktree, ".commit-msg.txt"), "Build(tooling): fixture filled closeout\n\nTask: TEST\n", "utf8");

    const result = runIntake(primary);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const data = verdict(primary);
    expect(data.gates).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "card closeout present", status: "pass" })]),
    );
    expect(data.gates.map((gate) => [gate.name, gate.status])).toEqual(
      expect.arrayContaining([
        ["pnpm validate", "pass"],
        ["pnpm test", "pass"],
      ]),
    );
    expect(data.security_scan?.status).toBe("pass");
  }, 30000);

  it("skips the closeout leg with a loud echo when GAMEKIT_INTAKE_CLOSEOUT_SKIP=1", () => {
    const primary = makePrimary("skip", NO_CLOSEOUT);
    const worktree = makeLane(primary);
    writeFileSync(join(worktree, "change.txt"), "changed\n", "utf8");
    writeFileSync(join(worktree, ".commit-msg.txt"), "Build(tooling): fixture skip closeout\n\nTask: TEST\n", "utf8");

    const result = runIntake(primary, { GAMEKIT_INTAKE_CLOSEOUT_SKIP: "1" });

    const data = verdict(primary);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toContain("GAMEKIT_INTAKE_CLOSEOUT_SKIP=1");
    expect(data.gates).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "card closeout present", status: "skip" })]),
    );
  }, 30000);
});

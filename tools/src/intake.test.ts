import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeLaneRegistry } from "./lane-registry";
import type { LaneEntry } from "./lane-registry";

const TSX = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const INTAKE = join(process.cwd(), "tools", "src", "intake.ts");
const SECURITY_SCAN = join(process.cwd(), "tools", "src", "lane-security-scan.ts");
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const roots: string[] = [];

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makePrimary(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `gamekit-intake-${name}-`));
  roots.push(root);
  git(root, ["init", "-b", "master"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Intake Test"]);
  writeFileSync(join(root, "README.md"), "fixture\n", "utf8");
  writePackage(root, 0);
  mkdirSync(join(root, "docs", "tasks"), { recursive: true });
  writeFileSync(
    join(root, "docs", "tasks", "card-fixture.md"),
    "# fixture\n\n## Gates\n\n- [ ] fixture\n\n## Closeout\n\n- [x] fixture closeout filled\n",
    "utf8",
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture"]);
  return root;
}

function writePackage(root: string, smokeDelayMs: number): void {
  const sleep = `node -e "setTimeout(()=>{},${smokeDelayMs})"`;
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
          "smoke:client": sleep,
          "capture:zone":
            "node -e \"const fs=require('fs');fs.mkdirSync(process.argv[1],{recursive:true});fs.writeFileSync(process.argv[1]+'/proof-ran.txt',process.argv.slice(2).join(' ')+'\\n')\"",
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

function makeLane(primary: string, lane = "fixture"): { worktree: string; entry: LaneEntry } {
  const branch = `codex/card-${lane}`;
  git(primary, ["branch", branch]);
  const worktree = join(primary, "..", `${lane}-worktree-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
    updated_at: "2026-07-06T00:00:00.000Z",
  };
  writeLaneRegistry(primary, [entry]);
  return { worktree, entry };
}

function installB3Hook(worktree: string, message: string): void {
  mkdirSync(join(worktree, "hooks"), { recursive: true });
  writeFileSync(
    join(worktree, "hooks", "pre-commit"),
    `#!/bin/sh
if [ ! -f tools/_capture-intake-b3/proof-ran.txt ]; then
  echo "${message}" >&2
  exit 1
fi
exit 0
`,
    "utf8",
  );
  chmodSync(join(worktree, "hooks", "pre-commit"), 0o755);
  git(worktree, ["config", "core.hooksPath", "hooks"]);
}

function writeFakeProofLeg(worktree: string): string {
  const proofScript = join(worktree, "fake-b3-proof.cjs").replace(/\\/g, "/");
  writeFileSync(
    proofScript,
    `const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
mkdirSync("tools/_capture-intake-b3", { recursive: true });
writeFileSync("tools/_capture-intake-b3/proof-ran.txt", "ran\\n");
appendFileSync("tools/_capture-intake-b3/proof.log", process.argv.slice(2).join(" ") + "\\n");
`,
    "utf8",
  );
  return `node "${proofScript}"`;
}

function runIntake(cwd: string, primary: string, lane = "fixture", extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(PNPM, ["intake", lane], {
    cwd,
    env: { ...process.env, ...extraEnv, INTAKE_PRIMARY_ROOT: primary, INTAKE_SKIP_REBASE: "1", INTAKE_LOCK_TIMEOUT_MS: "30000" },
    encoding: "utf8",
    shell: process.platform === "win32",
  });
}

function verdict(primary: string, lane = "fixture") {
  return JSON.parse(readFileSync(join(primary, "tools", "_lanes", `${lane}-intake.json`), "utf8")) as {
    commit: { created: boolean; hash: string | null };
    gates: Array<{ name: string; status: string; output_tail?: string; started_at?: string; finished_at?: string }>;
    security_scan: { status: string } | null;
  };
}

afterEach(() => {
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("intake one-shot", () => {
  it("commits staged work from .commit-msg.txt and writes the verdict shape", () => {
    const primary = makePrimary("commit");
    const { worktree } = makeLane(primary);
    writeFileSync(join(worktree, "change.txt"), "changed\n", "utf8");
    writeFileSync(join(worktree, ".commit-msg.txt"), "Build(tooling): fixture commit\n\nTask: TEST\n", "utf8");

    const result = runIntake(primary, primary);

    expect(result.status).toBe(0);
    const data = verdict(primary);
    expect(data.commit.created).toBe(true);
    expect(data.commit.hash).toMatch(/^[a-f0-9]{40}$/);
    expect(data.gates.map((gate) => [gate.name, gate.status])).toEqual(
      expect.arrayContaining([
        ["complete-from-staged", "pass"],
        ["pnpm validate", "pass"],
        ["pnpm -r typecheck", "pass"],
        ["pnpm test", "pass"],
        ["pnpm build:client", "pass"],
        ["pnpm smoke:client", "pass"],
      ]),
    );
    expect(data.security_scan?.status).toBe("pass");
  }, 30000);

  it("stops with exit 2 when work exists without .commit-msg.txt", () => {
    const primary = makePrimary("no-message");
    const { worktree } = makeLane(primary);
    writeFileSync(join(worktree, "change.txt"), "changed\n", "utf8");

    const result = runIntake(primary, primary);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(".commit-msg.txt is missing");
    expect(verdict(primary).commit.created).toBe(false);
  }, 30000);

  it("blocks when the lane closeout cites a missing capture artifact", () => {
    const primary = makePrimary("missing-closeout-artifact");
    const { worktree } = makeLane(primary);
    writeFileSync(
      join(worktree, "docs", "tasks", "card-fixture.md"),
      "# fixture\n\n## Closeout\n\nProof: tools/_capture-deleted/proof.png\n",
      "utf8",
    );
    writeFileSync(join(worktree, "change.txt"), "changed\n", "utf8");
    writeFileSync(join(worktree, ".commit-msg.txt"), "Build(tooling): fixture closeout artifact\n\nTask: TEST\n", "utf8");

    const result = runIntake(primary, primary);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("closeout cites missing capture artifact");
    expect(result.stderr).toContain("tools/_capture-deleted/proof.png");
    const data = verdict(primary);
    expect(data.commit.created).toBe(false);
    expect(data.gates).toEqual(expect.arrayContaining([expect.objectContaining({ name: "closeout capture artifacts exist", status: "fail" })]));
  }, 30000);

  it("allows missing closeout artifacts only with the loud escape hatch", () => {
    const primary = makePrimary("missing-closeout-artifact-escape");
    const { worktree } = makeLane(primary);
    writeFileSync(
      join(worktree, "docs", "tasks", "card-fixture.md"),
      "# fixture\n\n## Closeout\n\n- [x] filled\n\nProof: tools/_capture-deleted/proof.png\n",
      "utf8",
    );
    writeFileSync(join(worktree, "change.txt"), "changed\n", "utf8");
    writeFileSync(join(worktree, ".commit-msg.txt"), "Build(tooling): fixture closeout artifact escape\n\nTask: TEST\n", "utf8");

    const result = runIntake(primary, primary, "fixture", { INTAKE_ALLOW_MISSING_CLOSEOUT_ARTIFACTS: "1" });

    const data = verdict(primary);
    expect(result.status, `${result.stdout}\n${result.stderr}\n${JSON.stringify(data, null, 2)}`).toBe(0);
    expect(result.stderr).toContain("INTAKE_ALLOW_MISSING_CLOSEOUT_ARTIFACTS=1");
    expect(data.commit.created).toBe(true);
    expect(data.gates).toEqual(expect.arrayContaining([expect.objectContaining({ name: "closeout capture artifacts exist", status: "skip" })]));
  }, 30000);

  it.each([
    [
      "freshness from Gates",
      "BLOCKED (B3 visual proof): no capture artifact is newer than the staged files",
      (_worktree: string) => ({
        cardText: "# fixture\n\n## Gates\n\n- [ ] pnpm capture:zone tools/_capture-fixture --fake-proof\n",
        proofRan: "--fake-proof\n",
        proofLog: null,
      }),
    ],
    [
      "hash from explicit Proof leg",
      "BLOCKED (B3 visual proof): no content-hashed visual proof matches staged files",
      (worktree: string) => {
        const proofLeg = writeFakeProofLeg(worktree);
        return {
          cardText: `# fixture\n\n**Proof leg:** ${proofLeg}\n\n## Gates\n\n- [ ] fixture\n`,
          proofRan: "ran\n",
          proofLog: "\n",
        };
      },
    ],
  ])("runs the card proof leg once and retries a B3 %s commit failure", (_name, message, cardFixture) => {
    const primary = makePrimary(`b3-${_name}`);
    const { worktree } = makeLane(primary);
    const { cardText, proofRan, proofLog } = cardFixture(worktree);
    writeFileSync(join(primary, "docs", "tasks", "card-fixture.md"), cardText, "utf8");
    installB3Hook(worktree, message);
    writeFileSync(join(worktree, "change.txt"), "changed\n", "utf8");
    writeFileSync(join(worktree, ".commit-msg.txt"), "Build(tooling): fixture B3 retry\n\nTask: TEST\n", "utf8");

    const result = runIntake(primary, primary);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[intake] B3 auto-proof: running");
    expect(readFileSync(join(worktree, "tools", "_capture-intake-b3", "proof-ran.txt"), "utf8")).toBe(proofRan);
    if (proofLog !== null) expect(readFileSync(join(worktree, "tools", "_capture-intake-b3", "proof.log"), "utf8")).toBe(proofLog);
    const data = verdict(primary);
    expect(data.gates.map((gate) => [gate.name, gate.status])).toEqual(
      expect.arrayContaining([
        ["B3 auto-proof", "pass"],
        ["complete-from-staged", "pass"],
      ]),
    );
    expect(git(worktree, ["log", "-1", "--format=%s"])).toBe("Build(tooling): fixture B3 retry");
  }, 30000);

  it("refuses when run from a lane worktree instead of the primary cwd", () => {
    const primary = makePrimary("non-primary");
    const { worktree } = makeLane(primary);

    const result = runIntake(worktree, primary);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("intake must run from the primary repo worktree");
    expect(existsSync(join(primary, "tools", "_lanes", "fixture-intake.json"))).toBe(false);
  }, 30000);

  it("serializes concurrent smoke legs with the smoke lock", async () => {
    const primary = makePrimary("smoke-lock");
    writePackage(primary, 1200);
    git(primary, ["add", "package.json"]);
    git(primary, ["commit", "-m", "slow smoke"]);
    makeLane(primary);

    const env = { ...process.env, INTAKE_PRIMARY_ROOT: primary, INTAKE_SKIP_REBASE: "1", INTAKE_LOCK_TIMEOUT_MS: "30000" };
    const first = spawn(PNPM, ["intake", "fixture"], { cwd: primary, env, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = spawn(PNPM, ["intake", "fixture"], { cwd: primary, env, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });

    const collect = (child: ReturnType<typeof spawn>) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => (stdout += chunk));
        child.stderr?.on("data", (chunk) => (stderr += chunk));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });

    const [a, b] = await Promise.all([collect(first), collect(second)]);

    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    const combined = `${a.stdout}\n${b.stdout}`;
    expect(combined).toContain("waiting for smoke lock");
    const data = verdict(primary);
    const smoke = data.gates.find((gate) => gate.name === "pnpm smoke:client");
    expect(smoke?.started_at).toBeTruthy();
    expect(smoke?.finished_at).toBeTruthy();
  }, 30000);
});

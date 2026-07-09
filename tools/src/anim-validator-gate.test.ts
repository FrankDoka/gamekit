import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateAnimValidatorArtifacts, isAnimationSheet, requiredArtifactsFor } from "./anim-validator-gate";
import { writeLaneRegistry } from "./lane-registry";
import type { LaneEntry } from "./lane-registry";

const TSX = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const INTAKE = join(process.cwd(), "tools", "src", "intake.ts");
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("isAnimationSheet", () => {
  it.each([
    ["assets/sources/accepted/player_baldbase/sit/imagegen-b4/runtime/player_baldbase_sit.clean.png", true],
    ["client/public/assets/sprites/player_blackhair_cel_gather_east_256.png", true],
    ["client/public/assets/sprites/player_blackhair_cel_idle_east_256.webp", true],
    ["client/public/assets/sprites/monster_meadow_slime_attack_side_imagegen_pilot.png", true],
    ["assets/sources/accepted/player_baldbase/heavy_2h/imagegen-b2/player_baldbase_heavy_2h.webp", true],
    // artifacts-for-the-artifact must never recurse the gate
    ["client/public/assets/sprites/player_blackhair_cel_gather_east_256.panel.png", false],
    ["assets/sources/accepted/player_baldbase/sit/imagegen-b4/runtime/player_baldbase_sit.clean.panel.png", false],
    // neighbors that are not the sheet
    ["assets/sources/accepted/player_baldbase/sit/imagegen-b4/preview/player_baldbase_sit_contact-broad.png", false],
    ["assets/sources/accepted/player_baldbase/sit/imagegen-b4/frames/source-all/f00.png", false],
    ["assets/sources/accepted/player_baldbase/sit/imagegen-b4/raw/player_baldbase_sit_raw-board-anchor.png", false],
    ["client/public/assets/sprites/portrait_mage.png", false],
    ["client/public/assets/sprites/player_blackhair_cel_gather_east_256.metadata.json", false],
    // qa/reports/preview dirs hold proof/comparison images, never sheets
    // (lr3 bite 2026-07-07: same-framing pair flagged as a sheet)
    ["assets/sources/accepted/player_blackhair_cel/gather/imagegen-oneoff-20260707/qa/idle-vs-gather-same-framing-pair.png", false],
    ["assets/sources/accepted/player_baldbase/swing_1h/video-pilot-20260707/reports/frames-qa-action.png", false],
    ["assets/sources/accepted/player_baldbase/sit/imagegen-b4/qa/player_baldbase_sit.clean.png", false],
    // outside the gated roots
    ["docs/img/attack_flow.png", false],
    ["tools/asset-cleanup/fixtures/b4-negative/player_baldbase_sit.clean.png", false],
  ])("%s -> %s", (path, expected) => {
    expect(isAnimationSheet(path)).toBe(expected);
  });
});

describe("evaluateAnimValidatorArtifacts", () => {
  function scratchWorktree(): string {
    const root = mkdtempSync(join(tmpdir(), "gamekit-anim-gate-"));
    roots.push(root);
    return root;
  }

  const SHEET = "client/public/assets/sprites/monster_test_attack_side.png";

  function writeArtifacts(root: string, result: string): string[] {
    const { motionArc, identityPalette, opaqueRing, panel } = requiredArtifactsFor(SHEET);
    for (const artifact of [motionArc, identityPalette, opaqueRing]) {
      mkdirSync(dirname(join(root, artifact)), { recursive: true });
      writeFileSync(join(root, artifact), JSON.stringify({ result }), "utf8");
    }
    writeFileSync(join(root, panel), "png-bytes", "utf8");
    return [motionArc, identityPalette, opaqueRing, panel];
  }

  it("passes when no staged file is an animation sheet", () => {
    const result = evaluateAnimValidatorArtifacts(scratchWorktree(), ["shared/src/slate.ts", "docs/x.md"]);
    expect(result.sheets).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("reports all four artifacts missing for a bare staged sheet", () => {
    const result = evaluateAnimValidatorArtifacts(scratchWorktree(), [SHEET]);
    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(4);
    expect(result.findings.every((f) => f.problem === "not staged")).toBe(true);
  });

  it("fails closed when a staged verdict is not PASS", () => {
    const root = scratchWorktree();
    const artifacts = writeArtifacts(root, "FAIL");
    const result = evaluateAnimValidatorArtifacts(root, [SHEET, ...artifacts]);
    expect(result.ok).toBe(false);
    // motion-arc + identity-palette + opaque-ring verdicts all fail closed on non-PASS.
    expect(result.findings.map((f) => f.problem)).toEqual([
      "verdict not PASS",
      "verdict not PASS",
      "verdict not PASS",
    ]);
  });

  it("fails closed when a staged verdict is unreadable or missing on disk", () => {
    const root = scratchWorktree();
    const artifacts = writeArtifacts(root, "PASS");
    writeFileSync(join(root, artifacts[0]), "not json", "utf8");
    rmSync(join(root, artifacts[3]));
    const result = evaluateAnimValidatorArtifacts(root, [SHEET, ...artifacts]);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.problem)).toEqual(["unreadable verdict", "missing on disk"]);
  });

  it("passes with all three PASS verdicts and the panel staged", () => {
    const root = scratchWorktree();
    const artifacts = writeArtifacts(root, "PASS");
    const result = evaluateAnimValidatorArtifacts(root, [SHEET, ...artifacts]);
    expect(result.sheets).toEqual([SHEET]);
    expect(result.ok).toBe(true);
  });
});

describe("intake animation gate end-to-end", () => {
  function git(root: string, args: string[]): string {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  }

  function makePrimary(): string {
    const root = mkdtempSync(join(tmpdir(), "gamekit-anim-intake-"));
    roots.push(root);
    git(root, ["init", "-b", "master"]);
    git(root, ["config", "user.email", "test@example.invalid"]);
    git(root, ["config", "user.name", "Anim Gate Test"]);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        scripts: {
          validate: "node -e \"console.log('validate ok')\"",
          typecheck: "node -e \"console.log('typecheck ok')\"",
          test: "node -e \"console.log('test ok')\"",
          "build:client": "node -e \"console.log('build ok')\"",
          "smoke:client": "node -e \"console.log('smoke ok')\"",
          "lane:security-scan": "node -e \"console.log('scan ok')\"",
          intake: `node ${JSON.stringify(TSX)} ${JSON.stringify(INTAKE)}`,
        },
      }) + "\n",
      "utf8",
    );
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

  function makeLane(primary: string): string {
    git(primary, ["branch", "codex/card-fixture"]);
    const worktree = join(primary, "..", `anim-gate-worktree-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    git(primary, ["worktree", "add", worktree, "codex/card-fixture"]);
    roots.push(worktree);
    const entry: LaneEntry = {
      lane: "fixture",
      branch: "codex/card-fixture",
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

  function stageSheet(worktree: string, withArtifacts: boolean): void {
    const sheet = join(worktree, "client", "public", "assets", "sprites", "monster_test_attack_side.png");
    mkdirSync(dirname(sheet), { recursive: true });
    writeFileSync(sheet, "sheet-bytes", "utf8");
    if (withArtifacts) {
      writeFileSync(sheet.replace(/\.png$/, ".motion-arc-verdict.json"), JSON.stringify({ result: "PASS" }), "utf8");
      writeFileSync(sheet.replace(/\.png$/, ".identity-palette-verdict.json"), JSON.stringify({ result: "PASS" }), "utf8");
      writeFileSync(sheet.replace(/\.png$/, ".opaque-ring-verdict.json"), JSON.stringify({ result: "PASS" }), "utf8");
      writeFileSync(sheet.replace(/\.png$/, ".panel.png"), "panel-bytes", "utf8");
    }
    writeFileSync(join(worktree, ".commit-msg.txt"), "Content(art): fixture sheet\n\nTask: TEST\n", "utf8");
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
      commit: { created: boolean };
      gates: Array<{ name: string; status: string }>;
    };
  }

  it("blocks a staged animation sheet without the four artifacts", () => {
    const primary = makePrimary();
    const worktree = makeLane(primary);
    stageSheet(worktree, false);

    const result = runIntake(primary);

    expect(result.status).toBe(4);
    expect(result.stderr).toContain("missing animation validator artifacts");
    expect(result.stderr).toContain("monster_test_attack_side.motion-arc-verdict.json");
    const data = verdict(primary);
    expect(data.commit.created).toBe(false);
    expect(data.gates).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "animation validator artifacts", status: "fail" })]),
    );
  }, 30000);

  it("commits when all four artifacts are staged alongside the sheet", () => {
    const primary = makePrimary();
    const worktree = makeLane(primary);
    stageSheet(worktree, true);

    const result = runIntake(primary);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const data = verdict(primary);
    expect(data.commit.created).toBe(true);
    expect(data.gates).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "animation validator artifacts", status: "pass" })]),
    );
  }, 30000);

  it("skips only with the loud GAMEKIT_ANIM_VALIDATORS_SKIP=1 escape hatch", () => {
    const primary = makePrimary();
    const worktree = makeLane(primary);
    stageSheet(worktree, false);

    const result = runIntake(primary, { GAMEKIT_ANIM_VALIDATORS_SKIP: "1" });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toContain("GAMEKIT_ANIM_VALIDATORS_SKIP=1");
    const data = verdict(primary);
    expect(data.commit.created).toBe(true);
    expect(data.gates).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "animation validator artifacts", status: "skip" })]),
    );
  }, 30000);
});

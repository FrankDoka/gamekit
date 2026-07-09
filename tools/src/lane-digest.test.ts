import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyLaneCard, generateLaneDigest, verifyDigestAnchors } from "./lane-digest";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeFixtureRepo(): { root: string; card: string } {
  const root = mkdtempSync(join(tmpdir(), "gamekit-lane-digest-"));
  mkdirSync(join(root, "docs", "state"), { recursive: true });
  mkdirSync(join(root, "docs", "architecture"), { recursive: true });
  mkdirSync(join(root, "docs", "pipelines"), { recursive: true });
  mkdirSync(join(root, "docs", "tasks"), { recursive: true });
  writeFileSync(
    join(root, "AGENTS.md"),
    [
      "# AGENTS.md",
      "## Mandatory Checks",
      "- **Before editing ANY file, run `git worktree list` and check active-sessions.**",
      "- **Edit-target hard stop:** confirm pwd, branch, status, and top-level.",
      "- **Quantify before diagnosing; cite before claiming.**",
      "## Working Modes",
      "| Mode | Use for | Typical output |",
      "| --- | --- | --- |",
      "| Build | client/server/shared/tool code and tests | code, validation passing |",
      "## Gates Before MVP-0",
      "1. Validation passes, or the missing validation is specifically blocked and explained.",
      "## Change Discipline",
      "- Preserve user and other-agent changes. Do not revert unrelated work.",
      "## Git",
      "For any commit, use the project commit template.",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(root, "docs", "state", "session-brief.md"),
    [
      "# Session Brief",
      "## Current Snapshot",
      "- Normal gate: `pnpm validate`; run `pnpm session:check` before closeout.",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(root, "docs", "architecture", "ai-architecture.md"),
    [
      "# AI Architecture",
      "## Token Discipline & Return Contracts",
      "- **Build report (Sonnet / Codex code lane):** <=20 lines; files + line ranges, tests run, verification result, remaining risk.",
      "",
      "**(j) Worker-side token discipline (owner directive 2026-07-06):** workers use",
      "the same context hygiene the integrator does: grep before read, read ranges",
      "not files, never paste file contents or raw logs into reports.",
      "",
      "**(k) Documentation duty travels with the change (owner re-ratified",
      "2026-07-06):** whoever changes behavior updates the canonical doc IN THE SAME",
      "DELIVERABLE; the integrator verifies the doc landed at intake.",
      "",
      "2. **Card contract.** Every card has gates and at READY: rebase, green gates, STOP -- integrator merges.",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(root, "docs", "pipelines", "animation.md"),
    [
      "# Animation pipeline",
      "### The funnel (video route), in order — every step is executable",
      "",
      "**This list is EXHAUSTIVE — a processing step not listed here is a defect.**",
      "",
      "**Chroma law:** flat cel fields; no palette quantization or dithering ever.",
      "",
      "A speckle COUNT alone is never acceptance; per-frame eyes are the authority.",
      "",
      "Player-body intake additionally requires a canon torso close-up side-by-side.",
      "",
    ].join("\n"),
    "utf8",
  );
  const card = join(root, "docs", "tasks", "card-fixture.md");
  writeFileSync(
    card,
    [
      "# CARD FIXTURE",
      "**Read first:** AGENTS.md · `tools/src/lane-spawn.ts`",
      "**Scope:** Touches `tools/src/example.ts`.",
      "**Gates:**",
      "- [ ] `pnpm -r typecheck` green",
      "",
    ].join("\n"),
    "utf8",
  );
  git(root, ["init", "-b", "master"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Lane Digest Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture"]);
  return { root, card };
}

describe("lane digest", () => {
  it("classifies cards by explicit hint before path/text heuristics", () => {
    expect(classifyLaneCard("docs/tasks/card-any.md", "class: art\nTouches tools/src/foo.ts")).toBe("art");
  });

  // Live-repo assertion: reads a real game card. Skipped in a tools-only template (no game
  // cards present); a wired game with docs/tasks/ re-activates it.
  const editorCard = join(process.cwd(), "docs", "tasks", "card-editor-inspector-semantics.md");
  (existsSync(editorCard) ? it : it.skip)("classifies the editor inspector semantics card as client despite tooling QA references", () => {
    const card = editorCard;
    const text = readFileSync(card, "utf8");

    expect(classifyLaneCard(card, text)).toBe("client");

    const digest = generateLaneDigest({ root: process.cwd(), cardPathAbs: card });
    expect(digest.laneClass).toBe("client");
    expect(digest.text).toContain("LANE BOOT DIGEST (client;");
    expect(digest.text).toContain("Phaser 4 skill must be cited");
    expect(digest.text).toContain("capture:zone <outDir>` with PNG inspection");
  });

  it("keeps a tools-only card classified as tooling", () => {
    expect(
      classifyLaneCard(
        "docs/tasks/card-tooling.md",
        ["# CARD TOOLING", "**Scope:** Touches `tools/src/lane-spawn.ts` and `.githooks/pre-commit`.", ""].join("\n"),
      ),
    ).toBe("tooling");
  });

  it("falls back to code defaults with a loud ambiguous header on tied edit targets", () => {
    const { root, card } = makeFixtureRepo();
    writeFileSync(
      card,
      [
        "# CARD AMBIGUOUS",
        "**Scope:** Touches mixed targets.",
        "Edits `client/src/editor/Foo.ts` and `tools/src/foo.ts`.",
        "**Gates:**",
        "- [ ] `pnpm validate` green",
        "",
      ].join("\n"),
      "utf8",
    );

    const digest = generateLaneDigest({ root, cardPathAbs: card });
    expect(digest.laneClass).toBe("code");
    expect(digest.ambiguousClass).toBe(true);
    expect(digest.text).toContain("LANE BOOT DIGEST (code; class: ambiguous;");
    expect(digest.text).toContain("Class defaults: `pnpm -r typecheck`; `pnpm validate`; add focused tests");
  });

  it("reflects current canonical rule text at generation time", () => {
    const { root, card } = makeFixtureRepo();
    let digest = generateLaneDigest({ root, cardPathAbs: card });
    expect(digest.laneClass).toBe("tooling");
    expect(digest.text).toContain("Preserve user and other-agent changes");

    const agentsPath = join(root, "AGENTS.md");
    writeFileSync(
      agentsPath,
      readFileSync(agentsPath, "utf8").replace("Preserve user and other-agent changes.", "Preserve fixture drift changes."),
      "utf8",
    );
    digest = generateLaneDigest({ root, cardPathAbs: card });
    expect(digest.text).toContain("Preserve fixture drift changes");
  });

  it("fails loudly when a source heading anchor disappears", () => {
    const { root, card } = makeFixtureRepo();
    const agentsPath = join(root, "AGENTS.md");
    writeFileSync(agentsPath, readFileSync(agentsPath, "utf8").replace("## Mandatory Checks", "## Missing Checks"), "utf8");

    expect(() => generateLaneDigest({ root, cardPathAbs: card })).toThrow(/source anchor missing: AGENTS\.md :: ## Mandatory Checks/);
  });

  it("verifyDigestAnchors returns clean against a well-formed fixture repo", () => {
    const { root } = makeFixtureRepo();
    expect(verifyDigestAnchors(root)).toEqual([]);
  });

  it("verifyDigestAnchors reports the missing anchor when a heading is renamed", () => {
    const { root } = makeFixtureRepo();
    const agentsPath = join(root, "AGENTS.md");
    writeFileSync(agentsPath, readFileSync(agentsPath, "utf8").replace("## Mandatory Checks", "## Missing Checks"), "utf8");

    const missing = verifyDigestAnchors(root);
    expect(missing).toContainEqual(expect.stringMatching(/source anchor missing: AGENTS\.md :: ## Mandatory Checks/));
  });

  it("verifyDigestAnchors reports the missing rule bullet when a rule line is reworded", () => {
    const { root } = makeFixtureRepo();
    const briefPath = join(root, "docs", "state", "session-brief.md");
    writeFileSync(briefPath, readFileSync(briefPath, "utf8").replace("Normal gate:", "Standard gate:"), "utf8");

    const missing = verifyDigestAnchors(root);
    expect(missing).toContainEqual(
      expect.stringMatching(/rule pattern missing in docs\/state\/session-brief\.md :: ## Current Snapshot/),
    );
  });

  // Live-repo drift guard: checks the real repo's boot-digest anchors. Skipped in a tools-only
  // template (no game state docs); a wired game with docs/state/session-brief.md re-activates it.
  (existsSync(join(process.cwd(), "docs", "state", "session-brief.md")) ? it : it.skip)("verifyDigestAnchors is empty against the live repo docs today", () => {
    // vitest runs from the repo root, so process.cwd() is the live repo. If any anchored
    // heading/bullet ever drifts in the real docs, this fails here AND in `pnpm validate`.
    expect(verifyDigestAnchors(process.cwd())).toEqual([]);
  });
});

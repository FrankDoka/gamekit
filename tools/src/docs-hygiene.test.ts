import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOT_DOC_BUDGETS, findRetiredTermNotes } from "./docs-hygiene";

const DOCS_BUDGET = join(__dirname, "docs-budget.ts");
const TSX = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

// Runs docs-budget.ts against a throwaway ROOT via cwd. Returns stdout + exitCode.
function runBudget(root: string): { stdout: string; exitCode: number } {
  const result = spawnSync(process.execPath, [TSX, DOCS_BUDGET], {
    cwd: root,
    encoding: "utf8",
  });
  return { stdout: `${result.stdout ?? ""}${result.stderr ?? ""}`, exitCode: result.status ?? 1 };
}

// Builds a minimal fixture repo: every HOT_DOC exists at ~50% of its budget so
// nothing warns/fails by default. Callers then overwrite specific docs.
function makeFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gamekit-docs-hygiene-"));
  for (const [relPath, budget] of Object.entries(HOT_DOC_BUDGETS)) {
    writeDoc(root, relPath, "x".repeat(budget * 4 * 0.5));
  }
  return root;
}

function writeDoc(root: string, relPath: string, body: string): void {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
}

// Sizes body text so estimateTokens(body) ~= Math.round(budget * fraction).
function docAtFraction(budget: number, fraction: number): string {
  return "x".repeat(Math.round(budget * fraction) * 4);
}

describe("findRetiredTermNotes", () => {
  it("warns on an unmarked retired term", () => {
    const notes = findRetiredTermNotes("The CodeBoss engine handles all lanes.");
    expect(notes).toHaveLength(1);
    expect(notes[0].match).toBe("CodeBoss");
  });

  it("does not warn when a SUPERSEDED marker is adjacent", () => {
    const text = ["## History (SUPERSEDED 2026-07-08)", "The CodeBoss engine is gone."].join("\n");
    expect(findRetiredTermNotes(text)).toHaveLength(0);
  });

  it("does not warn when a RETIRED marker is on the same line", () => {
    expect(findRetiredTermNotes("CodeBoss RETIRED 2026-07-08.")).toHaveLength(0);
  });

  it("warns on sonnet-default phrasings but NOT bare 'sonnet 5'", () => {
    expect(findRetiredTermNotes("replaces sonnet-5 default everywhere")).toHaveLength(1);
    expect(findRetiredTermNotes("Sonnet 5 unused; Fable subagents forbidden")).toHaveLength(0);
  });

  it("warns on 50/50 split but excludes 80/20 (live lane-MIX rule)", () => {
    expect(findRetiredTermNotes("Earlier we ran a 50/50 split.")).toHaveLength(1);
    expect(findRetiredTermNotes("the 80/20 commercial-lead split governs the lane MIX")).toHaveLength(0);
  });
});

describe("docs:budget WARN band", () => {
  it("prints WARN for a doc at 93% of ceiling and stays exit 0", () => {
    const root = makeFixtureRoot();
    const target = "docs/state/session-brief.md";
    writeDoc(root, target, docAtFraction(HOT_DOC_BUDGETS[target], 0.93));
    const { stdout, exitCode } = runBudget(root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("WARN");
    expect(stdout).toMatch(/within \d+% of ceiling/);
  });

  it("emits a retired-term WARN and stays exit 0", () => {
    const root = makeFixtureRoot();
    writeDoc(root, "CLAUDE.md", "The CodeBoss engine still runs the lanes here.");
    const { stdout, exitCode } = runBudget(root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("WARN retired-term");
    expect(stdout).toContain("CodeBoss");
  });

  it("does NOT emit a retired-term WARN when the term is marked", () => {
    const root = makeFixtureRoot();
    writeDoc(root, "CLAUDE.md", "CodeBoss RETIRED 2026-07-08 — engine removed.");
    const { stdout } = runBudget(root);
    expect(stdout).not.toContain("WARN retired-term");
  });

  it("still exits 1 when a doc is over budget", () => {
    const root = makeFixtureRoot();
    const target = "docs/state/session-brief.md";
    writeDoc(root, target, docAtFraction(HOT_DOC_BUDGETS[target], 1.2));
    const { stdout, exitCode } = runBudget(root);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("OVER");
  });
});

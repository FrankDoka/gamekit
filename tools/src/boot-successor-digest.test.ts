import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROBE_QUESTIONS,
  checkDigest,
  generateBootDigest,
  resolveLatestHandoffHeading,
} from "./boot-successor-digest";

// A well-formed ACTIVE-RULINGS block that answers every probe question. Kept
// minimal but semantically complete so `checkDigest` passes.
const HEALTHY_RULINGS = `**SUCCESSOR LAWS:** the Opus 4.8 seat runs agent lanes;
the agent-lane executor model is Opus 4.8. Codex = imagegen only (no code).
Owner alone calls Fable back to grade; paid video stays Fable-gated (successor
spawns none). Current phase = Phase 1. Successor manual = masterplan-v2.md §6.
The game stays private until the owner says otherwise; repo stays public.`;

// A STALE block: the successor-law paragraph was never written, so the digest
// cannot answer the probe questions -> `--check` must fail closed.
const STALE_RULINGS = `**SOME OLD RULING:** an unrelated content decision that
carries none of the successor governance facts a fresh seat needs.`;

function makeFixtureRepo(activeRulingsBody: string): string {
  const root = mkdtempSync(join(tmpdir(), "boot-digest-fixture-"));
  mkdirSync(join(root, "docs", "state"), { recursive: true });

  const decisions = [
    "# Decisions (ratified)",
    "",
    "Preamble prose.",
    "",
    "## ACTIVE RULINGS (current law — newest first)",
    "",
    activeRulingsBody,
    "",
    "## Older section",
    "",
    "archived stuff",
    "",
  ].join("\n");
  writeFileSync(join(root, "docs", "state", "decisions.md"), decisions, "utf8");

  const handoff = [
    "# Current Handoff",
    "",
    "Preamble routing prose that must be skipped.",
    "History: some links.",
    "",
    "## LATEST BLOCK — resume here",
    "",
    "Do the next queued lane.",
    "",
    "## OLDER BLOCK",
    "",
    "old stuff",
    "",
  ].join("\n");
  writeFileSync(join(root, "docs", "state", "handoff.md"), handoff, "utf8");

  return root;
}

const created: string[] = [];
function fixture(body: string): string {
  const root = makeFixtureRepo(body);
  created.push(root);
  return root;
}

afterEach(() => {
  while (created.length) {
    const root = created.pop()!;
    rmSync(root, { recursive: true, force: true });
  }
});

describe("resolveLatestHandoffHeading", () => {
  it("returns the FIRST '## ' heading after the preamble (not a hardcoded title)", () => {
    const root = fixture(HEALTHY_RULINGS);
    expect(resolveLatestHandoffHeading(root)).toBe("## LATEST BLOCK — resume here");
  });
});

describe("generateBootDigest", () => {
  it("emits all three provenance-stamped sections", () => {
    const root = fixture(HEALTHY_RULINGS);
    const { text } = generateBootDigest(root);
    expect(text).toContain("== CURRENT LAWS ==");
    expect(text).toContain("== WHAT TO DO NOW ==");
    expect(text).toContain("== HOW TO RUN A LANE ==");
    // Each section carries a Provenance stamp.
    expect(text).toMatch(/Provenance: docs\/state\/decisions\.md@.+#[0-9a-f]{12}/);
    expect(text).toMatch(/Provenance: docs\/state\/handoff\.md@.+#[0-9a-f]{12}/);
    expect(text).toMatch(/Provenance: authored-inline@.+#[0-9a-f]{12}/);
  });
});

describe("checkDigest (fail-closed)", () => {
  it("passes on a well-formed fixture that answers every probe question", () => {
    const root = fixture(HEALTHY_RULINGS);
    const { text } = generateBootDigest(root);
    const result = checkDigest(text);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("FAILS CLOSED on a seeded stale-doc fixture (missing successor laws)", () => {
    const root = fixture(STALE_RULINGS);
    const { text } = generateBootDigest(root);
    const result = checkDigest(text);
    expect(result.ok).toBe(false);
    // The named diff must list the unanswerable probe questions.
    expect(result.failures.length).toBeGreaterThan(0);
    const failedIds = new Set(result.failures.map((f) => f.id));
    // These successor governance facts live ONLY in the decisions.md ACTIVE
    // block; a stale block that drops them makes the digest unanswerable for
    // them, so --check fails closed. (executor-model / codex / phase / manual
    // are ALSO carried by the inline HOW-TO-RUN snippet + manual pointer, so
    // the digest can still answer those even on a stale decisions block — that
    // is intended self-containment, not a hole in the gate.)
    expect(failedIds.has("recall-fable")).toBe(true);
    expect(failedIds.has("paid-video")).toBe(true);
    expect(failedIds.has("game-visibility")).toBe(true);
    // Every failure names a real question from the fixed set.
    const knownIds = new Set(PROBE_QUESTIONS.map((q) => q.id));
    for (const f of result.failures) expect(knownIds.has(f.id)).toBe(true);
  });
});

// Successor cold-boot digest + mechanized probe (masterplan-v2 §1.8 / §7 R5).
//
// Read-only tool. Emits a provenance-stamped 3-section digest
// (CURRENT LAWS / WHAT TO DO NOW / HOW TO RUN A LANE) that a fresh successor
// seat (or a return-time haiku probe) can answer a FIXED question set from,
// the digest ALONE. `--check` fail-closes when the live docs no longer let the
// digest answer every probe question — the mechanized wave-close gate and the
// §7 R5 grading instrument.
//
// It does NOT auto-run the haiku probe (that is an integrator/Agent action) and
// does NOT change lane-digest.ts behavior (it only reuses lane-digest's exported
// readSection/gitHead/sha helpers).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gitHead, readSection, sha } from "./lane-digest";

const DECISIONS_FILE = "docs/state/decisions.md";
const HANDOFF_FILE = "docs/state/handoff.md";

// Exact anchors (cited: card Ground truth, decisions.md:11).
const ACTIVE_RULINGS_HEADING = "## ACTIVE RULINGS (current law — newest first)";
// Successor manual pointer — a fixed pointer line is acceptable per the card
// (§6 = the manual; §3 Phase 1 = the current phase). masterplan-v2.md:363/:100.
const MANUAL_POINTER = "Successor manual = docs/architecture/masterplan-v2.md §6 (boot §6.1); current phase = §3 Phase 1 (The Machine Serves the Successor).";

// HOW TO RUN A LANE — a fixed, short snippet authored inline (spawn → watch →
// verifier-first intake → merge ritual). Sourced from the ratified orchestration
// doctrine (ai-architecture "Integrator Conductor Loop"); kept terse and stable
// so the digest is self-contained without a fragile deep-doc extraction.
const HOW_TO_RUN_A_LANE = [
  "1. Spawn a disjoint agent lane (Opus 4.8 executor; Codex = imagegen only; never a Fable subagent) from a paste-ready card in docs/tasks/, bound to its own worktree/branch.",
  "2. Watch with `pnpm lanes:watch --events ready`; never trust the lane's self-reported numbers.",
  "3. At READY run the verifier-first intake ritual: read the diff + re-run the gates yourself (`pnpm validate`, `pnpm -r typecheck`) + eyes-on any visual proof BEFORE believing the closeout.",
  "4. Merge ritual, one step per command: rebase ff-only onto master → push → `pnpm lane:close` → flip docs/state → re-arm the board. Never `--no-verify`.",
].join("\n");

export type ProbeQuestion = {
  id: string;
  question: string;
  // Expected answer as a short lowercased keyword/substring that MUST appear in
  // the emitted digest (case-insensitive). Derivable from decisions.md ACTIVE.
  answerKey: string;
};

// Fixed question set + answer-keys authored IN the tool (card scope item 2).
// Each answerKey is a lowercased substring the digest must contain; if the live
// docs drift so an answer disappears, `--check` fails closed.
export const PROBE_QUESTIONS: ProbeQuestion[] = [
  { id: "executor-model", question: "What model runs an agent-lane executor?", answerKey: "opus 4.8" },
  { id: "codex-code", question: "Does Codex write code?", answerKey: "imagegen only" },
  { id: "recall-fable", question: "Who can call Fable back to grade the successor?", answerKey: "owner alone" },
  { id: "paid-video", question: "May the seat spawn paid video?", answerKey: "fable-gated" },
  { id: "current-phase", question: "What is the current phase?", answerKey: "phase 1" },
  { id: "successor-manual", question: "Where is the successor operating manual?", answerKey: "masterplan-v2.md §6" },
  { id: "game-visibility", question: "Is the game public? (the successor-relevant law is the GAME's visibility)", answerKey: "game stays private" },
];

export type BootDigest = {
  text: string;
  head: string;
  handoffHeading: string;
};

/**
 * Resolve the LATEST handoff block heading dynamically: the FIRST `## ` heading
 * after the file preamble (do NOT hardcode a session title). Skips the `# H1`
 * title and any leading prose/history. Throws (fail-closed) if none is found.
 */
export function resolveLatestHandoffHeading(root: string): string {
  const text = readFileSync(handoffPath(root), "utf8");
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+\S/.test(trimmed)) return trimmed;
  }
  throw new Error(`[boot-successor-digest] no '## ' handoff block heading found in ${HANDOFF_FILE}`);
}

function handoffPath(root: string): string {
  return `${root.replace(/\\/g, "/").replace(/\/+$/, "")}/${HANDOFF_FILE}`;
}

export function generateBootDigest(root: string): BootDigest {
  const head = gitHead(root);

  const laws = readSection(root, DECISIONS_FILE, ACTIVE_RULINGS_HEADING);
  const handoffHeading = resolveLatestHandoffHeading(root);
  const handoff = readSection(root, HANDOFF_FILE, handoffHeading);
  const howHash = sha(HOW_TO_RUN_A_LANE);
  const pointerHash = sha(MANUAL_POINTER);

  const lines = [
    `SUCCESSOR COLD-BOOT DIGEST (generated from ${head})`,
    "",
    "== CURRENT LAWS ==",
    `Provenance: ${DECISIONS_FILE}@${head}#${laws.hash}`,
    "",
    laws.text,
    "",
    "== WHAT TO DO NOW ==",
    `Provenance: ${HANDOFF_FILE}@${head}#${handoff.hash}; pointer#${pointerHash}`,
    "",
    MANUAL_POINTER,
    "",
    handoff.text,
    "",
    "== HOW TO RUN A LANE ==",
    `Provenance: authored-inline@${head}#${howHash}`,
    "",
    HOW_TO_RUN_A_LANE,
    "",
  ];

  return { text: lines.join("\n"), head, handoffHeading };
}

export type CheckFailure = {
  id: string;
  question: string;
  answerKey: string;
};

export type CheckResult = {
  ok: boolean;
  failures: CheckFailure[];
};

/**
 * Fail-closed check: every probe question's answer-key substring MUST be present
 * (case-insensitive) in the emitted digest. A stale/incomplete digest that can
 * no longer answer a probe question is a failure with a named diff.
 */
export function checkDigest(digestText: string, questions: ProbeQuestion[] = PROBE_QUESTIONS): CheckResult {
  const haystack = digestText.toLowerCase();
  const failures: CheckFailure[] = [];
  for (const q of questions) {
    if (!haystack.includes(q.answerKey.toLowerCase())) {
      failures.push({ id: q.id, question: q.question, answerKey: q.answerKey });
    }
  }
  return { ok: failures.length === 0, failures };
}

function main(argv: string[]): void {
  const root = process.cwd();
  const checkMode = argv.includes("--check");
  const digest = generateBootDigest(root);

  if (!checkMode) {
    process.stdout.write(digest.text + "\n");
    return;
  }

  const result = checkDigest(digest.text);
  if (result.ok) {
    process.stdout.write(
      `[boot:digest --check] OK — digest (from ${digest.head}) answers all ${PROBE_QUESTIONS.length} probe questions.\n`,
    );
    return;
  }

  process.stderr.write(
    `[boot:digest --check] FAIL — the digest cannot answer ${result.failures.length}/${PROBE_QUESTIONS.length} probe question(s):\n`,
  );
  for (const f of result.failures) {
    process.stderr.write(`  - [${f.id}] "${f.question}" — missing answer-key substring: "${f.answerKey}"\n`);
  }
  process.stderr.write(
    "The live docs no longer let the digest answer every probe question (stale/incomplete). Fix the source docs or the answer-key.\n",
  );
  process.exit(1);
}

// Run only as a CLI, never on import (keeps the module test-safe).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}

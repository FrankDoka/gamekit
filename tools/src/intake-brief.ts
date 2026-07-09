/**
 * intake-brief — MANDATORY first step of every integrator intake (owner order,
 * 2026-07-08 s24: the integrator burned senior-model tokens reading full lane
 * diffs, raw gate output, and full-res captures inline; this tool mechanizes
 * the cheap path).
 *
 * It measures the branch diff vs master and prints a BINDING routing verdict:
 *
 *   DIRECT-READ    small diff — the integrator may read it inline.
 *   VERIFIER-FIRST large diff — spawn a lesser-model second verifier on the
 *                  full diff; the integrator reads the brief + the listed
 *                  spot-check targets ONLY (never the full diff inline).
 *
 * Plus the standing output-filter contract, so the rules travel with the tool
 * instead of living in any one session's memory. Informational exit 0; exits 2
 * only when the branch/card shape is broken (missing card, no checked
 * closeout) since intake would fail closed anyway.
 *
 * Usage: pnpm intake:brief <branch-or-lane> [--base master]
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Thresholds (owner-retunable): above EITHER bound the diff is L → VERIFIER-FIRST.
const L_ADDED_LINES = 300;
const L_FILES = 8;
const SPOT_CHECKS = 3;

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function main(): void {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith("--"));
  const base = args.includes("--base") ? args[args.indexOf("--base") + 1]! : "master";
  if (!target) {
    console.error("usage: pnpm intake:brief <branch-or-lane> [--base master]");
    process.exitCode = 2;
    return;
  }
  const branch = target.startsWith("codex/") ? target : `codex/card-${target}`;

  const numstat = git("diff", "--numstat", `${base}..${branch}`)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [added, deleted, file] = line.split("\t");
      return { added: Number(added) || 0, deleted: Number(deleted) || 0, file: file ?? "" };
    });
  const codeFiles = numstat.filter((f) => !f.file.startsWith("docs/"));
  const addedTotal = codeFiles.reduce((sum, f) => sum + f.added, 0);
  const large = addedTotal > L_ADDED_LINES || codeFiles.length > L_FILES;

  // Spot-check targets: highest-churn code files + any gate/validator surface.
  const churn = [...codeFiles].sort((a, b) => b.added - a.added).slice(0, SPOT_CHECKS);
  const gateFiles = codeFiles.filter(
    (f) => /validate\.ts|check-|recipes\.py|\.githooks|lane-|intake/.test(f.file),
  );

  // Card + closeout shape (intake fails closed on these; surface them early).
  const cardName = branch.replace(/^codex\//, "");
  const cardPath = join("docs", "tasks", `${cardName}.md`);
  let cardIssue = "";
  if (!existsSync(cardPath)) {
    cardIssue = `card not found on master: ${cardPath}`;
  } else {
    const branchCard = git("show", `${branch}:${cardPath.replace(/\\/g, "/")}`);
    if (!/^## Closeout/m.test(branchCard) || !/- \[x\]/.test(branchCard)) {
      cardIssue = "branch card lacks a ## Closeout with checked - [x] boxes (intake will bounce)";
    }
  }

  console.log(`[intake:brief] ${branch} vs ${base}`);
  console.log(`  files: ${numstat.length} (${codeFiles.length} code) · +${addedTotal} code lines`);
  console.log(`  routing: ${large ? "VERIFIER-FIRST" : "DIRECT-READ"} (L = >${L_ADDED_LINES} added or >${L_FILES} code files)`);
  if (large) {
    console.log("    -> spawn a lesser-model verifier on the FULL diff (adversarial, file:line findings).");
    console.log("    -> integrator reads: this brief + verifier verdict + the spot-checks below. NEVER the full diff inline.");
  }
  console.log(`  spot-check targets (highest churn):`);
  for (const f of churn) console.log(`    - ${f.file} (+${f.added}/-${f.deleted})`);
  if (gateFiles.length > 0) {
    console.log(`  new/changed GATE surfaces — regression-test each against a broken state:`);
    for (const f of gateFiles) console.log(`    - ${f.file}`);
  }
  console.log("  output-filter contract (always): pipe gate re-runs through Select-String");
  console.log("    (PASS/FAIL/Tests lines only); captures viewed as CROPS unless the verdict");
  console.log("    is zone-level; lane reports >20 lines = contract violation, bounce them.");
  if (cardIssue) {
    console.error(`[intake:brief] BLOCKER: ${cardIssue}`);
    process.exitCode = 2;
  }
}

main();

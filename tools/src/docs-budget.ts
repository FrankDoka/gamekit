import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  HOT_DOC_BUDGETS,
  RETIRED_TERM_SCAN_DOCS,
  estimateTokens,
  findRetiredTermNotes,
  findStaleHotDocNotes,
  largestMarkdownSections,
} from "./docs-hygiene";

const ROOT = process.cwd();
const DOCS = join(ROOT, "docs");

const collectMarkdown = (dir: string, out: string[]): void => {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectMarkdown(full, out);
    else if (entry.endsWith(".md")) out.push(full);
  }
};

const allMarkdown: string[] = [];
collectMarkdown(DOCS, allMarkdown);
for (const file of ["README.md", "AGENTS.md", "CLAUDE.md"]) {
  const full = join(ROOT, file);
  if (existsSync(full)) allMarkdown.push(full);
}

// WARN band: docs within WARN_FRACTION of their ceiling get a non-blocking
// WARN status so the wall is visible before it is hit. WARN never sets exitCode.
const WARN_FRACTION = 0.92;

console.log("[docs:budget] hot cold-start docs");
let hotTotal = 0;
let overBudget = 0;
let warnBudget = 0;
for (const [relPath, budget] of Object.entries(HOT_DOC_BUDGETS)) {
  const full = join(ROOT, relPath);
  if (!existsSync(full)) {
    console.log(`  missing  ${relPath}`);
    continue;
  }
  const text = readFileSync(full, "utf8");
  const tokens = estimateTokens(text);
  hotTotal += tokens;
  if (tokens > budget) overBudget++;
  const warn = tokens <= budget && tokens >= budget * WARN_FRACTION;
  if (warn) warnBudget++;
  const status = tokens > budget ? "OVER" : warn ? "WARN" : "ok";
  console.log(`  ${status.padEnd(4)} ${String(tokens).padStart(5)} / ${String(budget).padStart(5)}  ${relPath}`);
  for (const section of largestMarkdownSections(text, 2)) {
    console.log(`       ${String(section.tokens).padStart(5)}  line ${String(section.line).padStart(3)}  ${section.title}`);
  }
  const staleNotes = findStaleHotDocNotes(text);
  for (const note of staleNotes) {
    console.log(`       stale line ${note.line}: ${note.match} -> ${note.note}`);
  }
}
console.log(`  total hot-doc estimate: ${hotTotal} tokens`);
if (warnBudget > 0) {
  console.log(`\n[docs:budget] WARN — ${warnBudget} doc(s) within ${Math.round((1 - WARN_FRACTION) * 100)}% of ceiling (advisory, not blocking).`);
}

// Retired-term WARN scan (WARN-first: advisory, NEVER sets exitCode). Flags hot
// docs (incl. CLAUDE.md) that name a retired system without a nearby marker.
let retiredWarnings = 0;
for (const relPath of RETIRED_TERM_SCAN_DOCS) {
  const full = join(ROOT, relPath);
  if (!existsSync(full)) continue;
  const notes = findRetiredTermNotes(readFileSync(full, "utf8"));
  for (const note of notes) {
    retiredWarnings++;
    console.log(`[docs:budget] WARN retired-term ${relPath}:${note.line}: "${note.match}" -> ${note.note}`);
  }
}
if (retiredWarnings > 0) {
  console.log(`[docs:budget] WARN — ${retiredWarnings} retired-term reference(s) lack a nearby RETIRED/SUPERSEDED marker (advisory, not blocking).`);
}

const ranked = allMarkdown
  .map((file) => ({ rel: relative(ROOT, file).replace(/\\/g, "/"), tokens: estimateTokens(readFileSync(file, "utf8")) }))
  .filter((file) => !file.rel.startsWith("docs/archive/"))
  .sort((a, b) => b.tokens - a.tokens)
  .slice(0, 12);

console.log("\n[docs:budget] largest non-archive markdown files");
for (const file of ranked) {
  console.log(`  ${String(file.tokens).padStart(6)}  ${file.rel}`);
}

// Hot-doc budget breaches are BLOCKING (owner-ratified 2026-07-01, docs/state/decisions.md).
// Previously this script was advisory (always exit 0), which made the CI step decorative.
if (overBudget > 0) {
  console.error(`\n[docs:budget] FAIL — ${overBudget} hot doc(s) over budget. Trim the flagged sections (move detail to devlogs/archive) before committing.`);
  process.exitCode = 1;
}

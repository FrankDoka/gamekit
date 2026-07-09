import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { integrationBranch } from "./toolkit-config.js";

const ROOT = process.cwd();
const MAIN_BRANCH = integrationBranch();
const TASKS_DIR = join(ROOT, "docs", "tasks");
const ARCHIVE_DIR = join(TASKS_DIR, "archive");
const TOOL_TESTS_DIR = join(ROOT, "tools", "src");

// Optional absolute-doc-root prefix (e.g. "Z:/MyGame") a game uses in markdown links;
// when set, such links resolve against ROOT. The game names it via GAME_DOCS_ABS_ROOT.
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const absDocRoot = process.env.GAME_DOCS_ABS_ROOT?.trim();
const absDocRootRe = absDocRoot
  ? new RegExp(`^${absDocRoot.split(/[\\/]/).map(escapeRe).join("[\\\\/]")}[\\\\/](.*)$`, "i")
  : null;

type MovePlan = {
  oldAbs: string;
  newAbs: string;
  oldRel: string;
  newRel: string;
};

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitMaybe(args: string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function gitOk(args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function rel(abs: string): string {
  return relative(ROOT, abs).replace(/\\/g, "/");
}

function taskCards(): string[] {
  if (!existsSync(TASKS_DIR)) return [];
  return readdirSync(TASKS_DIR)
    .filter((name) => name.startsWith("card-") && name.endsWith(".md"))
    .map((name) => join(TASKS_DIR, name));
}

function allMarkdown(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) allMarkdown(full, out);
    else if (name.endsWith(".md")) out.push(full);
  }
  return out;
}

function collectToolTests(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collectToolTests(full, out);
    else if (name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function fixtureSafeCards(): Set<string> {
  const safe = new Set<string>();
  const fixtureRef = /docs\/tasks\/(card-[A-Za-z0-9_.-]+\.md)/g;
  const joinedFixtureRef = /["']docs["']\s*,\s*["']tasks["']\s*,\s*["'](card-[A-Za-z0-9_.-]+\.md)["']/g;
  for (const file of collectToolTests(TOOL_TESTS_DIR)) {
    const text = readFileSync(file, "utf8");
    let match: RegExpExecArray | null;
    while ((match = fixtureRef.exec(text)) !== null) {
      safe.add(join(TASKS_DIR, match[1]));
    }
    while ((match = joinedFixtureRef.exec(text)) !== null) {
      safe.add(join(TASKS_DIR, match[1]));
    }
  }
  return safe;
}

function statusLine(text: string): string {
  return text.split(/\r?\n/).slice(0, 20).find((line) => /\*\*Status:\*\*/i.test(line)) ?? "";
}

function statusSaysClosed(text: string): boolean {
  return /\b(MERGED|CLOSED)\b/i.test(statusLine(text));
}

function branchForCard(file: string, text: string): string {
  const branchMatch = /\bBranch:\*\*\s*`([^`]+)`/i.exec(text) ?? /\bbranch\s+`(codex\/card-[^`]+)`/i.exec(text);
  if (branchMatch) return branchMatch[1];
  const base = file.replace(/\\/g, "/").split("/").pop() ?? "";
  return `codex/${base.slice(0, -".md".length)}`;
}

function firstStatusHash(text: string): string | null {
  const match = /\b(?:MERGED|CLOSED)\b[^\n`]*`?([0-9a-f]{7,40})`?/i.exec(statusLine(text));
  return match ? match[1] : null;
}

function commitExists(ref: string): boolean {
  return gitOk(["cat-file", "-e", `${ref}^{commit}`]);
}

function isMergedToMaster(file: string, text: string): boolean {
  const branch = branchForCard(file, text);
  if (gitOk(["rev-parse", "--verify", "--quiet", branch])) {
    return gitOk(["merge-base", "--is-ancestor", branch, MAIN_BRANCH]);
  }
  const hash = firstStatusHash(text);
  return Boolean(hash && commitExists(hash) && gitOk(["merge-base", "--is-ancestor", hash, MAIN_BRANCH]));
}

function resolveMarkdownTarget(mdAbs: string, target: string): string | null {
  let clean = target.trim().split(/\s+/)[0] ?? "";
  if (!clean || /^(https?:|mailto:|#)/i.test(clean)) return null;
  clean = clean.split("#")[0];
  if (!clean) return null;
  const zRoot = absDocRootRe?.exec(clean) ?? null;
  if (zRoot) return join(ROOT, zRoot[1]);
  if (/^[A-Za-z]:[\\/]/.test(clean)) return clean;
  return resolve(dirname(mdAbs), clean);
}

function relativeLink(fromAbs: string, toAbs: string): string {
  let next = relative(dirname(fromAbs), toAbs).replace(/\\/g, "/");
  if (!next.startsWith(".")) next = `./${next}`;
  return next;
}

function updateLinks(plans: MovePlan[]): number {
  if (!plans.length) return 0;
  const moved = new Map(plans.map((plan) => [resolve(plan.oldAbs).toLowerCase(), plan.newAbs]));
  const mdFiles = allMarkdown(join(ROOT, "docs"));
  for (const file of ["README.md", "AGENTS.md", "CLAUDE.md"]) {
    const full = join(ROOT, file);
    if (existsSync(full)) mdFiles.push(full);
  }

  let updated = 0;
  const linkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
  for (const md of mdFiles) {
    const sourceAfterMove = moved.get(resolve(md).toLowerCase()) ?? md;
    const original = readFileSync(md, "utf8");
    const next = original.replace(linkRe, (whole, label: string, raw: string) => {
      const anchor = raw.includes("#") ? `#${raw.split("#").slice(1).join("#")}` : "";
      const abs = resolveMarkdownTarget(md, raw);
      if (!abs) return whole;
      const sourceMoved = sourceAfterMove !== md;
      const movedTarget = moved.get(resolve(abs).toLowerCase());
      if (!movedTarget && !sourceMoved) return whole;
      return `[${label}](${relativeLink(sourceAfterMove, movedTarget ?? abs)}${anchor})`;
    });
    if (next !== original) {
      writeFileSync(md, next, "utf8");
      updated++;
    }
  }
  return updated;
}

function moveCard(plan: MovePlan): void {
  try {
    renameSync(plan.oldAbs, plan.newAbs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM") throw error;
    execFileSync("git", ["mv", plan.oldRel, plan.newRel], { cwd: ROOT, stdio: "inherit" });
  }
}

function main(): number {
  const write = process.argv.includes("--write");
  const cards = taskCards();
  const fixtureSafe = fixtureSafeCards();
  const lackingMerged = cards.filter((file) => !/\bMERGED\b/i.test(readFileSync(file, "utf8"))).length;
  const candidates = cards.filter((file) => {
    if (fixtureSafe.has(file)) return false;
    const text = readFileSync(file, "utf8");
    return statusSaysClosed(text) && isMergedToMaster(file, text);
  });
  const plans = candidates.map((oldAbs) => {
    const newAbs = join(ARCHIVE_DIR, oldAbs.replace(/\\/g, "/").split("/").pop() ?? "");
    return { oldAbs, newAbs, oldRel: rel(oldAbs), newRel: rel(newAbs) };
  });

  console.log(`[tasks:sweep] before top-level cards=${cards.length} lacking-MERGED=${lackingMerged}`);
  console.log(`[tasks:sweep] fixture-safe=${fixtureSafe.size}`);
  console.log(`[tasks:sweep] eligible=${plans.length}`);
  for (const plan of plans) console.log(`  ${plan.oldRel} -> ${plan.newRel}`);
  if (!write) {
    console.log("[tasks:sweep] dry run; pass --write to move eligible cards");
    return 0;
  }

  mkdirSync(ARCHIVE_DIR, { recursive: true });
  for (const plan of plans) {
    if (existsSync(plan.newAbs)) {
      throw new Error(`archive target already exists: ${plan.newRel}`);
    }
  }
  const updatedLinks = updateLinks(plans);
  for (const plan of plans) moveCard(plan);
  const afterCards = taskCards();
  const afterLackingMerged = afterCards.filter((file) => !/\bMERGED\b/i.test(readFileSync(file, "utf8"))).length;
  console.log(`[tasks:sweep] updated markdown link file(s)=${updatedLinks}`);
  console.log(`[tasks:sweep] moved=${plans.length}`);
  console.log(`[tasks:sweep] after top-level cards=${afterCards.length} lacking-MERGED=${afterLackingMerged}`);
  const master = gitMaybe(["rev-parse", "--short", MAIN_BRANCH]);
  if (master) console.log(`[tasks:sweep] ${MAIN_BRANCH}=${master}`);
  return 0;
}

process.exit(main());

import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { gameRoot } from "./toolkit-config.js";
import { evaluateAnimValidatorArtifacts } from "./anim-validator-gate";
import { lanesDir, readLaneRegistry } from "./lane-registry";
import type { LaneEntry } from "./lane-registry";

type GateStatus = "pass" | "fail" | "skip";

type GateVerdict = {
  name: string;
  command?: string;
  status: GateStatus;
  exit_code?: number | null;
  started_at?: string;
  finished_at?: string;
  output_tail?: string;
};

type IntakeVerdict = {
  lane: string;
  branch: string;
  worktree: string;
  card: string;
  started_at: string;
  finished_at?: string;
  primary_root: string;
  commit: { created: boolean; hash: string | null; message_file: string | null };
  dirty: { staged: string[]; unstaged: string[]; untracked: string[]; ignored_codex: string[] };
  stale_index_lock: { path: string | null; removed: boolean; skipped_reason: string | null };
  rebase: { status: GateStatus; output_tail?: string; conflicted_files: string[] };
  gates: GateVerdict[];
  security_scan: GateVerdict | null;
  remaining_human_steps: string[];
};

type LockFile = {
  pid: number;
  acquired_at: string;
};

const cwd = process.cwd();
const PRIMARY_ROOT = normalizePath(process.env.INTAKE_PRIMARY_ROOT ?? gameRoot());
const LOCK_TIMEOUT_MS = Number(process.env.INTAKE_LOCK_TIMEOUT_MS ?? "900000");
const SELF_TEST_SKIP_REBASE = process.env.INTAKE_SKIP_REBASE === "1";
const ALLOW_MISSING_CLOSEOUT_ARTIFACTS = process.env.INTAKE_ALLOW_MISSING_CLOSEOUT_ARTIFACTS === "1";
const SKIP_CLOSEOUT_PRESENCE = process.env.GAMEKIT_INTAKE_CLOSEOUT_SKIP === "1";
const SKIP_ANIM_VALIDATORS = process.env.GAMEKIT_ANIM_VALIDATORS_SKIP === "1";
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const B3_VISUAL_PROOF_MARKER = "BLOCKED (B3 visual proof)";

type B3ProofCommand = {
  display: string;
  command: string;
  args: string[];
};

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function samePath(a: string, b: string): boolean {
  return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase();
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitResult(dir: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function outputTail(value: string, maxLines = 40): string {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.length > 0)
    .slice(-maxLines)
    .join("\n");
}

function splitCommandLine(commandLine: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < commandLine.length; i += 1) {
    const char = commandLine[i];
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += char;
  }
  if (token) tokens.push(token);
  return tokens;
}

function normalizeProofCommand(commandLine: string): B3ProofCommand | null {
  const tokens = splitCommandLine(commandLine.replace(/^`|`$/g, "").trim());
  if (!tokens.length) return null;

  const captureIndex = tokens.findIndex((token) => token === "capture:zone");
  if (captureIndex >= 0) {
    const args = tokens.slice(captureIndex);
    const firstCaptureArg = 1;
    if (args[firstCaptureArg] && !args[firstCaptureArg].startsWith("--")) {
      args[firstCaptureArg] = "tools/_capture-intake-b3";
    } else {
      args.splice(firstCaptureArg, 0, "tools/_capture-intake-b3");
    }
    return {
      display: ["pnpm", ...args].join(" "),
      command: PNPM,
      args,
    };
  }

  return {
    display: tokens.join(" "),
    command: tokens[0],
    args: tokens.slice(1),
  };
}

function gatesSection(cardText: string): string {
  const gatesIndex = cardText.search(/^## Gates\b/im);
  if (gatesIndex < 0) return "";
  const nextSection = cardText.slice(gatesIndex + 1).search(/\n##\s+/);
  return nextSection >= 0 ? cardText.slice(gatesIndex, gatesIndex + 1 + nextSection) : cardText.slice(gatesIndex);
}

function extractB3ProofCommand(cardText: string): B3ProofCommand | null {
  const explicit = cardText.match(/^\s*\*\*Proof leg:\*\*\s*(.+?)\s*$/im);
  if (explicit?.[1]) return normalizeProofCommand(explicit[1]);

  for (const line of gatesSection(cardText).split(/\r?\n/)) {
    if (!/\bcapture:zone\b.*--[A-Za-z0-9-]+-proof\b/.test(line)) continue;
    const backtick = line.match(/`([^`]*\bcapture:zone\b[^`]*)`/);
    const commandLine = backtick?.[1] ?? line.replace(/^\s*[-*]\s+(?:\[[ xX]\]\s*)?/, "").trim();
    const command = normalizeProofCommand(commandLine);
    if (command) return command;
  }
  return null;
}

function stageForCommit(worktree: string): void {
  git(worktree, ["add", "-A"]);
  for (const path of [".codex-prompt.txt", ".codex-result.txt", ".codex-summary.txt", ".codex-last-message.txt", ".codex-continuation.txt", ".commit-msg.txt"]) {
    gitResult(worktree, ["reset", "--", path]);
  }
}

function assertPrimaryCwd(): boolean {
  let primaryTop: string;
  let currentTop: string;
  try {
    primaryTop = normalizePath(git(PRIMARY_ROOT, ["rev-parse", "--show-toplevel"]));
  } catch (error) {
    console.error(`[intake] BLOCKED: primary repo cannot be resolved at ${PRIMARY_ROOT}: ${(error as Error).message.split("\n")[0]}`);
    return false;
  }
  try {
    currentTop = normalizePath(git(cwd, ["rev-parse", "--show-toplevel"]));
  } catch (error) {
    console.error(`[intake] BLOCKED: cwd is not inside a git repo: ${cwd} (${(error as Error).message.split("\n")[0]})`);
    return false;
  }
  if (!samePath(primaryTop, currentTop)) {
    console.error("[intake] BLOCKED: intake must run from the primary repo worktree.");
    console.error(`[intake] primary=${primaryTop}`);
    console.error(`[intake] current=${currentTop}`);
    return false;
  }
  return true;
}

function resolveLane(target: string): LaneEntry | null {
  const normalizedTarget = normalizePath(target).toLowerCase();
  const entries = readLaneRegistry(PRIMARY_ROOT);
  return (
    entries.find((entry) => {
      return (
        entry.lane === target ||
        entry.branch === target ||
        normalizePath(entry.worktree).toLowerCase() === normalizedTarget ||
        basename(normalizePath(entry.worktree)).toLowerCase() === normalizedTarget
      );
    }) ?? null
  );
}

function splitStatusLine(line: string): { x: string; y: string; path: string } {
  return { x: line[0] ?? " ", y: line[1] ?? " ", path: line.slice(3).trim() };
}

function readDirty(worktree: string): IntakeVerdict["dirty"] {
  const lines = git(worktree, ["status", "--porcelain"]).split(/\r?\n/).filter(Boolean);
  const dirty: IntakeVerdict["dirty"] = { staged: [], unstaged: [], untracked: [], ignored_codex: [] };
  for (const line of lines) {
    const parsed = splitStatusLine(line);
    // Lane bookkeeping files never count as committable work: .codex-* plus a
    // leftover .commit-msg.txt (excluded from commits, so it survives them).
    if (/^\.codex-.*\.txt$/.test(parsed.path) || parsed.path === ".commit-msg.txt") {
      dirty.ignored_codex.push(parsed.path);
      continue;
    }
    if (parsed.x === "?" && parsed.y === "?") dirty.untracked.push(parsed.path);
    else {
      if (parsed.x !== " ") dirty.staged.push(parsed.path);
      if (parsed.y !== " ") dirty.unstaged.push(parsed.path);
    }
  }
  return dirty;
}

function hasCommittableWork(dirty: IntakeVerdict["dirty"]): boolean {
  return dirty.staged.length + dirty.unstaged.length + dirty.untracked.length > 0;
}

function gitProcessesLive(): boolean {
  if (process.platform === "win32") {
    const result = spawnSync("tasklist", ["/FI", "IMAGENAME eq git.exe"], { encoding: "utf8" });
    return (result.stdout ?? "").toLowerCase().includes("git.exe");
  }
  const result = spawnSync("pgrep", ["-x", "git"], { encoding: "utf8" });
  return result.status === 0;
}

function gitDir(worktree: string): string {
  const dir = git(worktree, ["rev-parse", "--git-dir"]);
  return isAbsolute(dir) || /^[A-Za-z]:[\\/]/.test(dir) ? dir : join(worktree, dir);
}

function sweepIndexLock(worktree: string): IntakeVerdict["stale_index_lock"] {
  const lockPath = join(gitDir(worktree), "index.lock");
  if (!existsSync(lockPath)) return { path: lockPath, removed: false, skipped_reason: null };
  if (gitProcessesLive()) {
    return { path: lockPath, removed: false, skipped_reason: "live git process detected" };
  }
  rmSync(lockPath, { force: true });
  return { path: lockPath, removed: true, skipped_reason: null };
}

function runB3AutoProof(worktree: string, cardText: string, verdict: IntakeVerdict): boolean {
  const proofCommand = extractB3ProofCommand(cardText);
  if (!proofCommand) {
    console.error("[intake] B3 auto-proof: no proof leg found in the lane card; add `**Proof leg:** pnpm capture:zone tools/_capture-name --<x>-proof`.");
    return false;
  }

  const started = new Date().toISOString();
  console.log(`[intake] B3 auto-proof: running ${proofCommand.display}`);
  const result = spawnSync(proofCommand.command, proofCommand.args, {
    cwd: worktree,
    encoding: "utf8",
    shell: proofCommand.command === PNPM && process.platform === "win32",
  });
  const finished = new Date().toISOString();
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const status = result.status === 0 ? "pass" : "fail";
  verdict.gates.push({
    name: "B3 auto-proof",
    command: proofCommand.display,
    status,
    exit_code: result.status,
    started_at: started,
    finished_at: finished,
    output_tail: outputTail(combined),
  });
  return true;
}

function checkAnimValidatorArtifacts(worktree: string, verdict: IntakeVerdict): number | null {
  // --diff-filter=d: a DELETED sheet needs no validation artifacts (bit the
  // funnel-sharpness intake 2026-07-07 when it retired intermediate webps).
  const staged = git(worktree, ["diff", "--cached", "--name-only", "--diff-filter=d"]).split(/\r?\n/).filter(Boolean);
  const result = evaluateAnimValidatorArtifacts(worktree, staged);
  if (result.sheets.length === 0) {
    verdict.gates.push({ name: "animation validator artifacts", status: "pass", output_tail: "no staged animation sheets" });
    return null;
  }
  if (SKIP_ANIM_VALIDATORS) {
    const line = `[intake] WARNING: GAMEKIT_ANIM_VALIDATORS_SKIP=1; skipping animation validator artifact gate for ${result.sheets.length} staged sheet(s): ${result.sheets.join(", ")}`;
    console.warn(line);
    verdict.gates.push({ name: "animation validator artifacts", status: "skip", output_tail: line });
    return null;
  }
  if (result.ok) {
    verdict.gates.push({
      name: "animation validator artifacts",
      status: "pass",
      output_tail: `all four artifacts (motion-arc verdict PASS, identity-palette verdict PASS, opaque-ring verdict PASS, panel) staged for ${result.sheets.length} sheet(s)`,
    });
    return null;
  }
  const message = [
    "[intake] BLOCKED: missing animation validator artifacts — every staged animation sheet needs its",
    "[intake] motion-arc verdict (PASS), identity-palette verdict (PASS), opaque-ring verdict (PASS), AND",
    "[intake] acceptance panel staged alongside (the panel owns the geometric-garble defect class the",
    "[intake] metrics cannot catch; the opaque-ring verdict owns the binary-alpha video-keying ring):",
    ...result.findings.map((f) => `  - ${f.sheet}: ${f.artifact} (${f.problem})`),
    "[intake] runtime-tree sheets: pass EXPLICIT output paths alongside the sheet — the tools' default",
    "[intake] REDIRECTS runtime verdicts to gitignored tools/_anim-verdicts/ which can never satisfy this",
    "[intake] gate; generate artifacts BEFORE the final proof capture so the B3 freshness gate stays green.",
    "[intake] run: python tools/asset-cleanup/recipes.py motion-arc <sheet> --cell N [--loop] --json <stem>.motion-arc-verdict.json",
    "[intake]      python tools/asset-cleanup/recipes.py identity-palette <sheet> --cell N [--canon REF --canon-cell M] --json <stem>.identity-palette-verdict.json",
    "[intake]      python tools/asset-cleanup/fringe.py opaque-magenta-ring <sheet> --cell N --json <stem>.opaque-ring-verdict.json  (stills: omit --cell)",
    "[intake]      python tools/asset-cleanup/anim_panel.py <sheet> --cell N --out <stem>.panel.png",
    "[intake] loud escape hatch (integrator only): GAMEKIT_ANIM_VALIDATORS_SKIP=1",
  ].join("\n");
  console.error(message);
  verdict.gates.push({ name: "animation validator artifacts", status: "fail", output_tail: outputTail(message) });
  return 4;
}

function completeFromStaged(worktree: string, verdict: IntakeVerdict, cardText: string): number | null {
  const dirty = readDirty(worktree);
  verdict.dirty = dirty;
  console.log(
    `[intake] dirty staged=${dirty.staged.length} unstaged=${dirty.unstaged.length} untracked=${dirty.untracked.length} ignored_codex=${dirty.ignored_codex.length}`,
  );
  if (!hasCommittableWork(dirty)) return null;

  const messagePath = join(worktree, ".commit-msg.txt");
  if (!existsSync(messagePath)) {
    console.error("[intake] BLOCKED: work exists but .commit-msg.txt is missing; refusing to invent a commit message.");
    return 2;
  }

  stageForCommit(worktree);
  const animStop = checkAnimValidatorArtifacts(worktree, verdict);
  if (animStop !== null) return animStop;
  let commit = gitResult(worktree, ["commit", "-F", ".commit-msg.txt"]);
  let combinedCommitOutput = `${commit.stdout}\n${commit.stderr}`;
  if (commit.status !== 0 && combinedCommitOutput.includes(B3_VISUAL_PROOF_MARKER)) {
    if (runB3AutoProof(worktree, cardText, verdict)) {
      stageForCommit(worktree);
      commit = gitResult(worktree, ["commit", "-F", ".commit-msg.txt"]);
      combinedCommitOutput = `${commit.stdout}\n${commit.stderr}`;
    }
  }
  if (commit.status !== 0) {
    verdict.gates.push({
      name: "complete-from-staged",
      command: "git commit -F .commit-msg.txt",
      status: "fail",
      exit_code: commit.status,
      output_tail: outputTail(combinedCommitOutput),
    });
    return 1;
  }
  verdict.commit = { created: true, hash: git(worktree, ["rev-parse", "HEAD"]), message_file: messagePath };
  verdict.gates.push({
    name: "complete-from-staged",
    command: "git add -A && git commit -F .commit-msg.txt",
    status: "pass",
    exit_code: 0,
    output_tail: outputTail(commit.stdout),
  });
  return null;
}

function rebaseOntoMaster(worktree: string, verdict: IntakeVerdict): number | null {
  if (SELF_TEST_SKIP_REBASE) {
    verdict.rebase = { status: "skip", output_tail: "INTAKE_SKIP_REBASE=1", conflicted_files: [] };
    return null;
  }
  const rebase = gitResult(worktree, ["rebase", "master"]);
  if (rebase.status === 0) {
    verdict.rebase = { status: "pass", output_tail: outputTail(`${rebase.stdout}\n${rebase.stderr}`), conflicted_files: [] };
    // A rebase rewrites the lane commit; keep the verdict hash = the mergeable tip.
    if (verdict.commit.created) verdict.commit.hash = git(worktree, ["rev-parse", "HEAD"]);
    return null;
  }
  const conflicted = gitResult(worktree, ["diff", "--name-only", "--diff-filter=U"]).stdout.split(/\r?\n/).filter(Boolean);
  verdict.rebase = {
    status: "fail",
    output_tail: outputTail(`${rebase.stdout}\n${rebase.stderr}`),
    conflicted_files: conflicted,
  };
  console.error(`[intake] BLOCKED: rebase conflict in ${conflicted.join(", ") || "(unknown files)"}`);
  return 3;
}

function runCommand(worktree: string, name: string, command: string, args: string[]): GateVerdict {
  const started = new Date().toISOString();
  console.log(`[intake] RUN ${command} ${args.join(" ")}`.trim());
  const result = spawnSync(command, args, { cwd: worktree, encoding: "utf8", shell: command === PNPM && process.platform === "win32" });
  const finished = new Date().toISOString();
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const status = result.status === 0 ? "pass" : "fail";
  console.log(`[intake] ${status.toUpperCase()} ${name} exit=${result.status ?? "null"}`);
  return {
    name,
    command: [command, ...args].join(" "),
    status,
    exit_code: result.status,
    started_at: started,
    finished_at: finished,
    output_tail: outputTail(combined),
  };
}

function pidIsLive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(lockPath: string): LockFile | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      Number.isInteger((parsed as Record<string, unknown>).pid) &&
      typeof (parsed as Record<string, unknown>).acquired_at === "string"
    ) {
      return parsed as LockFile;
    }
  } catch {
    // Corrupt locks cannot prove liveness.
  }
  return null;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireSmokeLock(): string[] {
  mkdirSync(lanesDir(PRIMARY_ROOT), { recursive: true });
  const lockPath = join(lanesDir(PRIMARY_ROOT), ".smoke.lock");
  const lock: LockFile = { pid: process.pid, acquired_at: new Date().toISOString() };
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const logLines: string[] = [];
  let loggedWait = false;

  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, JSON.stringify(lock, null, 2) + "\n", "utf8");
      closeSync(fd);
      const line = `[intake] smoke lock acquired pid=${lock.pid}`;
      console.log(line);
      logLines.push(line);
      return logLines;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const existing = readLock(lockPath);
      if (!existing || !pidIsLive(existing.pid)) {
        rmSync(lockPath, { force: true });
        const line = `[intake] stale smoke lock stolen ${existing ? `pid=${existing.pid}` : "unreadable"}`;
        console.log(line);
        logLines.push(line);
        continue;
      }
      if (!loggedWait) {
        const line = `[intake] waiting for smoke lock held by pid=${existing.pid} since ${existing.acquired_at}`;
        console.log(line);
        logLines.push(line);
        loggedWait = true;
      }
      sleepSync(250);
    }
  }
  throw new Error(`smoke lock busy: ${lockPath}`);
}

function releaseSmokeLock(): void {
  const lockPath = join(lanesDir(PRIMARY_ROOT), ".smoke.lock");
  const existing = readLock(lockPath);
  if (existing?.pid === process.pid) rmSync(lockPath, { force: true });
}

function readCard(primaryRoot: string, card: string): string {
  const path = /^[A-Za-z]:[\\/]/.test(card) || card.startsWith("/") ? card : join(primaryRoot, card);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function readWorktreeCard(worktree: string, card: string): string {
  const path = /^[A-Za-z]:[\\/]/.test(card) || card.startsWith("/") ? card : join(worktree, card);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function closeoutSection(cardText: string): string {
  const closeoutIndex = cardText.search(/^## Closeout\b/im);
  if (closeoutIndex < 0) return "";
  const nextSection = cardText.slice(closeoutIndex + 1).search(/\n##\s+/);
  return nextSection >= 0 ? cardText.slice(closeoutIndex, closeoutIndex + 1 + nextSection) : cardText.slice(closeoutIndex);
}

function citedCaptureArtifacts(cardText: string): string[] {
  const closeout = closeoutSection(cardText);
  if (!closeout) return [];
  const matches = closeout.match(/tools\/_capture[^\s`'")\],;]+/g) ?? [];
  return Array.from(new Set(matches.map((match) => normalizePath(match.replace(/[.]+$/, "")))));
}

function checkCloseoutArtifacts(worktree: string, cardText: string): GateVerdict {
  const artifacts = citedCaptureArtifacts(cardText);
  if (ALLOW_MISSING_CLOSEOUT_ARTIFACTS) {
    const line = `[intake] WARNING: INTAKE_ALLOW_MISSING_CLOSEOUT_ARTIFACTS=1; skipping closeout capture artifact existence check (${artifacts.length} cited)`;
    console.warn(line);
    return { name: "closeout capture artifacts exist", status: "skip", output_tail: line };
  }
  const missing = artifacts.filter((artifact) => !existsSync(join(worktree, artifact)));
  if (missing.length > 0) {
    const message = [
      "[intake] BLOCKED: closeout cites missing capture artifact(s):",
      ...missing.map((artifact) => `  - ${artifact}`),
    ].join("\n");
    console.error(message);
    return { name: "closeout capture artifacts exist", status: "fail", output_tail: message };
  }
  return {
    name: "closeout capture artifacts exist",
    status: "pass",
    output_tail: artifacts.length > 0 ? `checked ${artifacts.length} cited capture artifact(s)` : "no cited capture artifacts",
  };
}

function checkCloseoutPresence(cardText: string, cardPath: string): GateVerdict {
  if (SKIP_CLOSEOUT_PRESENCE) {
    const line = `[intake] WARNING: GAMEKIT_INTAKE_CLOSEOUT_SKIP=1; skipping card closeout-presence check for ${cardPath}`;
    console.warn(line);
    return { name: "card closeout present", status: "skip", output_tail: line };
  }
  const closeout = closeoutSection(cardText);
  const checkedBox = /^\s*[-*]\s*\[[xX]\]/m.test(closeout);
  if (!closeout || !checkedBox) {
    const message = [
      `[intake] BLOCKED: missing closeout — return-contract violation: ${cardPath}`,
      closeout
        ? "  the card has a ## Closeout heading but no checked box (- [x])"
        : "  the card has no ## Closeout section on the branch",
      "  fill the card's closeout box-by-box, or set GAMEKIT_INTAKE_CLOSEOUT_SKIP=1 for a dead lane the integrator completes.",
    ].join("\n");
    console.error(message);
    return { name: "card closeout present", status: "fail", output_tail: message };
  }
  return { name: "card closeout present", status: "pass", output_tail: `closeout with ≥1 checked box found in ${cardPath}` };
}

function proofFlags(cardText: string): string[] {
  const gatesIndex = cardText.search(/^## Gates\b/im);
  const text = gatesIndex >= 0 ? cardText.slice(gatesIndex) : cardText;
  return Array.from(new Set(text.match(/--[A-Za-z0-9-]+-proof\b/g) ?? []));
}

function isHighRisk(cardText: string): boolean {
  return /\brisk:\s*high\b/i.test(cardText);
}

function writeVerdict(lane: string, verdict: IntakeVerdict): void {
  verdict.finished_at = new Date().toISOString();
  const path = join(lanesDir(PRIMARY_ROOT), `${lane}-intake.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(verdict, null, 2) + "\n", "utf8");
  console.log(`[intake] verdict: ${path}`);
}

function usage(): never {
  console.error("usage: pnpm intake <lane-or-branch>");
  process.exit(2);
}

function main(): number {
  const target = process.argv[2];
  if (!target) usage();
  if (!assertPrimaryCwd()) return 1;

  const entry = resolveLane(target);
  if (!entry) {
    console.error(`[intake] BLOCKED: no lane registry entry matches ${target}`);
    return 2;
  }

  const cardText = readCard(PRIMARY_ROOT, entry.card);
  const worktreeCardText = readWorktreeCard(entry.worktree, entry.card);
  const verdict: IntakeVerdict = {
    lane: entry.lane,
    branch: entry.branch,
    worktree: normalizePath(resolve(entry.worktree)),
    card: entry.card,
    started_at: new Date().toISOString(),
    primary_root: PRIMARY_ROOT,
    commit: { created: false, hash: null, message_file: null },
    dirty: { staged: [], unstaged: [], untracked: [], ignored_codex: [] },
    stale_index_lock: { path: null, removed: false, skipped_reason: null },
    rebase: { status: "skip", conflicted_files: [] },
    gates: [],
    security_scan: null,
    remaining_human_steps: isHighRisk(cardText) ? ["diff read", "eyes-on verification", "second verifier", "owner ack"] : [],
  };

  try {
    verdict.stale_index_lock = sweepIndexLock(entry.worktree);

    const artifactGate = checkCloseoutArtifacts(entry.worktree, worktreeCardText);
    verdict.gates.push(artifactGate);
    if (artifactGate.status === "fail") {
      writeVerdict(entry.lane, verdict);
      return 2;
    }

    const commitStop = completeFromStaged(entry.worktree, verdict, cardText);
    if (commitStop !== null) {
      writeVerdict(entry.lane, verdict);
      return commitStop;
    }

    // Re-read the card AFTER commit-from-staged: the closeout may have been part
    // of the staged work just committed onto the branch.
    const committedCardText = readWorktreeCard(entry.worktree, entry.card);
    const closeoutGate = checkCloseoutPresence(committedCardText, entry.card);
    verdict.gates.push(closeoutGate);
    if (closeoutGate.status === "fail") {
      writeVerdict(entry.lane, verdict);
      return 2;
    }

    const rebaseStop = rebaseOntoMaster(entry.worktree, verdict);
    if (rebaseStop !== null) {
      writeVerdict(entry.lane, verdict);
      return rebaseStop;
    }

    const normalGates: [string, string[]][] = [
      ["pnpm validate", ["validate"]],
      ["pnpm -r typecheck", ["-r", "typecheck"]],
      ["pnpm test", ["test"]],
      ["pnpm build:client", ["build:client"]],
    ];
    for (const [name, args] of normalGates) {
      verdict.gates.push(runCommand(entry.worktree, name, PNPM, args));
    }

    let smokeLockLines: string[] = [];
    try {
      smokeLockLines = acquireSmokeLock();
      const smoke = runCommand(entry.worktree, "pnpm smoke:client", PNPM, ["smoke:client"]);
      smoke.output_tail = outputTail([smokeLockLines.join("\n"), smoke.output_tail].filter(Boolean).join("\n"));
      verdict.gates.push(smoke);
      for (const flag of proofFlags(cardText)) {
        // capture:zone takes the output dir as its first positional arg, before flags.
        const proofOut = `tools/_intake${flag.replace(/^--/, "-")}`;
        verdict.gates.push(runCommand(entry.worktree, `pnpm capture:zone ${proofOut} ${flag}`, PNPM, ["capture:zone", proofOut, flag]));
      }
    } finally {
      releaseSmokeLock();
    }

    verdict.security_scan = runCommand(entry.worktree, `pnpm lane:security-scan ${entry.branch}`, PNPM, [
      "lane:security-scan",
      entry.branch,
    ]);

    writeVerdict(entry.lane, verdict);
    const failed = [...verdict.gates, verdict.security_scan].filter((gate): gate is GateVerdict => Boolean(gate)).some((gate) => gate.status === "fail");
    return failed ? 1 : 0;
  } catch (error) {
    verdict.gates.push({ name: "intake-exception", status: "fail", output_tail: (error as Error).message });
    writeVerdict(entry.lane, verdict);
    console.error(`[intake] FAIL: ${(error as Error).message}`);
    return 1;
  }
}

process.exit(main());

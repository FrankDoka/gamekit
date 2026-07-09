/**
 * lane-spawn — mechanizes the Integrator Conductor Loop's spawn ritual
 * (docs/architecture/ai-architecture.md "The Integrator Conductor Loop" §3, §6c).
 *
 * Usage:
 *   pnpm lane:spawn <card-file> --engine codex|agent [--name <lane>] [--dry-run] [--no-digest] [-m <model>] [--sandbox <tier>]
 *
 * - Derives lane name/branch from the card filename (card-x.md -> Z:/gamekit-x,
 *   codex/card-x); refuses if the worktree or branch already exists.
 * - `git worktree add` + branch off master, runs `pnpm install` when the new
 *   worktree has no node_modules, then `sessions:sync` so the roster reflects
 *   the new lane immediately.
 * - Composes the delegation prompt from the card file and inlines a generated
 *   lane rules digest by default; `--no-digest` keeps the legacy card-only prompt.
 * - `--engine codex`: launches `codex exec -C <worktree> -s <sandbox> --json
 *   -o <worktree>/.codex-last-message.txt -` (prompt piped via stdin from a written
 *   prompt file) DETACHED via PowerShell `Start-Process` (Node's own
 *   `spawn({detached:true})` does not survive on this Windows setup — see the
 *   comment at the launch site), stdout JSONL -> tools/_lanes/<lane>-events.jsonl,
 *   stderr -> tools/_lanes/<lane>-stderr.txt. Parses the first `thread.started` line
 *   and records {lane, branch, worktree, engine, thread_id, started_at} in
 *   tools/_lanes/lanes.json.
 * - `--engine agent`: does everything except launching -- prints the composed prompt
 *   block for the orchestrator's own Agent tool, and records the lane in lanes.json
 *   with engine:"agent" (no thread_id).
 * - `--dry-run`: prints the exact command + prompt, changes nothing (no worktree, no
 *   branch, no lanes.json write).
 */
import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gameRoot, integrationBranch } from "./toolkit-config.js";
import {
  ensureLanesDir,
  lanesDir,
  lanesJsonPath,
  makeLaneEntry,
  updateLaneRegistry,
} from "./lane-registry";
import { generateLaneDigest } from "./lane-digest";

const ROOT = process.cwd();
const PRIMARY_ROOT = gameRoot();
const LANES_DIR = lanesDir(ROOT);
const LANES_JSON = lanesJsonPath(ROOT);
const SANDBOX_TIERS = ["workspace-write", "danger-full-access"] as const;
type SandboxTier = (typeof SANDBOX_TIERS)[number];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function assertPrimaryCwd(): boolean {
  let primaryTop: string;
  let currentTop: string;
  try {
    primaryTop = git(PRIMARY_ROOT, ["rev-parse", "--show-toplevel"]).replace(/\\/g, "/");
    currentTop = git(ROOT, ["rev-parse", "--show-toplevel"]).replace(/\\/g, "/");
  } catch (error) {
    console.error(`[lane-spawn] BLOCKED: could not resolve primary/current repo (${(error as Error).message.split("\n")[0]})`);
    return false;
  }
  if (normalizePath(primaryTop) !== normalizePath(currentTop)) {
    console.error("[lane-spawn] BLOCKED: non-dry-run lane spawn must run from the primary repo worktree.");
    console.error(`[lane-spawn] primary=${primaryTop}`);
    console.error(`[lane-spawn] current=${currentTop}`);
    return false;
  }
  return true;
}

function gitExists(cwd: string, args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv: string[]): {
  cardFile: string;
  engine: "codex" | "agent" | null;
  name: string | null;
  dryRun: boolean;
  model: string | null;
  sandbox: SandboxTier | null;
  noDigest: boolean;
} {
  const positional: string[] = [];
  let engine: "codex" | "agent" | null = null;
  let name: string | null = null;
  let dryRun = false;
  let model: string | null = null;
  let sandbox: SandboxTier | null = null;
  let noDigest = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--engine") {
      const v = argv[++i];
      if (v !== "codex" && v !== "agent") {
        throw new Error(`--engine must be "codex" or "agent", got ${String(v)}`);
      }
      engine = v;
    } else if (a === "--name") {
      name = argv[++i];
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--no-digest") {
      noDigest = true;
    } else if (a === "-m" || a === "--model") {
      model = argv[++i];
    } else if (a === "--sandbox") {
      const v = argv[++i];
      if (!SANDBOX_TIERS.includes(v as SandboxTier)) {
        throw new Error(`--sandbox must be ${SANDBOX_TIERS.join("|")}, got ${String(v)}`);
      }
      sandbox = v as SandboxTier;
    } else {
      positional.push(a);
    }
  }
  if (!positional[0]) {
    throw new Error("usage: pnpm lane:spawn <card-file> --engine codex|agent [--name <lane>] [--dry-run] [--no-digest] [-m <model>] [--sandbox <workspace-write|danger-full-access>]");
  }
  if (!engine) {
    throw new Error("--engine codex|agent is required");
  }
  return { cardFile: positional[0], engine, name, dryRun, model, sandbox, noDigest };
}

/** card-x.md -> "x" (lane name), branch "codex/card-x", worktree Z:/gamekit-x */
function deriveLaneName(cardFile: string, override: string | null): string {
  if (override) return override;
  const base = cardFile.replace(/\\/g, "/").split("/").pop() ?? cardFile;
  const m = /^card-(.+)\.md$/.exec(base);
  if (!m) {
    throw new Error(`card filename must match card-<name>.md, got ${base}`);
  }
  return m[1];
}

/** Pull the card's title line (first "# ..." heading) as the goal. */
function extractGoal(cardText: string): string {
  const line = cardText.split(/\r?\n/).find((l) => l.startsWith("# "));
  return line ? line.slice(2).trim() : "(card has no top-level heading)";
}

/** Pull the card's "**Gates...:**" checkbox block as the contract, verbatim. Matches the
 * common `**Gates:**` / `**Gates (all before READY):**` / etc. bold-heading convention seen
 * across docs/tasks/*.md; cards using a different heading style (rare) fall back to a
 * pointer at the card itself rather than guessing. */
function extractGates(cardText: string): string {
  const lines = cardText.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => /^\*\*Gates\b.*\*\*/.test(l.trim()));
  if (startIdx === -1) return "(card has no **Gates...:** heading — read the card directly)";
  const out: string[] = [];
  const firstLine = lines[startIdx].trim();
  // Some cards state the gate inline on the heading line itself (e.g.
  // "**Gates:** `pnpm validate` green · ..."); keep that trailing text too.
  const inline = firstLine.replace(/^\*\*Gates\b[^*]*\*\*/, "").trim();
  if (inline) out.push(inline);
  for (let i = startIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\*\*[A-Za-z]/.test(l.trim())) break; // next **Section:**
    out.push(l);
  }
  return out.join("\n").trim();
}

function composePrompt(opts: {
  cardFile: string;
  cardPathAbs: string;
  cardText: string;
  worktree: string;
  branch: string;
  digest: string | null;
}): string {
  const goal = extractGoal(opts.cardText);
  const gates = extractGates(opts.cardText);
  const lines = [
    `GOAL: ${goal}`,
    "",
    `SCOPE: Work ONLY in the git worktree ${opts.worktree} (branch ${opts.branch}, already` +
      ` created — confirm with \`git -C ${opts.worktree} branch --show-current\` before any edit;` +
      ` every file operation goes through that path prefix). Read the card first:` +
      ` ${opts.cardPathAbs} (also read its "Read first" list before editing).` +
      ` At READY: rebase onto master, green gates, STOP — do not merge or push.`,
    "",
  ];
  if (opts.digest) {
    lines.push(
      "LANE RULES DIGEST (generated from canonical docs at spawn time; replaces the full AGENTS.md boot chain unless `--no-digest` was used):",
      opts.digest,
      "",
    );
  }
  lines.push(
    `CONTRACT: Fill the card's gate checkboxes box-by-box with cited proof in your FINAL` +
      ` MESSAGE (executive summary first; also append a "## Closeout" section to the card file` +
      ` only if it exists inside your worktree). The gates:`,
    gates,
    "",
    `DONE MEANS: every gate above is proven with a citation (file:line, command output, or` +
      ` capture path), \`pnpm -r typecheck\` and \`pnpm validate\` green in the worktree, work` +
      ` on ${opts.branch} either committed or staged+.commit-msg.txt per the digest's commit` +
      ` rule (rebase onto master if it moved), and then STOP. If blocked, state the blocking` +
      ` question as your final message and stop.`,
  );
  return lines.join("\n");
}

function main(): number {
  const { cardFile, engine, name, dryRun, model, sandbox: sandboxArg, noDigest } = parseArgs(process.argv.slice(2));

  const cardPathAbs = cardFile.replace(/\\/g, "/").startsWith("/") || /^[A-Za-z]:/.test(cardFile)
    ? cardFile.replace(/\\/g, "/")
    : join(ROOT, cardFile).replace(/\\/g, "/");
  if (!existsSync(cardPathAbs)) {
    console.error(`[lane-spawn] card file not found: ${cardPathAbs}`);
    return 1;
  }
  const cardText = readFileSync(cardPathAbs, "utf8");

  // §6c(i): workspace-write EPERMs Node child-process spawn, so any card whose
  // gates run a child process cannot self-verify under it — every code lane hit
  // this on 2026-07-03 and three more on 2026-07-05. ART/IMAGEGEN lanes hit it
  // too: the imagegen-lanternwake-art lane (python gates only — recipes.py/
  // fringe.py/rembg) stayed workspace-write, spawn-EPERM'd on a post-process
  // command, and HUNG for 7h without delivering (2026-07-05, owner-hit — art
  // never reached the bank). Match the whole gate text AND the card body so
  // python-tool and imagegen lanes upgrade too. An explicit --sandbox wins.
  const spawnCue = /\b(pnpm|smoke|capture:zone|capture:hud|vitest|build:client|zone:lint|zone:dod|recipes\.py|fringe\.py|rimfix\.py|display-audit\.py|rembg|imagegen|imagegen:extract|python)\b/i;
  const gatesNeedProcessSpawn = spawnCue.test(extractGates(cardText)) || spawnCue.test(cardText);
  const sandbox: SandboxTier = sandboxArg ?? (gatesNeedProcessSpawn ? "danger-full-access" : "workspace-write");
  if (!sandboxArg && gatesNeedProcessSpawn) {
    console.log("[lane-spawn] sandbox AUTO-UPGRADED to danger-full-access: card gates run pnpm/smoke/capture (workspace-write would spawn-EPERM them, §6c(i))");
  }

  const lane = deriveLaneName(cardFile, name);
  const branch = `codex/card-${lane}`;
  // Worktree location — env-overridable, same contract as lane-close.ts's husk sweep.
  // Historical defaults (Z:/gamekit-<lane>) until the toolkit models a worktree-root config.
  const worktree = `${process.env.LANE_WORKTREE_PARENT ?? "Z:/"}${process.env.LANE_WORKTREE_PREFIX ?? "gamekit-"}${lane}`;

  if (existsSync(worktree)) {
    console.error(`[lane-spawn] refusing: worktree already exists at ${worktree}`);
    return 1;
  }
  if (gitExists(ROOT, ["rev-parse", "--verify", branch])) {
    console.error(`[lane-spawn] refusing: branch already exists: ${branch}`);
    return 1;
  }

  const digest = noDigest ? null : generateLaneDigest({ root: ROOT, cardPathAbs }).text;
  const prompt = composePrompt({ cardFile, cardPathAbs, cardText, worktree, branch, digest });

  const codexCmd =
    `codex exec -C "${worktree}" -s ${sandbox} --json` +
    (model ? ` -m ${model}` : "") +
    ` -o "${worktree}/.codex-last-message.txt" - < "${worktree}/.codex-prompt.txt"` +
    ` > tools/_lanes/${lane}-events.jsonl 2> tools/_lanes/${lane}-stderr.txt` +
    ` (via PowerShell Start-Process, detached)`;

  if (dryRun) {
    console.log("[lane-spawn] DRY RUN — no changes made");
    console.log(`  lane:     ${lane}`);
    console.log(`  branch:   ${branch}`);
    console.log(`  worktree: ${worktree}`);
    console.log(`  engine:   ${engine}`);
    console.log(`  SANDBOX:  ${sandbox}`);
    if (engine === "codex") {
      console.log(`  command:  ${codexCmd}`);
    }
    console.log("  prompt:");
    console.log(prompt);
    return 0;
  }

  if (!assertPrimaryCwd()) return 1;

  // 1. worktree + branch off the integration branch
  git(ROOT, ["worktree", "add", worktree, "-b", branch, integrationBranch()]);
  console.log(`[lane-spawn] worktree created: ${worktree} (${branch})`);

  if (existsSync(join(worktree, "node_modules"))) {
    console.log("[lane-spawn] pnpm install skipped: node_modules already exists");
  } else {
    console.log("[lane-spawn] running pnpm install in new worktree");
    execSync("pnpm install", { cwd: worktree, stdio: "inherit" });
  }

  // 1b. Gitignored-dependency preflight (mechanics rule (m); 2nd occurrence
  // mechanized 2026-07-08): fresh worktrees inherit NOTHING gitignored — a
  // paid-gen lane booted tokenless (cast canary) and an anim lane substituted
  // the BiRefNet matte because the venv was absent (postmortem item 8).
  {
    const cardTextForDeps = readFileSync(cardPathAbs, "utf8");
    const paidGen = /seedance|replicate|paid clip|imagegen|animate\.py|video route/i.test(cardTextForDeps);
    const animMatte = /birefnet|matte|animation\.md|runtime sheet/i.test(cardTextForDeps);
    if (paidGen) {
      const envSrc = join(ROOT, "tools/art-pipeline/.env");
      const envDst = join(worktree, "tools/art-pipeline/.env");
      if (existsSync(envSrc)) {
        copyFileSync(envSrc, envDst);
        console.log("[lane-spawn] preflight: tools/art-pipeline/.env copied into worktree (gitignored, never committed)");
      } else {
        console.log("[lane-spawn] preflight WARNING: card looks paid-gen but primary tools/art-pipeline/.env is MISSING — the lane will block on the provider token");
      }
    }
    if (animMatte && !existsSync(join(ROOT, "tmp/birefnet64-venv/Scripts/python.exe"))) {
      console.log("[lane-spawn] preflight WARNING: card touches the anim matte but tmp/birefnet64-venv is MISSING in the PRIMARY tree — the substitution ban requires the integrator to run BiRefNet from primary (animation.md)");
    }
  }

  // 2. sync roster (execSync goes through a shell so `npx` resolves on Windows,
  // matching lane-close.ts's convention).
  try {
    git(ROOT, ["worktree", "list"]); // sanity: confirms git sees it before sync
    execSync("npx tsx tools/src/sessions-sync.ts --write", { cwd: ROOT, encoding: "utf8" });
    console.log("[lane-spawn] roster synced");
  } catch (e) {
    console.log(`[lane-spawn] roster sync failed — run sessions-sync manually (${(e as Error).message.split("\n")[0]})`);
  }

  const startedAt = new Date().toISOString();

  if (engine === "agent") {
    const entry = makeLaneEntry({ root: ROOT, lane, branch, worktree, engine: "agent", threadId: null, card: cardPathAbs, now: startedAt });
    updateLaneRegistry(ROOT, (entries) => [...entries.filter((existing) => existing.lane !== lane), entry]);
    console.log(`[lane-spawn] engine=agent — hand this prompt to the orchestrator's Agent tool:`);
    console.log(prompt);
    console.log(`[lane-spawn] lane recorded in ${LANES_JSON}`);
    return 0;
  }

  // engine === "codex": launch detached, stdout JSONL / stderr to per-lane files.
  //
  // Node's child_process.spawn(..., { detached: true }) does NOT reliably survive
  // on this Windows setup: verified live that the detached grandchild (and its
  // redirected stdio) is torn down with the launching process regardless of
  // `unref()`, `shell`, or explicit `cmd.exe /c ... > file` redirection — zero
  // bytes ever land in the output files. PowerShell's `Start-Process` performs a
  // real Windows-native detach and DOES survive; verified live with a full codex
  // exec run (thread.started -> file edit -> commit -> turn.completed all
  // observed after the launching process exited). So the launch goes through
  // `Start-Process` with -RedirectStandardOutput/-RedirectStandardError, and the
  // prompt (arbitrary multi-line text with quotes) is written to a file and piped
  // via stdin (`codex exec -` reads stdin per --help) instead of being placed on
  // the command line, per the architecture doc's stdin/heredoc rule (§6c note d).
  ensureLanesDir(ROOT);
  const eventsPath = join(LANES_DIR, `${lane}-events.jsonl`);
  const stderrPath = join(LANES_DIR, `${lane}-stderr.txt`);
  const promptPath = join(worktree, ".codex-prompt.txt");
  const lastMessagePath = join(worktree, ".codex-last-message.txt");
  writeFileSync(promptPath, prompt, "utf8");

  const winWorktree = worktree.replace(/\//g, "\\");
  const winEvents = eventsPath.replace(/\//g, "\\");
  const winStderr = stderrPath.replace(/\//g, "\\");
  const winPrompt = promptPath.replace(/\//g, "\\");
  const winLastMessage = lastMessagePath.replace(/\//g, "\\");
  const modelFlag = model ? ` -m ${model}` : "";
  const cmdLine =
    `codex exec -C "${winWorktree}" -s ${sandbox} --json${modelFlag}` +
    ` -o "${winLastMessage}" - < "${winPrompt}" > "${winEvents}" 2> "${winStderr}"`;

  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Start-Process -FilePath cmd.exe -ArgumentList '/c ${cmdLine.replace(/'/g, "''")}' -WorkingDirectory '${winWorktree}' -WindowStyle Hidden`,
    ],
    { encoding: "utf8" },
  );

  console.log(`[lane-spawn] SANDBOX TIER: ${sandbox}`);
  console.log(`[lane-spawn] codex exec launched via Start-Process (detached)`);
  console.log(`[lane-spawn] prompt file: ${promptPath}`);
  console.log(`[lane-spawn] events: ${eventsPath}`);
  console.log(`[lane-spawn] stderr: ${stderrPath}`);

  // Parse the first thread.started line (poll briefly; codex may take a moment to emit it).
  const threadId = pollThreadId(eventsPath, 15000);
  if (!threadId) {
    console.log("[lane-spawn] WARNING: no thread.started event observed within 15s — recording thread_id: null; check stderr file");
  } else {
    console.log(`[lane-spawn] thread_id: ${threadId}`);
  }

  const entry = makeLaneEntry({ root: ROOT, lane, branch, worktree, engine: "codex", threadId, card: cardPathAbs, now: startedAt });
  updateLaneRegistry(ROOT, (entries) => [...entries.filter((existing) => existing.lane !== lane), entry]);
  console.log(`[lane-spawn] lane recorded in ${LANES_JSON}`);
  return 0;
}

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function pollThreadId(eventsPath: string, timeoutMs: number): string | null {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(eventsPath)) {
      const text = readFileSync(eventsPath, "utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const evt: unknown = JSON.parse(line);
          if (
            evt &&
            typeof evt === "object" &&
            (evt as Record<string, unknown>).type === "thread.started"
          ) {
            const id = (evt as Record<string, unknown>).thread_id;
            if (typeof id === "string") return id;
          }
        } catch {
          // partial line write; retry on next poll
        }
      }
    }
    sleepSync(500);
  }
  return null;
}

process.exit(main());

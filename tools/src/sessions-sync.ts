import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const ACTIVE_SESSIONS_DOC = join(ROOT, "docs", "state", "active-sessions.md");
const SESSION_CARD_FILE = ".session-card";

const BEGIN_MARKER = "<!-- BEGIN GENERATED ROSTER -->";
const END_MARKER = "<!-- END GENERATED ROSTER -->";

interface WorktreeEntry {
  path: string;
  branch: string;
}

interface SessionCard {
  session: string;
  role: string;
  notes: string;
}

const normalizePath = (value: string): string =>
  value.trim().replace(/\\/g, "/").replace(/\/$/, "");

const parseWorktreeList = (text: string): WorktreeEntry[] => {
  const entries: WorktreeEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\S+)\s+\S+(?:\s+\[(.+?)\])?/.exec(line.trim());
    if (!match) continue;
    entries.push({
      path: normalizePath(match[1]),
      branch: match[2] ?? "(detached)",
    });
  }
  return entries;
};

const parseSessionCard = (worktreePath: string): SessionCard | null => {
  const cardPath = join(worktreePath.replace(/\//g, "\\"), SESSION_CARD_FILE);
  if (!existsSync(cardPath)) return null;
  const text = readFileSync(cardPath, "utf8");
  const get = (key: string): string => {
    const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(text);
    return match ? match[1].trim() : "";
  };
  const session = get("session");
  const role = get("role");
  const notes = get("notes");
  if (!session) return null;
  return { session, role, notes };
};

const generateRosterTable = (worktrees: WorktreeEntry[]): string => {
  const rows: string[] = [];
  rows.push("| Session | Branch | Worktree | Role | Notes |");
  rows.push("| --- | --- | --- | --- | --- |");

  for (const wt of worktrees) {
    const card = parseSessionCard(wt.path);
    const session = card?.session ?? wt.path.split("/").pop() ?? wt.path;
    const role = card?.role ?? "";
    const notes = card?.notes ?? "";
    rows.push(
      `| ${session} | \`${wt.branch}\` | \`${wt.path}\` | ${role} | ${notes} |`,
    );
  }

  return rows.join("\n");
};

const checkOnly = process.argv.includes("--check");

// The roster only has meaning in the canonical primary worktree (the game repo root on
// the owner's machine). In CI there is a single throwaway checkout, and in lane worktrees
// the doc is stale by definition (lanes must NOT edit docs/state on their branch) —
// enforcing there would force the exact write-race this tool exists to kill.
if (process.env.CI) {
  console.log("[sessions:sync] CI checkout has no session roster; skipping");
  process.exit(0);
}

const worktreeText = execFileSync("git", ["worktree", "list"], {
  cwd: ROOT,
  encoding: "utf8",
});
const worktrees = parseWorktreeList(worktreeText);

const primary = worktrees[0]?.path ?? "";
if (normalizePath(ROOT) !== primary) {
  if (checkOnly) {
    console.log(
      `[sessions:sync] not the primary worktree (${primary}); roster check is integrator-only — skipping`,
    );
    process.exit(0);
  }
  console.error(
    `[sessions:sync] refusing to write the roster outside the primary worktree (${primary}); lanes never edit docs/state`,
  );
  process.exit(1);
}
const generatedTable = generateRosterTable(worktrees);

if (!existsSync(ACTIVE_SESSIONS_DOC)) {
  console.error(
    `[sessions:sync] docs/state/active-sessions.md not found at ${ACTIVE_SESSIONS_DOC}`,
  );
  process.exit(1);
}

const doc = readFileSync(ACTIVE_SESSIONS_DOC, "utf8");
const beginIdx = doc.indexOf(BEGIN_MARKER);
const endIdx = doc.indexOf(END_MARKER);

if (beginIdx === -1 || endIdx === -1) {
  if (checkOnly) {
    console.error(
      `[sessions:sync] docs/state/active-sessions.md is missing roster markers (${BEGIN_MARKER} / ${END_MARKER}); run \`pnpm sessions:sync\` to initialize`,
    );
    process.exit(1);
  }
  console.error(
    `[sessions:sync] docs/state/active-sessions.md is missing roster markers; cannot inject table`,
  );
  process.exit(1);
}

const before = doc.slice(0, beginIdx + BEGIN_MARKER.length);
const after = doc.slice(endIdx);
const expected = `${before}\n${generatedTable}\n${after}`;
const normalizedDoc = doc.replace(/\r\n/g, "\n");
const normalizedExpected = expected.replace(/\r\n/g, "\n");

if (normalizedDoc === normalizedExpected) {
  console.log("[sessions:sync] roster is up to date");
  process.exit(0);
}

if (checkOnly) {
  console.error(
    "[sessions:sync] roster drift detected — docs/state/active-sessions.md does not match git worktree list + .session-card files",
  );
  console.error("[sessions:sync] expected table:");
  console.error(generatedTable);
  process.exit(1);
}

writeFileSync(ACTIVE_SESSIONS_DOC, normalizedExpected, "utf8");
console.log(
  `[sessions:sync] updated docs/state/active-sessions.md with ${worktrees.length} worktree(s)`,
);

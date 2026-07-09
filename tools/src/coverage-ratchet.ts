/**
 * Coverage ratchet — the executable form of "Coverage Gates: Ratchet, Not Cliff"
 * (docs/state/decisions.md, 2026-07-03). Coverage is measured now; the CI gate never
 * lets a workspace's line coverage fall below its recorded baseline, and it never lets
 * the baseline climb past the ratified ceilings (shared 90% / server 80% / client 60%).
 *
 * Runs `vitest run --coverage` (root vitest.config.ts already wires provider v8 +
 * json-summary + `all: true` so untouched files count against the total), then compares
 * per-workspace lines.pct against tools/coverage-baseline.json.
 *
 * Usage:
 *   pnpm coverage:check                      # compare current run vs baseline; exit 1 on regression
 *   pnpm coverage:update                     # rewrite baseline to current (capped at ceilings,
 *                                             #   refuses to lower without GAMEKIT_COVERAGE_LOWER_OK=1)
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const COVERAGE_SUMMARY = join(ROOT, "coverage", "coverage-summary.json");
const BASELINE_PATH = join(ROOT, "tools", "coverage-baseline.json");

type Workspace = "server" | "shared" | "client";
const WORKSPACE_PREFIXES: Record<Workspace, string> = {
  server: "/server/src/",
  shared: "/shared/src/",
  client: "/client/src/",
};

const CEILINGS: Record<Workspace, number> = { shared: 90, server: 80, client: 60 };

type CoverageSummary = {
  total: { lines: { pct: number } };
  [file: string]: unknown;
};

type BaselineWorkspace = { lines: number; note?: string };
type Baseline = {
  generated_at: string;
  ceilings: Record<Workspace, number>;
  workspaces: Record<Workspace, BaselineWorkspace>;
};

function runCoverage(): void {
  console.log("[coverage-ratchet] running `pnpm exec vitest run --coverage`...");
  try {
    const out = execSync("pnpm exec vitest run --coverage", { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
    console.log(tail(out, 20));
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    console.log(tail(`${err.stdout ?? ""}${err.stderr ?? ""}`, 40));
    console.error("[coverage-ratchet] vitest run failed (tests must pass before coverage is trustworthy).");
    process.exit(1);
  }
}

function tail(text: string, lines: number): string {
  return text.trimEnd().split(/\r?\n/).slice(-lines).join("\n");
}

function loadSummary(): CoverageSummary {
  if (!existsSync(COVERAGE_SUMMARY)) {
    console.error(`[coverage-ratchet] missing ${COVERAGE_SUMMARY} after the vitest run.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(COVERAGE_SUMMARY, "utf8")) as CoverageSummary;
}

function loadBaseline(): Baseline {
  if (!existsSync(BASELINE_PATH)) {
    console.error(`[coverage-ratchet] missing baseline ${BASELINE_PATH}. Seed it with \`pnpm coverage:update\`.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

// Per-workspace lines pct, computed from the raw per-file entries (not vitest's `total`,
// which mixes every workspace together). `all: true` in vitest.config.ts means every
// included file appears here even with zero tests touching it, so the baseline is honest.
function perWorkspaceLines(summary: CoverageSummary): Record<Workspace, { covered: number; total: number; pct: number; fileCount: number }> {
  const acc: Record<Workspace, { covered: number; total: number }> = {
    server: { covered: 0, total: 0 },
    shared: { covered: 0, total: 0 },
    client: { covered: 0, total: 0 },
  };
  const fileCount: Record<Workspace, number> = { server: 0, shared: 0, client: 0 };
  for (const [file, entry] of Object.entries(summary)) {
    if (file === "total") continue;
    const norm = file.replace(/\\/g, "/");
    const ws = (Object.keys(WORKSPACE_PREFIXES) as Workspace[]).find((w) => norm.includes(WORKSPACE_PREFIXES[w]));
    if (!ws) continue;
    const lines = (entry as { lines: { covered: number; total: number } }).lines;
    acc[ws].covered += lines.covered;
    acc[ws].total += lines.total;
    fileCount[ws] += 1;
  }
  const result = {} as Record<Workspace, { covered: number; total: number; pct: number; fileCount: number }>;
  for (const ws of Object.keys(acc) as Workspace[]) {
    const { covered, total } = acc[ws];
    result[ws] = { covered, total, pct: total > 0 ? Math.round((covered / total) * 10000) / 100 : 0, fileCount: fileCount[ws] };
  }
  return result;
}

function check(): number {
  runCoverage();
  const summary = loadSummary();
  const baseline = loadBaseline();
  const current = perWorkspaceLines(summary);

  let failed = false;
  for (const ws of Object.keys(CEILINGS) as Workspace[]) {
    const base = baseline.workspaces[ws]?.lines ?? 0;
    const cur = current[ws].pct;
    const note = current[ws].fileCount === 0 ? " (no files tracked yet)" : "";
    if (cur < base) {
      failed = true;
      console.error(
        `[coverage-ratchet] FAIL ${ws}: lines ${cur.toFixed(2)}% < baseline ${base.toFixed(2)}%${note}`,
      );
    } else {
      console.log(`[coverage-ratchet] OK ${ws}: lines ${cur.toFixed(2)}% >= baseline ${base.toFixed(2)}%${note}`);
      if (cur > base + 0.5) {
        console.log(
          `[coverage-ratchet] ratchet up available for ${ws}: current ${cur.toFixed(2)}% is ${(cur - base).toFixed(2)} pts above baseline — run \`pnpm coverage:update\``,
        );
      }
    }
  }

  if (failed) {
    console.error("[coverage-ratchet] coverage regressed below the recorded baseline. Add tests or investigate before merging.");
    return 1;
  }
  console.log("[coverage-ratchet] OK — no workspace regressed below its baseline.");
  return 0;
}

function update(): number {
  runCoverage();
  const summary = loadSummary();
  const previous = existsSync(BASELINE_PATH) ? loadBaseline() : null;
  const current = perWorkspaceLines(summary);
  const lowerOk = process.env.GAMEKIT_COVERAGE_LOWER_OK === "1";

  const workspaces = {} as Baseline["workspaces"];
  for (const ws of Object.keys(CEILINGS) as Workspace[]) {
    const ceiling = CEILINGS[ws];
    const prevPct = previous?.workspaces[ws]?.lines ?? 0;
    let next = Math.min(current[ws].pct, ceiling);
    if (next < prevPct && !lowerOk) {
      console.error(
        `[coverage-ratchet] REFUSED to lower ${ws} baseline: current ${current[ws].pct.toFixed(2)}% < previous ${prevPct.toFixed(2)}%.`,
      );
      console.error("[coverage-ratchet] The ratchet only goes up. To deliberately lower it: GAMEKIT_COVERAGE_LOWER_OK=1 pnpm coverage:update");
      next = prevPct;
    } else if (next < prevPct && lowerOk) {
      console.error(`[coverage-ratchet] WARNING: lowering ${ws} baseline from ${prevPct.toFixed(2)}% to ${next.toFixed(2)}% (GAMEKIT_COVERAGE_LOWER_OK=1).`);
    }
    if (current[ws].pct >= ceiling) {
      next = ceiling;
      console.log(`[coverage-ratchet] ${ws} at/above ceiling (${ceiling}%) — capped there.`);
    }
    const entry: BaselineWorkspace = { lines: next };
    if (current[ws].fileCount === 0) entry.note = "no tests yet";
    workspaces[ws] = entry;
  }

  const baseline: Baseline = {
    generated_at: new Date().toISOString(),
    ceilings: CEILINGS,
    workspaces,
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  console.log(`[coverage-ratchet] baseline written to ${BASELINE_PATH}:`);
  console.log(JSON.stringify(baseline, null, 2));
  return 0;
}

function main(argv: string[]): number {
  const isUpdate = argv.includes("--update");
  return isUpdate ? update() : check();
}

process.exit(main(process.argv.slice(2)));

/**
 * Zone DoD verdict artifact — generates a fillable JSON of the ZONE DEFINITION OF
 * DONE checklist (zone-building-guide.md), pre-filling the MECHANICAL boxes by
 * running the placement gates and leaving the human/visual boxes pending for the
 * reviewer. A READY report for a zone card attaches this JSON; the integrator
 * re-runs the same command to confirm. This is the executable form of "the DoD
 * checklist IS the acceptance contract" (owner escalation 2026-07-02) — the Harbor
 * patchwork shipped because nobody opened that checklist box-by-box.
 *
 * Mechanical pre-fill sources:
 *   - zone-lint            (scale 1.0, promoted-on-disk, ordinal spawns, bounds, dupes, density)
 *   - display-audit.py     (per-placement on-screen size ceilings + resolution)
 *   - walkability-probe.py (reachability + edge containment)
 *   - sweep coverage/freshness (captures present for every grid cell AND newer than
 *                               the layout mtime — the B3 "capture newer than content" rule)
 *
 * Verdict-JSON convention matches recipes.py / zone-lint.ts. Exit 0 = every
 * MECHANICAL box PASS (human boxes pending is fine), 1 = any mechanical FAIL,
 * 2 = usage/read error.
 *
 * Usage:
 *   pnpm zone:dod <mapId|layout.json> <captureDir> [--json OUT.json]
 *   pnpm zone:dod map_harbor_outskirts tools/_capture-sweep
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { CAMERA_ZOOM_1440P_BASIS } from "@gamekit/game-contract";
import { listCaptureShots, sha256File } from "./proof-hash";
import { sweepGridForCapture } from "./zone-sweep-grid";

const ROOT = process.cwd();
const DISPLAY_AUDIT = join(ROOT, "tools", "asset-cleanup", "display-audit.py");
const WALKABILITY = join(ROOT, "tools", "asset-cleanup", "walkability-probe.py");
const ZONE_LINT = join(ROOT, "tools", "src", "zone-lint.ts");

type BoxStatus = "pass" | "fail" | "pending";
type Category = "mechanical" | "human";
type ChecklistBox = {
  id: string;
  category: Category;
  box: string;
  status: BoxStatus;
  evidence: string;
  note: string;
};

type ToolRun = { command: string; exitCode: number | null; result: "PASS" | "FAIL"; output: string };

function tail(text: string, lines = 12): string {
  return text.trimEnd().split(/\r?\n/).slice(-lines).join("\n");
}

function runPython(script: string, args: string[]): ToolRun {
  // shell:true so `python`/`.cmd` shims resolve on Windows as well as POSIX.
  const res = spawnSync("python", [script, ...args], { cwd: ROOT, encoding: "utf-8", shell: true });
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return {
    command: `python ${basename(script)} ${args.join(" ")}`,
    exitCode: res.status,
    result: res.status === 0 ? "PASS" : "FAIL",
    output: tail(output),
  };
}

function runZoneLint(layout: string): { run: ToolRun; verdict: unknown } {
  const tmp = join(ROOT, "tools", "_zone-dod-lint.tmp.json");
  if (existsSync(tmp)) rmSync(tmp);
  // shell:true so the `npx`/`tsx` .cmd shim resolves on Windows.
  const res = spawnSync("npx", ["tsx", ZONE_LINT, layout, "--json", tmp], { cwd: ROOT, encoding: "utf-8", shell: true });
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  let verdict: unknown = null;
  if (existsSync(tmp)) {
    try {
      verdict = JSON.parse(readFileSync(tmp, "utf-8"));
    } catch {
      verdict = null;
    }
    rmSync(tmp);
  }
  return {
    run: {
      command: `zone:lint ${basename(layout)}`,
      exitCode: res.status,
      result: res.status === 0 ? "PASS" : "FAIL",
      output: tail(output),
    },
    verdict,
  };
}

type SweepReport = {
  result: "PASS" | "FAIL";
  expected: number;
  found: number;
  missing: string[];
  stale: string[];
  layoutMtimeMs: number;
  oldestCaptureMtimeMs: number | null;
  detail: string;
};

function checkSweep(layout: string, captureDir: string, mapWidth: number, mapHeight: number): SweepReport {
  const grid = sweepGridForCapture(mapWidth, mapHeight, CAMERA_ZOOM_1440P_BASIS);
  const expectedNames: string[] = [];
  for (let r = 0; r < grid.rows; r += 1) {
    for (let c = 0; c < grid.cols; c += 1) expectedNames.push(`sweep_r${r}c${c}.png`);
  }
  const layoutMtimeMs = statSync(layout).mtimeMs;
  const present = existsSync(captureDir)
    ? new Set(readdirSync(captureDir).filter((f) => /^sweep_r\d+c\d+\.png$/.test(f)))
    : new Set<string>();
  const missing = expectedNames.filter((n) => !present.has(n));
  const stale: string[] = [];
  let oldest: number | null = null;
  for (const name of expectedNames) {
    if (!present.has(name)) continue;
    const m = statSync(join(captureDir, name)).mtimeMs;
    oldest = oldest === null ? m : Math.min(oldest, m);
    if (m < layoutMtimeMs) stale.push(name); // B3: a capture older than the layout is stale
  }
  const found = expectedNames.length - missing.length;
  const ok = missing.length === 0 && stale.length === 0;
  return {
    result: ok ? "PASS" : "FAIL",
    expected: expectedNames.length,
    found,
    missing,
    stale,
    layoutMtimeMs,
    oldestCaptureMtimeMs: oldest,
    detail: ok
      ? `${found}/${expectedNames.length} sweep cells present and newer than layout`
      : `${missing.length} missing, ${stale.length} stale (older than layout mtime)`,
  };
}

// The ZONE DEFINITION OF DONE boxes, verbatim intent from zone-building-guide.md.
// `mechanical` boxes are pre-filled from the gate runs; `human` boxes stay pending
// with an empty evidence field for the reviewer to fill from the sweep captures.
function buildChecklist(
  lintVerdict: { result?: string; checks?: Array<{ name: string; status: string; detail: string }> } | null,
  displayAudit: ToolRun,
  walkability: ToolRun,
  sweep: SweepReport,
  groundRegionCount: number,
  spawnCount: number,
  hasLandmarks: boolean,
): ChecklistBox[] {
  const lintCheck = (name: string) => lintVerdict?.checks?.find((c) => c.name === name);
  const lintStatus = (name: string): BoxStatus => {
    const c = lintCheck(name);
    if (!c) return "pending";
    return c.status === "FAIL" ? "fail" : "pass"; // WARN counts as pass (non-blocking)
  };
  const lintDetail = (name: string) => lintCheck(name)?.detail ?? "zone-lint check not found";

  const sweepEvidence = `${sweep.found}/${sweep.expected} sweep cells in captureDir`;

  return [
    // Mechanical — ground-region budget is a layout fact.
    {
      id: "ground_material_budget",
      category: "mechanical",
      box: "Ground-material budget: ONE ground overlay covering the whole zone (a 2nd region is owner-gated).",
      status: groundRegionCount === 1 ? "pass" : "pending",
      evidence: `layout ground regions = ${groundRegionCount}`,
      note:
        groundRegionCount === 1
          ? "single overlay — zero ground-to-ground seams (default pattern)"
          : "more than one ground region — owner-gated exception; reviewer must confirm the visual boxes below",
    },
    { id: "no_identical_edge_pieces_adjacent", category: "human", box: "No two identical edge pieces adjacent (variants alternate/flip).", status: "pending", evidence: "", note: "judge in sweep close-ups" },
    { id: "no_visible_region_rectangles", category: "human", box: "No visible region rectangles; every material boundary is transition-covered, family-coherent, continuous.", status: "pending", evidence: "", note: "judge in sweep close-ups" },
    { id: "paths_connect", category: "human", box: "Paths connect two meaningful endpoints; no orphaned material islands.", status: "pending", evidence: "", note: "judge in sweep close-ups" },
    { id: "composition_not_scattering", category: "human", box: "Composition, not scattering: purposeful clusters, no bald ground >~300px in settled areas.", status: "pending", evidence: "", note: "judge in sweep close-ups" },
    { id: "overlaps_read_as_depth", category: "human", box: "Overlaps read as depth, never as collision (baselines differ; no interpenetration).", status: "pending", evidence: "", note: "judge in sweep close-ups" },
    { id: "tiles_are_not_decals", category: "human", box: "Tiles are not decals (no full-bleed tile placed as a decal slicing across props).", status: "pending", evidence: "", note: "judge in sweep close-ups" },
    { id: "plan_before_placement", category: "human", box: "Plan before placement: district/material plan written + reviewed (new zone or full re-dress).", status: "pending", evidence: "", note: "process box — cite the plan doc" },
    // Mechanical — scale sanity is display-audit + zone-lint's scale check.
    {
      id: "scale_sanity",
      category: "mechanical",
      box: "Scale sanity (person < bench/well < stall/boat; 1:1 rule) per the playbook.",
      status: displayAudit.result === "PASS" && lintStatus("prop_scale_1.0") === "pass" ? "pass" : "fail",
      evidence: `display-audit ${displayAudit.result} (exit ${displayAudit.exitCode}); zone-lint prop_scale_1.0 ${lintStatus("prop_scale_1.0")}`,
      note: lintDetail("prop_scale_1.0"),
    },
    // Mechanical-assisted — density + monster count feed "reads full"; visual richness still human.
    {
      id: "zone_reads_full",
      category: "human",
      box: "Zone reads FULL: dressed fields + clusters + decals AND a populated, varied monster field.",
      status: "pending",
      evidence: `zone-lint density: ${lintDetail("scatter_density_band")}; monster spawn fields = ${spawnCount}`,
      note: "mechanical density/monster-count is advisory; reviewer confirms visual richness in sweep",
    },
    { id: "edges_themed", category: "human", box: "Edges are themed, never raw void (cliff/coast/treeline/cave/open-air — not a flat cutoff).", status: "pending", evidence: "", note: "judge every border cell in the sweep" },
    { id: "portals_diegetic", category: "human", box: "Portals are diegetic (built, themed entrance with surround dressing + FX), not a bare vortex.", status: "pending", evidence: "", note: "judge the portal cell(s) in the sweep" },
    // Mechanical — reachability.
    {
      id: "walkability",
      category: "mechanical",
      box: "Walkability: no invisible walls / unreachable pockets; edge containment holds (walk-test all four edges).",
      status: walkability.result === "PASS" ? "pass" : "fail",
      evidence: `walkability-probe ${walkability.result} (exit ${walkability.exitCode})`,
      note: "flood-fill of the compiled collision grid with the server footprint",
    },
    // Mechanical — landmark reachability (the "player can't reach X" failure class).
    {
      id: "landmark_reachability",
      category: "mechanical",
      box: "Landmark reachability: every named repro landmark (cliff base, windmill rear, blossom tree, granary door, ...) is standable.",
      status: !hasLandmarks
        ? "pending"
        : /LANDMARKS:\s*PASS/.test(walkability.output)
          ? "pass"
          : "fail",
      evidence: hasLandmarks
        ? (walkability.output.match(/LANDMARKS:.*/)?.[0] ?? "landmarks fed to probe; no summary line found")
        : "no <mapId>.landmarks.json — add one to gate 'player can't reach X' repros",
      note: "probe --landmarks: a reachable flood-fill cell must fall within tol px of each point",
    },
    // Mechanical — the review surface itself must exist and be fresh.
    {
      id: "closeup_captures_inspected",
      category: "mechanical",
      box: "Close-up captures inspected (full-map sweep present + fresh); the checklist is judged there.",
      status: sweep.result === "PASS" ? "pass" : "fail",
      evidence: sweepEvidence,
      note: sweep.detail,
    },
  ];
}

function main(argv: string[]): number {
  const positional = argv.slice(2).filter((a) => !a.startsWith("--"));
  const jsonIdx = argv.indexOf("--json");
  const jsonOut = jsonIdx >= 0 ? argv[jsonIdx + 1] : undefined;
  if (positional.length < 2) {
    console.error("usage: zone:dod <mapId|layout.json> <captureDir> [--json OUT.json]");
    return 2;
  }
  const [mapArg, captureDir] = positional;

  // Resolve layout + map manifest paths from a mapId or a layout path.
  const mapId = mapArg.endsWith(".layout.json") ? basename(mapArg).replace(/\.layout\.json$/, "") : mapArg;
  const layout = mapArg.endsWith(".layout.json") ? mapArg : join(ROOT, "content", "zones", `${mapId}.layout.json`);
  const mapJson = join(ROOT, "content", "maps", `${mapId}.json`);
  for (const [label, p] of [["layout", layout], ["map manifest", mapJson]] as const) {
    if (!existsSync(p)) {
      console.error(`[zone:dod] ${label} not found: ${p}`);
      return 2;
    }
  }

  const layoutData = JSON.parse(readFileSync(layout, "utf-8")) as {
    bounds: { width: number; height: number };
    ground?: unknown[];
    monsterSpawns?: unknown[];
  };
  const { width, height } = layoutData.bounds;
  const groundRegionCount = (layoutData.ground ?? []).length;
  const spawnCount = (layoutData.monsterSpawns ?? []).length;

  // Landmark reachability assertions live next to the layout (optional). When present
  // they are fed to the SAME probe run so its exit code (and the walkability box) also
  // fails when a named landmark — cliff base, windmill rear, blossom tree — is blocked.
  // This is what turns "0 unreachable pockets but the player is hard-stuck" (owner walk
  // 2026-07-03) into a mechanical FAIL (card-bloomvale-collision-tune scope 4).
  const landmarks = join(ROOT, "content", "zones", `${mapId}.landmarks.json`);
  const hasLandmarks = existsSync(landmarks);

  console.log(`[zone:dod] ${mapId}: running mechanical gates...`);
  const { run: lintRun, verdict: lintVerdict } = runZoneLint(layout);
  const displayAudit = runPython(DISPLAY_AUDIT, [layout]);
  const walkability = runPython(WALKABILITY, hasLandmarks ? [mapJson, "--landmarks", landmarks] : [mapJson]);
  const sweep = checkSweep(layout, captureDir, width, height);

  const checklist = buildChecklist(
    lintVerdict as never,
    displayAudit,
    walkability,
    sweep,
    groundRegionCount,
    spawnCount,
    hasLandmarks,
  );

  const mechanical = checklist.filter((b) => b.category === "mechanical");
  const mechFail = mechanical.filter((b) => b.status === "fail");
  const pendingHuman = checklist.filter((b) => b.category === "human" && b.status === "pending");

  const verdict = {
    tool: "zone-dod.ts",
    mapId,
    layout,
    captureDir,
    proof: {
      schemaVersion: 1,
      layout: {
        path: layout.replace(/\\/g, "/"),
        sha256: sha256File(layout),
      },
      shots: listCaptureShots(captureDir),
    },
    generated: "fill the pending human boxes from the sweep captures; do not close the card until every box is pass",
    result: mechFail.length === 0 ? "PASS" : "FAIL",
    mechanicalResult: mechFail.length === 0 ? "PASS" : "FAIL",
    summary: {
      mechanicalBoxes: mechanical.length,
      mechanicalFailed: mechFail.length,
      humanBoxesPending: pendingHuman.length,
    },
    gates: {
      zoneLint: { ...lintRun, verdict: lintVerdict },
      displayAudit,
      walkability,
      sweep,
    },
    checklist,
  };

  const out = jsonOut ?? layout.replace(/\.layout\.json$/, "") + ".zonedod-verdict.json";
  writeFileSync(out, JSON.stringify(verdict, null, 2) + "\n", "utf-8");

  // Human-readable summary.
  const width2 = Math.max(...checklist.map((b) => b.id.length));
  for (const b of checklist) {
    const tag = b.status === "pass" ? "PASS" : b.status === "fail" ? "FAIL" : "pend";
    const cat = b.category === "mechanical" ? "M" : "H";
    console.log(`  [${tag}] (${cat}) ${b.id.padEnd(width2)}  ${b.evidence}`);
  }
  console.log(
    `${verdict.result}: DoD ${mapId} — ${mechanical.length - mechFail.length}/${mechanical.length} mechanical boxes pass, ` +
      `${pendingHuman.length} human box(es) pending (verdict: ${out})`,
  );
  if (mechFail.length > 0) {
    console.error(`[zone:dod] mechanical FAIL: ${mechFail.map((b) => b.id).join(", ")}`);
  }
  return mechFail.length > 0 ? 1 : 0;
}

process.exit(main(process.argv));

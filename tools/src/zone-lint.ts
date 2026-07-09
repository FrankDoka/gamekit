/**
 * Zone layout lint — static, no-boot checks on content/zones/*.layout.json that
 * mechanize the parts of the ZONE PATTERN a schema validator can't see. This is the
 * placement-review gate: the 2026-07-02 Harbor patchwork slipped through three human
 * layers because zone review was sampled and manual (card-zone-gates; owner standing
 * order: second occurrence of a failure class -> executable gate).
 *
 * Complements `pnpm zone:validate` (schema + assetKey membership + 1:1 scale for
 * props) — this adds the layout-composition invariants: promoted keys resolve to a
 * FILE on disk, ordinal spawn ids, anchors inside bounds (+margin), no exact-position
 * stacks, and the scatter density band.
 *
 * Verdict-JSON convention matches tools/asset-cleanup/recipes.py exactly:
 *   { tool, target, result: "PASS"|"FAIL", checks: [{name, status, detail}] }
 * WARN never fails the run; only FAIL does. Exit 0 = PASS (warnings allowed),
 * 1 = any FAIL, 2 = usage/read error.
 *
 * Usage:
 *   pnpm zone:lint content/zones/<map>.layout.json [--json OUT.json]
 *   pnpm zone:lint --all                 # every layout; exit 1 if any FAILs
 *   pnpm zone:lint --all --warn-only     # never exit 1 (the pnpm validate wiring)
 *
 * Tunables (doctrine defaults; visual-tuning-playbook + zone-building-guide):
 *   --density-min 15 --density-max 35    # ~15-35 placements per gameplay screen
 *   --bounds-margin 400                  # border props bleed past the edge to seal
 *                                        # it; beyond this = runaway coordinate bug
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CAMERA_NATIVE_BASIS_HEIGHT,
  CAMERA_ZOOM_1440P_BASIS,
} from "@gamekit/game-contract";

const ROOT = process.cwd();
const ZONES_DIR = join(ROOT, "content", "zones");
const ASSETS_DIR = join(ROOT, "client", "public", "assets");
const REGISTRY_PATH = join(ASSETS_DIR, "promoted-registry.json");

// A gameplay screen in WORLD px at the fixed 1440p-basis camera zoom. Density is
// judged per this screen (zone-building-guide "aim ~15-35 visible per screen").
const SCREEN_H = CAMERA_NATIVE_BASIS_HEIGHT / CAMERA_ZOOM_1440P_BASIS;
const SCREEN_W = (Math.round((CAMERA_NATIVE_BASIS_HEIGHT * 16) / 9) / CAMERA_ZOOM_1440P_BASIS);
const SCREEN_AREA = SCREEN_W * SCREEN_H;

export type CheckStatus = "PASS" | "WARN" | "FAIL";
export type Check = { name: string; status: CheckStatus; detail: string };
export type Verdict = { tool: string; target: string; result: "PASS" | "FAIL"; checks: Check[] };

type Options = {
  json?: string;
  all: boolean;
  warnOnly: boolean;
  densityMin: number;
  densityMax: number;
  boundsMargin: number;
};

type Placement = { instanceId: string; assetKey: string; x: number; y: number; scale?: number };
type Layout = {
  bounds: { width: number; height: number };
  ground: Placement[];
  decals: Placement[];
  props: Placement[];
  monsterSpawns: Array<{ instanceId: string; monsterId: string }>;
};

type RegistryEntry = { targetName?: string; targetPath?: string };

function parseArgs(argv: string[]): { targets: string[]; opts: Options } {
  const opts: Options = {
    all: argv.includes("--all"),
    warnOnly: argv.includes("--warn-only"),
    densityMin: 15,
    densityMax: 35,
    boundsMargin: 400,
  };
  const targets: string[] = [];
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") opts.json = argv[++i];
    else if (arg === "--density-min") opts.densityMin = Number(argv[++i]);
    else if (arg === "--density-max") opts.densityMax = Number(argv[++i]);
    else if (arg === "--bounds-margin") opts.boundsMargin = Number(argv[++i]);
    else if (arg === "--all" || arg === "--warn-only") continue;
    else if (arg.startsWith("--")) continue;
    else targets.push(arg);
  }
  return { targets, opts };
}

function loadRegistryByTargetName(): Map<string, RegistryEntry> {
  const byName = new Map<string, RegistryEntry>();
  if (!existsSync(REGISTRY_PATH)) return byName;
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8")) as {
    promoted?: Record<string, RegistryEntry>;
  };
  for (const entry of Object.values(registry.promoted ?? {})) {
    if (typeof entry.targetName === "string" && entry.targetName.length > 0) {
      byName.set(entry.targetName, entry);
    }
  }
  return byName;
}

// Resolve a promoted assetKey to a real file under client/public/assets, mirroring
// display-audit.py's candidate order (registry targetPath first, then the by-kind
// conventional dirs). Returns the relative path or null if nothing exists on disk.
function resolveAssetFile(key: string, registry: Map<string, RegistryEntry>): string | null {
  const entry = registry.get(key);
  const candidates: string[] = [];
  if (entry?.targetPath) {
    const rel = entry.targetPath.split("assets/").pop();
    if (rel) candidates.push(rel);
  }
  candidates.push(`props/${key}.png`, `decals/${key}.png`, `tilesets/${key}.png`, `tiles/${key}.png`);
  for (const rel of candidates) {
    if (rel && existsSync(join(ASSETS_DIR, rel))) return rel;
  }
  return null;
}

export const DEFAULT_LINT_OPTIONS: Options = {
  all: false,
  warnOnly: false,
  densityMin: 15,
  densityMax: 35,
  boundsMargin: 400,
};

export function lintLayout(target: string, opts: Options = DEFAULT_LINT_OPTIONS): Verdict {
  const raw = readFileSync(target, "utf-8");
  const layout = JSON.parse(raw) as Layout;
  const registry = loadRegistryByTargetName();
  const checks: Check[] = [];

  const W = layout.bounds.width;
  const H = layout.bounds.height;
  const props = layout.props ?? [];
  const decals = layout.decals ?? [];
  const ground = layout.ground ?? [];
  const spawns = layout.monsterSpawns ?? [];

  // (1) 1:1 rule — props ship at their exact display px and place at scale 1.0
  // (shimmer/D3-v2). Decals are exempt (transition/flora decals legitimately scale).
  const offScale = props.filter((p) => Math.abs((p.scale ?? 1) - 1) > 1e-6);
  checks.push({
    name: "prop_scale_1.0",
    status: offScale.length === 0 ? "PASS" : "FAIL",
    detail:
      offScale.length === 0
        ? `${props.length} props at scale 1.0`
        : `${offScale.length} prop(s) off 1.0: ` +
          offScale.slice(0, 5).map((p) => `${p.instanceId}=${p.scale}`).join(", "),
  });

  // (2) promoted keys resolve to a FILE on disk (zone:validate checks registry
  // membership; a key can be registered but the PNG missing -> renders nothing).
  const missing: string[] = [];
  for (const [section, list] of [["ground", ground], ["decals", decals], ["props", props]] as const) {
    for (const p of list) {
      if (!resolveAssetFile(p.assetKey, registry)) missing.push(`${section}:${p.instanceId}(${p.assetKey})`);
    }
  }
  checks.push({
    name: "promoted_keys_on_disk",
    status: missing.length === 0 ? "PASS" : "FAIL",
    detail:
      missing.length === 0
        ? `${ground.length + decals.length + props.length} placements resolve to a file`
        : `${missing.length} missing: ${missing.slice(0, 5).join(", ")}`,
  });

  // (3) ordinal spawn ids — every monsterSpawn instanceId must carry a trailing
  // numeric ordinal and be unique. Both live exporter schemes satisfy this
  // (`monster_spawn_field_N` and `monster_spawn_<species>_<x>_<y>_<n>`); a hand-authored
  // spawn that drops the ordinal or collides with another id is the "per-zone index
  // collision" that orphans invisible colliders and traps the player at field edges
  // (zone-building-guide "Engine invariants"). Contiguity/0-based is NOT required —
  // the two schemes number differently.
  const noOrdinal = spawns.filter((s) => !/_\d+$/.test(s.instanceId)).map((s) => s.instanceId);
  const idCounts = new Map<string, number>();
  for (const s of spawns) idCounts.set(s.instanceId, (idCounts.get(s.instanceId) ?? 0) + 1);
  const dupIds = [...idCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  let spawnStatus: CheckStatus = "PASS";
  let spawnDetail = `${spawns.length} spawn id(s) carry a unique ordinal suffix`;
  if (spawns.length === 0) {
    spawnDetail = "no monster spawns";
  } else if (noOrdinal.length > 0) {
    spawnStatus = "FAIL";
    spawnDetail = `${noOrdinal.length} spawn id(s) missing a trailing ordinal: ${noOrdinal.slice(0, 5).join(", ")}`;
  } else if (dupIds.length > 0) {
    spawnStatus = "FAIL";
    spawnDetail = `duplicate spawn instanceId(s): ${dupIds.slice(0, 5).join(", ")}`;
  }
  checks.push({ name: "spawn_ids_ordinal", status: spawnStatus, detail: spawnDetail });

  // (4) anchors within bounds (+margin). Border props deliberately bleed a few hundred
  // px past the edge to seal it (zone-building-guide border rows); beyond the margin is
  // a runaway-coordinate bug, not an intentional overhang.
  const M = opts.boundsMargin;
  const oob: string[] = [];
  for (const [section, list] of [["decals", decals], ["props", props]] as const) {
    for (const p of list) {
      if (p.x < -M || p.x > W + M || p.y < -M || p.y > H + M) {
        oob.push(`${section}:${p.instanceId}(${p.x},${p.y})`);
      }
    }
  }
  checks.push({
    name: "anchors_within_bounds",
    status: oob.length === 0 ? "PASS" : "FAIL",
    detail:
      oob.length === 0
        ? `all anchors within [${-M}..${W + M}]x[${-M}..${H + M}]`
        : `${oob.length} beyond margin ${M}: ${oob.slice(0, 5).join(", ")}`,
  });

  // (5) no duplicate exact-position stacks — two placements in the same section at an
  // identical (x,y) is almost always an accidental double-place (invisible, wasted, and
  // a Y-sort flicker). Jittered scatter never lands two on the same subpixel.
  const stacks: string[] = [];
  for (const [section, list] of [["decals", decals], ["props", props]] as const) {
    const seen = new Map<string, string>();
    for (const p of list) {
      const key = `${p.x},${p.y}`;
      const prev = seen.get(key);
      if (prev) stacks.push(`${section}:${prev}+${p.instanceId}@(${key})`);
      else seen.set(key, p.instanceId);
    }
  }
  checks.push({
    name: "no_duplicate_position_stacks",
    status: stacks.length === 0 ? "PASS" : "FAIL",
    detail:
      stacks.length === 0
        ? "no exact-position duplicates"
        : `${stacks.length} stack(s): ${stacks.slice(0, 5).join(", ")}`,
  });

  // (6) scatter density band — WARN-only guideline (towns run denser by design; this
  // surfaces "barely any assets" and "wallpaper" without blocking). props+decals over
  // the number of gameplay screens the map spans.
  const placements = props.length + decals.length;
  const screens = (W * H) / SCREEN_AREA;
  const perScreen = placements / screens;
  const inBand = perScreen >= opts.densityMin && perScreen <= opts.densityMax;
  checks.push({
    name: "scatter_density_band",
    status: inBand ? "PASS" : "WARN",
    detail:
      `${perScreen.toFixed(1)}/screen (${placements} placements / ${screens.toFixed(2)} screens; ` +
      `band ${opts.densityMin}-${opts.densityMax})` + (inBand ? "" : " -> outside pattern band"),
  });

  const failed = checks.some((c) => c.status === "FAIL");
  return {
    tool: "zone-lint.ts",
    target,
    result: failed ? "FAIL" : "PASS",
    checks,
  };
}

function printVerdict(verdict: Verdict): void {
  const width = Math.max(...verdict.checks.map((c) => c.name.length));
  for (const c of verdict.checks) {
    console.log(`  [${c.status}] ${c.name.padEnd(width)}  ${c.detail}`);
  }
  console.log(`${verdict.result}: ${basename(verdict.target)}`);
}

function main(argv: string[]): number {
  const { targets, opts } = parseArgs(argv);

  let files: string[];
  if (opts.all) {
    if (!existsSync(ZONES_DIR)) {
      console.log("[zone:lint] No content/zones/ directory — nothing to lint.");
      return 0;
    }
    files = readdirSync(ZONES_DIR)
      .filter((f) => f.endsWith(".layout.json"))
      .map((f) => join(ZONES_DIR, f));
    if (files.length === 0) {
      console.log("[zone:lint] No .layout.json files found — nothing to lint.");
      return 0;
    }
  } else {
    if (targets.length === 0) {
      console.error("usage: zone:lint <layout.json> [--json OUT] | --all [--warn-only]");
      return 2;
    }
    files = targets;
  }

  const verdicts: Verdict[] = [];
  for (const file of files) {
    if (!existsSync(file)) {
      console.error(`[zone:lint] not found: ${file}`);
      return 2;
    }
    let verdict: Verdict;
    try {
      verdict = lintLayout(file, opts);
    } catch (err) {
      console.error(`[zone:lint] failed to lint ${file}: ${(err as Error).message}`);
      return 2;
    }
    printVerdict(verdict);
    verdicts.push(verdict);
    // single-target: write the verdict JSON next to the layout (or --json path)
    if (!opts.all) {
      const out = opts.json ?? file.replace(/\.json$/, "") + ".zonelint-verdict.json";
      writeFileSync(out, JSON.stringify(verdict, null, 2) + "\n", "utf-8");
      console.log(`(verdict: ${out})`);
    }
  }

  const anyFail = verdicts.some((v) => v.result === "FAIL");
  if (opts.all) {
    const failing = verdicts.filter((v) => v.result === "FAIL").map((v) => basename(v.target));
    if (anyFail && opts.warnOnly) {
      console.warn(
        `[zone:lint] WARNING (non-blocking): ${failing.length} layout(s) FAIL zone-lint: ${failing.join(", ")}. ` +
          `Fix before this pass goes blocking (card-zone-gates: blocking after one green week).`,
      );
      return 0;
    }
    if (anyFail) {
      console.error(`[zone:lint] FAILED: ${failing.join(", ")}`);
      return 1;
    }
    console.log(`[zone:lint] OK — ${verdicts.length} layout(s) clean.`);
  }
  return anyFail ? 1 : 0;
}

// Entrypoint guard: only run when invoked directly (so the self-test can import
// lintLayout without triggering the CLI's process.exit).
const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  process.exit(main(process.argv));
}

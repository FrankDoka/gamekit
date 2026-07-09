/**
 * Entity display-scale audit (card-npc-display-scale) — the durable gate that closes the
 * D3-v2 moving-edge shimmer class repo-wide.
 *
 * WHAT IT PROVES
 * --------------
 * The shimmer root cause (card-slime-display-scale, be57750b) is runtime MINIFICATION: a
 * MOVING world entity whose source->screen ratio != 1.0 reshuffles which source pixels land
 * on its rim every frame, so any motion crawls the edge. The fix is to render every moving
 * textured entity at ratio EXACTLY 1.0 (author at world px x zoom, render DOWN by
 * ASSET_BASIS_SCALE = 1/zoom so camera zoom cancels it — the "1440p basis" mechanism).
 *
 * source->screen ratio = renderScale x cameraZoom. The camera zoom is LOCKED at
 * CAMERA_ZOOM_1440P_BASIS (constants.ts: MIN == MAX == DEFAULT), and ASSET_BASIS_SCALE is its
 * reciprocal, so:
 *   - a BASIS entity renders at ASSET_BASIS_SCALE  -> ratio 1.0  (crisp, no crawl)
 *   - a NON-basis entity renders at the fit-to-96 x displayScale path -> ratio != 1.0 (crawls)
 *
 * Only MOVING entities produce this shimmer class (static props/chests/nodes/portals never
 * translate, so their rim never re-samples between frames). The moving textured entities are:
 *   - monsters  (createMonsterAvatar / setMonsterTexture: the static-idle branch)
 *   - NPCs      (createNpcAvatar: setScale(assetBasisFactor))
 * The player uses exact-size animation sheets (a different, sheet-scaled path) and is out of
 * scope. Loot sparkles are procedural Arcs (no texture -> no ratio). Portal ground rings are a
 * soft VFX glow placeholder (no cel rim, named art follow-up) — audited & reported, not gated.
 *
 * THE GATE
 * --------
 * For every PROMOTED, TEXTURED, MOVING entity sprite, this asserts it is a 1440p-basis asset
 * (=> ratio 1.0). Any promoted moving entity that is NOT basis renders minified and is a
 * shimmer-class violation. Known, documented exceptions (currently only monster_gloamslime,
 * whose 256px master would have to UPSCALE to its ~423px boss size = a re-generation, named
 * follow-up per card-slime-display-scale) are listed in KNOWN_NON_BASIS and reported as WARN.
 *
 * MODE
 * ----
 * Default (no flag): report + exit 0 (WARN advisory — the standard ratchet: prove a green week
 * before it blocks). `--strict`: exit 1 on any un-excepted violation (the ratchet flip).
 * `--selftest`: verify the derivation constants against the client source, exit non-zero on drift.
 *
 * Reads the generated client config (auto-generated, stable format) as the single source of
 * truth for which sprites are promoted and which are basis — never re-lists them here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const PROMOTED_ASSETS_TS = join(ROOT, "client", "src", "config", "promoted-assets.ts");
const CONSTANTS_TS = join(ROOT, "client", "src", "config", "constants.ts");

// Derived from constants.ts (cited): CAMERA_ZOOM_1440P_BASIS = 1440 / (88 * 6.5) and
// ASSET_BASIS_SCALE = 1 / that. --selftest asserts these literals still match the source so the
// gate can never silently drift from the render path it audits.
const PLAYER_BODY_DISPLAY_HEIGHT = 88;
const CAMERA_NATIVE_BASIS_HEIGHT = 1440;
const CAMERA_REFERENCE_PLAYER_BODY_HEIGHTS = 6.5;
const CAMERA_ZOOM = CAMERA_NATIVE_BASIS_HEIGHT / (PLAYER_BODY_DISPLAY_HEIGHT * CAMERA_REFERENCE_PLAYER_BODY_HEIGHTS);
const ASSET_BASIS_SCALE = 1 / CAMERA_ZOOM;
const RATIO_TOLERANCE = 0.02;

// Promoted-and-textured moving entities that legitimately do NOT render at ratio 1.0, each with
// the ratified reason. These surface as WARN, never as a strict failure. Keep this list minimal;
// the intent is that it trends to empty as follow-up re-generations land.
const KNOWN_NON_BASIS: Record<string, string> = {
  // Empty since card-gloamslime-regen landed the 423px basis master (2026-07-07) —
  // the last WARN entry regenerated away, exactly as this list intended.
};

function readSourceTs(path: string): string {
  return readFileSync(path, "utf8");
}

/** Parse a `Record<string, string>` block (e.g. PROMOTED_SPRITES) into its key set. */
function parseRecordKeys(source: string, exportName: string): Set<string> {
  const start = source.indexOf(`export const ${exportName}`);
  if (start < 0) throw new Error(`entity-scale-audit: ${exportName} not found in promoted-assets.ts`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("};", open);
  if (open < 0 || close < 0) throw new Error(`entity-scale-audit: could not bound ${exportName}`);
  const body = source.slice(open + 1, close);
  const keys = new Set<string>();
  for (const m of body.matchAll(/"([^"]+)"\s*:/g)) keys.add(m[1]);
  return keys;
}

/** Parse a `new Set<string>([...])` block (PROMOTED_1440P_BASIS_ASSETS) into its member set. */
function parseSetMembers(source: string, exportName: string): Set<string> {
  const start = source.indexOf(`export const ${exportName}`);
  if (start < 0) throw new Error(`entity-scale-audit: ${exportName} not found in promoted-assets.ts`);
  const open = source.indexOf("[", start);
  const close = source.indexOf("]", open);
  if (open < 0 || close < 0) throw new Error(`entity-scale-audit: could not bound ${exportName}`);
  const body = source.slice(open + 1, close);
  const members = new Set<string>();
  for (const m of body.matchAll(/"([^"]+)"/g)) members.add(m[1]);
  return members;
}

type Row = {
  key: string;
  kind: "monster" | "npc";
  basis: boolean;
  ratio: number;
  status: "OK" | "WARN" | "VIOLATION";
  note?: string;
};

function audit(): { rows: Row[]; violations: Row[]; warns: Row[] } {
  const src = readSourceTs(PROMOTED_ASSETS_TS);
  const promotedSprites = parseRecordKeys(src, "PROMOTED_SPRITES");
  const basis = parseSetMembers(src, "PROMOTED_1440P_BASIS_ASSETS");

  // Moving textured entities render through PROMOTED_SPRITES: npc_* via createNpcAvatar,
  // monster_* via createMonsterAvatar. (Non-entity promoted art lives in PROMOTED_PROPS /
  // _DECALS / _TILES and is static, so it is not part of the moving-shimmer class.)
  const entityKeys = [...promotedSprites]
    .filter((k) => k.startsWith("monster_") || k.startsWith("npc_"))
    .sort();

  const rows: Row[] = [];
  for (const key of entityKeys) {
    const kind: Row["kind"] = key.startsWith("npc_") ? "npc" : "monster";
    const isBasis = basis.has(key);
    // Basis entity: renderScale = ASSET_BASIS_SCALE. Non-basis entity: the fit-to-96 x
    // displayScale path renders at a non-basis scale whose ratio is != 1.0 by construction
    // (renderScale x zoom, with renderScale far from ASSET_BASIS_SCALE). We report it as the
    // full-size upper bound (renderScale 1.0 => ratio == zoom); the exact value depends on the
    // per-asset displayScale, but ANY non-basis value != 1.0 is a violation regardless.
    const renderScale = isBasis ? ASSET_BASIS_SCALE : 1;
    const ratio = renderScale * CAMERA_ZOOM;
    const ratioOk = Math.abs(ratio - 1.0) <= RATIO_TOLERANCE;
    let status: Row["status"];
    let note: string | undefined;
    if (ratioOk) {
      status = "OK";
    } else if (key in KNOWN_NON_BASIS) {
      status = "WARN";
      note = KNOWN_NON_BASIS[key];
    } else {
      status = "VIOLATION";
      note = "promoted moving entity is NOT 1440p-basis -> renders minified (shimmer class).";
    }
    rows.push({ key, kind, basis: isBasis, ratio, status, note });
  }
  return {
    rows,
    violations: rows.filter((r) => r.status === "VIOLATION"),
    warns: rows.filter((r) => r.status === "WARN"),
  };
}

function selftest(): number {
  const constants = readSourceTs(CONSTANTS_TS);
  const problems: string[] = [];
  const expect = (label: string, present: boolean) => {
    if (!present) problems.push(label);
  };
  expect(
    "PLAYER_BODY_DISPLAY_HEIGHT = 88",
    /PLAYER_BODY_DISPLAY_HEIGHT\s*=\s*88\b/.test(constants),
  );
  expect(
    "CAMERA_NATIVE_BASIS_HEIGHT = 1440",
    /CAMERA_NATIVE_BASIS_HEIGHT\s*=\s*1440\b/.test(constants),
  );
  expect(
    "CAMERA_REFERENCE_PLAYER_BODY_HEIGHTS = 6.5",
    /CAMERA_REFERENCE_PLAYER_BODY_HEIGHTS\s*=\s*6\.5\b/.test(constants),
  );
  expect(
    "camera zoom is LOCKED (MIN == MAX == DEFAULT == 1440p basis)",
    /CAMERA_ZOOM_MIN\s*=\s*CAMERA_ZOOM_1440P_BASIS/.test(constants) &&
      /CAMERA_ZOOM_MAX\s*=\s*CAMERA_ZOOM_1440P_BASIS/.test(constants) &&
      /CAMERA_ZOOM_DEFAULT\s*=\s*CAMERA_ZOOM_1440P_BASIS/.test(constants),
  );
  expect(
    "ASSET_BASIS_SCALE = 1 / CAMERA_ZOOM_1440P_BASIS",
    /ASSET_BASIS_SCALE\s*=\s*1\s*\/\s*CAMERA_ZOOM_1440P_BASIS/.test(constants),
  );
  // The identity the whole gate rests on: basis renderScale x zoom == 1.
  if (Math.abs(ASSET_BASIS_SCALE * CAMERA_ZOOM - 1.0) > 1e-9) {
    problems.push(`ASSET_BASIS_SCALE * CAMERA_ZOOM != 1 (got ${ASSET_BASIS_SCALE * CAMERA_ZOOM})`);
  }
  if (problems.length > 0) {
    console.error("[entity-scale-audit] SELFTEST FAILED — render-path constants drifted from the gate:");
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  console.log("[entity-scale-audit] selftest OK (zoom locked, basis*zoom==1, derivation matches source).");
  return 0;
}

function main(): number {
  const strict = process.argv.includes("--strict");
  if (process.argv.includes("--selftest")) return selftest();

  const { rows, violations, warns } = audit();

  console.log(
    `[entity-scale-audit] moving textured entities: ${rows.length} audited ` +
      `(zoom ${CAMERA_ZOOM.toFixed(5)}, basis scale ${ASSET_BASIS_SCALE.toFixed(5)}; ratio 1.0 == crisp)`,
  );
  for (const r of rows) {
    const line = `  [${r.status.padEnd(9)}] ${r.kind.padEnd(7)} ${r.key.padEnd(34)} ratio ${r.ratio.toFixed(3)} basis=${r.basis}`;
    console.log(r.note ? `${line}\n      ${r.note}` : line);
  }

  if (warns.length > 0) {
    console.log(`[entity-scale-audit] ${warns.length} documented non-basis exception(s) (WARN, see notes).`);
  }

  if (violations.length > 0) {
    const msg = `[entity-scale-audit] ${violations.length} moving entity static(s) render minified (ratio != 1.0, not excepted):`;
    if (strict) {
      console.error(msg);
      for (const v of violations) console.error(`  - ${v.key}: fix by shipping it as a 1440p-basis static (see visual-tuning-playbook D3-v2).`);
      return 1;
    }
    console.warn(`${msg} (WARN — advisory until the ratchet flips to --strict).`);
    for (const v of violations) console.warn(`  - ${v.key}`);
    return 0;
  }

  console.log("[entity-scale-audit] PASS — every moving textured entity renders at source->screen ratio 1.0.");
  return 0;
}

process.exit(main());

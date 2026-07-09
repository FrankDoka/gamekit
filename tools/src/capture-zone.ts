/**
 * Zone visual capture — boots server+client (guest login) via the smoke harness,
 * then pans the camera to several framings of the active zone and saves PNGs.
 * This is the in-engine self-verification loop for zone/asset work.
 *
 * Usage: tsx tools/src/capture-zone.ts <outDir>
 * Saves <outDir>/zone-<label>.png for each framing.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { relative as pathRelative, resolve as pathResolve } from "node:path";
import { CAMERA_NATIVE_BASIS_HEIGHT, getCameraZoomForViewportHeight } from "@gamekit/game-contract";
import { createSmokeHarness, stopChildProcesses } from "./smoke/harness";
import { isTransientNavError } from "./capture-retry";
import { listCaptureShots, proofForFiles, visualProofFiles } from "./proof-hash";
import { SWEEP_CAPTURE_HEIGHT, SWEEP_CAPTURE_WIDTH, SWEEP_OVERLAP, sweepGridForCapture } from "./zone-sweep-grid";
import type { EditorSmokeScene, SmokeBrowserGlobal } from "./smoke/types";

type Shot = { label: string; cx: number; cy: number; zoom: number; file?: string };
type AspectAuditShot = { label: string; width: number; height: number; cx: number; cy: number };
type SmokeHarnessInstance = Awaited<ReturnType<typeof createSmokeHarness>>;
type SmokePage = SmokeHarnessInstance["pageA"];
// HUD-VIEWPORT-ANCHORING (card-hud-viewport-anchoring, scope item 5): minimal --viewport=WxH
// flag so the HUD anchoring proof can be captured at explicit window sizes (2560x1440,
// 1600x900, 1280x720, etc.) instead of only the fixed sweep-capture default. No existing
// flag did this — grepped `--viewport|setViewportSize` in this file before adding.
function parseViewportArg(): { width: number; height: number } | undefined {
  const arg = process.argv.find((a) => a.startsWith("--viewport="));
  if (!arg) return undefined;
  const match = /^(\d+)x(\d+)$/.exec(arg.slice("--viewport=".length));
  if (!match) throw new Error(`--viewport must be WIDTHxHEIGHT (e.g. --viewport=1280x720), got: ${arg}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

const CAPTURE_VIEWPORT = parseViewportArg() ?? { width: SWEEP_CAPTURE_WIDTH, height: SWEEP_CAPTURE_HEIGHT };
const ROOT = process.cwd();
const GAMEPLAY_ZOOM = getCameraZoomForViewportHeight(CAPTURE_VIEWPORT.height);
const basisZoom = (multiplier: number): number => Number((GAMEPLAY_ZOOM * multiplier).toFixed(4));

// --sweep: tile the FULL map in overlapping gameplay-zoom framings so no region goes
// unreviewed (card-zone-gates). The grid is derived from map size + the gameplay-zoom
// camera world-view with ~20% overlap; naming is deterministic `sweep_rYcX.png`. This
// is the mechanical answer to the Harbor patchwork ("review was sampled and manual").
// Grid math lives in zone-sweep-grid.ts so `zone:dod` checks the same expected count.
function buildSweepShots(mapWidth: number, mapHeight: number, zoom: number): Shot[] {
  const viewW = CAPTURE_VIEWPORT.width / zoom;
  const viewH = CAPTURE_VIEWPORT.height / zoom;
  const grid = sweepGridForCapture(mapWidth, mapHeight, zoom);
  const shots: Shot[] = [];
  for (let r = 0; r < grid.rows; r += 1) {
    for (let c = 0; c < grid.cols; c += 1) {
      const label = `sweep_r${r}c${c}`;
      shots.push({ label, cx: grid.xs[c], cy: grid.ys[r], zoom, file: `${label}.png` });
    }
  }
  console.log(
    `[capture] sweep grid ${grid.cols}x${grid.rows} = ${grid.count} framings ` +
      `(view ${Math.round(viewW)}x${Math.round(viewH)} world px, ${SWEEP_OVERLAP * 100}% overlap) ` +
      `over ${mapWidth}x${mapHeight} map`,
  );
  return shots;
}

function readMapBounds(mapId: string): { width: number; height: number } {
  const layoutPath = `content/zones/${mapId}.layout.json`;
  if (existsSync(layoutPath)) {
    const layout = JSON.parse(readFileSync(layoutPath, "utf8")) as { bounds?: { width: number; height: number } };
    if (layout.bounds?.width && layout.bounds?.height) return layout.bounds;
  }
  const mapPath = `content/maps/${mapId}.json`;
  const map = JSON.parse(readFileSync(mapPath, "utf8")) as { size?: { width: number; height: number } };
  if (map.size?.width && map.size?.height) return map.size;
  throw new Error(`could not read map bounds for ${mapId} (looked in ${layoutPath} and ${mapPath})`);
}

// Best-effort spawn point for a map: prefer the `default` spawn, else the first one.
// Falls back to the map center when no spawn points are authored. Reads the layout
// (source of truth for zone work) then the compiled map manifest. Never throws — a
// missing spawn just centers on the map so an unknown/spawn-less game still frames.
function readMapSpawn(mapId: string, bounds: { width: number; height: number }): { x: number; y: number } {
  const pickSpawn = (spawnPoints: Array<{ id?: unknown; x?: unknown; y?: unknown }> | undefined) => {
    if (!Array.isArray(spawnPoints) || spawnPoints.length === 0) return undefined;
    const chosen = spawnPoints.find((sp) => sp.id === "default") ?? spawnPoints[0];
    if (typeof chosen?.x === "number" && typeof chosen?.y === "number") return { x: chosen.x, y: chosen.y };
    return undefined;
  };
  const layoutPath = `content/zones/${mapId}.layout.json`;
  if (existsSync(layoutPath)) {
    const layout = JSON.parse(readFileSync(layoutPath, "utf8")) as { spawnPoints?: Array<{ id?: unknown; x?: unknown; y?: unknown }> };
    const fromLayout = pickSpawn(layout.spawnPoints);
    if (fromLayout) return fromLayout;
  }
  const mapPath = `content/maps/${mapId}.json`;
  if (existsSync(mapPath)) {
    const map = JSON.parse(readFileSync(mapPath, "utf8")) as { spawnPoints?: Array<{ id?: unknown; x?: unknown; y?: unknown }> };
    const fromMap = pickSpawn(map.spawnPoints);
    if (fromMap) return fromMap;
  }
  return { x: Math.round(bounds.width / 2), y: Math.round(bounds.height / 2) };
}

// Bounds-derived SHOTS for an arbitrary game map with no hardcoded framing table entry.
// Frames are computed from the map's own bounds + spawn point so the non-sweep pass works
// for ANY --map=<id> without falling back to a hardcoded map's framing. Mirrors the named-framing set's
// intent: an overview (whole map), a gameplay-zoom shot at spawn, and the MANDATORY
// closeup-inspect at spawn for edge/scale review.
function boundsDerivedShots(mapId: string): Shot[] {
  const bounds = readMapBounds(mapId);
  const spawn = readMapSpawn(mapId, bounds);
  const midX = Math.round(bounds.width / 2);
  const midY = Math.round(bounds.height / 2);
  // Overview zoom: fit the whole map into the capture viewport, then a small margin,
  // clamped so it never zooms IN past gameplay zoom for a tiny map.
  const fitZoom = Math.min(CAPTURE_VIEWPORT.width / bounds.width, CAPTURE_VIEWPORT.height / bounds.height) * 0.95;
  const overviewZoom = Number(Math.min(fitZoom, GAMEPLAY_ZOOM).toFixed(4));
  return [
    { label: "overview", cx: midX, cy: midY, zoom: overviewZoom },
    { label: "gameplay-framing", cx: spawn.x, cy: spawn.y, zoom: GAMEPLAY_ZOOM },
    { label: "spawn-wide", cx: spawn.x, cy: spawn.y, zoom: basisZoom(0.7) },
    // MANDATORY inspection close-up (visual-tuning-playbook): hero + nearby props filling the
    // frame so edge halos, outline artifacts, and relative-scale absurdities can't hide.
    { label: "closeup-inspect", cx: spawn.x, cy: spawn.y, zoom: basisZoom(1.6) },
  ];
}

// Bounds-derived aspect-audit shots centered on the map's spawn point, so the wide/narrow
// letterbox checks survey the actual playfield for ANY map instead of the Harbor center.
function boundsDerivedAspectShots(mapId: string): AspectAuditShot[] {
  const bounds = readMapBounds(mapId);
  const spawn = readMapSpawn(mapId, bounds);
  return [
    { label: "aspect-ultrawide", width: 3440, height: CAMERA_NATIVE_BASIS_HEIGHT, cx: spawn.x, cy: spawn.y },
    { label: "aspect-narrow", width: 1080, height: CAMERA_NATIVE_BASIS_HEIGHT, cx: spawn.x, cy: spawn.y },
  ];
}

const EDITOR_MAP_ID = "map_harbor_outskirts";

// Default framing map when no --map=<id> is given: prefer EDITOR_MAP_ID when that
// map's content exists, else fall back to the first authored zone layout so the
// plain/sweep capture stays game-agnostic instead of throwing on a hardcoded id.
// Never throws: returns EDITOR_MAP_ID if nothing is found so the downstream
// readMapBounds error message stays intact.
function resolveDefaultMapId(): string {
  if (existsSync(`content/maps/${EDITOR_MAP_ID}.json`) || existsSync(`content/zones/${EDITOR_MAP_ID}.layout.json`)) {
    return EDITOR_MAP_ID;
  }
  const zonesDir = "content/zones";
  if (existsSync(zonesDir)) {
    const firstLayout = readdirSync(zonesDir)
      .filter((f) => f.endsWith(".layout.json"))
      .sort()[0];
    if (firstLayout) return firstLayout.slice(0, -".layout.json".length);
  }
  return EDITOR_MAP_ID;
}

async function main(): Promise<void> {
  const outDir = process.argv[2] ?? "tools/_capture";
  const mapArg = process.argv.find((arg) => arg.startsWith("--map="));
  const targetMapId = mapArg?.slice("--map=".length);
  const sweepMode = process.argv.includes("--sweep");
  // With no --map, resolve the default framing map from the game's own content
  // (the first authored zone) so the plain/sweep path works for any game.
  const framingMapId = targetMapId ?? resolveDefaultMapId();
  const sweepBounds = sweepMode ? readMapBounds(framingMapId) : undefined;
  const shots = sweepBounds
    ? buildSweepShots(sweepBounds.width, sweepBounds.height, GAMEPLAY_ZOOM)
    : boundsDerivedShots(framingMapId);
  // Aspect-audit reframings: also bounds+spawn derived for whatever map we're framing.
  const aspectShots = boundsDerivedAspectShots(framingMapId);
  mkdirSync(outDir, { recursive: true });

  const harness = await createSmokeHarness({
    pageAQuery: targetMapId ? `?devMap=${encodeURIComponent(targetMapId)}` : undefined,
    allowSplitMaps: Boolean(targetMapId),
  });
  const page: SmokePage = harness.pageA;
  await page.setViewportSize(CAPTURE_VIEWPORT);
  // let the resize settle + textures finish
  await page.waitForTimeout(800);

  if (targetMapId && !harness.stateA.players.some((player) => player.sessionId === harness.joinedA.localSessionId && player.mapId === targetMapId)) {
    await page.evaluate(async (mapId) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game") as EditorSmokeScene | undefined;
      if (!scene?.setVisualQaMapOverride) throw new Error("GameScene.setVisualQaMapOverride unavailable for map capture");
      scene.setVisualQaMapOverride(mapId);
      scene.cameras?.main?.stopFollow();
      await new Promise((resolve) => setTimeout(resolve, 900));
    }, targetMapId);
  }

  for (const shot of shots) {
    const shotFile = `${outDir}/${shot.file ?? `zone-${shot.label}.png`}`;
    await withShotRetry(page, shot.label, async () => {
      await page.evaluate(
        ({ cx, cy, zoom }) => {
          const g = (globalThis as SmokeBrowserGlobal).__GAME;
          const scene = g?.scene?.getScene("game");
          const cam = scene?.cameras?.main;
          if (!cam) return;
          cam.stopFollow();
          cam.setZoom(zoom);
          cam.centerOn(cx, cy);
        },
        shot,
      );
      await page.waitForTimeout(450);
      await page.screenshot({ path: shotFile });
    });
    console.log(`[capture] ${shot.label} -> ${shotFile}`);
  }

  // Sweep is a pure full-map coverage pass — skip the aspect-audit reframings.
  for (const shot of sweepMode ? [] : aspectShots) {
    await withShotRetry(page, shot.label, async () => {
      await page.setViewportSize({ width: shot.width, height: shot.height });
      await page.waitForTimeout(350);
      await page.evaluate(
        ({ cx, cy, zoom }) => {
          const g = (globalThis as SmokeBrowserGlobal).__GAME;
          const scene = g?.scene?.getScene("game");
          const cam = scene?.cameras?.main;
          if (!cam) return;
          cam.stopFollow();
          cam.setZoom(zoom);
          cam.centerOn(cx, cy);
        },
        { ...shot, zoom: getCameraZoomForViewportHeight(shot.height) },
      );
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${outDir}/zone-${shot.label}.png` });
    });
    console.log(`[capture] ${shot.label} -> ${outDir}/zone-${shot.label}.png`);
  }

  writeVisualProof(outDir);

  await harness.browser.close();
  stopChildProcesses();
  console.log("[capture] done.");
}

function writeVisualProof(outDir: string): void {
  const captureDir = repoRelativePath(outDir);
  const visualProof = {
    schemaVersion: 1,
    kind: "gamekit-visual-proof",
    generatedAt: new Date().toISOString(),
    captureDir,
    inputs: proofForFiles(ROOT, visualProofFiles(ROOT)),
    shots: listCaptureShots(outDir).map((shot) => ({
      ...shot,
      path: `${captureDir}/${shot.path}`.replace(/\\/g, "/"),
    })),
  };
  writeFileSync(`${outDir}/visual-proof.json`, JSON.stringify(visualProof, null, 2) + "\n", "utf8");
  console.log(`[capture] visual proof -> ${outDir}/visual-proof.json`);
}

function repoRelativePath(file: string): string {
  const rel = pathRelative(ROOT, pathResolve(ROOT, file)).replace(/\\/g, "/");
  return rel.startsWith("../") ? file.replace(/\\/g, "/") : rel;
}

main().catch((err) => {
  console.error("[capture] FATAL:", err);
  stopChildProcesses();
  process.exit(1);
});

// Retry a single framing shot (camera evaluate + screenshot) when it hits a transient
// navigation race, rather than aborting the whole capture run. This is the mechanical fix for
// the observed `page.evaluate: Execution context was destroyed` flake (backlog p0, capture-zone).
async function withShotRetry(
  page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"],
  label: string,
  action: () => Promise<void>,
  attempts = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await action();
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= attempts || !isTransientNavError(error)) throw error;
      console.warn(`[capture] shot ${label} hit a transient navigation race (attempt ${attempt}/${attempts}), retrying: ${message}`);
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => undefined);
      await page.waitForTimeout(600);
    }
  }
}

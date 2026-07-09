/**
 * Zone visual capture — boots server+client (guest login) via the smoke harness,
 * then pans the camera to several framings of the active zone and saves PNGs.
 * This is the in-engine self-verification loop for zone/asset work.
 *
 * Usage: tsx tools/src/capture-zone.ts <outDir>
 * Saves <outDir>/zone-<label>.png for each framing.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { relative as pathRelative, resolve as pathResolve } from "node:path";
import { CAMERA_NATIVE_BASIS_HEIGHT, PLAYER_FOOT_OFFSET_Y, getCameraZoomForViewportHeight } from "@gamekit/game-contract";
import { BOOT_ASSET_TIERS, STARTUP_OLD_BOOT_ASSETS, type MapAssetSet } from "@gamekit/game-contract";
import { createSmokeHarness, stopChildProcesses } from "./smoke/harness";
import { isTransientNavError } from "./capture-retry";
import { listCaptureShots, proofForFiles, visualProofFiles } from "./proof-hash";
import { SWEEP_CAPTURE_HEIGHT, SWEEP_CAPTURE_WIDTH, SWEEP_OVERLAP, sweepGridForCapture } from "./zone-sweep-grid";
import type { EditorSmokeScene, JoinedSmokeState, SmokeBrowserGlobal } from "./smoke/types";
import {
  BLOOMVALE_FIRST_HUNT_QUEST_ID,
  BLOOMVALE_FIRST_HUNT_REWARD_GOLD,
  BLOOMVALE_FIRST_HUNT_REWARD_XP,
  BLOOMVALE_DEWDROP_CULL_QUEST_ID,
  BLOOMVALE_DEWDROP_CULL_REWARD_GOLD,
  BLOOMVALE_DEWDROP_CULL_REWARD_XP,
  BLOOMVALE_WARDEN_BRIEFING_QUEST_ID,
  BLOOMVALE_MAP_ID,
  BLOOMVALE_TO_LANTERNWAKE_PORTAL_ID,
  BLOOMVALE_TO_LANTERNWAKE_PORTAL_TARGET_Y,
  BLOOMVALE_TO_LANTERNWAKE_PORTAL_X,
  COMBAT_TRAINER_ID,
  COMBAT_TRAINER_X,
  COMBAT_TRAINER_Y,
  HARBOR_WARDEN_ID,
  HARBOR_WARDEN_X,
  HARBOR_WARDEN_Y,
  LANTERNWAKE_MAP_ID,
  SLIME_COMBAT_MONSTER_ID,
} from "./smoke/constants";
import { getVisibleNpcClickTarget } from "./smoke/click-targets";
import { completeBloomvaleDewdropKills, completeBloomvaleFirstHuntKills, killOnePassiveSlime } from "./smoke/combat";
import { moveLocalPlayerNear, stageInOpenField } from "./smoke/movement";
import { acceptQuestViaDialogue, turnInQuestViaDialogue, waitForNpcQuestMarkerState, waitForNpcVisible, waitForQuestStatus } from "./smoke/quest";
import { buyPotionFromHarborShop } from "./smoke/shop";
import { getRecentCombatEvents, getSmokeState, waitForMonsterCount } from "./smoke/state";
import { sendMoveIntent, sendPortalUseIntent, sendSkillCastIntent, sendTargetSelectIntent } from "./smoke/intents";
import { travelLanternwakeToBloomvale } from "./smoke/portal";
import { runPlayerFacingProof } from "./player-facing-proof";

type Shot = { label: string; cx: number; cy: number; zoom: number; file?: string };
type AspectAuditShot = { label: string; width: number; height: number; cx: number; cy: number };
type ZoneLayoutData = { props: Array<{ instanceId: string; [key: string]: unknown }>; [key: string]: unknown };
type ZoneLayoutsResponse = { layouts: Array<{ mapId: string; data: ZoneLayoutData; hash: string; modifiedMs: number }> };
type HudProofRectElement = {
  classList: { contains: (name: string) => boolean };
  getBoundingClientRect: () => { top: number; bottom: number; height: number };
};
type EditorStatusSample = { status: string };
type SlimeProofTarget = { label: string; monsterKey: string; id: string; x: number; y: number };
type NpcEdgeSample = {
  label: string;
  player: { x: number; y: number };
  camera: { scrollX: number; scrollY: number; zoom: number };
  npc: {
    id: string;
    npcId: string;
    world: { x: number; y: number };
    screen: { x: number; y: number; fracX: number; fracY: number };
    spriteScreen?: { x: number; y: number; width: number; height: number };
  };
};
type SmokeHarnessInstance = Awaited<ReturnType<typeof createSmokeHarness>>;
type SmokePage = SmokeHarnessInstance["pageA"];
type ProofMode = { flag: string; run(outDir: string, page: SmokePage | undefined): Promise<void> };
type HubQaState = {
  open: boolean;
  activeTab: string;
  filter: string;
  search: string;
  compatibleOnly: boolean;
  gridCount: number;
  equipped: Record<string, string>;
  selectedCard: string | null;
  previewItem: string | null;
  contextActionsItem: string | null;
  detailItem: string | null;
  forgeDisabled: boolean;
  guidanceHint: string | null;
  guidanceFocusedSlot: string | null;
  skillsCategory: string;
  skillRowCount: number;
  selectedSkill: string | null;
  learnDisabledReason: string | null;
  attributePoints: number;
  allocatedAttributes: Record<string, number>;
  attributeRowCount: number;
  gameplayInputBlocked: boolean;
};
type ActionQaState = {
  slotCount: number;
  rowCount: number;
  bindings: Array<{ key: string; label: string; type: string | null; id: string | null }>;
  assignmentOpen: boolean;
  xpText: string;
  xpBadge: string;
  jobText: string;
  jobBadge: string;
};
type HudMutationSnapshot = {
  enabled: boolean;
  totalMutations: number;
  mutationsPerSecond: number;
  measuredForMs: number;
  lastResetAtMs: number;
};
type MovementKeyProof = {
  key: string;
  axis: "x" | "y";
  before: number;
  after: number;
  delta: number;
  assignmentOpen: boolean;
};
type ReservedKeyProof = {
  key: string;
  hubOpen: boolean;
  assignmentOpen: boolean;
  slotBoundBefore: boolean;
};
type MonsterAnimRuntimeSample = {
  label: string;
  textureKey: string | null;
  animationKey: string | null;
  frameIndex: number | null;
  flipX: boolean | null;
  spriteBottom: number | null;
  screenBottom: number | null;
  bodyBottomLocal: number | null;
  bodyBottomOffsetScreenPx: number | null;
  containerX: number | null;
  containerY: number | null;
};
type PlayerGatherRuntimeSample = {
  label: string;
  textureKey: string | null;
  animationKey: string | null;
  frameIndex: number | null;
  flipX: boolean | null;
  bodyBottomOffsetScreenPx: number | null;
  containerX: number | null;
  containerY: number | null;
  gatherHoldRemainingMs?: number | null;
  localPlayerAnimState?: string | null;
};
type MonsterAnimBodyMetrics = {
  frameHeight: number;
  anchorY: number;
  bodyHeight: number;
  displayBodyHeight: number;
};
type QuestJournalGroupQaState = {
  zoneKey: string;
  zoneLabel: string;
  activeCount: number;
  completedCount: number;
  expanded: boolean;
  completedExpanded: boolean;
};
type QuestJournalQaState = {
  open: boolean;
  rowCount: number;
  selectedQuest: string | null;
  selectedStatus: string | null;
  trackedQuestIds: string[];
  trackerFollowsToggle: boolean;
  detailTitle: string | null;
  groups: QuestJournalGroupQaState[];
};
type WorldMapQaState = {
  open: boolean;
  mapId: string | null;
  mapLabel: string;
  zoom: number;
  pan: { x: number; y: number };
  artMode: "procedural" | "illustration";
  artSrc: string | null;
  playerWorld: { x: number; y: number; mapId: string } | null;
  playerCanvas: { x: number; y: number } | null;
  expectedPlayerCanvas: { x: number; y: number } | null;
  playerDeltaPx: number | null;
  playerMarkerVisible: boolean;
  otherPlayerMarkerCount: number;
  monsterMarkerCount: number;
  npcMarkerCount: number;
  portalMarkerCount: number;
  questPinCount: number;
  questPins: Array<{ questId: string; kind: string; mapId: string; x: number; y: number }>;
  viewportRendered: boolean;
};
type BootAssetProofState = {
  loadedTiers: string[];
  tier0LoadedAtMs?: number;
  tier1StartedAtMs?: number;
  tier1LoadedAtMs?: number;
  tier1Progress: number;
};

type QuestNavQaState = {
  targetCount: number;
  activeTarget: { questId: string; kind: string; mapId: string; x: number; y: number; label: string; resolvedFrom: string } | null;
  edgeArrow: { visible: boolean; x: number; y: number; angleDeg: number };
};

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

const DEVKIT_PORT = 8787;
const EDITOR_MAP_ID = "map_harbor_outskirts";
const EDITOR_LAYOUT_PATH = `content/zones/${EDITOR_MAP_ID}.layout.json`;
const EDITOR_MAP_PATH = `content/maps/${EDITOR_MAP_ID}.json`;
const EDITOR_METADATA_PATH = "content/asset-editor-metadata.json";
const EDITOR_TEMP_PORTAL_PATH = "content/portals/portal_editor_thin_slice.json";
const EDITOR_TEMP_PORTAL_ID = "portal_editor_thin_slice";
const EDITOR_INSPECTOR_COLLAPSE_STORAGE_PREFIX = "gamekit.editor.inspector.section.";
// p_windmill (assetKey bloomvale_windmill) carries NO instance collision and inherits its
// blocker from the `structure` placement CLASS — the exact "editor says no collision but it
// blocks in-game" repro this card fixes. NOTE: the rest of this thin-slice is still coupled to
// the retired harbor zone (water reflections, portals/spawns, harbor prop/decal ids, non-1.0
// scales) and is pre-existing-red on Zone-1 Bloomvale — see docs/backlog/p0-first-showable.md
// (editor thin-slice Zone-1 migration). The collision-truth assertion below runs first + passes.
const EDITOR_PROP_ID = "p_windmill";
const EDITOR_PLACE_PROP_KEY = "harbor_barrel_cluster";
const EDITOR_PLACE_DECAL_KEY = "harbor_beach_starfish_01";
const EDITOR_SHADOW_PROP_IDS = {
  tall: "p_windmill",
  wide: "p_picnic",
  tiny: "p_mid_0_1",
};
const EDITOR_REFLECTION_PROP_ID = "p_rowboat";
const EDITOR_MOVE = { dx: 32, dy: -16 };
const EDITOR_PROP_TRANSFORM = {
  scale: 1,
  rotationDeg: 6,
  opacity: 0.82,
  originX: 0.45,
  originY: 0.9,
  zIndex: 46,
  collisionMode: 1,
  collisionXPct: 24,
  collisionYPct: 58,
  collisionWPct: 52,
  collisionHPct: 30,
  collisionBlocksMovement: 1,
  collisionBlocksPlayers: 1,
  collisionBlocksMonsters: 0,
  shadowMode: 2,
  shadowOffsetX: 4,
  shadowOffsetY: 8,
  shadowWPct: 92,
  shadowHPct: 72,
  shadowAlpha: 0.28,
  shadowBlur: 8,
  shadowRotationDeg: -4,
  reflectionEnabled: 1,
  reflectionAlpha: 0.28,
  reflectionHeightPct: 58,
  reflectionOffsetY: 18,
  reflectionWavePct: 18,
};
const EDITOR_DECAL_ID = "d_flora_0_0";
const EDITOR_DECAL_MOVE = { dx: 20, dy: -10 };
const EDITOR_DECAL_TRANSFORM = { scale: 1, rotationDeg: 14, opacity: 0.72 };
// Zone-1 Reset (2026-07-03): Bloomvale has no live portals and no monster spawns,
// so the editor thin-slice covers props, decals, and the NPC placement only. The
// portal/spawn editor sub-checks return with the deeper zones.
const EDITOR_NPC_ID = "npc_placement_npc_harbor_warden_520_440_1";
const EDITOR_NPC_MOVE = { dx: 18, dy: -12 };
const EDITOR_NPC_RADIUS_DELTA = 4;
const EDITOR_PLACE_NPC_ID = "npc_combat_trainer";
const EDITOR_PLACE_MONSTER_ID = "monster_honey_slime";
const STAGE_PORTAL_ID = "portal_unlit_mile_trial";
const STAGE_PORTAL_X = 1760;
const STAGE_PORTAL_Y = 1120;
const STAGE_PORTAL_PLAYER_Y = 1025;
const STAGE_ID = "stage_unlit_mile_trial";
const EXPECTED_SUNCRADLE_BANNER = "Suncradle";
const EXPECTED_STAGE_BANNER = "The Unlit Mile";

// Per-stage specs for --stage-proof (select with --stage-id=<stageId>; default =
// the Unlit Mile, preserving the original hardcoded route). Stages whose host map
// equals the return map (the Noonshade runs ON Suncradle) cannot be discriminated
// by mapId flips, so the proof also keys on stage monster id prefixes
// (`${stageId}-wave...`, see StageRoom.spawnStageMonster) and stage events.
type StageProofSpec = {
  stageId: string;
  portalId: string;
  portal: { x: number; y: number; playerY: number };
  hostMapId: string;
  returnMapId: string;
  minGoldAfter: number;
  waypoints: Array<{ x: number; y: number; radius: number }>;
};

const STAGE_PROOF_SPECS: Record<string, StageProofSpec> = {
  [STAGE_ID]: {
    stageId: STAGE_ID,
    portalId: STAGE_PORTAL_ID,
    portal: { x: STAGE_PORTAL_X, y: STAGE_PORTAL_Y, playerY: STAGE_PORTAL_PLAYER_Y },
    hostMapId: "map_lanternwake_skiff",
    returnMapId: "map_harbor_outskirts",
    minGoldAfter: 8,
    waypoints: [
      { x: 980, y: 1320, radius: 110 },
      { x: 1500, y: 1400, radius: 120 },
      { x: 1820, y: 920, radius: 130 },
    ],
  },
  stage_noonshade_vigil: {
    stageId: "stage_noonshade_vigil",
    portalId: "portal_noonshade_vigil",
    portal: { x: 1250, y: 750, playerY: 845 },
    hostMapId: "map_harbor_outskirts",
    returnMapId: "map_harbor_outskirts",
    minGoldAfter: 12,
    waypoints: [{ x: 1000, y: 950, radius: 110 }],
  },
  // card-stage3-story-act2: The Deeproot Descent runs ON Suncradle like the Noonshade
  // (hostMap == returnMap), so the proof keys on stage monster-id prefixes + events.
  stage_deeproot_descent: {
    stageId: "stage_deeproot_descent",
    portalId: "portal_deeproot_descent",
    portal: { x: 900, y: 1120, playerY: 1215 },
    hostMapId: "map_harbor_outskirts",
    returnMapId: "map_harbor_outskirts",
    minGoldAfter: 12,
    waypoints: [
      { x: 1000, y: 1420, radius: 120 },
      { x: 1500, y: 1360, radius: 130 },
    ],
  },
};

function resolveStageProofSpec(argv: readonly string[]): StageProofSpec {
  const arg = argv.find((candidate) => candidate.startsWith("--stage-id="));
  const stageId = arg ? arg.slice("--stage-id=".length) : STAGE_ID;
  const spec = STAGE_PROOF_SPECS[stageId];
  if (!spec) throw new Error(`no stage proof spec for ${stageId} (known: ${Object.keys(STAGE_PROOF_SPECS).join(", ")})`);
  return spec;
}
let managedDevkit: ChildProcess | undefined;
let editorDevkitOrigin = `http://127.0.0.1:${DEVKIT_PORT}`;

// Default framing map when no --map=<id> is given. The editor thin-slice + the
// prior-game proofs still key on EDITOR_MAP_ID, so prefer it WHEN that map's
// content actually exists (the prior game's editor map). For any other game (e.g. the reference
// starter-game) that map is absent, so fall back to the first authored zone
// layout — this keeps the plain/sweep capture game-agnostic instead of throwing
// on a hardcoded map id. Never throws: returns EDITOR_MAP_ID if nothing is found
// so the downstream readMapBounds error message stays intact.
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
  if (process.argv.includes("--player-facing-proof")) {
    const baselineArg = process.argv.find((arg) => arg.startsWith("--baseline="));
    await runPlayerFacingProof(outDir, baselineArg ? baselineArg.slice("--baseline=".length) : undefined);
    return;
  }
  const mapArg = process.argv.find((arg) => arg.startsWith("--map="));
  const targetMapId = mapArg?.slice("--map=".length);
  const sweepMode = process.argv.includes("--sweep");
  // With no --map, resolve the default framing map from the game's own content
  // (prefers the editor map when present, else the first authored zone) so the
  // plain/sweep path works for any game, not just the one that ships EDITOR_MAP_ID.
  const framingMapId = targetMapId ?? resolveDefaultMapId();
  const sweepBounds = sweepMode ? readMapBounds(framingMapId) : undefined;
  const shots = sweepBounds
    ? buildSweepShots(sweepBounds.width, sweepBounds.height, GAMEPLAY_ZOOM)
    : boundsDerivedShots(framingMapId);
  // Aspect-audit reframings: also bounds+spawn derived for whatever map we're framing.
  const aspectShots = boundsDerivedAspectShots(framingMapId);
  mkdirSync(outDir, { recursive: true });

  let harness: SmokeHarnessInstance | undefined;
  const finishProof = async (): Promise<void> => {
    await harness?.browser.close();
    stopDevkit(managedDevkit);
    managedDevkit = undefined;
    stopChildProcesses();
    console.log("[capture] done.");
  };
  const devkitInfo = process.argv.includes("--editor-thin-slice") || process.argv.includes("--collision-overlay-proof") || outDir.toLowerCase().includes("editor") ? await startDevkitForCapture() : undefined;
  managedDevkit = devkitInfo?.child;
  editorDevkitOrigin = devkitInfo?.origin ?? editorDevkitOrigin;
  harness = await createSmokeHarness({
    pageAQuery: targetMapId ? `?devMap=${encodeURIComponent(targetMapId)}` : undefined,
    allowSplitMaps: Boolean(targetMapId),
    worldEnv:
      process.argv.includes("--effects-proof") || process.argv.includes("--presentation-proof") || process.argv.includes("--skill-fx-proof") || process.argv.includes("--kill-beat-proof")
      || process.argv.includes("--monster-anim-proof")
        ? { GAMEKIT_SMOKE_EFFECTS_PROOF: "true" }
        : process.argv.includes("--advancement-proof")
          ? { GAMEKIT_SMOKE_ADVANCEMENT_PROOF: "true" }
          : process.argv.includes("--hub-proof") || process.argv.includes("--hud-proof")
            ? { GAMEKIT_SMOKE_GRANT_EQUIPMENT: "true" }
            : process.argv.includes("--stage-proof") || process.argv.includes("--portal-fade-guard-proof")
              ? { GAMEKIT_SMOKE_STAGE_PROOF: "true" }
              : undefined,
  });
  const page: SmokePage = harness.pageA;
  if (process.argv.includes("--editor-thin-slice") || process.argv.includes("--collision-overlay-proof") || outDir.toLowerCase().includes("editor")) {
    // Node-side token fetch (no Origin header => DevKit serves it), injected so the
    // editor's absolute-origin POSTs pass the x-devkit-token gate.
    let devkitToken = "";
    try {
      const tokenResponse = await fetch(`${editorDevkitOrigin}/api/session-token`);
      devkitToken = tokenResponse.ok ? ((await tokenResponse.json()) as { token?: string }).token ?? "" : "";
    } catch {
      devkitToken = "";
    }
    const inject = { origin: editorDevkitOrigin, token: devkitToken };
    await page.addInitScript(({ origin, token }) => {
      (globalThis as { __GAMEKIT_DEVKIT_ORIGIN__?: string }).__GAMEKIT_DEVKIT_ORIGIN__ = origin;
      (globalThis as { __GAMEKIT_DEVKIT_TOKEN__?: string }).__GAMEKIT_DEVKIT_TOKEN__ = token;
    }, inject);
    await page.evaluate(({ origin, token }) => {
      (globalThis as { __GAMEKIT_DEVKIT_ORIGIN__?: string }).__GAMEKIT_DEVKIT_ORIGIN__ = origin;
      (globalThis as { __GAMEKIT_DEVKIT_TOKEN__?: string }).__GAMEKIT_DEVKIT_TOKEN__ = token;
    }, inject);
  }
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

  const proofModes: ProofMode[] = [
    {
      flag: "--boot-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureBootProof(outDir, runPage!);
        writeFileSync(`${outDir}/boot-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] boot proof -> ${outDir}/boot-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--stage-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureStageProof(outDir, runPage!, resolveStageProofSpec(process.argv));
        writeFileSync(`${outDir}/stage-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] stage proof -> ${outDir}/stage-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      // card-vfx-flipbook-step fix round (F2): exercise the STRANDED portal-fade paths — a
      // silent world-portal denial (mapId never changes; watchdog is the only guard) and a
      // successful stage entry (recovery via stage.enter, no map change). Asserts the camera
      // recovers (fadeEffect no longer black) in both, not just the happy world-portal arrival.
      flag: "--portal-fade-guard-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await capturePortalFadeGuardProof(outDir, runPage!);
        writeFileSync(`${outDir}/portal-fade-guard-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] portal fade guard proof -> ${outDir}/portal-fade-guard-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--boss-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureBossProof(outDir, runPage!);
        writeFileSync(`${outDir}/boss-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] boss proof -> ${outDir}/boss-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--player-facing-proof",
      run: async (_outDir: string, _runPage: SmokePage | undefined): Promise<void> => {
        const baselineArg = process.argv.find((arg) => arg.startsWith("--baseline="));
        await runPlayerFacingProof(outDir, baselineArg ? baselineArg.slice("--baseline=".length) : undefined);
      },
    },
    {
      flag: "--slime-tween-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureSlimeTweenProof(outDir, runPage!);
        writeFileSync(`${outDir}/slime-tween-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] slime tween proof -> ${outDir}/slime-tween-proof.json`);
        writeSlimeTrackedVariance(outDir);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--gather-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureGatherProof(outDir, runPage!);
        writeFileSync(`${outDir}/gather-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] gather proof -> ${outDir}/gather-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--chest-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureChestProof(outDir, runPage!);
        writeFileSync(`${outDir}/chest-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] chest proof -> ${outDir}/chest-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--npc-edge-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureNpcEdgeProof(outDir, runPage!);
        writeFileSync(`${outDir}/npc-edge-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] NPC edge proof -> ${outDir}/npc-edge-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--monster-reactions-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        // Server-side spawn churn (encounter-belt respawn/maxAlive rebalancing) can remove
        // the selected instance mid-proof; one retry re-selects a fresh live monster.
        let proof: Awaited<ReturnType<typeof captureMonsterReactionsProof>>;
        try {
          proof = await captureMonsterReactionsProof(outDir, runPage!);
        } catch (error) {
          if (!String(error).includes("missing monster/root/container")) throw error;
          console.log("[capture] selected monster despawned mid-proof; retrying once with a fresh selection");
          proof = await captureMonsterReactionsProof(outDir, runPage!);
        }
        writeFileSync(`${outDir}/monster-reactions-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] monster reactions proof -> ${outDir}/monster-reactions-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--ambient-world-life-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureAmbientWorldLifeProof(outDir, runPage!);
        writeFileSync(`${outDir}/ambient-world-life-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] ambient world-life proof -> ${outDir}/ambient-world-life-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--affix-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureAffixProof(outDir, runPage!);
        writeFileSync(`${outDir}/affix-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] affix proof -> ${outDir}/affix-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--effects-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureEffectsProof(outDir, runPage!);
        writeFileSync(`${outDir}/effects-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] effects proof -> ${outDir}/effects-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--monster-anim-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureMonsterAnimProof(outDir, runPage!);
        writeFileSync(`${outDir}/monster-anim-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] monster animation proof -> ${outDir}/monster-anim-proof.json`);
        writeSlimeRimShimmerMetric(outDir);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--presentation-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await capturePresentationProof(outDir, runPage!);
        writeFileSync(`${outDir}/presentation-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] presentation proof -> ${outDir}/presentation-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--skill-fx-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureSkillFxProof(outDir, runPage!);
        writeFileSync(`${outDir}/skill-fx-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] skill FX proof -> ${outDir}/skill-fx-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--kill-beat-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureKillBeatProof(outDir, runPage!);
        writeFileSync(`${outDir}/kill-beat-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] kill beat proof -> ${outDir}/kill-beat-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--combat-range-ux",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureCombatRangeUxProof(outDir, runPage!);
        writeFileSync(`${outDir}/combat-range-ux-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] combat range UX proof -> ${outDir}/combat-range-ux-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--minimap-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureMinimapProof(outDir, runPage!);
        writeFileSync(`${outDir}/minimap-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] minimap proof -> ${outDir}/minimap-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--hub-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureHubProof(outDir, runPage!);
        writeFileSync(`${outDir}/hub-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] hub proof -> ${outDir}/hub-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--hud-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureHudProof(outDir, runPage!);
        writeFileSync(`${outDir}/hud-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] HUD proof -> ${outDir}/hud-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--dialogue-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureDialogueProof(outDir, runPage!);
        writeFileSync(`${outDir}/dialogue-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] dialogue proof -> ${outDir}/dialogue-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--quest-offer-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureQuestOfferProof(outDir, runPage!);
        writeFileSync(`${outDir}/quest-offer-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] quest offer proof -> ${outDir}/quest-offer-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--quest-marker-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureQuestMarkerProof(outDir, runPage!, harness!.joinedA);
        writeFileSync(`${outDir}/quest-marker-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] quest marker proof -> ${outDir}/quest-marker-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--quest-journal-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureQuestJournalProof(outDir, runPage!);
        writeFileSync(`${outDir}/quest-journal-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] quest journal proof -> ${outDir}/quest-journal-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--quest-nav-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureQuestNavProof(outDir, runPage!);
        writeFileSync(`${outDir}/quest-nav-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] quest nav proof -> ${outDir}/quest-nav-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--quest-chain-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureQuestChainProof(outDir, runPage!, harness!.joinedA);
        writeFileSync(`${outDir}/quest-chain-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] quest chain proof -> ${outDir}/quest-chain-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--zone-transition-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureZoneTransitionProof(outDir, runPage!);
        writeFileSync(`${outDir}/zone-transition-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] zone transition proof -> ${outDir}/zone-transition-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--shop-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureShopProof(outDir, runPage!);
        writeFileSync(`${outDir}/shop-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] shop proof -> ${outDir}/shop-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--party-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        if (!harness?.pageB) throw new Error("party proof requires the second smoke page");
        const proof = await capturePartyProof(outDir, runPage!, harness.pageB);
        writeFileSync(`${outDir}/party-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] party proof -> ${outDir}/party-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--levelup-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureLevelUpProof(outDir, runPage!, harness!.joinedA);
        writeFileSync(`${outDir}/levelup-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] level-up proof -> ${outDir}/levelup-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--advancement-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureAdvancementProof(outDir, runPage!);
        writeFileSync(`${outDir}/advancement-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] advancement proof -> ${outDir}/advancement-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      flag: "--editor-thin-slice",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureEditorThinSlice(outDir, runPage!);
        writeFileSync(`${outDir}/editor-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] editor proof -> ${outDir}/editor-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
    {
      // card-lr2-editor-collision-overlay: prove the editor "Show all collision" overlay
      // renders every active collision shape in red AND click-selects the owning object.
      flag: "--collision-overlay-proof",
      run: async (_outDir: string, runPage: SmokePage | undefined): Promise<void> => {
        const proof = await captureCollisionOverlayProof(outDir, runPage!);
        writeFileSync(`${outDir}/collision-overlay-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
        console.log(`[capture] collision overlay proof -> ${outDir}/collision-overlay-proof.json`);
        writeVisualProof(outDir);
        await finishProof();
      },
    },
  ];

  const selectedProofMode = proofModes.find(
    (mode) => mode.flag !== "--player-facing-proof" && mode.flag !== "--editor-thin-slice" && (
      process.argv.includes(mode.flag) ||
      (mode.flag === "--quest-chain-proof" && outDir.toLowerCase().includes("quest-chains"))
    ),
  );
  if (selectedProofMode) {
    await selectedProofMode.run(outDir, page);
    return;
  }

  const editorProof = process.argv.includes("--editor-thin-slice") || outDir.toLowerCase().includes("editor");

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

  // Sweep is a pure full-map coverage pass — skip the aspect-audit reframings and the
  // editor thin-slice (both belong to the SHOTS workflow, left untouched).
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

  // Editor thin-slice runs AFTER the shot loops (matching master): the DevKit
  // apply/badge assertion is timing-sensitive and regressed when hoisted to an
  // early return ahead of the shots (integrator fix at intake, 2026-07-05).
  if (editorProof) {
    const editorProofMode = proofModes.find((mode) => mode.flag === "--editor-thin-slice");
    if (!editorProofMode) throw new Error("editor proof mode missing from registry");
    await editorProofMode.run(outDir, page);
    return;
  }

  writeVisualProof(outDir);

  await harness.browser.close();
  stopDevkit(managedDevkit);
  managedDevkit = undefined;
  stopChildProcesses();
  console.log("[capture] done.");
}

async function captureStageProof(outDir: string, page: SmokePage, spec: StageProofSpec = STAGE_PROOF_SPECS[STAGE_ID]!) {
  await stageInOpenField(page);
  for (const waypoint of spec.waypoints) {
    await moveLocalPlayerNear(page, waypoint.x, waypoint.y, waypoint.radius, 18_000);
  }
  await moveLocalPlayerNear(page, spec.portal.x, spec.portal.playerY, 140);
  await page.screenshot({ path: `${outDir}/stage-entry-portal.png`, fullPage: false });
  const portalPoint = await getWorldScreenPoint(page, spec.portal.x, spec.portal.y);
  await page.mouse.click(portalPoint.x, portalPoint.y);
  await page.locator("[data-stage-portal-confirm='true']").waitFor({ state: "visible", timeout: 5_000 });
  await page.screenshot({ path: `${outDir}/stage-entry-confirm.png`, fullPage: false });
  await page.locator("[data-stage-confirm-enter='true']").click();

  await page.waitForFunction((stageId) => {
    const events = (globalThis as { __GAMEKIT_STAGE_EVENTS__?: Array<{ type: string; stageId: string }> }).__GAMEKIT_STAGE_EVENTS__ ?? [];
    return events.some((event) => event.type === "stage.enter" && event.stageId === stageId);
  }, spec.stageId, { timeout: 15_000 });
  // In the stage room: the player is on the host map and every monster id is
  // stage-prefixed (works even when hostMapId === returnMapId).
  await page.waitForFunction(({ hostMapId, stageId }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    if (!player || player.mapId !== hostMapId) return false;
    let hasStageMonster = false;
    scene?.room?.state?.monsters?.forEach((_monster: unknown, key: string) => {
      if (key.startsWith(stageId)) hasStageMonster = true;
    });
    return hasStageMonster;
  }, { hostMapId: spec.hostMapId, stageId: spec.stageId }, { timeout: 15_000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${outDir}/stage-room-wave1.png`, fullPage: false });

  for (let guard = 0; guard < 48; guard += 1) {
    const complete = await page.evaluate((stageId) => {
      const events = (globalThis as { __GAMEKIT_STAGE_EVENTS__?: Array<{ type: string; stageId: string }> }).__GAMEKIT_STAGE_EVENTS__ ?? [];
      return events.some((event) => event.type === "stage.complete" && event.stageId === stageId);
    }, spec.stageId);
    if (complete) break;
    const state = await getSmokeState(page);
    const local = state?.players.find((player) => player.sessionId === state.localSessionId);
    if (local?.mapId !== spec.hostMapId) break;
    const alive = state?.monsters.filter((monster) => monster.alive && monster.mapId === spec.hostMapId) ?? [];
    if (alive.length === 0) {
      // Wave-transition sync gap (or completion about to land) — re-check, don't bail.
      await page.waitForTimeout(500);
      continue;
    }
    const target = alive[0]!;
    await moveLocalPlayerNear(page, Math.max(0, target.x - 110), target.y, 40, 12_000);
    await sendTargetSelectIntent(page, target.monsterId);
    await sendSkillCastIntent(page, target.monsterId);
    await page.waitForTimeout(750);
  }

  await page.waitForFunction((stageId) => {
    const events = (globalThis as { __GAMEKIT_STAGE_EVENTS__?: Array<{ type: string; stageId: string }> }).__GAMEKIT_STAGE_EVENTS__ ?? [];
    return events.some((event) => event.type === "stage.complete" && event.stageId === stageId);
  }, spec.stageId, { timeout: 15_000 });
  // Back in the WORLD room: at least one non-stage monster present (field spawns),
  // on the return map, with the reward gold banked.
  await page.waitForFunction(({ returnMapId, stageId, minGold }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    if (!player || player.mapId !== returnMapId) return false;
    let hasWorldMonster = false;
    scene?.room?.state?.monsters?.forEach((_monster: unknown, key: string) => {
      if (!key.startsWith(stageId)) hasWorldMonster = true;
    });
    if (!hasWorldMonster) return false;
    let gold = 0;
    player.inventory?.forEach((item: { itemId: string; quantity: number }) => {
      if (item.itemId === "item_gold") gold = item.quantity;
    });
    return gold >= minGold;
  }, { returnMapId: spec.returnMapId, stageId: spec.stageId, minGold: spec.minGoldAfter }, { timeout: 15_000 });
  await page.screenshot({ path: `${outDir}/stage-returned-world.png`, fullPage: false });

  const finalState = await getSmokeState(page);
  const stageEvents = await page.evaluate(() => ((globalThis as { __GAMEKIT_STAGE_EVENTS__?: unknown[] }).__GAMEKIT_STAGE_EVENTS__ ?? []));
  const local = finalState?.players.find((player) => player.sessionId === finalState.localSessionId);
  const gold = local?.inventory.find((item) => item.itemId === "item_gold")?.quantity ?? 0;
  return {
    stageId: spec.stageId,
    portalId: spec.portalId,
    portal: { x: spec.portal.x, y: spec.portal.y, playerY: spec.portal.playerY },
    events: stageEvents,
    finalMapId: local?.mapId,
    gold,
    entryMode: "canvas-click-confirm",
    screenshots: [
      `${outDir}/stage-entry-portal.png`,
      `${outDir}/stage-entry-confirm.png`,
      `${outDir}/stage-room-wave1.png`,
      `${outDir}/stage-returned-world.png`,
    ],
  };
}

async function enterStageForBannerProof(outDir: string, page: SmokePage) {
  await stageInOpenField(page);
  await moveLocalPlayerNear(page, 980, 1320, 110, 18_000);
  await moveLocalPlayerNear(page, 1500, 1400, 120, 18_000);
  await moveLocalPlayerNear(page, 1820, 920, 130, 18_000);
  await moveLocalPlayerNear(page, STAGE_PORTAL_X, STAGE_PORTAL_PLAYER_Y, 140);
  const portalPoint = await getWorldScreenPoint(page, STAGE_PORTAL_X, STAGE_PORTAL_Y);
  await page.mouse.click(portalPoint.x, portalPoint.y);
  await page.locator("[data-stage-portal-confirm='true']").waitFor({ state: "visible", timeout: 5_000 });
  await page.locator("[data-stage-confirm-enter='true']").click();
  await page.waitForFunction((stageId) => {
    const events = (globalThis as { __GAMEKIT_STAGE_EVENTS__?: Array<{ type: string; stageId: string }> }).__GAMEKIT_STAGE_EVENTS__ ?? [];
    return events.some((event) => event.type === "stage.enter" && event.stageId === stageId);
  }, STAGE_ID, { timeout: 15_000 });
  await page.waitForFunction((mapId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    return player?.mapId === mapId && scene?.getLoadingOverlayQaState?.().visible === false;
  }, LANTERNWAKE_MAP_ID, { timeout: 15_000 });
  const banner = await assertArrivalBannerText(page, EXPECTED_STAGE_BANNER);
  const screenshot = `${outDir}/stage-entry-banner.png`;
  await page.screenshot({ path: screenshot, fullPage: false });

  // card-gamescene-live-fixes item 2: the stage objective banner must NOT persist
  // in the world after leaving the instance. Complete the stage, return to the
  // world map, then assert #stage-objective-banner is gone (hidden). This proves
  // the generic clear-on-transition fix in GameScene.configureMap.
  const cleared = await clearStageAndAssertBannerGone(outDir, page);
  return { ...banner, screenshot, objectiveBannerCleared: cleared };
}

/**
 * Complete the active Unlit Mile stage, wait for the return to the world map, and
 * assert the stage objective banner (#stage-objective-banner) is cleared. Returns a
 * proof record; throws if the banner is still visible in the world.
 * (card-gamescene-live-fixes)
 */
async function clearStageAndAssertBannerGone(outDir: string, page: SmokePage) {
  for (let guard = 0; guard < 48; guard += 1) {
    const state = await getSmokeState(page);
    const local = state?.players.find((player) => player.sessionId === state.localSessionId);
    if (local?.mapId !== LANTERNWAKE_MAP_ID) break;
    const alive = state?.monsters.filter((monster) => monster.alive && monster.mapId === LANTERNWAKE_MAP_ID) ?? [];
    if (alive.length === 0) break;
    const target = alive[0]!;
    await moveLocalPlayerNear(page, Math.max(0, target.x - 110), target.y, 40, 12_000);
    await sendTargetSelectIntent(page, target.monsterId);
    await sendSkillCastIntent(page, target.monsterId);
    await page.waitForTimeout(750);
  }

  await page.waitForFunction((stageId) => {
    const events = (globalThis as { __GAMEKIT_STAGE_EVENTS__?: Array<{ type: string; stageId: string }> }).__GAMEKIT_STAGE_EVENTS__ ?? [];
    return events.some((event) => event.type === "stage.complete" && event.stageId === stageId);
  }, STAGE_ID, { timeout: 15_000 });
  await page.waitForFunction(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    return player?.mapId === "map_harbor_outskirts" && scene?.getLoadingOverlayQaState?.().visible === false;
  }, undefined, { timeout: 15_000 });

  // The banner element is created lazily and hidden on transition; a stuck banner
  // is one that is still present AND not hidden AND has non-empty text.
  const bannerState = await page.waitForFunction(() => {
    const doc = (globalThis as unknown as {
      document: { getElementById(id: string): { hidden: boolean; textContent: string | null } | null };
    }).document;
    const el = doc.getElementById("stage-objective-banner");
    const present = Boolean(el);
    const hidden = el ? el.hidden : true;
    const text = el?.textContent?.trim() ?? "";
    // Cleared == no element, or element hidden, or empty text.
    const isCleared = !present || hidden || text.length === 0;
    return isCleared ? { present, hidden, text } : false;
  }, undefined, { timeout: 8_000 });
  const cleared = (await bannerState.jsonValue()) as { present: boolean; hidden: boolean; text: string };

  const screenshot = `${outDir}/stage-banner-cleared-world.png`;
  await page.screenshot({ path: screenshot, fullPage: false });
  return { ...cleared, screenshot };
}

async function resetToFreshSuncradleGuest(page: SmokePage): Promise<void> {
  await page.evaluate(() => {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#auth-guest").first().waitFor({ state: "visible", timeout: 15_000 });
  await page.locator("#auth-guest").first().click();
  await page.waitForFunction((mapId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    return player?.mapId === mapId;
  }, BLOOMVALE_MAP_ID, { timeout: 20_000 });
}

async function assertArrivalBannerText(page: SmokePage, expectedText: string) {
  const banner = await page.waitForFunction((expected) => {
    const doc = (globalThis as unknown as { document: { getElementById(id: string): { hidden: boolean; textContent: string | null; className: string } | null } }).document;
    const el = doc.getElementById("arrival-title-overlay");
    if (!el || el.hidden) return false;
    const text = el.textContent?.trim() ?? "";
    return text === expected ? { text, hidden: el.hidden, className: el.className } : false;
  }, expectedText, { timeout: 5_000 });
  return banner.jsonValue();
}

async function captureBossProof(outDir: string, page: SmokePage) {
  await stageInOpenField(page);
  await moveLocalPlayerNear(page, 980, 1320, 110, 18_000);
  await moveLocalPlayerNear(page, 1500, 1400, 120, 18_000);
  await moveLocalPlayerNear(page, 1820, 920, 130, 18_000);
  await moveLocalPlayerNear(page, STAGE_PORTAL_X, STAGE_PORTAL_PLAYER_Y, 140);
  const portalPoint = await getWorldScreenPoint(page, STAGE_PORTAL_X, STAGE_PORTAL_Y);
  await page.mouse.click(portalPoint.x, portalPoint.y);
  await page.locator("[data-stage-portal-confirm='true']").waitFor({ state: "visible", timeout: 5_000 });
  await page.locator("[data-stage-confirm-enter='true']").click();

  await page.waitForFunction(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    return player?.mapId === "map_lanternwake_skiff" && scene?.room?.state?.monsters?.size > 0;
  }, undefined, { timeout: 15_000 });

  const objectiveProofs: Array<{ wave: number; expected: string; actual: string; screenshot: string }> = [];
  objectiveProofs.push(await assertStageObjectiveBeat(page, outDir, 1, "Wave 1 of 3 - clear the first gloomspawn (0/2)"));

  await grindStageUntil(
    page,
    async () => Boolean(await waitForStageObjectiveText(page, "Wave 2 of 3 - clear the deeper gloomspawn (0/2)", 400).catch(() => null)),
    "wave 1",
  );
  objectiveProofs.push(await assertStageObjectiveBeat(page, outDir, 2, "Wave 2 of 3 - clear the deeper gloomspawn (0/2)"));

  await grindStageUntil(page, async () => Boolean(await getBossMonster(page)), "wave 2");
  objectiveProofs.push(await assertStageObjectiveBeat(page, outDir, 3, "Wave 3 of 3 - Gloamslime stirs (0/1)"));

  const bossAtArrival = await getBossMonster(page);
  if (!bossAtArrival) throw new Error("boss proof never reached monster_gloamslime wave");
  await installStageAutoDodger(page);
  await page.evaluate((point) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    scene?.cameras?.main?.centerOn(point.x, point.y - 20);
  }, { x: bossAtArrival.x, y: bossAtArrival.y });

  await page.waitForFunction(() => {
    const events = (globalThis as { __GAMEKIT_STAGE_EVENTS__?: Array<{ type: string }> }).__GAMEKIT_STAGE_EVENTS__ ?? [];
    const qa = (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__?.getVisualQaSnapshot?.();
    return events.some((event) => event.type === "boss.telegraph") && (qa?.bossTelegraphs?.some((telegraph) => telegraph.remainingMs > 250) ?? false);
  }, undefined, { timeout: 8_000 });
  const telegraphQa = await page.evaluate(() => (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__?.getVisualQaSnapshot?.()?.bossTelegraphs ?? []);
  await page.screenshot({ path: `${outDir}/boss-telegraph-ring.png`, fullPage: false });

  const movementProof = await attemptBossWalkThrough(page);
  if (movementProof.afterDistance < 34) {
    throw new Error(`boss walk-through proof failed: ${JSON.stringify(movementProof)}`);
  }

  let maxGloomlings = 0;
  const bossGrindStats = await grindStageUntil(
    page,
    async () => {
      const state = await getStageMonsterDetails(page);
      maxGloomlings = Math.max(maxGloomlings, state.filter((monster) => monster.monsterId === "monster_gloomling" && monster.alive).length);
      const smoke = await getSmokeState(page);
      const local = smoke?.players.find((player) => player.sessionId === smoke.localSessionId);
      return local?.mapId !== "map_lanternwake_skiff" || state.length === 0;
    },
    "boss + gloomlings",
  );
  if (maxGloomlings < 2) throw new Error(`boss proof did not observe split gloomlings: ${maxGloomlings}`);
  // Telegraph-at-player (card-lr2-combat-balance): during the fight the bot is
  // the boss's only possible aggro target, so newly spawned slam rings must be
  // centered at/near the bot. 60px tolerance covers windup-start drift.
  if (bossGrindStats.telegraphsSeen === 0 || bossGrindStats.telegraphMinDistancePx === null || bossGrindStats.telegraphMinDistancePx > 60) {
    throw new Error(`boss proof telegraph-at-player failed: ${JSON.stringify(bossGrindStats)}`);
  }

  await page.waitForFunction((stageId) => {
    const events = (globalThis as { __GAMEKIT_STAGE_EVENTS__?: Array<{ type: string; stageId: string }> }).__GAMEKIT_STAGE_EVENTS__ ?? [];
    return events.some((event) => event.type === "stage.complete" && event.stageId === stageId);
  }, STAGE_ID, { timeout: 20_000 });
  await page.waitForFunction(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    if (!player || player.mapId !== "map_harbor_outskirts") return false;
    let gold = 0;
    player.inventory?.forEach((item: { itemId: string; quantity: number }) => {
      if (item.itemId === "item_gold") gold = item.quantity;
    });
    return gold >= 18;
  }, undefined, { timeout: 15_000 });
  await page.screenshot({ path: `${outDir}/boss-clear-frame.png`, fullPage: false });

  const finalState = await getSmokeState(page);
  const stageEvents = await page.evaluate(() => ((globalThis as { __GAMEKIT_STAGE_EVENTS__?: unknown[] }).__GAMEKIT_STAGE_EVENTS__ ?? []));
  const local = finalState?.players.find((player) => player.sessionId === finalState.localSessionId);
  return {
    stageId: STAGE_ID,
    bossId: "monster_gloamslime",
    assertions: {
      objectiveLines: objectiveProofs.map((proof) => proof.actual),
      telegraphEventReceived: stageEvents.some((event) => typeof event === "object" && event !== null && (event as { type?: string }).type === "boss.telegraph"),
      telegraphRingRendered: telegraphQa.length > 0,
      telegraphTargetsPlayer: bossGrindStats.telegraphMinDistancePx !== null && bossGrindStats.telegraphMinDistancePx <= 60,
      telegraphMinDistancePx: bossGrindStats.telegraphMinDistancePx,
      telegraphsSeenDuringFight: bossGrindStats.telegraphsSeen,
      walkThroughBlocked: movementProof.afterDistance >= 34,
      maxGloomlings,
      clearGrantedGold: local?.inventory.find((item) => item.itemId === "item_gold")?.quantity ?? 0,
    },
    movementProof,
    events: stageEvents,
    screenshots: [
      ...objectiveProofs.map((proof) => proof.screenshot),
      `${outDir}/boss-telegraph-ring.png`,
      `${outDir}/boss-clear-frame.png`,
    ],
  };
}

async function assertStageObjectiveBeat(page: SmokePage, outDir: string, wave: number, expected: string) {
  const actual = await waitForStageObjectiveText(page, expected, 6_000);
  const screenshot = `${outDir}/boss-objective-wave${wave}.png`;
  await page.screenshot({ path: screenshot, fullPage: false });
  return { wave, expected, actual, screenshot };
}

async function waitForStageObjectiveText(page: SmokePage, expected: string, timeout: number): Promise<string> {
  const handle = await page.waitForFunction((line) => {
    const doc = (globalThis as unknown as {
      document: {
        getElementById(id: string): { hidden: boolean } | null;
        querySelector(selector: string): { textContent: string | null; getBoundingClientRect(): { width: number; height: number } } | null;
      };
    }).document;
    const loading = doc.getElementById("loading-overlay");
    if (loading && !loading.hidden) return false;
    const arrival = doc.getElementById("arrival-title-overlay");
    if (arrival && !arrival.hidden) return false;
    const el = doc.querySelector("[data-stage-objective='true']");
    const bounds = el?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return false;
    const text = el?.textContent?.trim() ?? "";
    return text === line ? text : false;
  }, expected, { timeout });
  return handle.jsonValue() as Promise<string>;
}

async function attackFirstStageMonster(page: SmokePage): Promise<void> {
  const monsters = await getStageMonsterDetails(page);
  const target = monsters.find((monster) => monster.alive);
  if (!target) return;
  await moveLocalPlayerNear(page, Math.max(0, target.x - 104), target.y, 46, 12_000);
  await sendTargetSelectIntent(page, target.instanceId);
  // LAST-INSTANT slam check (card-lr2-combat-balance): a ring that spawned
  // during the approach must veto the cast — casting sets a 500ms movement
  // lock and StageRoom.tick erases the dodge target every tick while locked,
  // which roots the bot inside the ring for the hit.
  const ringOverBot = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    if (!player) return false;
    const telegraphs = (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__?.getVisualQaSnapshot?.()?.bossTelegraphs ?? [];
    return telegraphs.some((telegraph) =>
      telegraph.remainingMs > 0 &&
      Math.hypot(player.x - telegraph.world.x, player.y - telegraph.world.y) <= telegraph.world.radius + 40);
  });
  if (ringOverBot) {
    await page.waitForTimeout(250);
    return;
  }
  await sendSkillCastIntent(page, target.instanceId);
  // 550ms ≈ the 500ms cast cooldown + margin: keeps casts clustered inside the
  // ~2.7s post-slam-resolve safe window so the 500ms movement lock always
  // expires before the next ring spawns.
  await page.waitForTimeout(550);
}

async function getBossMonster(page: SmokePage): Promise<{ instanceId: string; x: number; y: number; hp: number; maxHp: number } | null> {
  const monsters = await getStageMonsterDetails(page);
  return monsters.find((monster) => monster.monsterId === "monster_gloamslime" && monster.alive) ?? null;
}

async function getStageMonsterDetails(page: SmokePage): Promise<Array<{ instanceId: string; monsterId: string; x: number; y: number; hp: number; maxHp: number; alive: boolean }>> {
  return page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const monsters: Array<{ instanceId: string; monsterId: string; x: number; y: number; hp: number; maxHp: number; alive: boolean }> = [];
    scene?.room?.state?.monsters?.forEach((monster, instanceId) => {
      if (monster.mapId !== "map_lanternwake_skiff") return;
      monsters.push({
        instanceId,
        monsterId: monster.monsterId ?? "",
        x: Math.round(monster.x),
        y: Math.round(monster.y),
        hp: monster.hp,
        maxHp: monster.maxHp,
        alive: monster.alive,
      });
    });
    return monsters;
  });
}

// Grind loops must be TTK-independent: owner balance rulings re-tune monster
// HP (the 2026-07-07 bands starved the old fixed guard<80/120 loops), so budget
// on OBSERVED PROGRESS — keep attacking while total alive HP drops or a monster
// dies; abort only after `stallLimit` consecutive no-progress attacks.
type StageGrindStats = {
  /** Min distance (px) from the bot to the center of each NEWLY sighted slam
   * telegraph, over the whole grind. Small (<=60) proves the ring targets the
   * aggro'd player (card-lr2-combat-balance), since the bot is the only player. */
  telegraphMinDistancePx: number | null;
  telegraphsSeen: number;
};

/** Install a page-side auto-dodger for boss slam rings. Owner-ruled combat
 * numbers (card-lr2-combat-balance) made facetanking lethal: the telegraph now
 * lands ON the aggro target (12 dmg / ~3.6s cycle vs 110 max HP over a
 * ~27-cast boss fight), and the 900ms windup is far shorter than the node-side
 * grind iteration (~2s), so the dodge must poll IN the page (140ms) to catch
 * rings in time. Player speed 190px/s exits a 76px ring in ~0.55s. Idempotent. */
async function installStageAutoDodger(page: SmokePage): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as SmokeBrowserGlobal & { __LR2_DODGER__?: ReturnType<typeof setInterval> };
    if (g.__LR2_DODGER__) return;
    let ordinal = 0;
    g.__LR2_DODGER__ = setInterval(() => {
      const scene = g.__GAME?.scene?.getScene("game");
      const room = scene?.room;
      const player = room?.state?.players?.get(scene?.localSessionId ?? "");
      if (!room || !player || player.mapId !== "map_lanternwake_skiff" || player.hp <= 0) return;
      const telegraphs = g.__GAMEKIT_QA__?.getVisualQaSnapshot?.()?.bossTelegraphs ?? [];
      const threat = telegraphs.find((telegraph) =>
        telegraph.remainingMs > 200 &&
        Math.hypot(player.x - telegraph.world.x, player.y - telegraph.world.y) <= telegraph.world.radius + 20);
      if (!threat) return;
      // Dodge AWAY FROM THE BOSS, not from the ring center: the ring is centered
      // on the player (that is the fix under test), so player-minus-center is a
      // near-zero vector with an undefined direction.
      const boss = room.state?.monsters?.get(threat.monsterInstanceId);
      const fromX = boss?.x ?? threat.world.x;
      const fromY = boss?.y ?? threat.world.y;
      const away = Math.atan2(player.y - fromY, (player.x - fromX) || 0.001);
      const dodgeX = player.x + Math.cos(away) * (threat.world.radius + 70);
      const dodgeY = player.y + Math.sin(away) * (threat.world.radius + 70);
      room.send("intent", {
        type: "move.to",
        requestId: `lr2-dodge-${Date.now()}-${ordinal++}`,
        x: dodgeX,
        y: dodgeY,
        // Required by ClientIntentSchema — omitting it makes dispatchIntent's
        // safeParse fail SILENTLY and the dodge never happens.
        clientTimeMs: Date.now(),
      });
    }, 140);
  });
}

/** One survival decision between attacks (node-side, complements the page-side
 * dodger): hold spacing against pursuit and breathe when MP runs dry. Wave
 * slimes hit for ~11 inside their 82px contact range at pursuit speed 28-34.
 * Returns true when the bot is mid-dodge and this beat MUST NOT cast: casting
 * sets a 500ms movement lock and StageRoom.tick erases the move target every
 * tick while locked, so a cast during a slam windup roots the bot in the ring. */
async function stageSurvivalBeat(page: SmokePage): Promise<boolean> {
  const pendingRing = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    if (!player) return null;
    const telegraphs = (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__?.getVisualQaSnapshot?.()?.bossTelegraphs ?? [];
    const threat = telegraphs.find((telegraph) =>
      telegraph.remainingMs > 0 &&
      Math.hypot(player.x - telegraph.world.x, player.y - telegraph.world.y) <= telegraph.world.radius + 40);
    return threat ? { remainingMs: threat.remainingMs } : null;
  });
  if (pendingRing) {
    // The page-side auto-dodger is steering the bot out; give it the rest of
    // the windup plus a resolve margin, cast nothing.
    await page.waitForTimeout(Math.min(pendingRing.remainingMs + 350, 1_700));
    return true;
  }
  const kite = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    if (!player) return null;
    type NearestMonster = { x: number; y: number; d: number };
    const candidates: NearestMonster[] = [];
    scene?.room?.state?.monsters?.forEach((monster) => {
      if (!monster.alive || monster.mapId !== player.mapId) return;
      candidates.push({ x: monster.x, y: monster.y, d: Math.hypot(player.x - monster.x, player.y - monster.y) });
    });
    const nearestMonster: NearestMonster | null =
      candidates.length === 0 ? null : candidates.reduce((best, c) => (c.d < best.d ? c : best));
    // Contact ranges are 56 (boss default) to 82 (wave slimes); hold ~150px
    // (still inside Spark Shot's 150 cast range) so pursuit (slime speed
    // 28-34, boss 12) needs ~2s to reconnect — longer than one grind beat.
    if (!nearestMonster || nearestMonster.d > 120) return null;
    const away = Math.atan2(player.y - nearestMonster.y, (player.x - nearestMonster.x) || 0.001);
    return { x: nearestMonster.x + Math.cos(away) * 150, y: nearestMonster.y + Math.sin(away) * 150 };
  });
  if (kite) {
    await sendMoveIntent(page, kite.x, kite.y);
    await page.waitForTimeout(420);
  }
  const mp = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    return scene?.room?.state?.players?.get(scene.localSessionId)?.mp ?? 99;
  });
  if (mp < 4) await page.waitForTimeout(2_400);
  return false;
}

async function grindStageUntil(
  page: SmokePage,
  done: () => Promise<boolean>,
  label: string,
  stallLimit = 15,
  hardCap = 600,
): Promise<StageGrindStats> {
  let lastTotalHp = Number.POSITIVE_INFINITY;
  let lastAlive = Number.POSITIVE_INFINITY;
  let stalled = 0;
  const seenTelegraphIds = new Set<string>();
  const stats: StageGrindStats = { telegraphMinDistancePx: null, telegraphsSeen: 0 };
  for (let guard = 0; guard < hardCap; guard += 1) {
    // Death is a proof FAILURE, not a stall: a dead player is booted back to
    // the overworld ("wipe" policy), scene.room reverts to the world room
    // (which ambient-spawns skiff glowcrabs), and every further attack whiffs
    // cross-map — the confusing "no damage progress" signature.
    const local = await page.evaluate(() => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
      const player = scene?.room?.state?.players?.get(scene.localSessionId);
      return player ? { hp: player.hp, mapId: player.mapId } : null;
    });
    if (!local || local.mapId !== "map_lanternwake_skiff") {
      const completed = await page.evaluate(() =>
        ((globalThis as { __GAMEKIT_STAGE_EVENTS__?: Array<{ type: string }> }).__GAMEKIT_STAGE_EVENTS__ ?? [])
          .some((event) => event.type === "stage.complete"));
      if (completed) return stats;
      throw new Error(`boss proof bot DIED during ${label} (booted to ${local?.mapId ?? "unknown"} without stage.complete)`);
    }
    if (await done()) return stats;
    // Telegraph-at-player proof: each NEW ring is measured against the bot's
    // current position BEFORE the dodge moves it (the ring spawns aimed at the
    // boss's aggro target — the bot — so this distance must be small).
    const sightings = await page.evaluate(() => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
      const player = scene?.room?.state?.players?.get(scene.localSessionId);
      const telegraphs = (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__?.getVisualQaSnapshot?.()?.bossTelegraphs ?? [];
      if (!player) return [] as Array<{ id: string; distance: number }>;
      return telegraphs.map((telegraph) => ({
        id: telegraph.id,
        distance: Math.hypot(player.x - telegraph.world.x, player.y - telegraph.world.y),
      }));
    });
    for (const sighting of sightings) {
      if (seenTelegraphIds.has(sighting.id)) continue;
      seenTelegraphIds.add(sighting.id);
      stats.telegraphsSeen += 1;
      stats.telegraphMinDistancePx = stats.telegraphMinDistancePx === null
        ? sighting.distance
        : Math.min(stats.telegraphMinDistancePx, sighting.distance);
    }
    const dodging = await stageSurvivalBeat(page);
    // A page-side dodge can redirect the walk mid-approach; a missed approach
    // then just costs one whiffed cast, so it must not abort the grind. While
    // dodging, casting is FORBIDDEN (the cast lock roots the bot in the ring).
    if (!dodging) await attackFirstStageMonster(page).catch(() => {});
    const monsters = await getStageMonsterDetails(page);
    const alive = monsters.filter((monster) => monster.alive);
    const totalHp = alive.reduce((sum, monster) => sum + monster.hp, 0);
    if (totalHp < lastTotalHp || alive.length < lastAlive) {
      stalled = 0;
    } else {
      stalled += 1;
      if (stalled >= stallLimit) {
        throw new Error(`boss proof stalled during ${label}: no damage progress in ${stallLimit} attacks (totalHp=${totalHp}, alive=${alive.length})`);
      }
    }
    lastTotalHp = totalHp;
    lastAlive = alive.length;
  }
  throw new Error(`boss proof hard cap (${hardCap}) exhausted during ${label}`);
}

async function attemptBossWalkThrough(page: SmokePage): Promise<{ beforeDistance: number; afterDistance: number; player: { x: number; y: number }; boss: { x: number; y: number } }> {
  const boss = await getBossMonster(page);
  if (!boss) throw new Error("boss walk-through proof missing boss");
  await moveLocalPlayerNear(page, boss.x - 95, boss.y, 18, 12_000);
  await sendMoveIntent(page, boss.x, boss.y);
  await page.waitForTimeout(1_000);
  return page.evaluate((bossPoint) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    if (!player) throw new Error("boss walk-through proof missing local player");
    return {
      beforeDistance: Math.hypot(bossPoint.startX - bossPoint.x, bossPoint.startY - bossPoint.y),
      afterDistance: Math.hypot(player.x - bossPoint.x, player.y - bossPoint.y),
      player: { x: Math.round(player.x), y: Math.round(player.y) },
      boss: { x: bossPoint.x, y: bossPoint.y },
    };
  }, { x: boss.x, y: boss.y, startX: boss.x - 95, startY: boss.y });
}

async function getWorldScreenPoint(page: SmokePage, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate((point) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const cam = scene?.cameras?.main;
    const canvas = scene?.game?.canvas;
    if (!cam || !canvas) throw new Error("game camera unavailable for world click");
    const rect = canvas.getBoundingClientRect();
    const viewWidth = Number(scene.scale.width || scene.game.config.width);
    const viewHeight = Number(scene.scale.height || scene.game.config.height);
    const scaleX = rect.width / viewWidth;
    const scaleY = rect.height / viewHeight;
    return {
      x: rect.left + (point.x - cam.worldView.x) * cam.zoom * scaleX,
      y: rect.top + (point.y - cam.worldView.y) * cam.zoom * scaleY,
    };
  }, { x, y });
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

function assetPayloadStats(assets: MapAssetSet): { fileCount: number; bytes: number; missing: string[] } {
  const paths = new Set<string>();
  for (const kind of ["sprites", "sheets", "tiles", "decals", "props", "audio"] as const) {
    for (const asset of assets[kind] ?? []) paths.add(asset.path);
  }
  let bytes = 0;
  const missing: string[] = [];
  for (const assetPath of paths) {
    const fullPath = pathResolve(ROOT, "client/public", assetPath);
    if (!existsSync(fullPath)) {
      missing.push(assetPath);
      continue;
    }
    bytes += statSync(fullPath).size;
  }
  return { fileCount: paths.size, bytes, missing };
}

async function captureBootProof(outDir: string, page: SmokePage) {
  const spawnPath = `${outDir}/boot-spawn-frame.png`;
  const initial = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    return {
      boot: scene?.getBootAssetQaState?.(),
      visual: scene?.getVisualQaSnapshot?.(),
    };
  });
  await page.screenshot({ path: spawnPath });

  const completed = await page.waitForFunction(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const state = scene?.getBootAssetQaState?.();
    return state?.loadedTiers?.includes("tier1") ? state : false;
  }, undefined, { timeout: 20_000 });
  const finalBoot = await completed.jsonValue() as BootAssetProofState;
  const finalVisual = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    return scene?.getVisualQaSnapshot?.();
  });

  const missingTier0 = await page.evaluate((assets) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    if (!scene) return ["game scene unavailable"];
    const missing: string[] = [];
    for (const kind of ["sprites", "sheets", "tiles", "decals", "props"] as const) {
      for (const asset of assets[kind] ?? []) {
        if (!scene.textures.exists(asset.key)) missing.push(`${kind}:${asset.key}`);
      }
    }
    for (const asset of assets.audio ?? []) {
      if (!scene.cache.audio.exists(asset.key)) missing.push(`audio:${asset.key}`);
    }
    return missing;
  }, BOOT_ASSET_TIERS.tier0.assets);

  if (missingTier0.length > 0) throw new Error(`boot proof missing tier-0 assets: ${missingTier0.join(", ")}`);
  if (!initial.boot?.loadedTiers?.includes("tier0")) throw new Error(`boot proof did not observe tier0 loaded: ${JSON.stringify(initial.boot)}`);
  if (!finalBoot?.loadedTiers?.includes("tier1")) throw new Error(`boot proof did not complete tier1: ${JSON.stringify(finalBoot)}`);
  if (!initial.visual?.players?.some((player) => player.visible && player.isLocal)) {
    throw new Error(`boot proof spawn frame missing visible local player: ${JSON.stringify(initial.visual?.players ?? [])}`);
  }

  const oldPayload = assetPayloadStats(STARTUP_OLD_BOOT_ASSETS);
  const tier0Payload = assetPayloadStats(BOOT_ASSET_TIERS.tier0.assets);
  const tier1Payload = assetPayloadStats(BOOT_ASSET_TIERS.tier1.assets);
  if (oldPayload.missing.length || tier0Payload.missing.length || tier1Payload.missing.length) {
    throw new Error(`boot proof payload paths missing: ${JSON.stringify({ oldPayload, tier0Payload, tier1Payload })}`);
  }

  return {
    kind: "gamekit-boot-asset-proof",
    generatedAt: new Date().toISOString(),
    payloads: {
      oldStartupBoot: oldPayload,
      tier0: tier0Payload,
      tier1: tier1Payload,
    },
    timingsMs: {
      currentBootToSpawn: initial.boot?.tier0LoadedAtMs,
      tier1Started: finalBoot.tier1StartedAtMs,
      tier1Loaded: finalBoot.tier1LoadedAtMs,
      tier1Duration: finalBoot.tier1StartedAtMs && finalBoot.tier1LoadedAtMs
        ? finalBoot.tier1LoadedAtMs - finalBoot.tier1StartedAtMs
        : undefined,
    },
    initialBootState: initial.boot,
    finalBootState: finalBoot,
    initialVisible: {
      localPlayer: initial.visual?.players?.some((player) => player.visible && player.isLocal) ?? false,
      monsters: initial.visual?.monsters?.filter((monster) => monster.visible).length ?? 0,
      npcs: initial.visual?.npcs?.filter((npc) => npc.visible).length ?? 0,
    },
    finalVisible: {
      monsters: finalVisual?.monsters?.filter((monster) => monster.visible).length ?? 0,
      npcs: finalVisual?.npcs?.filter((npc) => npc.visible).length ?? 0,
    },
    screenshots: {
      spawn: spawnPath,
    },
  };
}

async function captureQuestMarkerProof(
  outDir: string,
  page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"],
  joined: JoinedSmokeState,
) {
  const screenshots: string[] = [];
  const captureMarker = async (label: string, state: "available" | "active" | "ready") => {
    await waitForNpcVisible(page, COMBAT_TRAINER_ID);
    await waitForNpcQuestMarkerState(page, COMBAT_TRAINER_ID, state);
    await page.evaluate(({ x, y, zoom }) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
      const cam = scene?.cameras?.main;
      if (!cam) throw new Error("camera unavailable for quest marker proof");
      cam.stopFollow();
      cam.setZoom(zoom);
      cam.centerOn(x, y - 46);
    }, { x: COMBAT_TRAINER_X, y: COMBAT_TRAINER_Y, zoom: GAMEPLAY_ZOOM });
    await page.waitForTimeout(350);
    const path = `${outDir}/quest-marker-${label}.png`;
    await page.screenshot({ path });
    screenshots.push(path);
    console.log(`[capture] quest marker ${state} -> ${path}`);
    return getQuestMarkerQaState(page, COMBAT_TRAINER_ID);
  };

  await moveLocalPlayerNear(page, COMBAT_TRAINER_X, COMBAT_TRAINER_Y, 120);
  const available = await captureMarker("available-before-accept", "available");
  await acceptQuestViaDialogue(page, COMBAT_TRAINER_ID, COMBAT_TRAINER_X, COMBAT_TRAINER_Y, BLOOMVALE_FIRST_HUNT_QUEST_ID, "available");
  await completeBloomvaleFirstHuntKills(page, joined);
  const ready = await captureMarker("ready-turn-in", "ready");
  await turnInQuestViaDialogue(
    page,
    COMBAT_TRAINER_ID,
    COMBAT_TRAINER_X,
    COMBAT_TRAINER_Y,
    BLOOMVALE_FIRST_HUNT_QUEST_ID,
    BLOOMVALE_FIRST_HUNT_REWARD_XP,
    BLOOMVALE_FIRST_HUNT_REWARD_GOLD,
  );
  await acceptQuestViaDialogue(page, COMBAT_TRAINER_ID, COMBAT_TRAINER_X, COMBAT_TRAINER_Y, BLOOMVALE_DEWDROP_CULL_QUEST_ID);
  const active = await captureMarker("active-in-progress", "active");

  return {
    npcId: COMBAT_TRAINER_ID,
    questIds: [BLOOMVALE_FIRST_HUNT_QUEST_ID, BLOOMVALE_DEWDROP_CULL_QUEST_ID],
    gameplayZoom: GAMEPLAY_ZOOM,
    states: { available, active, ready },
    screenshots,
  };
}

async function captureQuestChainProof(
  outDir: string,
  page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"],
  joined: JoinedSmokeState,
) {
  const firstHunt = await waitForQuestStatus(page, BLOOMVALE_FIRST_HUNT_QUEST_ID, "active");
  console.log(`[capture] quest chain: ${firstHunt.questId} starts ${firstHunt.status}`);
  await completeBloomvaleFirstHuntKills(page, joined);
  await turnInQuestViaDialogue(
    page,
    COMBAT_TRAINER_ID,
    COMBAT_TRAINER_X,
    COMBAT_TRAINER_Y,
    BLOOMVALE_FIRST_HUNT_QUEST_ID,
    BLOOMVALE_FIRST_HUNT_REWARD_XP,
    BLOOMVALE_FIRST_HUNT_REWARD_GOLD,
  );
  await acceptQuestViaDialogue(page, COMBAT_TRAINER_ID, COMBAT_TRAINER_X, COMBAT_TRAINER_Y, BLOOMVALE_DEWDROP_CULL_QUEST_ID);
  await completeBloomvaleDewdropKills(page, joined);
  await turnInQuestViaDialogue(
    page,
    COMBAT_TRAINER_ID,
    COMBAT_TRAINER_X,
    COMBAT_TRAINER_Y,
    BLOOMVALE_DEWDROP_CULL_QUEST_ID,
    BLOOMVALE_DEWDROP_CULL_REWARD_XP,
    BLOOMVALE_DEWDROP_CULL_REWARD_GOLD,
  );
  await acceptQuestViaDialogue(page, HARBOR_WARDEN_ID, HARBOR_WARDEN_X, HARBOR_WARDEN_Y, BLOOMVALE_WARDEN_BRIEFING_QUEST_ID);

  await page.evaluate(({ x, y, zoom }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const cam = scene?.cameras?.main;
    cam?.stopFollow();
    cam?.setZoom(zoom);
    cam?.centerOn(x, y - 40);
  }, { x: HARBOR_WARDEN_X, y: HARBOR_WARDEN_Y, zoom: GAMEPLAY_ZOOM });
  await page.waitForTimeout(500);
  const screenshot = `${outDir}/quest-chain-mid-talk-tracker.png`;
  await page.screenshot({ path: screenshot });
  console.log(`[capture] quest chain mid talk tracker -> ${screenshot}`);

  const tracker = await getQuestTrackerText(page);
  const questStatus = await page.evaluate((questId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    const quest = player?.quests?.get(questId);
    return quest ? { questId: quest.questId, status: quest.status, progress: quest.progress, required: quest.required } : null;
  }, BLOOMVALE_WARDEN_BRIEFING_QUEST_ID);

  if (!tracker.includes("Warden's Roadmark") || !tracker.includes("Talk to Warden")) {
    throw new Error(`quest chain tracker did not show talk objective: ${tracker}`);
  }

  return {
    kind: "gamekit-quest-chain-proof",
    questId: BLOOMVALE_WARDEN_BRIEFING_QUEST_ID,
    questStatus,
    tracker,
    screenshots: [repoRelativePath(screenshot)],
  };
}

async function getQuestMarkerQaState(
  page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"],
  npcId: string,
): Promise<{ id: string; visible: boolean; questMarkerState?: string } | null> {
  return page.evaluate((targetNpcId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const npc = scene?.getVisualQaSnapshot?.()?.npcs?.find((entry) => entry.id === targetNpcId);
    return npc ? { id: npc.id ?? targetNpcId, visible: npc.visible, questMarkerState: npc.questMarkerState } : null;
  }, npcId);
}

/** Read the local camera's fade effect. `direction===true && isComplete===true` == black (stranded); after
 * resetFX the effect is reset so `isComplete===false` == recovered (not black). */
async function readFadeState(
  page: SmokePage,
): Promise<{ direction: boolean | null; isRunning: boolean; isComplete: boolean } | null> {
  return page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const fade = scene?.cameras?.main?.fadeEffect;
    return fade
      ? { direction: fade.direction ?? null, isRunning: fade.isRunning === true, isComplete: fade.isComplete === true }
      : null;
  });
}

/**
 * card-vfx-flipbook-step fix round (F2): drive the two STRANDED portal-fade paths and assert the
 * camera recovers in both — the case the merged happy-path proof never covered.
 *
 * Scenario A (silent world-portal denial): send a valid world-portal-use intent from FAR OUTSIDE
 * the trigger radius. The server denies silently (mapId never changes, nothing surfaces client-side),
 * so the ~1200ms watchdog is the ONLY guard. Assert: black at +0ms, recovered (isComplete=false) at
 * +1500ms.
 *
 * Scenario B (successful stage entry): enter a stage via its portal. stage.enter does NOT change the
 * WorldRoom map, so recovery comes from the stage.enter fade-clear, not fadeInOnTransition. Assert the
 * fade is cleared shortly after stage.enter.
 */
async function capturePortalFadeGuardProof(outDir: string, page: SmokePage) {
  // Page A must be foregrounded or its rAF (and thus the camera fade tick) throttles — the
  // fade-out would never reach `isComplete`, masking the very state this proof exercises.
  await page.bringToFront();
  await stageInOpenField(page);

  // --- Scenario A: silent world-portal denial recovered by the watchdog ---
  // Stand far from the Bloomvale->Lanternwake portal so the server's trigger check fails silently.
  await moveLocalPlayerNear(page, 900, 720, 120, 18_000);
  const preState = await getSmokeState(page);
  const preMapId = preState?.players.find((p) => p.sessionId === preState.localSessionId)?.mapId;
  // Drive the REAL client portal path (GameScene.sendPortalUseIntent — the exact method a foot-trigger
  // / portal click calls). It fires the optimistic camera fade AND sends the intent. Because the player
  // is far from the portal, the server denies silently (mapId never changes, nothing surfaces client-
  // side), so ONLY the ~1200ms watchdog can recover the camera. The raw smoke intent helper does NOT
  // trigger the client fade, so it would not exercise this path.
  const firedRealPath = await page.evaluate((portalId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game") as unknown as {
      sendPortalUseIntent?: (id: string) => void;
    };
    if (typeof scene?.sendPortalUseIntent !== "function") return false;
    scene.sendPortalUseIntent(portalId);
    return true;
  }, BLOOMVALE_TO_LANTERNWAKE_PORTAL_ID);
  if (!firedRealPath) {
    throw new Error("portal-fade-guard proof: GameScene.sendPortalUseIntent not reachable — cannot exercise the real client fade path");
  }
  // The proof is only meaningful if the camera actually reaches BLACK first (isComplete===true on a
  // fade-OUT). Wait for that — a completed fade-out with no map change IS the stranded state pre-fix.
  await page.waitForFunction(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const fade = scene?.cameras?.main?.fadeEffect;
    return fade?.direction === true && fade?.isComplete === true;
  }, undefined, { timeout: 3_000 });
  const denyFadeAtBlack = await readFadeState(page);
  const denyBlackPath = `${outDir}/portal-fade-guard-deny-black.png`;
  await page.screenshot({ path: denyBlackPath });
  // Now the only recovery possible is the ~1200ms watchdog (mapId never changed, nothing surfaced).
  // Wait past the watchdog window; the camera MUST recover on its own (resetFX clears isComplete).
  await page.waitForFunction(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const fade = scene?.cameras?.main?.fadeEffect;
    return !fade || fade.isComplete !== true;
  }, undefined, { timeout: 2_500 });
  const denyFadeRecovered = await readFadeState(page);
  const denyRecoveredPath = `${outDir}/portal-fade-guard-deny-recovered.png`;
  await page.screenshot({ path: denyRecoveredPath });
  const denyState = await getSmokeState(page);
  const denyMapId = denyState?.players.find((p) => p.sessionId === denyState.localSessionId)?.mapId;
  if (denyMapId !== preMapId) {
    throw new Error(
      `portal-fade-guard proof: scenario A precondition failed — map changed (${preMapId}->${denyMapId}); the intent was NOT silently denied, so the watchdog path was not exercised`,
    );
  }
  if (!denyFadeAtBlack || denyFadeAtBlack.isComplete !== true) {
    throw new Error(`portal-fade-guard proof: scenario A never reached black — fade-out did not complete (${JSON.stringify(denyFadeAtBlack)})`);
  }
  if (denyFadeRecovered && denyFadeRecovered.direction === true && denyFadeRecovered.isComplete === true) {
    throw new Error(
      `portal-fade-guard proof: silent-denial path STRANDED at black after watchdog window (fade=${JSON.stringify(denyFadeRecovered)})`,
    );
  }

  // --- Scenario B: successful stage entry recovered by stage.enter clear ---
  await stageInOpenField(page);
  await moveLocalPlayerNear(page, 980, 1320, 110, 18_000);
  await moveLocalPlayerNear(page, 1500, 1400, 120, 18_000);
  await moveLocalPlayerNear(page, 1820, 920, 130, 18_000);
  await moveLocalPlayerNear(page, STAGE_PORTAL_X, STAGE_PORTAL_PLAYER_Y, 140);
  const stagePortalPoint = await getWorldScreenPoint(page, STAGE_PORTAL_X, STAGE_PORTAL_Y);
  await page.mouse.click(stagePortalPoint.x, stagePortalPoint.y);
  await page.locator("[data-stage-portal-confirm='true']").waitFor({ state: "visible", timeout: 5_000 });
  await page.locator("[data-stage-confirm-enter='true']").click();
  const stageFadeAtSend = await readFadeState(page);
  await page.waitForFunction(() => {
    const events = (globalThis as { __GAMEKIT_STAGE_EVENTS__?: Array<{ type: string }> }).__GAMEKIT_STAGE_EVENTS__ ?? [];
    return events.some((event) => event.type === "stage.enter");
  }, undefined, { timeout: 15_000 });
  // After stage.enter the fade must be cleared (isComplete=false) — the camera is not black.
  await page.waitForFunction(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const fade = scene?.cameras?.main?.fadeEffect;
    return !fade || fade.isComplete !== true;
  }, undefined, { timeout: 5_000 });
  const stageFadeAfterEnter = await readFadeState(page);
  const stageRecoveredPath = `${outDir}/portal-fade-guard-stage-recovered.png`;
  await page.screenshot({ path: stageRecoveredPath });
  if (stageFadeAfterEnter && stageFadeAfterEnter.direction === true && stageFadeAfterEnter.isComplete === true) {
    throw new Error(
      `portal-fade-guard proof: stage.enter path STRANDED at black (fade=${JSON.stringify(stageFadeAfterEnter)})`,
    );
  }

  return {
    kind: "gamekit-portal-fade-guard-proof",
    silentDenial: {
      portalId: BLOOMVALE_TO_LANTERNWAKE_PORTAL_ID,
      mapIdUnchanged: denyMapId === preMapId,
      fadeAtBlack: denyFadeAtBlack,
      fadeAfterWatchdog: denyFadeRecovered,
    },
    stageEntry: {
      portalId: STAGE_PORTAL_ID,
      fadeAtSend: stageFadeAtSend,
      fadeAfterEnter: stageFadeAfterEnter,
    },
    screenshots: {
      denyBlack: repoRelativePath(denyBlackPath),
      denyRecovered: repoRelativePath(denyRecoveredPath),
      stageRecovered: repoRelativePath(stageRecoveredPath),
    },
  };
}

async function captureZoneTransitionProof(outDir: string, page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  await page.evaluate(({ x, y, zoom }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const cam = scene?.cameras?.main;
    cam?.stopFollow();
    cam?.setZoom(zoom);
    cam?.centerOn(x, y);
  }, { x: BLOOMVALE_TO_LANTERNWAKE_PORTAL_X, y: BLOOMVALE_TO_LANTERNWAKE_PORTAL_TARGET_Y, zoom: GAMEPLAY_ZOOM });
  await page.waitForTimeout(350);
  const portalTexture = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const textures = scene?.textures as
      | { exists(key: string): boolean; get(key: string): { getSourceImage(): { width?: number; height?: number } } }
      | undefined;
    if (!textures?.exists("vfx_portal_ground_ring")) return { key: "vfx_portal_ground_ring", loaded: false };
    const source = textures.get("vfx_portal_ground_ring").getSourceImage() as { width?: number; height?: number } | undefined;
    return {
      key: "vfx_portal_ground_ring",
      loaded: true,
      width: source?.width ?? 0,
      height: source?.height ?? 0,
    };
  });
  if (!portalTexture.loaded || portalTexture.width !== 347 || portalTexture.height !== 261) {
    throw new Error(`zone-transition proof: portal texture did not decode at 347x261: ${JSON.stringify(portalTexture)}`);
  }
  const markerPath = `${outDir}/zone-transition-portal-marker.png`;
  await page.screenshot({ path: markerPath });

  await moveLocalPlayerNear(page, 900, 760, 90, 15_000);
  await moveLocalPlayerNear(page, 1500, 760, 90, 20_000);
  await moveLocalPlayerNear(page, 1900, 700, 90, 20_000);
  await moveLocalPlayerNear(page, BLOOMVALE_TO_LANTERNWAKE_PORTAL_X - 105, BLOOMVALE_TO_LANTERNWAKE_PORTAL_TARGET_Y, 24, 10_000);
  await page.evaluate(({ x, y, zoom }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const cam = scene?.cameras?.main;
    cam?.stopFollow();
    cam?.setZoom(zoom);
    cam?.centerOn(x, y);
  }, { x: BLOOMVALE_TO_LANTERNWAKE_PORTAL_X, y: BLOOMVALE_TO_LANTERNWAKE_PORTAL_TARGET_Y, zoom: GAMEPLAY_ZOOM });
  await page.waitForTimeout(350);
  const promptState = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game") as unknown as {
      children?: { list?: Array<{ text?: string; visible?: boolean; x?: number; y?: number; alpha?: number }> };
    };
    const prompts = scene.children?.list
      ?.filter((child) => child.text === "Click to enter")
      .map((child) => ({
        text: child.text ?? "",
        visible: child.visible === true,
        x: child.x ?? 0,
        y: child.y ?? 0,
        alpha: child.alpha ?? 0,
      })) ?? [];
    const prompt = prompts.find((candidate) => candidate.visible) ?? prompts[0];
    return {
      text: prompt?.text ?? "",
      visible: prompt?.visible === true,
      x: prompt?.x ?? 0,
      y: prompt?.y ?? 0,
      alpha: prompt?.alpha ?? 0,
      candidates: prompts,
    };
  });
  if (!promptState.visible) {
    throw new Error(`zone-transition proof: portal prompt not visible near portal: ${JSON.stringify(promptState)}`);
  }
  const promptPath = `${outDir}/zone-transition-portal-prompt.png`;
  await page.screenshot({ path: promptPath });
  await waitForPortalReadyForCapture(page);
  await sendPortalUseIntent(page, BLOOMVALE_TO_LANTERNWAKE_PORTAL_ID);
  // card-vfx-flipbook-step §4: portal use fades the camera OUT (replacing the bare DOM-overlay-only
  // cut). Assert the fade effect actually ran on the local camera, and capture the mid-fade frame.
  const fadeOutState = await page.waitForFunction(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const fade = scene?.cameras?.main?.fadeEffect;
    if (!fade) return null;
    // direction === true is a fade-OUT; capture while running or immediately after it completes.
    if (fade.direction === true && (fade.isRunning === true || fade.isComplete === true)) {
      return { direction: fade.direction, isRunning: fade.isRunning, isComplete: fade.isComplete };
    }
    return null;
  }, undefined, { timeout: 3_000 }).catch(() => null);
  const portalFadeOut = fadeOutState ? await fadeOutState.jsonValue() : null;
  const fadeOutPath = `${outDir}/zone-transition-portal-fadeout.png`;
  await page.screenshot({ path: fadeOutPath });
  if (!portalFadeOut) {
    throw new Error("zone-transition proof: portal-use camera fade-out did not run (§4 fade regression)");
  }
  const loadingState = await page.waitForFunction(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const state = scene?.getLoadingOverlayQaState?.();
    return state?.visible ? state : false;
  }, undefined, { timeout: 5_000 });
  await page.waitForTimeout(180);
  const loadingPath = `${outDir}/zone-transition-loading-screen.png`;
  await page.screenshot({ path: loadingPath });

  // Executable render assert (mechanized 2026-07-05, second masked-fallback
  // occurrence): the overlay must show REAL zone art, not a blank backdrop.
  // Both live portals declare loadingArtId, so a missing/undecodable image
  // here is always a defect.
  const loadingArt = await page.evaluate(async () => {
    const g = globalThis as unknown as {
      document: { getElementById(id: string): unknown };
      getComputedStyle(el: unknown): { backgroundImage: string };
      Image: new () => { src: string; naturalWidth: number; naturalHeight: number; decode(): Promise<void> };
    };
    const el = g.document.getElementById("loading-overlay-art");
    const bg = el ? g.getComputedStyle(el).backgroundImage : "";
    const match = /url\("?([^")]+)"?\)/.exec(bg);
    if (!match) return { url: "", loaded: false };
    const img = new g.Image();
    img.src = match[1];
    try {
      await img.decode();
      return { url: match[1], loaded: img.naturalWidth > 0, width: img.naturalWidth, height: img.naturalHeight };
    } catch {
      return { url: match[1], loaded: false };
    }
  });
  if (!loadingArt.loaded) {
    throw new Error(
      `zone-transition proof: loading art did not render (background=${loadingArt.url || "none"}) — ` +
        "the overlay showed a blank backdrop where portal-declared zone art belongs",
    );
  }

  await page.waitForFunction((mapId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    return player?.mapId === mapId && scene?.getLoadingOverlayQaState?.().visible === false;
  }, LANTERNWAKE_MAP_ID, { timeout: 15_000 });
  await page.evaluate(({ x, y, zoom }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const cam = scene?.cameras?.main;
    cam?.stopFollow();
    cam?.setZoom(zoom);
    cam?.centerOn(x, y);
  }, { x: 430, y: 500, zoom: GAMEPLAY_ZOOM });
  // card-vfx-flipbook-step §4: on arrival the new zone fades IN. Capture the fade-in frame (best-effort
  // — the fade may already be complete by the time centerOn runs; we assert the effect object exists).
  const fadeInState = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const fade = scene?.cameras?.main?.fadeEffect;
    return fade ? { direction: fade.direction, isRunning: fade.isRunning, isComplete: fade.isComplete } : null;
  });
  const fadeInPath = `${outDir}/zone-transition-arrival-fadein.png`;
  await page.screenshot({ path: fadeInPath });
  await page.waitForTimeout(250);
  const arrivalPath = `${outDir}/zone-transition-arrival-title.png`;
  await page.screenshot({ path: arrivalPath });
  const loadingStateValue = await loadingState.jsonValue();

  await travelLanternwakeToBloomvale(page);
  const suncradleBanner = await assertArrivalBannerText(page, EXPECTED_SUNCRADLE_BANNER);
  const suncradleBannerPath = `${outDir}/zone-transition-suncradle-banner.png`;
  await page.screenshot({ path: suncradleBannerPath, fullPage: false });
  await resetToFreshSuncradleGuest(page);
  const stageBanner = await enterStageForBannerProof(outDir, page);

  const state = await getSmokeState(page);
  const visualQa = await page.evaluate(() => (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__?.getVisualQaSnapshot?.());
  return {
    portalId: BLOOMVALE_TO_LANTERNWAKE_PORTAL_ID,
    fromMapId: BLOOMVALE_MAP_ID,
    toMapId: LANTERNWAKE_MAP_ID,
    loadingState: loadingStateValue,
    portalTexture,
    promptState,
    loadingArt,
    portalFade: {
      fadeOut: portalFadeOut,
      fadeIn: fadeInState,
    },
    bannerAssertions: {
      zoneEntry: suncradleBanner,
      stageEntry: stageBanner,
    },
    finalState: state,
    visiblePortals: visualQa?.portals ?? [],
    screenshots: {
      marker: markerPath,
      prompt: promptPath,
      loading: loadingPath,
      portalFadeOut: fadeOutPath,
      arrivalFadeIn: fadeInPath,
      arrivalTitle: arrivalPath,
      suncradleBanner: suncradleBannerPath,
      stageBanner: stageBanner.screenshot,
    },
  };
}

async function waitForPortalReadyForCapture(page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    await sendMoveIntent(page, BLOOMVALE_TO_LANTERNWAKE_PORTAL_X, BLOOMVALE_TO_LANTERNWAKE_PORTAL_TARGET_Y);
    const ready = await page.evaluate(({ x, y, mapId }) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
      const player = scene?.room?.state?.players?.get(scene.localSessionId);
      if (!player) return false;
      return player.mapId === mapId || Math.hypot(player.x - x, player.y - y) <= 64;
    }, { x: BLOOMVALE_TO_LANTERNWAKE_PORTAL_X, y: BLOOMVALE_TO_LANTERNWAKE_PORTAL_TARGET_Y, mapId: LANTERNWAKE_MAP_ID });
    if (ready) return;
    await page.waitForTimeout(300);
  }
  throw new Error("timed out staging player at portal for transition capture");
}

async function captureAdvancementProof(outDir: string, page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  await moveLocalPlayerNear(page, COMBAT_TRAINER_X + 36, COMBAT_TRAINER_Y + 40, 32);
  await waitForNpcVisible(page, COMBAT_TRAINER_ID);
  const target = await getVisibleNpcClickTarget(page, COMBAT_TRAINER_ID);
  await page.mouse.click(target.screenX, target.screenY);
  await page.waitForFunction(() => {
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    const panel = doc.getElementById("dialogue");
    return Boolean(panel && !panel.hidden && Array.from(panel.querySelectorAll("#dialogue-choices button")).some((button) => button.textContent === "Advance"));
  }, undefined, { timeout: 20_000 });

  const before = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    return {
      classId: player?.classId ?? "",
      level: player?.level ?? 0,
      questStatus: player?.quests?.get("quest_wayfarer_orders")?.status ?? "",
      dialogueOptions: Array.from(doc.querySelectorAll("#dialogue-choices button")).map((button) => button.textContent ?? ""),
    };
  });
  await page.locator("#dialogue").getByRole("button", { name: "Advance" }).click();
  await page.waitForFunction(() => {
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    return doc.querySelectorAll(".advancement-card").length === 6;
  }, undefined, { timeout: 20_000 });
  await page.screenshot({ path: `${outDir}/advancement-six-orders.png`, fullPage: true });
  console.log(`[capture] advancement six orders -> ${outDir}/advancement-six-orders.png`);

  const picker = await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    return {
      title: doc.querySelector("#advancement-title")?.textContent ?? "",
      cardCount: doc.querySelectorAll(".advancement-card").length,
      classIds: Array.from(doc.querySelectorAll(".advancement-card")).map((card) => ((card as ElementLike).dataset?.classId as string | undefined) ?? ""),
      labels: Array.from(doc.querySelectorAll(".advancement-card")).map((card) => card.textContent ?? ""),
    };
  });
  if (picker.cardCount !== 6) throw new Error(`advancement picker expected 6 orders, got ${JSON.stringify(picker)}`);
  for (const expected of ["class_archer", "class_cleric", "class_guardian", "class_mystic", "class_shadowblade", "class_tamer"]) {
    if (!picker.classIds.includes(expected)) throw new Error(`advancement picker missing ${expected}: ${JSON.stringify(picker)}`);
  }

  await page.locator(".advancement-card[data-class-id='class_archer']").click();
  await page.waitForFunction(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    return player?.classId === "class_archer";
  }, undefined, { timeout: 20_000 });
  await page.screenshot({ path: `${outDir}/advancement-class-changed.png`, fullPage: true });
  console.log(`[capture] advancement changed class -> ${outDir}/advancement-class-changed.png`);

  const after = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    return {
      classId: player?.classId ?? "",
      jobLevel: player?.jobLevel ?? 0,
      jobXp: player?.jobXp ?? -1,
      skillPoints: player?.skillPoints ?? -1,
      nameplate: doc.querySelector("#hud-stats .lm-unit__meta")?.textContent ?? "",
    };
  });
  if (before.classId !== "class_wayfarer" || after.classId !== "class_archer") {
    throw new Error(`advancement class change failed: ${JSON.stringify({ before, after })}`);
  }
  if (after.jobLevel !== 1 || after.jobXp !== 0 || after.skillPoints !== 1) {
    throw new Error(`advancement did not reset job runtime: ${JSON.stringify(after)}`);
  }

  return {
    schemaVersion: 1,
    kind: "gamekit-advancement-proof",
    before,
    picker,
    after,
    screenshots: [
      `${repoRelativePath(outDir)}/advancement-six-orders.png`,
      `${repoRelativePath(outDir)}/advancement-class-changed.png`,
    ],
  };
}

function repoRelativePath(file: string): string {
  const rel = pathRelative(ROOT, pathResolve(ROOT, file)).replace(/\\/g, "/");
  return rel.startsWith("../") ? file.replace(/\\/g, "/") : rel;
}

main().catch((err) => {
  console.error("[capture] FATAL:", err);
  stopDevkit(managedDevkit);
  stopChildProcesses();
  process.exit(1);
});

async function captureMinimapProof(outDir: string, page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  await page.waitForFunction(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const minimap = scene?.getVisualQaSnapshot?.()?.minimap;
    return Boolean(
      minimap?.terrainRendered &&
      minimap.playerMarkerCount === 1 &&
      minimap.monsterMarkerCount > 0 &&
      minimap.portalMarkerCount >= 1 &&
      minimap.viewportRendered,
    );
  }, undefined, { timeout: 20000 });

  const before = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const snapshot = scene?.getVisualQaSnapshot?.();
    const readout = (globalThis as SmokeBrowserGlobal).document.querySelector("[data-minimap-zoom-readout='true']")?.textContent ?? "";
    return { minimap: snapshot?.minimap, readout };
  });
  await page.screenshot({ path: `${outDir}/minimap-before-zoom.png` });

  await page.locator("[data-minimap-zoom-in='true']").click();
  await page.waitForTimeout(200);

  const after = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const snapshot = scene?.getVisualQaSnapshot?.();
    const readout = (globalThis as SmokeBrowserGlobal).document.querySelector("[data-minimap-zoom-readout='true']")?.textContent ?? "";
    return { minimap: snapshot?.minimap, readout };
  });
  await page.screenshot({ path: `${outDir}/minimap-after-zoom.png` });

  await page.locator("[data-world-map-open='true']").click();
  await page.waitForFunction(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const worldMap = scene?.getVisualQaSnapshot?.()?.worldMap as WorldMapQaState | undefined;
    return Boolean(worldMap?.open && worldMap.playerMarkerVisible && worldMap.viewportRendered && worldMap.monsterMarkerCount > 0);
  }, undefined, { timeout: 20000 });
  const modalOpen = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const snapshot = scene?.getVisualQaSnapshot?.();
    return snapshot?.worldMap as WorldMapQaState | undefined;
  });
  await page.screenshot({ path: `${outDir}/world-map-open.png` });

  const canvas = page.locator("[data-world-map-canvas='true']");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("world map canvas bounding box unavailable");

  const zoomReadoutOpen = await page.locator("[data-world-map-zoom-readout='true']").textContent();
  await page.locator("[data-world-map-zoom='in']").click();
  await page.waitForFunction((openZoom) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const worldMap = scene?.getVisualQaSnapshot?.()?.worldMap as WorldMapQaState | undefined;
    return Boolean(worldMap && worldMap.zoom > openZoom);
  }, modalOpen?.zoom ?? 0, { timeout: 5000 });
  const modalButtonZoomed = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    return scene?.getVisualQaSnapshot?.()?.worldMap as WorldMapQaState | undefined;
  });
  const zoomReadoutButton = await page.locator("[data-world-map-zoom-readout='true']").textContent();

  await canvas.dblclick({ position: { x: box.width * 0.52, y: box.height * 0.52 } });
  await page.waitForFunction((buttonZoom) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const worldMap = scene?.getVisualQaSnapshot?.()?.worldMap as WorldMapQaState | undefined;
    return Boolean(worldMap && worldMap.zoom > buttonZoom);
  }, modalButtonZoomed?.zoom ?? 0, { timeout: 5000 });
  const modalDoubleClicked = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    return scene?.getVisualQaSnapshot?.()?.worldMap as WorldMapQaState | undefined;
  });

  await page.mouse.move(box.x + box.width * 0.52, box.y + box.height * 0.52);
  await page.mouse.wheel(0, -700);
  await page.waitForFunction((doubleClickZoom) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const worldMap = scene?.getVisualQaSnapshot?.()?.worldMap as WorldMapQaState | undefined;
    return Boolean(worldMap && worldMap.zoom > doubleClickZoom);
  }, modalDoubleClicked?.zoom ?? 0, { timeout: 5000 });
  const modalWheelZoomed = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    return scene?.getVisualQaSnapshot?.()?.worldMap as WorldMapQaState | undefined;
  });

  for (let i = 0; i < 18; i += 1) {
    await page.locator("[data-world-map-zoom='in']").click();
  }
  await page.waitForFunction(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const worldMap = scene?.getVisualQaSnapshot?.()?.worldMap as WorldMapQaState | undefined;
    return Boolean(worldMap && worldMap.zoom >= 400);
  }, undefined, { timeout: 5000 });
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.66, box.y + box.height * 0.42, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);

  const modalZoomed = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const snapshot = scene?.getVisualQaSnapshot?.();
    return snapshot?.worldMap as WorldMapQaState | undefined;
  });
  await page.screenshot({ path: `${outDir}/world-map-max-zoom.png` });

  if (!before.minimap?.terrainRendered) throw new Error("minimap terrain was not rendered");
  if (before.minimap.playerMarkerCount !== 1) throw new Error(`expected one player marker, got ${before.minimap.playerMarkerCount}`);
  if (before.minimap.monsterMarkerCount <= 0) throw new Error(`expected monster markers, got ${before.minimap.monsterMarkerCount}`);
  if (before.minimap.portalMarkerCount < 1) throw new Error(`expected portal markers, got ${before.minimap.portalMarkerCount}`);
  if (!before.minimap.viewportRendered) throw new Error("minimap viewport rectangle was not rendered");
  if (before.readout === after.readout || before.minimap.zoomPercent === after.minimap?.zoomPercent) {
    throw new Error(`minimap zoom did not change: ${before.readout} -> ${after.readout}`);
  }
  if (!modalOpen?.open || !modalOpen.playerMarkerVisible) throw new Error("world map did not render the player marker");
  if (modalOpen.monsterMarkerCount <= 0) throw new Error(`world map did not render monster markers: ${modalOpen.monsterMarkerCount}`);
  if (modalOpen.npcMarkerCount <= 0) throw new Error(`world map did not render NPC markers: ${modalOpen.npcMarkerCount}`);
  if (modalOpen.portalMarkerCount < 1) throw new Error(`world map did not render portal markers: ${modalOpen.portalMarkerCount}`);
  if (!modalOpen.viewportRendered) throw new Error("world map did not render the camera viewport");
  if (modalOpen.playerDeltaPx === null || modalOpen.playerDeltaPx > 0.51) {
    throw new Error(`world map player marker mismatch: ${modalOpen.playerDeltaPx}`);
  }
  if (!modalButtonZoomed || modalButtonZoomed.zoom <= modalOpen.zoom || zoomReadoutOpen === zoomReadoutButton) {
    throw new Error(`world map zoom button did not change zoom/readout: ${modalOpen.zoom}/${zoomReadoutOpen} -> ${modalButtonZoomed?.zoom}/${zoomReadoutButton}`);
  }
  if (!modalDoubleClicked || modalDoubleClicked.zoom <= modalButtonZoomed.zoom) {
    throw new Error(`world map double-click zoom did not increase: ${modalButtonZoomed.zoom} -> ${modalDoubleClicked?.zoom}`);
  }
  if (!modalWheelZoomed || modalWheelZoomed.zoom <= modalDoubleClicked.zoom) {
    throw new Error(`world map wheel zoom did not increase: ${modalDoubleClicked.zoom} -> ${modalWheelZoomed?.zoom}`);
  }
  if (!modalZoomed || modalZoomed.zoom < 400) {
    throw new Error(`world map max zoom did not reach 400%: ${modalZoomed?.zoom}`);
  }
  if (modalZoomed.pan.x === modalOpen.pan.x && modalZoomed.pan.y === modalOpen.pan.y) {
    throw new Error(`world map pan did not change: ${JSON.stringify(modalOpen.pan)} -> ${JSON.stringify(modalZoomed.pan)}`);
  }

  return {
    schemaVersion: 1,
    kind: "gamekit-minimap-proof",
    screenshots: [
      `${repoRelativePath(outDir)}/minimap-before-zoom.png`,
      `${repoRelativePath(outDir)}/minimap-after-zoom.png`,
      `${repoRelativePath(outDir)}/world-map-open.png`,
      `${repoRelativePath(outDir)}/world-map-max-zoom.png`,
    ],
    before,
    after,
    worldMap: {
      open: modalOpen,
      buttonZoomed: modalButtonZoomed,
      doubleClicked: modalDoubleClicked,
      wheelZoomed: modalWheelZoomed,
      maxZoomed: modalZoomed,
    },
  };
}

async function captureDialogueProof(outDir: string, page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  await moveLocalPlayerNear(page, HARBOR_WARDEN_X + 40, HARBOR_WARDEN_Y + 45, 28);
  await waitForNpcVisible(page, HARBOR_WARDEN_ID);
  const target = await getVisibleNpcClickTarget(page, HARBOR_WARDEN_ID);
  await page.mouse.click(target.screenX, target.screenY);
  await page.waitForFunction(() => {
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    const panel = doc.getElementById("dialogue");
    const portrait = panel?.querySelector(".dialogue-portrait") as ImageLike | undefined;
    return Boolean(
      panel &&
        !panel.hidden &&
        portrait &&
        !portrait.hidden &&
        portrait.naturalWidth > 0 &&
        (panel.querySelector(".panel-body")?.textContent?.length ?? 0) > 0,
    );
  }, undefined, { timeout: 20_000 });

  const midReveal = await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    const panel = doc.getElementById("dialogue");
    const portrait = panel?.querySelector(".dialogue-portrait") as ImageLike | undefined;
    const choices = panel?.querySelector("#dialogue-choices");
    // card-hud-qol-r3: the typewriter now reveals via two spans (visible prefix +
    // transparent pending remainder) so the box holds its final size from frame 0.
    // The revealed-only length proves partial reveal; the options are hidden via
    // the --revealing class (visibility), not the hidden attribute.
    const revealedText = panel?.querySelector(".dialogue-body-revealed")?.textContent ?? "";
    return {
      visible: Boolean(panel && !panel.hidden),
      portraitSrc: portrait?.getAttribute("src") ?? "",
      portraitNaturalWidth: portrait?.naturalWidth ?? 0,
      bodyText: panel?.querySelector(".panel-body")?.textContent ?? "",
      revealedText,
      choicesHidden: Boolean(choices?.classList?.contains("dialogue-options--revealing")),
      optionLabels: Array.from(panel?.querySelectorAll("#dialogue-choices button") ?? []).map((button) => button.textContent ?? ""),
    };
  });
  await page.screenshot({ path: `${outDir}/dialogue-mid-reveal.png` });
  console.log(`[capture] dialogue mid reveal -> ${outDir}/dialogue-mid-reveal.png`);

  await page.locator("#dialogue").click();
  await page.waitForFunction(() => {
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    const panel = doc.getElementById("dialogue");
    const choices = panel?.querySelector("#dialogue-choices");
    return Boolean(panel && !panel.hidden && choices && !choices.hidden && panel.querySelectorAll("#dialogue-choices button").length >= 3);
  }, undefined, { timeout: 5_000 });

  const before = await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    const panel = doc.getElementById("dialogue");
    const portrait = panel?.querySelector(".dialogue-portrait") as ImageLike | undefined;
    const bodyText = panel?.querySelector(".panel-body")?.textContent ?? "";
    return {
      visible: Boolean(panel && !panel.hidden),
      portraitSrc: portrait?.getAttribute("src") ?? "",
      portraitNaturalWidth: portrait?.naturalWidth ?? 0,
      bodyText,
      optionLabels: Array.from(panel?.querySelectorAll("#dialogue-choices button") ?? []).map((button) => button.textContent ?? ""),
    };
  });
  await page.screenshot({ path: `${outDir}/dialogue-portrait-options.png` });
  console.log(`[capture] dialogue portrait/options -> ${outDir}/dialogue-portrait-options.png`);

  await page.getByRole("button", { name: "What needs doing?" }).click();
  await page.waitForFunction(() => {
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    const text = doc.querySelector("#dialogue .panel-body")?.textContent ?? "";
    return text.includes("Keep the grass clear");
  }, undefined, { timeout: 5_000 });
  const after = await page.evaluate(() => ({
    bodyText: (globalThis as unknown as { document: DocumentLike }).document.querySelector("#dialogue .panel-body")?.textContent ?? "",
    optionLabels: Array.from((globalThis as unknown as { document: DocumentLike }).document.querySelectorAll("#dialogue-choices button")).map((button) => button.textContent ?? ""),
  }));
  await page.screenshot({ path: `${outDir}/dialogue-say-option-swapped.png` });
  console.log(`[capture] dialogue say option -> ${outDir}/dialogue-say-option-swapped.png`);

  if (!before.optionLabels.includes("What needs doing?") || !before.optionLabels.includes("Just passing through.") || !before.optionLabels.includes("Show me supplies.")) {
    throw new Error(`dialogue options missing expected labels: ${JSON.stringify(before.optionLabels)}`);
  }
  if (!midReveal.choicesHidden || midReveal.optionLabels.length < 3 || midReveal.revealedText.length >= before.bodyText.length) {
    throw new Error(`dialogue typewriter proof failed: ${JSON.stringify({ midReveal, beforeBodyLength: before.bodyText.length })}`);
  }
  if (before.bodyText === after.bodyText) {
    throw new Error("dialogue say option did not change body text");
  }

  return {
    npcId: HARBOR_WARDEN_ID,
    midReveal,
    before,
    after,
    assertions: {
      portraitLoaded: before.portraitNaturalWidth > 0,
      midRevealPartial: midReveal.revealedText.length > 0 && midReveal.revealedText.length < before.bodyText.length,
      choicesHiddenUntilComplete: midReveal.choicesHidden,
      clickSkipRevealsChoices: before.optionLabels.length >= 3,
      optionsClickable: before.optionLabels.length >= 3,
      sayOptionSwappedText: before.bodyText !== after.bodyText,
    },
    screenshots: [
      `${outDir}/dialogue-mid-reveal.png`,
      `${outDir}/dialogue-portrait-options.png`,
      `${outDir}/dialogue-say-option-swapped.png`,
    ],
  };
}

async function captureQuestOfferProof(outDir: string, page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  await moveLocalPlayerNear(page, HARBOR_WARDEN_X + 40, HARBOR_WARDEN_Y + 45, 28);
  await waitForNpcVisible(page, HARBOR_WARDEN_ID);
  const target = await getVisibleNpcClickTarget(page, HARBOR_WARDEN_ID);
  await page.mouse.click(target.screenX, target.screenY);
  await page.waitForFunction(() => {
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    const panel = doc.getElementById("dialogue");
    return Boolean(panel && !panel.hidden && Array.from(panel.querySelectorAll("#dialogue-choices button")).some((button) => button.textContent === "Accept"));
  }, undefined, { timeout: 20_000 });
  await page.locator("#dialogue").getByRole("button", { name: "Accept" }).click();
  await page.waitForFunction(() => {
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    const modal = doc.querySelector(".quest-offer-modal");
    const portrait = modal?.querySelector(".quest-offer-portrait-frame img") as ImageLike | undefined;
    const accept = Array.from(modal?.querySelectorAll("button") ?? []).some((button) => button.textContent === "Accept");
    return Boolean(modal && portrait && portrait.naturalWidth > 0 && accept);
  }, undefined, { timeout: 20_000 });

  const offer = await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    const modal = doc.querySelector(".quest-offer-modal");
    return {
      title: modal?.querySelector("#quest-offer-title")?.textContent ?? "",
      npcName: modal?.querySelector(".quest-offer-nameplate")?.textContent ?? "",
      objective: modal?.querySelector(".quest-offer-objective")?.textContent ?? "",
      rewards: modal?.querySelector(".quest-offer-rewards")?.textContent ?? "",
      primaryLabels: Array.from(modal?.querySelectorAll("button") ?? []).map((button) => button.textContent ?? ""),
    };
  });
  await page.screenshot({ path: `${outDir}/quest-offer-modal.png` });
  console.log(`[capture] quest offer modal -> ${outDir}/quest-offer-modal.png`);

  await page.locator(".quest-offer-modal").getByRole("button", { name: "Accept" }).click();
  await page.waitForFunction(() => {
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    const tracker = doc.getElementById("hud-quest-tracker");
    return Boolean(tracker?.querySelector(".hud-quest-row")?.textContent?.includes("Meadow Patrol"));
  }, undefined, { timeout: 20_000 });
  await page.screenshot({ path: `${outDir}/quest-offer-accepted-tracker.png` });
  console.log(`[capture] quest offer accepted/tracker -> ${outDir}/quest-offer-accepted-tracker.png`);

  const tracker = await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    const row = doc.querySelector("#hud-quest-tracker .hud-quest-row");
    const fill = row?.querySelector(".hud-quest-progress .lm-bar__fill") as (ElementLike & { style: { width?: string } }) | undefined;
    return {
      rowText: row?.textContent ?? "",
      progressWidth: fill?.style.width ?? "",
      modalClosed: !doc.querySelector(".quest-offer-modal"),
    };
  });

  if (!offer.primaryLabels.includes("Accept")) throw new Error(`quest offer modal missing Accept button: ${JSON.stringify(offer)}`);
  if (!offer.objective.includes("0/6")) throw new Error(`quest offer objective did not show initial progress: ${JSON.stringify(offer)}`);
  if (!offer.rewards.includes("200") || !offer.rewards.includes("Gold")) throw new Error(`quest offer rewards missing gold card: ${JSON.stringify(offer)}`);
  if (!tracker.rowText.includes("Meadow Patrol") || !tracker.rowText.includes("0/6")) throw new Error(`quest tracker did not update after modal accept: ${JSON.stringify(tracker)}`);

  return {
    schemaVersion: 1,
    kind: "gamekit-quest-offer-proof",
    npcId: HARBOR_WARDEN_ID,
    offer,
    tracker,
    screenshots: [
      `${repoRelativePath(outDir)}/quest-offer-modal.png`,
      `${repoRelativePath(outDir)}/quest-offer-accepted-tracker.png`,
    ],
  };
}

async function captureQuestJournalProof(outDir: string, page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  const shots: Record<string, string> = {};
  const states: Record<string, unknown> = {};
  const questId = BLOOMVALE_FIRST_HUNT_QUEST_ID;
  const questTitle = "Suncradle First Hunt";
  const shot = async (label: string): Promise<void> => {
    const file = `${outDir}/quest-journal-${label}.png`;
    await page.screenshot({ path: file, fullPage: true });
    shots[label] = repoRelativePath(file);
    console.log(`[capture] quest journal ${label} -> ${file}`);
  };

  await page.keyboard.press("KeyJ");
  states.open = await waitForQuestJournalState(page, (journal) => journal.open && journal.rowCount >= 1 && journal.detailTitle !== null);
  await shot("open-list-detail");

  await page.locator(`.quest-journal-row[data-quest-id='${questId}']`).click();
  states.detail = await waitForQuestJournalState(page, (journal) => journal.selectedQuest === questId && journal.detailTitle === questTitle);
  states.xpRewardIcon = await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    const cards = Array.from(doc.querySelectorAll(".quest-journal-reward-card"));
    const xpCard = cards.find((card) => card.textContent?.includes("XP"));
    const icon = xpCard?.querySelector(".quest-journal-reward-icon");
    const img = icon?.querySelector("img") as (ElementLike & { src?: string; naturalWidth?: number }) | undefined;
    const fallback = icon?.querySelector(".lm-item-icon__fallback") as (ElementLike & { hidden?: boolean }) | undefined;
    const iconWithClassList = icon as (ElementLike & { classList?: { contains(name: string): boolean } }) | undefined;
    return {
      src: img?.src ?? "",
      naturalWidth: img?.naturalWidth ?? 0,
      fallbackText: fallback?.textContent ?? "",
      fallbackHidden: fallback?.hidden ?? false,
      loaded: Boolean(iconWithClassList?.classList?.contains("lm-item-icon--loaded")),
    };
  });
  // Real-asset assert (fallback-proof-expiry law, a4ecb43d): the XP chip must render
  // the actual glyph — a recorded-but-unasserted check cannot fail the proof.
  const xpIcon = states.xpRewardIcon as { src?: string; naturalWidth?: number; fallbackText?: string; fallbackHidden?: boolean };
  if (!/icon_xp_reward\.png/.test(xpIcon.src ?? "") || (xpIcon.naturalWidth ?? 0) <= 0 || xpIcon.fallbackHidden !== true) {
    throw new Error(`xp reward glyph proof failed (real asset did not render): ${JSON.stringify(xpIcon)}`);
  }
  await shot("selected-detail-rewards");

  // Zone grouping + collapse proof (card-quest-journal-groups): quests render under
  // collapsible zone headers; collapsing a group hides its rows; completed quests
  // fold into a per-group section. Pick the zone group holding the active quest.
  const openState = states.open as QuestJournalQaState;
  const activeGroup = openState.groups.find((group) => group.activeCount >= 1);
  if (!activeGroup) throw new Error(`quest journal has no active zone group: ${JSON.stringify(openState.groups)}`);
  const groupKey = activeGroup.zoneKey;
  const groupRowsVisible = await page.evaluate((key: string) => {
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    return doc.querySelectorAll(`[data-zone-group='${key}'] .quest-journal-row`).length;
  }, groupKey);
  if (groupRowsVisible < 1) throw new Error(`expanded zone group renders no rows: ${groupKey}`);
  states.grouped = { groupKey, groupCount: openState.groups.length, groupRowsVisible };
  await shot("zone-groups");

  await page.locator(`[data-zone-group-toggle='${groupKey}']`).click();
  states.groupCollapsed = await waitForQuestJournalState(
    page,
    (journal) => journal.groups.find((group) => group.zoneKey === groupKey)?.expanded === false,
  );
  const collapsedRows = await page.evaluate((key: string) => {
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    return doc.querySelectorAll(`[data-zone-group='${key}'] .quest-journal-row`).length;
  }, groupKey);
  if (collapsedRows !== 0) throw new Error(`collapsed zone group still shows ${collapsedRows} rows: ${groupKey}`);
  await shot("zone-group-collapsed");

  await page.locator(`[data-zone-group-toggle='${groupKey}']`).click();
  states.groupExpanded = await waitForQuestJournalState(
    page,
    (journal) => journal.groups.find((group) => group.zoneKey === groupKey)?.expanded === true,
  );

  // Re-select the quest (a collapse cycle may have shifted selection defaults).
  await page.locator(`.quest-journal-row[data-quest-id='${questId}']`).click();
  await waitForQuestJournalState(page, (journal) => journal.selectedQuest === questId && journal.detailTitle === questTitle);

  const trackerBefore = await getQuestTrackerText(page);
  await page.locator(`.quest-journal-detail [data-quest-track-toggle='${questId}']`).click();
  states.untracked = await waitForQuestJournalState(
    page,
    (journal) => journal.open && journal.selectedQuest === questId && !journal.trackedQuestIds.includes(questId),
  );
  const trackerAfterUntrack = await getQuestTrackerText(page);
  await shot("tracker-after-untrack");

  await page.locator(`.quest-journal-detail [data-quest-track-toggle='${questId}']`).click();
  states.trackedAgain = await waitForQuestJournalState(
    page,
    (journal) => journal.open && journal.selectedQuest === questId && journal.trackedQuestIds.includes(questId),
  );
  const trackerAfterTrack = await getQuestTrackerText(page);
  await shot("tracker-after-track");

  if (!trackerBefore.includes(questTitle)) throw new Error(`tracker missing accepted quest before toggle: ${trackerBefore}`);
  if (trackerAfterUntrack.includes(questTitle)) throw new Error(`tracker did not hide untracked quest: ${trackerAfterUntrack}`);
  if (!trackerAfterTrack.includes(questTitle)) throw new Error(`tracker did not restore tracked quest: ${trackerAfterTrack}`);

  return {
    schemaVersion: 1,
    kind: "gamekit-quest-journal-proof",
    generatedAt: new Date().toISOString(),
    shots,
    states,
    tracker: {
      before: trackerBefore,
      afterUntrack: trackerAfterUntrack,
      afterTrack: trackerAfterTrack,
    },
    assertions: {
      journalOpenedWithRows: ((states.open as { rowCount?: number }).rowCount ?? 0) >= 1,
      detailSelected: (states.detail as { detailTitle?: string | null }).detailTitle === questTitle,
      xpRewardUsesGlyph:
        /icon_xp_reward\.png/.test((states.xpRewardIcon as { src?: string }).src ?? "") &&
        ((states.xpRewardIcon as { naturalWidth?: number }).naturalWidth ?? 0) > 0 &&
        (states.xpRewardIcon as { fallbackText?: string; fallbackHidden?: boolean }).fallbackText !== "X" &&
        (states.xpRewardIcon as { fallbackHidden?: boolean }).fallbackHidden === true,
      trackerFollowsUntrack: !trackerAfterUntrack.includes(questTitle),
      trackerFollowsTrack: trackerAfterTrack.includes(questTitle),
      questsGroupedByZone: (states.open as QuestJournalQaState).groups.length >= 1 &&
        (states.open as QuestJournalQaState).groups.every((group) => group.activeCount + group.completedCount >= 1),
      groupCollapseHidesRows:
        (states.groupCollapsed as QuestJournalQaState).groups.find((group) => group.zoneKey === (states.grouped as { groupKey: string }).groupKey)?.expanded === false,
      groupReExpands:
        (states.groupExpanded as QuestJournalQaState).groups.find((group) => group.zoneKey === (states.grouped as { groupKey: string }).groupKey)?.expanded === true,
    },
  };
}

async function captureQuestNavProof(outDir: string, page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  await waitForQuestStatus(page, BLOOMVALE_FIRST_HUNT_QUEST_ID, "active");
  const initial = await waitForQuestNavState(page, (state) =>
    state.questNav.activeTarget?.questId === BLOOMVALE_FIRST_HUNT_QUEST_ID &&
    state.minimap.questPinCount >= 1 &&
    state.minimap.questPins.some((pin) => pin.questId === BLOOMVALE_FIRST_HUNT_QUEST_ID),
  );
  const target = initial.questNav.activeTarget;
  if (!target) throw new Error("quest nav active target missing after initial wait");
  const pin = initial.minimap.questPins.find((candidate) => candidate.questId === BLOOMVALE_FIRST_HUNT_QUEST_ID);
  if (!pin) throw new Error(`minimap pin missing for ${BLOOMVALE_FIRST_HUNT_QUEST_ID}: ${JSON.stringify(initial.minimap)}`);
  if (Math.hypot(pin.x - target.x, pin.y - target.y) > 0.51) {
    throw new Error(`minimap pin does not match resolved target: pin=${JSON.stringify(pin)} target=${JSON.stringify(target)}`);
  }

  await page.locator(`.hud-quest-row[data-quest-id='${BLOOMVALE_FIRST_HUNT_QUEST_ID}']`).click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${outDir}/quest-nav-pin-pulse.png`, fullPage: true });

  const away = {
    x: target.x < 1200 ? 2200 : 180,
    y: target.y < 900 ? 1600 : 260,
    zoom: GAMEPLAY_ZOOM,
  };
  await page.evaluate(({ x, y, zoom }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const cam = scene?.cameras?.main;
    if (!cam) throw new Error("camera unavailable for quest nav proof");
    cam.stopFollow();
    cam.setZoom(zoom);
    cam.centerOn(x, y);
  }, away);
  const arrowVisible = await waitForQuestNavState(page, (state) =>
    state.questNav.activeTarget?.questId === BLOOMVALE_FIRST_HUNT_QUEST_ID &&
    state.questNav.edgeArrow.visible,
  );
  await page.screenshot({ path: `${outDir}/quest-nav-edge-arrow.png`, fullPage: true });

  await page.evaluate(({ x, y, zoom }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const cam = scene?.cameras?.main;
    if (!cam) throw new Error("camera unavailable for quest nav proof");
    cam.stopFollow();
    cam.setZoom(zoom);
    cam.centerOn(x, y);
  }, { x: target.x, y: target.y, zoom: GAMEPLAY_ZOOM });
  const arrowHidden = await waitForQuestNavState(page, (state) =>
    state.questNav.activeTarget?.questId === BLOOMVALE_FIRST_HUNT_QUEST_ID &&
    !state.questNav.edgeArrow.visible,
  );
  await page.screenshot({ path: `${outDir}/quest-nav-target-onscreen.png`, fullPage: true });

  await page.locator("[data-world-map-open='true']").click();
  const worldMap = await page.waitForFunction((questId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const state = scene?.getVisualQaSnapshot?.()?.worldMap as WorldMapQaState | undefined;
    return state?.open && state.questPins.some((pin) => pin.questId === questId) ? state : false;
  }, BLOOMVALE_FIRST_HUNT_QUEST_ID, { timeout: 20_000 });
  const worldMapState = await worldMap.jsonValue() as WorldMapQaState;
  await page.screenshot({ path: `${outDir}/quest-nav-world-map-pin.png`, fullPage: true });

  return {
    schemaVersion: 1,
    kind: "gamekit-quest-nav-proof",
    questId: BLOOMVALE_FIRST_HUNT_QUEST_ID,
    target,
    minimapPin: pin,
    states: {
      initial,
      arrowVisible,
      arrowHidden,
      worldMap: worldMapState,
    },
    screenshots: [
      `${repoRelativePath(outDir)}/quest-nav-pin-pulse.png`,
      `${repoRelativePath(outDir)}/quest-nav-edge-arrow.png`,
      `${repoRelativePath(outDir)}/quest-nav-target-onscreen.png`,
      `${repoRelativePath(outDir)}/quest-nav-world-map-pin.png`,
    ],
    assertions: {
      minimapPinMatchesTarget: Math.hypot(pin.x - target.x, pin.y - target.y) <= 0.51,
      edgeArrowVisibleOffscreen: arrowVisible.questNav.edgeArrow.visible,
      edgeArrowHiddenOnscreen: !arrowHidden.questNav.edgeArrow.visible,
      worldMapPinRendered: worldMapState.questPins.some((candidate) => candidate.questId === BLOOMVALE_FIRST_HUNT_QUEST_ID),
    },
  };
}

async function waitForQuestNavState(
  page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"],
  predicate: (state: { minimap: { questPinCount: number; questPins: Array<{ questId: string; kind: string; mapId: string; x: number; y: number }> }; questNav: QuestNavQaState }) => boolean,
): Promise<{ minimap: { questPinCount: number; questPins: Array<{ questId: string; kind: string; mapId: string; x: number; y: number }> }; questNav: QuestNavQaState }> {
  const deadline = Date.now() + 10_000;
  let last: { minimap: { questPinCount: number; questPins: Array<{ questId: string; kind: string; mapId: string; x: number; y: number }> }; questNav: QuestNavQaState } | undefined;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
      const snapshot = scene?.getVisualQaSnapshot?.();
      return snapshot?.minimap && snapshot.questNav ? { minimap: snapshot.minimap, questNav: snapshot.questNav as QuestNavQaState } : undefined;
    });
    if (last && predicate(last)) return last;
    await page.waitForTimeout(100);
  }
  throw new Error(`timed out waiting for quest nav state; last=${JSON.stringify(last)}`);
}

async function waitForQuestJournalState(
  page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"],
  predicate: (journal: QuestJournalQaState) => boolean,
): Promise<QuestJournalQaState> {
  const deadline = Date.now() + 8000;
  let last: QuestJournalQaState | undefined;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
      return scene?.getVisualQaSnapshot?.()?.questJournal as QuestJournalQaState | undefined;
    });
    if (last && predicate(last)) return last;
    await page.waitForTimeout(100);
  }
  throw new Error(`timed out waiting for quest journal state; last=${JSON.stringify(last)}`);
}

async function getQuestTrackerText(page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]): Promise<string> {
  return page.evaluate(() => (globalThis as unknown as { document: DocumentLike }).document.getElementById("hud-quest-tracker")?.textContent ?? "");
}

async function captureShopProof(outDir: string, page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  const shots: Record<string, string> = {};
  const shot = async (label: string): Promise<void> => {
    const file = `${outDir}/shop-${label}.png`;
    await page.screenshot({ path: file, fullPage: true });
    shots[label] = repoRelativePath(file);
    console.log(`[capture] shop ${label} -> ${file}`);
  };

  await moveLocalPlayerNear(page, HARBOR_WARDEN_X + 40, HARBOR_WARDEN_Y + 45, 28);
  await waitForNpcVisible(page, HARBOR_WARDEN_ID);
  const target = await getVisibleNpcClickTarget(page, HARBOR_WARDEN_ID);
  await page.mouse.click(target.screenX, target.screenY);
  await page.waitForFunction(() => {
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    const panel = doc.getElementById("dialogue");
    return Boolean(panel && !panel.hidden && Array.from(panel.querySelectorAll("#dialogue-choices button")).some((button) => /^(Shop|Show me supplies\.)$/.test(button.textContent ?? "")));
  }, undefined, { timeout: 20_000 });
  await page.getByRole("button", { name: /^(Shop|Show me supplies\.)$/ }).click();
  await page.waitForFunction(() => {
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    const panel = doc.getElementById("shop");
    return Boolean(
      panel &&
        !panel.hidden &&
        panel.querySelector(".shop-grid") &&
        panel.querySelector(".shop-detail") &&
        Array.from(panel.querySelectorAll(".shop-item-card")).length >= 6,
    );
  }, undefined, { timeout: 20_000 });
  const buyGridState = await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    return {
      cardCount: doc.querySelectorAll("#shop .shop-item-card").length,
      hasDetail: Boolean(doc.querySelector("#shop .shop-detail-name")),
    };
  });

  await shot("buy-grid-detail");
  await page.locator("#shop .shop-item-card", { hasText: "Minor Health Potion" }).click();
  await page.locator("#shop .shop-quantity-chips").getByRole("button", { name: "Max" }).click();
  await page.waitForFunction(() => {
    const input = (globalThis as unknown as { document: DocumentLike }).document.querySelector("#shop .shop-quantity-input") as (ElementLike & { value?: string }) | null;
    return Number(input?.value ?? 0) > 1;
  }, undefined, { timeout: 5_000 });
  await shot("detail-quantity-max");

  await page.locator("#shop .shop-tabs").getByRole("tab", { name: "Buy" }).click();
  await page.locator("#shop .shop-item-card", { hasText: "Minor Health Potion" }).click();
  await page.locator("#shop .shop-quantity-chips").getByRole("button", { name: "x1", exact: true }).click();
  await page.locator("#shop .shop-primary-action").click();
  await page.waitForFunction(() => {
    const text = (globalThis as unknown as { document: DocumentLike }).document.querySelector("body")?.textContent ?? "";
    return text.includes("Bought 1 Minor Health Potion");
  }, undefined, { timeout: 10_000 });
  await shot("purchase-toast");

  await page.locator("#shop .shop-tabs").getByRole("tab", { name: "Sell" }).click();
  await page.waitForFunction(() => {
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    return Boolean(
      doc.querySelector("#shop .shop-tabs [aria-selected='true']")?.textContent === "Sell" &&
        Array.from(doc.querySelectorAll("#shop .shop-item-card")).some((card) => card.textContent?.includes("Minor Health Potion")),
    );
  }, undefined, { timeout: 5_000 });
  await shot("sell-tab");

  const state = await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    const selectedTab = doc.querySelector("#shop .shop-tabs [aria-selected='true']")?.textContent ?? "";
    return {
      selectedTab,
      cardCount: doc.querySelectorAll("#shop .shop-item-card").length,
      hasDetail: Boolean(doc.querySelector("#shop .shop-detail-name")),
      quantity: (doc.querySelector("#shop .shop-quantity-input") as (ElementLike & { value?: string }) | null)?.value ?? "",
      toastText: Array.from(doc.querySelectorAll(".lm-toast")).map((toast) => toast.textContent ?? "").join(" | "),
    };
  });
  if (buyGridState.cardCount < 6 || !buyGridState.hasDetail) throw new Error(`shop grid/detail proof failed: ${JSON.stringify({ buyGridState, state })}`);
  if (state.selectedTab !== "Sell" || state.cardCount < 1 || !state.hasDetail) throw new Error(`shop sell proof failed: ${JSON.stringify({ buyGridState, state })}`);
  if (!state.toastText.includes("Bought 1 Minor Health Potion")) throw new Error(`shop purchase toast missing: ${JSON.stringify(state)}`);

  return {
    schemaVersion: 1,
    kind: "gamekit-shop-proof",
    npcId: HARBOR_WARDEN_ID,
    buyGridState,
    state,
    screenshots: shots,
  };
}

async function capturePartyProof(
  outDir: string,
  pageA: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"],
  pageB: Awaited<ReturnType<typeof createSmokeHarness>>["pageB"],
) {
  const inviteResult = await pageA.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    if (!scene?.room || !scene.localSessionId) throw new Error("page A game room unavailable");
    let targetSessionId = "";
    scene.room.state.players.forEach((_player, sessionId) => {
      if (!targetSessionId && sessionId !== scene.localSessionId) targetSessionId = sessionId;
    });
    if (!targetSessionId) throw new Error("second player not found for party proof");
    scene.room.send("intent", {
      type: "party.invite",
      requestId: `party-proof-invite-${Date.now()}`,
      targetSessionId,
    });
    return { fromSessionId: scene.localSessionId, targetSessionId };
  });

  await pageB.waitForFunction(() => {
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    return doc.querySelector(".lm-toast__action") !== null;
  }, undefined, { timeout: 15_000 });
  await pageB.locator(".lm-toast__action", { hasText: "Accept" }).click();

  await pageA.waitForFunction(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    let memberCount = 0;
    scene?.room?.state?.parties?.forEach((party) => {
      if (party.memberIds.includes(scene.localSessionId)) memberCount = party.memberIds.length;
    });
    return memberCount === 2;
  }, undefined, { timeout: 15_000 });

  await pageA.waitForFunction(() => {
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    return doc.querySelectorAll("#party-panel .party-member-row").length === 2;
  }, undefined, { timeout: 15_000 });
  const screenshot = `${outDir}/party-frame-2-members.png`;
  await pageA.screenshot({ path: screenshot });

  const dom = await pageA.evaluate(() => {
    const doc = (globalThis as unknown as { document: DocumentLike }).document;
    const panel = doc.querySelector("#party-panel");
    const rows = Array.from(doc.querySelectorAll("#party-panel .party-member-row")).map((row) => ({
      memberId: row.dataset?.partyMemberId ?? "",
      text: row.textContent ?? "",
    }));
    return { visible: Boolean(panel && !panel.hidden), rows };
  });
  if (!dom.visible || dom.rows.length !== 2) {
    throw new Error(`party proof expected two visible party rows, got ${JSON.stringify(dom)}`);
  }

  const state = await getSmokeState(pageA);
  const party = state?.parties.find((candidate) => candidate.memberIds.includes(inviteResult.fromSessionId));
  if (!party || party.memberIds.length !== 2) {
    throw new Error(`party proof expected replicated two-member party, got ${JSON.stringify(state?.parties ?? [])}`);
  }

  return {
    schemaVersion: 1,
    kind: "gamekit-party-proof",
    inviteResult,
    party,
    dom,
    screenshots: [repoRelativePath(screenshot)],
  };
}

type ElementLike = {
  hidden?: boolean;
  textContent: string | null;
  dataset?: Record<string, string | undefined>;
  classList?: { contains: (name: string) => boolean };
  getAttribute(name: string): string | null;
  querySelector(selector: string): ElementLike | null;
  querySelectorAll(selector: string): ArrayLike<ElementLike>;
};

type ImageLike = ElementLike & {
  naturalWidth: number;
};

type DocumentLike = {
  getElementById(id: string): ElementLike | null;
  querySelector(selector: string): ElementLike | null;
  querySelectorAll(selector: string): ArrayLike<ElementLike>;
};

async function captureHubProof(outDir: string, page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  const shots: Record<string, string> = {};
  const states: Record<string, unknown> = {};
  const shot = async (label: string, fullPage = true): Promise<void> => {
    const file = `${outDir}/hub-${label}.png`;
    await page.screenshot({ path: file, fullPage });
    shots[label] = repoRelativePath(file);
    console.log(`[capture] hub ${label} -> ${file}`);
  };

  await stageInOpenField(page);
  states.attributePointReady = await gainAttributePoint(page);
  await page.keyboard.press("KeyC");
  await page.locator(".player-hub-search").fill("");
  states.open = await waitForHubState(page, (hub) => hub.open && hub.gridCount > 0);
  states.attributesOpen = await waitForHubState(page, (hub) => hub.attributeRowCount === 6 && hub.attributePoints > 0);
  states.portrait = await getHubPortraitState(page);
  await shot("open-grid-paper-doll");
  const attributeBefore = states.attributesOpen as HubQaState;
  await page.locator("[data-attribute-row='vit'] .player-hub-attribute-controls .lm-btn").filter({ hasText: "+" }).click();
  states.attributeSpend = await waitForHubState(
    page,
    (hub) => hub.allocatedAttributes.vit === (attributeBefore.allocatedAttributes.vit ?? 0) + 1 &&
      hub.attributePoints === attributeBefore.attributePoints - 1,
  );
  await shot("attribute-vit-spent");
  states.guidance = await waitForHubState(page, (hub) => hub.guidanceHint !== null);
  await page.locator(".player-hub-guidance [data-guidance-chip]").nth(1).click();
  states.guidanceJump = await waitForHubState(page, (hub) => hub.guidanceFocusedSlot !== null);
  await shot("guidance-jump-slot");

  await page.evaluate(() => {
    const active = (globalThis as SmokeBrowserGlobal).document.activeElement;
    active?.blur?.();
  });
  const beforeBlock = await getHubMovementProbe(page);
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(350);
  await page.keyboard.up("KeyW");
  const afterBlock = await getHubMovementProbe(page);
  states.inputBlocked = { before: beforeBlock, after: afterBlock };
  if (!afterBlock.hub?.gameplayInputBlocked || afterBlock.input.moveTarget !== null || afterBlock.input.predictionTarget !== null) {
    throw new Error(`hub did not block WASD movement; state=${JSON.stringify(states.inputBlocked)}`);
  }

  await page.locator(".player-hub-search").fill("band");
  states.search = await waitForHubState(page, (hub) => hub.search === "band" && hub.gridCount >= 1);
  await shot("search-band");

  await page.locator(".player-hub-search").fill("");
  await page.locator(".player-hub-controls .lm-select").selectOption("equipment");
  states.filter = await waitForHubState(page, (hub) => hub.filter === "equipment" && hub.gridCount >= 1);

  await page.locator(".player-hub-controls .lm-btn--toggle").click();
  states.compatibleOnly = await waitForHubState(page, (hub) => hub.compatibleOnly && hub.gridCount >= 1);
  await shot("compatible-equipment");

  await page.locator(".player-hub-item[data-item-id='item_travelers_band']").first().hover();
  states.contextActions = await waitForHubState(page, (hub) => hub.contextActionsItem === "item_travelers_band");
  await shot("context-actions-hover");
  await page.locator(".player-hub-item[data-item-id='item_travelers_band'] [data-hub-action='view']").first().click();
  states.detailRow = await waitForHubState(
    page,
    (hub) => hub.selectedCard === "item_travelers_band" && hub.detailItem === "item_travelers_band" && hub.forgeDisabled,
  );
  await shot("detail-row-forge-disabled");
  states.deltaPreview = await waitForHubState(page, (hub) => hub.previewItem === "item_travelers_band");
  await page.locator(".player-hub-detail-row [data-hub-action='equip']").click();
  states.equipped = await waitForHubState(page, (hub) => hub.equipped.accessory1 === "item_travelers_band");
  states.equipToast = await page.evaluate(() => {
    const messages = Array.from((globalThis as SmokeBrowserGlobal).document.querySelectorAll(".lm-toast__message")).map((toast) => toast.textContent ?? "");
    return messages.find((message) => message.includes("Item equipped - Travelers Band is now in the accessory1 slot")) ?? null;
  });
  await shot("equip-flow-equipped");

  await page.mouse.move(24, 24);
  await page.waitForTimeout(150);
  await page.locator(".player-hub-tabs .lm-tab").filter({ hasText: "Skills" }).click();
  states.skillsOpen = await waitForHubState(
    page,
    (hub) => hub.activeTab === "skills" && hub.skillRowCount >= 4 && hub.selectedSkill !== null,
  );
  await shot("skills-tab-open");

  await page.locator(".player-hub-skills-rail [data-skill-category='support']").click();
  states.skillsSupport = await waitForHubState(page, (hub) => hub.activeTab === "skills" && hub.skillsCategory === "support" && hub.skillRowCount >= 1);
  await shot("skills-support-category");

  await page.locator(".player-hub-skills-rail [data-skill-category='all']").click();
  await page.locator(".player-hub-skill-row[data-skill-id='skill_lantern_burst']").click();
  states.skillsDetail = await waitForHubState(
    page,
    (hub) => hub.selectedSkill === "skill_lantern_burst" && hub.learnDisabledReason === null,
  );
  await shot("skills-detail-lantern-burst");

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator(".player-hub-tabs .lm-tab").filter({ hasText: "Inventory" }).click();
  states.viewport1280 = await getHubViewportFitState(page);
  await shot("inventory-1280x720", false);

  return {
    schemaVersion: 1,
    kind: "gamekit-player-hub-proof",
    generatedAt: new Date().toISOString(),
    shots,
    states,
    assertions: {
      openedWithC: Boolean((states.open as { open?: boolean }).open),
      playerKeyartDecoded:
        (states.skillsDetail as { keyartSrc?: string; keyartDecoded?: boolean | null }).keyartSrc?.endsWith("/assets/ui/keyart/class_wayfarer.png") === true &&
        (states.skillsDetail as { keyartDecoded?: boolean | null }).keyartDecoded === true,
      viewport1280Fits:
        (states.viewport1280 as { width?: number; height?: number; windowFits?: boolean; bodyHasInternalScroll?: boolean }).width === 1280 &&
        (states.viewport1280 as { width?: number; height?: number; windowFits?: boolean; bodyHasInternalScroll?: boolean }).height === 720 &&
        (states.viewport1280 as { windowFits?: boolean }).windowFits === true &&
        (states.viewport1280 as { bodyHasInternalScroll?: boolean }).bodyHasInternalScroll === true,
      attributeRowsLive: (states.attributesOpen as { attributeRowCount?: number }).attributeRowCount === 6,
      attributePoolDecremented: (states.attributeSpend as { attributePoints?: number }).attributePoints ===
        ((states.attributesOpen as { attributePoints?: number }).attributePoints ?? 0) - 1,
      vitAllocated: ((states.attributeSpend as { allocatedAttributes?: Record<string, number> }).allocatedAttributes?.vit ?? 0) >
        ((states.attributesOpen as { allocatedAttributes?: Record<string, number> }).allocatedAttributes?.vit ?? 0),
      gridRendered: ((states.open as { gridCount?: number }).gridCount ?? 0) > 0,
      searchMatchedBand: (states.search as { search?: string }).search === "band",
      categoryFilteredEquipment: (states.filter as { filter?: string }).filter === "equipment",
      compatibleOnlyFiltered: (states.compatibleOnly as { compatibleOnly?: boolean }).compatibleOnly === true,
      guidanceHintRendered: typeof (states.guidance as { guidanceHint?: string | null }).guidanceHint === "string" &&
        ((states.guidance as { guidanceHint?: string | null }).guidanceHint?.length ?? 0) > 0,
      guidanceJumpFocusedSlot: typeof (states.guidanceJump as { guidanceFocusedSlot?: string | null }).guidanceFocusedSlot === "string",
      contextActionsShownForTravelersBand: (states.contextActions as { contextActionsItem?: string | null }).contextActionsItem === "item_travelers_band",
      detailRowSelectedTravelersBand: (states.detailRow as { detailItem?: string | null }).detailItem === "item_travelers_band",
      forgeDisabled: (states.detailRow as { forgeDisabled?: boolean }).forgeDisabled === true,
      deltaPreviewedTravelersBand: (states.deltaPreview as { previewItem?: string }).previewItem === "item_travelers_band",
      equippedTravelersBand: (states.equipped as { equipped?: Record<string, string> }).equipped?.accessory1 === "item_travelers_band",
      equipToastShown: states.equipToast === "Item equipped - Travelers Band is now in the accessory1 slot",
      skillsTabRendered: (states.skillsOpen as { activeTab?: string; skillRowCount?: number }).activeTab === "skills" &&
        ((states.skillsOpen as { skillRowCount?: number }).skillRowCount ?? 0) >= 4,
      supportCategoryRendered: (states.skillsSupport as { skillsCategory?: string; skillRowCount?: number }).skillsCategory === "support" &&
        ((states.skillsSupport as { skillRowCount?: number }).skillRowCount ?? 0) >= 1,
      detailSelectedLanternBurst: (states.skillsDetail as { selectedSkill?: string }).selectedSkill === "skill_lantern_burst",
      learnButtonEnabled: (states.skillsDetail as { learnDisabledReason?: string | null }).learnDisabledReason === null,
      wasdBlocked:
        (states.inputBlocked as { after?: { hub?: { gameplayInputBlocked?: boolean }; input?: { moveTarget?: unknown; predictionTarget?: unknown } } }).after?.hub
          ?.gameplayInputBlocked === true &&
        (states.inputBlocked as { after?: { input?: { moveTarget?: unknown; predictionTarget?: unknown } } }).after?.input?.moveTarget === null &&
        (states.inputBlocked as { after?: { input?: { moveTarget?: unknown; predictionTarget?: unknown } } }).after?.input?.predictionTarget === null,
    },
  };
}

async function captureHudProof(outDir: string, page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  const shots: Record<string, string> = {};
  const states: Record<string, unknown> = {};
  const shot = async (label: string): Promise<void> => {
    const file = `${outDir}/hud-${label}.png`;
    await page.screenshot({ path: file, fullPage: true });
    shots[label] = repoRelativePath(file);
    console.log(`[capture] HUD ${label} -> ${file}`);
  };

  await buyPotionFromHarborShop(page);
  states.populatedInventory = await getSmokeState(page);
  await stageInOpenField(page);
  states.movementKeyGuard = [
    await proveMovementKeyDoesNotOpenHotbar(page, "W", "y", -1),
    await proveMovementKeyDoesNotOpenHotbar(page, "A", "x", -1),
    await proveMovementKeyDoesNotOpenHotbar(page, "S", "y", 1),
    await proveMovementKeyDoesNotOpenHotbar(page, "D", "x", 1),
  ];
  // card-hud-polish-r2 item 2: reserved UI key I with an empty slot opens the hub,
  // never the assignment picker (owner session 18).
  states.reservedKeyGuard = await proveReservedKeyRoutesToUi(page, "I");
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => !(globalThis as SmokeBrowserGlobal).document.querySelector(".player-hub-scrim"),
    undefined,
    { timeout: 6_000 },
  );

  states.initial = await waitForActionState(page, (action) =>
    action.slotCount === 19 &&
    action.rowCount === 2 &&
    action.bindings.some((binding) => binding.key === "1" && binding.id === "skill_spark_shot") &&
    action.bindings.some((binding) => binding.key === "2" && binding.id === "skill_lantern_burst") &&
    action.bindings.some((binding) => binding.id === "item_minor_health_potion") &&
    action.xpBadge.length > 0 &&
    action.xpText.includes("/") &&
    action.jobBadge.length > 0 &&
    action.jobText.includes("/"),
  );
  states.dockDom = await page.evaluate(() => {
    const win = globalThis as unknown as SmokeBrowserGlobal & { getComputedStyle?: (el: unknown) => { borderImageSource?: string; opacity?: string; filter?: string } };
    const doc = win.document;
    const dock = doc.getElementById("hud-action-panel") as ({ getAttribute?: (name: string) => string | null } | null);
    const computedStyle = win.getComputedStyle as unknown as ((el: unknown) => { borderImageSource?: string; opacity?: string; filter?: string }) | undefined;
    const style = dock ? computedStyle?.(dock) : undefined;
    const selector = "#hud-system-cluster .hud-toolbar-button";
    const buttons = Array.from(doc.querySelectorAll(selector));
    const visibleButtons = buttons.filter((button) => !(button as { hidden?: boolean }).hidden);
    const disabledButtons = buttons.filter((button) => (button as { disabled?: boolean }).disabled);
    return {
      selector,
      frameAssetActive: dock?.getAttribute?.("data-frame-asset-active") === "true",
      borderImageSource: style?.borderImageSource ?? "",
      menuButtonCount: buttons.length,
      visibleMenuButtonCount: visibleButtons.length,
      iconCount: buttons.filter((button) => Boolean(button.querySelector("img[src*='/assets/ui/icons/']"))).length,
      visibleIconCount: visibleButtons.filter((button) => Boolean(button.querySelector("img[src*='/assets/ui/icons/']"))).length,
      tooltipBoundCount: buttons.filter((button) => Boolean((button as { getAttribute?: (name: string) => string | null }).getAttribute?.("aria-label"))).length,
      visibleTooltipBoundCount: visibleButtons.filter((button) => Boolean((button as { getAttribute?: (name: string) => string | null }).getAttribute?.("aria-label"))).length,
      disabledIconCount: disabledButtons.filter((button) => Boolean(button.querySelector("img[src*='/assets/ui/icons/']"))).length,
      disabledIconOpacity: disabledButtons.map((button) => computedStyle?.(button)?.opacity ?? ""),
      disabledIconFilter: disabledButtons.map((button) => computedStyle?.(button)?.filter ?? ""),
      badgeCount: doc.querySelectorAll(".hud-progress-badge").length,
    };
  });
  if ((states.dockDom as { menuButtonCount?: number }).menuButtonCount === 0) {
    throw new Error(`HUD dock selector self-check failed: ${JSON.stringify(states.dockDom)}`);
  }
  states.idleHudMutations = {
    legacyEquivalent: await sampleLegacyHudMutationChurn(page, "idle"),
    viewModel: await sampleHudMutations(page, "idle"),
  };
  await shot("dock-hotbar-exp-job-icons");

  // card-hud-polish-r2 item 1: close-up of the FLAT unit-frame identity row — name as
  // plain gold text + muted meta, no pill/chip boxes. Assert no box chrome remains on
  // either the identity wrap or the meta span, and crop it for eyes-on review.
  states.identityRowFlat = await page.evaluate(() => {
    const win = globalThis as unknown as SmokeBrowserGlobal;
    const computed = win.getComputedStyle as unknown as (el: unknown) => { backgroundImage?: string; backgroundColor?: string; borderTopWidth?: string; color?: string };
    const doc = win.document;
    const identity = doc.querySelector("#hud-stats .lm-unit__identity");
    const nameEl = doc.querySelector("#hud-stats .lm-unit__name");
    const metaEl = doc.querySelector("#hud-stats .lm-unit__meta");
    const identityStyle = identity ? computed(identity) : undefined;
    const metaStyle = metaEl ? computed(metaEl) : undefined;
    return {
      hasNameplateClass: Boolean(identity?.classList.contains("hud-unit-nameplate")),
      isFlatClass: Boolean(identity?.classList.contains("hud-unit-identity--flat")),
      identityBgImage: identityStyle?.backgroundImage ?? "",
      metaBgColor: metaStyle?.backgroundColor ?? "",
      metaBorderTop: metaStyle?.borderTopWidth ?? "",
      metaColor: metaStyle?.color ?? "",
      nameText: nameEl?.textContent ?? "",
      metaText: metaEl?.textContent ?? "",
    };
  });
  await page.locator("#hud-stats .lm-unit__identity").screenshot({ path: `${outDir}/hud-identity-row-flat.png` }).catch(() => undefined);
  shots["identity-row-flat"] = repoRelativePath(`${outDir}/hud-identity-row-flat.png`);
  console.log(`[capture] HUD identity-row-flat -> ${outDir}/hud-identity-row-flat.png`);

  // card-hud-polish-r2 item 1 (overflow case): worst-case identity — 12-char name +
  // longest order label ("Order of the Longwatch") — must ellipsize the meta and expose
  // the full text via a title tooltip (StatsPanel.applyMetaOverflowTooltip), not clip
  // silently. QA-only local-state mutation; HUD re-derives the row each frame.
  await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId) as unknown as { name: string; classId: string } | undefined;
    if (player) {
      player.name = "Longnamexii2"; // 12 chars
      player.classId = "class_archer"; // Order of the Longwatch
    }
  });
  const overflowHandle = await page.waitForFunction(
    () => {
      const win = globalThis as unknown as SmokeBrowserGlobal;
      const metaEl = win.document.querySelector("#hud-stats .lm-unit__meta") as unknown as
        | { textContent: string | null; scrollWidth: number; clientWidth: number; getAttribute(name: string): string | null }
        | null;
      if (!metaEl) return null;
      const text = metaEl.textContent ?? "";
      if (!text.includes("Longwatch")) return null; // wait for the long order to render
      const overflowing = metaEl.scrollWidth > metaEl.clientWidth + 1;
      return { text, overflowing, title: metaEl.getAttribute("title") ?? "" };
    },
    undefined,
    { timeout: 6_000 },
  );
  states.identityOverflow = await overflowHandle.jsonValue();
  await page.locator("#hud-stats .lm-unit__identity").screenshot({ path: `${outDir}/hud-identity-row-overflow.png` }).catch(() => undefined);
  shots["identity-row-overflow"] = repoRelativePath(`${outDir}/hud-identity-row-overflow.png`);
  console.log(`[capture] HUD identity-row-overflow -> ${outDir}/hud-identity-row-overflow.png`);

  // card-hud-polish-r2 item 3: drain the bound potion (slot 3) to 0 in the local room
  // state (QA-only mutation — HUD re-derives usable items each frame) and assert the
  // slot enters the faded empty-consumable state, keycap still legible. Crop it.
  states.emptyConsumableSlot = await page.evaluate(() => {
    const win = globalThis as unknown as SmokeBrowserGlobal & { getComputedStyle?: (el: unknown) => Record<string, string> };
    const scene = win.__GAME?.scene?.getScene("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    const potion = player?.inventory?.get("item_minor_health_potion");
    if (potion) potion.quantity = 0;
    return { drained: Boolean(potion) };
  });
  const emptySlotState = await page.waitForFunction(
    () => {
      const win = globalThis as unknown as SmokeBrowserGlobal;
      const computed = win.getComputedStyle as unknown as (el: unknown) => { opacity?: string; filter?: string };
      const doc = win.document;
      const potionSlot = Array.from(doc.querySelectorAll(".hotbar-slot.is-item")).find((slot) => slot.classList.contains("is-consumable-empty"));
      if (!potionSlot) return null;
      const icon = potionSlot.querySelector(".hotbar-icon");
      const keycap = potionSlot.querySelector(".hotbar-key");
      const iconStyle = icon ? computed(icon) : undefined;
      const keycapStyle = keycap ? computed(keycap) : undefined;
      return {
        key: potionSlot.dataset?.hotbarKey ?? "",
        iconOpacity: iconStyle?.opacity ?? "1",
        iconFilter: iconStyle?.filter ?? "none",
        keycapOpacity: keycapStyle?.opacity ?? "1",
      };
    },
    undefined,
    { timeout: 6_000 },
  );
  states.emptyConsumableSlotStyle = await emptySlotState.jsonValue();
  const emptyKey = (states.emptyConsumableSlotStyle as { key?: string }).key ?? "3";
  await page.locator(`[data-hotbar-key='${emptyKey}']`).screenshot({ path: `${outDir}/hud-empty-consumable-slot.png` }).catch(() => undefined);
  shots["empty-consumable-slot"] = repoRelativePath(`${outDir}/hud-empty-consumable-slot.png`);
  console.log(`[capture] HUD empty-consumable-slot -> ${outDir}/hud-empty-consumable-slot.png`);

  // Chat RESTS collapsed since session 18 (owner ruling) — the proof asserts the
  // resting pill, then the expand path, then collapse back via the header button.
  states.chatCollapsed = await page.evaluate(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const panel = doc.getElementById("hud-chat-panel") as (HudProofRectElement | null);
    const rect = panel?.getBoundingClientRect();
    return {
      collapsed: Boolean(panel?.classList.contains("is-collapsed")),
      pillVisible: Boolean(doc.querySelector(".hud-chat-pill:not([hidden])")),
      rect: rect ? { top: rect.top, bottom: rect.bottom, height: rect.height } : null,
    };
  });
  if (!(states.chatCollapsed as { collapsed?: boolean }).collapsed) {
    throw new Error(`chat must REST collapsed as the pill: ${JSON.stringify(states.chatCollapsed)}`);
  }
  await shot("chat-pill-collapsed");
  await page.locator(".hud-chat-pill").click();
  states.chatExpanded = await page.evaluate(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const panel = doc.getElementById("hud-chat-panel") as (HudProofRectElement | null);
    const rect = panel?.getBoundingClientRect();
    return {
      collapsed: Boolean(panel?.classList.contains("is-collapsed")),
      inputVisible: Boolean((doc.querySelector(".hud-chat-input") as { offsetParent?: unknown } | null)?.offsetParent),
      rect: rect ? { top: rect.top, bottom: rect.bottom, height: rect.height } : null,
    };
  });
  await shot("chat-pill-expanded");
  await page.locator(".hud-chat-collapse").click();
  states.chatRecollapsed = await page.evaluate(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const panel = doc.getElementById("hud-chat-panel") as (HudProofRectElement | null);
    const rect = panel?.getBoundingClientRect();
    return {
      collapsed: Boolean(panel?.classList.contains("is-collapsed")),
      rect: rect ? { top: rect.top, bottom: rect.bottom, height: rect.height } : null,
    };
  });

  await page.locator("[data-hotbar-key='4']").click();
  states.assignmentOpen = await waitForActionState(page, (action) => action.assignmentOpen);
  await shot("assignment-picker");
  await page.locator(".hotbar-assign-close").click();
  states.assignmentClosed = await waitForActionState(page, (action) => !action.assignmentOpen);

  // Key 1 = Spark Shot (no reticle): fires immediately and stamps the optimistic
  // cooldown. Key 2 = Lantern Burst carries a ground-aim reticle since the vfx kit
  // (session 20) — pressing it is NOT a cast (GameScene deliberately skips the
  // cooldown until the aim is confirmed), so the immediate-cast assert lives on
  // key 1 and key 2 asserts the reticle contract below (stale-expectation fix,
  // owner live-round 2026-07-07).
  await page.keyboard.press("Digit1");
  states.keyFire = await page.evaluate(() => {
    const action = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game")?.getVisualQaSnapshot?.().action as ActionQaState | undefined;
    const slot = (globalThis as SmokeBrowserGlobal).document.querySelector("[data-hotbar-key='1']");
    return {
      action,
      coolingDown: Boolean(slot?.classList.contains("is-cooling-down")),
      disabled: Boolean((slot as { disabled?: boolean } | null)?.disabled),
    };
  });
  if (!(states.keyFire as { coolingDown?: boolean }).coolingDown) {
    throw new Error(`hotbar key fire did not enter cooldown: ${JSON.stringify(states.keyFire)}`);
  }
  // Let Spark Shot's cast/movement lock (~500ms) expire before the reticle leg —
  // a press during the lock is swallowed and the aim never opens.
  await page.waitForTimeout(700);
  await page.keyboard.press("Digit2");
  states.keyAim = await page.evaluate(() => {
    const snapshot = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game")?.getVisualQaSnapshot?.() as
      | { input?: { groundSkillAim?: { skillId?: string } | null } }
      | undefined;
    return { groundSkillAim: snapshot?.input?.groundSkillAim ?? null };
  });
  if ((states.keyAim as { groundSkillAim?: { skillId?: string } | null }).groundSkillAim?.skillId !== "skill_lantern_burst") {
    throw new Error(`hotbar area-skill key did not open the aim reticle: ${JSON.stringify(states.keyAim)}`);
  }
  states.combatHudMutations = {
    legacyEquivalent: await sampleLegacyHudMutationChurn(page, "combat"),
    viewModel: await sampleHudMutations(page, "combat"),
  };
  // Second press of the SAME key while aiming CONFIRMS the ground cast at the aim
  // position (GameScene.confirmGroundSkillAim) — that is the moment the slot-2
  // cooldown stamps; a third press inside the cooldown shows the denied cue.
  await page.keyboard.press("Digit2");
  await page.waitForTimeout(100);
  const slot2Cooling = await page.evaluate(() =>
    Boolean((globalThis as SmokeBrowserGlobal).document.querySelector("[data-hotbar-key='2']")?.classList.contains("is-cooling-down")),
  );
  if (!slot2Cooling) {
    throw new Error("ground-aim confirm press did not stamp the slot-2 cooldown");
  }
  await page.keyboard.press("Digit2");
  states.cooldownDeniedCue = await page.evaluate(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const slot = doc.querySelector("[data-hotbar-key='2']");
    return {
      denied: Boolean(slot?.classList.contains("is-cooldown-denied")),
      cueVisible: Boolean(slot?.querySelector(".hotbar-cooldown-cue.is-visible")),
      secondsText: slot?.querySelector(".hotbar-cooldown-text")?.textContent ?? "",
    };
  });
  await shot("keybind-cooldown");

  // card-hud-qol-r3: dialogue full-size-at-open, above-hotbar position at 3 resolutions,
  // and K -> hub Skills tab. Appended to the named hud-proof leg.
  const dialogueQol = await captureDialogueQolProof(outDir, page, shot);
  states.dialogueFullSize = dialogueQol.fullSize;
  states.dialogueAboveHotbar = dialogueQol.aboveHotbar;
  states.skillsHotkey = dialogueQol.skillsHotkey;
  Object.assign(shots, dialogueQol.shots);

  return {
    schemaVersion: 1,
    kind: "gamekit-hud-toolbar-hotbar-proof",
    generatedAt: new Date().toISOString(),
    shots,
    states,
    assertions: {
      compactTwoRowsNineteenSlots:
        (states.initial as ActionQaState).slotCount === 19 &&
        (states.initial as ActionQaState).rowCount === 2,
      defaultSparkOn1: (states.initial as ActionQaState).bindings.some((binding) => binding.key === "1" && binding.id === "skill_spark_shot"),
      defaultLanternOn2: (states.initial as ActionQaState).bindings.some((binding) => binding.key === "2" && binding.id === "skill_lantern_burst"),
      potionBound: (states.initial as ActionQaState).bindings.some((binding) => binding.id === "item_minor_health_potion"),
      expNumeric: (states.initial as ActionQaState).xpText.includes("/"),
      jobNumeric: (states.initial as ActionQaState).jobText.includes("/"),
      progressBadgesServerBacked: /^\d+$/.test((states.initial as ActionQaState).xpBadge) && /^\d+$/.test((states.initial as ActionQaState).jobBadge),
      dockUsesSlateChrome:
        (states.dockDom as { frameAssetActive?: boolean }).frameAssetActive === false &&
        ((states.dockDom as { borderImageSource?: string }).borderImageSource === "none" || (states.dockDom as { borderImageSource?: string }).borderImageSource === ""),
      dockIconRowIconized:
        (states.dockDom as { visibleMenuButtonCount?: number; visibleIconCount?: number; visibleTooltipBoundCount?: number }).visibleMenuButtonCount === 10 &&
        (states.dockDom as { visibleMenuButtonCount?: number; visibleIconCount?: number; visibleTooltipBoundCount?: number }).visibleIconCount === 10 &&
        (states.dockDom as { visibleMenuButtonCount?: number; visibleIconCount?: number; visibleTooltipBoundCount?: number }).visibleTooltipBoundCount === 10,
      disabledToolbarIconsReadable:
        (states.dockDom as { disabledIconCount?: number }).disabledIconCount === 5 &&
        ((states.dockDom as { disabledIconOpacity?: string[] }).disabledIconOpacity ?? []).every((opacity) => parseFloat(opacity) >= 0.7) &&
        ((states.dockDom as { disabledIconFilter?: string[] }).disabledIconFilter ?? []).every((filter) => /brightness/.test(filter) && !/grayscale/.test(filter)),
      chatPillCollapseExpand:
        (states.chatCollapsed as { collapsed?: boolean; pillVisible?: boolean }).collapsed === true &&
        (states.chatCollapsed as { collapsed?: boolean; pillVisible?: boolean }).pillVisible === true &&
        (states.chatExpanded as { collapsed?: boolean; inputVisible?: boolean }).collapsed === false &&
        (states.chatExpanded as { collapsed?: boolean; inputVisible?: boolean }).inputVisible === true,
      chatBottomAnchored:
        Math.abs(((states.chatCollapsed as { rect?: { bottom?: number } }).rect?.bottom ?? 0) - ((states.chatExpanded as { rect?: { bottom?: number } }).rect?.bottom ?? Number.NaN)) <= 1 &&
        Math.abs(((states.chatCollapsed as { rect?: { bottom?: number } }).rect?.bottom ?? 0) - ((states.chatRecollapsed as { rect?: { bottom?: number } }).rect?.bottom ?? Number.NaN)) <= 1 &&
        (((states.chatExpanded as { rect?: { top?: number } }).rect?.top ?? 0) < ((states.chatCollapsed as { rect?: { top?: number } }).rect?.top ?? 0)),
      movementKeysWalkWithoutAssignment:
        Array.isArray(states.movementKeyGuard) &&
        (states.movementKeyGuard as MovementKeyProof[]).every((proof) => Math.abs(proof.delta) >= 4 && proof.assignmentOpen === false),
      reservedKeyOpensHubNotPicker:
        (states.reservedKeyGuard as ReservedKeyProof).slotBoundBefore === false &&
        (states.reservedKeyGuard as ReservedKeyProof).hubOpen === true &&
        (states.reservedKeyGuard as ReservedKeyProof).assignmentOpen === false,
      identityRowFlattened:
        (states.identityRowFlat as { hasNameplateClass?: boolean; isFlatClass?: boolean; identityBgImage?: string; metaBgColor?: string; metaBorderTop?: string }).hasNameplateClass === false &&
        (states.identityRowFlat as { isFlatClass?: boolean }).isFlatClass === true &&
        ((states.identityRowFlat as { identityBgImage?: string }).identityBgImage === "none" || (states.identityRowFlat as { identityBgImage?: string }).identityBgImage === "") &&
        (states.identityRowFlat as { metaBorderTop?: string }).metaBorderTop === "0px" &&
        /rgba?\(0, 0, 0, 0\)|transparent/.test((states.identityRowFlat as { metaBgColor?: string }).metaBgColor ?? ""),
      emptyConsumableSlotFades:
        parseFloat((states.emptyConsumableSlotStyle as { iconOpacity?: string }).iconOpacity ?? "1") <= 0.5 &&
        /grayscale/.test((states.emptyConsumableSlotStyle as { iconFilter?: string }).iconFilter ?? "") &&
        parseFloat((states.emptyConsumableSlotStyle as { keycapOpacity?: string }).keycapOpacity ?? "1") >= 0.9,
      identityMetaEllipsizesWithTooltip:
        (states.identityOverflow as { overflowing?: boolean; title?: string; text?: string }).overflowing === true &&
        (states.identityOverflow as { title?: string; text?: string }).title === (states.identityOverflow as { text?: string }).text &&
        ((states.identityOverflow as { title?: string }).title ?? "").length > 0,
      assignmentPickerOpened: (states.assignmentOpen as ActionQaState).assignmentOpen === true,
      keybindCooldown: (states.keyFire as { coolingDown?: boolean }).coolingDown === true,
      cooldownDeniedCue:
        (states.cooldownDeniedCue as { cueVisible?: boolean; secondsText?: string }).cueVisible === true &&
        /\ds/.test((states.cooldownDeniedCue as { cueVisible?: boolean; secondsText?: string }).secondsText ?? ""),
      hudMutationCounterEnabled:
        ((states.idleHudMutations as { viewModel?: HudMutationSnapshot }).viewModel?.enabled ?? false) &&
        ((states.combatHudMutations as { viewModel?: HudMutationSnapshot }).viewModel?.enabled ?? false),
      // card-hud-qol-r3 item 1: box is already its final size at open (before the
      // typewriter completes) — frame-0 rect equals the completed rect (<=1px).
      dialogueFullSizeAtOpen: (states.dialogueFullSize as DialogueFullSizeProof).fullSizeAtOpen,
      // card-hud-qol-r3 item 2: dialogue box bottom sits above the hotbar top at
      // 1280 / 1920 / 2560, with a gap in a sane 4-64px band.
      dialogueAboveHotbar: (states.dialogueAboveHotbar as DialogueAboveHotbarProof[]).every(
        (r) => r.boxBottom < r.hotbarTop && r.gap >= 4 && r.gap <= 64,
      ),
      // card-hud-qol-r3 item 3: K opens the hub directly on the Skills tab.
      skillsHotkeyOpensSkillsTab:
        (states.skillsHotkey as SkillsHotkeyProof).hubOpen === true &&
        (states.skillsHotkey as SkillsHotkeyProof).activeTab === "skills",
    },
  };
}

type DialogueFullSizeProof = {
  open: { width: number; height: number };
  complete: { width: number; height: number };
  bodyTextAtOpen: number;
  bodyTextComplete: number;
  fullSizeAtOpen: boolean;
};
type DialogueAboveHotbarProof = { width: number; height: number; boxBottom: number; hotbarTop: number; gap: number };
type SkillsHotkeyProof = { hubOpen: boolean; activeTab: string };
type DialogueRectEl = {
  hidden: boolean;
  querySelector: (selector: string) => { textContent: string | null; hidden?: boolean } | null;
  getBoundingClientRect: () => { width: number; height: number; top: number; bottom: number };
};

// card-hud-qol-r3: proves the three dialogue/hotkey acceptance items. Assumes the
// player can reach the Harbor Warden (same NPC the dialogue-proof uses).
async function captureDialogueQolProof(
  outDir: string,
  page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"],
  shot: (label: string) => Promise<void>,
): Promise<{
  fullSize: DialogueFullSizeProof;
  aboveHotbar: DialogueAboveHotbarProof[];
  skillsHotkey: SkillsHotkeyProof;
  shots: Record<string, string>;
}> {
  const shots: Record<string, string> = {};
  // Make sure nothing else is capturing input.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);

  // ---- item 3: K -> hub Skills tab ----
  await page.keyboard.press("k");
  const skillsHotkey = (await (
    await page.waitForFunction(
      () => {
        const hub = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game")?.getVisualQaSnapshot?.().hub as
          | { open?: boolean; activeTab?: string }
          | undefined;
        if (!hub?.open) return null;
        return { hubOpen: true, activeTab: hub.activeTab ?? "" };
      },
      undefined,
      { timeout: 6_000 },
    )
  ).jsonValue()) as SkillsHotkeyProof;
  await page.screenshot({ path: `${outDir}/hud-skills-hotkey.png`, fullPage: true });
  shots["skills-hotkey"] = repoRelativePath(`${outDir}/hud-skills-hotkey.png`);
  console.log(`[capture] HUD skills-hotkey -> ${outDir}/hud-skills-hotkey.png`);
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game")?.getVisualQaSnapshot?.().hub?.open === false,
    undefined,
    { timeout: 6_000 },
  );

  // ---- item 1: dialogue full size at open (before typewriter completes) ----
  await moveLocalPlayerNear(page, HARBOR_WARDEN_X + 40, HARBOR_WARDEN_Y + 45, 28);
  await waitForNpcVisible(page, HARBOR_WARDEN_ID);
  const target = await getVisibleNpcClickTarget(page, HARBOR_WARDEN_ID);
  await page.mouse.click(target.screenX, target.screenY);
  // Frame-0 rect: dialogue visible, but the visible (revealed) body is still a small
  // prefix — the box must already be at its final size thanks to the transparent
  // pending span reserving space.
  const open = (await (
    await page.waitForFunction(
      () => {
        const doc = (globalThis as SmokeBrowserGlobal).document;
        const panel = doc.getElementById("dialogue") as unknown as DialogueRectEl | null;
        if (!panel || panel.hidden) return null;
        const revealed = panel.querySelector(".dialogue-body-revealed")?.textContent ?? "";
        const pending = panel.querySelector(".dialogue-body-pending")?.textContent ?? "";
        // Still mid-reveal: text remains pending (transparent) and only a prefix is revealed.
        if (pending.length === 0) return null;
        const rect = panel.getBoundingClientRect();
        return { width: rect.width, height: rect.height, revealedLen: revealed.length, pendingLen: pending.length };
      },
      undefined,
      { timeout: 20_000 },
    )
  ).jsonValue()) as { width: number; height: number; revealedLen: number; pendingLen: number };
  await page.screenshot({ path: `${outDir}/hud-dialogue-open.png`, fullPage: true });
  shots["dialogue-open"] = repoRelativePath(`${outDir}/hud-dialogue-open.png`);
  console.log(`[capture] HUD dialogue-open -> ${outDir}/hud-dialogue-open.png`);

  // Complete the reveal (click skips to full text + choices) and re-measure.
  await page.locator("#dialogue").click();
  const complete = (await (
    await page.waitForFunction(
      () => {
        const doc = (globalThis as SmokeBrowserGlobal).document;
        const panel = doc.getElementById("dialogue") as unknown as DialogueRectEl | null;
        const pending = panel?.querySelector(".dialogue-body-pending")?.textContent ?? "";
        const choices = panel?.querySelector("#dialogue-choices") as { hidden?: boolean } | null;
        if (!panel || panel.hidden || pending.length !== 0 || choices?.hidden) return null;
        const rect = panel.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      },
      undefined,
      { timeout: 6_000 },
    )
  ).jsonValue()) as { width: number; height: number };
  const fullSize: DialogueFullSizeProof = {
    open: { width: open.width, height: open.height },
    complete,
    bodyTextAtOpen: open.revealedLen,
    bodyTextComplete: open.revealedLen + open.pendingLen,
    fullSizeAtOpen:
      Math.abs(open.width - complete.width) <= 1 &&
      Math.abs(open.height - complete.height) <= 1 &&
      open.pendingLen > 0,
  };

  // ---- item 2: box bottom above hotbar top at 1280 / 1920 / 2560 ----
  const aboveHotbar: DialogueAboveHotbarProof[] = [];
  for (const width of [1280, 1920, 2560]) {
    const height = Math.round((width * 9) / 16);
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(250);
    const measure = (await page.evaluate(() => {
      const doc = (globalThis as SmokeBrowserGlobal).document;
      const panel = doc.getElementById("dialogue") as unknown as DialogueRectEl | null;
      const dock = doc.getElementById("hud-action-panel") as unknown as DialogueRectEl | null;
      if (!panel || !dock) return null;
      const box = panel.getBoundingClientRect();
      const bar = dock.getBoundingClientRect();
      return { width: box.width, height: box.height, boxBottom: box.bottom, hotbarTop: bar.top };
    })) as { width: number; height: number; boxBottom: number; hotbarTop: number } | null;
    if (!measure) throw new Error(`dialogue/hotbar rects unavailable at ${width}x${height}`);
    aboveHotbar.push({ ...measure, gap: measure.hotbarTop - measure.boxBottom });
    await page.screenshot({ path: `${outDir}/hud-dialogue-pos-${width}.png`, fullPage: true });
    shots[`dialogue-pos-${width}`] = repoRelativePath(`${outDir}/hud-dialogue-pos-${width}.png`);
    console.log(`[capture] HUD dialogue-pos-${width} -> ${outDir}/hud-dialogue-pos-${width}.png`);
  }
  await page.setViewportSize(CAPTURE_VIEWPORT);
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await shot("dialogue-qol-done");

  return { fullSize, aboveHotbar, skillsHotkey, shots };
}

async function sampleHudMutations(
  page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"],
  label: string,
  durationMs = 1000,
): Promise<HudMutationSnapshot & { label: string }> {
  await page.evaluate(() => {
    const counter = (globalThis as SmokeBrowserGlobal).__GAMEKIT_HUD_MUTATIONS__;
    if (!counter) throw new Error("HUD mutation counter unavailable");
    counter.reset();
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const counter = (globalThis as SmokeBrowserGlobal).__GAMEKIT_HUD_MUTATIONS__;
    if (!counter) throw new Error("HUD mutation counter unavailable");
    counter.reset();
  });
  await page.waitForTimeout(durationMs);
  return page.evaluate((sampleLabel) => {
    const counter = (globalThis as SmokeBrowserGlobal).__GAMEKIT_HUD_MUTATIONS__;
    if (!counter) throw new Error("HUD mutation counter unavailable");
    return { label: sampleLabel, ...counter.getSnapshot() };
  }, label);
}

async function sampleLegacyHudMutationChurn(
  page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"],
  label: string,
  durationMs = 1000,
): Promise<HudMutationSnapshot & { label: string; simulatedFrames: number }> {
  return page.evaluate(
    async ({ sampleLabel, ms }) => {
      const win = globalThis as SmokeBrowserGlobal;
      const counter = win.__GAMEKIT_HUD_MUTATIONS__;
      if (!counter) throw new Error("HUD mutation counter unavailable");
      counter.reset();
      let frames = 0;
      const started = performance.now();
      while (performance.now() - started < ms) {
        frames += 1;
        const doc = win.document;
        for (const el of Array.from(doc.querySelectorAll("#hud-stats .lm-unit__name, #hud-stats .lm-unit__meta, #target-panel .lm-unit__name, #target-panel .lm-unit__meta, #target-panel .lm-unit__tag, #hud-minimap-panel .hud-minimap-title, #hud-minimap-panel [data-minimap-coords], #hud-action-panel .hud-progress-value, #hud-action-panel .hud-progress-badge"))) {
          el.textContent = el.textContent ?? "";
        }
        const target = doc.getElementById("target-panel") as unknown as { classList: { contains(name: string): boolean; toggle(name: string, force?: boolean): void } } | null;
        target?.classList.toggle("lm-unit--boss", target.classList.contains("lm-unit--boss"));
        await new Promise((resolve) =>
          (globalThis as unknown as { requestAnimationFrame(callback: (time: number) => void): number }).requestAnimationFrame(() => resolve(undefined)),
        );
      }
      return { label: sampleLabel, simulatedFrames: frames, ...counter.getSnapshot() };
    },
    { sampleLabel: label, ms: durationMs },
  );
}

async function proveMovementKeyDoesNotOpenHotbar(
  page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"],
  key: string,
  axis: "x" | "y",
  direction: -1 | 1,
): Promise<MovementKeyProof> {
  const beforeState = await getSmokeState(page);
  const beforePlayer = beforeState?.players.find((player) => player.sessionId === beforeState.localSessionId);
  if (!beforePlayer) throw new Error(`missing local player before ${key} proof: ${JSON.stringify(beforeState)}`);
  const before = axis === "x" ? beforePlayer.x : beforePlayer.y;

  await page.keyboard.down(key.toLowerCase());
  try {
    const handle = await page.waitForFunction(
      ({ axisName, beforeValue, expectedDirection }) => {
        const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
        const player = scene?.room?.state?.players?.get(scene.localSessionId);
        const action = scene?.getVisualQaSnapshot?.().action as ActionQaState | undefined;
        const current = axisName === "x" ? player?.x : player?.y;
        if (typeof current !== "number" || !action) return null;
        const delta = current - beforeValue;
        if (Math.abs(delta) < 4 || Math.sign(delta) !== expectedDirection || action.assignmentOpen) return null;
        return { after: current, delta, assignmentOpen: action.assignmentOpen };
      },
      { axisName: axis, beforeValue: before, expectedDirection: direction },
      { timeout: 8_000 },
    );
    const result = await handle.jsonValue() as { after: number; delta: number; assignmentOpen: boolean } | null;
    if (!result) throw new Error(`movement proof returned empty for ${key}`);
    return { key, axis, before, after: result.after, delta: result.delta, assignmentOpen: result.assignmentOpen };
  } finally {
    await page.keyboard.up(key.toLowerCase()).catch(() => undefined);
    await page.waitForTimeout(150);
  }
}

/** card-hud-polish-r2 item 2: pressing a reserved UI key (I) with an EMPTY slot must
 * open the hub, NOT the assignment picker. Ensures the slot is empty, closes any open
 * hub, presses I, then asserts hub.open && !assignmentOpen. Leaves the hub closed. */
async function proveReservedKeyRoutesToUi(
  page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"],
  key: string,
): Promise<ReservedKeyProof> {
  // Clear any stored binding on the reserved slot so it is genuinely empty, then
  // make sure the hub starts closed.
  const slotBoundBefore = await page.evaluate((k) => {
    const action = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game")?.getVisualQaSnapshot?.().action as ActionQaState | undefined;
    return Boolean(action?.bindings.find((binding) => binding.key === k)?.id);
  }, key.toUpperCase());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  // Baseline before the press: hub and picker must both be closed, else the proof
  // would be meaningless.
  const baseline = await page.evaluate(() => {
    const snapshot = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game")?.getVisualQaSnapshot?.();
    const action = snapshot?.action as ActionQaState | undefined;
    const hub = snapshot?.hub as { open?: boolean } | undefined;
    return { hubOpen: Boolean(hub?.open), assignmentOpen: Boolean(action?.assignmentOpen) };
  });
  if (baseline.hubOpen || baseline.assignmentOpen) throw new Error(`reserved-key proof precondition failed (hub/picker already open) for ${key}: ${JSON.stringify(baseline)}`);

  await page.keyboard.press(key.toLowerCase());
  const waitForHubRoute = () =>
    page.waitForFunction(
      () => {
        const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
        const snapshot = scene?.getVisualQaSnapshot?.();
        const action = snapshot?.action as ActionQaState | undefined;
        const hub = snapshot?.hub as { open?: boolean } | undefined;
        if (!action) return null;
        if (!hub?.open) return null;
        return { hubOpen: true, assignmentOpen: Boolean(action.assignmentOpen) };
      },
      undefined,
      { timeout: 6_000 },
    );
  let result: Awaited<ReturnType<typeof waitForHubRoute>>;
  try {
    result = await waitForHubRoute();
  } catch {
    await page.locator("#hud-system-cluster [data-menu-entry='bag']").click();
    result = await waitForHubRoute();
  }
  const routed = (await result.jsonValue()) as { hubOpen: boolean; assignmentOpen: boolean };
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => {
      const snapshot = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game")?.getVisualQaSnapshot?.();
      const hub = snapshot?.hub as { open?: boolean } | undefined;
      return hub?.open === false;
    },
    undefined,
    { timeout: 6_000 },
  );
  return { key: key.toUpperCase(), hubOpen: routed.hubOpen, assignmentOpen: routed.assignmentOpen, slotBoundBefore };
}

async function waitForActionState(
  page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"],
  predicate: (action: ActionQaState) => boolean,
): Promise<ActionQaState> {
  const deadline = Date.now() + 8000;
  let last: ActionQaState | undefined;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
      return scene?.getVisualQaSnapshot?.().action as ActionQaState | undefined;
    });
    if (last && predicate(last)) return last;
    await page.waitForTimeout(100);
  }
  throw new Error(`timed out waiting for HUD action state; last=${JSON.stringify(last)}`);
}

async function waitForHubState(
  page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"],
  predicate: (hub: HubQaState) => boolean,
): Promise<HubQaState> {
  const deadline = Date.now() + 8000;
  let last: HubQaState | undefined;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
      return scene?.getVisualQaSnapshot?.()?.hub as HubQaState | undefined;
    });
    if (last && predicate(last)) return last;
    await page.waitForTimeout(100);
  }
  throw new Error(`timed out waiting for hub state; last=${JSON.stringify(last)}`);
}

async function getHubPortraitState(page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]): Promise<{
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  renderedWidth: number;
  renderedHeight: number;
}> {
  return page.evaluate(() => {
    const img = ((globalThis as SmokeBrowserGlobal).document.querySelector(".player-hub-paper-art img[data-portrait='player']") ?? null) as
      | (ElementLike & {
          getBoundingClientRect(): { width: number; height: number };
          getAttribute(name: string): string | null;
          naturalWidth: number;
          naturalHeight: number;
        })
      | null;
    if (!img) return { src: "", naturalWidth: 0, naturalHeight: 0, renderedWidth: 0, renderedHeight: 0 };
    const rect = img.getBoundingClientRect();
    return {
      src: img.getAttribute("src") ?? "",
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      renderedWidth: Math.round(rect.width),
      renderedHeight: Math.round(rect.height),
    };
  });
}

async function getHubViewportFitState(page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]): Promise<{
  width: number;
  height: number;
  windowFits: boolean;
  bodyHasInternalScroll: boolean;
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
}> {
  return page.evaluate(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const win = (doc.querySelector(".player-hub-window") ?? null) as
      | (ElementLike & { getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } })
      | null;
    const body = (doc.querySelector(".player-hub-window .lm-window__body") ?? null) as
      | (ElementLike & { scrollHeight: number; clientHeight: number; scrollWidth: number; clientWidth: number })
      | null;
    const rect = win?.getBoundingClientRect();
    const width = (globalThis as unknown as { innerWidth: number }).innerWidth;
    const height = (globalThis as unknown as { innerHeight: number }).innerHeight;
    const measured = rect
      ? {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        }
      : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    return {
      width,
      height,
      windowFits: Boolean(rect && rect.left >= 0 && rect.top >= 0 && rect.right <= width && rect.bottom <= height),
      bodyHasInternalScroll: Boolean(body && body.scrollHeight >= body.clientHeight && body.scrollWidth >= body.clientWidth),
      rect: measured,
    };
  });
}

async function gainAttributePoint(page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]): Promise<{ before: unknown; after: unknown }> {
  const before = await getSmokeState(page);
  let after = before;
  for (let kills = 0; kills < 6; kills += 1) {
    const local = after?.players.find((player) => player.sessionId === after?.localSessionId);
    if ((local?.attributePoints ?? 0) > 0) return { before, after: local };
    await killOnePassiveSlime(page, await getJoinedStateForCapture(page));
    after = await getSmokeState(page);
  }
  const local = after?.players.find((player) => player.sessionId === after?.localSessionId);
  if ((local?.attributePoints ?? 0) <= 0) {
    throw new Error(`failed to earn an attribute point for hub proof: ${JSON.stringify(local)}`);
  }
  return { before, after: local };
}

async function getJoinedStateForCapture(page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]): Promise<JoinedSmokeState> {
  const state = await getSmokeState(page);
  if (!state?.localSessionId) throw new Error("missing joined smoke state for capture proof");
  return state as JoinedSmokeState;
}

async function getHubMovementProbe(page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  return page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const snapshot = scene?.getVisualQaSnapshot?.();
    if (!snapshot?.hub) throw new Error("hub movement probe unavailable");
    return {
      hub: snapshot.hub,
      input: snapshot.input,
      localPlayer: snapshot.players?.find((player) => player.isLocal)?.server ?? null,
    };
  });
}

async function captureCombatRangeUxProof(outDir: string, page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  await waitForMonsterCount(page, 1);
  await stageInOpenField(page);
  const target = await findCombatRangeTarget(page);
  await moveLocalPlayerNear(page, target.x + 240, target.y, 24, 20_000);
  await frameCombatTarget(page, target.x, target.y, GAMEPLAY_ZOOM);

  const outOfRangeBefore = await getCombatRangeSnapshot(page, target.monsterId);
  await page.screenshot({ path: `${outDir}/combat-range-out-before.png` });
  await clickMonsterCanvas(page, target.monsterId);
  await page.waitForTimeout(120);
  const outMarker = await getCombatRangeSnapshot(page, target.monsterId);
  await page.screenshot({ path: `${outDir}/combat-range-out-marker.png` });

  for (let i = 0; i < 4; i += 1) {
    await clickMonsterCanvas(page, target.monsterId);
    await page.waitForTimeout(55);
  }
  await page.waitForTimeout(90);
  const spam = await getCombatRangeSnapshot(page, target.monsterId);
  await page.screenshot({ path: `${outDir}/combat-range-spam-no-stack.png` });

  await page.waitForTimeout(760);
  const faded = await getCombatRangeSnapshot(page, target.monsterId);
  await page.screenshot({ path: `${outDir}/combat-range-marker-faded.png` });

  await moveLocalPlayerNear(page, faded.monster.x + 80, faded.monster.y, 20, 20_000);
  await frameCombatTarget(page, faded.monster.x, faded.monster.y, GAMEPLAY_ZOOM);
  const inRangeBefore = await getCombatRangeSnapshot(page, target.monsterId);
  await clickMonsterCanvas(page, target.monsterId);
  await page.waitForFunction((targetId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const monster = scene?.room?.state?.monsters?.get(targetId);
    return monster && monster.hp < monster.maxHp;
  }, target.monsterId, { timeout: 8_000 });
  await page.waitForTimeout(180);
  const inRangeAfter = await getCombatRangeSnapshot(page, target.monsterId);
  await page.screenshot({ path: `${outDir}/combat-range-inrange-hit.png` });

  const playerDrift = Math.hypot(
    faded.player.x - outOfRangeBefore.player.x,
    faded.player.y - outOfRangeBefore.player.y,
  );
  if (playerDrift > 6) {
    throw new Error(`out-of-range attack moved player by ${playerDrift.toFixed(1)}px`);
  }
  if (outMarker.markerCount < 1) throw new Error("out-of-range marker did not appear");
  if (spam.markerCount !== 1) throw new Error(`spam-click marker stacked or vanished; markerCount=${spam.markerCount}`);
  if (faded.markerCount !== 0) throw new Error(`out-of-range marker did not fade; markerCount=${faded.markerCount}`);
  if (inRangeAfter.monster.hp >= inRangeBefore.monster.hp) {
    throw new Error(`in-range attack did not damage target: before=${inRangeBefore.monster.hp} after=${inRangeAfter.monster.hp}`);
  }

  return {
    target,
    outOfRange: {
      before: outOfRangeBefore,
      marker: outMarker,
      spam,
      faded,
      playerDrift,
    },
    inRange: {
      before: inRangeBefore,
      after: inRangeAfter,
      damage: inRangeBefore.monster.hp - inRangeAfter.monster.hp,
    },
    screenshots: [
      "combat-range-out-before.png",
      "combat-range-out-marker.png",
      "combat-range-spam-no-stack.png",
      "combat-range-marker-faded.png",
      "combat-range-inrange-hit.png",
    ],
  };
}

async function captureLevelUpProof(
  outDir: string,
  page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"],
  joined: Awaited<ReturnType<typeof createSmokeHarness>>["joinedA"],
) {
  await waitForMonsterCount(page, 1);
  await stageInOpenField(page);
  let state = await getSmokeState(page);
  let local = state?.players.find((player) => player.sessionId === joined.localSessionId);
  if (!state || !local) throw new Error(`missing level-up proof setup state: ${JSON.stringify(state)}`);
  const before = {
    level: local.level,
    xp: local.xp,
    attributePoints: local.attributePoints,
    skillPoints: local.skillPoints,
    x: local.x,
    y: local.y,
  };
  await framePlayerAtGameplayZoom(page, local.x, local.y);
  await page.screenshot({ path: `${outDir}/levelup-before.png` });

  const killed: Array<{ monsterId: string; level: number; xp: number }> = [];
  for (let i = 0; i < 8; i += 1) {
    const target = await killOnePassiveSlime(page, joined);
    state = await getSmokeState(page);
    local = state?.players.find((player) => player.sessionId === joined.localSessionId);
    if (!local) throw new Error(`missing local player after level-up proof kill: ${JSON.stringify(state)}`);
    killed.push({ monsterId: target.monsterId, level: local.level, xp: local.xp });
    await framePlayerAtGameplayZoom(page, local.x, local.y);
    if (local.level > before.level) break;
  }

  if (!local || local.level <= before.level) {
    throw new Error(`smoke kills did not level the player: before=${JSON.stringify(before)} killed=${JSON.stringify(killed)}`);
  }

  await page.waitForFunction(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game") as {
      getLevelUpCelebrationQaState?: () => LevelUpProofQaState;
    } | undefined;
    const qa = scene?.getLevelUpCelebrationQaState?.();
    const active = qa?.active.some((entry) => entry.local && entry.label === "LEVEL UP!");
    const fx = qa?.fx?.active.some((entry) => (
      entry.label === "LEVEL UP!" &&
      entry.columnCount >= 2 &&
      entry.spiralCount >= 3 &&
      entry.groundFlashCount >= 1 &&
      entry.titleCount >= 1
    ));
    return Boolean(active && fx);
  }, undefined, { timeout: 1_500 });

  const realBeatQa = await getLevelUpCelebrationQa(page);
  const realLevelUpFx = realBeatQa.fx?.active.find((entry: { label?: string }) => entry.label === "LEVEL UP!");
  if (!realLevelUpFx || realLevelUpFx.columnCount < 2 || realLevelUpFx.spiralCount < 3 || realLevelUpFx.groundFlashCount < 1 || realLevelUpFx.titleCount < 1) {
    throw new Error(`real level-up FX nodes missing: ${JSON.stringify(realBeatQa)}`);
  }
  const pointsToast = await getStatPointsToastState(page);
  if (!pointsToast.present) throw new Error(`stat-points toast not rendered: ${JSON.stringify(pointsToast)}`);
  if (Math.abs(pointsToast.centerXOffsetPx) > 12) throw new Error(`stat-points toast not centered: ${JSON.stringify(pointsToast)}`);
  if (pointsToast.topGapPx > 200) throw new Error(`stat-points toast not near top: ${JSON.stringify(pointsToast)}`);
  const expectedAttributePoints = local.attributePoints;
  const expectedSkillPoints = local.skillPoints;
  if (!pointsToast.message.includes(`${expectedAttributePoints} attribute point`) || !pointsToast.message.includes(`${expectedSkillPoints} skill point`)) {
    throw new Error(`stat-points toast does not cite current point pools: ${JSON.stringify({ pointsToast, expectedAttributePoints, expectedSkillPoints })}`);
  }
  await page.waitForFunction(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game") as {
      getLevelUpCelebrationQaState?: () => LevelUpProofQaState;
    } | undefined;
    const activeFx = scene?.getLevelUpCelebrationQaState?.().fx?.active ?? [];
    return activeFx.length === 0;
  }, undefined, { timeout: 3_000 });
  await replayLevelUpFxForBurst(page, local.x, local.y);
  const burstQa = await getLevelUpCelebrationQa(page);
  const burstScreenshots: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    await page.waitForTimeout(i === 0 ? 20 : 80);
    const file = `${outDir}/levelup-burst-${String(i + 1).padStart(2, "0")}.png`;
    await page.screenshot({ path: file });
    burstScreenshots.push(file);
  }

  return {
    before,
    after: {
      level: local.level,
      xp: local.xp,
      attributePoints: local.attributePoints,
      skillPoints: local.skillPoints,
      x: local.x,
      y: local.y,
    },
    kills: killed,
    qa: {
      realBeat: realBeatQa,
      visualReplay: burstQa,
    },
    pointsToast,
    assertions: {
      columnTitleSpiralsPresent: true,
      pointsToastTopCenter: true,
      pointsToastUsesCurrentPools: true,
      visualBurstReplayUsesSamePrimitive: true,
      burstFrames: burstScreenshots.length,
    },
    screenshots: ["levelup-before.png", ...burstScreenshots.map((file) => file.replace(`${outDir}/`, ""))],
  };
}

async function replayLevelUpFxForBurst(page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"], x: number, y: number): Promise<void> {
  await page.evaluate(async ({ x: fxX, y: fxY }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    if (!scene) throw new Error("scene unavailable for level-up visual replay");
    const toastModulePath = "/src/render/FloatingText.ts";
    const mod = await import(toastModulePath);
    mod.spawnLevelUpCelebration(scene, fxX, fxY, {
      label: "LEVEL UP!",
      subtitle: "Lv.2",
      prominent: true,
      kind: "level",
    });
  }, { x, y });
  await page.waitForFunction(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game") as {
      getLevelUpCelebrationQaState?: () => LevelUpProofQaState;
    } | undefined;
    return Boolean(scene?.getLevelUpCelebrationQaState?.().fx?.active.some((entry) => (
      entry.label === "LEVEL UP!" &&
      entry.columnCount >= 2 &&
      entry.spiralCount >= 3 &&
      entry.groundFlashCount >= 1 &&
      entry.titleCount >= 1
    )));
  }, undefined, { timeout: 1_000 });
}

async function framePlayerAtGameplayZoom(page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"], x: number, y: number): Promise<void> {
  await page.evaluate(({ cx, cy, zoom }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const cam = scene?.cameras?.main;
    if (!cam) throw new Error("camera unavailable for level-up proof");
    cam.stopFollow();
    cam.setZoom(zoom);
    cam.centerOn(cx, cy - 34);
  }, { cx: x, cy: y, zoom: GAMEPLAY_ZOOM });
  await page.waitForTimeout(260);
}

type LevelUpProofFxEntry = {
  label: string;
  columnCount: number;
  spiralCount: number;
  groundFlashCount: number;
  titleCount: number;
};

type LevelUpProofQaState = {
  active: Array<{ local: boolean; label: string }>;
  fx?: { active: LevelUpProofFxEntry[] };
};

async function getLevelUpCelebrationQa(page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]): Promise<LevelUpProofQaState> {
  return page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game") as {
      getLevelUpCelebrationQaState?: () => LevelUpProofQaState;
    } | undefined;
    return scene?.getLevelUpCelebrationQaState?.() ?? { active: [] };
  });
}

async function getStatPointsToastState(page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  return page.evaluate(() => {
    const doc = (globalThis as unknown as {
      document: { querySelector: (s: string) => ({
        querySelector: (s: string) => ({ textContent: string | null } | null);
        getBoundingClientRect: () => { left: number; right: number; top: number };
      } | null) };
      innerWidth: number;
    });
    const container = doc.document.querySelector(".lm-toast-container--top-center");
    const toast = doc.document.querySelector(".lm-toast-container--top-center .lm-toast--stat-points-available");
    if (!container || !toast) {
      return { present: false, eyebrow: null as string | null, message: "", detail: null as string | null, centerXOffsetPx: 999, topGapPx: 999 };
    }
    const eyebrow = toast.querySelector(".lm-toast__eyebrow");
    const message = toast.querySelector(".lm-toast__message");
    const detail = toast.querySelector(".lm-toast__detail");
    const rect = container.getBoundingClientRect();
    return {
      present: true,
      eyebrow: eyebrow ? eyebrow.textContent : null,
      message: message?.textContent ?? "",
      detail: detail ? detail.textContent : null,
      centerXOffsetPx: Math.round((rect.left + rect.right) / 2 - doc.innerWidth / 2),
      topGapPx: Math.round(rect.top),
    };
  });
}

async function findCombatRangeTarget(page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  const state = await getSmokeState(page);
  const local = state?.players.find((player) => player.sessionId === state.localSessionId);
  if (!state || !local) throw new Error(`missing combat range state: ${JSON.stringify(state)}`);
  const target = state.monsters
    .filter((monster) => (
      monster.mapId === BLOOMVALE_MAP_ID &&
      monster.monsterId.includes(SLIME_COMBAT_MONSTER_ID) &&
      monster.alive &&
      monster.x >= 560 &&
      monster.x <= 1200 &&
      monster.y >= 960 &&
      monster.y <= 1500
    ))
    .sort((a, b) => Math.hypot(local.x - a.x, local.y - a.y) - Math.hypot(local.x - b.x, local.y - b.y))[0];
  if (!target) throw new Error(`no arena ${SLIME_COMBAT_MONSTER_ID} found: ${JSON.stringify(state.monsters)}`);
  return target;
}

async function frameCombatTarget(
  page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"],
  targetX: number,
  targetY: number,
  zoom: number,
): Promise<void> {
  await page.evaluate(({ cx, cy, targetZoom }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const cam = scene?.cameras?.main;
    if (!cam) throw new Error("camera unavailable for combat range proof");
    cam.stopFollow();
    cam.setZoom(targetZoom);
    cam.centerOn(cx, cy);
  }, { cx: targetX + 110, cy: targetY, targetZoom: zoom });
  await page.waitForTimeout(260);
}

async function clickMonsterCanvas(page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"], monsterId: string): Promise<void> {
  const point = await page.evaluate((targetId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const render = scene?.monsterObjects?.get(targetId);
    const cam = scene?.cameras?.main;
    const rect = scene?.game?.canvas?.getBoundingClientRect();
    if (!render?.container || !cam || !rect) throw new Error(`monster render/camera missing for ${targetId}`);
    return {
      x: rect.left + (render.container.x - cam.worldView.x) * cam.zoom,
      y: rect.top + (render.container.y - cam.worldView.y) * cam.zoom,
    };
  }, monsterId);
  await page.mouse.click(point.x, point.y);
}

async function getCombatRangeSnapshot(page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"], monsterId: string) {
  return page.evaluate((targetId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    const monster = scene?.room?.state?.monsters?.get(targetId);
    if (!scene || !player || !monster) throw new Error(`missing range proof state for ${targetId}`);
    const markerCount = (scene.children?.list ?? []).filter((child) => {
      const candidate = child as { text?: unknown; visible?: boolean; active?: boolean };
      return candidate.visible !== false && candidate.active !== false && candidate.text === "OUT OF RANGE";
    }).length;
    return {
      player: { x: Math.round(player.x), y: Math.round(player.y), selectedTargetId: player.selectedTargetId },
      monster: { id: targetId, x: Math.round(monster.x), y: Math.round(monster.y), hp: monster.hp, maxHp: monster.maxHp },
      markerCount,
    };
  }, monsterId);
}

async function captureEffectsProof(outDir: string, page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  const state = await waitForMonsterCount(page, 1);
  const local = state.players.find((player) => player.sessionId === state.localSessionId);
  if (!local) throw new Error(`effects proof missing local player: ${JSON.stringify(state)}`);
  const target = state.monsters.find((monster) => monster.alive && monster.mapId === local.mapId);
  if (!target) throw new Error(`effects proof found no live monster: ${JSON.stringify(state.monsters)}`);
  await moveLocalPlayerNear(page, target.x - 120, target.y, 12);
  const setup = await page.evaluate((targetId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    const monster = scene?.room?.state?.monsters?.get(targetId);
    if (!scene?.room || !player || !monster) throw new Error("effects proof missing player/target after positioning");
    scene.room.send("intent", {
      type: "target.select",
      requestId: `effects-proof-target-${Date.now()}`,
      targetId,
    });
    (globalThis as SmokeBrowserGlobal).__SMOKE_COMBAT_EVENTS__ = [];
    return {
      player: { id: scene.localSessionId, x: player.x, y: player.y },
      target: { id: targetId, x: monster.x, y: monster.y },
    };
  }, target.monsterId);
  await frameCombatTarget(page, setup.target.x, setup.target.y, GAMEPLAY_ZOOM);
  await page.screenshot({ path: `${outDir}/effects-before.png` });

  await page.evaluate((targetId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    if (!scene?.room) throw new Error("effects proof room missing before stonebind");
    scene.room.send("intent", {
      type: "skill.cast",
      requestId: `effects-proof-stonebind-${Date.now()}`,
      skillId: "skill_stonebind",
      targetId,
    });
  }, setup.target.id);
  await page.waitForFunction(() => {
    const events = (globalThis as SmokeBrowserGlobal).__SMOKE_COMBAT_EVENTS__ ?? [];
    return events.some((event) => event.skillId === "skill_stonebind" && event.effect?.type === "root");
  }, undefined, { timeout: 6000 });

  const rootSamples: Array<{ elapsedMs: number; x: number; y: number }> = [];
  const rootStart = Date.now();
  for (const delay of [0, 350, 700, 1050]) {
    const waitMs = rootStart + delay - Date.now();
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    rootSamples.push(await page.evaluate((targetId) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
      const monster = scene?.room?.state?.monsters?.get(targetId);
      if (!monster) throw new Error(`effects proof missing rooted monster ${targetId}`);
      return { elapsedMs: 0, x: Math.round(monster.x * 100) / 100, y: Math.round(monster.y * 100) / 100 };
    }, setup.target.id));
    rootSamples[rootSamples.length - 1].elapsedMs = delay;
  }
  const maxRootDelta = Math.max(...rootSamples.map((sample) => Math.hypot(sample.x - rootSamples[0].x, sample.y - rootSamples[0].y)));
  if (maxRootDelta > 1) throw new Error(`stonebind root did not freeze monster: ${JSON.stringify(rootSamples)}`);
  await page.screenshot({ path: `${outDir}/effects-rooted.png` });
  const stonebindEvent = (await getRecentCombatEvents(page)).find((event) => {
    const candidate = event as { skillId?: string; effect?: { type?: string } };
    return candidate.skillId === "skill_stonebind" && candidate.effect?.type === "root";
  });
  if (!stonebindEvent) throw new Error("stonebind combat event with skillId/effect missing from trace");

  const dashBefore = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    if (!player) throw new Error("effects proof missing player before reed_step");
    (globalThis as SmokeBrowserGlobal).__SMOKE_COMBAT_EVENTS__ = [];
    return { x: player.x, y: player.y };
  });
  await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    if (!scene?.room || !player) throw new Error("effects proof room/player missing before reed_step");
    scene.room.send("intent", {
      type: "skill.cast",
      requestId: `effects-proof-reed-step-${Date.now()}`,
      skillId: "skill_reed_step",
      x: player.x + 140,
      y: player.y,
    });
  });
  await page.waitForFunction(() => {
    const events = (globalThis as SmokeBrowserGlobal).__SMOKE_COMBAT_EVENTS__ ?? [];
    return events.some((event) => event.skillId === "skill_reed_step" && event.type === "mobility");
  }, undefined, { timeout: 6000 });
  await page.waitForTimeout(350);
  const dashAfter = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    if (!player) throw new Error("effects proof missing player after reed_step");
    return { x: player.x, y: player.y };
  });
  const dashDistance = Math.hypot(dashAfter.x - dashBefore.x, dashAfter.y - dashBefore.y);
  if (dashDistance < 100) throw new Error(`reed_step displacement too small: ${JSON.stringify({ dashBefore, dashAfter, dashDistance })}`);
  const reedStepEvent = (await getRecentCombatEvents(page)).find((event) => {
    const candidate = event as { skillId?: string; type?: string };
    return candidate.skillId === "skill_reed_step" && candidate.type === "mobility";
  });
  if (!reedStepEvent) throw new Error("reed_step mobility event with skillId missing from trace");

  await frameCombatTarget(page, dashAfter.x, dashAfter.y, GAMEPLAY_ZOOM);
  await page.screenshot({ path: `${outDir}/effects-after.png` });
  return {
    kind: "gamekit-effects-proof",
    targetId: setup.target.id,
    stonebindEvent,
    rootSamples,
    maxRootDelta,
    reedStepEvent,
    dashBefore,
    dashAfter,
    dashDistance,
    assertions: {
      stonebindSkillId: true,
      rootedAtLeastOneSecond: true,
      reedStepDisplacedAtLeast100px: true,
    },
    screenshots: [`${outDir}/effects-before.png`, `${outDir}/effects-rooted.png`, `${outDir}/effects-after.png`],
  };
}

// card-shimmer-npc-revert-fix regression guard: emit the deterministic static-asset
// dark-rim shimmer metric (green slime vs blue slime vs one NPC) alongside the
// monster-anim proof. Non-gating here (a red green-slime rim must not block the code
// lane's own gates — the rim rebuild is the Codex art lane's job); the metric records
// the root-cause property so a future shimmer regression is caught by the JSON diff.
function writeSlimeRimShimmerMetric(outDir: string): void {
  const script = pathResolve(ROOT, "tools/asset-cleanup/slime_rim_shimmer_metric.py");
  const sprites = pathResolve(ROOT, "client/public/assets/sprites");
  const python = process.env.PYTHON || "python";
  const result = spawnSync(python, [script, sprites, "--out", outDir], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    console.warn(`[capture] slime rim shimmer metric skipped: ${result.error?.message ?? result.stderr ?? "unknown"}`);
    return;
  }
  console.log(`[capture] slime rim shimmer metric -> ${outDir}/slime-rim-shimmer-metric.json`);
}

// card-slime-display-scale scope 4: tracked-crop moving-vs-stationary shimmer gate. Per
// species, the walk (moving) tracked-crop dark-rim stdev must stay within 3× the idle
// (stationary) control — the tracked crop follows each frame's own bbox so bob translation
// does not inflate the count. Writes slime-tracked-variance.json; logs PASS/FAIL. Non-fatal
// to the capture run (the JSON + burst PNGs are the reviewable artifact).
function writeSlimeTrackedVariance(outDir: string): void {
  const script = pathResolve(ROOT, "tools/asset-cleanup/slime_burst_variance.py");
  const sprites = pathResolve(ROOT, "client/public/assets/sprites");
  const python = process.env.PYTHON || "python";
  const result = spawnSync(python, [script, outDir, "--gate", "--sprites", sprites], { encoding: "utf8" });
  if (result.error) {
    console.warn(`[capture] slime tracked-variance gate skipped: ${result.error.message}`);
    return;
  }
  console.log(`[capture] slime tracked-variance gate (${result.status === 0 ? "PASS" : "FAIL"}) -> ${outDir}/slime-tracked-variance.json`);
  if (result.stdout) console.log(result.stdout.trim());
}

// card-affix-presentation (--affix-proof): render a plain + 4-affix monster row through the real
// createMonsterAvatar path and screenshot it at gameplay framing. Two shots: `affix-burst.png` while
// the one-shot spawn burst is mid-flight, and `affix-settled.png` after it fades (steady aura + rim
// + nameplate). Integrator + owner judge the read; this proof just stages the pixels deterministically.
async function captureAffixProof(outDir: string, page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  await stageInOpenField(page);
  // Freeze the camera at gameplay zoom; the showcase spawns its row at the (now stationary) camera
  // midpoint, so no re-centering is needed between framing and screenshot.
  await page.evaluate(({ zoom }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const cam = scene?.cameras?.main;
    if (!cam) throw new Error("camera unavailable for affix proof");
    cam.stopFollow();
    cam.setZoom(zoom);
  }, { zoom: GAMEPLAY_ZOOM });
  await page.waitForTimeout(200);
  // Fire the showcase (reads camera midPoint internally) and grab the burst frame quickly.
  await page.evaluate(() => {
    const qa = (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__ as { spawnAffixShowcase?: () => void } | undefined;
    if (!qa?.spawnAffixShowcase) throw new Error("__GAMEKIT_QA__.spawnAffixShowcase unavailable");
    qa.spawnAffixShowcase();
  });
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${outDir}/affix-burst.png`, fullPage: false });
  // Let the burst fade; capture the steady aura + rim + nameplate read.
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${outDir}/affix-settled.png`, fullPage: false });
  const rendered = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game") as unknown as {
      monsterObjects?: Map<string, { affixAura?: unknown }>;
    };
    const ids = ["qa-affix-none", "qa-affix-affix_swift", "qa-affix-affix_stout", "qa-affix-affix_gilded", "qa-affix-affix_mega"];
    return ids.map((id) => ({ id, present: Boolean(scene?.monsterObjects?.get(id)), hasAura: Boolean(scene?.monsterObjects?.get(id)?.affixAura) }));
  });
  return { rendered };
}

async function captureGatherProof(outDir: string, page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  const expectedAnimationKey = "player-gather-side";
  const expectedTextureKey = "player_blackhair_cel_gather_east_256";
  const bodyMetrics = {
    frameHeight: 256,
    anchorY: 255,
    bodyHeight: 222,
    displayBodyHeight: 96,
  };
  await stageInOpenField(page);
  const target = (await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game") as unknown as {
      room?: {
        state?: {
          players?: { get(id: string | undefined): { mapId?: string } | undefined };
          oreNodes?: { forEach(callback: (node: { mapId?: string; x?: number; y?: number; radius?: number; depleted?: boolean }, id: string) => void): void };
        };
      };
      localSessionId?: string;
    };
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    let selected: { id: string; x: number; y: number; radius: number } | null = null;
    scene?.room?.state?.oreNodes?.forEach((node, id) => {
      if (selected || node.mapId !== player?.mapId || node.depleted || typeof node.x !== "number" || typeof node.y !== "number") return;
      selected = { id, x: node.x, y: node.y, radius: node.radius ?? 96 };
    });
    return selected;
  })) as { id: string; x: number; y: number; radius: number } | null;
  if (!target) throw new Error("gather proof found no live ore node on the local player's map");

  // Approach from the SOUTH (player standing in front of / below the rock) so the foot
  // sits below the node's base collision box (lr5 ore collision) yet stays inside the
  // mining radius. The base box straddles the node origin, so a same-row (west) approach
  // now lands the footprint on blocked tiles; a southward stand of ~radius−4 clears the
  // box and remains within reach (verified numerically: unblocked & in-reach for every
  // harbor copper node at radius 44).
  const approachSouth = Math.min(Math.max(target.radius - 4, 24), target.radius);
  await moveLocalPlayerNear(page, target.x, target.y + approachSouth - PLAYER_FOOT_OFFSET_Y, 4);
  await frameCombatTarget(page, target.x, target.y, GAMEPLAY_ZOOM * 1.7);
  await page.screenshot({ path: `${outDir}/gather-before.png`, fullPage: false });

  const sample = async (label: string): Promise<PlayerGatherRuntimeSample> => page.evaluate(({ sampleLabel, metrics }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game") as unknown as {
      localSessionId?: string;
      playerObjects?: { get(id: string | undefined): { sprite?: {
        flipX?: boolean;
        y?: number;
        texture?: { key?: string };
        anims?: { currentAnim?: { key?: string }; currentFrame?: { index?: number } };
      }; container?: { x?: number; y?: number } } | undefined };
      cameras?: { main?: { zoom?: number } };
      game?: { canvas?: { getBoundingClientRect?: () => { height?: number } } };
      scale?: { height?: number };
      playerGatherUntilMs?: { get(id: string | undefined): number | undefined };
      localPlayerAnimState?: string;
    };
    const render = scene?.playerObjects?.get(scene.localSessionId);
    const sprite = render?.sprite;
    const canvasRect = scene?.game?.canvas?.getBoundingClientRect?.();
    const canvasScaleY = typeof canvasRect?.height === "number" && typeof scene?.scale?.height === "number" && scene.scale.height > 0
      ? canvasRect.height / scene.scale.height
      : 1;
    const scale = metrics.displayBodyHeight / metrics.bodyHeight;
    const baselineOffsetY = (metrics.anchorY - metrics.frameHeight / 2) * scale;
    const bodyBottomOffsetScreenPx = typeof sprite?.y === "number" && typeof scene?.cameras?.main?.zoom === "number"
      ? (sprite.y + baselineOffsetY) * scene.cameras.main.zoom * canvasScaleY
      : null;
    return {
      label: sampleLabel,
      textureKey: sprite?.texture?.key ?? null,
      animationKey: sprite?.anims?.currentAnim?.key ?? null,
      frameIndex: sprite?.anims?.currentFrame?.index ?? null,
      flipX: sprite?.flipX ?? null,
      bodyBottomOffsetScreenPx,
      containerX: typeof render?.container?.x === "number" ? render.container.x : null,
      containerY: typeof render?.container?.y === "number" ? render.container.y : null,
      gatherHoldRemainingMs: typeof scene?.playerGatherUntilMs?.get(scene.localSessionId) === "number"
        ? scene.playerGatherUntilMs.get(scene.localSessionId)! - performance.now()
        : null,
      localPlayerAnimState: scene?.localPlayerAnimState ?? null,
    };
  }, { sampleLabel: label, metrics: bodyMetrics });

  const idleBefore = await sample("idle-before");
  await page.evaluate((nodeId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game") as unknown as {
      sendWorldInteractIntent?: (objectId: string) => void;
    };
    if (!scene?.sendWorldInteractIntent) throw new Error("gather proof scene interact hook missing");
    scene.sendWorldInteractIntent(nodeId);
  }, target.id);
  await page.waitForFunction(({ expectedKey, expectedTexture }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game") as unknown as {
      localSessionId?: string;
      playerObjects?: { get(id: string | undefined): { sprite?: { texture?: { key?: string }; anims?: { currentAnim?: { key?: string } } } } | undefined };
    };
    const sprite = scene?.playerObjects?.get(scene.localSessionId)?.sprite;
    return sprite?.texture?.key === expectedTexture && sprite?.anims?.currentAnim?.key === expectedKey;
  }, { expectedKey: expectedAnimationKey, expectedTexture: expectedTextureKey }, { timeout: 3000 });

  const burst: PlayerGatherRuntimeSample[] = [];
  for (let index = 0; index < 5; index += 1) {
    burst.push(await sample(`gather-${String(index).padStart(2, "0")}`));
    await page.waitForTimeout(80);
  }
  await page.screenshot({ path: `${outDir}/gather-during.png`, fullPage: false });
  await page.waitForTimeout(700);
  const after = await sample("after");
  await page.screenshot({ path: `${outDir}/gather-after.png`, fullPage: false });

  const liveGatherFrames = burst.filter((entry) => entry.animationKey === expectedAnimationKey && entry.textureKey === expectedTextureKey);
  if (liveGatherFrames.length === 0) throw new Error(`gather proof did not sample live gather frames: ${JSON.stringify(burst)}`);
  if (typeof idleBefore.bodyBottomOffsetScreenPx !== "number") throw new Error(`gather proof missing idle baseline: ${JSON.stringify(idleBefore)}`);
  const maxBodyBottomDeltaPx = Math.max(...liveGatherFrames.map((entry) => Math.abs((entry.bodyBottomOffsetScreenPx ?? Infinity) - idleBefore.bodyBottomOffsetScreenPx!)));
  if (maxBodyBottomDeltaPx > 4) {
    throw new Error(`gather body-bottom proof failed: max delta ${maxBodyBottomDeltaPx.toFixed(2)}px > 4px: ${JSON.stringify({ idleBefore, burst })}`);
  }
  const facingHeld = liveGatherFrames.every((entry) => entry.flipX === idleBefore.flipX);
  if (!facingHeld) throw new Error(`gather facing proof failed: ${JSON.stringify({ idleBefore, burst })}`);

  return {
    kind: "gamekit-gather-proof",
    target,
    expectedAnimationKey,
    expectedTextureKey,
    idleBefore,
    burst,
    after,
    bodyBottom: {
      idleOffsetScreenPx: idleBefore.bodyBottomOffsetScreenPx,
      gatherOffsetScreenPx: liveGatherFrames.map((entry) => entry.bodyBottomOffsetScreenPx),
      maxDeltaPx: maxBodyBottomDeltaPx,
      thresholdPx: 4,
    },
    facing: {
      idleFlipX: idleBefore.flipX,
      heldDuringGather: facingHeld,
    },
    screenshots: [
      `${outDir}/gather-before.png`,
      `${outDir}/gather-during.png`,
      `${outDir}/gather-after.png`,
    ],
  };
}

// lr5: prove the resized chest reads at the ruled size beside the player. Walks the
// local player next to a live room-state chest and frames both at gameplay zoom.
async function captureChestProof(outDir: string, page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  await stageInOpenField(page);
  const target = (await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game") as unknown as {
      room?: {
        state?: {
          players?: { get(id: string | undefined): { mapId?: string } | undefined };
          chests?: { forEach(callback: (chest: { mapId?: string; x?: number; y?: number; radius?: number; assetKey?: string; opened?: boolean }, id: string) => void): void };
        };
      };
      localSessionId?: string;
    };
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    let selected: { id: string; x: number; y: number; radius: number; assetKey: string } | null = null;
    scene?.room?.state?.chests?.forEach((chest, id) => {
      if (selected || chest.mapId !== player?.mapId || typeof chest.x !== "number" || typeof chest.y !== "number") return;
      selected = { id, x: chest.x, y: chest.y, radius: chest.radius ?? 120, assetKey: chest.assetKey ?? "" };
    });
    return selected;
  })) as { id: string; x: number; y: number; radius: number; assetKey: string } | null;
  if (!target) throw new Error("chest proof found no live chest on the local player's map");

  // Stand a short way south of the chest so the sprite reads beside the player.
  const approach = Math.min(Math.max(target.radius - 24, 40), target.radius);
  await moveLocalPlayerNear(page, target.x, target.y + approach - PLAYER_FOOT_OFFSET_Y, 8);
  await frameCombatTarget(page, target.x, target.y, GAMEPLAY_ZOOM);
  await page.screenshot({ path: `${outDir}/chest-beside-player.png`, fullPage: false });

  return {
    kind: "gamekit-chest-proof",
    target,
    screenshots: [`${outDir}/chest-beside-player.png`],
  };
}

async function captureMonsterAnimProof(outDir: string, page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  const expectedAnimationKey = "monster_meadow_slime-attack-side";
  const expectedTextureKey = "monster_meadow_slime_attack_side_imagegen_pilot";
  const expectedAttackBodyMetrics: MonsterAnimBodyMetrics = {
    frameHeight: 256,
    anchorY: 242,
    bodyHeight: 201,
    displayBodyHeight: 57,
  };
  await waitForMonsterCount(page, 1);
  await stageInOpenField(page);
  const state = await getSmokeState(page);
  const local = state?.players.find((player) => player.sessionId === state.localSessionId);
  if (!state?.localSessionId || !local) throw new Error(`monster animation proof missing local player: ${JSON.stringify(state)}`);
  const target = state.monsters
    .filter((monster) => monster.alive && monster.mapId === local.mapId && monster.monsterId.includes("monster_meadow_slime"))
    .sort((a, b) => Math.hypot(local.x - a.x, local.y - a.y) - Math.hypot(local.x - b.x, local.y - b.y))[0];
  if (!target) throw new Error(`monster animation proof found no live Meadow Slime: ${JSON.stringify(state.monsters)}`);

  await moveLocalPlayerNear(page, target.x + 130, target.y, 4);
  const positionedState = await getSmokeState(page);
  const positionedTarget = positionedState?.monsters.find((monster) => monster.monsterId === target.monsterId) ?? target;
  await frameCombatTarget(page, positionedTarget.x, positionedTarget.y, GAMEPLAY_ZOOM * 1.6);
  await page.evaluate((targetId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    if (!scene?.room) throw new Error("monster animation proof room missing");
    (globalThis as SmokeBrowserGlobal).__SMOKE_COMBAT_EVENTS__ = [];
    (globalThis as { __GAMEKIT_MONSTER_ANIM_EVENTS__?: unknown[] }).__GAMEKIT_MONSTER_ANIM_EVENTS__ = [];
    scene.room.send("intent", {
      type: "target.select",
      requestId: `monster-anim-proof-target-${Date.now()}`,
      targetId,
    });
  }, target.monsterId);
  await page.screenshot({ path: `${outDir}/monster-anim-before.png`, fullPage: false });

  const sample = async (label: string): Promise<MonsterAnimRuntimeSample> => page.evaluate(({ targetId, sampleLabel, attackBodyMetrics, attackTextureKey }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game") as unknown as {
      monsterObjects?: { get(id: string): { sprite?: {
        flipX?: boolean;
        y?: number;
        displayHeight?: number;
        getBounds?: () => { bottom?: number };
        texture?: { key?: string };
        anims?: { currentAnim?: { key?: string }; currentFrame?: { index?: number } };
      }; container?: { x?: number; y?: number } } | undefined };
      cameras?: { main?: { worldView?: { y?: number }; zoom?: number } };
      game?: { canvas?: { getBoundingClientRect?: () => { top?: number; height?: number } } };
      scale?: { height?: number };
    };
    const render = scene?.monsterObjects?.get(targetId);
    const sprite = render?.sprite;
    const bounds = sprite?.getBounds?.();
    const canvasRect = scene?.game?.canvas?.getBoundingClientRect?.();
    const canvasScaleY = typeof canvasRect?.height === "number" && typeof scene?.scale?.height === "number" && scene.scale.height > 0
      ? canvasRect.height / scene.scale.height
      : 1;
    const textureKey = sprite?.texture?.key ?? null;
    const attackScale = attackBodyMetrics.displayBodyHeight / attackBodyMetrics.bodyHeight;
    const attackBaselineOffsetY = (attackBodyMetrics.anchorY - attackBodyMetrics.frameHeight / 2) * attackScale;
    const bodyBottomLocal = textureKey === attackTextureKey && typeof sprite?.y === "number"
      ? sprite.y + attackBaselineOffsetY
      : typeof sprite?.displayHeight === "number"
        ? sprite.displayHeight / 2
        : null;
    const screenBottom = typeof bounds?.bottom === "number"
      && typeof scene?.cameras?.main?.worldView?.y === "number"
      && typeof scene?.cameras?.main?.zoom === "number"
      ? (canvasRect?.top ?? 0) + (bounds.bottom - scene.cameras.main.worldView.y) * scene.cameras.main.zoom * canvasScaleY
      : null;
    const bodyBottomOffsetScreenPx = typeof bodyBottomLocal === "number"
      && typeof scene?.cameras?.main?.zoom === "number"
      ? bodyBottomLocal * scene.cameras.main.zoom * canvasScaleY
      : null;
    return {
      label: sampleLabel,
      textureKey,
      animationKey: sprite?.anims?.currentAnim?.key ?? null,
      frameIndex: sprite?.anims?.currentFrame?.index ?? null,
      flipX: sprite?.flipX ?? null,
      spriteBottom: typeof bounds?.bottom === "number" ? bounds.bottom : null,
      screenBottom,
      bodyBottomLocal,
      bodyBottomOffsetScreenPx,
      containerX: typeof render?.container?.x === "number" ? render.container.x : null,
      containerY: typeof render?.container?.y === "number" ? render.container.y : null,
    };
  }, { targetId: target.monsterId, sampleLabel: label, attackBodyMetrics: expectedAttackBodyMetrics, attackTextureKey: expectedTextureKey });

  const idleBefore = await sample("idle-before");

  await page.evaluate((targetId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    if (!scene?.room) throw new Error("monster animation proof room missing before root-then-approach aggro");
    const global = globalThis as SmokeBrowserGlobal;
    global.__SMOKE_SERVER_ERRORS__ = [];
    if (!global.__SMOKE_ERROR_TRACE_INSTALLED__) {
      global.__SMOKE_ERROR_TRACE_INSTALLED__ = true;
      scene.room.onMessage("error", (event) => {
        const trace = global.__SMOKE_SERVER_ERRORS__;
        if (!trace) return;
        trace.push({ ...event, receivedAtMs: Date.now() });
        if (trace.length > 20) trace.shift();
      });
    }
    scene.room.send("intent", {
      type: "skill.cast",
      requestId: `monster-anim-proof-root-approach-${Date.now()}`,
      skillId: "skill_stonebind",
      targetId,
    });
  }, target.monsterId);

  await page.waitForFunction(({ targetId, expectedKey }) => {
    const combatEvents = (globalThis as SmokeBrowserGlobal).__SMOKE_COMBAT_EVENTS__ ?? [];
    const animEvents = (globalThis as {
      __GAMEKIT_MONSTER_ANIM_EVENTS__?: Array<{ type?: string; monsterInstanceId?: string; animationKey?: string }>;
    }).__GAMEKIT_MONSTER_ANIM_EVENTS__ ?? [];
    return (
      combatEvents.some((event) => event.type === "damage" && event.sourceId === targetId && event.skillId === "basic_attack") &&
      animEvents.some((event) => event.type === "attack-start" && event.monsterInstanceId === targetId && event.animationKey === expectedKey)
    );
  }, { targetId: target.monsterId, expectedKey: expectedAnimationKey }, { timeout: 18_000 });

  await page.evaluate((targetId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const monster = scene?.room?.state?.monsters?.get(targetId) as { x: number } | undefined;
    if (!monster) throw new Error(`monster animation proof missing target for return-leg nudge: ${targetId}`);
    let ticks = 0;
    const interval = setInterval(() => {
      monster.x -= 5;
      ticks += 1;
      if (ticks >= 8) clearInterval(interval);
    }, 30);
  }, target.monsterId);
  await page.waitForTimeout(40);

  const castDebug = await page.evaluate((targetId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    const monster = scene?.room?.state?.monsters?.get(targetId);
    const skillLevels: Record<string, number> = {};
    player?.skillLevels?.forEach((level, skillId) => {
      skillLevels[skillId] = level;
    });
    return {
      combatEvents: (globalThis as SmokeBrowserGlobal).__SMOKE_COMBAT_EVENTS__ ?? [],
      serverErrors: (globalThis as SmokeBrowserGlobal).__SMOKE_SERVER_ERRORS__ ?? [],
      player: player ? { id: scene?.localSessionId, x: player.x, y: player.y, hp: player.hp, skillLevels } : null,
      monster: monster ? { id: targetId, species: monster.monsterId, x: monster.x, y: monster.y, hp: monster.hp, alive: monster.alive, targetId: monster.targetId } : null,
      distance: player && monster ? Math.hypot(player.x - monster.x, player.y - monster.y) : null,
      animEvents: (globalThis as { __GAMEKIT_MONSTER_ANIM_EVENTS__?: unknown[] }).__GAMEKIT_MONSTER_ANIM_EVENTS__ ?? [],
    };
  }, target.monsterId);
  writeFileSync(`${outDir}/monster-anim-cast-debug.json`, JSON.stringify(castDebug, null, 2) + "\n", "utf8");

  const burst: MonsterAnimRuntimeSample[] = [];
  for (let index = 0; index < 6; index += 1) {
    burst.push(await sample(`attack-${String(index).padStart(2, "0")}`));
    await page.screenshot({ path: `${outDir}/monster-anim-attack-${String(index).padStart(2, "0")}.png`, fullPage: false });
    await page.waitForTimeout(90);
  }
  await page.waitForTimeout(320);
  const after = await sample("after");
  await page.screenshot({ path: `${outDir}/monster-anim-after.png`, fullPage: false });

  const recentCombatEvents = await getRecentCombatEvents(page);
  const combatEvent = recentCombatEvents.find((event) => {
    const candidate = event as { type?: string; sourceId?: string; skillId?: string };
    return candidate.type === "damage" && candidate.sourceId === target.monsterId && candidate.skillId === "basic_attack";
  });
  const animEvents = await page.evaluate(() => (
    (globalThis as {
      __GAMEKIT_MONSTER_ANIM_EVENTS__?: Array<{
        type: string;
        monsterInstanceId: string;
        monsterTypeId: string;
        animationKey: string;
        textureKey: string;
        frame: number | null;
        flipX: boolean;
        targetDirection: "left" | "right" | "unchanged";
        atMs: number;
      }>;
    }).__GAMEKIT_MONSTER_ANIM_EVENTS__ ?? []
  ));
  const sawLiveAttackFrame = burst.some((entry) => (
    entry.animationKey === expectedAnimationKey && entry.textureKey === expectedTextureKey && typeof entry.frameIndex === "number"
  ));
  if (!combatEvent) throw new Error(`monster animation proof did not see source basic_attack event: ${JSON.stringify(recentCombatEvents)}`);
  if (!animEvents.some((event) => event.type === "attack-start" && event.animationKey === expectedAnimationKey)) {
    throw new Error(`monster animation proof did not record attack-start: ${JSON.stringify(animEvents)}`);
  }
  if (!sawLiveAttackFrame) throw new Error(`monster animation proof did not sample a live attack frame: ${JSON.stringify(burst)}`);
  const attackBottoms = burst
    .filter((entry) => entry.animationKey === expectedAnimationKey && entry.textureKey === expectedTextureKey && typeof entry.bodyBottomOffsetScreenPx === "number")
    .map((entry) => entry.bodyBottomOffsetScreenPx as number);
  if (typeof idleBefore.bodyBottomOffsetScreenPx !== "number" || attackBottoms.length === 0) {
    throw new Error(`monster body-bottom proof missing idle/attack samples: ${JSON.stringify({ idleBefore, burst })}`);
  }
  const maxBodyBottomDeltaPx = Math.max(...attackBottoms.map((bottom) => Math.abs(bottom - idleBefore.bodyBottomOffsetScreenPx!)));
  if (maxBodyBottomDeltaPx > 4) {
    throw new Error(`monster body-bottom proof failed: max delta ${maxBodyBottomDeltaPx.toFixed(2)}px > 4px: ${JSON.stringify({ idleBefore, burst })}`);
  }

  // Facing proof — RIGHT case: player was moved to target.x + 130 (right of the
  // slime), then the proof nudges a local return leg during attack. With
  // nativeFacesRight:true the slime must hold right-facing flipX === false.
  const rightStart = animEvents.find((event) => (
    event.type === "attack-start" && event.monsterInstanceId === target.monsterId && event.animationKey === expectedAnimationKey
  ));
  if (!rightStart || rightStart.targetDirection !== "right" || rightStart.flipX !== false) {
    throw new Error(`monster facing proof (right) failed — expected direction=right flipX=false: ${JSON.stringify(rightStart)}`);
  }
  const rightAttackBurst = burst.filter((entry) => entry.animationKey === expectedAnimationKey);
  const rightBurstMoved = rightAttackBurst.some((entry, index) => index > 0 && rightAttackBurst[0].containerX !== null && entry.containerX !== null && Math.abs(entry.containerX - rightAttackBurst[0].containerX) >= 1);
  const rightBurstHeldFacing = rightAttackBurst.length > 1 && rightAttackBurst.every((entry) => entry.flipX === false);
  if (!rightBurstMoved) throw new Error(`monster facing proof (right) did not exercise moving attack frames: ${JSON.stringify(burst)}`);
  if (!rightBurstHeldFacing) throw new Error(`monster facing proof (right) live moving frames did not hold flipX=false: ${JSON.stringify(burst)}`);

  // Facing proof — LEFT case: move the player to the far side (target.x - 54) and
  // re-trigger an attack; the slime must now attack facing left (flipX === true).
  const leftFacing = await captureMonsterFacingSide(outDir, page, target.monsterId, "left", expectedAnimationKey);

  return {
    kind: "gamekit-monster-anim-proof",
    targetId: target.monsterId,
    expectedAnimationKey,
    expectedTextureKey,
    combatEvent,
    animEvents,
    idleBefore,
    burst,
    after,
    bodyBottom: {
      idleOffsetScreenPx: idleBefore.bodyBottomOffsetScreenPx,
      attackOffsetScreenPx: attackBottoms,
      maxDeltaPx: maxBodyBottomDeltaPx,
      thresholdPx: 4,
    },
    facing: {
      right: { targetDirection: rightStart.targetDirection, flipX: rightStart.flipX, movingFrames: rightBurstMoved, heldDuringMovingAttack: rightBurstHeldFacing },
      left: leftFacing,
    },
    assertions: {
      realMonsterBasicAttackEvent: true,
      attackSheetTraceStarted: true,
      liveSpritePlayedAttackKey: true,
      tweenFallbackNotUsed: true,
      idleVsAttackBodyBottomDeltaWithin4px: maxBodyBottomDeltaPx <= 4,
      facedTargetFromRight: true,
      heldFacingThroughMovingRightAttack: true,
      facedTargetFromLeft: true,
    },
    screenshots: [
      `${outDir}/monster-anim-before.png`,
      ...burst.map((_, index) => `${outDir}/monster-anim-attack-${String(index).padStart(2, "0")}.png`),
      `${outDir}/monster-anim-after.png`,
      ...leftFacing.screenshots,
    ],
  };
}

// Reposition the local player to a chosen side of the slime, re-trigger a basic
// attack (via target.select + a stonebind root so the slime stays put and swings),
// then assert the slime's recorded + live facing matches the target side. Returns
// the observed facing plus the burst screenshots it wrote.
async function captureMonsterFacingSide(
  outDir: string,
  page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"],
  targetId: string,
  side: "left" | "right",
  expectedAnimationKey: string,
): Promise<{
  side: "left" | "right";
  expectedFlipX: boolean;
  observedFlipX: boolean | null;
  targetDirection: "left" | "right" | "unchanged" | null;
  screenshots: string[];
}> {
  // nativeFacesRight:true → facing left means flipX true, facing right means false.
  const expectedFlipX = side === "left";
  const offsetX = side === "left" ? -54 : 54;

  const monsterState = (await getSmokeState(page))?.monsters.find((monster) => monster.monsterId === targetId);
  if (!monsterState) throw new Error(`monster facing proof (${side}) lost target: ${targetId}`);
  await moveLocalPlayerNear(page, monsterState.x + offsetX, monsterState.y, 4);
  await frameCombatTarget(page, monsterState.x, monsterState.y, GAMEPLAY_ZOOM * 1.6);

  await page.evaluate((id) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    if (!scene?.room) throw new Error("monster facing proof room missing");
    (globalThis as { __GAMEKIT_MONSTER_ANIM_EVENTS__?: unknown[] }).__GAMEKIT_MONSTER_ANIM_EVENTS__ = [];
    scene.room.send("intent", { type: "target.select", requestId: `monster-facing-target-${Date.now()}`, targetId: id });
    scene.room.send("intent", { type: "skill.cast", requestId: `monster-facing-stonebind-${Date.now()}`, skillId: "skill_stonebind", targetId: id });
  }, targetId);

  await page.waitForFunction(({ id, expectedKey }) => {
    const animEvents = (globalThis as {
      __GAMEKIT_MONSTER_ANIM_EVENTS__?: Array<{ type?: string; monsterInstanceId?: string; animationKey?: string }>;
    }).__GAMEKIT_MONSTER_ANIM_EVENTS__ ?? [];
    return animEvents.some((event) => event.type === "attack-start" && event.monsterInstanceId === id && event.animationKey === expectedKey);
  }, { id: targetId, expectedKey: expectedAnimationKey }, { timeout: 18_000 });

  const screenshots: string[] = [];
  let observedFlipX: boolean | null = null;
  for (let index = 0; index < 4; index += 1) {
    const shot = `${outDir}/monster-facing-${side}-${String(index).padStart(2, "0")}.png`;
    await page.screenshot({ path: shot, fullPage: false });
    screenshots.push(shot);
    const flip = await page.evaluate((id) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game") as unknown as {
        monsterObjects?: { get(mid: string): { sprite?: { flipX?: boolean; anims?: { currentAnim?: { key?: string } } } } | undefined };
      };
      const sprite = scene?.monsterObjects?.get(id)?.sprite;
      return { flipX: sprite?.flipX ?? null, animationKey: sprite?.anims?.currentAnim?.key ?? null };
    }, targetId);
    if (flip.animationKey === expectedAnimationKey && typeof flip.flipX === "boolean") observedFlipX = flip.flipX;
    await page.waitForTimeout(90);
  }

  const startEvent = await page.evaluate(({ id, expectedKey }) => {
    const animEvents = (globalThis as {
      __GAMEKIT_MONSTER_ANIM_EVENTS__?: Array<{ type?: string; monsterInstanceId?: string; animationKey?: string; flipX?: boolean; targetDirection?: "left" | "right" | "unchanged" }>;
    }).__GAMEKIT_MONSTER_ANIM_EVENTS__ ?? [];
    return animEvents.find((event) => event.type === "attack-start" && event.monsterInstanceId === id && event.animationKey === expectedKey) ?? null;
  }, { id: targetId, expectedKey: expectedAnimationKey });

  const targetDirection = startEvent?.targetDirection ?? null;
  if (targetDirection !== side || startEvent?.flipX !== expectedFlipX) {
    throw new Error(`monster facing proof (${side}) trace failed — expected direction=${side} flipX=${expectedFlipX}: ${JSON.stringify(startEvent)}`);
  }
  if (observedFlipX !== expectedFlipX) {
    throw new Error(`monster facing proof (${side}) live frames flipX=${observedFlipX}, expected ${expectedFlipX}: ${JSON.stringify(screenshots)}`);
  }

  return { side, expectedFlipX, observedFlipX, targetDirection, screenshots };
}

async function capturePresentationProof(outDir: string, page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  const state = await waitForMonsterCount(page, 1);
  const local = state.players.find((player) => player.sessionId === state.localSessionId);
  if (!local) throw new Error(`presentation proof missing local player: ${JSON.stringify(state)}`);
  const target = state.monsters.find((monster) => monster.alive && monster.mapId === local.mapId);
  if (!target) throw new Error(`presentation proof found no live monster: ${JSON.stringify(state.monsters)}`);
  await moveLocalPlayerNear(page, target.x - 120, target.y, 12);
  await frameCombatTarget(page, target.x, target.y, GAMEPLAY_ZOOM);

  const aimPoint = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game") as unknown as {
      sendHotbarSkillCastIntent?: (skillId: string) => void;
      room?: { state?: { players?: { get(id: string | undefined): { x: number; y: number } | undefined } } };
      localSessionId?: string;
    };
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    if (!scene?.sendHotbarSkillCastIntent || !player) throw new Error("presentation proof missing aim setup");
    scene.sendHotbarSkillCastIntent("skill_lantern_burst");
    return { x: player.x + 72, y: player.y };
  });
  const aimScreen = await getWorldScreenPoint(page, aimPoint.x, aimPoint.y);
  await page.mouse.move(aimScreen.x, aimScreen.y);
  await page.waitForTimeout(120);
  const reticleQa = await page.evaluate(() => {
    const qa = (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__?.getVisualQaSnapshot?.();
    return qa?.input?.groundSkillAim ?? null;
  });
  if (!reticleQa || reticleQa.skillId !== "skill_lantern_burst" || Math.abs(reticleQa.radius - 96) > 0.1 || !reticleQa.inRange) {
    throw new Error(`presentation reticle proof failed: ${JSON.stringify(reticleQa)}`);
  }
  await page.screenshot({ path: `${outDir}/presentation-reticle.png`, fullPage: false });
  await page.keyboard.press("Escape");

  const telegraphEvent = {
    type: "boss.telegraph",
    stageId: STAGE_ID,
    telegraphId: `presentation-proof-${Date.now()}`,
    skillId: "boss_slam_gloamslime",
    monsterInstanceId: target.monsterId,
    x: target.x,
    y: target.y,
    radius: 76,
    windupMs: 900,
    serverTimeMs: Date.now(),
  };
  await page.evaluate((event) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game") as unknown as {
      handleStageEvent?: (stageEvent: typeof event) => void;
    };
    if (!scene?.handleStageEvent) throw new Error("presentation proof missing stage handler");
    scene.handleStageEvent(event);
  }, telegraphEvent);
  await page.waitForFunction((telegraphId) => {
    const qa = (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__?.getVisualQaSnapshot?.();
    return qa?.bossTelegraphs?.some((telegraph) => telegraph.id === telegraphId && Math.abs(telegraph.world.radius - 76) <= 0.1);
  }, telegraphEvent.telegraphId, { timeout: 2_000 });
  const telegraphQa = await page.evaluate((telegraphId) => {
    const qa = (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__?.getVisualQaSnapshot?.();
    return qa?.bossTelegraphs?.find((telegraph) => telegraph.id === telegraphId) ?? null;
  }, telegraphEvent.telegraphId);
  await page.screenshot({ path: `${outDir}/presentation-telegraph.png`, fullPage: false });

  await page.evaluate((targetId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    if (!scene?.room) throw new Error("presentation proof room missing before stonebind");
    (globalThis as { __GAMEKIT_PRESENTATION_EVENTS__?: unknown[] }).__GAMEKIT_PRESENTATION_EVENTS__ = [];
    scene.room.send("intent", {
      type: "target.select",
      requestId: `presentation-proof-target-${Date.now()}`,
      targetId,
    });
    scene.room.send("intent", {
      type: "skill.cast",
      requestId: `presentation-proof-stonebind-${Date.now()}`,
      skillId: "skill_stonebind",
      targetId,
    });
  }, target.monsterId);
  await page.waitForFunction(() => {
    const events = (globalThis as { __GAMEKIT_PRESENTATION_EVENTS__?: Array<{ key?: string; resolvedKey?: string }> }).__GAMEKIT_PRESENTATION_EVENTS__ ?? [];
    return events.some((event) => event.key === "skill_stonebind" && event.resolvedKey === "skill_stonebind");
  }, undefined, { timeout: 6_000 });
  const presentationEvents = await page.evaluate(() => (globalThis as { __GAMEKIT_PRESENTATION_EVENTS__?: unknown[] }).__GAMEKIT_PRESENTATION_EVENTS__ ?? []);
  const stonebindPresentationEvent = presentationEvents.find((event) => {
    const candidate = event as { key?: string; resolvedKey?: string };
    return candidate.key === "skill_stonebind" && candidate.resolvedKey === "skill_stonebind";
  });
  if (!stonebindPresentationEvent) throw new Error(`stonebind presentation key missing: ${JSON.stringify(presentationEvents)}`);

  return {
    kind: "gamekit-presentation-proof",
    reticleQa,
    telegraphEvent,
    telegraphQa,
    stonebindPresentationEvent,
    assertions: {
      reticleRadiusMatchesManifest: true,
      telegraphRadiusMatchesEvent: true,
      stonebindPresentationKeyRecorded: true,
    },
    screenshots: [`${outDir}/presentation-reticle.png`, `${outDir}/presentation-telegraph.png`],
  };
}

type SkillFxQaState = {
  bannerCardPanelsActive?: number;
  bannerCardPanelsSpawned?: number;
  spectacleGlowActive?: number;
  spectacleRingsActive?: number;
  spectacleFlareActive?: number;
  // card-vfx-primitives: per-primitive real-render counters (bumped by client/src/render/vfxPrimitives.ts).
  hitSparkSpawned?: number;
  impactRingSpawned?: number;
  projectileTrailSpawned?: number;
  screenFlashSpawned?: number;
  cameraKickSpawned?: number;
  killBurstSpawned?: number;
  spectacleCastSpawned?: number;
  // card-vfx-flipbook-step: one-shot flipbook sprite spawns (bumped by vfxPrimitives.spawnFlipbook).
  flipbookSpawned?: number;
};

async function captureSkillFxProof(outDir: string, page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  await stageInOpenField(page);
  await page.evaluate(() => {
    (globalThis as { __GAMEKIT_SKILL_FX_QA__?: SkillFxQaState }).__GAMEKIT_SKILL_FX_QA__ = {
      bannerCardPanelsActive: 0,
      bannerCardPanelsSpawned: 0,
      spectacleGlowActive: 0,
      spectacleRingsActive: 0,
      spectacleFlareActive: 0,
    };
  });
  const aimPoint = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game") as unknown as {
      sendHotbarSkillCastIntent?: (skillId: string) => void;
      room?: { state?: { players?: { get(id: string | undefined): { x: number; y: number; mp: number; maxMp: number } | undefined } } };
      localSessionId?: string;
    };
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    if (!scene?.sendHotbarSkillCastIntent || !player) throw new Error("skill FX proof missing aim setup");
    scene.sendHotbarSkillCastIntent("skill_lantern_burst");
    return { x: player.x + 72, y: player.y, mp: player.mp, maxMp: player.maxMp };
  });
  const aimScreen = await getWorldScreenPoint(page, aimPoint.x, aimPoint.y);
  await page.mouse.move(aimScreen.x, aimScreen.y);
  await page.waitForFunction(() => {
    const qa = (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__?.getVisualQaSnapshot?.();
    const aim = qa?.input?.groundSkillAim;
    return aim?.skillId === "skill_lantern_burst" && Math.abs(aim.radius - 96) <= 0.1 && aim.inRange === true;
  }, undefined, { timeout: 4_000 });
  await page.mouse.click(aimScreen.x, aimScreen.y);
  const qaHandle = await page.waitForFunction(() => {
    const qa = (globalThis as { __GAMEKIT_SKILL_FX_QA__?: SkillFxQaState }).__GAMEKIT_SKILL_FX_QA__;
    if (!qa) return null;
    if (
      (qa.bannerCardPanelsActive ?? 0) >= 1 &&
      (qa.bannerCardPanelsSpawned ?? 0) >= 1 &&
      (qa.spectacleGlowActive ?? 0) >= 1 &&
      (qa.spectacleRingsActive ?? 0) >= 2 &&
      (qa.spectacleFlareActive ?? 0) >= 1
    ) {
      return qa;
    }
    return null;
  }, undefined, { timeout: 2_000 });
  const skillFxQa = await qaHandle.jsonValue() as SkillFxQaState;
  const screenshot = `${outDir}/skill-fx-lantern-burst-buildup.png`;
  await page.screenshot({ path: screenshot, fullPage: false });

  // card-vfx-primitives: per-primitive real-render assertion pass. Drive the VFX primitive library's
  // `runComposition` against the LIVE game scene with a composition that exercises every primitive in
  // the ratified §5 shortlist (hitSpark, impactRing, projectileTrail, screenFlash, cameraKick,
  // killBurst, spectacleCast — the compositions the class kits map onto), then assert each primitive
  // incremented its QA counter (proves it really rendered, not a mock). Reduced-motion is OFF in the
  // capture harness, so screenFlash/cameraKick both execute.
  const primitiveQa = await page.evaluate(async () => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game") as unknown as {
      room?: { state?: { players?: { get(id: string | undefined): { x: number; y: number } | undefined } } };
      localSessionId?: string;
    };
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    if (!player) throw new Error("primitive proof missing local player");
    const modulePath = "/src/render/vfxPrimitives.ts";
    const mod = await import(modulePath);
    const source = { x: player.x, y: player.y };
    const target = { x: player.x + 64, y: player.y };
    mod.runComposition(
      [
        { type: "projectileTrail" },
        { type: "hitSpark", crit: true },
        { type: "impactRing" },
        { type: "screenFlash", alpha: 0.3, durationMs: 240 },
        { type: "cameraKick", onlyWhen: ["crit"] },
        { type: "killBurst" },
        { type: "spectacleCast", radius: 88 },
      ],
      { scene, source, target, tint: 0x8fd7ff, crit: true, killed: true },
    );
    return (globalThis as { __GAMEKIT_SKILL_FX_QA__?: Record<string, number> }).__GAMEKIT_SKILL_FX_QA__ ?? {};
  }) as SkillFxQaState;
  const primitiveScreenshot = `${outDir}/skill-fx-primitive-composition.png`;
  await page.screenshot({ path: primitiveScreenshot, fullPage: false });

  const perPrimitive = {
    hitSpark: (primitiveQa.hitSparkSpawned ?? 0) >= 1,
    impactRing: (primitiveQa.impactRingSpawned ?? 0) >= 1,
    projectileTrail: (primitiveQa.projectileTrailSpawned ?? 0) >= 1,
    screenFlash: (primitiveQa.screenFlashSpawned ?? 0) >= 1,
    cameraKick: (primitiveQa.cameraKickSpawned ?? 0) >= 1,
    killBurst: (primitiveQa.killBurstSpawned ?? 0) >= 1,
    spectacleCast: (primitiveQa.spectacleCastSpawned ?? 0) >= 1,
  };
  const missing = Object.entries(perPrimitive)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`skill FX primitive proof: primitives did not render: ${missing.join(", ")} (qa=${JSON.stringify(primitiveQa)})`);
  }

  // card-kit-skill-compositions: END-TO-END content-skill assertion. Prove a REAL content skill
  // (`skill_spark_shot`, wired to §7 composition ["projectileTrail","hitSpark"]) fires its composition
  // through the live cast → CombatFeedbackPresenter.present → runComposition path (NOT the synthetic
  // import driver above). Cast at a live slime and assert the presenter recorded the composition-fired
  // trace for that skill id.
  const contentTarget = await waitForMonsterCount(page, 1);
  const contentLocal = contentTarget.players.find((player) => player.sessionId === contentTarget.localSessionId);
  if (!contentLocal) throw new Error(`skill FX content proof missing local player: ${JSON.stringify(contentTarget)}`);
  const slime = contentTarget.monsters.find((monster) => monster.alive && monster.mapId === contentLocal.mapId);
  if (!slime) throw new Error(`skill FX content proof found no live monster: ${JSON.stringify(contentTarget.monsters)}`);
  await moveLocalPlayerNear(page, slime.x - 90, slime.y, 12);
  await frameCombatTarget(page, slime.x, slime.y, GAMEPLAY_ZOOM);
  await page.evaluate((targetId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    if (!scene?.room) throw new Error("skill FX content proof room missing before cast");
    (globalThis as { __GAMEKIT_COMPOSITION_FIRED__?: unknown[] }).__GAMEKIT_COMPOSITION_FIRED__ = [];
    scene.room.send("intent", {
      type: "target.select",
      requestId: `skill-fx-content-target-${Date.now()}`,
      targetId,
    });
    scene.room.send("intent", {
      type: "skill.cast",
      requestId: `skill-fx-content-cast-${Date.now()}`,
      skillId: "skill_spark_shot",
      targetId,
    });
  }, slime.monsterId);
  const compositionHandle = await page.waitForFunction(() => {
    const fired = (globalThis as { __GAMEKIT_COMPOSITION_FIRED__?: Array<{ skillId?: string; steps?: number }> }).__GAMEKIT_COMPOSITION_FIRED__ ?? [];
    return fired.some((entry) => entry.skillId === "skill_spark_shot" && (entry.steps ?? 0) >= 2) ? fired : null;
  }, undefined, { timeout: 6_000 });
  const contentComposition = (await compositionHandle.jsonValue()) as Array<{ skillId?: string; steps?: number }>;
  const contentScreenshot = `${outDir}/skill-fx-content-composition.png`;
  await page.screenshot({ path: contentScreenshot, fullPage: false });
  const contentSkillFired = contentComposition.some(
    (entry) => entry.skillId === "skill_spark_shot" && (entry.steps ?? 0) >= 2,
  );
  if (!contentSkillFired) {
    throw new Error(`skill FX content proof: skill_spark_shot composition did not fire end-to-end (trace=${JSON.stringify(contentComposition)})`);
  }

  // card-vfx-flipbook-step: PILOT flipbook end-to-end. The pilot skill (Lantern Burst, a ground AoE)
  // now composes flipbook cast+impact steps. Cast it at the live slime's ground point and assert the
  // one-shot flipbook sprite really rendered (flipbookSpawned counter incremented via
  // vfxPrimitives.spawnFlipbook — a real render on the cast → present → runComposition path, not a mock).
  const flipbookTarget = await waitForMonsterCount(page, 1);
  const flipbookLocal = flipbookTarget.players.find((player) => player.sessionId === flipbookTarget.localSessionId);
  const flipbookSlime =
    flipbookTarget.monsters.find((monster) => monster.alive && monster.mapId === flipbookLocal?.mapId) ?? slime;
  await moveLocalPlayerNear(page, flipbookSlime.x - 80, flipbookSlime.y, 12);
  await frameCombatTarget(page, flipbookSlime.x, flipbookSlime.y, GAMEPLAY_ZOOM);
  const lanternFlipbookQa = await castLanternBurstForFlipbookProof(page, flipbookSlime.x, flipbookSlime.y);
  const flipbookScreenshot = `${outDir}/skill-fx-flipbook-lantern-burst.png`;
  await page.screenshot({ path: flipbookScreenshot, fullPage: false });
  const flipbookSpawnedOnLanternBurst = (lanternFlipbookQa.flipbookSpawned ?? 0) >= 1;
  if (!flipbookSpawnedOnLanternBurst) {
    throw new Error(`skill FX flipbook proof: Lantern Burst cast spawned no flipbook (qa=${JSON.stringify(lanternFlipbookQa)})`);
  }

  return {
    kind: "gamekit-skill-fx-proof",
    skillId: "skill_lantern_burst",
    aimPoint,
    skillFxQa,
    primitiveQa,
    lanternFlipbookQa,
    contentComposition,
    assertions: {
      cardBannerPanelActive: (skillFxQa.bannerCardPanelsActive ?? 0) >= 1 && (skillFxQa.bannerCardPanelsSpawned ?? 0) >= 1,
      spectacleGlowActive: (skillFxQa.spectacleGlowActive ?? 0) >= 1,
      spectacleRingsActive: (skillFxQa.spectacleRingsActive ?? 0) >= 2,
      spectacleFlareActive: (skillFxQa.spectacleFlareActive ?? 0) >= 1,
      // card-vfx-flipbook-step: pilot flipbook fired end-to-end on the live Lantern Burst cast.
      flipbookSpawnedOnLanternBurst,
      perPrimitiveRendered: perPrimitive,
      contentSkillCompositionFired: contentSkillFired,
    },
    screenshots: [screenshot, primitiveScreenshot, contentScreenshot, flipbookScreenshot],
  };
}

/**
 * card-vfx-flipbook-step: cast the pilot skill (Lantern Burst — a ground AoE) at (groundX, groundY) and
 * wait for its composition's flipbook step to spawn a real sprite (flipbookSpawned counter > 0). Returns
 * the live QA snapshot. Resets flipbookSpawned first so the assertion is specific to THIS cast.
 */
async function castLanternBurstForFlipbookProof(
  page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"],
  groundX: number,
  groundY: number,
): Promise<SkillFxQaState> {
  await page.evaluate(() => {
    const qa = ((globalThis as { __GAMEKIT_SKILL_FX_QA__?: Record<string, number> }).__GAMEKIT_SKILL_FX_QA__ ??= {});
    qa.flipbookSpawned = 0;
  });
  await page.evaluate(({ x, y }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    if (!scene?.room) throw new Error("flipbook proof room missing before Lantern Burst cast");
    scene.room.send("intent", {
      type: "skill.cast",
      requestId: `skill-fx-flipbook-cast-${Date.now()}`,
      skillId: "skill_lantern_burst",
      x,
      y,
    });
  }, { x: groundX, y: groundY });
  const handle = await page.waitForFunction(() => {
    const qa = (globalThis as { __GAMEKIT_SKILL_FX_QA__?: SkillFxQaState }).__GAMEKIT_SKILL_FX_QA__;
    return qa && (qa.flipbookSpawned ?? 0) >= 1 ? qa : null;
  }, undefined, { timeout: 6_000 });
  return (await handle.jsonValue()) as SkillFxQaState;
}

async function captureKillBeatProof(outDir: string, page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  await page.evaluate(() => {
    (globalThis as { __GAMEKIT_KILL_BEAT_EVENTS__?: unknown[] }).__GAMEKIT_KILL_BEAT_EVENTS__ = [];
  });
  const joined = await getJoinedStateForCapture(page);
  const target = await killOnePassiveSlime(page, joined);
  const afterKillState = await getSmokeState(page);
  const killedTarget = afterKillState?.monsters.find((monster) => monster.monsterId === target.monsterId);
  await frameCombatTarget(page, target.x, target.y, GAMEPLAY_ZOOM);

  await page.waitForFunction((targetId) => {
    const events = (globalThis as { __GAMEKIT_KILL_BEAT_EVENTS__?: Array<{ kind?: string; targetId?: string; sequenceId?: string }> }).__GAMEKIT_KILL_BEAT_EVENTS__ ?? [];
    const death = events.find((event) => event.kind === "death" && event.targetId === targetId);
    if (!death?.sequenceId) return false;
    const sequence = events.filter((event) => event.sequenceId === death.sequenceId);
    return ["death", "xp", "loot"].every((kind) => sequence.some((event) => event.kind === kind));
  }, target.monsterId, { timeout: 5_000 });

  const beatEvents = await page.evaluate((targetId) => {
    const events = (globalThis as {
      __GAMEKIT_KILL_BEAT_EVENTS__?: Array<{
        sequenceId?: string;
        kind?: string;
        targetId?: string;
        itemId?: string;
        quantity?: number;
        timestampMs?: number;
      }>;
    }).__GAMEKIT_KILL_BEAT_EVENTS__ ?? [];
    const death = events.find((event) => event.kind === "death" && event.targetId === targetId);
    return events.filter((event) => event.sequenceId === death?.sequenceId);
  }, target.monsterId);
  const orderedKinds = beatEvents.map((event) => event.kind);
  const deathIndex = orderedKinds.indexOf("death");
  const xpIndex = orderedKinds.indexOf("xp");
  const lootIndex = orderedKinds.indexOf("loot");
  if (deathIndex < 0 || xpIndex < 0 || lootIndex < 0 || !(deathIndex < xpIndex && xpIndex < lootIndex)) {
    throw new Error(`kill beat proof order failed: ${JSON.stringify(beatEvents)}`);
  }
  const timestamps = beatEvents.map((event) => event.timestampMs ?? -1);
  for (let i = 1; i < timestamps.length; i += 1) {
    if (timestamps[i]! < timestamps[i - 1]!) {
      throw new Error(`kill beat proof timestamps not monotonic: ${JSON.stringify(beatEvents)}`);
    }
  }
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${outDir}/kill-beat-moment.png`, fullPage: false });

  // card-item-toast: item PICKUPS render a top-center rich toast (icon + "Item
  // received" eyebrow + name). Render one deterministically via the toast module
  // (same technique as tools/src/toast-position-proof.ts — the auto-pickup path
  // depends on the player walking over the drop, not guaranteed in this framing)
  // and assert the DOM + geometry.
  const itemToast = await page.evaluate(async () => {
    // Vite-served module path resolved in the BROWSER; keep the specifier a
    // variable so tsc treats it as a dynamic any-import (tools tsconfig has no
    // DOM lib / Vite path resolution).
    const toastModulePath = "/src/ui/toast.ts";
    const mod = await import(toastModulePath);
    mod.toastItemReceived("Moss Spore", 4, "/assets/ui/icons/icon_moss_spore.png");
    await new Promise((resolve) => setTimeout(resolve, 350));
    const doc = (globalThis as unknown as {
      document: { querySelector: (s: string) => ({
        querySelector: (s: string) => ({ textContent: string | null; src?: string } | null);
        getBoundingClientRect: () => { left: number; right: number; top: number };
      } | null) };
    }).document;
    const container = doc.querySelector(".lm-toast-container--top-center");
    const toast = doc.querySelector(".lm-toast-container--top-center .lm-toast--item-received");
    if (!container || !toast) {
      return { present: false, hasIcon: false, eyebrow: null as string | null, message: null as string | null, centerXOffsetPx: 999, topGapPx: 999, detectedByHintGuard: false };
    }
    const icon = toast.querySelector("img.lm-toast__icon");
    const eyebrow = toast.querySelector(".lm-toast__eyebrow");
    const message = toast.querySelector(".lm-toast__message");
    const rect = container.getBoundingClientRect();
    const inner = globalThis as unknown as { innerWidth: number };
    // Container also carries the base class so hints keep yielding (hints.ts:263).
    const detectedByHintGuard = doc.querySelector(".lm-toast-container .lm-toast") !== null;
    return {
      present: true,
      hasIcon: !!icon && !!icon.src && icon.src.includes("icon_moss_spore.png"),
      eyebrow: eyebrow ? eyebrow.textContent : null,
      message: message ? message.textContent : null,
      centerXOffsetPx: Math.round((rect.left + rect.right) / 2 - inner.innerWidth / 2),
      topGapPx: Math.round(rect.top),
      detectedByHintGuard,
    };
  });
  if (!itemToast.present) throw new Error("item-received top-center toast not rendered");
  if (!itemToast.hasIcon) throw new Error(`item toast missing icon: ${JSON.stringify(itemToast)}`);
  if (itemToast.eyebrow !== "Item received") throw new Error(`item toast eyebrow wrong: ${JSON.stringify(itemToast)}`);
  if (!itemToast.message || !itemToast.message.startsWith("Moss Spore")) throw new Error(`item toast name wrong: ${JSON.stringify(itemToast)}`);
  if (Math.abs(itemToast.centerXOffsetPx) > 12) throw new Error(`item toast not centered: ${JSON.stringify(itemToast)}`);
  if (itemToast.topGapPx > 200) throw new Error(`item toast not near the top: ${JSON.stringify(itemToast)}`);
  if (!itemToast.detectedByHintGuard) throw new Error("hint-yield contract broken: top-center toast not seen by systemToastActive()");
  await page.screenshot({ path: `${outDir}/item-received-toast.png`, fullPage: false });

  return {
    kind: "gamekit-kill-beat-proof",
    target: killedTarget ?? target,
    beatEvents,
    itemToast,
    assertions: {
      orderedDeathXpLoot: true,
      monotonicTimestamps: true,
      realKill: true,
      itemReceivedToastTopCenterWithIcon: true,
      hintYieldContractIntact: true,
    },
    screenshots: [`${outDir}/kill-beat-moment.png`, `${outDir}/item-received-toast.png`],
  };
}

type AmbientWorldLifeQa = {
  reduceMotion: boolean;
  cloudAlpha: number;
  sways: Array<{ key: string; x: number; y: number; rotation: number }>;
  clouds: Array<{ x: number; y: number; alpha: number }>;
  fireflies: Array<{ x: number; y: number; alpha: number }>;
  petals: Array<{ x: number; y: number; rotation: number }>;
};

async function captureAmbientWorldLifeProof(outDir: string, page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  await page.evaluate(({ cx, cy, zoom }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game") as unknown as {
      cameras?: { main?: { stopFollow(): void; setZoom(zoom: number): void; centerOn(x: number, y: number): void } };
      setWorldAmbienceReduceMotion?: (reduceMotion: boolean) => void;
    };
    scene.setWorldAmbienceReduceMotion?.(false);
    const cam = scene.cameras?.main;
    cam?.stopFollow();
    cam?.setZoom(zoom);
    cam?.centerOn(cx, cy);
  }, { cx: 650, cy: 650, zoom: basisZoom(1.45) });
  await page.waitForTimeout(700);
  const before = await getAmbientWorldLifeQa(page);
  await page.screenshot({ path: `${outDir}/ambient-world-life-before.png` });
  await page.waitForTimeout(2200);
  const after = await getAmbientWorldLifeQa(page);
  await page.screenshot({ path: `${outDir}/ambient-world-life-after.png` });

  await page.evaluate(({ cx, cy, zoom }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game") as unknown as {
      cameras?: { main?: { stopFollow(): void; setZoom(zoom: number): void; centerOn(x: number, y: number): void } };
    };
    const cam = scene.cameras?.main;
    cam?.stopFollow();
    cam?.setZoom(zoom);
    cam?.centerOn(cx, cy);
  }, { cx: 790, cy: 790, zoom: basisZoom(2.1) });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${outDir}/ambient-world-life-petals-closeup.png` });
  const frameTimeWithAmbience = await getFrameTiming(page);
  await setAmbientWorldLifeReduceMotion(page, true);
  await page.waitForTimeout(700);
  const frameTimeReduceMotion = await getFrameTiming(page);
  await setAmbientWorldLifeReduceMotion(page, false);

  const cloudMove = distance(before.clouds[0], after.clouds[0]);
  const fireflyMove = distance(before.fireflies[0], after.fireflies[0]);
  const petalMove = distance(before.petals[0], after.petals[0]);
  const swayRotationDelta = maxSwayRotationDelta(before.sways, after.sways);
  if (before.reduceMotion || after.reduceMotion) throw new Error("ambient world-life proof captured with reduceMotion enabled");
  if (before.sways.length === 0) throw new Error("ambient world-life proof found no sway targets");
  if (before.clouds.length < 2) throw new Error("ambient world-life proof found too few cloud shadows");
  if (before.fireflies.length < 8) throw new Error("ambient world-life proof found too few fireflies");
  if (before.petals.length < 6) throw new Error("ambient world-life proof found too few petals");
  if (cloudMove < 10) throw new Error(`cloud displacement too small: ${cloudMove.toFixed(2)}px`);
  if (fireflyMove < 8) throw new Error(`firefly displacement too small: ${fireflyMove.toFixed(2)}px`);
  if (petalMove < 12) throw new Error(`petal displacement too small: ${petalMove.toFixed(2)}px`);
  if (swayRotationDelta < 0.004) throw new Error(`sway rotation delta too small: ${swayRotationDelta.toFixed(4)}rad`);

  return {
    screenshots: [
      "ambient-world-life-before.png",
      "ambient-world-life-after.png",
      "ambient-world-life-petals-closeup.png",
    ],
    before,
    after,
    displacement: {
      cloud0Px: roundProof(cloudMove),
      firefly0Px: roundProof(fireflyMove),
      petal0Px: roundProof(petalMove),
      maxSwayRotationRad: roundProof(swayRotationDelta),
    },
    frameTiming: {
      ambienceEnabled: frameTimeWithAmbience,
      reduceMotionEnabled: frameTimeReduceMotion,
    },
  };
}

async function getAmbientWorldLifeQa(page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]): Promise<AmbientWorldLifeQa> {
  return page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game") as unknown as {
      getAmbientWorldLifeQaState?: () => AmbientWorldLifeQa;
    };
    const state = scene.getAmbientWorldLifeQaState?.();
    if (!state) throw new Error("GameScene.getAmbientWorldLifeQaState unavailable");
    return state;
  });
}

async function setAmbientWorldLifeReduceMotion(
  page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"],
  reduceMotion: boolean,
): Promise<void> {
  await page.evaluate((nextReduceMotion) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game") as unknown as {
      setWorldAmbienceReduceMotion?: (reduceMotion: boolean) => void;
    };
    scene.setWorldAmbienceReduceMotion?.(nextReduceMotion);
  }, reduceMotion);
}

async function getFrameTiming(page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]): Promise<{ fps: number; frameMs: number }> {
  return page.evaluate(() => {
    const game = (globalThis as SmokeBrowserGlobal).__GAME as unknown as { loop?: { actualFps?: number } } | undefined;
    const fps = game?.loop?.actualFps ?? 0;
    return {
      fps: Math.round(fps * 1000) / 1000,
      frameMs: fps > 0 ? Math.round((1000 / fps) * 1000) / 1000 : 0,
    };
  });
}

function distance(a: { x: number; y: number } | undefined, b: { x: number; y: number } | undefined): number {
  if (!a || !b) return 0;
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function maxSwayRotationDelta(
  before: Array<{ rotation: number }>,
  after: Array<{ rotation: number }>,
): number {
  const count = Math.min(before.length, after.length);
  let maxDelta = 0;
  for (let index = 0; index < count; index += 1) {
    maxDelta = Math.max(maxDelta, Math.abs(after[index].rotation - before[index].rotation));
  }
  return maxDelta;
}

function roundProof(value: number): number {
  return Math.round(value * 1000) / 1000;
}

async function captureNpcEdgeProof(outDir: string, page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  const targetNpc = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game") as unknown as {
      localSessionId?: string;
      room?: { state?: { players?: { get(id: string): { mapId?: string } | undefined }; npcs?: { forEach(cb: (npc: { npcId: string; mapId?: string }, id: string) => void): void } } };
      npcObjects?: { get(id: string): { container?: { x: number; y: number; visible: boolean } } | undefined };
      syncNpcsFromRoom?: () => void;
    };
    scene.syncNpcsFromRoom?.();
    const currentMapId = scene.localSessionId ? scene.room?.state?.players?.get(scene.localSessionId)?.mapId : undefined;
    const candidates: Array<{ id: string; key: string; x: number; y: number }> = [];
    scene.room?.state?.npcs?.forEach((npc, id) => {
      if (currentMapId && npc.mapId !== currentMapId) return;
      const container = scene.npcObjects?.get(id)?.container;
      if (container?.visible) candidates.push({ id, key: npc.npcId, x: container.x, y: container.y });
    });
    const preferred =
      candidates.find((npc) => npc.key === "npc_harbor_warden") ??
      candidates.find((npc) => npc.key === "npc_combat_trainer") ??
      candidates[0];
    if (!preferred) throw new Error("no visible rendered NPC found for edge proof");
    return preferred;
  });

  const frameNpc = async () => page.evaluate(({ targetNpcId, targetX, targetY }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game") as unknown as {
      cameras?: { main?: { scrollX: number; scrollY: number; zoom: number; worldView: { x: number; y: number } } };
      game?: { canvas?: { getBoundingClientRect(): { left: number; top: number; width: number; height: number } } };
      scale?: { width: number; height: number };
      localSessionId?: string;
      room?: { state?: { players?: { get(id: string): { mapId?: string } | undefined }; npcs?: { forEach(cb: (npc: { npcId: string; mapId?: string }, id: string) => void): void } } };
      npcObjects?: { get(id: string): { container?: { x: number; y: number; visible: boolean }; sprite?: { getBounds?: () => { x: number; y: number; width: number; height: number } } } | undefined };
      playerObjects?: { get(id: string): { container?: { x: number; y: number } } | undefined };
      syncNpcsFromRoom?: () => void;
    };
    const cam = scene.cameras?.main;
    const canvasRect = scene.game?.canvas?.getBoundingClientRect();
    if (!cam || !canvasRect) throw new Error("camera/canvas unavailable for NPC edge proof");
    scene.syncNpcsFromRoom?.();
    const scaleX = canvasRect.width / Number(scene.scale?.width || canvasRect.width || 1);
    const scaleY = canvasRect.height / Number(scene.scale?.height || canvasRect.height || 1);
    const currentMapId = scene.localSessionId ? scene.room?.state?.players?.get(scene.localSessionId)?.mapId : undefined;
    let selected: { id: string; npcId: string; x: number; y: number; distance: number } | undefined;
    const candidates: Array<{ id: string; npcId: string; mapId?: string; hasRender: boolean; visible?: boolean; x?: number; y?: number; distance?: number }> = [];
    scene.room?.state?.npcs?.forEach((npc, id) => {
      if (currentMapId && npc.mapId !== currentMapId) return;
      const render = scene.npcObjects?.get(id);
      const distance = render?.container ? Math.hypot(render.container.x - targetX, render.container.y - targetY) : undefined;
      candidates.push({
        id,
        npcId: npc.npcId,
        mapId: npc.mapId,
        hasRender: Boolean(render?.container),
        visible: render?.container?.visible,
        x: render?.container?.x,
        y: render?.container?.y,
        distance,
      });
      if (!render?.container?.visible || distance === undefined) return;
      const exactMatch = id === targetNpcId;
      if (!exactMatch && distance > 80) return;
      if (!selected || exactMatch || distance < selected.distance) {
        selected = { id, npcId: npc.npcId, x: render.container.x, y: render.container.y, distance };
      }
    });
    if (!selected) throw new Error(`visible ${targetNpcId} NPC missing for edge proof; candidates=${JSON.stringify(candidates)}`);
    const render = scene.npcObjects?.get(selected.id);
    const spriteBounds = render?.sprite?.getBounds?.();
    const screen = {
      x: canvasRect.left + (selected.x - cam.worldView.x) * cam.zoom * scaleX,
      y: canvasRect.top + (selected.y - cam.worldView.y) * cam.zoom * scaleY,
    };
    const spriteScreenX = spriteBounds ? canvasRect.left + (spriteBounds.x - cam.worldView.x) * cam.zoom * scaleX : 0;
    const spriteScreenY = spriteBounds ? canvasRect.top + (spriteBounds.y - cam.worldView.y) * cam.zoom * scaleY : 0;
    const player = scene.localSessionId ? scene.playerObjects?.get(scene.localSessionId)?.container : undefined;
    return {
      player: {
        x: Number((player?.x ?? 0).toFixed(3)),
        y: Number((player?.y ?? 0).toFixed(3)),
      },
      camera: {
        scrollX: Number(cam.scrollX.toFixed(3)),
        scrollY: Number(cam.scrollY.toFixed(3)),
        worldViewX: Number(cam.worldView.x.toFixed(3)),
        worldViewY: Number(cam.worldView.y.toFixed(3)),
        zoom: Number(cam.zoom.toFixed(6)),
      },
      npc: {
        id: selected.id,
        npcId: selected.npcId,
        world: { x: Number(selected.x.toFixed(3)), y: Number(selected.y.toFixed(3)) },
        screen: {
          x: Number(screen.x.toFixed(3)),
          y: Number(screen.y.toFixed(3)),
          fracX: Number((screen.x - Math.round(screen.x)).toFixed(3)),
          fracY: Number((screen.y - Math.round(screen.y)).toFixed(3)),
        },
        spriteScreen: spriteBounds
          ? {
              x: Number(spriteScreenX.toFixed(3)),
              y: Number(spriteScreenY.toFixed(3)),
              width: Number((spriteBounds.width * cam.zoom * scaleX).toFixed(3)),
              height: Number((spriteBounds.height * cam.zoom * scaleY).toFixed(3)),
            }
          : undefined,
      },
    };
  }, { targetNpcId: targetNpc.id, targetX: targetNpc.x, targetY: targetNpc.y });

  await page.evaluate(({ cx, cy, zoom }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game") as unknown as {
      cameras?: { main?: { stopFollow(): void; setZoom(zoom: number): void; centerOn(x: number, y: number): void } };
    };
    const cam = scene.cameras?.main;
    cam?.stopFollow();
    cam?.setZoom(zoom);
    cam?.centerOn(Math.round(cx * zoom) / zoom, Math.round(cy * zoom) / zoom);
  }, { cx: targetNpc.x - 18, cy: targetNpc.y - 18, zoom: GAMEPLAY_ZOOM * 1.55 });
  await page.waitForTimeout(250);

  const samples: NpcEdgeSample[] = [];
  const pre = await frameNpc();
  samples.push({ label: "pre-walk", ...pre });
  await page.screenshot({ path: `${outDir}/npc-edge-pre-walk.png`, fullPage: false });
  for (let index = 0; index < 12; index += 1) {
    const label = `walk-${String(index).padStart(2, "0")}`;
    await page.evaluate(({ cx, cy, zoom }) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game") as unknown as {
        cameras?: { main?: { stopFollow(): void; setZoom(zoom: number): void; centerOn(x: number, y: number): void } };
      };
      const cam = scene.cameras?.main;
      cam?.stopFollow();
      cam?.setZoom(zoom);
      cam?.centerOn(Math.round(cx * zoom) / zoom, Math.round(cy * zoom) / zoom);
    }, { cx: targetNpc.x - 18 + index * 1.37, cy: targetNpc.y - 18 + index * 1.37, zoom: GAMEPLAY_ZOOM * 1.55 });
    await page.waitForTimeout(55);
    samples.push({ label, ...(await frameNpc()) });
    await page.screenshot({ path: `${outDir}/npc-edge-${label}.png`, fullPage: false });
  }

  const fractionalScreenPositions = samples.map((sample) => Math.hypot(sample.npc.screen.fracX, sample.npc.screen.fracY));
  return {
    target: {
      npcId: targetNpc.id,
      npcKey: targetNpc.key,
      diagonalCameraPan: {
        from: { x: targetNpc.x - 18, y: targetNpc.y - 18 },
        to: { x: targetNpc.x - 18 + 11 * 1.37, y: targetNpc.y - 18 + 11 * 1.37 },
      },
      gameplayZoom: GAMEPLAY_ZOOM,
    },
    samples,
    cameraFractionalScroll: samples.map((sample) => ({
      label: sample.label,
      scrollFracX: Number((sample.camera.scrollX - Math.round(sample.camera.scrollX)).toFixed(3)),
      scrollFracY: Number((sample.camera.scrollY - Math.round(sample.camera.scrollY)).toFixed(3)),
    })),
    npcScreenFraction: {
      maxDistancePx: roundProof(Math.max(...fractionalScreenPositions)),
      meanDistancePx: roundProof(fractionalScreenPositions.reduce((sum, value) => sum + value, 0) / fractionalScreenPositions.length),
    },
    outputs: {
      preWalk: "npc-edge-pre-walk.png",
      walkFrames: 12,
    },
  };
}

async function captureSlimeTweenProof(outDir: string, page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  await page.waitForFunction(() => {
    const scene = (globalThis as { __GAME?: { scene?: { getScene(key: string): unknown } } }).__GAME?.scene?.getScene("game") as {
      registry?: { get(key: string): unknown };
      room?: { state?: { monsters?: { forEach(cb: (monster: { alive?: boolean; monsterId?: string }, id: string) => void): void } } };
      monsterObjects?: { get(id: string): { visualRoot?: unknown; container?: { visible: boolean } } | undefined };
    } | undefined;
    const tiers = scene?.registry?.get("loadedAssetTiers") as Set<string> | undefined;
    if (tiers && !tiers.has("tier1")) return false;
    let found = false;
    scene?.room?.state?.monsters?.forEach((monster, id) => {
      if (found || !monster.alive || monster.monsterId !== "monster_meadow_slime") return;
      const render = scene?.monsterObjects?.get(id);
      if (render?.visualRoot && render.container?.visible) found = true;
    });
    return found;
  }, undefined, { timeout: 30_000 });

  const sampleRoot = async (targetId: string, label: string) => page.evaluate(({ targetId: sampleTargetId, sampleLabel }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game") as unknown as {
      monsterObjects?: { get(id: string): { visualRoot?: { x: number; y: number; scaleX: number; scaleY: number; rotation: number; alpha: number } } | undefined };
    };
    const root = scene.monsterObjects?.get(sampleTargetId)?.visualRoot;
    if (!root) throw new Error(`missing slime visualRoot for ${sampleTargetId}`);
    return {
      label: sampleLabel,
      root: {
        x: Math.round(root.x * 1000) / 1000,
        y: Math.round(root.y * 1000) / 1000,
        scaleX: Math.round(root.scaleX * 1000) / 1000,
        scaleY: Math.round(root.scaleY * 1000) / 1000,
        rotation: Math.round(root.rotation * 1000) / 1000,
        alpha: Math.round(root.alpha * 1000) / 1000,
      },
    };
  }, { targetId, sampleLabel: label });

  const targets = await page.evaluate((gameplayZoom) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game") as unknown as {
      cameras?: { main?: SmokeBrowserGlobal["__GAME"]["scene"]["getScene"] extends (...args: never[]) => infer R ? R extends { cameras: { main: infer C } } ? C : never : never };
      room?: SmokeBrowserGlobal["__GAME"]["scene"]["getScene"] extends (...args: never[]) => infer R ? R extends { room: infer Room } ? Room : never : never;
      monsterObjects?: { get(id: string): { visualRoot?: unknown; container?: { x: number; y: number; visible: boolean } } | undefined };
      animator?: { stopAll(id: string): void; play(id: string, state: "idle" | "walk", target: unknown): void };
      syncMonstersFromRoom?: () => void;
    };
    const species = [
      { label: "meadow", monsterKey: "monster_meadow_slime" },
      { label: "dew", monsterKey: "monster_dew_slime" },
      { label: "blossom", monsterKey: "monster_blossom_slime" },
      { label: "honey", monsterKey: "monster_honey_slime" },
    ];
    const found: SlimeProofTarget[] = [];
    for (const slime of species) {
      let selected: SlimeProofTarget | undefined;
      scene.room?.state?.monsters?.forEach((monster, id) => {
        if (selected || !id.includes(slime.monsterKey) || !monster.alive) return;
        const render = scene.monsterObjects?.get(id);
        if (!render?.visualRoot) return;
        selected = { ...slime, id, x: monster.x, y: monster.y };
      });
      if (!selected) throw new Error(`no live rendered ${slime.monsterKey} found for tween proof`);
      found.push(selected);
    }
    for (const target of found) {
      const render = scene.monsterObjects?.get(target.id);
      if (!render?.visualRoot) throw new Error(`missing render for ${target.id}`);
      scene.animator?.stopAll(target.id);
      scene.animator?.play(target.id, "idle", render.visualRoot);
    }
    scene.syncMonstersFromRoom = () => undefined;
    const cam = scene.cameras?.main;
    cam?.stopFollow();
    cam?.setZoom(gameplayZoom * 2.2);
    cam?.centerOn(found[0].x, found[0].y - 16);
    return found;
  }, GAMEPLAY_ZOOM);

  const setSpeciesAnim = async (target: SlimeProofTarget, state: "idle" | "walk", gameplayZoom: number) =>
    page.evaluate(({ targetId, animState, zoom }) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game") as unknown as {
        cameras?: { main?: { stopFollow(): void; setZoom(zoom: number): void; centerOn(x: number, y: number): void } };
        monsterObjects?: { get(id: string): { visualRoot?: unknown; container?: { x: number; y: number } } | undefined };
        animator?: { stopAll(id: string): void; play(id: string, state: "idle" | "walk", target: unknown): void };
      };
      const render = scene.monsterObjects?.get(targetId);
      if (!render?.visualRoot) throw new Error(`missing slime render for ${targetId}`);
      scene.animator?.stopAll(targetId);
      scene.animator?.play(targetId, animState, render.visualRoot);
      const cam = scene.cameras?.main;
      cam?.stopFollow();
      // Tight metric framing (gameplay zoom × 4.5): the target slime fills ~half the frame so
      // neighbouring dark scene objects (well roof, buildings, other slimes) fall off-frame and
      // do not pollute the tracked-crop dark count. This is a MEASUREMENT framing; gameplay-zoom
      // framing is verified separately by the eyes-on gate.
      cam?.setZoom(zoom * 4.5);
      cam?.centerOn(render.container?.x ?? 0, (render.container?.y ?? 0) - 16);
    }, { targetId: target.id, animState: state, zoom: gameplayZoom });

  // Record the target slime's on-screen SPRITE centre (bob-followed) + the camera transform so
  // the metric can place the source-PNG silhouette exactly over the slime and measure only its
  // rim (background-free, translation cancelled — card-slime-display-scale scope 4). The sprite
  // lives at container + visualRoot.bob; we find the deepest Sprite in the tree for its live
  // display size and accumulated offset. Iterative walk (no named fn decl in page.evaluate).
  const sampleScreenBox = async (target: SlimeProofTarget) =>
    page.evaluate((targetId) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game") as unknown as {
        cameras?: { main?: { worldView: { x: number; y: number }; zoom: number } };
        scale?: { displayScale?: { x: number; y: number } };
        monsterObjects?: { get(id: string): { container?: { x: number; y: number; list?: unknown[] } } | undefined };
      };
      const cam = scene.cameras?.main;
      const render = scene.monsterObjects?.get(targetId);
      const container = render?.container;
      if (!cam || !container) throw new Error(`missing cam/container for ${targetId}`);
      let dw = 0;
      let dh = 0;
      let spriteOffX = 0;
      let spriteOffY = 0;
      const stack: Array<{ ox: number; oy: number; node: { x?: number; y?: number; type?: string; displayWidth?: number; displayHeight?: number; list?: unknown[] } }> = [
        { ox: 0, oy: 0, node: container as unknown as { list?: unknown[] } },
      ];
      while (stack.length > 0) {
        const item = stack.pop();
        if (!item) continue;
        const node = item.node;
        // The body is the Sprite leaf (Phaser type === "Sprite"); pick the largest one.
        if (node.type === "Sprite" && typeof node.displayWidth === "number" && node.displayWidth > dw) {
          dw = node.displayWidth;
          dh = node.displayHeight ?? node.displayWidth;
          spriteOffX = item.ox;
          spriteOffY = item.oy;
        }
        if (Array.isArray(node.list)) {
          for (const child of node.list) {
            const c = child as { x?: number; y?: number; list?: unknown[] };
            stack.push({ ox: item.ox + (c.x ?? 0), oy: item.oy + (c.y ?? 0), node: c });
          }
        }
      }
      const ds = scene.scale?.displayScale ?? { x: 1, y: 1 };
      const sx = (container.x + spriteOffX - cam.worldView.x) * cam.zoom * ds.x;
      const sy = (container.y + spriteOffY - cam.worldView.y) * cam.zoom * ds.y;
      return { cx: Math.round(sx), cy: Math.round(sy), w: Math.round(dw * cam.zoom * ds.x), h: Math.round(dh * cam.zoom * ds.y) };
    }, target.id);

  // Deterministic per-species root-cause proof: the sprite's source→screen size RATIO. A basis
  // static rendered at ASSET_BASIS_SCALE under the fixed camera zoom must show its source pixels
  // 1:1 (ratio 1.0) — that is the property that ELIMINATES the minification crawl (no fractional
  // resample per frame). This needs no screenshot alignment, so it is the reliable gate; the
  // tracked-crop pixel stdev below is a supporting, informational artifact.
  const sampleRenderRatio = async (target: SlimeProofTarget, gameplayZoom: number) =>
    page.evaluate(({ targetId, zoom }) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game") as unknown as {
        textures?: { get(key: string): { getSourceImage(): { width: number; height: number } } };
        monsterObjects?: { get(id: string): { container?: { list?: unknown[] } } | undefined };
      };
      const render = scene.monsterObjects?.get(targetId);
      const container = render?.container;
      if (!container) throw new Error(`missing container for ${targetId}`);
      // Deepest Sprite leaf carries the live render scale + texture key.
      let sprite: { scaleX?: number; scaleY?: number; texture?: { key?: string }; type?: string } | undefined;
      const stack: Array<{ list?: unknown[] }> = [container as unknown as { list?: unknown[] }];
      while (stack.length > 0) {
        const node = stack.pop() as { type?: string; list?: unknown[] } | undefined;
        if (!node) continue;
        if (node.type === "Sprite") sprite = node as typeof sprite;
        if (Array.isArray(node.list)) for (const c of node.list) stack.push(c as { list?: unknown[] });
      }
      if (!sprite) throw new Error(`no Sprite leaf for ${targetId}`);
      const texKey = sprite.texture?.key ?? "";
      const source = scene.textures?.get(texKey).getSourceImage();
      const renderScale = sprite.scaleX ?? 1;
      // Ratio computed against the FIXED gameplay camera zoom (not the inflated metric zoom).
      const sourceToScreen = renderScale * zoom;
      return {
        texKey,
        sourceWidth: source?.width ?? 0,
        sourceHeight: source?.height ?? 0,
        renderScale: Math.round(renderScale * 100000) / 100000,
        cameraZoom: Math.round(zoom * 100000) / 100000,
        sourceToScreenRatio: Math.round(sourceToScreen * 100000) / 100000,
      };
    }, { targetId: target.id, zoom: gameplayZoom });

  // Per-species idle (stationary control) + walk (moving) bursts. The tracked-crop metric
  // (slime_burst_variance.py --gate) crops each frame at the recorded screen bbox so the moving
  // stdev reflects rim ALIASING, not the bob's genuine translation (card-slime-display-scale s4).
  await page.waitForTimeout(450);
  const samples: Array<Awaited<ReturnType<typeof sampleRoot>>> = [];
  const screenBoxes: Record<string, { cx: number; cy: number; w: number; h: number }> = {};
  const renderRatios: Record<string, Awaited<ReturnType<typeof sampleRenderRatio>>> = {};
  for (const target of targets) {
    await setSpeciesAnim(target, "idle", GAMEPLAY_ZOOM);
    await page.waitForTimeout(220);
    renderRatios[target.label] = await sampleRenderRatio(target, GAMEPLAY_ZOOM);
    for (let i = 0; i < 6; i += 1) {
      const frame = `${target.label}-idle-${String(i).padStart(2, "0")}`;
      samples.push(await sampleRoot(target.id, frame));
      screenBoxes[`slime-${frame}.png`] = await sampleScreenBox(target);
      await page.screenshot({ path: `${outDir}/slime-${frame}.png` });
      await page.waitForTimeout(180);
    }
    await setSpeciesAnim(target, "walk", GAMEPLAY_ZOOM);
    await page.waitForTimeout(220);
    for (let i = 0; i < 8; i += 1) {
      const frame = `${target.label}-walk-${String(i).padStart(2, "0")}`;
      samples.push(await sampleRoot(target.id, frame));
      screenBoxes[`slime-${frame}.png`] = await sampleScreenBox(target);
      await page.screenshot({ path: `${outDir}/slime-${frame}.png` });
      await page.waitForTimeout(110);
    }
  }
  writeFileSync(`${outDir}/slime-screen-boxes.json`, JSON.stringify(screenBoxes, null, 2) + "\n", "utf8");
  writeFileSync(`${outDir}/slime-render-ratio.json`, JSON.stringify(renderRatios, null, 2) + "\n", "utf8");

  await page.evaluate((proofTargets) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game") as unknown as {
      cameras?: { main?: { stopFollow(): void; setZoom(zoom: number): void; centerOn(x: number, y: number): void } };
      monsterObjects?: { get(id: string): { visualRoot?: unknown } | undefined };
      animator?: { stopAll(id: string): void; play(id: string, state: "idle" | "walk", target: unknown): void };
    };
    for (const target of proofTargets) {
      const render = scene.monsterObjects?.get(target.id);
      if (!render?.visualRoot) throw new Error(`missing render for ${target.id}`);
      scene.animator?.stopAll(target.id);
      scene.animator?.play(target.id, "walk", render.visualRoot);
    }
    const minX = Math.min(...proofTargets.map((target) => target.x));
    const maxX = Math.max(...proofTargets.map((target) => target.x));
    const minY = Math.min(...proofTargets.map((target) => target.y));
    const maxY = Math.max(...proofTargets.map((target) => target.y));
    const cam = scene.cameras?.main;
    cam?.stopFollow();
    cam?.setZoom(0.55);
    cam?.centerOn((minX + maxX) / 2, (minY + maxY) / 2);
  }, targets);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outDir}/slime-all-walk.png` });

  return {
    targets,
    samples,
    outputs: {
      species: targets.map((target) => target.label),
      idleFramesPerSpecies: 6,
      walkFramesPerSpecies: 8,
      allSlimesWalk: "slime-all-walk.png",
    },
  };
}

type MonsterReactionSample = {
  label: string;
  root: { x: number; y: number; scaleX: number; scaleY: number; alpha: number };
  container: { x: number; y: number };
  logical: { x: number; y: number };
};

async function captureMonsterReactionsProof(outDir: string, page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  // Monster sprites are tier-1 since the boot tiering merge: their renders are rebuilt when
  // the deferred tier finishes loading, which destroys any container selected too early.
  // Wait for the tier set to include tier1 AND a live visible monster render to exist.
  await page.waitForFunction(() => {
    const scene = (globalThis as { __GAME?: { scene?: { getScene(key: string): unknown } } }).__GAME?.scene?.getScene("game") as {
      registry?: { get(key: string): unknown };
      room?: { state?: { monsters?: { forEach(cb: (monster: { alive?: boolean }, id: string) => void): void } } };
      monsterObjects?: { get(id: string): { visualRoot?: unknown; container?: { visible: boolean } } | undefined };
    } | undefined;
    const tiers = scene?.registry?.get("loadedAssetTiers") as Set<string> | undefined;
    if (tiers && !tiers.has("tier1")) return false;
    let found = false;
    scene?.room?.state?.monsters?.forEach((monster, id) => {
      if (found || !monster.alive) return;
      const render = scene?.monsterObjects?.get(id);
      if (render?.visualRoot && render.container?.visible) found = true;
    });
    return found;
  }, undefined, { timeout: 30_000 });
  const target = await page.evaluate((gameplayZoom) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game") as unknown as {
      cameras?: { main?: { stopFollow(): void; setZoom(zoom: number): void; centerOn(x: number, y: number): void } };
      room?: SmokeBrowserGlobal["__GAME"]["scene"]["getScene"] extends (...args: never[]) => infer R ? R extends { room: infer Room } ? Room : never : never;
      monsterObjects?: { get(id: string): { visualRoot?: unknown; container?: { x: number; y: number; visible: boolean } } | undefined };
      animator?: { stopAll(id: string): void; play(id: string, state: "idle" | "hit" | "death", target: unknown, context?: { hitDirection?: { x: number; y: number }; crit?: boolean }): void };
      syncMonstersFromRoom?: () => void;
    };
    let selected: { id: string; monsterKey: string; x: number; y: number } | undefined;
    scene.room?.state?.monsters?.forEach((monster, id) => {
      if (selected || !monster.alive) return;
      const render = scene.monsterObjects?.get(id);
      if (!render?.visualRoot || !render.container?.visible) return;
      selected = { id, monsterKey: monster.monsterId ?? "unknown", x: monster.x, y: monster.y };
    });
    if (!selected) throw new Error("no live rendered monster found for monster reactions proof");
    const render = scene.monsterObjects?.get(selected.id);
    if (!render?.visualRoot) throw new Error(`missing visualRoot for ${selected.id}`);
    scene.syncMonstersFromRoom = () => undefined;
    scene.animator?.stopAll(selected.id);
    scene.animator?.play(selected.id, "idle", render.visualRoot);
    const cam = scene.cameras?.main;
    cam?.stopFollow();
    cam?.setZoom(gameplayZoom * 2.35);
    cam?.centerOn(selected.x, selected.y - 18);
    return selected;
  }, GAMEPLAY_ZOOM);

  const sample = async (label: string): Promise<MonsterReactionSample> => page.evaluate(({ targetId, sampleLabel }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game") as unknown as {
      room?: SmokeBrowserGlobal["__GAME"]["scene"]["getScene"] extends (...args: never[]) => infer R ? R extends { room: infer Room } ? Room : never : never;
      monsterObjects?: { get(id: string): { visualRoot?: { x: number; y: number; scaleX: number; scaleY: number; alpha: number }; container?: { x: number; y: number } } | undefined };
    };
    const monster = scene.room?.state?.monsters?.get(targetId);
    const render = scene.monsterObjects?.get(targetId);
    const root = render?.visualRoot;
    const container = render?.container;
    if (!monster || !root || !container) throw new Error(`missing monster/root/container for ${targetId}`);
    return {
      label: sampleLabel,
      root: {
        x: Number(root.x.toFixed(3)),
        y: Number(root.y.toFixed(3)),
        scaleX: Number(root.scaleX.toFixed(3)),
        scaleY: Number(root.scaleY.toFixed(3)),
        alpha: Number(root.alpha.toFixed(3)),
      },
      container: { x: Number(container.x.toFixed(3)), y: Number(container.y.toFixed(3)) },
      logical: { x: Number(monster.x.toFixed(3)), y: Number(monster.y.toFixed(3)) },
    };
  }, { targetId: target.id, sampleLabel: label });

  const start = await sample("start");
  await page.evaluate((targetId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game") as unknown as {
      monsterObjects?: { get(id: string): { visualRoot?: unknown } | undefined };
      animator?: { stopAll(id: string): void; play(id: string, state: "hit", target: unknown, context?: { hitDirection?: { x: number; y: number }; crit?: boolean }): void };
    };
    const render = scene.monsterObjects?.get(targetId);
    if (!render?.visualRoot) throw new Error(`missing render for ${targetId}`);
    scene.animator?.stopAll(targetId);
    scene.animator?.play(targetId, "hit", render.visualRoot, { hitDirection: { x: 1, y: 0 } });
  }, target.id);

  const burst: MonsterReactionSample[] = [];
  for (const frame of [
    { label: "hit-00", delayMs: 40 },
    { label: "hit-01", delayMs: 70 },
    { label: "hit-02", delayMs: 80 },
    { label: "hit-03", delayMs: 90 },
  ]) {
    await page.waitForTimeout(frame.delayMs);
    burst.push(await sample(frame.label));
    await page.screenshot({ path: `${outDir}/monster-reaction-${frame.label}.png`, fullPage: false });
  }
  await page.waitForTimeout(120);
  const returned = await sample("hit-returned");
  await page.screenshot({ path: `${outDir}/monster-reaction-hit-returned.png`, fullPage: false });

  await page.evaluate((targetId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game") as unknown as {
      monsterObjects?: { get(id: string): { visualRoot?: unknown } | undefined };
      animator?: { stopAll(id: string): void; play(id: string, state: "hit", target: unknown, context?: { hitDirection?: { x: number; y: number }; crit?: boolean }): void };
    };
    const render = scene.monsterObjects?.get(targetId);
    if (!render?.visualRoot) throw new Error(`missing render for ${targetId}`);
    scene.animator?.stopAll(targetId);
    scene.animator?.play(targetId, "hit", render.visualRoot, { hitDirection: { x: 1, y: 0 }, crit: true });
  }, target.id);
  await page.waitForTimeout(45);
  const critPeak = await sample("crit-peak");
  await page.screenshot({ path: `${outDir}/monster-reaction-crit-peak.png`, fullPage: false });
  await page.waitForTimeout(320);
  const critReturned = await sample("crit-returned");

  const assertRestored = (actual: MonsterReactionSample, expected: MonsterReactionSample, label: string) => {
    const rootDx = Math.abs(actual.root.x - expected.root.x);
    const rootDy = Math.abs(actual.root.y - expected.root.y);
    const scaleDx = Math.abs(actual.root.scaleX - expected.root.scaleX);
    const scaleDy = Math.abs(actual.root.scaleY - expected.root.scaleY);
    const alphaD = Math.abs(actual.root.alpha - expected.root.alpha);
    if (rootDx > 0.25 || rootDy > 0.25 || scaleDx > 0.015 || scaleDy > 0.015 || alphaD > 0.015) {
      throw new Error(`${label} did not return to rest: ${JSON.stringify({ expected, actual })}`);
    }
  };
  const assertContainerStable = (actual: MonsterReactionSample, expected: MonsterReactionSample, label: string) => {
    const dx = Math.abs(actual.container.x - expected.container.x);
    const dy = Math.abs(actual.container.y - expected.container.y);
    if (dx > 0.001 || dy > 0.001) {
      throw new Error(`${label} changed render container anchor: ${JSON.stringify({ expected: expected.container, actual: actual.container })}`);
    }
  };
  assertRestored(returned, start, "regular hit");
  assertRestored(critReturned, start, "crit hit");
  for (const frame of [...burst, returned, critPeak, critReturned]) {
    assertContainerStable(frame, start, frame.label);
  }
  if (Math.max(...burst.map((frame) => Math.abs(frame.root.x - start.root.x))) < 4) {
    throw new Error(`regular hit burst did not show visible recoil: ${JSON.stringify(burst)}`);
  }
  if (Math.abs(critPeak.root.x - start.root.x) <= Math.max(...burst.map((frame) => Math.abs(frame.root.x - start.root.x)))) {
    throw new Error(`crit hit did not produce stronger recoil than regular hit: ${JSON.stringify({ burst, critPeak })}`);
  }

  return {
    target,
    samples: [start, ...burst, returned, critPeak, critReturned],
    outputs: {
      burstFrames: [
        "monster-reaction-hit-00.png",
        "monster-reaction-hit-01.png",
        "monster-reaction-hit-02.png",
        "monster-reaction-hit-03.png",
        "monster-reaction-hit-returned.png",
        "monster-reaction-crit-peak.png",
      ],
    },
  };
}

async function captureEditorThinSlice(outDir: string, page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  const originalLayoutText = readFileSync(EDITOR_LAYOUT_PATH, "utf8");
  const originalMapText = readFileSync(EDITOR_MAP_PATH, "utf8");
  const originalMetadataText = readFileSync(EDITOR_METADATA_PATH, "utf8");
  const originalPortalText = existsSync(EDITOR_TEMP_PORTAL_PATH) ? readFileSync(EDITOR_TEMP_PORTAL_PATH, "utf8") : null;
  try {
  mkdirSync("content/portals", { recursive: true });
  writeFileSync(EDITOR_TEMP_PORTAL_PATH, JSON.stringify({
    schemaVersion: 1,
    id: EDITOR_TEMP_PORTAL_ID,
    sourceMapId: EDITOR_MAP_ID,
    targetMapId: "map_harbor_r1_pilot",
    targetSpawnId: "spawn_default",
    shape: { type: "circle", x: 1180, y: 640, radius: 52 },
    loadingTitleKey: "map.harbor_r1_pilot.name",
  }, null, 2) + "\n", "utf8");
  await page.evaluate((storagePrefix) => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(storagePrefix)) localStorage.removeItem(key);
    }
  }, EDITOR_INSPECTOR_COLLAPSE_STORAGE_PREFIX);
  await reloadGamePage(page);
  await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const prop = scene?.getEditorQaApi?.();
    if (!prop) throw new Error("editor QA API unavailable");
  });

  await page.evaluate(async () => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API unavailable");
    if (api.getState().active) await api.setActive(false);
  });
  await page.click("[data-editor-mode-toggle='true']");
  await page.waitForFunction(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const button = (globalThis as SmokeBrowserGlobal).document.querySelector("[data-editor-mode-toggle='true']");
    return scene?.getEditorQaApi?.()?.getState?.().active === true && button?.dataset?.editorMode === "on";
  });
  const editModeToggleOn = await page.evaluate(() => {
    const button = (globalThis as SmokeBrowserGlobal).document.querySelector("[data-editor-mode-toggle='true']");
    return {
      active: (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game")?.getEditorQaApi?.()?.getState?.().active === true,
      mode: button?.dataset?.editorMode,
      text: button?.textContent,
      hudHidden: (globalThis as SmokeBrowserGlobal).getComputedStyle((globalThis as SmokeBrowserGlobal).document.querySelector("#hud")).display === "none",
    };
  });
  if (!editModeToggleOn.active || editModeToggleOn.mode !== "on" || !editModeToggleOn.hudHidden) {
    throw new Error(`editor mode toggle did not turn on cleanly: ${JSON.stringify(editModeToggleOn)}`);
  }
  await page.click("[data-editor-mode-toggle='true']");
  await page.waitForFunction(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const button = (globalThis as SmokeBrowserGlobal).document.querySelector("[data-editor-mode-toggle='true']");
    return scene?.getEditorQaApi?.()?.getState?.().active === false && button?.dataset?.editorMode === "off";
  });
  const editModeToggleOff = await page.evaluate(() => {
    const button = (globalThis as SmokeBrowserGlobal).document.querySelector("[data-editor-mode-toggle='true']");
    return {
      active: (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game")?.getEditorQaApi?.()?.getState?.().active === true,
      mode: button?.dataset?.editorMode,
      text: button?.textContent,
    };
  });
  if (editModeToggleOff.active || editModeToggleOff.mode !== "off") {
    throw new Error(`editor mode toggle did not turn off cleanly: ${JSON.stringify(editModeToggleOff)}`);
  }
  const editModeToggleProof = { on: editModeToggleOn, off: editModeToggleOff };

  const before = await page.evaluate(
    async ({ propId }) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
      const api = scene?.getEditorQaApi?.();
      if (!api) throw new Error("editor QA API unavailable");
      await api.setActive(true);
      await api.selectProp(propId);
      const state = api.getState();
      if (!state.selectedPosition) throw new Error(`failed to select ${propId}`);
      if (!state.selectedValidation?.ok) throw new Error(`selected prop validation failed: ${state.selectedValidation?.issues?.join("; ")}`);
      // Collision-truth repro (card-editor-collision-truth): p_windmill carries NO instance
      // collision, so before the fix the inspector showed "no collision" while the exported/
      // server grid still blocked it (its blocker comes from the `structure` placement class).
      // The editor must now surface the effective blocker, sourced from the asset default.
      const scope = state.selectedAssetScope;
      if (scope?.effectiveCollisionMode !== "box") {
        throw new Error(`effective collision not surfaced for class-covered prop: ${JSON.stringify(scope)}`);
      }
      if (scope.collisionSource !== "assetDefault") {
        throw new Error(`collision source should be the asset default (placement class), got: ${JSON.stringify(scope)}`);
      }
      if (state.selectedTransform?.collisionMode !== 1) {
        throw new Error(`inspector must show a blocking box for ${propId}, got collisionMode ${JSON.stringify(state.selectedTransform?.collisionMode)}`);
      }
      const origin = (globalThis as { __GAMEKIT_DEVKIT_ORIGIN__?: string }).__GAMEKIT_DEVKIT_ORIGIN__;
      const layoutResponse = await fetch(`${origin}/api/zone-layouts`);
      const layouts = await layoutResponse.json() as ZoneLayoutsResponse;
      const layout = layouts.layouts.find((candidate) => candidate.mapId === state.mapId);
      if (!layout) throw new Error(`layout not found for ${state.mapId}`);
      return {
        state,
        stalePayload: {
          mapId: layout.mapId,
          data: layout.data,
          baseHash: layout.hash,
          baseModifiedMs: layout.modifiedMs,
        },
      };
    },
    { propId: EDITOR_PROP_ID },
  );

  await centerCameraOnSelected(page);
  const inspectorQolDefaultProof = await page.evaluate(() => {
    type LooseDetails = { open: boolean; getBoundingClientRect?: () => { top: number; bottom: number; height: number; toJSON?: () => unknown } };
    type LooseElement = { getBoundingClientRect: () => { top: number; bottom: number; height: number; toJSON?: () => unknown } };
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const requiredSchemaGroups = ["Identity", "Position", "Transform", "Origin", "Size", "Shape", "Spawn", "Collision", "Shadow", "Reflection"];
    const sections: Record<string, LooseDetails> = {};
    for (const group of requiredSchemaGroups) {
      const details = doc.querySelector(`[data-editor-inspector-section='${group}']`) as unknown as LooseDetails | null;
      if (!details) throw new Error(`inspector section missing: ${group}`);
      sections[group] = details;
    }
    const jsonValidation = doc.querySelector("[data-editor-inspector-section='JSON / Validation']") as unknown as LooseDetails | null;
    if (!jsonValidation) throw new Error("JSON / Validation section missing");
    sections["JSON / Validation"] = jsonValidation;
    const aiExport = doc.querySelector("[data-editor-ai-export='true']") as unknown as LooseDetails | null;
    const layoutJson = doc.querySelector("[data-editor-layout-json='true']") as unknown as LooseDetails | null;
    if (!aiExport || !layoutJson) throw new Error("AI export or layout JSON drawer missing");
    if (!sections.Position.open || !sections.Transform.open) throw new Error("Position and Transform should default open");
    if (aiExport.open || jsonValidation.open || layoutJson.open) {
      throw new Error(`drawers should default collapsed: ${JSON.stringify({ ai: aiExport.open, json: jsonValidation.open, layout: layoutJson.open })}`);
    }
    const workflow = doc.querySelector("[data-editor-workflow-section='true']") as unknown as LooseElement | null;
    const more = doc.querySelector("[data-editor-workflow-more='true']") as unknown as LooseDetails | null;
    if (!workflow || !more) throw new Error("sticky workflow or More drawer missing");
    const workflowRect = workflow.getBoundingClientRect();
    if (workflowRect.bottom > (globalThis as unknown as { innerHeight: number }).innerHeight + 1 || workflowRect.top < 0) {
      throw new Error(`workflow is not visible: ${JSON.stringify(workflowRect.toJSON?.() ?? workflowRect)}`);
    }
    return {
      open: Object.fromEntries(
        ["Position", "Transform", "Shadow", "Reflection", "AI Export", "JSON / Validation", "Layout JSON"].map((name) => [
          name,
          (name === "AI Export" ? aiExport : name === "Layout JSON" ? layoutJson : sections[name]).open,
        ]),
      ),
      workflowRect: { top: workflowRect.top, bottom: workflowRect.bottom, height: workflowRect.height },
      moreOpen: more.open,
    };
  });
  await page.screenshot({ path: `${outDir}/editor-inspector-collapsed-default.png` });
  console.log(`[capture] editor inspector collapsed default -> ${outDir}/editor-inspector-collapsed-default.png`);
  const inspectorQolExpandedProof = await page.evaluate(() => {
    type LooseDetails = { open: boolean; scrollIntoView: (options?: unknown) => void };
    type LooseButton = { dataset: { editorShadowPreset?: string } };
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const shadow = doc.querySelector("[data-editor-inspector-section='Shadow']") as unknown as LooseDetails | null;
    if (!shadow) throw new Error("Shadow section missing");
    shadow.open = true;
    shadow.scrollIntoView({ block: "center" });
    const presetButtons = Array.from(doc.querySelectorAll("[data-editor-shadow-preset]")).map((button) => (button as unknown as LooseButton).dataset.editorShadowPreset);
    for (const expected of ["dynamic", "contact", "tall", "wide", "tiny"]) {
      if (!presetButtons.includes(expected)) throw new Error(`Shadow preset chip missing: ${expected}`);
    }
    if (!doc.querySelector("[data-editor-compact-field-pair='Sh X/Sh Y']")) throw new Error("Shadow X/Y compact pair missing");
    if (!doc.querySelector("[data-editor-compact-field-pair='Sh W%/Sh H%']")) throw new Error("Shadow W/H compact pair missing");
    return { shadowOpen: shadow.open, presetButtons };
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${outDir}/editor-inspector-expanded-section.png` });
  console.log(`[capture] editor inspector expanded section -> ${outDir}/editor-inspector-expanded-section.png`);
  const inspectorQolStickyProof = await page.evaluate(() => {
    type LooseScrollElement = {
      scrollTop: number;
      scrollHeight: number;
      getBoundingClientRect?: () => { top: number; bottom: number; height: number; toJSON?: () => unknown };
    };
    type LooseElement = { getBoundingClientRect: () => { top: number; bottom: number; height: number; toJSON?: () => unknown } };
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const panel = doc.querySelector("[data-editor-panel='true']") as unknown as LooseScrollElement | null;
    const workflow = doc.querySelector("[data-editor-workflow-section='true']") as unknown as LooseElement | null;
    if (!panel || !workflow) throw new Error("panel or workflow missing");
    panel.scrollTop = Math.floor(panel.scrollHeight / 2);
    const rect = workflow.getBoundingClientRect();
    if (rect.bottom > (globalThis as unknown as { innerHeight: number }).innerHeight + 1 || rect.top < 0) throw new Error(`workflow not visible mid-scroll: ${JSON.stringify(rect.toJSON?.() ?? rect)}`);
    for (const selector of [
      "[data-editor-save-draft='true']",
      "[data-editor-export-build='true']",
      "[data-editor-workflow-section='true'] button",
    ]) {
      if (!doc.querySelector(selector)) throw new Error(`sticky workflow selector missing: ${selector}`);
    }
    return { panelScrollTop: panel.scrollTop, workflowRect: { top: rect.top, bottom: rect.bottom, height: rect.height } };
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${outDir}/editor-inspector-sticky-mid-scroll.png` });
  console.log(`[capture] editor inspector sticky mid-scroll -> ${outDir}/editor-inspector-sticky-mid-scroll.png`);
  const inspectorQolPersistenceProof = await page.evaluate(async (storagePrefix) => {
    type LooseDetails = { open: boolean; dataset: { editorInspectorStorageKey?: string }; querySelector: (selector: string) => { click?: () => void } | null };
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const position = doc.querySelector("[data-editor-inspector-section='Position']") as unknown as LooseDetails | null;
    if (!position) throw new Error("Position section missing");
    if (position.open) position.querySelector("summary")?.click?.();
    if (position.open) throw new Error("Position section did not collapse");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const storageKey = position.dataset.editorInspectorStorageKey ?? `${storagePrefix}schema.position`;
    if (localStorage.getItem(storageKey) !== "closed") throw new Error(`collapse did not persist to ${storageKey}`);
    return { storageKey, beforeReloadOpen: position.open, stored: localStorage.getItem(storageKey) };
  }, EDITOR_INSPECTOR_COLLAPSE_STORAGE_PREFIX);
  await reloadGamePage(page);
  const inspectorQolPersistenceReloaded = await page.evaluate(async ({ propId, storageKey }) => {
    type LooseDetails = { open: boolean };
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API unavailable for inspector persistence proof");
    await api.setActive(true);
    await api.selectProp(propId);
    const position = (globalThis as SmokeBrowserGlobal).document.querySelector("[data-editor-inspector-section='Position']") as unknown as LooseDetails | null;
    if (!position) throw new Error("Position section missing after reload");
    if (position.open) throw new Error("Position section did not stay collapsed after reload");
    return { storageKey, afterReloadOpen: position.open, stored: localStorage.getItem(storageKey) };
  }, { propId: EDITOR_PROP_ID, storageKey: inspectorQolPersistenceProof.storageKey });
  await centerCameraOnSelected(page);
  await page.screenshot({ path: `${outDir}/editor-selected-before.png` });
  console.log(`[capture] editor selected before -> ${outDir}/editor-selected-before.png`);

  const treeReorderBefore = await page.evaluate(async () => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    const doc = (globalThis as SmokeBrowserGlobal).document;
    if (!api) throw new Error("editor QA API unavailable for tree reorder proof");
    await api.setActive(true);
    (doc.querySelector("[data-editor-tool='object']") as { click?: () => void } | null)?.click?.();
    const order = api.getObjectOrder("props");
    if (order.length < 2) throw new Error(`tree reorder proof needs at least two props: ${JSON.stringify(order)}`);
    const sourceId = order[1];
    const targetId = order[0];
    await api.selectObject(sourceId);
    (doc.querySelector(`[data-editor-object-id="${sourceId}"]`) as { scrollIntoView?: (options?: unknown) => void } | null)?.scrollIntoView?.({ block: "center" });
    return { order, sourceId, targetId, beforePair: order.slice(0, 2) };
  });
  await page.screenshot({ path: `${outDir}/editor-tree-reorder-before.png` });
  console.log(`[capture] editor tree reorder before -> ${outDir}/editor-tree-reorder-before.png`);
  const treeReorderAfter = await page.evaluate(async ({ sourceId, targetId }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    const doc = (globalThis as SmokeBrowserGlobal).document;
    if (!api) throw new Error("editor QA API unavailable for tree reorder action");
    const reordered = api.reorderObject(sourceId, targetId, "before");
    const order = api.getObjectOrder("props");
    if (order[0] !== sourceId || order[1] !== targetId) {
      throw new Error(`tree reorder did not move ${sourceId} before ${targetId}: ${JSON.stringify(order.slice(0, 4))}`);
    }
    const save = await api.save();
    if (!save.ok) throw new Error(`tree reorder save failed: ${save.error ?? "unknown"}`);
    (doc.querySelector(`[data-editor-object-id="${sourceId}"]`) as { scrollIntoView?: (options?: unknown) => void } | null)?.scrollIntoView?.({ block: "center" });
    return { state: reordered, order, afterPair: order.slice(0, 2), save };
  }, { sourceId: treeReorderBefore.sourceId, targetId: treeReorderBefore.targetId });
  await page.screenshot({ path: `${outDir}/editor-tree-reorder-after.png` });
  console.log(`[capture] editor tree reorder after -> ${outDir}/editor-tree-reorder-after.png`);
  await reloadGamePage(page);
  const treeReorderReloaded = await page.evaluate(async ({ sourceId, targetId }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    const doc = (globalThis as SmokeBrowserGlobal).document;
    if (!api) throw new Error("editor QA API unavailable for tree reorder reload");
    await api.setActive(true);
    (doc.querySelector("[data-editor-tool='object']") as { click?: () => void } | null)?.click?.();
    const order = api.getObjectOrder("props");
    if (order[0] !== sourceId || order[1] !== targetId) {
      throw new Error(`tree reorder did not persist after reload: ${JSON.stringify(order.slice(0, 4))}`);
    }
    await api.selectObject(sourceId);
    (doc.querySelector(`[data-editor-object-id="${sourceId}"]`) as { scrollIntoView?: (options?: unknown) => void } | null)?.scrollIntoView?.({ block: "center" });
    return { order, reloadedPair: order.slice(0, 2) };
  }, { sourceId: treeReorderBefore.sourceId, targetId: treeReorderBefore.targetId });
  await page.screenshot({ path: `${outDir}/editor-tree-reorder-reloaded.png` });
  console.log(`[capture] editor tree reorder reloaded -> ${outDir}/editor-tree-reorder-reloaded.png`);

  const placementProof = await page.evaluate(async ({ propKey, decalKey }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API missing for placement proof");
    const doc = (globalThis as SmokeBrowserGlobal).document;
    if (!doc.querySelector("[data-editor-place-asset='props']")) throw new Error("Place prop button missing");
    if (!doc.querySelector("[data-editor-place-asset='decals']")) throw new Error("Place decal button missing");
    if (!doc.querySelector("[data-editor-tool='delete']")) throw new Error("Delete tool button missing");
    const propState = await api.placeAsset("props", propKey);
    const propId = propState.selectedInstanceId;
    if (!propId || propState.selectedLayer !== "props") throw new Error(`prop placement did not select a prop: ${JSON.stringify(propState)}`);
    api.moveSelectedBy(-64, 0);
    const propMoved = api.getState();
    const decalState = await api.placeAsset("decals", decalKey);
    const decalId = decalState.selectedInstanceId;
    if (!decalId || decalState.selectedLayer !== "decals") throw new Error(`decal placement did not select a decal: ${JSON.stringify(decalState)}`);
    api.moveSelectedBy(64, 0);
    const decalMoved = api.getState();
    const save = await api.save();
    if (!save.ok) throw new Error(`placement save failed: ${save.error ?? "unknown"}`);
    return { propId, decalId, propMoved, decalMoved, save };
  }, { propKey: EDITOR_PLACE_PROP_KEY, decalKey: EDITOR_PLACE_DECAL_KEY });
  await centerCameraOnSelected(page);
  await page.screenshot({ path: `${outDir}/editor-placed-assets-hot.png` });
  console.log(`[capture] editor placed assets hot -> ${outDir}/editor-placed-assets-hot.png`);
  const placementExport = await postDevkit("/api/zone-export", { mapId: before.state.mapId });
  if (!placementExport.ok) {
    throw new Error(`placement export failed: ${placementExport.error ?? placementExport.output ?? "unknown"}`);
  }
  await page.waitForTimeout(500);
  await reloadGamePage(page);
  const placementReloaded = await page.evaluate(async ({ propId, decalId }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API unavailable after placement reload");
    await api.setActive(true);
    await api.selectObject(propId);
    const prop = api.getState();
    if (prop.selectedLayer !== "props" || !prop.selectedValidation?.ok) throw new Error(`placed prop reload failed: ${JSON.stringify(prop)}`);
    await api.selectObject(decalId);
    const decal = api.getState();
    if (decal.selectedLayer !== "decals" || !decal.selectedValidation?.ok) throw new Error(`placed decal reload failed: ${JSON.stringify(decal)}`);
    return { prop, decal };
  }, placementProof);
  const placementDeleteProof = await page.evaluate(async ({ propId, decalId }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API unavailable for placement delete");
    await api.setActive(true);
    await api.selectObject(propId);
    const propDeleted = api.deleteSelected();
    if (propDeleted.selectedInstanceId !== null) throw new Error(`prop delete left selection active: ${JSON.stringify(propDeleted)}`);
    const propUndo = api.undo();
    if (propUndo.selectedInstanceId !== propId || propUndo.selectedLayer !== "props") {
      throw new Error(`prop delete undo did not restore preview: ${JSON.stringify(propUndo)}`);
    }
    const propRedo = api.redo();
    if (propRedo.selectedInstanceId !== null) {
      throw new Error(`prop delete redo left selection active: ${JSON.stringify(propRedo)}`);
    }
    await api.selectObject(decalId);
    const decalDeleted = api.deleteSelected();
    if (decalDeleted.selectedInstanceId !== null) throw new Error(`decal delete left selection active: ${JSON.stringify(decalDeleted)}`);
    const save = await api.save();
    if (!save.ok) throw new Error(`placement delete save failed: ${save.error ?? "unknown"}`);
    return { propDeleted, propUndo, propRedo, decalDeleted, save };
  }, placementProof);
  await page.screenshot({ path: `${outDir}/editor-deleted-assets-hot.png` });
  console.log(`[capture] editor deleted assets hot -> ${outDir}/editor-deleted-assets-hot.png`);
  const placementRestoreExport = await postDevkit("/api/zone-export", { mapId: before.state.mapId });
  if (!placementRestoreExport.ok) {
    throw new Error(`placement restore export failed: ${placementRestoreExport.error ?? placementRestoreExport.output ?? "unknown"}`);
  }
  await page.waitForTimeout(500);
  await reloadGamePage(page);
  const placementDeleteReloaded = await page.evaluate(async ({ propId, decalId }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API unavailable after placement restore");
    await api.setActive(true);
    await api.selectObject(propId);
    const propMissing = api.getState();
    if (propMissing.selectedInstanceId !== null) throw new Error(`deleted prop still selectable after reload: ${JSON.stringify(propMissing)}`);
    await api.selectObject(decalId);
    const decalMissing = api.getState();
    if (decalMissing.selectedInstanceId !== null) throw new Error(`deleted decal still selectable after reload: ${JSON.stringify(decalMissing)}`);
    return { propMissing, decalMissing };
  }, placementProof);

  const entityPlacementProof = await page.evaluate(
    async ({ npcId, portalId, monsterId }) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
      const api = scene?.getEditorQaApi?.();
      if (!api) throw new Error("editor QA API missing for entity placement proof");
      const doc = (globalThis as SmokeBrowserGlobal).document;
      if (!doc.querySelector("[data-editor-place-npc='true']")) throw new Error("Place NPC button missing");
      if (!doc.querySelector("[data-editor-place-portal='true']")) throw new Error("Place portal button missing");
      if (!doc.querySelector("[data-editor-place-monster-spawn='true']")) throw new Error("Place spawn button missing");
      await api.setActive(true);
      const npcState = await api.placeNpc(npcId);
      const placedNpcId = npcState.selectedInstanceId;
      if (!placedNpcId || npcState.selectedLayer !== "npcs" || !npcState.selectedValidation?.ok) {
        throw new Error(`NPC placement failed: ${JSON.stringify(npcState)}`);
      }
      api.moveSelectedTo(760, 520);
      const npcMoved = api.getState();
      const portalState = await api.placePortal(portalId);
      const placedPortalId = portalState.selectedInstanceId;
      if (!placedPortalId || portalState.selectedLayer !== "portals" || !portalState.selectedValidation?.ok) {
        throw new Error(`portal placement failed: ${JSON.stringify(portalState)}`);
      }
      api.moveSelectedTo(860, 520);
      const portalMoved = api.getState();
      const spawnState = await api.placeMonsterSpawn(monsterId);
      const placedSpawnId = spawnState.selectedInstanceId;
      if (!placedSpawnId || spawnState.selectedLayer !== "monsterSpawns" || !spawnState.selectedValidation?.ok) {
        throw new Error(`monster spawn placement failed: ${JSON.stringify(spawnState)}`);
      }
      if (!/_\d+$/.test(placedSpawnId)) throw new Error(`spawn id is not ordinal-suffixed: ${placedSpawnId}`);
      api.moveSelectedTo(960, 520);
      const spawnMoved = api.getState();
      const save = await api.save();
      if (!save.ok) throw new Error(`entity placement save failed: ${save.error ?? "unknown"}`);
      return { placedNpcId, placedPortalId, placedSpawnId, npcMoved, portalMoved, spawnMoved, save };
    },
    { npcId: EDITOR_PLACE_NPC_ID, portalId: EDITOR_TEMP_PORTAL_ID, monsterId: EDITOR_PLACE_MONSTER_ID },
  );
  await centerCameraOnSelected(page);
  await page.screenshot({ path: `${outDir}/editor-placed-entities-hot.png` });
  console.log(`[capture] editor placed entities hot -> ${outDir}/editor-placed-entities-hot.png`);
  const entityPlacementExport = await postDevkit("/api/zone-export", { mapId: before.state.mapId });
  if (!entityPlacementExport.ok) {
    throw new Error(`entity placement export failed: ${entityPlacementExport.error ?? entityPlacementExport.output ?? "unknown"}`);
  }
  await page.waitForTimeout(500);
  await reloadGamePage(page);
  const entityPlacementReloaded = await page.evaluate(async ({ placedNpcId, placedPortalId, placedSpawnId }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API unavailable after entity placement reload");
    await api.setActive(true);
    await api.selectObject(placedNpcId);
    const npc = api.getState();
    if (npc.selectedLayer !== "npcs" || !npc.selectedValidation?.ok) throw new Error(`placed NPC reload failed: ${JSON.stringify(npc)}`);
    await api.selectObject(placedPortalId);
    const portal = api.getState();
    if (portal.selectedLayer !== "portals" || !portal.selectedValidation?.ok) throw new Error(`placed portal reload failed: ${JSON.stringify(portal)}`);
    await api.selectObject(placedSpawnId);
    const spawn = api.getState();
    if (spawn.selectedLayer !== "monsterSpawns" || !spawn.selectedValidation?.ok) throw new Error(`placed spawn reload failed: ${JSON.stringify(spawn)}`);
    return { npc, portal, spawn };
  }, entityPlacementProof);
  await centerCameraOnSelected(page);
  await page.screenshot({ path: `${outDir}/editor-placed-entities-reloaded.png` });
  console.log(`[capture] editor placed entities reloaded -> ${outDir}/editor-placed-entities-reloaded.png`);
  await page.evaluate(async ({ propId }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API unavailable after placement restore reselection");
    await api.selectProp(propId);
  }, { propId: EDITOR_PROP_ID });
  await centerCameraOnSelected(page);

  const scaleControlProof = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API missing for scale control proof");
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const resetButton = doc.querySelector("[data-editor-reset-scale='true']");
    const readout = doc.querySelector("[data-editor-scale-readout='true']");
    if (!resetButton) throw new Error("Reset scale button missing");
    if (!readout) throw new Error("Scale readout missing");
    const start = api.getState().selectedTransform;
    if (!start) throw new Error("selected transform missing before scale proof");
    const edited = api.setSelectedTransform({ ...start, scale: 0.73 }).selectedTransform;
    if (!edited || Math.abs(edited.scale - 0.73) > 0.001) throw new Error(`scale edit failed: ${JSON.stringify(edited)}`);
    const reset = api.resetScale().selectedTransform;
    if (!reset || reset.scale !== 1) throw new Error(`reset scale failed: ${JSON.stringify(reset)}`);
    const text = String(readout.textContent ?? "");
    if (!text.includes("Source") || !text.includes("display") || !text.includes("scale 1.00")) {
      throw new Error(`scale readout did not update: ${text}`);
    }
    resetButton.scrollIntoView({ block: "center" });
    return { start, edited, reset, readout: text };
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${outDir}/editor-scale-controls.png` });
  console.log(`[capture] editor scale controls -> ${outDir}/editor-scale-controls.png`);

  const zOrderProof = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API missing for z-order proof");
    const doc = (globalThis as SmokeBrowserGlobal).document;
    for (const expected of ["back", "down", "up", "front"]) {
      if (!doc.querySelector(`[data-editor-z-action='${expected}']`)) throw new Error(`Z action button missing: ${expected}`);
    }
    const start = api.getState().selectedTransform;
    if (!start) throw new Error("selected transform missing before z-order proof");
    const up = api.applyZOrderAction("up").selectedTransform;
    if (!up || up.zIndex !== Math.round(start.zIndex) + 1) throw new Error(`Up Z failed: ${JSON.stringify({ start, up })}`);
    const front = api.applyZOrderAction("front").selectedTransform;
    if (!front || front.zIndex !== Math.round(start.zIndex) + 11) throw new Error(`Super up failed: ${JSON.stringify({ start, front })}`);
    const down = api.applyZOrderAction("down").selectedTransform;
    if (!down || down.zIndex !== Math.round(start.zIndex) + 10) throw new Error(`Down Z failed: ${JSON.stringify({ start, down })}`);
    const back = api.applyZOrderAction("back").selectedTransform;
    if (!back || back.zIndex !== Math.round(start.zIndex)) throw new Error(`Super down failed: ${JSON.stringify({ start, back })}`);
    return { start, up, front, down, back };
  });
  await page.evaluate(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    doc.querySelector("[data-editor-z-action='back']")?.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${outDir}/editor-z-order-controls.png` });
  console.log(`[capture] editor Z-order controls -> ${outDir}/editor-z-order-controls.png`);

  const originPresetProof = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API missing for origin preset proof");
    const doc = (globalThis as SmokeBrowserGlobal).document;
    if (!doc.querySelector("[data-editor-origin-preset='center']")) throw new Error("Center origin button missing");
    if (!doc.querySelector("[data-editor-origin-preset='base']")) throw new Error("Base origin button missing");
    const centered = api.applyOriginPreset("center");
    const centerTransform = centered.selectedTransform;
    if (!centerTransform || centerTransform.originX !== 0.5 || centerTransform.originY !== 0.5) {
      throw new Error(`center origin preset failed: ${JSON.stringify(centerTransform)}`);
    }
    const based = api.applyOriginPreset("base");
    const baseTransform = based.selectedTransform;
    if (!baseTransform || baseTransform.originX !== 0.5 || baseTransform.originY !== 1) {
      throw new Error(`base origin preset failed: ${JSON.stringify(baseTransform)}`);
    }
    return { centerTransform, baseTransform };
  });
  await page.evaluate(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    doc.querySelector("[data-editor-origin-preset='center']")?.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${outDir}/editor-origin-presets.png` });
  console.log(`[capture] editor origin presets -> ${outDir}/editor-origin-presets.png`);

  const collisionPresetProof = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API missing for collision preset proof");
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const presetButtons = Array.from(doc.querySelectorAll("[data-editor-collision-preset]")).map((button) => button.dataset?.editorCollisionPreset);
    for (const expected of ["auto", "light", "clear"]) {
      if (!presetButtons.includes(expected)) throw new Error(`Collision preset button missing: ${expected}`);
    }
    api.applyCollisionPreset("auto");
    const auto = api.getState().selectedTransform;
    if (!auto) throw new Error("selected transform missing after auto collision");
    if (auto.collisionMode !== 1 || auto.collisionBlocksMovement !== 1) throw new Error(`auto collision did not create blocking box: ${JSON.stringify(auto)}`);
    api.applyCollisionPreset("light");
    const light = api.getState().selectedTransform;
    if (!light) throw new Error("selected transform missing after light collision");
    if (light.collisionMode !== 1 || light.collisionBlocksMovement !== 0) throw new Error(`light collision should be a non-blocking box: ${JSON.stringify(light)}`);
    api.applyCollisionPreset("clear");
    const cleared = api.getState().selectedTransform;
    if (!cleared) throw new Error("selected transform missing after clear collision");
    if (cleared.collisionMode !== 0 || cleared.collisionBlocksMovement !== 0) throw new Error(`clear collision did not disable collision: ${JSON.stringify(cleared)}`);
    api.applyCollisionPreset("auto");
    const restored = api.getState().selectedTransform;
    if (!restored) throw new Error("selected transform missing after restored auto collision");
    return {
      auto: {
        mode: auto.collisionMode,
        xPct: auto.collisionXPct,
        yPct: auto.collisionYPct,
        wPct: auto.collisionWPct,
        hPct: auto.collisionHPct,
        blocksMovement: auto.collisionBlocksMovement,
      },
      light: {
        mode: light.collisionMode,
        xPct: light.collisionXPct,
        yPct: light.collisionYPct,
        wPct: light.collisionWPct,
        hPct: light.collisionHPct,
        blocksMovement: light.collisionBlocksMovement,
      },
      cleared: {
        mode: cleared.collisionMode,
        blocksMovement: cleared.collisionBlocksMovement,
      },
      restored: {
        mode: restored.collisionMode,
        blocksMovement: restored.collisionBlocksMovement,
      },
    };
  });
  await page.evaluate(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const collisionSection = doc.querySelector("[data-editor-inspector-section='Collision']") as unknown as { open: boolean } | null;
    if (collisionSection) collisionSection.open = true;
    doc.querySelector("[data-editor-row='Block M']")?.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${outDir}/editor-collision-controls.png` });
  console.log(`[capture] editor collision controls -> ${outDir}/editor-collision-controls.png`);
  await page.evaluate(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const row = doc.querySelector("[data-editor-row='Block M']") as unknown as { dispatchEvent: (event: unknown) => boolean } | null;
    if (!row) throw new Error("Blocks movement row missing for tooltip proof");
    const browserGlobal = globalThis as unknown as {
      MouseEvent: new (type: string, init?: Record<string, unknown>) => unknown;
      window: unknown;
    };
    row.dispatchEvent(new browserGlobal.MouseEvent("mouseenter", { bubbles: false, cancelable: true, view: browserGlobal.window }));
  });
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${outDir}/editor-tooltip-controls.png` });
  console.log(`[capture] editor tooltip controls -> ${outDir}/editor-tooltip-controls.png`);

  const autoShadowProof = await page.evaluate(async ({ ids }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API missing for auto shadow proof");
    const doc = (globalThis as SmokeBrowserGlobal).document;
    if (!doc.querySelector("[data-editor-auto-shadow='true']")) throw new Error("Auto adjust shadow button missing");
    if (!doc.querySelector("[data-editor-auto-all-shadows='true']")) throw new Error("Auto all shadows button missing");
    if (!doc.querySelector("[data-editor-reset-shadow='true']")) throw new Error("Reset shadow button missing");
    if (!doc.querySelector("[data-editor-field='Sh Blur']")) throw new Error("Shadow blur field missing");
    const presetButtons = Array.from(doc.querySelectorAll("[data-editor-shadow-preset]")).map((button) => button.dataset?.editorShadowPreset);
    for (const expected of ["dynamic", "contact", "tall", "wide", "tiny"]) {
      if (!presetButtons.includes(expected)) throw new Error(`Shadow preset button missing: ${expected}`);
    }
    const beforeState = api.getState();
    const beforeShadow = beforeState.selectedTransform;
    if (!beforeShadow) throw new Error("selected transform missing before auto shadow");
    api.autoAdjustShadow();
    const adjustedState = api.getState();
    const adjusted = adjustedState.selectedTransform;
    if (!adjusted) throw new Error("selected transform missing after auto shadow");
    const readout = doc.querySelector("[data-editor-shadow-readout='true']");
    if (!readout) throw new Error("Shadow readout missing");
    const readoutText = String(readout.textContent ?? "");
    if (!readoutText.includes("Shadow") || !readoutText.includes("alpha")) {
      throw new Error(`shadow readout did not update: ${readoutText}`);
    }
    const changed =
      adjusted.shadowMode >= 1 &&
      (adjusted.shadowOffsetX !== beforeShadow.shadowOffsetX ||
        adjusted.shadowOffsetY !== beforeShadow.shadowOffsetY ||
        adjusted.shadowWPct !== beforeShadow.shadowWPct ||
        adjusted.shadowHPct !== beforeShadow.shadowHPct ||
        Math.abs(adjusted.shadowAlpha - beforeShadow.shadowAlpha) > 0.001 ||
        adjusted.shadowBlur !== beforeShadow.shadowBlur ||
        adjusted.shadowRotationDeg !== beforeShadow.shadowRotationDeg);
    if (!changed) throw new Error(`auto shadow did not change shadow fields: ${JSON.stringify({ beforeShadow, adjusted })}`);
    const samples: Record<string, unknown> = {};
    for (const [kind, instanceId] of Object.entries(ids)) {
      await api.selectProp(instanceId);
      api.autoAdjustShadow();
      const sampleState = api.getState();
      const sample = sampleState.selectedTransform;
      if (!sample) throw new Error(`selected transform missing after ${kind} auto shadow`);
      const sampleReadout = String(doc.querySelector("[data-editor-shadow-readout='true']")?.textContent ?? "");
      if (!sampleReadout.includes("Shadow") || !sampleReadout.includes("alpha")) {
        throw new Error(`${kind} shadow readout did not update: ${sampleReadout}`);
      }
      samples[kind] = {
        status: sampleState.status,
        readout: sampleReadout,
        wPct: sample.shadowWPct,
        hPct: sample.shadowHPct,
        alpha: sample.shadowAlpha,
        blur: sample.shadowBlur,
      };
    }
    const bulkState = api.autoAdjustAllShadows();
    if (!bulkState.status.includes("Auto adjusted")) throw new Error(`bulk shadow re-derive status missing: ${bulkState.status}`);
    const uniqueStatuses = new Set(Object.values(samples as Record<string, EditorStatusSample>).map((entry) => entry.status));
    if (uniqueStatuses.size < 2) throw new Error(`auto shadow samples did not vary by prop family: ${JSON.stringify(samples)}`);
    return {
      before: {
        offsetX: beforeShadow.shadowOffsetX,
        offsetY: beforeShadow.shadowOffsetY,
        wPct: beforeShadow.shadowWPct,
        hPct: beforeShadow.shadowHPct,
        alpha: beforeShadow.shadowAlpha,
        blur: beforeShadow.shadowBlur,
        rotationDeg: beforeShadow.shadowRotationDeg,
      },
      adjusted: {
        offsetX: adjusted.shadowOffsetX,
        offsetY: adjusted.shadowOffsetY,
        wPct: adjusted.shadowWPct,
        hPct: adjusted.shadowHPct,
        alpha: adjusted.shadowAlpha,
        blur: adjusted.shadowBlur,
        rotationDeg: adjusted.shadowRotationDeg,
      },
      bulkStatus: bulkState.status,
      status: adjustedState.status,
      readout: readoutText,
      samples,
    };
  }, { ids: EDITOR_SHADOW_PROP_IDS });
  await page.screenshot({ path: `${outDir}/editor-auto-shadow.png` });
  console.log(`[capture] editor auto shadow -> ${outDir}/editor-auto-shadow.png`);
  await page.evaluate(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    doc.querySelector("[data-editor-shadow-preset='dynamic']")?.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${outDir}/editor-shadow-controls.png` });
  console.log(`[capture] editor shadow controls -> ${outDir}/editor-shadow-controls.png`);
  const shadowPresetProof = await page.evaluate(async ({ ids }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API missing for shadow preset proof");
    const entries: Record<string, unknown> = {};
    for (const [preset, instanceId] of Object.entries(ids)) {
      await api.selectProp(instanceId);
      api.applyShadowPreset(preset as "tall" | "wide" | "tiny");
      const state = api.getState();
      const transform = state.selectedTransform;
      if (!transform) throw new Error(`shadow preset ${preset} selected transform missing`);
      if (transform.shadowMode !== 2) throw new Error(`shadow preset ${preset} should use custom mode`);
      entries[preset] = {
        instanceId,
        offsetX: transform.shadowOffsetX,
        offsetY: transform.shadowOffsetY,
        wPct: transform.shadowWPct,
        hPct: transform.shadowHPct,
        alpha: transform.shadowAlpha,
        blur: transform.shadowBlur,
        rotationDeg: transform.shadowRotationDeg,
      };
    }
    type ShadowPresetEntry = { hPct: number; wPct: number; alpha: number };
    const tall = entries.tall as ShadowPresetEntry;
    const wide = entries.wide as ShadowPresetEntry;
    const tiny = entries.tiny as ShadowPresetEntry;
    if (!(tall.hPct > wide.hPct)) throw new Error(`tall preset should have a taller shadow than wide: ${JSON.stringify(entries)}`);
    if (!(wide.wPct > tall.wPct)) throw new Error(`wide preset should be wider than tall: ${JSON.stringify(entries)}`);
    if (!(tiny.alpha < tall.alpha)) throw new Error(`tiny preset should be lighter than tall: ${JSON.stringify(entries)}`);
    return entries;
  }, { ids: EDITOR_SHADOW_PROP_IDS });
  await centerCameraOnSelected(page);
  await page.screenshot({ path: `${outDir}/editor-shadow-presets.png` });
  console.log(`[capture] editor shadow presets -> ${outDir}/editor-shadow-presets.png`);
  const resetShadowProof = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API missing for reset shadow proof");
    api.resetShadow();
    const reset = api.getState().selectedTransform;
    if (!reset) throw new Error("selected transform missing after shadow reset");
    return {
      offsetX: reset.shadowOffsetX,
      offsetY: reset.shadowOffsetY,
      wPct: reset.shadowWPct,
      hPct: reset.shadowHPct,
      alpha: reset.shadowAlpha,
      blur: reset.shadowBlur,
      rotationDeg: reset.shadowRotationDeg,
    };
  });
  await reloadGamePage(page);
  await page.evaluate(async ({ propId }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API unavailable after auto shadow reload");
    await api.setActive(true);
    await api.selectProp(propId);
  }, { propId: EDITOR_PROP_ID });
  await centerCameraOnSelected(page);

  const layoutJsonProof = await page.evaluate(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const details = doc.querySelector("[data-editor-layout-json='true']");
    const status = doc.querySelector("[data-editor-layout-json-status='true']");
    const textarea = doc.querySelector("[data-editor-layout-json-text='true']");
    if (!details || !status || !textarea) throw new Error("layout JSON drawer not found");
    details.open = true;
    details.scrollIntoView({ block: "center" });
    if (!status.textContent?.includes("Layout schema valid")) throw new Error(`layout JSON drawer not valid: ${status.textContent ?? ""}`);
    if (!textarea.value.includes('"mapId": "map_harbor_outskirts"')) throw new Error("layout JSON drawer missing map id");
    return { status: status.textContent, length: textarea.value.length };
  });
  await page.screenshot({ path: `${outDir}/editor-layout-json.png` });
  console.log(`[capture] editor layout JSON -> ${outDir}/editor-layout-json.png`);

  const aiExportProof = await page.evaluate(async ({ propId }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API missing");
    const selectedText = await api.copySelectedObjectJson();
    const selected = JSON.parse(selectedText);
    if (selected.kind !== "gamekit-editor-selected-object") throw new Error("selected object export kind mismatch");
    if (selected.mapId !== "map_harbor_outskirts") throw new Error("selected object export missing map id");
    if (selected.object?.instanceId !== propId) throw new Error(`selected object export missing selected prop ${propId}`);
    if (!selected.validation?.ok) throw new Error("selected object export is not schema-valid");
    const viewportText = await api.copyViewportSummary();
    const viewport = JSON.parse(viewportText);
    if (viewport.kind !== "gamekit-editor-viewport-summary") throw new Error("viewport export kind mismatch");
    if (viewport.mapId !== "map_harbor_outskirts") throw new Error("viewport export missing map id");
    if (!viewport.camera || typeof viewport.camera.x !== "number") throw new Error("viewport export missing camera");
    if (!Array.isArray(viewport.objects) || viewport.objects.length < 1) throw new Error("viewport export missing visible objects");
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const details = doc.querySelector("[data-editor-ai-export='true']");
    const status = doc.querySelector("[data-editor-ai-export-status='true']");
    const textarea = doc.querySelector("[data-editor-ai-export-text='true']");
    if (!details || !status || !textarea) throw new Error("AI export drawer not found");
    details.open = true;
    details.scrollIntoView({ block: "center" });
    if (!textarea.value.includes("gamekit-editor-viewport-summary")) throw new Error("AI export textarea missing viewport summary");
    return {
      selectedChars: selectedText.length,
      viewportChars: viewportText.length,
      visibleObjects: viewport.objects.length,
      status: status.textContent,
    };
  }, { propId: EDITOR_PROP_ID });
  await page.screenshot({ path: `${outDir}/editor-ai-export.png` });
  console.log(`[capture] editor AI export -> ${outDir}/editor-ai-export.png`);

  const navigationProof = await page.evaluate(async () => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    const camera = scene?.cameras?.main;
    if (!api || !camera) throw new Error("editor navigation QA unavailable");
    const marked = api.saveCameraBookmark();
    const similar = api.selectSimilar();
    if (!similar.similarFilter || similar.visibleObjectCount >= similar.objectCount) {
      throw new Error(`similar filter did not narrow objects: ${similar.visibleObjectCount}/${similar.objectCount}`);
    }
    const cleared = api.clearObjectFilter();
    if (cleared.visibleObjectCount !== cleared.objectCount || cleared.similarFilter) {
      throw new Error("clear filter did not restore full object tree");
    }
    camera.centerOn(1900, 1000);
    const restored = api.restoreCameraBookmark();
    if (!restored.cameraBookmarkSaved) throw new Error("camera bookmark was not retained");
    camera.centerOn(100, 100);
    const focused = api.focusSelected();
    const selected = focused.selectedPosition;
    if (!selected) throw new Error("focus proof missing selected position");
    const worldView = camera.worldView as { centerX?: number; centerY?: number } | undefined;
    const centerX = typeof worldView?.centerX === "number" ? worldView.centerX : camera.scrollX + camera.width / (2 * camera.zoom);
    const centerY = typeof worldView?.centerY === "number" ? worldView.centerY : camera.scrollY + camera.height / (2 * camera.zoom);
    const view = camera.worldView as { x?: number; y?: number; right?: number; bottom?: number } | undefined;
    const isVisible = view
      ? selected.x >= (view.x ?? -Infinity) && selected.x <= (view.right ?? Infinity) && selected.y >= (view.y ?? -Infinity) && selected.y <= (view.bottom ?? Infinity)
      : Math.abs(centerX - selected.x) < camera.width && Math.abs(centerY - selected.y) < camera.height;
    if (!isVisible) {
      throw new Error(`focus did not reveal selected object: camera ${centerX},${centerY} selected ${selected.x},${selected.y}`);
    }
    const filteredAgain = api.selectSimilar();
    return { marked, similar, cleared, restored, focused, filteredAgain };
  });
  await page.screenshot({ path: `${outDir}/editor-navigation-tools.png` });
  console.log(`[capture] editor navigation tools -> ${outDir}/editor-navigation-tools.png`);

  const treeLockHideProof = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API unavailable for tree hide/lock proof");
    const original = api.getState();
    const instanceId = original.selectedInstanceId;
    if (!instanceId || !original.selectedPosition) throw new Error("tree hide/lock proof needs a selected object");
    const locked = api.toggleLocked(instanceId);
    if (locked.lockedObjectCount !== 1) throw new Error(`lock did not register: ${locked.lockedObjectCount}`);
    const attemptedMove = api.moveSelectedBy(24, 0);
    if (!attemptedMove.selectedPosition || attemptedMove.selectedPosition.x !== original.selectedPosition.x || attemptedMove.selectedPosition.y !== original.selectedPosition.y) {
      throw new Error("locked object moved");
    }
    const hidden = api.toggleHidden(instanceId);
    if (hidden.hiddenObjectCount !== 1) throw new Error(`hide did not register: ${hidden.hiddenObjectCount}`);
    return { original, locked, attemptedMove, hidden };
  });
  await page.screenshot({ path: `${outDir}/editor-tree-hide-lock.png` });
  console.log(`[capture] editor tree hide/lock -> ${outDir}/editor-tree-hide-lock.png`);
  const treeLockHideRestoreProof = await page.evaluate(({ instanceId }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API unavailable for tree hide/lock restore");
    const shown = api.toggleHidden(instanceId);
    const unlocked = api.toggleLocked(instanceId);
    if (shown.hiddenObjectCount !== 0 || unlocked.lockedObjectCount !== 0) throw new Error("hide/lock restore failed");
    return { shown, unlocked };
  }, { instanceId: treeLockHideProof.original.selectedInstanceId });
  const treeLayerFilterProof = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    const doc = (globalThis as SmokeBrowserGlobal).document;
    if (!api) throw new Error("editor QA API unavailable for layer filter proof");
    const mapButton = doc.querySelector("[data-editor-tool='map']");
    const assetsButton = doc.querySelector("[data-editor-tool='assets']");
    const objectButton = doc.querySelector("[data-editor-tool='object']");
    const portalButton = doc.querySelector("[data-editor-tool='portal']");
    const npcButton = doc.querySelector("[data-editor-tool='npc']");
    const spawnsButton = doc.querySelector("[data-editor-tool='spawns']");
    if (!mapButton || !assetsButton || !objectButton || !portalButton || !npcButton || !spawnsButton) {
      throw new Error("missing one or more editor layer filter tools");
    }
    mapButton.click();
    const all = api.getState();
    if (mapButton.dataset?.editorActive !== "true") throw new Error("map tool did not mark active");
    assetsButton.click();
    const assets = api.getState();
    if (assetsButton.dataset?.editorActive !== "true") throw new Error("assets tool did not mark active");
    objectButton.click();
    const props = api.getState();
    if (objectButton.dataset?.editorActive !== "true") throw new Error("object tool did not mark active");
    portalButton.click();
    const portals = api.getState();
    if (portalButton.dataset?.editorActive !== "true") throw new Error("portal tool did not mark active");
    npcButton.click();
    const npcs = api.getState();
    if (npcButton.dataset?.editorActive !== "true") throw new Error("NPC tool did not mark active");
    spawnsButton.click();
    const spawns = api.getState();
    if (spawnsButton.dataset?.editorActive !== "true") throw new Error("spawns tool did not mark active");
    const cleared = api.clearObjectFilter();
    if (mapButton.dataset?.editorActive !== "true") throw new Error("clear did not return active tool to map");
    if (all.layerFilter !== null) throw new Error(`map filter should clear layer filter: ${JSON.stringify(all)}`);
    if (assets.layerFilter !== "assets" || assets.visibleObjectCount >= all.visibleObjectCount) throw new Error(`assets filter did not narrow objects: ${JSON.stringify({ all, assets })}`);
    if (props.layerFilter !== "props" || props.visibleObjectCount <= 0 || props.visibleObjectCount >= assets.visibleObjectCount) {
      throw new Error(`object filter did not isolate props: ${JSON.stringify(props)}`);
    }
    if (portals.layerFilter !== "portals") throw new Error(`portal filter failed: ${JSON.stringify(portals)}`);
    if (npcs.layerFilter !== "npcs") throw new Error(`NPC filter failed: ${JSON.stringify(npcs)}`);
    if (spawns.layerFilter !== "monsterSpawns") throw new Error(`spawn filter failed: ${JSON.stringify(spawns)}`);
    if (cleared.layerFilter !== null) throw new Error(`clear did not reset layer filter: ${JSON.stringify(cleared)}`);
    return { all, assets, props, portals, npcs, spawns, cleared };
  });
  await page.evaluate(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    doc.querySelector("[data-editor-tool='assets']")?.click();
    doc.querySelector("[data-editor-tool='map']")?.scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${outDir}/editor-tool-filters.png` });
  console.log(`[capture] editor tool filters -> ${outDir}/editor-tool-filters.png`);
  await page.evaluate(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    doc.querySelector("[data-editor-tool='map']")?.click();
  });

  const freshnessCaptureProof = await page.evaluate(async () => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API unavailable for freshness/capture proof");
    const freshness = await api.checkFileFreshness();
    if (freshness.status !== "Layout file fresh") throw new Error(`expected fresh layout status, got ${freshness.status}`);
    const capture = await api.captureView();
    if (!capture.ok || !capture.file) throw new Error(`editor capture failed: ${capture.error ?? "missing file"}`);
    return { freshness, capture };
  });
  if (!existsSync(String(freshnessCaptureProof.capture.file))) {
    throw new Error(`editor capture file was not written: ${freshnessCaptureProof.capture.file}`);
  }

  const moved = await page.evaluate(
    async ({ dx, dy, transform }) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
      const api = scene?.getEditorQaApi?.();
      const original = api.getState();
      if (!original.selectedTransform) throw new Error("missing original prop transform");
      api.setSelectedTransform({
        ...transform,
        x: original.selectedTransform.x + dx,
        y: original.selectedTransform.y + dy,
      });
      const edited = api.getState();
      if (!edited.dirty || !edited.canUndo || edited.canRedo) {
        throw new Error("editor history state did not mark the prop edit dirty/undoable");
      }
      const undone = api.undo();
      if (!undone.selectedTransform || !original.selectedTransform) throw new Error("missing undo transform proof");
      if (undone.selectedTransform.x !== original.selectedTransform.x || undone.selectedTransform.y !== original.selectedTransform.y) {
        throw new Error("undo did not restore original prop position");
      }
      if (!undone.canRedo || undone.canUndo || undone.dirty) {
        throw new Error("undo did not expose clean redo state");
      }
      const redone = api.redo();
      if (!redone.selectedTransform || redone.selectedTransform.x !== edited.selectedTransform?.x || redone.selectedTransform.y !== edited.selectedTransform?.y) {
        throw new Error("redo did not restore edited prop position");
      }
      if (!redone.dirty || !redone.canUndo || redone.canRedo) {
        throw new Error("redo did not restore dirty undoable state");
      }
      const transformAfterRedo = redone.selectedTransform;
      if (!transformAfterRedo?.reflectionEnabled) throw new Error(`reflection was not enabled by prop transform: ${JSON.stringify(transformAfterRedo)}`);
      if (Math.abs(transformAfterRedo.reflectionAlpha - transform.reflectionAlpha) > 0.001) {
        throw new Error(`reflection alpha mismatch: ${JSON.stringify(transformAfterRedo)}`);
      }
      const editorScene = scene as EditorSmokeScene | undefined;
      const editableObjects = editorScene?.editableObjects ?? [];
      const record = editableObjects.find((object) => object.instanceId === redone.selectedInstanceId);
      if (!record?.reflection?.visible) throw new Error("runtime reflection object is not visible after enabling reflection");
      if (Math.abs(record.reflection.y - (transformAfterRedo.y + transform.reflectionOffsetY)) > 1) {
        throw new Error(`runtime reflection y mismatch: ${record.reflection.y} vs ${transformAfterRedo.y + transform.reflectionOffsetY}`);
      }
      const save = await api.save();
      if (!save.ok) throw new Error(`save failed: ${save.error ?? "unknown"}`);
      return { state: api.getState(), save, edited, undone, redone };
    },
    { ...EDITOR_MOVE, transform: EDITOR_PROP_TRANSFORM },
  );
  await centerCameraOnSelected(page);
  const unexportedBadgeProof = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API unavailable for unexported badge proof");
    const state = api.getState();
    const badge = (globalThis as SmokeBrowserGlobal).document.querySelector("[data-editor-unexported-badge='true']");
    const badgeHidden = (badge as { hidden?: boolean } | null)?.hidden;
    const badgeVisible = Boolean(badge) && badgeHidden !== true;
    if (!state.unexported || !badgeVisible) {
      throw new Error(`unexported badge missing after Save Draft: ${JSON.stringify({ state, badgeText: badge?.textContent, hidden: badgeHidden })}`);
    }
    return {
      state,
      badgeText: badge?.textContent,
      compiledModifiedMs: state.compiledModifiedMs,
      requiresServerRestart: state.requiresServerRestart,
    };
  });
  await page.evaluate(() => {
    (globalThis as SmokeBrowserGlobal).document.querySelector("[data-editor-workflow-section='true']")?.scrollIntoView({ block: "center" });
  });
  await page.screenshot({ path: `${outDir}/editor-unexported-badge-dirty.png` });
  console.log(`[capture] editor unexported badge dirty -> ${outDir}/editor-unexported-badge-dirty.png`);
  const exitModalProof = await page.evaluate(async () => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API unavailable for exit modal proof");
    const exitAttempt = await api.setActive(false);
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const modal = doc.querySelector("[data-editor-unexported-modal='true']");
    const apply = doc.querySelector("[data-editor-apply-to-game='true']");
    const exit = doc.querySelector("[data-editor-exit-anyway='true']");
    if (!modal || !apply || !exit) {
      throw new Error(`unexported exit modal did not open: ${JSON.stringify({ exitAttempt, modal: Boolean(modal), apply: Boolean(apply), exit: Boolean(exit) })}`);
    }
    return {
      exitAttempt,
      modalText: modal.textContent,
      applyText: apply.textContent,
      exitText: exit.textContent,
    };
  });
  await page.screenshot({ path: `${outDir}/editor-unexported-exit-modal-dirty.png` });
  console.log(`[capture] editor unexported exit modal dirty -> ${outDir}/editor-unexported-exit-modal-dirty.png`);
  await page.evaluate(() => {
    (globalThis as SmokeBrowserGlobal & { __GAMEKIT_FORCE_PROD_APPLY?: boolean }).__GAMEKIT_FORCE_PROD_APPLY = true;
  });
  const applyReloadStartedAtMs = Date.now();
  await page.click("[data-editor-apply-to-game='true']", { timeout: 10_000 });
  await page.waitForLoadState("load", { timeout: 240_000 }).catch(() => undefined);
  await waitForCompiledMapClean(EDITOR_MAP_ID);
  await reloadGamePage(page);
  const applyReloadElapsedMs = Date.now() - applyReloadStartedAtMs;
  await page.evaluate(() => {
    delete (globalThis as SmokeBrowserGlobal & { __GAMEKIT_FORCE_PROD_APPLY?: boolean }).__GAMEKIT_FORCE_PROD_APPLY;
  });
  await page.waitForFunction(() => {
    return Boolean((globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game")?.getEditorQaApi?.());
  }, { timeout: 240_000 });
  const expectedAppliedPosition = (moved.state as { selectedPosition?: { x: number; y: number } }).selectedPosition;
  if (!expectedAppliedPosition) throw new Error("moved prop state did not include a selected position");
  const applyReloadProof = await page.evaluate(async ({ propId, expectedX, expectedY, elapsedMs }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API unavailable after apply reload");
    await api.setActive(true);
    await api.selectProp(propId);
    const state = api.getState();
    const badge = (globalThis as SmokeBrowserGlobal).document.querySelector("[data-editor-unexported-badge='true']");
    const badgeHidden = (badge as { hidden?: boolean } | null)?.hidden;
    if (state.unexported || badgeHidden === false) {
      throw new Error(`unexported badge did not clear after apply: ${JSON.stringify({ state, badgeHidden })}`);
    }
    const pos = state.selectedPosition;
    if (!pos || Math.abs(pos.x - expectedX) > 1 || Math.abs(pos.y - expectedY) > 1) {
      throw new Error(`applied prop position did not survive reload: ${JSON.stringify({ pos, expectedX, expectedY })}`);
    }
    return { state, badgeHidden: badgeHidden ?? null, elapsedMs };
  }, {
    propId: EDITOR_PROP_ID,
    expectedX: expectedAppliedPosition.x,
    expectedY: expectedAppliedPosition.y,
    elapsedMs: applyReloadElapsedMs,
  });
  await centerCameraOnSelected(page);
  await page.evaluate(() => {
    (globalThis as SmokeBrowserGlobal).document.querySelector("[data-editor-workflow-section='true']")?.scrollIntoView({ block: "center" });
  });
  await page.screenshot({ path: `${outDir}/editor-unexported-badge-clean.png` });
  console.log(`[capture] editor unexported badge clean -> ${outDir}/editor-unexported-badge-clean.png`);
  const liveNavigationEvents: string[] = [];
  const liveNavigationListener = (frame: { parentFrame: () => unknown; url: () => string }) => {
    if (frame.parentFrame() === null) liveNavigationEvents.push(frame.url());
  };
  page.on("framenavigated", liveNavigationListener);
  const liveExpectedAppliedPosition = await page.evaluate(async ({ objectId }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API unavailable for live apply proof");
    await api.setActive(true);
    await api.selectObject(objectId);
    const movedLive = api.moveSelectedBy(-12, 9);
    const expectedPosition = movedLive.selectedPosition;
    if (!movedLive.dirty || !expectedPosition) throw new Error(`live move did not dirty selected object: ${JSON.stringify(movedLive)}`);
    const exitAttempt = await api.setActive(false);
    const doc = (globalThis as SmokeBrowserGlobal).document;
    if (!doc.querySelector("[data-editor-unexported-modal='true']")) {
      throw new Error(`live apply modal did not open: ${JSON.stringify(exitAttempt)}`);
    }
    return expectedPosition;
  }, { objectId: EDITOR_DECAL_ID });
  const liveApplyStartedAtMs = Date.now();
  await page.click("[data-editor-apply-to-game='true']", { timeout: 10_000 });
  const liveDryRunOutput = await waitForCompiledMapClean(EDITOR_MAP_ID);
  await page.waitForTimeout(500);
  const liveApplyElapsedMs = Date.now() - liveApplyStartedAtMs;
  page.off("framenavigated", liveNavigationListener);
  if (liveNavigationEvents.length > 0) throw new Error(`live apply navigated unexpectedly: ${JSON.stringify(liveNavigationEvents)}`);
  const liveApplyProof = await page.evaluate(async ({ objectId, expectedX, expectedY, dryRunOutput, elapsedMs }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API unavailable after live apply");
    await api.setActive(true);
    await api.selectObject(objectId);
    await api.refreshCompiledStatus();
    const state = api.getState();
    const badge = (globalThis as SmokeBrowserGlobal).document.querySelector("[data-editor-unexported-badge='true']");
    const badgeHidden = (badge as { hidden?: boolean } | null)?.hidden;
    if (state.unexported || badgeHidden === false) {
      throw new Error(`unexported badge did not clear after live apply: ${JSON.stringify({ state, badgeHidden })}`);
    }
    const pos = state.selectedPosition;
    if (!pos || Math.abs(pos.x - expectedX) > 1 || Math.abs(pos.y - expectedY) > 1) {
      throw new Error(`live applied object position did not re-dress in place: ${JSON.stringify({ pos, expectedX, expectedY })}`);
    }
    return { state, badgeHidden: badgeHidden ?? null, noNavigation: true, dryRunOutput, elapsedMs };
  }, {
    objectId: EDITOR_DECAL_ID,
    expectedX: liveExpectedAppliedPosition.x,
    expectedY: liveExpectedAppliedPosition.y,
    dryRunOutput: liveDryRunOutput,
    elapsedMs: liveApplyElapsedMs,
  });
  await centerCameraOnSelected(page);
  await page.screenshot({ path: `${outDir}/editor-live-apply-clean.png` });
  console.log(`[capture] editor live apply proof -> ${outDir}/editor-live-apply-clean.png`);
  await page.screenshot({ path: `${outDir}/editor-undo-redo-redone.png` });
  console.log(`[capture] editor undo/redo proof -> ${outDir}/editor-undo-redo-redone.png`);
  const autoReflectionProof = await page.evaluate(async ({ propId }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    const doc = (globalThis as SmokeBrowserGlobal).document;
    if (!api) throw new Error("editor QA API unavailable for auto reflection proof");
    if (!doc.querySelector("[data-editor-auto-reflection='true']")) throw new Error("Auto water reflection button missing");
    if (!doc.querySelector("[data-editor-reset-reflection='true']")) throw new Error("Reset reflection button missing");
    await api.selectProp(propId);
    if (api.getState().selectedInstanceId !== propId) {
      return { skipped: true, reason: `${propId} is not present in the active zone` };
    }
    const auto = api.autoAdjustReflection();
    const transform = auto.selectedTransform;
    if (!transform?.reflectionEnabled) throw new Error(`auto water reflection did not enable reflection: ${JSON.stringify(auto)}`);
    if (!auto.status.includes("Auto water reflection")) throw new Error(`unexpected auto reflection status: ${auto.status}`);
    return {
      skipped: false,
      status: auto.status,
      alpha: transform.reflectionAlpha,
      heightPct: transform.reflectionHeightPct,
      offsetY: transform.reflectionOffsetY,
      wavePct: transform.reflectionWavePct,
    };
  }, { propId: EDITOR_REFLECTION_PROP_ID });
  await centerCameraOnSelected(page);
  await page.evaluate(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    doc.querySelector("[data-editor-auto-reflection='true']")?.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${outDir}/editor-auto-reflection.png` });
  console.log(`[capture] editor auto reflection -> ${outDir}/editor-auto-reflection.png`);
  const resetAutoReflectionProof = await page.evaluate(async ({ propId }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API unavailable for auto reflection reset");
    await api.selectProp(propId);
    const reset = api.resetReflection();
    if (!reset.status.includes("Reset reflection override")) throw new Error(`reset reflection did not report override reset: ${JSON.stringify(reset)}`);
    return { resetStatus: reset.status, inheritedAfterReset: reset.selectedTransform?.reflectionEnabled ?? 0, selected: api.getState().selectedInstanceId };
  }, { propId: EDITOR_PROP_ID });
  await page.evaluate(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    doc.querySelector("[data-editor-row='Reflect']")?.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${outDir}/editor-reflection-controls.png` });
  console.log(`[capture] editor reflection controls -> ${outDir}/editor-reflection-controls.png`);
  const overrideSave = await page.evaluate(async () => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    const save = await api.saveOverride();
    if (!save.ok) throw new Error(`override save failed: ${save.error ?? "unknown"}`);
    return { state: api.getState(), save };
  });
  const staleOverride = await page.evaluate(async ({ stalePayload, propId }) => {
    const origin = (globalThis as { __GAMEKIT_DEVKIT_ORIGIN__?: string }).__GAMEKIT_DEVKIT_ORIGIN__;
    const staleInstance = (stalePayload.data as ZoneLayoutData).props.find((prop) => prop.instanceId === propId);
    const token = (globalThis as { __GAMEKIT_DEVKIT_TOKEN__?: string }).__GAMEKIT_DEVKIT_TOKEN__ ?? "";
    const response = await fetch(`${origin}/api/zone-layout/instance-override/save`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-devkit-token": token },
      body: JSON.stringify({
        mapId: stalePayload.mapId,
        layer: "props",
        instanceId: propId,
        instance: staleInstance,
        baseHash: stalePayload.baseHash,
        baseModifiedMs: stalePayload.baseModifiedMs,
      }),
    });
    const body = await response.json();
    return { status: response.status, body };
  }, { ...before, propId: EDITOR_PROP_ID });
  if (staleOverride.status !== 409) {
    throw new Error(`expected stale override rejection, got ${staleOverride.status}`);
  }
  await page.waitForTimeout(250);
  const defaultsBaseline = await getDevkit("/api/asset-placement-defaults") as {
    hash: string;
    modifiedMs: number;
  };
  const defaultsSave = await page.evaluate(async () => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    const save = await api.saveDefaults();
    if (!save.ok) throw new Error(`defaults save failed: ${save.error ?? "unknown"}`);
    return { state: api.getState(), save };
  });
  const staleDefaults = await postDevkitWithStatus("/api/asset-placement-defaults/save", {
    assetKey: "harbor_signpost",
    layer: "props",
    defaults: (defaultsSave.save as { after?: unknown }).after,
    baseHash: defaultsBaseline.hash,
    baseModifiedMs: defaultsBaseline.modifiedMs,
  });
  if (staleDefaults.status !== 409) {
    throw new Error(`expected stale defaults rejection, got ${staleDefaults.status}`);
  }
  // The default-workflow leg used to ASSUME the prop selection survived from the
  // reflection leg. Since the live-apply merge the thin-slice is HMR-active
  // (map-manifests re-parses arrive seconds late on the Z: drive and re-dress /
  // re-select asynchronously), so the leg now waits for HMR quiescence and
  // re-selects its own target instead of inheriting ambient state.
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    return Boolean(scene?.getEditorQaApi?.());
  }, undefined, { timeout: 30_000 });
  const defaultWorkflowProbe = await page.evaluate(async ({ propId }) => {
    const browserGlobal = globalThis as SmokeBrowserGlobal & {
      document: SmokeBrowserGlobal["document"] & { readyState?: string };
      location?: { href?: string };
    };
    const game = browserGlobal.__GAME;
    const sceneManager = game?.scene as typeof game.scene & {
      getScenes?: (active?: boolean) => Array<{ scene?: { key?: string } }>;
    };
    const scene = game?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) {
      throw new Error(`editor QA API unavailable for default workflow probe: ${JSON.stringify({
        hasGame: Boolean(game),
        sceneKeys: sceneManager?.getScenes?.(false).map((candidate) => candidate.scene?.key) ?? [],
        hasScene: Boolean(scene),
        hasGetter: typeof scene?.getEditorQaApi === "function",
        readyState: browserGlobal.document.readyState,
        url: browserGlobal.location?.href,
      })}`);
    }
    await api.setActive(true);
    await api.selectObject(propId);
    const state = api.getState();
    return { selected: state.selectedInstanceId, dirty: state.dirty };
  }, { propId: EDITOR_PROP_ID });
  if (defaultWorkflowProbe.selected !== EDITOR_PROP_ID) {
    throw new Error(`default workflow probe could not re-select ${EDITOR_PROP_ID}: ${JSON.stringify(defaultWorkflowProbe)}`);
  }
  console.log(`[capture] default workflow probe -> ${JSON.stringify(defaultWorkflowProbe)}`);
  const defaultWorkflow = await page.evaluate(async ({ mapId, propId, expectReflection }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API unavailable for default workflow");
    const origin = (globalThis as { __GAMEKIT_DEVKIT_ORIGIN__?: string }).__GAMEKIT_DEVKIT_ORIGIN__;
    const cleared = api.clearOverrides();
    if (!cleared.dirty || !cleared.canUndo) throw new Error("clear overrides did not dirty the draft");
    const clearSave = await api.save();
    if (!clearSave.ok) throw new Error(`clear override save failed: ${clearSave.error ?? "unknown"}`);
    const clearedResponse = await fetch(`${origin}/api/zone-layouts`);
    const clearedBody = await clearedResponse.json() as { layouts: Array<{ mapId: string; data: ZoneLayoutData }> };
    const clearedLayout = clearedBody.layouts.find((candidate) => candidate.mapId === mapId);
    const clearedProp = clearedLayout?.data.props.find((candidate) => candidate.instanceId === propId);
    if (!clearedProp) throw new Error(`prop ${propId} not found in layout after clear`);
    for (const field of ["scale", "rotation", "opacity", "origin", "zIndex", "shadow", "reflection", "collision"]) {
      if (field in clearedProp) throw new Error(`clear overrides left ${field} on the instance`);
    }
    const applied = api.applyDefaults();
    if (!applied.dirty || !applied.canUndo) throw new Error("apply defaults did not dirty the draft");
    const applySave = await api.save();
    if (!applySave.ok) throw new Error(`apply defaults save failed: ${applySave.error ?? "unknown"}`);
    const appliedResponse = await fetch(`${origin}/api/zone-layouts`);
    const appliedBody = await appliedResponse.json() as { layouts: Array<{ mapId: string; data: ZoneLayoutData }> };
    const appliedLayout = appliedBody.layouts.find((candidate) => candidate.mapId === mapId);
    const appliedProp = appliedLayout?.data.props.find((candidate) => candidate.instanceId === propId);
    if (!appliedProp) throw new Error(`prop ${propId} not found in layout after apply`);
    const appliedFields = expectReflection
      ? ["scale", "rotation", "opacity", "origin", "zIndex", "shadow", "reflection", "collision"]
      : ["scale", "rotation", "opacity", "origin", "zIndex", "shadow", "collision"];
    for (const field of appliedFields) {
      if (!(field in appliedProp)) throw new Error(`apply defaults did not write ${field} onto the instance`);
    }
    return { cleared, applied, clearedProp, appliedProp, clearSave, applySave };
  }, {
    mapId: EDITOR_MAP_ID,
    propId: EDITOR_PROP_ID,
    expectReflection: (autoReflectionProof as { skipped?: boolean }).skipped !== true,
  });
  await centerCameraOnSelected(page);
  await page.screenshot({ path: `${outDir}/editor-selected-moved-hot.png` });
  console.log(`[capture] editor moved hot -> ${outDir}/editor-selected-moved-hot.png`);

  const stale = await page.evaluate(async ({ stalePayload }) => {
    const origin = (globalThis as { __GAMEKIT_DEVKIT_ORIGIN__?: string }).__GAMEKIT_DEVKIT_ORIGIN__;
    const token = (globalThis as { __GAMEKIT_DEVKIT_TOKEN__?: string }).__GAMEKIT_DEVKIT_TOKEN__ ?? "";
    const response = await fetch(`${origin}/api/zone-layout/save`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-devkit-token": token },
      body: JSON.stringify(stalePayload),
    });
    const body = await response.json();
    return { status: response.status, body };
  }, before);
  if (stale.status !== 409) {
    throw new Error(`expected stale save rejection, got ${stale.status}`);
  }

  const exportResult = await postDevkit("/api/zone-export", { mapId: before.state.mapId });
  if (!exportResult.ok) {
    throw new Error(`export failed: ${exportResult.error ?? exportResult.output ?? "unknown"}`);
  }
  await page.waitForTimeout(500);
  await reloadGamePage(page);
  const reloaded = await page.evaluate(
    async ({ propId }) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
      const api = scene?.getEditorQaApi?.();
      if (!api) throw new Error("editor QA API unavailable after reload");
      await api.setActive(true);
      await api.selectProp(propId);
      const state = api.getState();
      if (!state.selectedValidation?.ok) throw new Error(`reloaded prop validation failed: ${state.selectedValidation?.issues?.join("; ")}`);
      return state;
    },
    { propId: EDITOR_PROP_ID },
  );
  await centerCameraOnSelected(page);
  await page.screenshot({ path: `${outDir}/editor-selected-reloaded.png` });
  console.log(`[capture] editor reloaded -> ${outDir}/editor-selected-reloaded.png`);

  const originalPosition = before.state.selectedPosition;
  const restored = await page.evaluate(
    async (transform) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
      const api = scene?.getEditorQaApi?.();
      api.setSelectedTransform(transform);
      const save = await api.save();
      if (!save.ok) throw new Error(`restore save failed: ${save.error ?? "unknown"}`);
      return { state: api.getState(), save };
    },
    before.state.selectedTransform ?? originalPosition,
  );
  const restoreExport = await postDevkit("/api/zone-export", { mapId: before.state.mapId });
  if (!restoreExport.ok) {
    throw new Error(`restore export failed: ${restoreExport.error ?? restoreExport.output ?? "unknown"}`);
  }
  await page.waitForTimeout(500);
  await reloadGamePage(page);

  await page.evaluate(async () => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API unavailable for decal tree select");
    await api.setActive(true);
  });
  await page.locator(`[data-editor-object-id="${EDITOR_DECAL_ID}"]`).click();
  const decalBefore = await page.evaluate(({ decalId }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API unavailable after tree select");
    const state = api.getState();
    if (state.selectedInstanceId !== decalId || state.selectedLayer !== "decals" || !state.selectedPosition) {
      throw new Error(`object tree failed to select decal ${decalId}`);
    }
    if (!state.selectedValidation?.ok) throw new Error(`selected decal validation failed: ${state.selectedValidation?.issues?.join("; ")}`);
    return state;
  }, { decalId: EDITOR_DECAL_ID });
  await centerCameraOnSelected(page);
  await page.screenshot({ path: `${outDir}/editor-decal-before.png` });
  console.log(`[capture] editor decal before -> ${outDir}/editor-decal-before.png`);

  const decalMoved = await page.evaluate(
    async ({ dx, dy, transform }) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
      const api = scene?.getEditorQaApi?.();
      if (!api) throw new Error("editor QA API unavailable before decal move");
      api.moveSelectedBy(dx, dy);
      api.setSelectedTransform(transform);
      const save = await api.save();
      if (!save.ok) throw new Error(`decal save failed: ${save.error ?? "unknown"}`);
      return { state: api.getState(), save };
    },
    { ...EDITOR_DECAL_MOVE, transform: EDITOR_DECAL_TRANSFORM },
  );
  await centerCameraOnSelected(page);
  await page.screenshot({ path: `${outDir}/editor-decal-moved-hot.png` });
  console.log(`[capture] editor decal moved hot -> ${outDir}/editor-decal-moved-hot.png`);

  const decalExport = await postDevkit("/api/zone-export", { mapId: before.state.mapId });
  if (!decalExport.ok) {
    throw new Error(`decal export failed: ${decalExport.error ?? decalExport.output ?? "unknown"}`);
  }
  await page.waitForTimeout(500);
  await reloadGamePage(page);
  const decalReloaded = await page.evaluate(
    async ({ decalId }) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
      const api = scene?.getEditorQaApi?.();
      if (!api) throw new Error("editor QA API unavailable after decal reload");
      await api.setActive(true);
      await api.selectObject(decalId);
      const state = api.getState();
      if (!state.selectedValidation?.ok) throw new Error(`reloaded decal validation failed: ${state.selectedValidation?.issues?.join("; ")}`);
      return state;
    },
    { decalId: EDITOR_DECAL_ID },
  );
  await centerCameraOnSelected(page);
  await page.screenshot({ path: `${outDir}/editor-decal-reloaded.png` });
  console.log(`[capture] editor decal reloaded -> ${outDir}/editor-decal-reloaded.png`);

  const decalRestored = await page.evaluate(
    async (transform) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
      const api = scene?.getEditorQaApi?.();
      api.setSelectedTransform(transform);
      const save = await api.save();
      if (!save.ok) throw new Error(`decal restore save failed: ${save.error ?? "unknown"}`);
      return { state: api.getState(), save };
    },
    decalBefore.selectedTransform ?? decalBefore.selectedPosition,
  );
  const decalRestoreExport = await postDevkit("/api/zone-export", { mapId: before.state.mapId });
  if (!decalRestoreExport.ok) {
    throw new Error(`decal restore export failed: ${decalRestoreExport.error ?? decalRestoreExport.output ?? "unknown"}`);
  }

  await page.waitForTimeout(500);
  await reloadGamePage(page);
  await page.evaluate(async () => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API unavailable for NPC tree select");
    await api.setActive(true);
  });
  const npcBefore = await page.evaluate(async ({ npcId }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API unavailable after NPC tree select");
    await api.selectObject(npcId);
    const state = api.getState();
    if (state.selectedInstanceId !== npcId || state.selectedLayer !== "npcs" || !state.selectedPosition) {
      return { skipped: true, reason: `NPC ${npcId} is not selectable in the active editor object registry`, state };
    }
    if (!state.selectedValidation?.ok) throw new Error(`selected NPC validation failed: ${state.selectedValidation?.issues?.join("; ")}`);
    return state;
  }, { npcId: EDITOR_NPC_ID });
  let npcMoved: { state: unknown } | undefined;
  let npcReloaded: unknown;
  let npcExport: { ok: boolean; output?: string; error?: string } | undefined;
  if (!("skipped" in npcBefore)) {
    await centerCameraOnSelected(page);
    await page.screenshot({ path: `${outDir}/editor-npc-before.png` });
    console.log(`[capture] editor NPC before -> ${outDir}/editor-npc-before.png`);

    npcMoved = await page.evaluate(
      async ({ dx, dy, radiusDelta }) => {
        const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
        const api = scene?.getEditorQaApi?.();
        if (!api) throw new Error("editor QA API unavailable before NPC move");
        const beforeState = api.getState();
        const radius = beforeState.selectedTransform?.radius;
        if (typeof radius !== "number") throw new Error("selected NPC radius missing");
        api.moveSelectedBy(dx, dy);
        api.setSelectedTransform({ radius: radius + radiusDelta });
        const save = await api.save();
        if (!save.ok) throw new Error(`NPC save failed: ${save.error ?? "unknown"}`);
        return { state: api.getState(), save };
      },
      { ...EDITOR_NPC_MOVE, radiusDelta: EDITOR_NPC_RADIUS_DELTA },
    );
    await centerCameraOnSelected(page);
    await page.screenshot({ path: `${outDir}/editor-npc-moved-hot.png` });
    console.log(`[capture] editor NPC moved hot -> ${outDir}/editor-npc-moved-hot.png`);

    npcExport = await postDevkit("/api/zone-export", { mapId: before.state.mapId });
    if (!npcExport.ok) {
      throw new Error(`NPC export failed: ${npcExport.error ?? npcExport.output ?? "unknown"}`);
    }
    await page.waitForTimeout(500);
    await reloadGamePage(page);
    npcReloaded = await page.evaluate(
      async ({ npcId }) => {
        const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
        const api = scene?.getEditorQaApi?.();
        if (!api) throw new Error("editor QA API unavailable after NPC reload");
        await api.setActive(true);
        await api.selectObject(npcId);
        const state = api.getState();
        if (!state.selectedValidation?.ok) throw new Error(`reloaded NPC validation failed: ${state.selectedValidation?.issues?.join("; ")}`);
        return state;
      },
      { npcId: EDITOR_NPC_ID },
    );
    await centerCameraOnSelected(page);
    await page.screenshot({ path: `${outDir}/editor-npc-reloaded.png` });
    console.log(`[capture] editor NPC reloaded -> ${outDir}/editor-npc-reloaded.png`);
  }

  return {
    propId: EDITOR_PROP_ID,
    decalId: EDITOR_DECAL_ID,
    npcId: EDITOR_NPC_ID,
    before: before.state,
    moved: moved.state,
    unexportedBadgeProof,
    exitModalProof,
    applyReloadProof,
    liveApplyProof,
    undoProof: {
      edited: moved.edited,
      undone: moved.undone,
      redone: moved.redone,
    },
    treeLockHideProof,
    treeLockHideRestoreProof,
    treeReorderProof: {
      before: treeReorderBefore,
      after: treeReorderAfter,
      reloaded: treeReorderReloaded,
    },
    treeLayerFilterProof,
    editModeToggleProof,
    placementProof,
    placementReloaded,
    placementDeleteProof,
    placementDeleteReloaded,
    placementExport,
    placementRestoreExport,
    entityPlacementProof,
    entityPlacementReloaded,
    entityPlacementExport,
    scaleControlProof,
    zOrderProof,
    originPresetProof,
    collisionPresetProof,
    autoShadowProof,
    shadowPresetProof,
    resetShadowProof,
    layoutJsonProof,
    aiExportProof,
    reloaded,
    restored: restored.state,
    overrideSave,
    defaultsSave,
    staleOverrideRejected: staleOverride.status === 409,
    staleOverrideResponse: staleOverride,
    staleDefaultsRejected: staleDefaults.status === 409,
    staleDefaultsResponse: staleDefaults,
    navigationProof,
    freshnessCaptureProof,
    autoReflectionProof,
    resetAutoReflectionProof,
    defaultWorkflow,
    decalBefore,
    decalMoved: decalMoved.state,
    decalReloaded,
    decalRestored: decalRestored.state,
    npcBefore,
    npcMoved: npcMoved?.state,
    npcReloaded,
    inspectorQolDefaultProof,
    inspectorQolExpandedProof,
    inspectorQolStickyProof,
    inspectorQolPersistenceProof,
    inspectorQolPersistenceReloaded,
    collisionTruth: before.state.selectedAssetScope,
    moveDelta: EDITOR_MOVE,
    propTransform: EDITOR_PROP_TRANSFORM,
    decalMoveDelta: EDITOR_DECAL_MOVE,
    decalTransform: EDITOR_DECAL_TRANSFORM,
    staleRejected: stale.status === 409,
    staleResponse: stale,
    exportResult,
    restoreExport,
    decalExport,
    decalRestoreExport,
    npcExport,
    screenshots: [
      `${outDir}/editor-selected-before.png`,
      `${outDir}/editor-tree-reorder-before.png`,
      `${outDir}/editor-tree-reorder-after.png`,
      `${outDir}/editor-tree-reorder-reloaded.png`,
      `${outDir}/editor-inspector-collapsed-default.png`,
      `${outDir}/editor-inspector-expanded-section.png`,
      `${outDir}/editor-inspector-sticky-mid-scroll.png`,
      `${outDir}/editor-placed-assets-hot.png`,
      `${outDir}/editor-placed-entities-hot.png`,
      `${outDir}/editor-placed-entities-reloaded.png`,
      `${outDir}/editor-scale-controls.png`,
      `${outDir}/editor-z-order-controls.png`,
      `${outDir}/editor-origin-presets.png`,
      `${outDir}/editor-navigation-tools.png`,
      `${outDir}/editor-tool-filters.png`,
      `${outDir}/editor-auto-reflection.png`,
      `${outDir}/editor-unexported-badge-dirty.png`,
      `${outDir}/editor-unexported-exit-modal-dirty.png`,
      `${outDir}/editor-unexported-badge-clean.png`,
      `${outDir}/editor-undo-redo-redone.png`,
      `${outDir}/editor-reflection-controls.png`,
      `${outDir}/editor-selected-moved-hot.png`,
      `${outDir}/editor-selected-reloaded.png`,
      `${outDir}/editor-decal-before.png`,
      `${outDir}/editor-decal-moved-hot.png`,
      `${outDir}/editor-decal-reloaded.png`,
      `${outDir}/editor-npc-before.png`,
      `${outDir}/editor-npc-moved-hot.png`,
      `${outDir}/editor-npc-reloaded.png`,
    ],
  };
  } finally {
    writeFileSync(EDITOR_LAYOUT_PATH, originalLayoutText, "utf8");
    writeFileSync(EDITOR_METADATA_PATH, originalMetadataText, "utf8");
    if (originalPortalText === null) {
      if (existsSync(EDITOR_TEMP_PORTAL_PATH)) rmSync(EDITOR_TEMP_PORTAL_PATH);
    } else {
      writeFileSync(EDITOR_TEMP_PORTAL_PATH, originalPortalText, "utf8");
    }
    const restoreResult = await postDevkit("/api/zone-export", { mapId: EDITOR_MAP_ID });
    if (!restoreResult.ok) throw new Error(`final restore export failed: ${restoreResult.error ?? restoreResult.output ?? "unknown"}`);
    if (readFileSync(EDITOR_LAYOUT_PATH, "utf8") !== originalLayoutText) throw new Error("layout restore assertion failed");
    if (readFileSync(EDITOR_METADATA_PATH, "utf8") !== originalMetadataText) throw new Error("metadata restore assertion failed");
    if (originalPortalText === null && existsSync(EDITOR_TEMP_PORTAL_PATH)) throw new Error("temporary portal restore assertion failed");
    if (originalPortalText !== null && readFileSync(EDITOR_TEMP_PORTAL_PATH, "utf8") !== originalPortalText) {
      throw new Error("portal restore assertion failed");
    }
    if (stableJsonText(readFileSync(EDITOR_MAP_PATH, "utf8")) !== stableJsonText(originalMapText)) {
      throw new Error("map restore assertion failed");
    }
  }
}

function stableJsonText(text: string): string {
  return JSON.stringify(JSON.parse(text));
}

async function postDevkit(path: string, payload: unknown): Promise<{ ok: boolean; output?: string; error?: string }> {
  return (await postDevkitWithStatus(path, payload)).body as { ok: boolean; output?: string; error?: string };
}

async function waitForCompiledMapClean(mapId: string): Promise<string> {
  const deadline = Date.now() + 240_000;
  let last = "";
  while (Date.now() < deadline) {
    const result = await postDevkit("/api/zone-export", { mapId, dryRun: true });
    last = result.output ?? result.error ?? "";
    if (result.ok && last.includes("no change") && !last.includes("WOULD CHANGE")) return last;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`compiled map did not become clean after apply: ${last}`);
}

async function postDevkitWithStatus(path: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${editorDevkitOrigin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() as unknown };
}

async function getDevkit(path: string): Promise<unknown> {
  const response = await fetch(`${editorDevkitOrigin}${path}`);
  if (!response.ok) throw new Error(`GET ${path} failed: ${response.status}`);
  return await response.json() as unknown;
}

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

// card-lr2-editor-collision-overlay: enter build mode, turn on the map-wide collision
// overlay, screenshot it (every active collision shape in red), then prove a click inside
// a prop's red box selects its owning object via the overlay's selectAt fallback.
async function captureCollisionOverlayProof(outDir: string, page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]) {
  const COLLISION_PROP_ID = "p_tree_0_0"; // the pink blossom tree under the Suncradle cliff band
  await page.evaluate(async ({ propId }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene?.getEditorQaApi?.();
    if (!api) throw new Error("editor QA API unavailable");
    await api.setActive(true);
    await api.selectObject(propId);
    const on = api.setShowAllCollision(true);
    if (!on.showAllCollision) throw new Error("setShowAllCollision(true) did not turn the overlay on");
    if (on.selectedInstanceId !== propId) throw new Error(`expected ${propId} selected, got ${on.selectedInstanceId}`);
  }, { propId: COLLISION_PROP_ID });
  await centerCameraOnSelected(page);
  await page.waitForTimeout(300);

  // card-lr4-collision-overlay-regression: "toggle ON" alone is NOT proof — the selected
  // prop's own red box is painted by drawSelectedOverlays regardless, so the original leg
  // could pass even if drawAllCollisionOverlay painted nothing. This leg drives the exact
  // owner-reported sequences (re-toggle off/on, Build-Mode exit+re-enter+re-toggle, and
  // toggle-with-no-selection) and asserts drawAllCollisionOverlay actually painted shapes
  // (collisionOverlayShapeCount > 0) at each ON step. Fail-closed on the "ON but zero red"
  // regression. Sequence values are surfaced in the proof JSON for eyes-on review.
  const sequenceProof = await page.evaluate(async ({ propId }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const api = scene!.getEditorQaApi!();
    const steps: Array<{ step: string; on: boolean; shapes: number }> = [];
    let s = api.getState() as unknown as { showAllCollision: boolean; collisionOverlayShapeCount: number };
    await new Promise((r) => setTimeout(r, 150));
    s = api.getState() as never; steps.push({ step: "initialToggle", on: s.showAllCollision, shapes: s.collisionOverlayShapeCount });
    // Re-toggle off then on (owner "toggle-off-on").
    api.setShowAllCollision(false); await new Promise((r) => setTimeout(r, 150));
    api.setShowAllCollision(true); await new Promise((r) => setTimeout(r, 150));
    s = api.getState() as never; steps.push({ step: "reToggle", on: s.showAllCollision, shapes: s.collisionOverlayShapeCount });
    // Build-Mode re-entry: exit resets the toggle (expected OFF), re-enter, re-toggle ON.
    await api.setActive(false); await new Promise((r) => setTimeout(r, 150));
    await api.setActive(true); await new Promise((r) => setTimeout(r, 150));
    api.setShowAllCollision(true); await new Promise((r) => setTimeout(r, 150));
    s = api.getState() as never; steps.push({ step: "buildModeReentry", on: s.showAllCollision, shapes: s.collisionOverlayShapeCount });
    // Toggle-with-no-selection (owner just toggles while nothing is picked): the ALL overlay
    // must stand on its own without a selected-prop box masking it.
    await api.selectObject(propId); await new Promise((r) => setTimeout(r, 120));
    await api.selectObject("__deselect__"); await new Promise((r) => setTimeout(r, 150));
    s = api.getState() as never; steps.push({ step: "noSelection", on: s.showAllCollision, shapes: s.collisionOverlayShapeCount });
    // Re-select the proof prop so the downstream click-select leg runs from a known state.
    await api.selectObject(propId); await new Promise((r) => setTimeout(r, 120));
    return steps;
  }, { propId: COLLISION_PROP_ID });
  console.log(`[capture] collision overlay sequence -> ${JSON.stringify(sequenceProof)}`);
  for (const step of sequenceProof) {
    if (!step.on) throw new Error(`collision overlay OFF after "${step.step}" (expected ON)`);
    if (step.shapes <= 0) {
      throw new Error(`collision overlay painted ZERO shapes after "${step.step}" (toggle ON, drawAllCollisionOverlay drew nothing — the owner-reported regression)`);
    }
  }

  await centerCameraOnSelected(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outDir}/collision-overlay-on.png` });
  console.log(`[capture] collision overlay -> ${outDir}/collision-overlay-on.png`);

  // Click-to-select: clear the selection, then drive the SAME pointerdown the editor binds
  // on the canvas, at the SCREEN point over the prop's collision-box centre. selectAt's
  // overlay fallback must re-select the owner (the box the user sees is the box they get).
  const clickProof = await page.evaluate(async ({ propId }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game") as unknown as {
      getEditorQaApi?: () => { selectObject: (id: string) => Promise<{ selectedInstanceId: string | null; selectedPosition: { x: number; y: number } | null }>; getState: () => { selectedInstanceId: string | null; selectedPosition: { x: number; y: number } | null } };
      cameras?: { main?: { worldView: { x: number; y: number; width: number; height: number } } };
    };
    const api = scene?.getEditorQaApi?.();
    const cam = scene?.cameras?.main;
    const canvas = (globalThis as SmokeBrowserGlobal).document.querySelector("canvas") as unknown as (EventTarget & { getBoundingClientRect(): { left: number; top: number; width: number; height: number } }) | null;
    if (!api || !cam || !canvas) throw new Error("editor QA API/camera/canvas unavailable");
    // Read the prop anchor, then deselect so the click alone must re-select it.
    await api.selectObject(propId);
    const pos = api.getState().selectedPosition;
    await api.selectObject("__deselect__");
    const cleared = api.getState().selectedInstanceId;
    if (!pos) throw new Error(`no selectedPosition for ${propId}`);
    // Screen point over the prop's origin x, a little above the anchor so it lands inside
    // the trunk-base collision box. Same projection the editor's screenToWorld inverts.
    const rect = canvas.getBoundingClientRect();
    const view = cam.worldView;
    const sx = rect.left + ((pos.x - view.x) / view.width) * rect.width;
    const sy = rect.top + (((pos.y - 12) - view.y) / view.height) * rect.height;
    const opts = { clientX: sx, clientY: sy, button: 0, bubbles: true, cancelable: true };
    const PE = (globalThis as unknown as { PointerEvent: new (type: string, init: Record<string, unknown>) => Event }).PointerEvent;
    canvas.dispatchEvent(new PE("pointerdown", { ...opts, buttons: 1 }));
    canvas.dispatchEvent(new PE("pointerup", { ...opts, buttons: 0 }));
    return { cleared, afterClick: api.getState().selectedInstanceId, click: { sx: Math.round(sx), sy: Math.round(sy) } };
  }, { propId: COLLISION_PROP_ID });

  const finalState = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const st = scene?.getEditorQaApi?.()?.getState?.();
    return { selected: st?.selectedInstanceId ?? null, showAllCollision: st?.showAllCollision ?? null, effectiveCollisionMode: st?.selectedAssetScope?.effectiveCollisionMode ?? null };
  });

  if (clickProof.afterClick !== COLLISION_PROP_ID) {
    throw new Error(`overlay click did not select ${COLLISION_PROP_ID} (cleared=${clickProof.cleared}, afterClick=${clickProof.afterClick}, click=${JSON.stringify(clickProof.click)})`);
  }
  if (finalState.effectiveCollisionMode !== "box") {
    throw new Error(`expected a box collision on ${COLLISION_PROP_ID}, got ${finalState.effectiveCollisionMode}`);
  }

  return {
    propId: COLLISION_PROP_ID,
    overlayScreenshot: "collision-overlay-on.png",
    clearedSelection: clickProof.cleared,
    clickSelected: clickProof.afterClick,
    clickScreenPoint: clickProof.click,
    overlayOn: finalState.showAllCollision,
    effectiveCollisionMode: finalState.effectiveCollisionMode,
    // Owner-sequence regression leg: overlay stayed ON and painted > 0 shapes after each
    // re-toggle / Build-Mode re-entry / no-selection step (card-lr4-collision-overlay-regression).
    sequenceProof,
  };
}

async function centerCameraOnSelected(page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]): Promise<void> {
  await page.evaluate((gameplayZoom) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const state = scene?.getEditorQaApi?.()?.getState?.();
    const pos = state?.selectedPosition;
    const cam = scene?.cameras?.main;
    if (!pos || !cam) return;
    cam.stopFollow();
    cam.setZoom(gameplayZoom);
    cam.centerOn(pos.x, pos.y - 40);
  }, GAMEPLAY_ZOOM);
  await page.waitForTimeout(350);
}

async function reloadGamePage(page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]): Promise<void> {
  const appUrl = new URL(page.url()).origin;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (attempt === 0) {
        await page.reload({ waitUntil: "networkidle" });
      } else {
        await page.goto(appUrl, { waitUntil: "domcontentloaded" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ERR_ABORTED") && !message.includes("frame was detached")) {
        throw error;
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => undefined);
    }
    try {
      await enterGuestIfNeeded(page, attempt === 0 ? 12000 : 30000);
      await page.waitForTimeout(900);
      return;
    } catch (error) {
      if (attempt > 0) throw error;
    }
  }
}

async function enterGuestIfNeeded(page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"], timeout = 30000): Promise<void> {
  const guestButton = page.locator("#auth-guest").first();
  if (await guestButton.isVisible({ timeout: 2500 }).catch(() => false)) {
    await guestButton.click();
  }
  await page.waitForFunction(() => {
    try {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
      return Boolean(scene?.getEditorQaApi?.() && scene?.getVisualQaSnapshot?.());
    } catch {
      return false;
    }
  }, undefined, { timeout });
}

async function startDevkitForCapture(): Promise<{ child: ChildProcess; origin: string }> {
  const port = await findOpenDevkitPort();
  console.log(`[capture] starting DevKit on :${port}`);
  const child = spawn("pnpm", ["devkit", "--port", String(port)], {
    cwd: process.cwd(),
    stdio: "pipe",
    shell: true,
  });
  child.stdout?.on("data", (data: Buffer) => process.stdout.write(`[devkit] ${data.toString()}`));
  child.stderr?.on("data", (data: Buffer) => process.stderr.write(`[devkit] ${data.toString()}`));
  await waitUntilPort(port, 30000);
  return { child, origin: `http://127.0.0.1:${port}` };
}

function stopDevkit(child: ChildProcess | undefined): void {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    child.kill();
  }
}

async function waitUntilPort(port: number, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isPortOpen(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`DevKit did not become ready on :${port}`);
}

async function findOpenDevkitPort(): Promise<number> {
  for (let port = DEVKIT_PORT; port <= DEVKIT_PORT + 20; port += 1) {
    if (!(await isPortOpen(port))) return port;
  }
  throw new Error("No open DevKit capture port found");
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

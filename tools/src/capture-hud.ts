/**
 * Combat/unit HUD capture — boots server+client (guest login) via the smoke harness,
 * then drives the local player into a real combat state so the reference-bar HUD renders
 * for screenshots: player unit frame, monster target frame, corner-bracket target box,
 * aggro outline, overhead HP bar, attack indicator, and styled damage numbers.
 *
 * This is the in-engine self-verification loop for HUD/combat-UI work (card-hud-kit),
 * the combat-state complement to capture-zone (which only pans an idle camera).
 *
 * Usage: tsx tools/src/capture-hud.ts <outDir>
 */
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { MapManifest, createStaticCollisionResolver } from "@gamekit/game-contract";
import {
  PLAYER_FOOT_OFFSET_Y,
  PLAYER_FOOTPRINT_HALF_WIDTH,
  PLAYER_FOOTPRINT_HEIGHT,
  getCameraZoomForViewportHeight,
} from "@gamekit/game-contract";
// NOTE: the combat-HUD path needs the map manifests, but the client's config/map-manifests uses
// Vite `import.meta.glob`, which a plain tsx run cannot evaluate. loadMapManifests() (below) reads
// content/maps/*.json directly so this tool runs tsx-safe end-to-end (card-proof-harness-hardening).
import { createSmokeHarness, stopChildProcesses } from "./smoke/harness";
import { sendEnhanceAttemptIntent, sendSkillCastIntent, sendTargetSelectIntent } from "./smoke/intents";
import { moveLocalPlayerNear } from "./smoke/movement";
import { getSmokeState } from "./smoke/state";
import { SWEEP_CAPTURE_HEIGHT, SWEEP_CAPTURE_WIDTH } from "./zone-sweep-grid";
import type { SmokeBrowserGlobal } from "./smoke/types";

const VIEWPORT = { width: SWEEP_CAPTURE_WIDTH, height: SWEEP_CAPTURE_HEIGHT };
const ZOOM = getCameraZoomForViewportHeight(VIEWPORT.height);
const STANDOFF_DISTANCE = 90;
const WALK_SAMPLE_STEP_PX = 16;

type CapturePlayer = NonNullable<Awaited<ReturnType<typeof getSmokeState>>>["players"][number];
type CaptureMonster = NonNullable<Awaited<ReturnType<typeof getSmokeState>>>["monsters"][number];
type CandidateAttempt = { monsterId: string; x: number; y: number; reason: string };

/**
 * tsx-safe map manifest loader. capture-hud runs under plain `tsx` (no Vite), so the
 * client's config/map-manifests module — which uses the Vite-only `import.meta.glob` —
 * throws when imported here. Read + parse content/maps/*.json directly instead, keyed by
 * mapId, exactly as the client parses them. (card-proof-harness-hardening scope item 2.)
 */
function loadMapManifests(): Map<string, MapManifest> {
  const dir = resolve(process.cwd(), "content", "maps");
  const maps = new Map<string, MapManifest>();
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const manifest = MapManifest.parse(JSON.parse(readFileSync(resolve(dir, entry), "utf8")));
    maps.set(manifest.id, manifest);
  }
  return maps;
}

async function centerCamera(page: Page, cx: number, cy: number, zoom: number): Promise<void> {
  await page.evaluate(
    ({ cx, cy, zoom }) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
      const cam = scene?.cameras?.main;
      if (!cam) return;
      cam.stopFollow();
      cam.setZoom(zoom);
      cam.centerOn(cx, cy);
    },
    { cx, cy, zoom },
  );
}

function playerFootprintBlocked(map: Pick<MapManifest, "collision">, x: number, y: number): boolean {
  const collision = createStaticCollisionResolver(map);
  return collision.isRectBlocked({
    left: x - PLAYER_FOOTPRINT_HALF_WIDTH,
    right: x + PLAYER_FOOTPRINT_HALF_WIDTH,
    top: y + PLAYER_FOOT_OFFSET_Y - PLAYER_FOOTPRINT_HEIGHT,
    bottom: y + PLAYER_FOOT_OFFSET_Y,
  });
}

function isStraightLineWalkable(
  map: Pick<MapManifest, "collision">,
  from: CapturePlayer,
  to: { x: number; y: number },
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / WALK_SAMPLE_STEP_PX));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    if (playerFootprintBlocked(map, from.x + dx * t, from.y + dy * t)) return false;
  }
  return true;
}

function standPointForMonster(player: CapturePlayer, monster: CaptureMonster): { x: number; y: number } {
  const dx = player.x - monster.x;
  const dy = player.y - monster.y;
  const distance = Math.hypot(dx, dy) || 1;
  return {
    x: monster.x + (dx / distance) * STANDOFF_DISTANCE,
    y: monster.y + (dy / distance) * STANDOFF_DISTANCE,
  };
}

function selectReachableMonster(
  player: CapturePlayer,
  monsters: CaptureMonster[],
  maps: Map<string, MapManifest>,
): { monster: CaptureMonster; stand: { x: number; y: number } } {
  const map = maps.get(player.mapId as never);
  if (!map) throw new Error(`map manifest missing for HUD capture map "${player.mapId}"`);
  const attempts: CandidateAttempt[] = [];
  const candidates = monsters
    .filter((monster) => monster.monsterId.includes("slime"))
    .map((monster) => ({ monster, distance: Math.hypot(monster.x - player.x, monster.y - player.y) }))
    .sort((a, b) => a.distance - b.distance);
  for (const { monster } of candidates) {
    const stand = standPointForMonster(player, monster);
    if (playerFootprintBlocked(map, stand.x, stand.y)) {
      attempts.push({
        monsterId: monster.monsterId,
        x: Math.round(stand.x),
        y: Math.round(stand.y),
        reason: "standpoint-blocked",
      });
      continue;
    }
    if (!isStraightLineWalkable(map, player, stand)) {
      attempts.push({
        monsterId: monster.monsterId,
        x: Math.round(stand.x),
        y: Math.round(stand.y),
        reason: "straight-line-blocked",
      });
      continue;
    }
    return { monster, stand };
  }
  throw new Error(`no reachable live slime for HUD capture; tried=${JSON.stringify(attempts)}`);
}

/** Seed a leaderboard.data payload, open the window, and assert the rows render. */
async function runLeaderboardProof(
  page: Page,
  shoot: (label: string) => Promise<void>,
): Promise<void> {
  // 20 ranked rows + an own-rank OUTSIDE the visible page (rank 42), so both the
  // top-20 list and the pinned own-rank row must render.
  const fixture = {
    type: "leaderboard.data",
    requestId: "leaderboard-proof",
    boardId: "stage-clear",
    page: 0,
    pageSize: 20,
    hasMore: true,
    rows: Array.from({ length: 20 }, (_, i) => ({
      rank: i + 1,
      characterId: `char-${i + 1}`,
      name: `Runner ${i + 1}`,
      value: 60_000 + i * 1500,
      valueLabel: `${Math.floor((60 + i * 1.5) / 60)}:${String(Math.round((60 + i * 1.5) % 60)).padStart(2, "0")}.0`,
      isSelf: false,
    })),
    ownRank: {
      rank: 42,
      characterId: "char-self",
      name: "You",
      value: 123_000,
      valueLabel: "2:03.0",
      isSelf: true,
    },
    serverTimeMs: Date.now(),
  };

  const hasHook = await page.evaluate((event) => {
    const qa = (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__;
    const present = typeof qa?.openLeaderboards === "function";
    qa?.openLeaderboards?.(event);
    return present;
  }, fixture);
  if (!hasHook) throw new Error("__GAMEKIT_QA__.openLeaderboards hook missing (not a DEV build?)");

  await page.locator("[data-leaderboard-list='true'] [data-leaderboard-row='true']").first().waitFor({
    state: "visible",
    timeout: 8000,
  });
  const rowCount = await page.locator("[data-leaderboard-list='true'] [data-leaderboard-row='true']").count();
  const ownPinned = await page.locator("[data-leaderboard-own='true'] .lm-leaderboard__row.is-self").count();
  const tabCount = await page.locator("[data-leaderboard-tab]").count();
  const snapshot = await page.evaluate(
    () => (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__?.getVisualQaSnapshot?.()?.leaderboard ?? null,
  );
  console.log(
    `[capture-hud] leaderboard: ${rowCount} rows, ${ownPinned} pinned own-rank, ${tabCount} tabs; snapshot=${JSON.stringify(snapshot)}`,
  );
  if (rowCount < 20) throw new Error(`leaderboard rendered ${rowCount} rows, expected 20 (rows not proven)`);
  if (ownPinned < 1) throw new Error("own-rank row was not pinned when off-page (own-rank not proven)");
  if (tabCount < 2) throw new Error(`leaderboard rendered ${tabCount} board tabs, expected >=2`);
  await page.waitForTimeout(200);
  await shoot("leaderboard");
}

async function captureEnhanceProof(outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  // Seed a live weapon + gold so one real enhance attempt can run end-to-end.
  const harness = await createSmokeHarness({ worldEnv: { GAMEKIT_SMOKE_GRANT_ENHANCE_WEAPON: "true" } });
  const page = harness.pageA;
  await page.setViewportSize(VIEWPORT);
  await page.waitForTimeout(1000);

  const shoot = async (label: string): Promise<void> => {
    await page.screenshot({ path: `${outDir}/enhance-${label}.png` });
    console.log(`[capture-hud] ${label} -> ${outDir}/enhance-${label}.png`);
  };

  // 1) Open the enhancement window and confirm it reflects the equipped weapon.
  const before = await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    scene?.openEnhancementForQa?.();
    return scene?.getEnhancementQaState?.() ?? null;
  });
  if (!before?.open) throw new Error("[capture-hud] enhance window did not open");
  if (!before.weaponItemId) throw new Error("[capture-hud] no weapon equipped for enhance-proof");
  if (!before.canAttempt) throw new Error(`[capture-hud] cannot attempt enhance: ${JSON.stringify(before)}`);
  await page.waitForTimeout(300);
  await shoot("window-open");

  // 2) Drive ONE live attempt against the seeded instance and wait for the server result.
  await sendEnhanceAttemptIntent(page, before.weaponItemId);
  let after = before;
  for (let i = 0; i < 20 && after.lastResult === null; i += 1) {
    await page.waitForTimeout(150);
    after = await page.evaluate(() => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
      return scene?.getEnhancementQaState?.() ?? null;
    }) ?? after;
  }
  if (!after || after.lastResult === null) {
    throw new Error("[capture-hud] enhance attempt produced no result message");
  }
  console.log(`[capture-hud] enhance result=${after.lastResult} level=${after.lastResultLevel}`);
  await page.waitForTimeout(300);
  await shoot("result");

  await harness.browser.close();
  stopChildProcesses();
  console.log(`[capture-hud] enhance-proof done -> ${outDir}`);
}

/**
 * --windows-proof (card-ui-window-reskins): open each reskinned surface (shop, journal,
 * world map, dialogue) one after another and assert it renders on the Lanternlight frame
 * (.lm-window for the openWindow() trio, .lm-dialogue-window for the bottom-anchored
 * dialogue). Per-window PNGs are staged for eyes-on. Shop opens against a live shop NPC
 * found in room state; the others use the QA bridge open paths.
 */
async function runWindowsProof(
  page: Page,
  shoot: (label: string) => Promise<void>,
): Promise<void> {
  const openWindow = async (kind: "shop" | "journal" | "worldMap", npcId?: string): Promise<void> => {
    const ok = await page.evaluate(
      ({ kind, npcId }) => {
        const qa = (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__;
        if (typeof qa?.openReskinWindow !== "function") return false;
        qa.openReskinWindow(kind, npcId);
        return true;
      },
      { kind, npcId },
    );
    if (!ok) throw new Error("__GAMEKIT_QA__.openReskinWindow hook missing (not a DEV build?)");
  };
  const closeTop = async (): Promise<void> => {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  };

  // Shop — needs a live NPC that actually stocks items.
  const state = await getSmokeState(page);
  const shopNpc = (state?.npcs ?? []).find((npc) => npc.shopItems.length > 0);
  if (!shopNpc) throw new Error("no live shop NPC in room state for windows-proof");
  await openWindow("shop", shopNpc.npcId);
  await page.locator(".lm-window.lm-shop .shop-shell").first().waitFor({ state: "visible", timeout: 8000 });
  const shopFramed = await page.locator(".lm-window.lm-shop.lm-frame--window").count();
  if (shopFramed < 1) throw new Error("shop did not render on the .lm-window Lanternlight frame");
  await page.waitForTimeout(350);
  await shoot("reskin-shop");
  await closeTop();

  // Quest journal.
  await openWindow("journal");
  await page.locator(".lm-window.lm-quest-journal .quest-journal").first().waitFor({ state: "visible", timeout: 8000 });
  const journalFramed = await page.locator(".lm-window.lm-quest-journal.lm-frame--window").count();
  if (journalFramed < 1) throw new Error("quest journal did not render on the .lm-window Lanternlight frame");
  await page.waitForTimeout(350);
  await shoot("reskin-journal");
  await closeTop();

  // World map.
  await openWindow("worldMap");
  await page.locator(".lm-window.lm-world-map .world-map-body").first().waitFor({ state: "visible", timeout: 8000 });
  const mapFramed = await page.locator(".lm-window.lm-world-map.lm-frame--window").count();
  if (mapFramed < 1) throw new Error("world map did not render on the .lm-window Lanternlight frame");
  await page.waitForTimeout(350);
  await shoot("reskin-worldmap");
  await closeTop();

  // Dialogue (bottom-anchored, non-modal — stays on .lm-dialogue-window, not openWindow()).
  const dialogueShown = await page.evaluate(() => {
    const qa = (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__;
    if (typeof qa?.showDialogue !== "function") return false;
    qa.showDialogue({
      type: "npc.dialogue",
      npcId: "qa-npc",
      npcName: "Windowsmith",
      body: "The Lanternlight frame proof — dialogue reskin renders here.",
      choices: [
        { id: "ok", label: "Understood", action: "close" },
        { id: "more", label: "Tell me more", action: "say", text: "..." },
      ],
      serverTimeMs: Date.now(),
    });
    return true;
  });
  if (!dialogueShown) throw new Error("__GAMEKIT_QA__.showDialogue hook missing (not a DEV build?)");
  await page.locator("#dialogue.lm-dialogue-window").first().waitFor({ state: "visible", timeout: 8000 });
  // The cozy-bounce --open class must be present (visible end state), else the frame is opacity:0.
  await page.locator("#dialogue.lm-dialogue-window--open").first().waitFor({ state: "attached", timeout: 8000 });
  await page.waitForTimeout(350);
  await shoot("reskin-dialogue");

  console.log(
    `[capture-hud] windows-proof: shop(${shopNpc.npcId}) + journal + worldMap + dialogue all rendered on the Lanternlight frame`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const enhanceProof = args.includes("--enhance-proof");
  const outDir = args.find((a) => !a.startsWith("--")) ?? "tools/_capture-hud";

  if (enhanceProof) {
    await captureEnhanceProof(outDir);
    return;
  }

  mkdirSync(outDir, { recursive: true });

  const harness = await createSmokeHarness({ worldEnv: { GAMEKIT_SMOKE_GRANT_MANA_POTION: "true" } });
  const page = harness.pageA;
  const sessionId = harness.joinedA.localSessionId;
  await page.setViewportSize(VIEWPORT);
  await page.waitForTimeout(800);

  const shoot = async (label: string): Promise<void> => {
    await page.screenshot({ path: `${outDir}/hud-${label}.png` });
    console.log(`[capture-hud] ${label} -> ${outDir}/hud-${label}.png`);
  };

  // --leaderboard-proof (card-leaderboards-funnel): open the Leaderboards window with a
  // seeded server payload and assert the rows + own-rank pin render. Smoke has no DB, so
  // the fixture is injected through the __GAMEKIT_QA__ bridge (openLeaderboards) exactly
  // as a real leaderboard.data reply would arrive.
  if (process.argv.includes("--leaderboard-proof")) {
    await runLeaderboardProof(page, shoot);
    await harness.browser.close();
    stopChildProcesses();
    console.log(`[capture-hud] done (leaderboard-proof) -> ${outDir}`);
    return;
  }

  // --windows-proof (card-ui-window-reskins): open shop/journal/worldMap/dialogue in turn
  // and assert each renders on the Lanternlight frame; per-window PNGs staged for eyes-on.
  if (process.argv.includes("--windows-proof")) {
    await runWindowsProof(page, shoot);
    await harness.browser.close();
    stopChildProcesses();
    console.log(`[capture-hud] done (windows-proof) -> ${outDir}`);
    return;
  }

  // 1) Player unit frame only (no target selected).
  const initial = await getSmokeState(page);
  const player0 = initial?.players.find((p) => p.sessionId === sessionId);
  if (!player0) throw new Error("local player not found for HUD capture");
  await centerCamera(page, player0.x, player0.y, ZOOM);
  await page.waitForTimeout(400);
  await shoot("player-frame");

  // Pick a reachable live slime using the same static collision grid/footprint math as movement.
  const preState = await getSmokeState(page);
  const player = preState?.players.find((p) => p.sessionId === sessionId);
  if (!player) throw new Error("local player vanished before targeting");
  const onMap = (preState?.monsters ?? []).filter((m) => m.mapId === player.mapId && m.alive);
  // tsx-safe: the client map-manifests module uses Vite's import.meta.glob and throws under
  // plain tsx, so load the same content/maps/*.json directly (card-proof-harness-hardening).
  const maps = loadMapManifests();
  const { monster, stand } = selectReachableMonster(player, onMap, maps);

  await moveLocalPlayerNear(page, stand.x, stand.y, 90);
  await sendTargetSelectIntent(page, monster.monsterId);
  await page.waitForTimeout(500);

  // 2) Target acquired: target frame + corner brackets + aggro outline + overhead HP bar.
  const acq = await getSmokeState(page);
  const pAcq = acq?.players.find((p) => p.sessionId === sessionId) ?? player;
  const mAcq = acq?.monsters.find((m) => m.monsterId === monster.monsterId) ?? monster;
  await centerCamera(page, (pAcq.x + mAcq.x) / 2, (pAcq.y + mAcq.y) / 2, ZOOM);
  await page.waitForTimeout(450);
  await shoot("target-acquired");

  // 3) Combat: cast repeatedly, framing each shot to catch styled damage numbers / attack indicator.
  for (let i = 0; i < 6; i += 1) {
    await sendSkillCastIntent(page, monster.monsterId);
    await page.waitForTimeout(170);
    const st = await getSmokeState(page);
    const pN = st?.players.find((p) => p.sessionId === sessionId) ?? pAcq;
    const mN = st?.monsters.find((m) => m.monsterId === monster.monsterId);
    if (mN?.alive) await centerCamera(page, (pN.x + mN.x) / 2, (pN.y + mN.y) / 2, ZOOM);
    await shoot(`combat-${i}`);
    await page.waitForTimeout(240);
  }

  await harness.browser.close();
  stopChildProcesses();
  console.log(`[capture-hud] done -> ${outDir}`);
}

main().catch((err) => {
  console.error("[capture-hud] FATAL:", err);
  stopChildProcesses();
  process.exit(1);
});

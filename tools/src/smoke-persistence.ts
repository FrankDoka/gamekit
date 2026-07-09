/**
 * Persistence smoke test for the Phaser + Colyseus + PostgreSQL slice.
 *
 * Uses DATABASE_URL when provided. Otherwise, tries to launch a temporary
 * Docker PostgreSQL container. The test runs migrations, joins the world with a
 * stable dev token, moves the character, closes the page to persist on leave,
 * rejoins with the same token, and verifies saved position, rewards, and
 * consumed potion inventory are restored.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { spawnSync, type ChildProcess } from "child_process";
import { readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import { killOnePassiveSlime } from "./smoke/combat";
import {
  BLOOMVALE_MAP_ID,
  CLIENT_PORT_END,
  CLIENT_PORT_START,
  FIELD_TO_HARBOR_PORTAL_TARGET_Y,
  FIELD_TO_HARBOR_PORTAL_X,
  FIELD_MAP_ID,
  GOLD_ID,
  HARBOR_WARDEN_ID,
  HARBOR_WARDEN_X,
  HARBOR_WARDEN_Y,
  LOOT_MATERIAL_ID,
  MINOR_HEALTH_POTION_ID,
  MOSS_SPORE_ID,
  PLAYER_FOOT_OFFSET_Y,
  PORTAL_TARGET_Y,
  PORTAL_X,
  ROOT,
  SERVER_PORT_END,
  SERVER_PORT_START,
  SLIME_AGGRO_MONSTER_ID,
  SLIME_COMBAT_XP,
} from "./smoke/constants";
import { sendLootPickupIntent } from "./smoke/intents";
import { moveLocalPlayerNear, stageInOpenField } from "./smoke/movement";
import { spawnProcessTree, stopProcessTree } from "./smoke/process-tree";
import { getSmokeState } from "./smoke/state";
import type { JoinedSmokeState, SmokeBrowserGlobal, SmokeInventoryItem } from "./smoke/types";

const POSTGRES_IMAGE = "postgres:16-alpine";
const POSTGRES_PASSWORD = "gamekit_smoke";
const POSTGRES_DB = "gamekit_smoke";
const TOKEN_KEY = "gamekit.devGuestToken";
const TEST_TOKEN = `persistence-${Date.now()}`;
const STARTING_GOLD = 10;
const SMOKE_EQUIPMENT_ID = "item_travelers_band";
const SMOKE_EQUIPMENT_SLOT = "accessory1";
const TIMEOUT = 30_000;
const FORCE_FAILURE_AFTER_START_ENV = "GAMEKIT_SMOKE_PERSISTENCE_FORCE_FAILURE_AFTER_START";

const childProcesses: ChildProcess[] = [];
const childOutput = new WeakMap<ChildProcess, string[]>();
const browsers: Browser[] = [];
let stoppingChildProcesses = false;
let cleanupPromise: Promise<void> | null = null;
let dockerContainerName: string | null = null;
let serverPort = 2567;
let clientPort = 5173;

type PlayerPosition = {
  mapId: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  xp: number;
  level: number;
  classId: string;
  jobXp: number;
  jobLevel: number;
  skillPoints: number;
  skillLevels: Record<string, number>;
  attributePoints: number;
  allocatedAttributes: Record<string, number>;
  def: number;
  mdef: number;
  inventory: Array<{ itemId: string; quantity: number }>;
  equipped: Record<string, string>;
};

async function main(): Promise<void> {
  const databaseUrl = await prepareDatabase();
  await runCommandWithRetry("migrate", "pnpm", ["db:migrate"], { DATABASE_URL: databaseUrl }, 8);

  serverPort = await findOpenPort(SERVER_PORT_START, SERVER_PORT_END);
  clientPort = await findOpenPort(CLIENT_PORT_START, CLIENT_PORT_END);
  await startWorldServer(databaseUrl);
  await startDevServer();
  if (process.env[FORCE_FAILURE_AFTER_START_ENV] === "1") {
    throw new Error(`${FORCE_FAILURE_AFTER_START_ENV}=1 forced failure after server startup`);
  }

  const browser = await chromium.launch({ headless: true });
  browsers.push(browser);
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  await context.addInitScript(({ key, token }) => {
    localStorage.setItem(key, token);
  }, { key: TOKEN_KEY, token: TEST_TOKEN });

  const page = await context.newPage();
  await applyCpuThrottleIfRequested(context, page);
  const consoleErrors: string[] = [];
  attachErrorCapture(page, "first", consoleErrors);

  await page.goto(getDevUrl(), { waitUntil: "networkidle", timeout: TIMEOUT });
  await enterAsGuest(page);
  const before = await waitForLocalPlayer(page);
  if (getInventoryQuantity(before, GOLD_ID) < STARTING_GOLD) {
    throw new Error(`expected starter gold ${STARTING_GOLD}, got inventory=${JSON.stringify(before.inventory)}`);
  }
  const afterEquip = await equipSmokeAccessory(page, before.def);

  await buyMinorHealthPotion(page);
  await buyAndSellLastMossSpore(page);
  const afterShop = await getLocalPlayer(page);
  const goldAfterShop = getInventoryQuantity(afterShop, GOLD_ID);
  const potionAfterBuy = getInventoryQuantity(afterShop, MINOR_HEALTH_POTION_ID);
  const mossSporeAfterSell = getInventoryQuantity(afterShop, MOSS_SPORE_ID);

  await sendMoveIntent(page, before.x + 120, before.y);
  const moved = await waitForLocalPlayerNear(page, before.x + 120, before.y, 12);
  await page.close();
  await new Promise((resolve) => setTimeout(resolve, 750));

  const rejoinPage = await context.newPage();
  await applyCpuThrottleIfRequested(context, rejoinPage);
  attachErrorCapture(rejoinPage, "rejoin", consoleErrors);
  await rejoinPage.goto(getDevUrl(), { waitUntil: "networkidle", timeout: TIMEOUT });
  await enterAsGuest(rejoinPage);
  const restored = await waitForLocalPlayerPastX(rejoinPage, moved.x - 5);
  if (restored.equipped[SMOKE_EQUIPMENT_SLOT] !== SMOKE_EQUIPMENT_ID || restored.def !== afterEquip.def) {
    throw new Error(`restored equipment mismatch: expected ${SMOKE_EQUIPMENT_SLOT}=${SMOKE_EQUIPMENT_ID} DEF=${afterEquip.def}, got ${JSON.stringify(restored)}`);
  }
  if (getInventoryQuantity(restored, GOLD_ID) !== goldAfterShop) {
    throw new Error(`restored gold stack did not match post-shop state: expected=${goldAfterShop}, inventory=${JSON.stringify(restored.inventory)}`);
  }
  if (getInventoryQuantity(restored, MINOR_HEALTH_POTION_ID) !== potionAfterBuy) {
    throw new Error(`restored potion stack did not match post-buy state: expected=${potionAfterBuy}, inventory=${JSON.stringify(restored.inventory)}`);
  }
  if (getInventoryQuantity(restored, MOSS_SPORE_ID) !== mossSporeAfterSell) {
    throw new Error(`restored Moss Spore stack did not match post-sell state: expected=${mossSporeAfterSell}, inventory=${JSON.stringify(restored.inventory)}`);
  }

  if (Math.abs(restored.x - moved.x) > 24) {
    throw new Error(`restored x=${restored.x} was too far from saved x=${moved.x}`);
  }

  let portalRejoinPage = rejoinPage;
  let restoredMap: PlayerPosition | null = null;
  const livePortalCount = countLivePortals();
  if (livePortalCount > 0) {
    await sendMoveIntent(rejoinPage, PORTAL_X, PORTAL_TARGET_Y);
    const fieldPosition = await waitForLocalPlayerMap(rejoinPage, FIELD_MAP_ID);
    await rejoinPage.close();
    await waitForLeavePersistence();

    portalRejoinPage = await context.newPage();
    attachErrorCapture(portalRejoinPage, "portal-rejoin", consoleErrors);
    await portalRejoinPage.goto(getDevUrl(), { waitUntil: "networkidle", timeout: TIMEOUT });
    await enterAsGuest(portalRejoinPage);
    restoredMap = await waitForLocalPlayerMap(portalRejoinPage, FIELD_MAP_ID);

    if (Math.abs(restoredMap.x - fieldPosition.x) > 24 || Math.abs(restoredMap.y - fieldPosition.y) > 24) {
      throw new Error(
        `restored map position (${restoredMap.x}, ${restoredMap.y}) was too far from saved (${fieldPosition.x}, ${fieldPosition.y})`,
      );
    }

    await sendMoveIntent(portalRejoinPage, FIELD_TO_HARBOR_PORTAL_X, FIELD_TO_HARBOR_PORTAL_TARGET_Y);
    await waitForLocalPlayerMap(portalRejoinPage, BLOOMVALE_MAP_ID);
  } else {
    console.log("[smoke:persistence] SKIP portal leg: 0 live portals");
    restoredMap = await waitForLocalPlayerMap(rejoinPage, BLOOMVALE_MAP_ID);
  }

  await stageInOpenField(portalRejoinPage);
  const playerBeforeCombat = await getLocalPlayer(portalRejoinPage);
  await killOnePassiveSlime(portalRejoinPage, await getJoinedSmokeState(portalRejoinPage));
  let afterKill = await waitForLocalPlayerMinXp(portalRejoinPage, playerBeforeCombat.xp + SLIME_COMBAT_XP);
  for (let kills = 1; afterKill.attributePoints <= 0 && kills < 6; kills += 1) {
    await killOnePassiveSlime(portalRejoinPage, await getJoinedSmokeState(portalRejoinPage));
    afterKill = await waitForLocalPlayerMinXp(portalRejoinPage, afterKill.xp + SLIME_COMBAT_XP);
  }
  if (afterKill.attributePoints <= 0) {
    throw new Error(`attribute point was not granted after combat level-up path: ${JSON.stringify(afterKill)}`);
  }
  if (afterKill.jobLevel < playerBeforeCombat.jobLevel || (afterKill.jobLevel === playerBeforeCombat.jobLevel && afterKill.jobXp <= playerBeforeCombat.jobXp)) {
    throw new Error(`job XP did not advance on kill: before=${playerBeforeCombat.jobLevel}/${playerBeforeCombat.jobXp}, after=${afterKill.jobLevel}/${afterKill.jobXp}`);
  }
  const attributeSpendBefore = await getLocalPlayer(portalRejoinPage);
  await sendAttributeAllocateIntent(portalRejoinPage, "vit", 1);
  const afterAttributeSpend = await waitForAttributeAllocation(portalRejoinPage, "vit", (attributeSpendBefore.allocatedAttributes.vit ?? 0) + 1);
  if (afterAttributeSpend.attributePoints !== attributeSpendBefore.attributePoints - 1 || afterAttributeSpend.maxHp <= attributeSpendBefore.maxHp) {
    throw new Error(`attribute spend mismatch: before=${JSON.stringify(attributeSpendBefore)}, after=${JSON.stringify(afterAttributeSpend)}`);
  }
  const skillSpendBefore = await getLocalPlayer(portalRejoinPage);
  await sendSkillLearnIntent(portalRejoinPage, "skill_lantern_burst");
  const afterSkillSpend = await waitForSkillLevel(portalRejoinPage, "skill_lantern_burst", (skillSpendBefore.skillLevels["skill_lantern_burst"] ?? 0) + 1);
  if (afterSkillSpend.skillPoints !== skillSpendBefore.skillPoints - 1) {
    throw new Error(`skill point spend mismatch: before=${skillSpendBefore.skillPoints}, after=${afterSkillSpend.skillPoints}`);
  }
  const droppedLoot = await waitForLootDrop(portalRejoinPage);
  await moveLocalPlayerNear(portalRejoinPage, droppedLoot.x, droppedLoot.y - PLAYER_FOOT_OFFSET_Y, 48);
  await waitForLocalPlayerNearLoot(portalRejoinPage, droppedLoot.x, droppedLoot.y);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await sendLootPickupIntent(portalRejoinPage, droppedLoot.lootId);
    await portalRejoinPage.waitForTimeout(250);
    if (await hasInventoryItem(portalRejoinPage, LOOT_MATERIAL_ID)) break;
  }
  const inventoryQuantity = await waitForInventoryItem(portalRejoinPage, LOOT_MATERIAL_ID);
  await portalRejoinPage.close();
  await new Promise((resolve) => setTimeout(resolve, 750));

  const rewardRejoinPage = await context.newPage();
  attachErrorCapture(rewardRejoinPage, "reward-rejoin", consoleErrors);
  await rewardRejoinPage.goto(getDevUrl(), { waitUntil: "networkidle", timeout: TIMEOUT });
  await enterAsGuest(rewardRejoinPage);
  const restoredRewards = await waitForLocalPlayerRewards(rewardRejoinPage, afterKill.xp, LOOT_MATERIAL_ID, inventoryQuantity);
  const restoredAttributes = await waitForAttributeAllocation(rewardRejoinPage, "vit", afterAttributeSpend.allocatedAttributes.vit);
  if (restoredAttributes.attributePoints !== afterAttributeSpend.attributePoints || restoredAttributes.maxHp !== afterAttributeSpend.maxHp) {
    throw new Error(`restored attribute allocation mismatch: expected ${JSON.stringify(afterAttributeSpend)}, got ${JSON.stringify(restoredAttributes)}`);
  }
  await sendAttributeResetIntent(rewardRejoinPage);
  const afterAttributeReset = await waitForAttributeReset(rewardRejoinPage, "vit", restoredAttributes.attributePoints + restoredAttributes.allocatedAttributes.vit);
  await waitForSkillLevel(rewardRejoinPage, "skill_lantern_burst", afterSkillSpend.skillLevels["skill_lantern_burst"] ?? 1);
  const restoredJob = await getLocalPlayer(rewardRejoinPage);
  if (restoredJob.jobLevel !== afterSkillSpend.jobLevel || restoredJob.jobXp !== afterSkillSpend.jobXp || restoredJob.skillPoints !== afterSkillSpend.skillPoints) {
    throw new Error(`restored job progression mismatch: expected job ${afterSkillSpend.jobLevel}/${afterSkillSpend.jobXp} SP ${afterSkillSpend.skillPoints}, got ${restoredJob.jobLevel}/${restoredJob.jobXp} SP ${restoredJob.skillPoints}`);
  }
  await stageInOpenField(rewardRejoinPage);
  const potionBeforeUse = await getLocalPlayer(rewardRejoinPage);
  const playerAfterHit = await waitForAggressiveMonsterDamage(rewardRejoinPage);
  await sendItemUseIntent(rewardRejoinPage, MINOR_HEALTH_POTION_ID);
  const playerAfterPotion = await waitForPotionUse(rewardRejoinPage, playerAfterHit.hp, getInventoryQuantity(potionBeforeUse, MINOR_HEALTH_POTION_ID));
  await rewardRejoinPage.close();
  await new Promise((resolve) => setTimeout(resolve, 750));

  const potionRejoinPage = await context.newPage();
  attachErrorCapture(potionRejoinPage, "potion-rejoin", consoleErrors);
  await potionRejoinPage.goto(getDevUrl(), { waitUntil: "networkidle", timeout: TIMEOUT });
  await enterAsGuest(potionRejoinPage);
  const restoredPotionUse = await waitForInventoryQuantity(potionRejoinPage, MINOR_HEALTH_POTION_ID, getInventoryQuantity(playerAfterPotion, MINOR_HEALTH_POTION_ID));
  await potionRejoinPage.screenshot({ path: `${ROOT}/tools/smoke-persistence-screenshot.png` });
  await potionRejoinPage.close();
  await waitForLeavePersistence();
  await context.close();
  await verifyAccountCharacterSelectLifecycle(browser, consoleErrors);

  if (consoleErrors.length > 0) {
    throw new Error(`console errors during persistence smoke:\n${consoleErrors.join("\n")}`);
  }

  console.log(`[smoke:persistence] restored position (${restored.x}, ${restored.y}) from saved (${moved.x}, ${moved.y}).`);
  console.log(`[smoke:persistence] restored equipment: ${SMOKE_EQUIPMENT_SLOT}=${restored.equipped[SMOKE_EQUIPMENT_SLOT]}, DEF ${afterEquip.def}.`);
  console.log(`[smoke:persistence] restored shop buy/sell: ${GOLD_ID} x${getInventoryQuantity(restored, GOLD_ID)}, ${MINOR_HEALTH_POTION_ID} x${getInventoryQuantity(restored, MINOR_HEALTH_POTION_ID)}, ${MOSS_SPORE_ID} x${getInventoryQuantity(restored, MOSS_SPORE_ID)}.`);
  if (livePortalCount > 0 && restoredMap) {
    console.log(`[smoke:persistence] restored map ${restoredMap.mapId} at (${restoredMap.x}, ${restoredMap.y}) after portal.`);
  }
  console.log(
    `[smoke:persistence] restored rewards: XP ${restoredRewards.xp}, Lv ${restoredRewards.level}, ${LOOT_MATERIAL_ID} x${inventoryQuantity}.`,
  );
  console.log(
    `[smoke:persistence] restored job progression: ${restoredJob.classId} Job ${restoredJob.jobLevel} XP ${restoredJob.jobXp}; skill_lantern_burst Lv ${restoredJob.skillLevels["skill_lantern_burst"] ?? 0}; SP ${restoredJob.skillPoints}.`,
  );
  console.log(
    `[smoke:persistence] restored attribute allocation: VIT ${afterAttributeSpend.allocatedAttributes.vit}, pool ${afterAttributeSpend.attributePoints}; reset pool ${afterAttributeReset.attributePoints}.`,
  );
  console.log(
    `[smoke:persistence] restored potion use: HP ${playerAfterHit.hp} -> ${playerAfterPotion.hp}; ${MINOR_HEALTH_POTION_ID} x${getInventoryQuantity(restoredPotionUse, MINOR_HEALTH_POTION_ID)} after reload.`,
  );
  console.log("[smoke:persistence] account character-select lifecycle restored one HUD after re-entry.");
  console.log("[smoke:persistence] ALL CHECKS PASSED.");

  await browser.close();
}

function getInventoryQuantity(player: PlayerPosition, itemId: string): number {
  return player.inventory.find((item) => item.itemId === itemId)?.quantity ?? 0;
}

function countLivePortals(): number {
  return readdirSync(`${ROOT}/content/maps`)
    .filter((entry) => entry.endsWith(".json"))
    .reduce((total, entry) => {
      const map = JSON.parse(readFileSync(`${ROOT}/content/maps/${entry}`, "utf8")) as {
        portals?: unknown[];
        portalPlacements?: unknown[];
      };
      return total + (map.portals?.length ?? 0) + (map.portalPlacements?.length ?? 0);
    }, 0);
}

async function waitForLeavePersistence(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 750));
}

async function getJoinedSmokeState(page: Page): Promise<JoinedSmokeState> {
  const state = await getSmokeState(page);
  if (!state?.localSessionId) throw new Error("missing local session id for persistence combat leg");
  return state as JoinedSmokeState;
}

async function buyMinorHealthPotion(page: Page): Promise<PlayerPosition> {
  await sendMoveIntent(page, HARBOR_WARDEN_X, HARBOR_WARDEN_Y);
  await waitForLocalPlayerNear(page, HARBOR_WARDEN_X, HARBOR_WARDEN_Y, 72);
  return buyShopItem(page, MINOR_HEALTH_POTION_ID);
}

async function equipSmokeAccessory(page: Page, defBefore: number): Promise<PlayerPosition> {
  await sendEquipmentEquipIntent(page, SMOKE_EQUIPMENT_ID, SMOKE_EQUIPMENT_SLOT);
  await page.waitForFunction(({ expectedItemId, expectedSlot, minDef }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    return player?.equipped?.get(expectedSlot) === expectedItemId && player.def > minDef;
  }, { expectedItemId: SMOKE_EQUIPMENT_ID, expectedSlot: SMOKE_EQUIPMENT_SLOT, minDef: defBefore }, { timeout: TIMEOUT });
  return getLocalPlayer(page);
}

async function buyAndSellLastMossSpore(page: Page): Promise<void> {
  const afterBuy = await buyShopItem(page, MOSS_SPORE_ID);
  if (getInventoryQuantity(afterBuy, MOSS_SPORE_ID) <= 0) {
    throw new Error(`expected Moss Spore after shop buy, got ${JSON.stringify(afterBuy.inventory)}`);
  }

  const beforeSell = await getLocalPlayer(page);
  await sendShopSellIntent(page, HARBOR_WARDEN_ID, MOSS_SPORE_ID);
  await page.waitForFunction(({ goldBefore }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    const gold = player?.inventory?.get("item_gold")?.quantity ?? 0;
    const mossSpore = player?.inventory?.get("item_moss_spore")?.quantity ?? 0;
    return gold > goldBefore && mossSpore === 0;
  }, { goldBefore: getInventoryQuantity(beforeSell, GOLD_ID) }, { timeout: TIMEOUT });
}

async function verifyAccountCharacterSelectLifecycle(browser: Browser, consoleErrors: string[]): Promise<void> {
  const suffix = Date.now().toString(36);
  const email = `lifecycle-${suffix}@smoke.test`;
  const password = "SmokePass123!";
  const characterName = `Life${suffix.slice(-8)}`;
  const account = await createAccountCharacter(email, password, characterName);

  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  await context.addInitScript(({ sessionToken, displayName }) => {
    localStorage.setItem("gamekit.authSessionToken", sessionToken);
    localStorage.setItem("gamekit.authDisplayName", displayName);
    localStorage.setItem("gamekit.authProvider", "email");
    localStorage.removeItem("gamekit.authCharacterId");
    localStorage.removeItem("gamekit.authCharacterName");
    localStorage.removeItem("gamekit.devGuestToken");
  }, { sessionToken: account.sessionToken, displayName: account.displayName });
  const page = await context.newPage();
  attachErrorCapture(page, "account-lifecycle", consoleErrors);

  await page.goto(getDevUrl(), { waitUntil: "networkidle", timeout: TIMEOUT });
  await page.locator("#auth-character-slot-0 .auth-character-login").waitFor({ state: "visible", timeout: TIMEOUT });
  await enterFirstAccountCharacter(page, account.characterId);

  const firstEntry = await waitForLocalPlayer(page);
  await waitForHudPanelCounts(page, 1);

  await page.evaluate(() => {
    localStorage.removeItem("gamekit.authCharacterId");
    localStorage.removeItem("gamekit.authCharacterName");
  });
  await page.close();
  await waitForLeavePersistence();

  const reentryPage = await context.newPage();
  attachErrorCapture(reentryPage, "account-reentry", consoleErrors);
  await reentryPage.goto(getDevUrl(), { waitUntil: "networkidle", timeout: TIMEOUT });
  await reentryPage.locator("#auth-character-slot-0 .auth-character-login").waitFor({ state: "visible", timeout: TIMEOUT });
  await enterFirstAccountCharacter(reentryPage, account.characterId);
  const secondEntry = await waitForLocalPlayer(reentryPage);
  await waitForHudPanelCounts(reentryPage, 1);

  if (secondEntry.hp !== firstEntry.hp || secondEntry.maxHp !== firstEntry.maxHp) {
    throw new Error(`account character lifecycle changed HP unexpectedly: before=${firstEntry.hp}/${firstEntry.maxHp}, after=${secondEntry.hp}/${secondEntry.maxHp}`);
  }

  await context.close();
}

async function createAccountCharacter(
  email: string,
  password: string,
  characterName: string,
): Promise<{ sessionToken: string; displayName: string; characterId: string; characterName: string }> {
  const register = await postAuthJson("/api/auth/register", { type: "auth.register", email, password }) as {
    type: string;
    sessionToken?: string;
    displayName?: string;
  };
  if (register.type !== "auth.success" || !register.sessionToken || !register.displayName) {
    throw new Error(`account lifecycle register failed: ${JSON.stringify(register)}`);
  }

  const created = await postAuthJson("/api/auth/characters/create", {
    type: "auth.characters.create",
    sessionToken: register.sessionToken,
    slotIndex: 0,
    name: characterName,
  }) as { type: string; character?: { id?: string; name?: string } };
  if (created.type !== "auth.character.created" || !created.character?.id || !created.character.name) {
    throw new Error(`account lifecycle character create failed: ${JSON.stringify(created)}`);
  }

  return {
    sessionToken: register.sessionToken,
    displayName: register.displayName,
    characterId: created.character.id,
    characterName: created.character.name,
  };
}

async function postAuthJson(path: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${getDevUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}

async function enterFirstAccountCharacter(page: Page, expectedCharacterId: string): Promise<void> {
  await page.locator("#auth-character-slot-0 .auth-character-login").click();
  await page.waitForFunction((characterId) => {
    const storedCharacterId = localStorage.getItem("gamekit.authCharacterId");
    const storedCharacterName = localStorage.getItem("gamekit.authCharacterName");
    return storedCharacterId === characterId && Boolean(storedCharacterName);
  }, expectedCharacterId, { timeout: TIMEOUT });
}

async function waitForHudPanelCounts(page: Page, expected: number): Promise<void> {
  await page.waitForFunction((count) => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const ids = [
      "#hud-minimap-panel",
      "#hud-stats",
      "#hud-action-panel",
      "#hud-quest-tracker",
      "#hud-chat-panel",
    ];
    return ids.every((selector) => doc.querySelectorAll(selector).length === count);
  }, expected, { timeout: TIMEOUT });
}

async function buyShopItem(page: Page, itemId: string): Promise<PlayerPosition> {
  const before = await getLocalPlayer(page);
  const quantityBefore = getInventoryQuantity(before, itemId);
  await sendShopBuyIntent(page, HARBOR_WARDEN_ID, itemId);
  await page.waitForFunction(({ wantedItemId, goldBefore, itemBefore }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    const gold = player?.inventory?.get("item_gold")?.quantity ?? 0;
    const itemQuantity = player?.inventory?.get(wantedItemId)?.quantity ?? 0;
    return gold < goldBefore && itemQuantity === itemBefore + 1;
  }, {
    wantedItemId: itemId,
    goldBefore: getInventoryQuantity(before, GOLD_ID),
    itemBefore: quantityBefore,
  }, { timeout: TIMEOUT });

  return getLocalPlayer(page);
}

async function prepareDatabase(): Promise<string> {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  ensureDockerAvailable();
  const port = await findOpenPort(55432, 55442);
  dockerContainerName = `gamekit-smoke-postgres-${process.pid}`;

  runCommand("docker", "docker", [
    "run",
    "--rm",
    "-d",
    "--name",
    dockerContainerName,
    "-e",
    `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
    "-e",
    `POSTGRES_DB=${POSTGRES_DB}`,
    "-p",
    `${port}:5432`,
    POSTGRES_IMAGE,
  ]);

  await waitUntil("postgres", () => isPortOpen(port), TIMEOUT);
  return `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${port}/${POSTGRES_DB}`;
}

function ensureDockerAvailable(): void {
  const version = spawnSync("docker", ["version"], { shell: true, stdio: "pipe" });
  if (version.status !== 0) {
    throw new Error(
      `DATABASE_URL is not set and Docker daemon is not available. Set DATABASE_URL or start Docker to run the persistence smoke test against PostgreSQL.\n${version.stderr.toString()}`,
    );
  }
}

// game sets its own workspace package names
const SERVER_PACKAGE = process.env.GAME_SERVER_PACKAGE ?? "@game/server";
const CLIENT_PACKAGE = process.env.GAME_CLIENT_PACKAGE ?? "@game/client";

async function startWorldServer(databaseUrl: string): Promise<void> {
  const server = spawnProcessTree("pnpm", ["--filter", SERVER_PACKAGE, "boot"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl, PORT: String(serverPort), GAMEKIT_FORCE_LOOT: "always", ALLOW_GUEST_LOGIN: "true", GAMEKIT_SMOKE_GRANT_EQUIPMENT: "true" },
    stdio: "pipe",
    shell: true,
  });
  childProcesses.push(server);
  captureChildOutput("server", server);

  await waitUntil("world server", () => isPortOpen(serverPort), TIMEOUT, server);
}

async function startDevServer(): Promise<void> {
  const devServer = spawnProcessTree("pnpm", ["--filter", CLIENT_PACKAGE, "dev", "--host", "127.0.0.1", "--port", String(clientPort), "--strictPort"], {
    cwd: ROOT,
    env: {
      ...process.env,
      VITE_COLYSEUS_URL: `ws://127.0.0.1:${serverPort}`,
      VITE_AUTH_HTTP_URL: `http://127.0.0.1:${serverPort}`,
      VITE_API_PROXY_TARGET: `http://127.0.0.1:${serverPort}`,
    },
    stdio: "pipe",
    shell: true,
  });
  childProcesses.push(devServer);
  captureChildOutput("client", devServer);

  await waitUntil("client dev server", () => isPortOpen(clientPort), TIMEOUT, devServer);
}

async function enterAsGuest(page: Page): Promise<void> {
  const guestButton = page.locator("#auth-guest").first();
  await guestButton.waitFor({ state: "visible", timeout: TIMEOUT });
  await guestButton.click();
}

function runCommand(label: string, command: string, args: string[], env: NodeJS.ProcessEnv = {}): void {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    shell: true,
    stdio: "pipe",
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`${label} failed:\n${result.stdout}\n${result.stderr}`);
  }
}

async function runCommandWithRetry(
  label: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  attempts: number,
): Promise<void> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      runCommand(label, command, args, env);
      return;
    } catch (err) {
      lastError = err as Error;
      if (attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }

  throw lastError ?? new Error(`${label} failed`);
}

function captureChildOutput(label: string, child: ChildProcess): void {
  const output: string[] = [];
  childOutput.set(child, output);
  const record = (data: Buffer, write: (text: string) => boolean) => {
    const text = data.toString();
    output.push(text);
    write(`[${label}] ${text}`);
  };
  child.stdout?.on("data", (data: Buffer) => record(data, (text) => process.stdout.write(text)));
  child.stderr?.on("data", (data: Buffer) => record(data, (text) => process.stderr.write(text)));
  child.on("exit", (code) => {
    if (!stoppingChildProcesses && code !== null && code !== 0) {
      console.error(`[${label}] exited with code ${code}`);
    }
  });
}

async function waitForLocalPlayer(page: Page): Promise<PlayerPosition> {
  await page.waitForFunction(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    return scene?.localSessionId && scene?.room?.state?.players?.get(scene.localSessionId);
  }, null, { timeout: TIMEOUT });

  return getLocalPlayer(page);
}

async function waitForLocalPlayerPastX(page: Page, minX: number): Promise<PlayerPosition> {
  await page.waitForFunction((targetX) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    return player && player.x >= targetX;
  }, minX, { timeout: TIMEOUT });

  return getLocalPlayer(page);
}

async function waitForLocalPlayerNear(page: Page, x: number, y: number, radius: number): Promise<PlayerPosition> {
  await page.waitForFunction(({ targetX, targetY, maxDistance }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    return player && Math.hypot(player.x - targetX, player.y - targetY) <= maxDistance;
  }, { targetX: x, targetY: y, maxDistance: radius }, { timeout: TIMEOUT });

  return getLocalPlayer(page);
}

async function waitForLocalPlayerMap(page: Page, mapId: string): Promise<PlayerPosition> {
  await page.waitForFunction((expectedMapId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    return player?.mapId === expectedMapId;
  }, mapId, { timeout: TIMEOUT });

  return getLocalPlayer(page);
}

async function waitForLocalPlayerMinXp(page: Page, minXp: number): Promise<PlayerPosition> {
  await page.waitForFunction((expectedXp) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    return player?.xp >= expectedXp;
  }, minXp, { timeout: TIMEOUT });

  return getLocalPlayer(page);
}

async function waitForLocalPlayerRewards(
  page: Page,
  minXp: number,
  itemId: string,
  minQuantity: number,
): Promise<PlayerPosition> {
  await page.waitForFunction(({ expectedXp, wantedItemId, expectedQuantity }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    const item = player?.inventory?.get(wantedItemId);
    return player?.xp >= expectedXp && item?.quantity >= expectedQuantity;
  }, { expectedXp: minXp, wantedItemId: itemId, expectedQuantity: minQuantity }, { timeout: TIMEOUT });

  return getLocalPlayer(page);
}

async function waitForSkillLevel(page: Page, skillId: string, level: number): Promise<PlayerPosition> {
  await page.waitForFunction(({ wantedSkillId, expectedLevel }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    return (player?.skillLevels?.get(wantedSkillId) ?? 0) >= expectedLevel;
  }, { wantedSkillId: skillId, expectedLevel: level }, { timeout: TIMEOUT });

  return getLocalPlayer(page);
}

async function waitForAttributeAllocation(page: Page, attribute: string, value: number): Promise<PlayerPosition> {
  await page.waitForFunction(({ wantedAttribute, expectedValue }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    return (player?.allocatedAttributes?.get(wantedAttribute) ?? 0) >= expectedValue;
  }, { wantedAttribute: attribute, expectedValue: value }, { timeout: TIMEOUT });

  return getLocalPlayer(page);
}

async function waitForAttributeReset(page: Page, attribute: string, expectedPool: number): Promise<PlayerPosition> {
  await page.waitForFunction(({ wantedAttribute, wantedPool }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    return player && (player.allocatedAttributes?.get(wantedAttribute) ?? 0) === 0 && player.attributePoints === wantedPool;
  }, { wantedAttribute: attribute, wantedPool: expectedPool }, { timeout: TIMEOUT });

  return getLocalPlayer(page);
}

async function waitForInventoryQuantity(page: Page, itemId: string, quantity: number): Promise<PlayerPosition> {
  await page.waitForFunction(({ wantedItemId, expectedQuantity }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    const itemQuantity = player?.inventory?.get(wantedItemId)?.quantity ?? 0;
    return player && itemQuantity === expectedQuantity;
  }, { wantedItemId: itemId, expectedQuantity: quantity }, { timeout: TIMEOUT });

  return getLocalPlayer(page);
}

async function waitForAggressiveMonsterDamage(page: Page): Promise<PlayerPosition> {
  const before = await getLocalPlayer(page);
  const aggressor = await waitForAggressiveMonster(page);
  await moveLocalPlayerNear(page, aggressor.x - 52, aggressor.y, 14);
  await page.waitForFunction(({ targetMonsterId, beforeHp }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    const monster = scene?.room?.state?.monsters?.get(targetMonsterId);
    return monster?.targetId === scene?.localSessionId && player?.hp < beforeHp;
  }, { targetMonsterId: aggressor.monsterId, beforeHp: before.hp }, { timeout: TIMEOUT });

  return getLocalPlayer(page);
}

async function waitForPotionUse(page: Page, hpBefore: number, potionBefore: number): Promise<PlayerPosition> {
  await page.waitForFunction(({ expectedMinHp, expectedPotion }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    const potion = player?.inventory?.get("item_minor_health_potion")?.quantity ?? 0;
    return player?.hp > expectedMinHp && potion === expectedPotion - 1;
  }, { expectedMinHp: hpBefore, expectedPotion: potionBefore }, { timeout: TIMEOUT });

  return getLocalPlayer(page);
}

async function getLocalPlayer(page: Page): Promise<PlayerPosition> {
  return page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME.scene.getScene("game");
    const player = scene.room.state.players.get(scene.localSessionId);
    const inventory: Array<{ itemId: string; quantity: number }> = [];
    const equipped: Record<string, string> = {};
    const skillLevels: Record<string, number> = {};
    const allocatedAttributes: Record<string, number> = {};
    player.inventory?.forEach((item: SmokeInventoryItem) => {
      inventory.push({ itemId: item.itemId, quantity: item.quantity });
    });
    player.equipped?.forEach((itemId: string, slot: string) => {
      equipped[slot] = itemId;
    });
    player.skillLevels?.forEach((level: number, skillId: string) => {
      skillLevels[skillId] = level;
    });
    player.allocatedAttributes?.forEach((value: number, attribute: string) => {
      allocatedAttributes[attribute] = value;
    });
    return {
      mapId: player.mapId,
      x: Math.round(player.x),
      y: Math.round(player.y),
      hp: player.hp,
      maxHp: player.maxHp,
      xp: player.xp,
      level: player.level,
      classId: player.classId,
      jobXp: player.jobXp,
      jobLevel: player.jobLevel,
      skillPoints: player.skillPoints,
      skillLevels,
      attributePoints: player.attributePoints,
      allocatedAttributes,
      def: player.def,
      mdef: player.mdef,
      inventory,
      equipped,
    };
  });
}

async function waitForAggressiveMonster(page: Page): Promise<{ monsterId: string; x: number; y: number }> {
  await page.waitForFunction((monsterIdPrefix) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    let found = false;
    scene?.room?.state?.monsters?.forEach((monster, monsterId) => {
      if (monsterId.includes(monsterIdPrefix) && monster.mapId === player?.mapId && monster.alive) found = true;
    });
    return found;
  }, SLIME_AGGRO_MONSTER_ID, { timeout: TIMEOUT });

  return page.evaluate((monsterIdPrefix) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME.scene.getScene("game");
    const player = scene.room.state.players.get(scene.localSessionId);
    const candidates: Array<{ monsterId: string; x: number; y: number }> = [];
    scene.room.state.monsters.forEach((monster, monsterId) => {
      if (monsterId.includes(monsterIdPrefix) && monster.alive && monster.mapId === player?.mapId) {
        candidates.push({ monsterId, x: monster.x, y: monster.y });
      }
    });
    const found = (candidates.find((monster) => monster.y >= 900) ?? candidates[0]) ?? null;
    if (!found) throw new Error("no aggressive monster found");
    return found;
  }, SLIME_AGGRO_MONSTER_ID);
}

async function waitForLootDrop(page: Page): Promise<{ lootId: string; itemId: string; quantity: number; x: number; y: number }> {
  await page.waitForFunction((itemId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    let found = false;
    scene?.room?.state?.loot?.forEach((loot) => {
      if (loot.itemId === itemId && loot.mapId === player?.mapId && loot.quantity > 0) {
        found = true;
      }
    });
    return found && (scene?.lootObjects?.size ?? 0) > 0;
  }, LOOT_MATERIAL_ID, { timeout: TIMEOUT });

  return page.evaluate((itemId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME.scene.getScene("game");
    const player = scene.room.state.players.get(scene.localSessionId);
    let found: { lootId: string; itemId: string; quantity: number; x: number; y: number } | null = null;
    scene.room.state.loot.forEach((loot, lootId) => {
      if (!found && loot.itemId === itemId && loot.mapId === player?.mapId && loot.quantity > 0) {
        found = { lootId, itemId: loot.itemId, quantity: loot.quantity, x: loot.x, y: loot.y };
      }
    });
    if (!found) throw new Error("loot state missing after drop");
    return found;
  }, LOOT_MATERIAL_ID);
}

async function waitForLocalPlayerNearLoot(page: Page, lootX: number, lootY: number): Promise<void> {
  await page.waitForFunction(({ x, y, footOffsetY }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    return player && Math.hypot(player.x - x, player.y + footOffsetY - y) <= 48;
  }, { x: lootX, y: lootY, footOffsetY: PLAYER_FOOT_OFFSET_Y }, { timeout: TIMEOUT });
}

async function hasInventoryItem(page: Page, itemId: string): Promise<boolean> {
  return page.evaluate((wantedItemId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    return (player?.inventory?.get(wantedItemId)?.quantity ?? 0) > 0;
  }, itemId);
}

async function waitForInventoryItem(page: Page, itemId: string): Promise<number> {
  await page.waitForFunction((wantedItemId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    const item = player?.inventory?.get(wantedItemId);
    return item?.quantity > 0;
  }, itemId, { timeout: TIMEOUT });

  const player = await getLocalPlayer(page);
  const item = player.inventory.find((candidate) => candidate.itemId === itemId);
  if (!item) throw new Error(`inventory item missing after pickup: ${JSON.stringify(player)}`);
  return item.quantity;
}

async function sendMoveIntent(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(({ targetX, targetY }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME.scene.getScene("game");
    scene.room.send("intent", {
      type: "move.to",
      requestId: `smoke-move-${Date.now()}`,
      x: targetX,
      y: targetY,
      clientTimeMs: Date.now(),
    });
  }, { targetX: x, targetY: y });
}

async function sendShopBuyIntent(page: Page, npcId: string, itemId: string): Promise<void> {
  await page.evaluate(({ wantedNpcId, wantedItemId }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME.scene.getScene("game");
    scene.room.send("intent", {
      type: "shop.buy",
      requestId: `smoke-shop-buy-${Date.now()}`,
      npcId: wantedNpcId,
      itemId: wantedItemId,
      quantity: 1,
    });
  }, { wantedNpcId: npcId, wantedItemId: itemId });
}

async function sendShopSellIntent(page: Page, npcId: string, itemId: string): Promise<void> {
  await page.evaluate(({ wantedNpcId, wantedItemId }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME.scene.getScene("game");
    scene.room.send("intent", {
      type: "shop.sell",
      requestId: `smoke-shop-sell-${Date.now()}`,
      npcId: wantedNpcId,
      itemId: wantedItemId,
      quantity: 1,
    });
  }, { wantedNpcId: npcId, wantedItemId: itemId });
}

async function sendItemUseIntent(page: Page, itemId: string): Promise<void> {
  await page.evaluate((wantedItemId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME.scene.getScene("game");
    scene.room.send("intent", {
      type: "item.use",
      requestId: `smoke-item-use-${Date.now()}`,
      itemId: wantedItemId,
      quantity: 1,
    });
  }, itemId);
}

async function sendSkillLearnIntent(page: Page, skillId: string): Promise<void> {
  await page.evaluate((wantedSkillId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME.scene.getScene("game");
    scene.room.send("intent", {
      type: "skill.learn",
      requestId: `smoke-skill-learn-${Date.now()}`,
      skillId: wantedSkillId,
    });
  }, skillId);
}

async function sendAttributeAllocateIntent(page: Page, attribute: string, amount: number): Promise<void> {
  await page.evaluate(({ wantedAttribute, wantedAmount }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME.scene.getScene("game");
    scene.room.send("intent", {
      type: "attribute.allocate",
      requestId: `smoke-attribute-${Date.now()}`,
      attribute: wantedAttribute,
      amount: wantedAmount,
    });
  }, { wantedAttribute: attribute, wantedAmount: amount });
}

async function sendAttributeResetIntent(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME.scene.getScene("game");
    scene.room.send("intent", {
      type: "attribute.reset",
      requestId: `smoke-attribute-reset-${Date.now()}`,
    });
  });
}

async function sendEquipmentEquipIntent(page: Page, itemId: string, slot: string): Promise<void> {
  await page.evaluate(({ wantedItemId, wantedSlot }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME.scene.getScene("game");
    scene.room.send("intent", {
      type: "equipment.equip",
      requestId: `smoke-equipment-equip-${Date.now()}`,
      itemId: wantedItemId,
      slot: wantedSlot,
    });
  }, { wantedItemId: itemId, wantedSlot: slot });
}

function attachErrorCapture(page: Page, label: string, consoleErrors: string[]): void {
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") {
      if (isOptionalSpriteLoadError(text)) return;
      consoleErrors.push(`${label}: ${text}`);
      console.error(`[browser:${label}:error] ${text}`);
    } else if (msg.type() === "warning" && !text.includes("GL Driver Message")) {
      console.warn(`[browser:${label}:warning] ${text}`);
    }
  });
  page.on("pageerror", (err) => consoleErrors.push(`${label}: ${err.message}`));
}

function isOptionalSpriteLoadError(text: string): boolean {
  return (
    (text.startsWith("Failed to process file:") && text.includes("image ")) ||
    text.includes("`setTintFill(color)` is removed as of Phaser 4")
  );
}

async function waitUntil(
  label: string,
  check: () => Promise<boolean>,
  timeoutMs: number,
  child?: ChildProcess,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`${label} exited early with code ${child.exitCode}:\n${(childOutput.get(child) ?? []).join("")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`${label} did not become ready in ${timeoutMs}ms`);
}

function getDevUrl(): string {
  return `http://127.0.0.1:${clientPort}`;
}

async function findOpenPort(first: number, last: number): Promise<number> {
  for (let port = first; port <= last; port += 1) {
    if (!(await isPortOpen(port))) return port;
  }
  throw new Error(`No open PostgreSQL smoke-test port found between ${first} and ${last}.`);
}

async function isPortOpen(port: number): Promise<boolean> {
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

async function cleanup(): Promise<void> {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = cleanupInner();
  return cleanupPromise;
}

async function cleanupInner(): Promise<void> {
  stoppingChildProcesses = true;
  await Promise.all(browsers.map((browser) => browser.close().catch(() => undefined)));
  await Promise.all(childProcesses.map((child) => stopProcessTree(child)));
  if (dockerContainerName) {
    spawnSync("docker", ["rm", "-f", dockerContainerName], { shell: true, stdio: "ignore" });
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    void cleanup().finally(() => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  });
}

async function applyCpuThrottleIfRequested(context: BrowserContext, page: Page): Promise<void> {
  const rawRate = process.env.GAMEKIT_SMOKE_CPU_THROTTLE_RATE;
  if (!rawRate) return;
  const rate = Number(rawRate);
  if (!Number.isFinite(rate) || rate < 1) {
    throw new Error(`invalid GAMEKIT_SMOKE_CPU_THROTTLE_RATE=${rawRate}`);
  }
  const session = await context.newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate });
  console.log(`[smoke:persistence] CPU throttle rate ${rate}x enabled.`);
}

async function run(): Promise<never> {
  let exitCode = 0;
  try {
    await main();
  } catch (err) {
    exitCode = 1;
    console.error("[smoke:persistence] FATAL:", err instanceof Error ? err.stack ?? err.message : String(err));
  } finally {
    await cleanup();
  }
  process.exit(exitCode);
}

void run();

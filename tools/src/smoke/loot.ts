import type { Page } from "@playwright/test";
import { LOOT_MATERIAL_ID, PLAYER_FOOT_OFFSET_Y, TIMEOUT } from "./constants";
import { getSmokeState, waitForInventoryItem, waitForLootDrop } from "./state";
import { sendLootPickupIntent, sendMoveIntent } from "./intents";
import { moveLocalPlayerNear } from "./movement";
import { waitForQuestStatus } from "./quest";
import type { SmokeBrowserGlobal } from "./types";

export async function pickupFieldMaterialDrop(pageA: Page): Promise<void> {
  const droppedLoot = await waitForLootDrop(pageA, LOOT_MATERIAL_ID);
  await sendMoveIntent(pageA, droppedLoot.x, droppedLoot.y - PLAYER_FOOT_OFFSET_Y);
  await waitForLocalPlayerNearDrop(pageA, droppedLoot.x, droppedLoot.y);
  for (let i = 0; i < 4; i += 1) {
    await sendLootPickupIntent(pageA, droppedLoot.lootId);
    await pageA.waitForTimeout(250);
    if (await hasInventoryItem(pageA, LOOT_MATERIAL_ID)) break;
  }
  const inventoryQuantity = await waitForInventoryItem(pageA, LOOT_MATERIAL_ID);
  console.log(`[smoke] Loot: picked up ${droppedLoot.itemId} x${droppedLoot.quantity}; inventory now has ${inventoryQuantity}.`);
}

export async function collectLootForQuest(
  page: Page,
  itemId: string,
  questId: string,
  requiredQuantity: number,
): Promise<void> {
  const picked = new Set<string>();
  while (await getLocalInventoryQuantity(page, itemId) < requiredQuantity) {
    const state = await getSmokeState(page);
    const localPlayer = state?.players.find((player) => player.sessionId === state.localSessionId);
    if (!localPlayer) throw new Error(`local player missing while collecting ${itemId}: ${JSON.stringify(state)}`);

    const drop = state?.loot
      .filter((candidate) => (
        candidate.itemId === itemId &&
        candidate.mapId === localPlayer.mapId &&
        candidate.quantity > 0 &&
        !picked.has(candidate.lootId)
      ))
      .sort((a, b) => Math.hypot(localPlayer.x - a.x, localPlayer.y - a.y) - Math.hypot(localPlayer.x - b.x, localPlayer.y - b.y))[0];
    if (!drop) throw new Error(`no ${itemId} drops available for ${questId}: ${JSON.stringify(state)}`);

    const beforeQuantity = await getLocalInventoryQuantity(page, itemId);
    await moveLocalPlayerNear(page, drop.x, drop.y - PLAYER_FOOT_OFFSET_Y, 48);
    await waitForLocalPlayerNearDrop(page, drop.x, drop.y);
    for (let i = 0; i < 4; i += 1) {
      await sendLootPickupIntent(page, drop.lootId);
      await page.waitForTimeout(250);
      if (await getLocalInventoryQuantity(page, itemId) > beforeQuantity) break;
    }
    picked.add(drop.lootId);
    console.log(`[smoke] Loot: collected ${itemId} from ${drop.lootId}.`);
  }

  const ready = await waitForQuestStatus(page, questId, "ready");
  if (ready.progress !== ready.required) {
    throw new Error(`${questId} collect objective did not reach required progress: ${JSON.stringify(ready)}`);
  }
  console.log(`[smoke] Quest: ${questId} collect objective ready at ${ready.progress}/${ready.required}.`);
}

async function waitForLocalPlayerNearDrop(page: Page, lootX: number, lootY: number): Promise<void> {
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

async function getLocalInventoryQuantity(page: Page, itemId: string): Promise<number> {
  const state = await getSmokeState(page);
  const localPlayer = state?.players.find((player) => player.sessionId === state.localSessionId);
  return localPlayer?.inventory.find((candidate) => candidate.itemId === itemId)?.quantity ?? 0;
}

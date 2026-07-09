import type { Page } from "@playwright/test";
import { PLAYER_FOOT_OFFSET_Y, TIMEOUT } from "./constants";
import { getSmokeState } from "./state";
import { sendWorldInteractIntent } from "./intents";
import { moveLocalPlayerNear } from "./movement";

/**
 * Proves the chest interact -> loot roll loop end to end:
 *  1. find an unopened chest on the local player's map,
 *  2. walk into interact range,
 *  3. send world.interact and assert the chest flips to `opened`,
 *  4. assert at least one loot stack spawned near the chest (the shared loot roll fired).
 */
export async function openChestAndAssertLoot(page: Page): Promise<void> {
  const state = await getSmokeState(page);
  const localPlayer = state?.players.find((player) => player.sessionId === state.localSessionId);
  if (!localPlayer) throw new Error(`local player missing for chest leg: ${JSON.stringify(state)}`);

  const chest = state?.chests.find((c) => c.mapId === localPlayer.mapId && !c.opened);
  if (!chest) throw new Error(`no unopened chest on ${localPlayer.mapId}: ${JSON.stringify(state?.chests)}`);

  // Approach the chest. Server validates true interact range against chest.radius, so a generous
  // tolerance is fine; a prop-collision stall on the way in is non-fatal (we retry the interact
  // from wherever we ended up, and the server enforces the real range).
  const approachTolerance = Math.max(64, chest.radius - 30);
  try {
    await moveLocalPlayerNear(page, chest.x, chest.y - PLAYER_FOOT_OFFSET_Y, approachTolerance);
  } catch {
    // fell short of the tolerance (prop collision) — proceed; the interact loop below will
    // report if we are genuinely out of range.
  }

  let opened = false;
  for (let i = 0; i < 6; i += 1) {
    await sendWorldInteractIntent(page, chest.chestId);
    await page.waitForTimeout(300);
    const after = await getSmokeState(page);
    const live = after?.chests.find((c) => c.chestId === chest.chestId);
    if (live?.opened) {
      opened = true;
      break;
    }
  }
  if (!opened) throw new Error(`chest ${chest.chestId} did not open after interact`);

  // The shared loot roll should have spawned loot near the chest. GAMEKIT_FORCE_LOOT=always is
  // set for smoke so at least one stack is guaranteed.
  const lootAppeared = await page.waitForFunction((chestPos) => {
    const scene = (globalThis as { __GAME?: { scene: { getScene(k: string): { room?: { state?: { loot?: { forEach(cb: (l: { x: number; y: number }) => void): void } } } } } } }).__GAME
      ?.scene.getScene("game");
    let near = false;
    scene?.room?.state?.loot?.forEach((l) => {
      if (Math.hypot(l.x - chestPos.x, l.y - chestPos.y) <= 80) near = true;
    });
    return near;
  }, { x: chest.x, y: chest.y }, { timeout: TIMEOUT }).then(() => true).catch(() => false);

  if (!lootAppeared) throw new Error(`chest ${chest.chestId} opened but no loot spawned near it`);
  console.log(`[smoke] Chest: opened ${chest.chestId} and loot spawned from its table.`);
}

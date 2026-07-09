import type { Page } from "@playwright/test";
import {
  GOLD_ID,
  HARBOR_WARDEN_ID,
  HARBOR_WARDEN_X,
  HARBOR_WARDEN_Y,
  MINOR_HEALTH_POTION_ID,
  NPC_FOOTPRINT_OFFSET_Y,
  NPC_INTERACT_RANGE,
  PLAYER_FOOT_OFFSET_Y,
  TIMEOUT,
} from "./constants";
import { getVisibleNpcClickTarget } from "./click-targets";
import { moveLocalPlayerNear } from "./movement";
import { waitForNpcVisible } from "./quest";
import { getSmokeState } from "./state";
import type { SmokeBrowserGlobal } from "./types";

export async function buyPotionFromHarborShop(page: Page): Promise<void> {
  const before = await getLocalInventoryQuantities(page);
  if (before.gold <= 0) {
    throw new Error(`expected starter gold before shop buy, got ${JSON.stringify(before)}`);
  }

  await moveNearHarborWardenForShop(page);
  await waitForNpcVisible(page, HARBOR_WARDEN_ID);
  const target = await getVisibleNpcClickTarget(page, HARBOR_WARDEN_ID);
  await page.mouse.click(target.screenX, target.screenY);
  await page.waitForFunction(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const panel = doc.getElementById("dialogue");
    const button = Array.from(doc.querySelectorAll("button")).find((candidate) => /^(Shop|Show me supplies\.)$/.test(candidate.textContent ?? ""));
    return panel && !panel.hidden && Boolean(button);
  }, null, { timeout: TIMEOUT });
  await page.getByRole("button", { name: /^(Shop|Show me supplies\.)$/ }).click();
  await page.waitForFunction(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    // card-ui-window-reskins: the shop is hosted in a Lanternlight openWindow() frame; the
    // live shell mounts inside it only while open, so its presence IS the open signal.
    const shell = doc.querySelector(".lm-window.lm-shop .shop-shell");
    const rows = Array.from(doc.querySelectorAll(".shop-item-card"));
    const hasPotion = rows.some((candidate) => candidate.textContent?.includes("Minor Health Potion"));
    const button = doc.querySelector(".shop-primary-action:not(:disabled)");
    return Boolean(shell) && hasPotion && Boolean(button);
  }, null, { timeout: TIMEOUT });

  await page
    .locator("#shop .shop-item-card", { hasText: "Minor Health Potion" })
    .click();
  await page
    .locator("#shop .shop-primary-action")
    .click();
  await page.waitForFunction(({ goldBefore, potionBefore }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    const gold = player?.inventory?.get("item_gold")?.quantity ?? 0;
    const potion = player?.inventory?.get("item_minor_health_potion")?.quantity ?? 0;
    return gold < goldBefore && potion > potionBefore;
  }, { goldBefore: before.gold, potionBefore: before.potion }, { timeout: TIMEOUT });

  const after = await getLocalInventoryQuantities(page);
  console.log(
    `[smoke] Shop: bought potion; gold ${before.gold} -> ${after.gold}, potion ${before.potion} -> ${after.potion}.`,
  );

  // card-ui-window-reskins: the bespoke #shop-close button is retired — the shop closes via
  // the standard Lanternlight window X (same close behavior). Closing removes the window
  // (scrim) from the DOM, so absence of .lm-window.lm-shop is the closed signal.
  await page.locator(".lm-window.lm-shop .lm-window__close").click();
  const closeDialogue = page.locator("#dialogue-choices").getByRole("button", { name: /^(Close|Just passing through\.)$/ });
  if (await closeDialogue.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await closeDialogue.click();
  }
  await page.waitForFunction(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    return doc.querySelector(".lm-window.lm-shop") === null;
  }, null, { timeout: TIMEOUT });
  // Park in the open green SOUTH of the village props (card-world-spawn-fixes, 2026-07-07):
  // the old (636,560) waypoint sat north of the notice-board collision box (p_board 770,475),
  // so the next leg's straight-line east to the relocated chest (1050,640) clipped that box and
  // stalled OUT_OF_RANGE. (636,700) gives a collision-clear straight run to the chest.
  await moveLocalPlayerNear(page, 636, 700, 28);
}

async function moveNearHarborWardenForShop(page: Page): Promise<void> {
  await moveLocalPlayerNear(page, HARBOR_WARDEN_X + 100, HARBOR_WARDEN_Y + 15, 28);
  await page.waitForFunction(({ npcX, npcY, footOffsetY, npcOffsetY, maxDistance }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    return player && Math.hypot(player.x - npcX, player.y + footOffsetY - (npcY + npcOffsetY)) <= maxDistance;
  }, {
    npcX: HARBOR_WARDEN_X,
    npcY: HARBOR_WARDEN_Y,
    footOffsetY: PLAYER_FOOT_OFFSET_Y,
    npcOffsetY: NPC_FOOTPRINT_OFFSET_Y,
    maxDistance: NPC_INTERACT_RANGE - 24,
  }, { timeout: TIMEOUT });
}

async function getLocalInventoryQuantities(page: Page): Promise<{ gold: number; potion: number }> {
  const state = await getSmokeState(page);
  const localPlayer = state?.players.find((player) => player.sessionId === state.localSessionId);
  if (!localPlayer) throw new Error(`missing local player for shop state=${JSON.stringify(state)}`);

  return {
    gold: localPlayer.inventory.find((item) => item.itemId === GOLD_ID)?.quantity ?? 0,
    potion: localPlayer.inventory.find((item) => item.itemId === MINOR_HEALTH_POTION_ID)?.quantity ?? 0,
  };
}

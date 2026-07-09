import type { Page } from "@playwright/test";
import {
  CRAFT_RECIPE_INPUT_COUNT,
  CRAFT_RECIPE_INPUT_ID,
  CRAFT_RECIPE_OUTPUT_ID,
  HARBOR_WARDEN_ID,
  HARBOR_WARDEN_X,
  HARBOR_WARDEN_Y,
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

/**
 * Craft round-trip proof (card-crafting-station-ui): open the crafting panel at
 * Warden Bray's station, confirm the Minor Health Potion recipe row is enabled
 * (materials suffice — the smoke world grants 2 Moss Spore), fire the craft, and
 * assert the server consumed the inputs and granted the output.
 */
export async function craftAtHarborStation(page: Page): Promise<void> {
  const before = await getCraftInventory(page);
  if (before.input < CRAFT_RECIPE_INPUT_COUNT) {
    throw new Error(`expected >= ${CRAFT_RECIPE_INPUT_COUNT} craft inputs before craft, got ${JSON.stringify(before)}`);
  }

  await moveNearHarborWardenForCraft(page);
  await waitForNpcVisible(page, HARBOR_WARDEN_ID);
  const target = await getVisibleNpcClickTarget(page, HARBOR_WARDEN_ID);
  await page.mouse.click(target.screenX, target.screenY);
  await page.waitForFunction(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const panel = doc.getElementById("dialogue");
    const button = Array.from(doc.querySelectorAll("button")).find((candidate) => (candidate.textContent ?? "").trim() === "Craft");
    return panel && !panel.hidden && Boolean(button);
  }, null, { timeout: TIMEOUT });
  await page.locator("#dialogue-choices").getByRole("button", { name: "Craft", exact: true }).click();

  // Panel opens with a recipe list; the Minor Health Potion row is a live,
  // material-sufficient recipe (badge "Ready"). Its Craft button lives in the
  // detail pane and only enables once the row is selected.
  await page.waitForFunction(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const panel = doc.getElementById("crafting");
    const rows = Array.from(doc.querySelectorAll(".crafting-recipe-card"));
    const potionRow = rows.find((candidate) => candidate.textContent?.includes("Minor Health Potion"));
    return panel && !panel.hidden && potionRow && potionRow.classList.contains("is-craftable");
  }, null, { timeout: TIMEOUT });

  await page
    .locator("#crafting .crafting-recipe-card", { hasText: "Minor Health Potion" })
    .click();
  // The detail Craft button must be enabled now that a craftable row is selected.
  await page.waitForFunction(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    return Boolean(doc.querySelector(".crafting-primary-action:not(:disabled)"));
  }, null, { timeout: TIMEOUT });
  await page.locator("#crafting .crafting-primary-action").click();

  await page.waitForFunction(({ inputBefore, outputBefore }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    const input = player?.inventory?.get("item_moss_spore")?.quantity ?? 0;
    const output = player?.inventory?.get("item_minor_health_potion")?.quantity ?? 0;
    return input < inputBefore && output > outputBefore;
  }, { inputBefore: before.input, outputBefore: before.output }, { timeout: TIMEOUT });

  const after = await getCraftInventory(page);
  if (after.input !== before.input - CRAFT_RECIPE_INPUT_COUNT || after.output !== before.output + 1) {
    throw new Error(`craft round-trip mismatch before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }
  console.log(
    `[smoke] Crafting: crafted potion; input ${before.input} -> ${after.input}, output ${before.output} -> ${after.output}.`,
  );

  await page.locator("#crafting-close").click();
  await page.waitForFunction(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    return doc.getElementById("crafting")?.hidden === true;
  }, null, { timeout: TIMEOUT });
  // Re-park south of the village props so the following chest leg keeps its
  // collision-clear straight run east (mirrors buyPotionFromHarborShop's parking).
  await moveLocalPlayerNear(page, 636, 700, 28);
}

async function moveNearHarborWardenForCraft(page: Page): Promise<void> {
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

async function getCraftInventory(page: Page): Promise<{ input: number; output: number }> {
  const state = await getSmokeState(page);
  const localPlayer = state?.players.find((player) => player.sessionId === state.localSessionId);
  if (!localPlayer) throw new Error(`missing local player for craft state=${JSON.stringify(state)}`);
  return {
    input: localPlayer.inventory.find((item) => item.itemId === CRAFT_RECIPE_INPUT_ID)?.quantity ?? 0,
    output: localPlayer.inventory.find((item) => item.itemId === CRAFT_RECIPE_OUTPUT_ID)?.quantity ?? 0,
  };
}

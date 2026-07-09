import type { Page } from "@playwright/test";
import { LOOT_MATERIAL_ID, MINOR_HEALTH_POTION_ID, MINOR_MANA_POTION_ID, TIMEOUT } from "./constants";
import { getSmokeState } from "./state";
import type { SmokeBrowserGlobal } from "./types";

export async function verifyFullHpPotionUseRejected(page: Page): Promise<void> {
  const before = await getLocalItemUseState(page);
  if (before.hp < before.maxHp || before.potion <= 0) {
    throw new Error(`expected full HP with potion before reject check, got ${JSON.stringify(before)}`);
  }

  await sendItemUseIntent(page, MINOR_HEALTH_POTION_ID);
  await waitForFeedback(page, "HP is full");
  await expectItemUseStateUnchanged(page, before, "full HP potion use");
  console.log("[smoke] Item use reject: full-HP potion use did not consume inventory.");
}

export async function verifyInvalidItemUseRejected(page: Page): Promise<void> {
  const beforeUnknown = await getLocalItemUseState(page);
  await sendItemUseIntent(page, "item_missing_smoke_test");
  await waitForFeedback(page, "Item unavailable");
  await expectItemUseStateUnchanged(page, beforeUnknown, "unknown item use");

  const beforeMaterial = await getLocalItemUseState(page);
  if (beforeMaterial.material <= 0) {
    throw new Error(`expected ${LOOT_MATERIAL_ID} before non-potion reject check, got ${JSON.stringify(beforeMaterial)}`);
  }
  await sendItemUseIntent(page, LOOT_MATERIAL_ID);
  await waitForFeedback(page, "Item unavailable");
  await expectItemUseStateUnchanged(page, beforeMaterial, "non-potion item use");
  console.log("[smoke] Item use reject: unknown and non-potion items did not change inventory.");
}

export async function useMinorHealthPotionFromHotbar(page: Page): Promise<void> {
  const before = await getLocalPotionState(page);
  if (before.hp >= before.maxHp || before.potion <= 0) {
    throw new Error(`expected damaged player with potion before item use, got ${JSON.stringify(before)}`);
  }

  await page.locator("#hud-potion-use").click();
  await page.waitForFunction(({ hpBefore, potionBefore }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    const potion = player?.inventory?.get("item_minor_health_potion")?.quantity ?? 0;
    return player?.hp > hpBefore && potion === potionBefore - 1;
  }, { hpBefore: before.hp, potionBefore: before.potion }, { timeout: TIMEOUT });

  const after = await getLocalPotionState(page);
  console.log(
    `[smoke] Item use: potion restored HP ${before.hp} -> ${after.hp}; potion ${before.potion} -> ${after.potion}.`,
  );
}

export async function useMinorManaPotionAndAssertMpDelta(page: Page): Promise<void> {
  const before = await getLocalItemUseState(page);
  if (before.manaPotion <= 0) {
    throw new Error(`expected a mana potion before item use, got ${JSON.stringify(before)}`);
  }

  // Regen-immune proof design. Passive MP regen (WorldRoom.regenerateMp, ~2/sec
  // toward maxMp) makes the pre-use MP a moving target, which is why the old
  // `mp >= maxMp` precondition throw and the bare `mp > mpBefore` wait both flaked.
  //
  // The load-bearing signal here is the potion COUNT dropping by exactly one. Per
  // ConsumableUse.resolveConsumableUse, the server REJECTS a mana potion WITHOUT
  // consuming it when MP is already full (mpRestored <= 0 -> "item.mpFull"), so a
  // count decrement can happen ONLY when MP was below max AND the potion actually
  // restored MP. Passive regen can never cause a count decrement — it is fully
  // authoritative and regen-independent. The prior lantern-burst step spends >= 9
  // MP immediately before this leg, so MP is below max and the potion applies.
  //
  // Fire the use exactly once (a second in-flight use could consume a second potion),
  // then wait for the authoritative count decrement.
  await sendItemUseIntent(page, MINOR_MANA_POTION_ID);
  await page.waitForFunction((potionBefore) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    if (!player) return false;
    const potion = player.inventory?.get("item_minor_mana_potion")?.quantity ?? 0;
    return potion === potionBefore - 1; // consumed => server confirmed MP < max and restored
  }, before.manaPotion, { timeout: TIMEOUT });

  const after = await getLocalItemUseState(page);
  // Corroborate the authoritative count decrement: MP must have risen (the potion
  // restored it) and the mana-potion stack dropped by exactly one.
  if (after.manaPotion !== before.manaPotion - 1) {
    throw new Error(`mana potion count did not drop by one: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }
  if (after.mp <= before.mp) {
    throw new Error(`mana potion did not raise MP: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }
  console.log(
    `[smoke] Item use: mana potion restored MP ${before.mp} -> ${after.mp}; potion ${before.manaPotion} -> ${after.manaPotion}.`,
  );
}

export async function verifyNoPotionUseRejected(page: Page): Promise<void> {
  const before = await getLocalItemUseState(page);
  if (before.potion !== 0) {
    throw new Error(`expected no potion before no-resource reject check, got ${JSON.stringify(before)}`);
  }

  await sendItemUseIntent(page, MINOR_HEALTH_POTION_ID);
  await waitForFeedback(page, "No potion");
  await expectItemUseStateUnchanged(page, before, "no-potion item use");
  console.log("[smoke] Item use reject: no-potion use did not change HP or inventory.");
}

async function getLocalPotionState(page: Page): Promise<{ hp: number; maxHp: number; potion: number }> {
  const state = await getLocalItemUseState(page);
  return {
    hp: state.hp,
    maxHp: state.maxHp,
    potion: state.potion,
  };
}

type LocalItemUseState = {
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  potion: number;
  manaPotion: number;
  material: number;
};

async function getLocalItemUseState(page: Page): Promise<LocalItemUseState> {
  const state = await getSmokeState(page);
  const localPlayer = state?.players.find((player) => player.sessionId === state.localSessionId);
  if (!localPlayer) throw new Error(`missing local player for item state=${JSON.stringify(state)}`);

  return {
    hp: localPlayer.hp,
    maxHp: localPlayer.maxHp,
    mp: localPlayer.mp,
    maxMp: localPlayer.maxMp,
    potion: localPlayer.inventory.find((item) => item.itemId === MINOR_HEALTH_POTION_ID)?.quantity ?? 0,
    manaPotion: localPlayer.inventory.find((item) => item.itemId === MINOR_MANA_POTION_ID)?.quantity ?? 0,
    material: localPlayer.inventory.find((item) => item.itemId === LOOT_MATERIAL_ID)?.quantity ?? 0,
  };
}

async function sendItemUseIntent(page: Page, itemId: string): Promise<void> {
  await page.evaluate((wantedItemId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene.getScene("game");
    if (!scene?.room) throw new Error("game room unavailable");
    scene.room.send("intent", {
      type: "item.use",
      requestId: `smoke-item-use-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      itemId: wantedItemId,
      quantity: 1,
    });
  }, itemId);
}

async function waitForFeedback(page: Page, text: string): Promise<void> {
  await page.waitForFunction((expectedText) => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const toasts = doc.querySelectorAll(".lm-toast__message");
    return Array.from(toasts).some((el) => el.textContent === expectedText);
  }, text, { timeout: TIMEOUT });
}

async function expectItemUseStateUnchanged(
  page: Page,
  before: LocalItemUseState,
  label: string,
): Promise<void> {
  await page.waitForTimeout(250);
  const after = await getLocalItemUseState(page);
  if (
    after.hp !== before.hp ||
    after.maxHp !== before.maxHp ||
    after.mp !== before.mp ||
    after.maxMp !== before.maxMp ||
    after.potion !== before.potion ||
    after.manaPotion !== before.manaPotion ||
    after.material !== before.material
  ) {
    throw new Error(`${label} changed state: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }
}

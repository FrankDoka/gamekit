import type { Page } from "@playwright/test";
import type { SmokeBrowserGlobal } from "./types";

export async function sendMoveIntent(page: Page, x: number, y: number): Promise<string> {
  const requestId = `smoke-move-${Date.now()}`;
  await page.evaluate(({ requestId: moveRequestId, targetX, targetY }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene.getScene("game");
    if (!scene?.room) throw new Error("game room unavailable");
    scene.room.send("intent", {
      type: "move.to",
      requestId: moveRequestId,
      x: targetX,
      y: targetY,
      clientTimeMs: Date.now(),
    });
  }, { requestId, targetX: x, targetY: y });
  return requestId;
}

export async function sendPortalUseIntent(page: Page, portalId: string): Promise<void> {
  await page.evaluate((id) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene.getScene("game");
    if (!scene?.room) throw new Error("game room unavailable");
    scene.room.send("intent", {
      type: "portal.use",
      requestId: `smoke-portal-${Date.now()}`,
      portalId: id,
    });
  }, portalId);
}

export async function sendTargetSelectIntent(page: Page, targetId: string): Promise<void> {
  await page.evaluate((id) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene.getScene("game");
    if (!scene?.room) throw new Error("game room unavailable");
    scene.room.send("intent", {
      type: "target.select",
      requestId: `smoke-target-${Date.now()}`,
      targetId: id,
    });
  }, targetId);
}

export async function sendSkillCastIntent(page: Page, targetId: string): Promise<void> {
  await page.evaluate((id) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene.getScene("game");
    if (!scene?.room) throw new Error("game room unavailable");
    scene.room.send("intent", {
      type: "skill.cast",
      requestId: `smoke-skill-${Date.now()}`,
      skillId: "skill_spark_shot",
      targetId: id,
    });
  }, targetId);
}

export async function sendEnhanceAttemptIntent(page: Page, itemInstanceId: string): Promise<void> {
  await page.evaluate((id) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene.getScene("game");
    if (!scene?.room) throw new Error("game room unavailable");
    scene.room.send("intent", {
      type: "enhance.attempt",
      requestId: `smoke-enhance-${Date.now()}`,
      itemInstanceId: id,
    });
  }, itemInstanceId);
}

export async function sendLootPickupIntent(page: Page, lootId: string): Promise<void> {
  await page.evaluate((id) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene.getScene("game");
    if (!scene?.room) throw new Error("game room unavailable");
    scene.room.send("intent", {
      type: "loot.pickup",
      requestId: `smoke-loot-${Date.now()}`,
      lootId: id,
    });
  }, lootId);
}

export async function sendWorldInteractIntent(page: Page, objectId: string): Promise<void> {
  await page.evaluate((id) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene.getScene("game");
    if (!scene?.room) throw new Error("game room unavailable");
    scene.room.send("intent", {
      type: "world.interact",
      requestId: `smoke-interact-${Date.now()}`,
      objectId: id,
    });
  }, objectId);
}

export async function sendQuestAcceptIntent(page: Page, npcId: string, questId: string): Promise<void> {
  await page.evaluate(({ targetNpcId, targetQuestId }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene.getScene("game");
    if (!scene?.room) throw new Error("game room unavailable");
    scene.room.send("intent", {
      type: "quest.accept",
      requestId: `smoke-quest-accept-${Date.now()}`,
      npcId: targetNpcId,
      questId: targetQuestId,
    });
  }, { targetNpcId: npcId, targetQuestId: questId });
}

export async function sendQuestTurnInIntent(page: Page, npcId: string, questId: string): Promise<void> {
  await page.evaluate(({ targetNpcId, targetQuestId }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene.getScene("game");
    if (!scene?.room) throw new Error("game room unavailable");
    scene.room.send("intent", {
      type: "quest.turnIn",
      requestId: `smoke-quest-turn-in-${Date.now()}`,
      npcId: targetNpcId,
      questId: targetQuestId,
    });
  }, { targetNpcId: npcId, targetQuestId: questId });
}

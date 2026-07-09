import type { Page } from "@playwright/test";
import { FIELD_MAP_ID, HARBOR_MAP_ID, HARBOR_TO_FIELD_PORTAL_ID, PORTAL_TARGET_Y, PORTAL_X, TIMEOUT } from "./constants";
import { getVisibleMonsterClickTargets } from "./click-targets";
import { sendMoveIntent, sendTargetSelectIntent } from "./intents";
import { travelThroughPortal } from "./portal";
import { getRecentCombatEvents, getSmokeState } from "./state";
import type { SmokeBrowserGlobal } from "./types";

export async function stressCombatInput(page: Page): Promise<void> {
  await moveToOutOfRangeStressPoint(page);
  const beforeXp = await getLocalPlayerXp(page);
  const targets = await getVisibleMonsterClickTargets(page);
  if (targets.length < 2) {
    throw new Error(`expected at least two visible monster click targets, got ${JSON.stringify(targets)}`);
  }

  await page.keyboard.down("Space");
  for (let i = 0; i < 36; i += 1) {
    const target = targets[i % targets.length];
    await page.mouse.click(target.screenX, target.screenY);
    await page.waitForTimeout(20);
  }
  await page.keyboard.up("Space");
  await page.waitForTimeout(150);
  const cooldownToastCount = await countVisibleCooldownToasts(page);
  if (cooldownToastCount > 1) {
    throw new Error(`combat input stress stacked ${cooldownToastCount} cooldown toasts`);
  }
  console.log(`[smoke] Combat input stress: cooldown toast stack capped at ${cooldownToastCount}.`);

  // Clicking a monster leaves the client in held-attack mode
  // (InputController.isAttackHeld), which auto-chases and keeps casting at
  // the selected target — and the damaged shrooms retaliate (reactive aggro),
  // gang up, and can kill the player (death respawns on the harbor map and
  // breaks the route). Clear the held input, then retreat east past their
  // 360px reactive leash so they reset before continuing.
  await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    scene?.inputController?.clearHeldInput?.();
  });
  await page.waitForTimeout(250);

  const finalTarget = await selectVisibleMonsterForDeathStress(page);
  await page.evaluate((targetId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    scene?.room?.send("intent", {
      type: "skill.cast",
      requestId: `smoke-death-stress-${Date.now()}`,
      skillId: "skill_spark_shot",
      targetId,
      clientTimeMs: Date.now(),
    });
  }, finalTarget);
  await waitForDeathRespawnAtHarbor(page, beforeXp);
  const afterXp = await getLocalPlayerXp(page);
  console.log(`[smoke] Combat input stress: death respawned at Harbor with XP penalty ${beforeXp} -> ${afterXp}.`);
  await travelThroughPortal(page, HARBOR_TO_FIELD_PORTAL_ID, PORTAL_X, PORTAL_TARGET_Y, FIELD_MAP_ID);
}

export async function verifyUiBlocksHeldAttack(page: Page): Promise<void> {
  // Move UI moved out of the retired top-right #ui-move-toggle chip into the
  // Settings window (card-settings-window). Open Settings via the QA hook, then
  // drive the Move UI toggle by its stable data-settings-toggle selector.
  await page.evaluate(() => (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__?.openSettings?.());
  const moveToggle = page.locator("[data-settings-toggle='ui-move']");
  await moveToggle.waitFor({ state: "visible", timeout: TIMEOUT });

  await page.keyboard.down("Space");
  await moveToggle.dispatchEvent("click");
  await page.keyboard.up("Space");
  await page.waitForFunction(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const qa = (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__?.getVisualQaSnapshot?.();
    return doc.body.classList.contains("ui-move-enabled") && qa?.input?.attackHeld === false;
  }, null, { timeout: TIMEOUT });
  await moveToggle.dispatchEvent("click");
  await page.waitForFunction(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const qa = (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__?.getVisualQaSnapshot?.();
    return !doc.body.classList.contains("ui-move-enabled") && qa?.input?.attackHeld === false;
  }, null, { timeout: TIMEOUT });

  // Close Settings so its scrim/focus-trap doesn't block the rest of the smoke.
  await page.keyboard.press("Escape");
  await page.locator(".lm-settings").waitFor({ state: "detached", timeout: TIMEOUT });
}

async function moveToOutOfRangeStressPoint(page: Page): Promise<void> {
  const stressX = 850;
  const stressY = 700;
  await sendMoveIntent(page, stressX, stressY);
  await page.waitForFunction(({ x, y }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    return player && Math.hypot(player.x - x, player.y - y) <= 18;
  }, { x: stressX, y: stressY }, { timeout: TIMEOUT });
}

async function waitForSelectedTarget(page: Page, monsterId: string): Promise<void> {
  try {
    await page.waitForFunction((targetId) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
      const player = scene?.room?.state?.players?.get(scene.localSessionId);
      return player?.selectedTargetId === targetId;
    }, monsterId, { timeout: TIMEOUT });
  } catch (err) {
    const debugState = await page.evaluate((targetId) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
      const player = scene?.room?.state?.players?.get(scene.localSessionId);
      const monster = scene?.room?.state?.monsters?.get(targetId);
      const render = scene?.monsterObjects?.get(targetId);
      const input = scene?.input;
      return {
        wantedTargetId: targetId,
        selectedTargetId: player?.selectedTargetId,
        playerMapId: player?.mapId,
        playerMp: player?.mp,
        monster: monster
          ? { mapId: monster.mapId, alive: monster.alive, hp: monster.hp, x: monster.x, y: monster.y }
          : null,
        render: render
          ? {
              visible: render.container.visible,
              x: render.container.x,
              y: render.container.y,
            }
          : null,
        inputEnabled: input?.enabled,
        pointerCount: input?.manager?.pointers?.length,
      };
    }, monsterId);
    throw new Error(`selected target did not update; debug=${JSON.stringify(debugState)}`, { cause: err });
  }
}

async function selectVisibleMonsterForDeathStress(page: Page): Promise<string> {
  const freshTargets = await getVisibleMonsterClickTargets(page);
  const finalTarget = freshTargets.find((target) => target.monsterId.includes("monster_dawncap_shroom")) ?? freshTargets.at(-1);
  if (!finalTarget) {
    const state = await getSmokeState(page);
    const combatEvents = await getRecentCombatEvents(page);
    throw new Error(`no visible monster target remained after combat input stress; state=${JSON.stringify(state)} combat=${JSON.stringify(combatEvents)}`);
  }
  await sendTargetSelectIntent(page, finalTarget.monsterId);
  await waitForSelectedTarget(page, finalTarget.monsterId);
  return finalTarget.monsterId;
}

async function waitForDeathRespawnAtHarbor(page: Page, beforeXp: number): Promise<void> {
  try {
    await page.waitForFunction(({ harborMapId, xpBefore }) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
      const player = scene?.room?.state?.players?.get(scene.localSessionId);
      return player?.mapId === harborMapId && player.xp < xpBefore && player.hp === player.maxHp;
    }, { harborMapId: HARBOR_MAP_ID, xpBefore: beforeXp }, { timeout: 45_000 });
  } catch (err) {
    const state = await getSmokeState(page);
    const combatEvents = await getRecentCombatEvents(page);
    throw new Error(`combat input stress did not trigger death respawn at Harbor; state=${JSON.stringify(state)} combat=${JSON.stringify(combatEvents)}`, { cause: err });
  }
}

async function getLocalPlayerXp(page: Page): Promise<number> {
  const state = await getSmokeState(page);
  const player = state?.players.find((candidate) => candidate.sessionId === state.localSessionId);
  if (!player) throw new Error(`local player missing before combat input stress; state=${JSON.stringify(state)}`);
  return player.xp;
}

async function countVisibleCooldownToasts(page: Page): Promise<number> {
  return page.evaluate(() => Array.from((globalThis as SmokeBrowserGlobal).document.querySelectorAll(".lm-toast__message"))
    .filter((el) => el.textContent === "Skill cooling down").length);
}

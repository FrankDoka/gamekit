import type { Page } from "@playwright/test";
import { COMBAT_TRAINER_ID, COMBAT_TRAINER_X, COMBAT_TRAINER_Y, TIMEOUT } from "./constants";
import { getVisibleNpcClickTarget } from "./click-targets";
import { moveLocalPlayerNear, waitForLocalPlayerNear } from "./movement";
import { getSmokeState } from "./state";
import type { SmokeBrowserGlobal } from "./types";

const NPC_DIALOGUE_RADIUS = 120;

// Hard-assert proof for card-advancement-feedback #14: an eligible Wayfarer
// (seeded Lv 10 + quest_wayfarer_orders via GAMEKIT_SMOKE_ADVANCEMENT_PROOF)
// advances to a real order, the new class id + starting skill land the same tick,
// and the unmissable class-change celebration fires.
export async function verifyClassAdvancement(page: Page): Promise<void> {
  const before = await getSmokeState(page);
  const localBefore = before?.players.find((p) => p.sessionId === before.localSessionId);
  if (!localBefore) throw new Error("advancement: local player state missing before advance");
  if (localBefore.classId !== "class_wayfarer") {
    throw new Error(`advancement: expected seeded Wayfarer, got ${localBefore.classId}`);
  }
  if (localBefore.level < 10) {
    throw new Error(`advancement: expected seeded level >= 10, got ${localBefore.level}`);
  }

  await moveLocalPlayerNear(page, COMBAT_TRAINER_X, COMBAT_TRAINER_Y, NPC_DIALOGUE_RADIUS);
  await waitForLocalPlayerNear(page, COMBAT_TRAINER_X, COMBAT_TRAINER_Y, NPC_DIALOGUE_RADIUS);

  await openDialogue(page, COMBAT_TRAINER_ID);

  // The Advance option only renders when the server reports an eligible
  // advancement (DialogueService gate). Its presence is itself a proof.
  const advanceButton = page.locator("#dialogue-choices").getByRole("button", { name: "Advance" });
  await advanceButton.waitFor({ state: "visible", timeout: TIMEOUT });
  await advanceButton.click();

  // Advancement modal → pick the Guardian order. Each card is itself a <button>.
  const guardianCard = page.locator('button.advancement-card[data-class-id="class_guardian"]');
  await guardianCard.waitFor({ state: "visible", timeout: TIMEOUT });
  await guardianCard.click();

  // HARD-ASSERT: class id changed to Guardian, its starting skill (stonebind) is
  // present, AND the pre-advance Wayfarer kit (spark_shot) SURVIVED the advance.
  // Advancement KEEPS ancestor skills (card-skill-persistence, decisions.md
  // 2026-07-06) — the old wipe-on-advance behavior would drop spark_shot here.
  await page.waitForFunction(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId ?? "");
    if (!player) return false;
    const stonebind = player.skillLevels?.get?.("skill_stonebind") ?? 0;
    const sparkShot = player.skillLevels?.get?.("skill_spark_shot") ?? 0;
    return player.classId === "class_guardian" && stonebind > 0 && sparkShot > 0;
  }, null, { timeout: TIMEOUT });

  // HARD-ASSERT: the unmissable class-change celebration fired for the local player.
  await page.waitForFunction(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game") as
      | { getClassChangeCelebrationQaState?: () => { active: Array<{ classId: string; local: boolean }> } }
      | undefined;
    const qa = scene?.getClassChangeCelebrationQaState?.();
    return Boolean(qa?.active.some((c) => c.local && c.classId === "class_guardian"));
  }, null, { timeout: TIMEOUT });

  const after = await getSmokeState(page);
  const localAfter = after?.players.find((p) => p.sessionId === after.localSessionId);
  if (localAfter?.classId !== "class_guardian") {
    throw new Error(`advancement: class id did not settle to Guardian (got ${localAfter?.classId})`);
  }
  console.log("[smoke] Advancement: Wayfarer → Guardian, stonebind granted, celebration fired.");

  await verifyAdvancedClassCanStillCast(page);
}

// Regression proof for two rules at once:
//   1. Skill-node class gate (2026-07-06 live break): every node is authored
//      class_wayfarer, and an exact-match gate FORBADE all casts the moment a
//      player advanced — the lineage gate must keep them castable.
//   2. Skill persistence (card-skill-persistence, decisions.md 2026-07-06):
//      advancement KEEPS ancestor skills. The freshly advanced Guardian lands
//      skill_stonebind (its new starting kit) AND still holds skill_spark_shot
//      (the seeded Wayfarer kit). HARD-ASSERT BOTH cast by watching a monster's
//      HP drop for each — proving the retained skill was not wiped on advance.
async function verifyAdvancedClassCanStillCast(page: Page): Promise<void> {
  await castSkillAndExpectHpDrop(page, "skill_stonebind", "Guardian starting kit");
  await castSkillAndExpectHpDrop(page, "skill_spark_shot", "retained Wayfarer kit");
}

// A single cast can legitimately whiff (rollHit miss, or the target wandered out
// of melee range between the state read and the cast — spark shot is range 150),
// so the assert retries with a FRESH nearest-target selection per attempt. A cast
// that is server-REJECTED (the wipe/gate bugs this proof exists for) never lands
// on any attempt, so the regression signal is preserved.
async function castSkillAndExpectHpDrop(page: Page, skillId: string, label: string): Promise<void> {
  const attempts = 4;
  let lastNote = "no attempt ran";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const state = await getSmokeState(page);
    const local = state?.players.find((p) => p.sessionId === state.localSessionId);
    if (!local) throw new Error(`advanced-cast (${skillId}): local player state missing`);
    const target = (state?.monsters ?? [])
      .filter((m) => m.mapId === local.mapId && m.alive)
      .sort((a, b) => Math.hypot(local.x - a.x, local.y - a.y) - Math.hypot(local.x - b.x, local.y - b.y))[0];
    if (!target) throw new Error(`advanced-cast (${skillId}): no alive monster on the player's map`);

    await moveLocalPlayerNear(page, target.x + 60, target.y, 30);
    const beforeHp = target.hp;
    await page.evaluate(({ monsterId, castSkillId }) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
      if (!scene?.room) throw new Error("game room unavailable");
      scene.room.send("intent", {
        type: "skill.cast",
        requestId: `smoke-advanced-cast-${castSkillId}-${Date.now()}`,
        skillId: castSkillId,
        targetId: monsterId,
      });
    }, { monsterId: target.monsterId, castSkillId: skillId });

    const dropped = await page.waitForFunction(({ monsterId, hpBefore }) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
      const monster = scene?.room?.state?.monsters?.get(monsterId);
      return Boolean(monster && monster.hp < hpBefore);
    }, { monsterId: target.monsterId, hpBefore: beforeHp }, { timeout: 6_000 }).then(() => true, () => false);
    if (dropped) {
      console.log(`[smoke] Advancement: Guardian cast ${skillId} (${label}); ${target.monsterId} HP dropped below ${beforeHp} (attempt ${attempt}).`);
      return;
    }
    lastNote = `attempt ${attempt}/${attempts}: no HP drop on ${target.monsterId} (miss/out-of-range are legitimate once; rejection is not)`;
    await page.waitForTimeout(900); // let cooldown clear before the retry
  }
  throw new Error(`advanced-cast (${skillId}, ${label}): ${lastNote}`);
}

async function openDialogue(page: Page, npcId: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const target = await getVisibleNpcClickTarget(page, npcId);
    await page.mouse.click(target.screenX, target.screenY);
    const opened = await page
      .waitForFunction(() => {
        const panel = (globalThis as SmokeBrowserGlobal).document.getElementById("dialogue");
        return panel && !panel.hidden;
      }, null, { timeout: 2_500 })
      .then(() => true, () => false);
    if (opened) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`advancement: npc ${npcId} dialogue did not open`);
}

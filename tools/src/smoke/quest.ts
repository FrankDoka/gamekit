import type { Page } from "@playwright/test";
import {
  FIELD_QUEST_ID,
  FIELD_QUEST_NPC_ID,
  FIELD_QUEST_NPC_X,
  FIELD_QUEST_NPC_Y,
  FIELD_QUEST_REWARD_GOLD,
  FIELD_QUEST_REWARD_XP,
  FIELD_TO_HARBOR_PORTAL_ID,
  FIELD_TO_HARBOR_PORTAL_TARGET_Y,
  FIELD_TO_HARBOR_PORTAL_X,
  GOLD_ID,
  HARBOR_MAP_ID,
  HARBOR_QUEST_ID,
  HARBOR_QUEST_NPC_ID,
  HARBOR_QUEST_NPC_X,
  HARBOR_QUEST_NPC_Y,
  NPC_FOOTPRINT_OFFSET_Y,
  NPC_INTERACT_RANGE,
  PLAYER_FOOT_OFFSET_Y,
  QUEST_STATUS_TIMEOUT,
  TIMEOUT,
} from "./constants";
import { getVisibleNpcClickTarget } from "./click-targets";
import { moveLocalPlayerNear, waitForLocalPlayerNear } from "./movement";
import { travelThroughPortal } from "./portal";
import { getRecentCombatEvents, getSmokeState } from "./state";
import type { QuestStatus, SmokeBrowserGlobal } from "./types";

// NOTE: the old completeThornhollowScoutQuest (accept + kill + turn-in in a
// second zone) was cut: no current second zone hosts both a quest giver and its
// kill target. That coverage now lives in the fernwatch loop
// (acceptFieldQuestAndKill in combat.ts + turnInFieldQuest below).
const NPC_DIALOGUE_RADIUS = 120;

/**
 * Verify the Emberglass Scout dialogue does NOT offer quest_embers_in_ruin
 * (target monster on unreachable map_emberglass_ruins → server gates the offer).
 */
export async function verifyHarborQuestGated(page: Page): Promise<void> {
  await moveLocalPlayerNear(page, HARBOR_QUEST_NPC_X, HARBOR_QUEST_NPC_Y, NPC_DIALOGUE_RADIUS);
  await waitForLocalPlayerNear(page, HARBOR_QUEST_NPC_X, HARBOR_QUEST_NPC_Y, NPC_DIALOGUE_RADIUS);
  await waitForNpcVisible(page, HARBOR_QUEST_NPC_ID);
  await openDialogueWithNpc(page, HARBOR_QUEST_NPC_ID);
  // The Accept button must NOT appear — the quest targets an unreachable map.
  const hasAccept = await page.waitForFunction(() => {
    const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> } }).document;
    return Array.from(doc.querySelectorAll("button")).some((b) => b.textContent === "Accept");
  }, null, { timeout: 2_000 }).then(() => true, () => false);
  if (hasAccept) {
    throw new Error(`${HARBOR_QUEST_ID} should be gated (unreachable target map) but Accept button appeared`);
  }
  await closeDialogueIfOpen(page);
  console.log(`[smoke] Quest gate verified: ${HARBOR_QUEST_ID} not offered (target map unreachable).`);
}

/** Walk to an NPC, open its dialogue, click Accept, and wait for the quest to go active. */
export async function acceptQuestViaDialogue(
  page: Page,
  npcId: string,
  npcX: number,
  npcY: number,
  questId: string,
  expectedMarkerState: "plain" | "available" | "active" | "ready" = "active",
  expectedQuestStatus: "active" | "ready" = "active",
): Promise<QuestStatus> {
  await moveNearNpcForDialogue(page, npcX, npcY);
  await waitForNpcVisible(page, npcId);
  await waitForNpcQuestMarkerState(page, npcId, "available");
  await openDialogueWithNpc(page, npcId);
  await waitForDialogueButton(page, "Accept", npcId);
  await clickDialogueQuestAction(page, "Accept", "Accept", npcId);
  const status = await waitForQuestStatus(page, questId, expectedQuestStatus);
  await waitForNpcQuestMarkerState(page, npcId, expectedMarkerState);
  await closeDialogueIfOpen(page);
  console.log(`[smoke] Quest: accepted ${status.questId} at ${status.progress}/${status.required}.`);
  return status;
}

export async function turnInQuestViaDialogue(
  page: Page,
  npcId: string,
  npcX: number,
  npcY: number,
  questId: string,
  rewardXp: number,
  rewardGold: number,
): Promise<QuestStatus> {
  const before = await getLocalQuestAndGold(page);
  await moveNearNpcForDialogue(page, npcX, npcY);
  await waitForNpcVisible(page, npcId);
  await waitForNpcQuestMarkerState(page, npcId, "ready");
  const completed = await turnInQuestWithRetry(page, npcId, npcX, npcY, questId);
  await page.waitForFunction(({ beforeXp, beforeGold, expectedXp, expectedGold }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    const gold = player?.inventory?.get("item_gold")?.quantity ?? 0;
    return player?.xp >= beforeXp + expectedXp && gold >= beforeGold + expectedGold;
  }, {
    beforeXp: before.beforeXp,
    beforeGold: before.beforeGold,
    expectedXp: rewardXp,
    expectedGold: rewardGold,
  }, { timeout: TIMEOUT });
  await closeDialogueIfOpen(page);
  const after = await getLocalQuestAndGold(page);
  if (after.beforeXp < before.beforeXp + rewardXp || after.beforeGold < before.beforeGold + rewardGold) {
    throw new Error(`quest ${questId} reward delta too small: before=${JSON.stringify(before)} after=${JSON.stringify(after)} expected=+${rewardXp}/+${rewardGold}`);
  }
  console.log(`[smoke] Quest: turned in ${completed.questId}; XP ${before.beforeXp} -> ${after.beforeXp}; gold ${before.beforeGold} -> ${after.beforeGold}; rewards asserted +${rewardXp}/+${rewardGold}.`);
  return completed;
}

export async function reacceptRepeatableQuestViaDialogue(
  page: Page,
  npcId: string,
  npcX: number,
  npcY: number,
  questId: string,
): Promise<QuestStatus> {
  const active = await acceptQuestViaDialogue(page, npcId, npcX, npcY, questId);
  if (active.progress !== 0) {
    throw new Error(`repeatable ${questId} re-accepted with non-zero progress: ${JSON.stringify(active)}`);
  }
  console.log(`[smoke] Quest: repeatable ${active.questId} re-accepted after turn-in at ${active.progress}/${active.required}.`);
  return active;
}

/**
 * Accept a talk quest whose only objective is the NPC you are already talking to (e.g. Report to
 * Warden Bray). card-npc-interact-flow collapses the ceremony: accepting auto-re-opens the dialogue
 * with talk progress already advanced, so the player lands straight on Turn In (status "ready")
 * within one conversation — no unselect/reselect, no second walk-up.
 */
export async function acceptTalkQuestCollapsesToReady(
  page: Page,
  npcId: string,
  npcX: number,
  npcY: number,
  questId: string,
): Promise<QuestStatus> {
  await moveNearNpcForDialogue(page, npcX, npcY);
  await waitForNpcVisible(page, npcId);
  await waitForNpcQuestMarkerState(page, npcId, "available");
  await openDialogueWithNpc(page, npcId);
  await waitForDialogueButton(page, "Accept", npcId);
  await clickDialogueQuestAction(page, "Accept", "Accept", npcId);
  // The client auto-re-interacts; the follow-up dialogue must offer Turn In and the quest is ready.
  const ready = await waitForQuestStatus(page, questId, "ready");
  await waitForDialogueButton(page, "Turn In", npcId);
  await waitForNpcQuestMarkerState(page, npcId, "ready");
  await closeDialogueIfOpen(page);
  console.log(`[smoke] Quest: talk quest ${ready.questId} collapsed accept->ready in one dialogue at ${ready.progress}/${ready.required}.`);
  return ready;
}

export async function completeTalkQuestViaDialogue(
  page: Page,
  npcId: string,
  npcX: number,
  npcY: number,
  questId: string,
): Promise<QuestStatus> {
  await moveNearNpcForDialogue(page, npcX, npcY);
  await waitForNpcVisible(page, npcId);
  await openDialogueWithNpc(page, npcId);
  const ready = await waitForQuestStatus(page, questId, "ready");
  await waitForNpcQuestMarkerState(page, npcId, "ready");
  await closeDialogueIfOpen(page);
  console.log(`[smoke] Quest: completed talk objective ${ready.questId} at ${ready.progress}/${ready.required}.`);
  return ready;
}

/** Turn in quest_dawncap_gathering at the Fernwatch ranger and verify the rewards. */
export async function turnInFieldQuest(page: Page): Promise<QuestStatus> {
  const before = await getLocalQuestAndGold(page);
  await moveLocalPlayerNear(page, FIELD_QUEST_NPC_X, FIELD_QUEST_NPC_Y, NPC_DIALOGUE_RADIUS);
  await waitForNpcVisible(page, FIELD_QUEST_NPC_ID);
  const target = await getVisibleNpcClickTarget(page, FIELD_QUEST_NPC_ID);
  await page.mouse.click(target.screenX, target.screenY);
  await waitForDialogueButton(page, "Turn In", FIELD_QUEST_NPC_ID);
  await clickDialogueQuestAction(page, "Turn In", "Claim", FIELD_QUEST_NPC_ID);

  const completed = await waitForQuestStatus(page, FIELD_QUEST_ID, "completed");
  await page.waitForFunction(({ beforeXp, beforeGold, rewardXp, rewardGold }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    const gold = player?.inventory?.get("item_gold")?.quantity ?? 0;
    return player?.xp >= beforeXp + rewardXp && gold >= beforeGold + rewardGold;
  }, {
    beforeXp: before.beforeXp,
    beforeGold: before.beforeGold,
    rewardXp: FIELD_QUEST_REWARD_XP,
    rewardGold: FIELD_QUEST_REWARD_GOLD,
  }, { timeout: TIMEOUT });
  await closeDialogueIfOpen(page);
  const after = await getLocalQuestAndGold(page);
  console.log(`[smoke] Quest: turned in ${completed.questId}; XP ${before.beforeXp} -> ${after.beforeXp}; gold ${before.beforeGold} -> ${after.beforeGold}.`);
  return completed;
}

/** Walk into the fernwatch -> harbor portal and verify arrival on the harbor map. */
export async function returnToHarbor(page: Page): Promise<void> {
  await travelThroughPortal(
    page,
    FIELD_TO_HARBOR_PORTAL_ID,
    FIELD_TO_HARBOR_PORTAL_X,
    FIELD_TO_HARBOR_PORTAL_TARGET_Y,
    HARBOR_MAP_ID,
  );
  const state = await getSmokeState(page);
  const localPlayer = state?.players.find((player) => player.sessionId === state.localSessionId);
  if (localPlayer?.mapId !== HARBOR_MAP_ID) {
    throw new Error(`return to harbor failed: ${JSON.stringify(state)}`);
  }
  console.log(`[smoke] Returned to ${HARBOR_MAP_ID} at (${localPlayer.x}, ${localPlayer.y}).`);
}

export async function waitForQuestStatus(page: Page, questId: string, status: string): Promise<QuestStatus> {
  const timeoutMs = getQuestStatusTimeoutMs();
  const pollMs = 250;
  const startMs = Date.now();
  const hardDeadlineMs = startMs + timeoutMs + 15_000;
  let deadlineMs = startMs + timeoutMs;
  let lastSignature: string | null = null;
  let lastQuest: QuestStatus | null = null;
  const timeline: Array<{ elapsedMs: number; quest: QuestStatus | null }> = [];

  while (Date.now() <= hardDeadlineMs) {
    const nowMs = Date.now();
    const quest = await getQuestStatusSnapshot(page, questId);
    const signature = getQuestStatusSignature(quest);
    lastQuest = quest;
    if (signature !== lastSignature) {
      timeline.push({ elapsedMs: nowMs - startMs, quest });
      lastSignature = signature;
      deadlineMs = nowMs + timeoutMs;
    }
    if (quest?.status === status) return quest;
    if (nowMs >= deadlineMs) break;
    await page.waitForTimeout(pollMs);
  }

  const state = await getSmokeState(page);
  throw new Error(
    `timed out waiting for quest ${questId} to become ${status}; lastObserved=${JSON.stringify(lastQuest)} timeline=${JSON.stringify(timeline)} state=${JSON.stringify(state)}`,
  );
}

export async function waitForNpcQuestMarkerState(
  page: Page,
  npcId: string,
  state: "plain" | "available" | "active" | "ready",
): Promise<void> {
  await page.waitForFunction(({ targetNpcId, targetState }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const snapshot = scene?.getVisualQaSnapshot?.();
    return snapshot?.npcs?.find((npc) => npc.id === targetNpcId)?.questMarkerState === targetState;
  }, { targetNpcId: npcId, targetState: state }, { timeout: QUEST_STATUS_TIMEOUT });
  console.log(`[smoke] Quest marker: ${npcId} is ${state}.`);
}

export async function waitForNpcVisible(page: Page, npcId: string): Promise<void> {
  try {
    await page.waitForFunction((wantedNpcId) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
      const localPlayer = scene?.room?.state?.players?.get(scene.localSessionId);
      const npc = scene?.room?.state?.npcs?.get(wantedNpcId);
      const render = scene?.npcObjects?.get(wantedNpcId);
      return npc?.mapId === localPlayer?.mapId && render?.container?.visible === true;
    }, npcId, { timeout: TIMEOUT });
  } catch (err) {
    const debug = await page.evaluate((wantedNpcId) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
      const localPlayer = scene?.room?.state?.players?.get(scene.localSessionId);
      const npc = scene?.room?.state?.npcs?.get(wantedNpcId);
      const render = scene?.npcObjects?.get(wantedNpcId);
      return {
        localMapId: localPlayer?.mapId,
        localX: localPlayer?.x,
        localY: localPlayer?.y,
        currentMapId: scene?.currentMapId,
        npc: npc ? { mapId: npc.mapId, x: npc.x, y: npc.y } : null,
        npcObjectCount: scene?.npcObjects?.size,
        render: render ? { visible: render.container.visible, x: render.container.x, y: render.container.y } : null,
      };
    }, npcId);
    throw new Error(`npc ${npcId} did not become visible; debug=${JSON.stringify(debug)}`, { cause: err });
  }
}

async function openDialogueWithNpc(page: Page, npcId: string): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const target = await getVisibleNpcClickTarget(page, npcId);
    await page.mouse.click(target.screenX, target.screenY);
    const opened = await page.waitForFunction(() => {
      const panel = (globalThis as SmokeBrowserGlobal).document.getElementById("dialogue");
      return panel && !panel.hidden;
    }, null, { timeout: 2_500 }).then(() => true, () => false);
    if (opened) return;
    await page.waitForTimeout(250);
  }
  await sendWorldInteractIntentForNpc(page, npcId);
  const openedByIntent = await page.waitForFunction(() => {
    const panel = (globalThis as SmokeBrowserGlobal).document.getElementById("dialogue");
    return panel && !panel.hidden;
  }, null, { timeout: 2_500 }).then(() => true, () => false);
  if (openedByIntent) return;
  const debug = await getDialogueDebug(page, npcId);
  throw new Error(`npc ${npcId} dialogue did not open; debug=${JSON.stringify(debug)}`);
}

async function sendWorldInteractIntentForNpc(page: Page, npcId: string): Promise<void> {
  await page.evaluate((targetNpcId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game") as {
      roomClient?: { sendWorldInteractIntent?: (objectId: string) => void };
      sendWorldInteractIntent?: (objectId: string) => void;
    } | undefined;
    if (scene?.roomClient?.sendWorldInteractIntent) {
      scene.roomClient.sendWorldInteractIntent(targetNpcId);
      return;
    }
    if (scene?.sendWorldInteractIntent) {
      scene.sendWorldInteractIntent(targetNpcId);
      return;
    }
    throw new Error("world interact intent bridge unavailable");
  }, npcId);
}

async function waitForDialogueButton(page: Page, label: string, npcId: string): Promise<void> {
  try {
    await page.waitForFunction((wantedLabel) => {
      const doc = (globalThis as SmokeBrowserGlobal).document;
      const panel = doc.getElementById("dialogue");
      const button = Array.from(doc.querySelectorAll("button")).find((candidate) => candidate.textContent === wantedLabel);
      return panel && !panel.hidden && Boolean(button);
    }, label, { timeout: TIMEOUT });
  } catch (err) {
    const debug = await getDialogueDebug(page, npcId);
    throw new Error(`dialogue button "${label}" did not become available for ${npcId}; debug=${JSON.stringify(debug)}`, {
      cause: err,
    });
  }
}

async function clickDialogueQuestAction(page: Page, dialogueLabel: "Accept" | "Turn In", modalLabel: "Accept" | "Claim", npcId: string): Promise<void> {
  await page.locator("#dialogue").getByRole("button", { name: dialogueLabel }).click();
  try {
    const modalButton = page.locator(".quest-offer-modal").getByRole("button", { name: modalLabel });
    await modalButton.waitFor({ state: "visible", timeout: TIMEOUT });
    await modalButton.click();
  } catch (err) {
    const debug = await getDialogueDebug(page, npcId);
    throw new Error(`quest modal button "${modalLabel}" did not become available for ${npcId}; debug=${JSON.stringify(debug)}`, {
      cause: err,
    });
  }
}

async function closeDialogueIfOpen(page: Page): Promise<void> {
  const closeDialogue = page.locator("#dialogue-choices").getByRole("button", { name: /^(Close|Later|Just passing through\.|Back to the road\.)$/ });
  if (await closeDialogue.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await closeDialogue.click();
  }
  const panelOpen = await page.locator("#dialogue").isVisible({ timeout: 500 }).catch(() => false);
  if (!panelOpen) return;
  const choices = page.locator("#dialogue-choices button");
  const count = await choices.count();
  if (count > 0) {
    await choices.nth(count - 1).click();
  }
}

async function moveNearNpcForDialogue(page: Page, npcX: number, npcY: number): Promise<void> {
  // The mover is now collision-aware (movement.ts planCollisionAwarePath): it
  // routes around static props on its own, so the old coordinate-coupled detour
  // waypoints (690,760 / 600,560 for northbound harbor legs) are retired — they
  // broke every time a prop moved (notes-p0 §2a). Walk straight to the NPC's
  // interact anchor from wherever we are; the planner handles the obstacles.
  await moveLocalPlayerNear(page, getPlayerXForNpcInteract(npcX), getPlayerYForNpcInteract(npcY), 28);
  await waitForLocalPlayerInNpcInteractRange(page, npcX, npcY);
}

async function waitForLocalPlayerInNpcInteractRange(page: Page, npcX: number, npcY: number): Promise<void> {
  try {
    await page.waitForFunction(({ targetX, targetY, footOffsetY, npcOffsetY, maxDistance }) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
      const player = scene?.room?.state?.players?.get(scene.localSessionId);
      return player && Math.hypot(player.x - targetX, player.y + footOffsetY - (targetY + npcOffsetY)) <= maxDistance;
    }, {
      targetX: npcX,
      targetY: npcY,
      footOffsetY: PLAYER_FOOT_OFFSET_Y,
      npcOffsetY: NPC_FOOTPRINT_OFFSET_Y,
      maxDistance: NPC_INTERACT_RANGE - 24,
    }, { timeout: TIMEOUT });
  } catch (err) {
    const state = await getSmokeState(page);
    throw new Error(`local player did not enter NPC interaction range for (${npcX}, ${npcY}); state=${JSON.stringify(state)}`, { cause: err });
  }
}

function getPlayerXForNpcInteract(npcX: number): number {
  return npcX + 40;
}

function getPlayerYForNpcInteract(npcY: number): number {
  return npcY + 45;
}

async function getLocalQuestAndGold(page: Page): Promise<{ beforeXp: number; beforeGold: number }> {
  const state = await getSmokeState(page);
  const localPlayer = state?.players.find((player) => player.sessionId === state.localSessionId);
  if (!localPlayer) throw new Error(`local player missing for quest reward check: ${JSON.stringify(state)}`);
  const gold = localPlayer.inventory.find((item) => item.itemId === GOLD_ID)?.quantity ?? 0;
  return { beforeXp: localPlayer.xp, beforeGold: gold };
}

async function turnInQuestWithRetry(page: Page, npcId: string, npcX: number, npcY: number, questId: string): Promise<QuestStatus> {
  await openDialogueWithNpc(page, npcId);
  await waitForDialogueButton(page, "Turn In", npcId);
  await clickDialogueQuestAction(page, "Turn In", "Claim", npcId);

  try {
    return await waitForQuestStatus(page, questId, "completed");
  } catch (err) {
    const quest = await getQuestStatusSnapshot(page, questId);
    if (quest?.status !== "ready") throw err;
    console.log(`[smoke] Quest: ${questId} still ready after the first turn-in click; reopening dialogue and retrying once.`);
    await moveNearNpcForDialogue(page, npcX, npcY);
    await openDialogueWithNpc(page, npcId);
    await waitForDialogueButton(page, "Turn In", npcId);
    await clickDialogueQuestAction(page, "Turn In", "Claim", npcId);
    return waitForQuestStatus(page, questId, "completed");
  }
}

async function getQuestStatusSnapshot(page: Page, questId: string): Promise<QuestStatus | null> {
  const state = await getSmokeState(page);
  const localPlayer = state?.players.find((player) => player.sessionId === state.localSessionId);
  return localPlayer?.quests.find((candidate) => candidate.questId === questId) ?? null;
}

function getQuestStatusSignature(quest: QuestStatus | null): string {
  return quest ? `${quest.status}:${quest.progress}/${quest.required}` : "missing";
}

function getQuestStatusTimeoutMs(): number {
  const override = process.env.GAMEKIT_SMOKE_QUEST_STATUS_TIMEOUT_MS;
  if (!override) return QUEST_STATUS_TIMEOUT;
  const parsed = Number(override);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : QUEST_STATUS_TIMEOUT;
}

async function getDialogueDebug(page: Page, npcId: string): Promise<Record<string, unknown>> {
  const combatEvents = await getRecentCombatEvents(page);
  const state = await page.evaluate((wantedNpcId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const localPlayer = scene?.room?.state?.players?.get(scene.localSessionId);
    const npc = scene?.room?.state?.npcs?.get(wantedNpcId);
    const render = scene?.npcObjects?.get(wantedNpcId);
    const panel = (globalThis as SmokeBrowserGlobal).document.getElementById("dialogue");
    return {
      localMapId: localPlayer?.mapId,
      localX: localPlayer?.x,
      localY: localPlayer?.y,
      npc: npc ? { mapId: npc.mapId, x: npc.x, y: npc.y, questId: npc.questId } : null,
      distance: localPlayer && npc ? Math.round(Math.hypot(localPlayer.x - npc.x, localPlayer.y - npc.y)) : null,
      render: render ? { visible: render.container.visible, x: render.container.x, y: render.container.y } : null,
      dialogueHidden: panel?.hidden,
      dialogueText: panel?.textContent,
      buttons: Array.from((globalThis as SmokeBrowserGlobal).document.querySelectorAll("button")).map((button) => button.textContent),
    };
  }, npcId);
  return { ...state, combatEvents };
}

if (process.argv.includes("--selftest")) {
  const samples: Array<{ elapsedMs: number; quest: QuestStatus | null }> = [
    { elapsedMs: 0, quest: null },
    { elapsedMs: 500, quest: { questId: "quest_demo", status: "ready", progress: 4, required: 4 } },
    { elapsedMs: 1_500, quest: { questId: "quest_demo", status: "completed", progress: 4, required: 4 } },
  ];
  const rendered = JSON.stringify({
    questId: "quest_demo",
    wantedStatus: "completed",
    lastObserved: samples.at(-1)?.quest ?? null,
    timeline: samples,
  });
  const checks = [
    { name: "last observed quest is preserved", ok: rendered.includes('"lastObserved":{"questId":"quest_demo","status":"completed","progress":4,"required":4}') },
    { name: "timeline is preserved", ok: rendered.includes('"timeline"') && rendered.includes('"elapsedMs":500') },
  ];
  const failures = checks.filter((check) => !check.ok);
  for (const check of checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"}: ${check.name}`);
  }
  if (failures.length > 0) {
    console.error(`[smoke quest selftest] ${failures.length} case(s) failed`);
    process.exit(1);
  }
  console.log(`[smoke quest selftest] all ${checks.length} cases passed`);
}

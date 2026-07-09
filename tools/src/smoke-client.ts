/**
 * Headless smoke test for the Phaser + Colyseus client.
 *
 * Starts the world server and Vite dev server when needed, opens two Chromium
 * pages, and runs the first-playable smoke sequence in feature modules.
 *
 * Zone-1 Reset (2026-07-03): everything past Bloomvale Plains is quarantined to
 * content/_retired/ (no portals, no quests live until the deeper zones return).
 * card-bloomvale-revival (2026-07-03) returned the slime roster, so the Bloomvale
 * route now boots two guests and exercises shop / chat / item-use rejection /
 * camera zoom / UI-blocks-held-attack / replicated movement PLUS slime combat
 * (kill a passive Meadow Slime, per-kill XP) + respawn and aggressive-monster
 * behavior (Honey Slime approach -> damage -> leash reset). The loot/quest/portal
 * coverage stays parked with its retired content in the smoke feature modules and
 * resumes when the deeper zones return. See decisions.md "Zone-1 Reset" +
 * "Bloomvale Starter Roster".
 *
 * Usage:  pnpm smoke:client   (or:  tsx tools/src/smoke-client.ts)
 * Saves a screenshot to tools/smoke-screenshot.png on success.
 */

import {
  completeBloomvaleDewdropKills,
  completeBloomvaleFirstHuntKills,
  completeBloomvalePatrolKills,
  verifyAggressiveMonsterBehavior,
  verifyLanternBurstHitsSlime,
  verifyMonsterRespawn,
} from "./smoke/combat";
import {
  BLOOMVALE_FIRST_HUNT_QUEST_ID,
  BLOOMVALE_FIRST_HUNT_REWARD_GOLD,
  BLOOMVALE_FIRST_HUNT_REWARD_XP,
  BLOOMVALE_DEWDROP_CULL_QUEST_ID,
  BLOOMVALE_DEWDROP_CULL_REWARD_GOLD,
  BLOOMVALE_DEWDROP_CULL_REWARD_XP,
  BLOOMVALE_MOSS_SAMPLES_QUEST_ID,
  BLOOMVALE_MOSS_SAMPLES_REQUIRED,
  BLOOMVALE_MOSS_SAMPLES_REWARD_GOLD,
  BLOOMVALE_MOSS_SAMPLES_REWARD_XP,
  BLOOMVALE_PATROL_QUEST_ID,
  BLOOMVALE_PATROL_REWARD_GOLD,
  BLOOMVALE_PATROL_REWARD_XP,
  BLOOMVALE_WARDEN_BRIEFING_QUEST_ID,
  BLOOMVALE_WARDEN_BRIEFING_REWARD_GOLD,
  BLOOMVALE_WARDEN_BRIEFING_REWARD_XP,
  COMBAT_TRAINER_ID,
  COMBAT_TRAINER_X,
  COMBAT_TRAINER_Y,
  HARBOR_WARDEN_ID,
  HARBOR_WARDEN_X,
  HARBOR_WARDEN_Y,
  LANTERNWAKE_QUEST_ID,
  LANTERNWAKE_QUEST_NPC_ID,
  LANTERNWAKE_QUEST_NPC_X,
  LANTERNWAKE_QUEST_NPC_Y,
  LANTERNWAKE_QUEST_REWARD_GOLD,
  LANTERNWAKE_QUEST_REWARD_XP,
  MOSS_SPORE_ID,
  SLIME_AGGRO_MONSTER_ID,
} from "./smoke/constants";
import { createSmokeHarness, saveScreenshotAndClose, stopChildProcesses } from "./smoke/harness";
import { verifyUiBlocksHeldAttack } from "./smoke/input-stress";
import { useMinorManaPotionAndAssertMpDelta, verifyFullHpPotionUseRejected } from "./smoke/item";
import { collectLootForQuest } from "./smoke/loot";
import { verifyMouseWheelZoom, verifyReplicatedMovement } from "./smoke/movement";
import { travelBloomvaleToLanternwake, travelLanternwakeToBloomvale, verifyPortalRoundTrip } from "./smoke/portal";
import { acceptQuestViaDialogue, acceptTalkQuestCollapsesToReady, completeTalkQuestViaDialogue, turnInQuestViaDialogue, waitForQuestStatus } from "./smoke/quest";
import { buyPotionFromHarborShop } from "./smoke/shop";
import { craftAtHarborStation } from "./smoke/craft";
import { openChestAndAssertLoot } from "./smoke/chest";
import { verifyWorldChat } from "./smoke/chat";

async function main(): Promise<void> {
  const harness = await createSmokeHarness({
    instantDialogue: true,
    worldEnv: {
      GAMEKIT_SMOKE_GRANT_MANA_POTION: "true",
      GAMEKIT_SMOKE_GRANT_CRAFT_MATERIALS: "true",
      GAMEKIT_FORCE_LOOT: "always",
    },
  });
  const { pageA, pageB, joinedA, stateB, consoleErrors } = harness;

  await buyPotionFromHarborShop(pageA);
  await craftAtHarborStation(pageA);
  await openChestAndAssertLoot(pageA);
  await verifyWorldChat(pageA, pageB);
  await verifyFullHpPotionUseRejected(pageA);

  await verifyMouseWheelZoom(pageA);
  console.log("[smoke] Mouse wheel zoom clamps out and back in.");
  await verifyUiBlocksHeldAttack(pageA);
  console.log("[smoke] UI move mode clears held attack input.");

  if (consoleErrors.length > 0) {
    throw new Error(`console errors during boot:\n${consoleErrors.join("\n")}`);
  }

  await verifyReplicatedMovement(pageA, pageB, joinedA, stateB);
  await verifyPortalRoundTrip(pageA);

  // Bloomvale skill combat checks (card-dehardcode-skills-items).
  await verifyLanternBurstHitsSlime(pageA);
  await useMinorManaPotionAndAssertMpDelta(pageA);

  // Bloomvale quest loop + slime combat (card-quest-loop-z1).
  // card-p0-first-minute: the first-join quest is server-auto-accepted; assert it
  // instead of accepting via dialogue (the NPC no longer offers Accept for it).
  {
    const firstHunt = await waitForQuestStatus(pageA, BLOOMVALE_FIRST_HUNT_QUEST_ID, "active");
    console.log(`[smoke] Quest: ${firstHunt.questId} auto-accepted on join at ${firstHunt.progress}/${firstHunt.required}.`);
  }
  const killedSlime = await completeBloomvaleFirstHuntKills(pageA, joinedA);
  await turnInQuestViaDialogue(
    pageA,
    COMBAT_TRAINER_ID,
    COMBAT_TRAINER_X,
    COMBAT_TRAINER_Y,
    BLOOMVALE_FIRST_HUNT_QUEST_ID,
    BLOOMVALE_FIRST_HUNT_REWARD_XP,
    BLOOMVALE_FIRST_HUNT_REWARD_GOLD,
  );
  await acceptQuestViaDialogue(pageA, COMBAT_TRAINER_ID, COMBAT_TRAINER_X, COMBAT_TRAINER_Y, BLOOMVALE_DEWDROP_CULL_QUEST_ID);
  await completeBloomvaleDewdropKills(pageA, joinedA);
  await turnInQuestViaDialogue(
    pageA,
    COMBAT_TRAINER_ID,
    COMBAT_TRAINER_X,
    COMBAT_TRAINER_Y,
    BLOOMVALE_DEWDROP_CULL_QUEST_ID,
    BLOOMVALE_DEWDROP_CULL_REWARD_XP,
    BLOOMVALE_DEWDROP_CULL_REWARD_GOLD,
  );
  // card-npc-interact-flow: the Warden Briefing talk objective is the Warden herself, so accepting
  // collapses straight to turn-in-ready in one dialogue (no accept -> re-talk ceremony).
  await acceptTalkQuestCollapsesToReady(pageA, HARBOR_WARDEN_ID, HARBOR_WARDEN_X, HARBOR_WARDEN_Y, BLOOMVALE_WARDEN_BRIEFING_QUEST_ID);
  await turnInQuestViaDialogue(
    pageA,
    HARBOR_WARDEN_ID,
    HARBOR_WARDEN_X,
    HARBOR_WARDEN_Y,
    BLOOMVALE_WARDEN_BRIEFING_QUEST_ID,
    BLOOMVALE_WARDEN_BRIEFING_REWARD_XP,
    BLOOMVALE_WARDEN_BRIEFING_REWARD_GOLD,
  );
  await verifyMonsterRespawn(pageA, killedSlime.monsterId);

  await acceptQuestViaDialogue(pageA, HARBOR_WARDEN_ID, HARBOR_WARDEN_X, HARBOR_WARDEN_Y, BLOOMVALE_PATROL_QUEST_ID);
  await completeBloomvalePatrolKills(pageA, joinedA);
  await turnInQuestViaDialogue(
    pageA,
    HARBOR_WARDEN_ID,
    HARBOR_WARDEN_X,
    HARBOR_WARDEN_Y,
    BLOOMVALE_PATROL_QUEST_ID,
    BLOOMVALE_PATROL_REWARD_XP,
    BLOOMVALE_PATROL_REWARD_GOLD,
  );
  await acceptQuestViaDialogue(pageA, COMBAT_TRAINER_ID, COMBAT_TRAINER_X, COMBAT_TRAINER_Y, BLOOMVALE_MOSS_SAMPLES_QUEST_ID);
  await collectLootForQuest(pageA, MOSS_SPORE_ID, BLOOMVALE_MOSS_SAMPLES_QUEST_ID, BLOOMVALE_MOSS_SAMPLES_REQUIRED);
  await turnInQuestViaDialogue(
    pageA,
    COMBAT_TRAINER_ID,
    COMBAT_TRAINER_X,
    COMBAT_TRAINER_Y,
    BLOOMVALE_MOSS_SAMPLES_QUEST_ID,
    BLOOMVALE_MOSS_SAMPLES_REWARD_XP,
    BLOOMVALE_MOSS_SAMPLES_REWARD_GOLD,
  );
  await acceptQuestViaDialogue(pageA, HARBOR_WARDEN_ID, HARBOR_WARDEN_X, HARBOR_WARDEN_Y, LANTERNWAKE_QUEST_ID, "available");

  // Suncradle aggro behavior (card-bloomvale-revival).
  await verifyAggressiveMonsterBehavior(pageA, SLIME_AGGRO_MONSTER_ID);

  // Lanternwake handoff: the Warden sends the player down the lantern road; Mara
  // completes the talk objective and admits the Wakelight is dimming.
  await travelBloomvaleToLanternwake(pageA);
  await completeTalkQuestViaDialogue(pageA, LANTERNWAKE_QUEST_NPC_ID, LANTERNWAKE_QUEST_NPC_X, LANTERNWAKE_QUEST_NPC_Y, LANTERNWAKE_QUEST_ID);
  await turnInQuestViaDialogue(
    pageA,
    LANTERNWAKE_QUEST_NPC_ID,
    LANTERNWAKE_QUEST_NPC_X,
    LANTERNWAKE_QUEST_NPC_Y,
    LANTERNWAKE_QUEST_ID,
    LANTERNWAKE_QUEST_REWARD_XP,
    LANTERNWAKE_QUEST_REWARD_GOLD,
  );
  await pageA.waitForFunction(() => {
    const scene = (globalThis as { __GAME?: { scene?: { getScene?: (key: string) => unknown } } }).__GAME?.scene?.getScene?.("game") as
      | { room?: { state?: { players?: Map<string, { level?: number }> } }; localSessionId?: string }
      | undefined;
    const player = scene?.room?.state?.players?.get(scene.localSessionId ?? "");
    return (player?.level ?? 0) >= 2;
  }, null, { timeout: 20_000 });
  console.log("[smoke] Lanternwake: Mara turn-in raised the player to level 2.");
  await travelLanternwakeToBloomvale(pageA);

  if (consoleErrors.length > 0) {
    throw new Error(`console errors during test:\n${consoleErrors.join("\n")}`);
  }

  await saveScreenshotAndClose(harness);
  console.log("[smoke] ALL CHECKS PASSED.");
}

main().catch((err) => {
  console.error("[smoke] FATAL:", err);
  stopChildProcesses();
  process.exit(1);
});

import type { Page } from "@playwright/test";
import {
  AGGRESSIVE_MONSTER_ID,
  BLOOMVALE_MAP_ID,
  BLOOMVALE_DEWDROP_CULL_MONSTER_ID,
  BLOOMVALE_DEWDROP_CULL_MONSTER_XP,
  BLOOMVALE_DEWDROP_CULL_QUEST_ID,
  BLOOMVALE_DEWDROP_CULL_REQUIRED,
  BLOOMVALE_FIRST_HUNT_QUEST_ID,
  BLOOMVALE_FIRST_HUNT_REQUIRED,
  BLOOMVALE_PATROL_QUEST_ID,
  BLOOMVALE_PATROL_REQUIRED,
  BLOOMVALE_PATROL_MONSTER_ID,
  BLOOMVALE_PATROL_MONSTER_XP,
  FIELD_MAP_ID,
  FIELD_MONSTER_ID,
  FIELD_MONSTER_MIN_COUNT,
  FIELD_MONSTER_XP,
  FIELD_QUEST_ID,
  FIELD_QUEST_NPC_ID,
  FIELD_QUEST_NPC_X,
  FIELD_QUEST_NPC_Y,
  FIELD_QUEST_REQUIRED,
  SLIME_COMBAT_MONSTER_ID,
  SLIME_COMBAT_XP,
  TIMEOUT,
} from "./constants";
import { sendMoveIntent, sendSkillCastIntent, sendTargetSelectIntent } from "./intents";
import { moveLocalPlayerNear, stageInOpenField } from "./movement";
import {
  getRecentCombatEvents,
  getSmokeState,
  waitForMonsterCount,
  waitForMonsterKilledWithXp,
  waitForMonsterRespawn,
} from "./state";
import { acceptQuestViaDialogue, waitForQuestStatus } from "./quest";
import { useMinorHealthPotionFromHotbar } from "./item";
import type { JoinedSmokeState, MonsterTarget, SmokeBrowserGlobal } from "./types";

/**
 * Accept quest_dawncap_gathering at the Fernwatch ranger, then kill the
 * required Dawncap Shrooms (hp 58; ~5 spark-shot hits at level-1 matk) and
 * verify per-kill XP and quest readiness. Returns the first killed target so
 * the caller can run the respawn check against it.
 */
export async function acceptFieldQuestAndKill(pageA: Page, joinedA: JoinedSmokeState): Promise<MonsterTarget> {
  const active = await acceptQuestViaDialogue(pageA, FIELD_QUEST_NPC_ID, FIELD_QUEST_NPC_X, FIELD_QUEST_NPC_Y, FIELD_QUEST_ID);
  if (active.progress !== 0 || active.required !== FIELD_QUEST_REQUIRED) {
    throw new Error(`unexpected ${FIELD_QUEST_ID} accept state: ${JSON.stringify(active)}`);
  }
  console.log(`[smoke] Quest: accepted ${active.questId} at ${active.progress}/${active.required}.`);

  await waitForMonsterCount(pageA, FIELD_MONSTER_MIN_COUNT);
  const killed = new Set<string>();
  let firstKilled: MonsterTarget | null = null;
  while (killed.size < FIELD_QUEST_REQUIRED) {
    const state = await getSmokeState(pageA);
    const target = state?.monsters.find((monster) => (
      monster.mapId === FIELD_MAP_ID &&
      monster.monsterId.includes(FIELD_MONSTER_ID) &&
      monster.alive &&
      !killed.has(monster.monsterId)
    ));
    if (!target) throw new Error(`no alive ${FIELD_MONSTER_ID} available for quest; state=${JSON.stringify(state)}`);
    const playerBefore = state?.players.find((player) => player.sessionId === joinedA.localSessionId);
    if (!playerBefore) throw new Error(`missing local player before combat: ${JSON.stringify(state)}`);

    // Approach from the EAST (+180): the westmost shroom stands at (400,620)
    // and an approach from the west walks the player's foot into the
    // fernwatch -> harbor return portal at (180,700).
    await moveLocalPlayerNear(pageA, target.x + 180, target.y, 90);
    await sendTargetSelectIntent(pageA, target.monsterId);
    for (let i = 0; i < 14; i += 1) {
      const now = await getSmokeState(pageA);
      const monsterNow = now?.monsters.find((candidate) => candidate.monsterId === target.monsterId);
      const playerNow = now?.players.find((player) => player.sessionId === joinedA.localSessionId);
      if (monsterNow && !monsterNow.alive) break;
      // Shrooms wander up to ~86px around spawn; close back in if the gap
      // approaches spark shot's 330px range.
      if (monsterNow && playerNow && Math.hypot(playerNow.x - monsterNow.x, playerNow.y - monsterNow.y) > 280) {
        await sendMoveIntent(pageA, monsterNow.x + 150, monsterNow.y);
        await pageA.waitForTimeout(700);
      }
      await sendSkillCastIntent(pageA, target.monsterId);
      await pageA.waitForTimeout(1050);
    }

    const afterKill = await waitForMonsterKilledWithXp(pageA, target.monsterId, playerBefore.xp + FIELD_MONSTER_XP);
    const playerAfter = afterKill.players.find((player) => player.sessionId === joinedA.localSessionId);
    console.log(`[smoke] Combat: killed ${target.monsterId}; XP ${playerBefore.xp} -> ${playerAfter?.xp}.`);
    killed.add(target.monsterId);
    firstKilled ??= target;
  }

  const ready = await waitForQuestStatus(pageA, FIELD_QUEST_ID, "ready");
  if (ready.progress !== ready.required) {
    throw new Error(`${FIELD_QUEST_ID} did not reach required progress: ${JSON.stringify(ready)}`);
  }
  console.log(`[smoke] Combat: quest ${ready.progress}/${ready.required} ready to turn in.`);

  if (!firstKilled) throw new Error("no monster killed for the field quest");
  return firstKilled;
}

/**
 * Bloomvale combat (card-bloomvale-revival): approach a passive Meadow Slime,
 * spark it down, and verify the per-kill XP award. Returns the killed target so
 * the caller can run the respawn check against it. Passive slimes never chase,
 * so the loop just closes distance and re-casts until the target dies.
 */
export async function killOnePassiveSlime(pageA: Page, joinedA: JoinedSmokeState): Promise<MonsterTarget> {
  await waitForMonsterCount(pageA, 1);
  // Leave the boxed-in plaza for the open southern arena before engaging.
  await stageInOpenField(pageA);
  const state = await getSmokeState(pageA);
  const playerBefore = state?.players.find((player) => player.sessionId === joinedA.localSessionId);
  if (!playerBefore) throw new Error(`missing local player before combat: ${JSON.stringify(state)}`);
  // Pick the Meadow Slime nearest the STAGED position that sits in the open arena,
  // so the straight-line mover reaches it without wall-clipping a border band or a
  // vignette collider.
  const inArena = (m: MonsterTarget) => m.x >= 560 && m.x <= 1360 && m.y >= 960 && m.y <= 1500;
  const candidates = (state?.monsters ?? []).filter((monster) => (
    monster.mapId === BLOOMVALE_MAP_ID &&
    monster.monsterId.includes(SLIME_COMBAT_MONSTER_ID) &&
    monster.alive
  ));
  const target = candidates
    .filter(inArena)
    .sort((a, b) => Math.hypot(playerBefore.x - a.x, playerBefore.y - a.y) - Math.hypot(playerBefore.x - b.x, playerBefore.y - b.y))[0]
    ?? candidates
      .slice()
      .sort((a, b) => Math.hypot(playerBefore.x - a.x, playerBefore.y - a.y) - Math.hypot(playerBefore.x - b.x, playerBefore.y - b.y))[0];
  if (!target) throw new Error(`no alive ${SLIME_COMBAT_MONSTER_ID} available; state=${JSON.stringify(state)}`);

  // Spark Shot is now melee (range 120, card-z1-feel-tune). Stage 80px east ±20 so the
  // player casts from 60-100px — inside melee range, clear of the ~48px collision floor
  // (monster footprint halfWidth 34 + player halfWidth 14).
  await moveLocalPlayerNear(pageA, target.x + 80, target.y, 20);
  await sendTargetSelectIntent(pageA, target.monsterId);
  for (let i = 0; i < 16; i += 1) {
    const now = await getSmokeState(pageA);
    const monsterNow = now?.monsters.find((candidate) => candidate.monsterId === target.monsterId);
    const playerNow = now?.players.find((player) => player.sessionId === joinedA.localSessionId);
    if (monsterNow && !monsterNow.alive) break;
    if (monsterNow && playerNow && Math.hypot(playerNow.x - monsterNow.x, playerNow.y - monsterNow.y) > 120) {
      await sendMoveIntent(pageA, monsterNow.x + 80, monsterNow.y);
      await pageA.waitForTimeout(700);
    }
    await sendSkillCastIntent(pageA, target.monsterId);
    await pageA.waitForTimeout(1050);
  }

  const afterKill = await waitForMonsterKilledWithXp(pageA, target.monsterId, playerBefore.xp + SLIME_COMBAT_XP);
  const playerAfter = afterKill.players.find((player) => player.sessionId === joinedA.localSessionId);
  console.log(`[smoke] Combat: killed ${target.monsterId}; XP ${playerBefore.xp} -> ${playerAfter?.xp}.`);
  return target;
}

export async function verifyLanternBurstHitsSlime(pageA: Page): Promise<void> {
  await waitForMonsterCount(pageA, 1);
  await stageInOpenField(pageA);
  const state = await getSmokeState(pageA);
  const localPlayer = state?.players.find((player) => player.sessionId === state.localSessionId);
  if (!state?.localSessionId || !localPlayer) {
    throw new Error(`missing local player before lantern burst: ${JSON.stringify(state)}`);
  }
  const target = state.monsters
    .filter((monster) => monster.mapId === BLOOMVALE_MAP_ID && monster.alive)
    .sort((a, b) => Math.hypot(localPlayer.x - a.x, localPlayer.y - a.y) - Math.hypot(localPlayer.x - b.x, localPlayer.y - b.y))[0];
  if (!target) throw new Error(`no alive Bloomvale slime for lantern burst: ${JSON.stringify(state.monsters)}`);

  await moveLocalPlayerNear(pageA, target.x + 180, target.y, 40);
  const beforeHp = target.hp;
  await pageA.evaluate(({ x, y }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene.getScene("game");
    if (!scene?.room) throw new Error("game room unavailable");
    scene.room.send("intent", {
      type: "skill.cast",
      requestId: `smoke-lantern-burst-${Date.now()}`,
      skillId: "skill_lantern_burst",
      x,
      y,
    });
  }, { x: target.x, y: target.y });

  await pageA.waitForFunction(({ targetMonsterId, hpBefore }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const monster = scene?.room?.state?.monsters?.get(targetMonsterId);
    return Boolean(monster && monster.hp < hpBefore);
  }, { targetMonsterId: target.monsterId, hpBefore: beforeHp }, { timeout: TIMEOUT });
  const after = await getSmokeState(pageA);
  const hit = after?.monsters.find((monster) => monster.monsterId === target.monsterId);
  console.log(`[smoke] Combat: skill_lantern_burst hit ${target.monsterId}; HP ${beforeHp} -> ${hit?.hp}.`);
  await finishLanternTarget(pageA, target.monsterId);
}

export async function killSlimesForQuest(
  pageA: Page,
  joinedA: JoinedSmokeState,
  opts: {
    questId: string;
    requiredKills: number;
    monsterId: string;
    monsterXp: number;
  },
): Promise<MonsterTarget> {
  await waitForMonsterCount(pageA, 1);
  await stageInOpenField(pageA);

  let firstKilled: MonsterTarget | null = null;
  let completedKills = 0;
  let outerGuard = 0;
  while (completedKills < opts.requiredKills) {
    if (++outerGuard > 60) throw new Error(`${opts.questId} grind exceeded 60 engagement attempts at ${completedKills}/${opts.requiredKills}`);
    const state = await getSmokeState(pageA);
    const playerBefore = state?.players.find((player) => player.sessionId === joinedA.localSessionId);
    if (!playerBefore) throw new Error(`missing local player before ${opts.questId} combat: ${JSON.stringify(state)}`);

    const inQuestArena = (monster: MonsterTarget) => monster.x >= 560 && monster.x <= 1260 && monster.y >= 920 && monster.y <= 1500;
    const candidates = (state?.monsters ?? []).filter((monster) => (
      monster.mapId === BLOOMVALE_MAP_ID &&
      monster.monsterId.includes(opts.monsterId) &&
      // Skip Mega-affixed procs (card-lr2-combat-balance): a Mega carries ~4x
      // HP and outlasts the per-kill cast budget — it is a bonus elite, not
      // the quest chore, so the bot hunts ordinary slimes like a player would.
      !monster.monsterId.includes("-mega-") &&
      monster.alive &&
      inQuestArena(monster)
    ));
    // A pursuer actively targeting the bot outbleeds the grind (~10/hit lands
    // while the bot kites its QUEST target — e.g. a dew slime aggro-tagged by
    // the earlier lantern-burst AREA check chases across the map). Kill the
    // pursuer first, like a player would, then resume the quest chore.
    // The honey slime is the owner-ruled AGGRESSIVE ELITE (130hp / 13 atk,
    // 8-10 hit band) patrolling inside the quest arena — a low-level bot
    // cannot trade with it, and engaging anything else while it chases is a
    // livelock (the mid-kill attacker bail fires forever). Shed it FIRST:
    // retreat west until the drag exceeds its 640 leash and it resets home.
    const eliteChaser = (state?.monsters ?? []).find((monster) =>
      monster.mapId === BLOOMVALE_MAP_ID &&
      monster.alive &&
      monster.monsterId.includes("monster_honey_slime") &&
      monster.targetId === joinedA.localSessionId);
    if (eliteChaser) {
      console.log(`[smoke] Quest grind: shedding elite pursuer ${eliteChaser.monsterId}.`);
      await sendMoveIntent(pageA, 580, 840);
      for (let shedPoll = 0; shedPoll < 14; shedPoll += 1) {
        await pageA.waitForTimeout(700);
        const shedState = await getSmokeState(pageA);
        const stillChasing = shedState?.monsters.some((monster) =>
          monster.monsterId === eliteChaser.monsterId && monster.alive && monster.targetId === joinedA.localSessionId);
        if (!stillChasing) break;
        if (shedPoll === 6) await sendMoveIntent(pageA, 480, 760);
      }
      continue;
    }
    const pursuer = (state?.monsters ?? []).find((monster) =>
      monster.mapId === BLOOMVALE_MAP_ID &&
      monster.alive &&
      monster.targetId === joinedA.localSessionId &&
      Math.hypot(playerBefore.x - monster.x, playerBefore.y - monster.y) <= 160);
    const eliteThreat = (monster: MonsterTarget) => (state?.monsters ?? []).some((candidate) =>
      candidate.mapId === BLOOMVALE_MAP_ID &&
      candidate.alive &&
      candidate.monsterId.includes("monster_honey_slime") &&
      Math.hypot(monster.x - candidate.x, monster.y - candidate.y) <= 320);
    const safeCandidates = candidates.filter((candidate) => !eliteThreat(candidate));
    const target = pursuer ?? (safeCandidates.length > 0 ? safeCandidates : candidates)
      .slice()
      .sort((a, b) => Math.hypot(playerBefore.x - a.x, playerBefore.y - a.y) - Math.hypot(playerBefore.x - b.x, playerBefore.y - b.y))[0];
    if (!target) {
      await pageA.waitForTimeout(1_000);
      continue;
    }
    if (pursuer) console.log(`[smoke] Quest grind: clearing pursuer ${pursuer.monsterId} first.`);

    const approachX = getApproachX(target.x, playerBefore.x);
    await moveLocalPlayerNear(pageA, approachX, target.y, 24);
    await sendTargetSelectIntent(pageA, target.monsterId);
    let bailedToPursuer = false;
    for (let i = 0; i < 20; i += 1) {
      const now = await getSmokeState(pageA);
      const monsterNow = now?.monsters.find((candidate) => candidate.monsterId === target.monsterId);
      const playerNow = now?.players.find((player) => player.sessionId === joinedA.localSessionId);
      if (monsterNow && !monsterNow.alive) break;
      // The ELITE arriving mid-kill forces a re-evaluation (the outer loop
      // sheds it). Normal chasers do NOT bail — with two chasers a bail
      // livelocks (engage A, B arrives, bail, engage A, ...); instead the
      // retreat below steers away from ALL active threats while the current
      // target dies.
      const eliteArrived = playerNow ? (now?.monsters ?? []).some((monster) =>
        monster.mapId === BLOOMVALE_MAP_ID &&
        monster.alive &&
        monster.monsterId.includes("monster_honey_slime") &&
        monster.targetId === joinedA.localSessionId) : false;
      if (eliteArrived) {
        console.log(`[smoke] Quest grind: elite arrived mid-kill; re-evaluating.`);
        bailedToPursuer = true;
        break;
      }
      if (monsterNow && playerNow && Math.hypot(playerNow.x - monsterNow.x, playerNow.y - monsterNow.y) > 145) {
        await sendMoveIntent(pageA, getApproachX(monsterNow.x, playerNow.x), monsterNow.y);
        await pageA.waitForTimeout(600);
      }
      // MP breather: Spark Shot costs 2; casting while dry just whiffs
      // NO_RESOURCE and burns the cast budget.
      if (playerNow && playerNow.mp < 4) await pageA.waitForTimeout(2_000);
      await sendSkillCastIntent(pageA, target.monsterId);
      // The cast sets a 500ms movement lock (StageRoom/WorldRoom erase move
      // targets every tick while locked); retreat only after it expires.
      await pageA.waitForTimeout(600);
      // Hit-and-run (card-lr2-combat-balance): owner-ruled slime damage
      // (~9-11/hit inside the 82px contact range, pursuit speed 24-34) kills a
      // stationary bot mid-grind — and a death leash-heals the target, respawns
      // it alive, and docks XP (death penalty), breaking the kill-wait below.
      // Step back out after every cast; Spark Shot reaches 150 so the kill
      // keeps progressing from spacing the slime can never close.
      const afterCast = await getSmokeState(pageA);
      const monsterAfter = afterCast?.monsters.find((candidate) => candidate.monsterId === target.monsterId);
      const playerAfter = afterCast?.players.find((player) => player.sessionId === joinedA.localSessionId);
      if (monsterAfter?.alive && playerAfter) {
        // Retreat away from the CENTROID of every active threat (the target
        // plus any other slime chasing the bot) so a second chaser cannot pin
        // the bot while it kites the first.
        const threats = [
          monsterAfter,
          ...(afterCast?.monsters ?? []).filter((monster) =>
            monster.mapId === BLOOMVALE_MAP_ID &&
            monster.alive &&
            monster.targetId === joinedA.localSessionId &&
            monster.monsterId !== target.monsterId &&
            Math.hypot(playerAfter.x - monster.x, playerAfter.y - monster.y) <= 220),
        ];
        const cx = threats.reduce((sum, threat) => sum + threat.x, 0) / threats.length;
        const cy = threats.reduce((sum, threat) => sum + threat.y, 0) / threats.length;
        const away = Math.atan2(playerAfter.y - cy, (playerAfter.x - cx) || 0.001);
        await sendMoveIntent(
          pageA,
          playerAfter.x + Math.cos(away) * 130,
          playerAfter.y + Math.sin(away) * 130,
        );
        await pageA.waitForTimeout(450);
      }
    }

    if (bailedToPursuer) continue;
    // A pursuer kill is off-species: expect any XP gain (>= +1) rather than
    // the quest monster's award.
    const expectedXp = playerBefore.xp + (pursuer ? 1 : opts.monsterXp);
    // On timeout, log the decisive state (dead-or-alive, hp, xp) — kill-wait
    // failures are otherwise opaque (the classic signature of a mid-grind bot
    // death: target leash-healed alive, xp docked by the death penalty).
    const afterKill = await waitForMonsterKilledWithXp(pageA, target.monsterId, expectedXp).catch(async (err) => {
      const state2 = await getSmokeState(pageA);
      const monsterNow = state2?.monsters.find((candidate) => candidate.monsterId === target.monsterId);
      const playerNow = state2?.players.find((player) => player.sessionId === joinedA.localSessionId);
      console.error(`[smoke] kill-wait timeout: target=${target.monsterId} alive=${monsterNow?.alive} hp=${monsterNow?.hp} playerXp=${playerNow?.xp} expected>=${expectedXp} playerHp=${playerNow?.hp} playerPos=(${Math.round(playerNow?.x ?? -1)},${Math.round(playerNow?.y ?? -1)})`);
      throw err;
    });
    if (pursuer) continue;
    const quest = afterKill.players
      .find((player) => player.sessionId === joinedA.localSessionId)
      ?.quests.find((candidate) => candidate.questId === opts.questId);
    completedKills = quest?.progress ?? completedKills + 1;
    firstKilled ??= target;
    console.log(`[smoke] Quest: ${opts.questId} progress ${completedKills}/${opts.requiredKills} after ${target.monsterId}.`);
  }

  const ready = await waitForQuestStatus(pageA, opts.questId, "ready");
  if (ready.progress !== ready.required) {
    throw new Error(`${opts.questId} did not reach required progress: ${JSON.stringify(ready)}`);
  }
  console.log(`[smoke] Quest: ${ready.questId} ready at ${ready.progress}/${ready.required}.`);

  if (!firstKilled) throw new Error(`no ${opts.monsterId} killed for ${opts.questId}`);
  return firstKilled;
}

function getApproachX(monsterX: number, playerX: number): number {
  // 125px: outside every slime's 82px contact range, inside Spark Shot's 150px
  // cast range. Staging at the old 80px parked the bot INSIDE contact range,
  // which the owner-ruled damage (card-lr2-combat-balance, ~9-11/hit) turns
  // from chip damage into a mid-grind death.
  return monsterX >= playerX ? monsterX - 125 : monsterX + 125;
}

export async function completeBloomvaleFirstHuntKills(pageA: Page, joinedA: JoinedSmokeState): Promise<MonsterTarget> {
  return killSlimesForQuest(pageA, joinedA, {
    questId: BLOOMVALE_FIRST_HUNT_QUEST_ID,
    requiredKills: BLOOMVALE_FIRST_HUNT_REQUIRED,
    monsterId: SLIME_COMBAT_MONSTER_ID,
    monsterXp: SLIME_COMBAT_XP,
  });
}

export async function completeBloomvaleDewdropKills(pageA: Page, joinedA: JoinedSmokeState): Promise<MonsterTarget> {
  return killSlimesForQuest(pageA, joinedA, {
    questId: BLOOMVALE_DEWDROP_CULL_QUEST_ID,
    requiredKills: BLOOMVALE_DEWDROP_CULL_REQUIRED,
    monsterId: BLOOMVALE_DEWDROP_CULL_MONSTER_ID,
    monsterXp: BLOOMVALE_DEWDROP_CULL_MONSTER_XP,
  });
}

export async function completeBloomvalePatrolKills(pageA: Page, joinedA: JoinedSmokeState): Promise<MonsterTarget> {
  return killSlimesForQuest(pageA, joinedA, {
    questId: BLOOMVALE_PATROL_QUEST_ID,
    requiredKills: BLOOMVALE_PATROL_REQUIRED,
    monsterId: BLOOMVALE_PATROL_MONSTER_ID,
    monsterXp: BLOOMVALE_PATROL_MONSTER_XP,
  });
}

export async function verifyMonsterRespawn(pageA: Page, monsterId: string): Promise<void> {
  await waitForMonsterRespawn(pageA, monsterId);
  console.log(`[smoke] Combat: ${monsterId} respawned.`);
}

async function finishLanternTarget(pageA: Page, monsterId: string): Promise<void> {
  await sendTargetSelectIntent(pageA, monsterId);
  // 12 casts: the owner-ruled slimes (card-lr2-combat-balance) take ~5-6 hits
  // plus the occasional miss; the old 8 was tuned for 2-hit slimes.
  for (let i = 0; i < 12; i += 1) {
    const state = await getSmokeState(pageA);
    const monster = state?.monsters.find((candidate) => candidate.monsterId === monsterId);
    const player = state?.players.find((candidate) => candidate.sessionId === state.localSessionId);
    if (monster && !monster.alive) break;
    if (monster && player && Math.hypot(player.x - monster.x, player.y - monster.y) > 145) {
      // Stage at 125px: outside the slime's 82px contact range, inside Spark
      // Shot's 150px cast range (the old +80 parked the bot in melee, where
      // owner-ruled damage kills it mid-cleanup).
      await sendMoveIntent(pageA, monster.x + 125, monster.y);
      await pageA.waitForTimeout(600);
    }
    await sendSkillCastIntent(pageA, monsterId);
    // Cast lock is 500ms; retreat after it expires (hit-and-run, same as the
    // quest grind) so the pursuing slime never lands contact hits.
    await pageA.waitForTimeout(600);
    const afterCast = await getSmokeState(pageA);
    const monsterAfter = afterCast?.monsters.find((candidate) => candidate.monsterId === monsterId);
    const playerAfter = afterCast?.players.find((candidate) => candidate.sessionId === afterCast.localSessionId);
    if (monsterAfter?.alive && playerAfter) {
      const away = Math.atan2(playerAfter.y - monsterAfter.y, (playerAfter.x - monsterAfter.x) || 0.001);
      await sendMoveIntent(
        pageA,
        monsterAfter.x + Math.cos(away) * 145,
        monsterAfter.y + Math.sin(away) * 145,
      );
      await pageA.waitForTimeout(450);
    }
  }
  try {
    await pageA.waitForFunction((targetMonsterId) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
      const monster = scene?.room?.state?.monsters?.get(targetMonsterId);
      return monster?.alive === false;
    }, monsterId, { timeout: TIMEOUT });
  } catch (err) {
    const state = await getSmokeState(pageA);
    const combatEvents = await getRecentCombatEvents(pageA);
    throw new Error(`monster ${monsterId} did not die during lantern-burst cleanup; state=${JSON.stringify(state)} combat=${JSON.stringify(combatEvents)}`, { cause: err });
  }
}

/**
 * Report which map currently hosts the alive Mire Biter copies. Because of the
 * monster-ID collision (see constants.ts), only one of harbor/fernwatch has
 * them at runtime; the caller decides the aggro-check ordering from this.
 */
export async function getAliveAggressiveMonsterMapId(pageA: Page): Promise<string | null> {
  const state = await getSmokeState(pageA);
  const alive = state?.monsters.find((monster) => monster.monsterId.includes(AGGRESSIVE_MONSTER_ID) && monster.alive);
  return alive?.mapId ?? null;
}

/**
 * Aggressive-monster check against an aggressive species on the player's CURRENT
 * map (Bloomvale Honey Slime by default; the parked Mire Biter path passes its own
 * id): approach, take a hit, potion up, then outrun the leash and verify the reset.
 * The leash origin is read from the selected monster's live spawn position, so it
 * works for hash-placed slime fields with no fixed spawn coordinate.
 */
export async function verifyAggressiveMonsterBehavior(pageA: Page, aggressiveMonsterId: string = AGGRESSIVE_MONSTER_ID): Promise<void> {
  const state = await getSmokeState(pageA);
  const localPlayer = state?.players.find((player) => player.sessionId === state.localSessionId);
  if (!state?.localSessionId || !localPlayer) {
    throw new Error(`missing aggressive-check setup: ${JSON.stringify(state)}`);
  }
  const aggressiveCandidates = state.monsters
    .filter((monster) => monster.monsterId.includes(aggressiveMonsterId) && monster.alive && monster.mapId === localPlayer.mapId);
  const target = (aggressiveCandidates.some((monster) => monster.y >= localPlayer.y) ? aggressiveCandidates.filter((monster) => monster.y >= localPlayer.y) : aggressiveCandidates)
    .sort((a, b) => (
      Math.hypot(localPlayer.x - a.x, localPlayer.y - a.y) - Math.hypot(localPlayer.x - b.x, localPlayer.y - b.y)
    ))[0];
  if (!target) {
    throw new Error(`no alive ${aggressiveMonsterId} on ${localPlayer.mapId}: ${JSON.stringify(state?.monsters)}`);
  }
  const localSessionId = state.localSessionId;

  // Placement spawns can be randomized inside the authored zone; use the
  // selected monster's live starting position as the leash reset origin.
  const spawnX = target.x;
  const spawnY = target.y;
  const hpBefore = localPlayer.hp;
  await pageA.evaluate(() => {
    (globalThis as SmokeBrowserGlobal).__SMOKE_AGGRO_HIT__ = null;
  });
  // Close to within the Honey Slime's sightRange (110) from the west so it aggros;
  // 80px offset + 26px tolerance keeps arrival at 54-106px — inside sight, outside
  // the footprint overlap.
  await moveLocalPlayerNear(pageA, target.x - 80, target.y, 26);

  try {
    await pageA.waitForFunction(({ targetMonsterId, expectedTargetId, beforeHp }) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
      const player = scene?.room?.state?.players?.get(scene.localSessionId);
      const monster = scene?.room?.state?.monsters?.get(targetMonsterId);
      if (monster?.targetId === expectedTargetId && player?.hp < beforeHp) {
        (globalThis as SmokeBrowserGlobal).__SMOKE_AGGRO_HIT__ = {
          monsterId: targetMonsterId,
          hp: player.hp,
        };
      }
      return Boolean((globalThis as SmokeBrowserGlobal).__SMOKE_AGGRO_HIT__);
    }, { targetMonsterId: target.monsterId, expectedTargetId: localSessionId, beforeHp: hpBefore }, { timeout: 12_000 });
  } catch (err) {
    const debugState = await getSmokeState(pageA);
    const combatEvents = await getRecentCombatEvents(pageA);
    throw new Error(`${aggressiveMonsterId} did not aggro/damage in time; state=${JSON.stringify(debugState)} combat=${JSON.stringify(combatEvents)}`, { cause: err });
  }

  const aggroState = await getSmokeState(pageA);
  const hit = await pageA.evaluate(() => (globalThis as SmokeBrowserGlobal).__SMOKE_AGGRO_HIT__ as { hp: number } | null);
  if (!hit || hit.hp >= hpBefore) {
    const combatEvents = await getRecentCombatEvents(pageA);
    throw new Error(`${aggressiveMonsterId} did not damage player: before=${hpBefore}, state=${JSON.stringify(aggroState)} combat=${JSON.stringify(combatEvents)}`);
  }

  await useMinorHealthPotionFromHotbar(pageA);
  // Retreat back west into the open southern arena (the Honey Slime aggro target is
  // the anchored field at (1200,1200), so the player is always east of open ground).
  // Both hops stay on obstacle-free terrain and end >leashRange (240) from the spawn,
  // so the leash reset fires reliably without wall-clipping a vignette collider.
  await moveLocalPlayerNear(pageA, 900, 1120, 90, 12_000);
  await moveLocalPlayerNear(pageA, 700, 1080, 80, 20_000);
  try {
    await pageA.waitForFunction(({ targetMonsterId, originX, originY }) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
      const found = scene?.room?.state?.monsters?.get(targetMonsterId);
      return (
        found &&
        found.alive &&
        !found.targetId &&
        found.hp === found.maxHp &&
        Math.hypot(found.x - originX, found.y - originY) <= 8
      );
    }, { targetMonsterId: target.monsterId, originX: spawnX, originY: spawnY }, { timeout: 15_000 });
  } catch (err) {
    const debugState = await getSmokeState(pageA);
    const combatEvents = await getRecentCombatEvents(pageA);
    throw new Error(`${aggressiveMonsterId} did not leash/reset after retreat; state=${JSON.stringify(debugState)} combat=${JSON.stringify(combatEvents)}`, { cause: err });
  }

  const leashedState = await getSmokeState(pageA);
  const leashed = leashedState?.monsters.find((monster) => monster.monsterId === target.monsterId);
  console.log(
    `[smoke] Aggressive monster: ${target.monsterId} on ${localPlayer.mapId} hit HP ${hpBefore} -> ${hit.hp}, then leashed to (${leashed?.x}, ${leashed?.y}).`,
  );
}

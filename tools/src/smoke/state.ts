import type { Page } from "@playwright/test";
import { TIMEOUT } from "./constants";
import type { JoinedSmokeState, SmokeBrowserGlobal, SmokeState } from "./types";

export async function getSmokeState(page: Page): Promise<SmokeState | null> {
  return page.evaluate(() => {
    const game = (globalThis as SmokeBrowserGlobal).__GAME;
    if (!game) return null;
    const scene = game.scene.getScene("game");
    if (!scene) return null;
    const visualQa = (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__?.getVisualQaSnapshot?.();
    const cam = scene.cameras?.main;
    const players: SmokeState["players"] = [];
    const monsters: SmokeState["monsters"] = [];
    const loot: SmokeState["loot"] = [];
    const npcs: SmokeState["npcs"] = [];
    const chests: SmokeState["chests"] = [];
    const parties: SmokeState["parties"] = [];
    scene.room?.state?.players?.forEach((player, sessionId) => {
      const inventory: Array<{ itemId: string; quantity: number }> = [];
      const quests: Array<{ questId: string; status: string; progress: number; required: number; rewardXp: number; rewardGold: number }> = [];
      const allocatedAttributes: Record<string, number> = {};
      player.inventory?.forEach((item) => {
        inventory.push({ itemId: item.itemId, quantity: item.quantity });
      });
      player.allocatedAttributes?.forEach((value, attribute) => {
        allocatedAttributes[attribute] = value;
      });
      player.quests?.forEach((quest) => {
        quests.push({
          questId: quest.questId,
          status: quest.status,
          progress: quest.progress,
          required: quest.required,
          rewardXp: quest.rewardXp,
          rewardGold: quest.rewardGold,
        });
      });
      players.push({
        sessionId,
        mapId: player.mapId,
        x: Math.round(player.x),
        y: Math.round(player.y),
        hp: player.hp,
        maxHp: player.maxHp,
        mp: player.mp,
        maxMp: player.maxMp,
        xp: player.xp,
        level: player.level,
        classId: player.classId,
        jobXp: player.jobXp,
        jobLevel: player.jobLevel,
        skillPoints: player.skillPoints,
        attributePoints: player.attributePoints,
        allocatedAttributes,
        selectedTargetId: player.selectedTargetId,
        inventory,
        quests,
      });
    });
    scene.room?.state?.monsters?.forEach((monster, monsterId) => {
      monsters.push({
        monsterId,
        mapId: monster.mapId,
        x: Math.round(monster.x),
        y: Math.round(monster.y),
        hp: monster.hp,
        maxHp: monster.maxHp,
        alive: monster.alive,
        targetId: monster.targetId,
      });
    });
    scene.room?.state?.loot?.forEach((drop, lootId) => {
      loot.push({
        lootId,
        itemId: drop.itemId,
        quantity: drop.quantity,
        mapId: drop.mapId,
        x: Math.round(drop.x),
        y: Math.round(drop.y),
      });
    });
    scene.room?.state?.npcs?.forEach((npc, npcId) => {
      const shopItems: Array<{ itemId: string; buyPrice: number; sellPrice: number }> = [];
      npc.shopItems?.forEach((shopItem) => {
        shopItems.push({ itemId: shopItem.itemId, buyPrice: shopItem.buyPrice, sellPrice: shopItem.sellPrice });
      });
      npcs.push({
        npcId,
        mapId: npc.mapId,
        x: Math.round(npc.x),
        y: Math.round(npc.y),
        questId: npc.questId,
        questMarkerState: visualQa?.npcs?.find((entry) => entry.id === npcId)?.questMarkerState,
        shopItems,
      });
    });
    scene.room?.state?.chests?.forEach((chest, chestId) => {
      chests.push({
        chestId,
        mapId: chest.mapId,
        x: Math.round(chest.x),
        y: Math.round(chest.y),
        radius: chest.radius,
        opened: chest.opened,
      });
    });
    scene.room?.state?.parties?.forEach((party, partyId) => {
      parties.push({
        partyId,
        leaderId: party.leaderId,
        memberIds: [...party.memberIds],
      });
    });

    return {
      sceneKey: scene.scene.key as string,
      isActive: scene.scene.isActive() as boolean,
      childCount: (scene.children?.list?.length ?? 0) as number,
      statusText: (scene.statusText?.text ?? null) as string | null,
      hasRoom: Boolean(scene.room),
      localSessionId: (scene.localSessionId ?? null) as string | null,
      players,
      monsters,
      loot,
      npcs,
      chests,
      parties,
      renderedCount: (visualQa?.players?.filter((player) => player.visible).length ?? scene.playerObjects?.size ?? 0) as number,
      renderedMonsterCount: (visualQa?.monsters?.filter((monster) => monster.visible).length ?? scene.monsterObjects?.size ?? 0) as number,
      renderedLootCount: (scene.lootObjects?.size ?? 0) as number,
      camera: visualQa?.camera
        ? {
            scrollX: Math.round(visualQa.camera.scrollX),
            scrollY: Math.round(visualQa.camera.scrollY),
            zoom: visualQa.camera.zoom,
          }
        : cam
          ? { scrollX: Math.round(cam.scrollX), scrollY: Math.round(cam.scrollY), zoom: cam.zoom }
          : null,
      fps: (game.loop?.actualFps ?? 0) as number,
    };
  });
}

export async function waitForJoined(page: Page): Promise<JoinedSmokeState> {
  try {
    await page.waitForFunction(() => {
      const game = (globalThis as SmokeBrowserGlobal).__GAME;
      const scene = game?.scene?.getScene?.("game");
      let playerCount = 0;
      scene?.room?.state?.players?.forEach(() => {
        playerCount += 1;
      });
      return scene?.scene?.isActive() && scene?.localSessionId && playerCount >= 1;
    }, null, { timeout: TIMEOUT });
  } catch (err) {
    const state = await getSmokeState(page);
    throw new Error(`timed out waiting for Colyseus join; state=${JSON.stringify(state)}`, { cause: err });
  }

  const state = await getSmokeState(page);
  if (!state?.localSessionId) throw new Error("game state missing after join");
  await installCombatTrace(page);
  return state as JoinedSmokeState;
}

export async function getRecentCombatEvents(page: Page): Promise<unknown[]> {
  return page.evaluate(() => ((globalThis as SmokeBrowserGlobal).__SMOKE_COMBAT_EVENTS__ ?? []).slice(-12));
}

async function installCombatTrace(page: Page): Promise<void> {
  await page.evaluate(() => {
    const global = globalThis as SmokeBrowserGlobal;
    const scene = global.__GAME?.scene?.getScene?.("game");
    const room = scene?.room;
    if (!room || global.__SMOKE_COMBAT_TRACE_INSTALLED__) return;
    global.__SMOKE_COMBAT_TRACE_INSTALLED__ = true;
    global.__SMOKE_COMBAT_EVENTS__ = [];
    room.onMessage("combat", (event) => {
      const trace = global.__SMOKE_COMBAT_EVENTS__;
      if (!trace) return;
      trace.push({
        type: event?.type,
        skillId: event?.skillId,
        sourceId: event?.sourceId,
        targetId: event?.targetId,
        amount: event?.amount,
        killed: event?.killed,
        effect: event?.effect,
        x: event?.x,
        y: event?.y,
        serverTimeMs: event?.serverTimeMs,
      });
      if (trace.length > 40) trace.shift();
    });
  });
}

export async function waitForPlayerCount(page: Page, count: number, timeoutMs = TIMEOUT): Promise<SmokeState> {
  try {
    await page.waitForFunction((expectedCount) => {
      const game = (globalThis as SmokeBrowserGlobal).__GAME;
      const scene = game?.scene?.getScene?.("game");
      let playerCount = 0;
      scene?.room?.state?.players?.forEach(() => {
        playerCount += 1;
      });
      return playerCount === expectedCount && scene?.playerObjects?.size === expectedCount;
    }, count, { timeout: timeoutMs });
  } catch (err) {
    const state = await getSmokeState(page);
    throw new Error(`timed out waiting for exactly ${count} synced/rendered player(s); state=${JSON.stringify(state)}`, {
      cause: err,
    });
  }

  const state = await getSmokeState(page);
  if (!state) throw new Error("game state missing while waiting for players");
  return state;
}

export async function waitForRenderedCount(page: Page, count: number): Promise<SmokeState> {
  try {
    await page.waitForFunction((expectedCount) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
      return scene?.playerObjects?.size === expectedCount;
    }, count, { timeout: TIMEOUT });
  } catch (err) {
    const state = await getSmokeState(page);
    throw new Error(`timed out waiting for ${count} rendered player(s); state=${JSON.stringify(state)}`, { cause: err });
  }

  const state = await getSmokeState(page);
  if (!state) throw new Error("game state missing while waiting for rendered count");
  return state;
}

export async function waitForMonsterCount(page: Page, count: number): Promise<SmokeState> {
  await page.waitForFunction((expectedCount) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    return scene?.monsterObjects?.size >= expectedCount;
  }, count, { timeout: TIMEOUT });

  const state = await getSmokeState(page);
  if (!state) throw new Error("game state missing while waiting for monsters");
  return state;
}

export async function waitForMonsterKilledWithXp(page: Page, monsterId: string, minXp: number): Promise<SmokeState> {
  await page.waitForFunction(({ targetId, expectedXp }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const monster = scene?.room?.state?.monsters?.get(targetId);
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    return monster?.alive === false && player?.xp >= expectedXp;
  }, { targetId: monsterId, expectedXp: minXp }, { timeout: TIMEOUT });

  const state = await getSmokeState(page);
  if (!state) throw new Error("game state missing after monster kill");
  return state;
}

export async function waitForMonsterRespawn(page: Page, monsterId: string): Promise<SmokeState> {
  await page.waitForFunction((targetId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const monster = scene?.room?.state?.monsters?.get(targetId);
    return monster?.alive === true && scene?.monsterObjects?.has(targetId);
  }, monsterId, { timeout: 12_000 });

  const state = await getSmokeState(page);
  if (!state) throw new Error("game state missing after monster respawn");
  return state;
}

export async function waitForLootDrop(page: Page, itemId: string): Promise<{ lootId: string; itemId: string; quantity: number; x: number; y: number }> {
  await page.waitForFunction((wantedItemId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    let found = false;
    scene?.room?.state?.loot?.forEach((loot) => {
      if (loot.itemId === wantedItemId && loot.mapId === player?.mapId && loot.quantity > 0) {
        found = true;
      }
    });
    return found && (scene?.lootObjects?.size ?? 0) > 0;
  }, itemId, { timeout: TIMEOUT });

  const state = await getSmokeState(page);
  const drop = state?.loot.find((candidate) => candidate.itemId === itemId);
  if (!drop) throw new Error(`loot state missing after drop: ${JSON.stringify(state)}`);
  return { lootId: drop.lootId, itemId: drop.itemId, quantity: drop.quantity, x: drop.x, y: drop.y };
}

export async function waitForInventoryItem(page: Page, itemId: string): Promise<number> {
  await page.waitForFunction((wantedItemId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    const item = player?.inventory?.get(wantedItemId);
    return item?.quantity > 0;
  }, itemId, { timeout: TIMEOUT });

  const state = await getSmokeState(page);
  const localPlayer = state?.players.find((player) => player.sessionId === state.localSessionId);
  const item = localPlayer?.inventory.find((candidate) => candidate.itemId === itemId);
  if (!item) throw new Error(`inventory item missing after pickup: ${JSON.stringify(state)}`);
  return item.quantity;
}

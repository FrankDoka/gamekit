import type { Page } from "@playwright/test";
import type { SmokeBrowserGlobal } from "./types";

export async function getGroundClickPoint(
  page: Page,
  offsetX: number,
  offsetY: number,
): Promise<{ screenX: number; screenY: number }> {
  return page.evaluate(({ dx, dy }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene.getScene("game");
    if (!scene?.cameras?.main) throw new Error("game scene unavailable");
    const camera = scene.cameras.main;
    const canvasRect = scene.game.canvas.getBoundingClientRect();
    const viewWidth = Number(scene.scale.width ?? scene.game.config.width);
    const viewHeight = Number(scene.scale.height ?? scene.game.config.height);
    const scaleX = canvasRect.width / viewWidth;
    const scaleY = canvasRect.height / viewHeight;
    const player = scene.room.state.players.get(scene.localSessionId);
    return {
      screenX: canvasRect.left + (player.x + dx - camera.worldView.x) * camera.zoom * scaleX,
      screenY: canvasRect.top + (player.y + dy - camera.worldView.y) * camera.zoom * scaleY,
    };
  }, { dx: offsetX, dy: offsetY });
}

export async function getGroundDragPoints(
  page: Page,
): Promise<{ startX: number; startY: number; endX: number; endY: number }> {
  return page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene.getScene("game");
    if (!scene?.cameras?.main) throw new Error("game scene unavailable");
    const camera = scene.cameras.main;
    const canvasRect = scene.game.canvas.getBoundingClientRect();
    const viewWidth = Number(scene.scale.width ?? scene.game.config.width);
    const viewHeight = Number(scene.scale.height ?? scene.game.config.height);
    const scaleX = canvasRect.width / viewWidth;
    const scaleY = canvasRect.height / viewHeight;
    const player = scene.room.state.players.get(scene.localSessionId);
    const map = scene.getCurrentMap();
    const targetX = Math.min(map.size.width, player.x + 180);
    const targetY = Math.min(map.size.height, player.y + 90);
    return {
      startX: canvasRect.left + (player.x - camera.worldView.x) * camera.zoom * scaleX,
      startY: canvasRect.top + (player.y - camera.worldView.y) * camera.zoom * scaleY,
      endX: canvasRect.left + (targetX - camera.worldView.x) * camera.zoom * scaleX,
      endY: canvasRect.top + (targetY - camera.worldView.y) * camera.zoom * scaleY,
    };
  });
}

export async function getVisibleMonsterClickTargets(
  page: Page,
): Promise<Array<{ monsterId: string; screenX: number; screenY: number }>> {
  return page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene.getScene("game");
    if (!scene?.cameras?.main) throw new Error("game scene unavailable");
    const camera = scene.cameras.main;
    const canvasRect = scene.game.canvas.getBoundingClientRect();
    const viewWidth = Number(scene.scale.width ?? scene.game.config.width);
    const viewHeight = Number(scene.scale.height ?? scene.game.config.height);
    const scaleX = canvasRect.width / viewWidth;
    const scaleY = canvasRect.height / viewHeight;
    const localPlayer = scene.room.state.players.get(scene.localSessionId);
    const targets: Array<{ monsterId: string; screenX: number; screenY: number }> = [];
    scene.room.state.monsters.forEach((monster, monsterId) => {
      const render = scene.monsterObjects.get(monsterId);
      if (!monster.alive || monster.mapId !== localPlayer.mapId || !render?.container.visible) return;
      const viewX = (monster.x - camera.worldView.x) * camera.zoom;
      const viewY = (monster.y - camera.worldView.y) * camera.zoom;
      if (viewX < 0 || viewX > viewWidth || viewY < 0 || viewY > viewHeight) return;
      const screenX = canvasRect.left + viewX * scaleX;
      const screenY = canvasRect.top + viewY * scaleY;
      targets.push({ monsterId, screenX, screenY });
    });
    return targets.slice(0, 4);
  });
}

export async function getVisibleNpcClickTarget(
  page: Page,
  npcId: string,
): Promise<{ npcId: string; screenX: number; screenY: number }> {
  return page.evaluate((wantedNpcId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene.getScene("game");
    if (!scene?.cameras?.main) throw new Error("game scene unavailable");
    const camera = scene.cameras.main;
    const canvasRect = scene.game.canvas.getBoundingClientRect();
    const viewWidth = Number(scene.scale.width ?? scene.game.config.width);
    const viewHeight = Number(scene.scale.height ?? scene.game.config.height);
    const scaleX = canvasRect.width / viewWidth;
    const scaleY = canvasRect.height / viewHeight;
    const npc = scene.room.state.npcs.get(wantedNpcId);
    const render = scene.npcObjects.get(wantedNpcId);
    if (!npc || !render?.container.visible) {
      throw new Error(`npc ${wantedNpcId} is not visible`);
    }
    const hitRect = render.hitRect;
    const localX = hitRect.x + hitRect.width / 2;
    const localY = hitRect.y + hitRect.height * 0.25;
    const worldX = render.container.x + localX;
    const worldY = render.container.y + localY;
    const screenX = canvasRect.left + (worldX - camera.worldView.x) * camera.zoom * scaleX;
    const screenY = canvasRect.top + (worldY - camera.worldView.y) * camera.zoom * scaleY;
    return { npcId: wantedNpcId, screenX, screenY };
  }, npcId);
}

export async function getVisibleLootClickTarget(
  page: Page,
  lootId: string,
): Promise<{ lootId: string; screenX: number; screenY: number }> {
  return page.evaluate((wantedLootId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene.getScene("game");
    if (!scene?.cameras?.main) throw new Error("game scene unavailable");
    const camera = scene.cameras.main;
    const canvasRect = scene.game.canvas.getBoundingClientRect();
    const viewWidth = Number(scene.scale.width ?? scene.game.config.width);
    const viewHeight = Number(scene.scale.height ?? scene.game.config.height);
    const scaleX = canvasRect.width / viewWidth;
    const scaleY = canvasRect.height / viewHeight;
    const loot = scene.room.state.loot.get(wantedLootId);
    const render = scene.lootObjects.get(wantedLootId);
    if (!loot || !render?.container.visible) {
      throw new Error(`loot ${wantedLootId} is not visible`);
    }
    const screenX = canvasRect.left + (loot.x - camera.worldView.x) * camera.zoom * scaleX;
    const screenY = canvasRect.top + (loot.y - camera.worldView.y) * camera.zoom * scaleY;
    return { lootId: wantedLootId, screenX, screenY };
  }, lootId);
}

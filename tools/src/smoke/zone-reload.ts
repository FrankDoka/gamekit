import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { createStaticCollisionResolver, type MapManifest } from "@gamekit/game-contract";
import { ensureChatExpanded } from "./chat";
import { loadContentRegistry } from "../../../server/src/content/registry.js";
import { commitZoneReload, prepareZoneReload } from "../../../server/src/zone-reload.js";
import { TIMEOUT } from "./constants";
import type { SmokeBrowserGlobal } from "./types";

const MAP_ID = "map_harbor_outskirts";

export async function verifyZoneReloadSwap(root: string): Promise<void> {
  const contentDir = path.join(root, "content");
  const content = loadContentRegistry(contentDir);
  const original = content.maps.get(MAP_ID);
  if (!original?.placements?.monsterSpawns.length || !original.placements.npcs.length) {
    throw new Error(`zone reload smoke requires ${MAP_ID} NPC and monster placements`);
  }

  const tile = findUnblockedTile(original);
  const tempContent = createTempContentDir();
  const movedMonster = original.placements.monsterSpawns[0];
  const movedNpc = original.placements.npcs[0];
  const updated: MapManifest = {
    ...original,
    collision: {
      ...original.collision,
      blocked: [...original.collision.blocked.map(([x, y]) => [x, y] as [number, number]), tile],
    },
    placements: {
      monsterSpawns: original.placements.monsterSpawns.map((zone, index) =>
        index === 0 ? { ...zone, x: zone.x + 31, y: zone.y + 29 } : { ...zone },
      ),
      npcs: original.placements.npcs.map((npc, index) =>
        index === 0 ? { ...npc, x: npc.x + 37, y: npc.y + 41 } : { ...npc },
      ),
    },
  };
  fs.writeFileSync(path.join(tempContent, "maps", `${MAP_ID}.json`), JSON.stringify(updated), "utf8");

  const maps = new Map(content.maps);
  const staticCollisionByMap = new Map([[MAP_ID, createStaticCollisionResolver(original)]]);
  const monsterSpawnMaps = new Map<string, string>();
  const prepared = prepareZoneReload(tempContent, content, MAP_ID);
  commitZoneReload({ maps, staticCollisionByMap, monsterSpawnMaps }, prepared);

  const swappedMap = maps.get(MAP_ID);
  if (!swappedMap) throw new Error("zone reload smoke lost the map entry");
  const nextMonster = swappedMap.placements?.monsterSpawns.find((zone) => zone.instanceId === movedMonster.instanceId);
  const nextNpc = swappedMap.placements?.npcs.find((npc) => npc.instanceId === movedNpc.instanceId);
  if (nextMonster?.x !== movedMonster.x + 31 || nextMonster.y !== movedMonster.y + 29) {
    throw new Error("zone reload smoke did not move the monster spawn placement");
  }
  if (nextNpc?.x !== movedNpc.x + 37 || nextNpc.y !== movedNpc.y + 41) {
    throw new Error("zone reload smoke did not move the NPC placement");
  }

  const probeX = tile[0] * original.collision.tileSize + 1;
  const probeY = tile[1] * original.collision.tileSize + 1;
  if (createStaticCollisionResolver(original).isPointBlocked(probeX, probeY)) {
    throw new Error("zone reload smoke selected an already-blocked collision probe");
  }
  if (!staticCollisionByMap.get(MAP_ID)?.isPointBlocked(probeX, probeY)) {
    throw new Error("zone reload smoke did not flip collision walkability");
  }
  if (monsterSpawnMaps.get(movedMonster.monsterId) !== MAP_ID) {
    throw new Error("zone reload smoke did not rebuild monster spawn map lookup");
  }

  console.log(`[smoke] Zone reload swap moved monster ${movedMonster.instanceId}, NPC ${movedNpc.instanceId}, and blocked tile ${tile.join(",")}.`);
}

export async function verifyReloadZoneNonAdminRejected(page: Page): Promise<void> {
  await ensureChatExpanded(page);
  await page.locator(".hud-chat-input").fill(`/reloadzone ${MAP_ID}`);
  await page.keyboard.press("Enter");
  await page.waitForFunction((expected) => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const messages = Array.from(doc.querySelectorAll(".hud-chat-system"));
    return messages.some((candidate) => candidate.textContent?.includes(expected));
  }, "Unknown command.", { timeout: TIMEOUT });
  console.log("[smoke] Zone reload: non-admin /reloadzone command was rejected.");
}

function createTempContentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gamekit-zone-reload-smoke-"));
  fs.mkdirSync(path.join(dir, "maps"), { recursive: true });
  return dir;
}

function findUnblockedTile(map: MapManifest): [number, number] {
  const blocked = new Set(map.collision.blocked.map(([x, y]) => `${x},${y}`));
  for (let y = 0; y < Math.floor(map.size.height / map.collision.tileSize); y += 1) {
    for (let x = 0; x < Math.floor(map.size.width / map.collision.tileSize); x += 1) {
      if (!blocked.has(`${x},${y}`)) return [x, y];
    }
  }
  throw new Error(`no unblocked collision tile found in ${map.id}`);
}

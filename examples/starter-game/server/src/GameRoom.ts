import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Room, type Client } from "@colyseus/core";
import { GameState, Monster, Player } from "./state";

const MAP_ID = "map_starter_field";
const SPAWN_X = 800;
const SPAWN_Y = 600;
const MAP_WIDTH = 1600;
const MAP_HEIGHT = 1200;
// Single-step move clamp (px) — matches the intent contract in the task card.
const MAX_STEP = 1200;

const HERE = dirname(fileURLToPath(import.meta.url));
// server/src -> examples/starter-game/content/zones/<map>.layout.json
const LAYOUT_PATH = join(HERE, "..", "..", "content", "zones", `${MAP_ID}.layout.json`);

type MoveIntent = { type: "move.to"; x?: number; y?: number; clientTimeMs?: number };

type MonsterSpawn = {
  instanceId: string;
  monsterId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  maxAlive: number;
  respawnMs: number;
};

// Read the authored monster spawns straight from the zone layout so the live
// world matches the content the zone tools validate/export. Falls back to no
// spawns if the layout is unreadable (server still boots for capture/smoke).
function loadMonsterSpawns(): MonsterSpawn[] {
  try {
    const layout = JSON.parse(readFileSync(LAYOUT_PATH, "utf-8")) as {
      monsterSpawns?: MonsterSpawn[];
    };
    return layout.monsterSpawns ?? [];
  } catch (err) {
    console.log(JSON.stringify({ msg: "spawn-load-failed", error: String(err) }));
    return [];
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Coerce an untrusted client value to a finite number, else fall back. Guards move.to
 * against NaN/Infinity/garbage — keep this habit when you replace this with real intents. */
function finiteOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export class GameRoom extends Room<GameState> {
  onCreate(): void {
    this.setState(new GameState());
    this.spawnMonsters();

    this.onMessage("intent", (client, message: MoveIntent) => {
      if (!message || message.type !== "move.to") return;
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const targetX = clamp(finiteOr(message.x, player.x), 0, MAP_WIDTH);
      const targetY = clamp(finiteOr(message.y, player.y), 0, MAP_HEIGHT);
      const dx = targetX - player.x;
      const dy = targetY - player.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= MAX_STEP || dist === 0) {
        player.x = targetX;
        player.y = targetY;
      } else {
        // Clamp a single step to MAX_STEP along the straight line toward target.
        player.x = clamp(player.x + (dx / dist) * MAX_STEP, 0, MAP_WIDTH);
        player.y = clamp(player.y + (dy / dist) * MAX_STEP, 0, MAP_HEIGHT);
      }
      console.log(
        JSON.stringify({
          msg: "move",
          sessionId: client.sessionId,
          x: Math.round(player.x),
          y: Math.round(player.y),
        }),
      );
    });

    // No-op channels the harness/state trace may subscribe to.
    this.onMessage("error", () => {});
    this.onMessage("combat", () => {});
  }

  // Spawn live monsters from the zone's authored monsterSpawns into state.monsters.
  // Each zone spawns maxAlive instances jittered within its rect. Ids carry a
  // trailing ordinal so they read cleanly in state traces and stay unique.
  private spawnMonsters(): void {
    const spawns = loadMonsterSpawns();
    let total = 0;
    for (const spawn of spawns) {
      for (let i = 0; i < spawn.maxAlive; i += 1) {
        const monster = new Monster();
        monster.monsterId = spawn.monsterId;
        monster.mapId = MAP_ID;
        // Deterministic scatter across the spawn rect (no RNG so captures are stable).
        const fx = spawn.maxAlive > 1 ? i / (spawn.maxAlive - 1) : 0.5;
        const fy = ((i * 2 + 1) % Math.max(1, spawn.maxAlive)) / spawn.maxAlive;
        monster.x = clamp(spawn.x + (fx - 0.5) * spawn.width, 0, MAP_WIDTH);
        monster.y = clamp(spawn.y + (fy - 0.5) * spawn.height, 0, MAP_HEIGHT);
        monster.hp = 40;
        monster.maxHp = 40;
        monster.alive = true;
        const key = `${spawn.instanceId}_${i + 1}`;
        this.state.monsters.set(key, monster);
        total += 1;
      }
    }
    console.log(JSON.stringify({ msg: "monsters-spawned", count: total }));
  }

  onJoin(client: Client, options?: { name?: string }): void {
    const player = new Player();
    player.sessionId = client.sessionId;
    player.name = options?.name ?? `guest-${client.sessionId.slice(0, 4)}`;
    player.mapId = MAP_ID;
    player.x = SPAWN_X;
    player.y = SPAWN_Y;
    this.state.players.set(client.sessionId, player);
    console.log(JSON.stringify({ msg: "join", sessionId: client.sessionId, name: player.name }));
  }

  onLeave(client: Client): void {
    this.state.players.delete(client.sessionId);
    console.log(JSON.stringify({ msg: "leave", sessionId: client.sessionId }));
  }
}

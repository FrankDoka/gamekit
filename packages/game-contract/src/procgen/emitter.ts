/**
 * Emitter: a generated Dungeon -> a `content/zones/*.layout.json`-shaped object in PIXEL
 * space. This is our-schema glue; the generator (dungeon.ts) stays schema-agnostic.
 *
 * Mapping (proposals/procedural-dungeons.md "Mapping to our shape"):
 *   - tiles * tileSize -> pixel coordinates and bounds.
 *   - grid === WALL     -> collision.blocked [col,row] pairs (VOID is out-of-play; only
 *                          WALL cells that border floor matter, but we emit every WALL to
 *                          match the runtime's dense-grid collision convention).
 *   - entrance room     -> spawnPoints (player start).
 *   - boss room         -> a portal anchor (exit) when a portalId is supplied.
 *   - tier-graded spawns -> monsterSpawns rects (tier -> monsterId via a caller map).
 *
 * The output is deterministic for a deterministic Dungeon: instance ids are ordinal and
 * derived from grid position, never from insertion-time randomness.
 */

import type { PortalShape } from "../manifests.js";
import { WALL, ROOM_TYPE, type Dungeon } from "./dungeon.js";

/** Minimal structural shape of a zone layout the emitter produces. Intentionally a
 * plain interface (not the zod type) so this module has no runtime schema dependency;
 * callers validate with `ZoneLayout.parse` at the boundary. */
export interface EmittedLayout {
  schemaVersion: 1;
  mapId: string;
  bounds: { width: number; height: number };
  ground: unknown[];
  decals: unknown[];
  props: unknown[];
  npcs: unknown[];
  monsterSpawns: Array<{
    instanceId: string;
    monsterId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    maxAlive: number;
    respawnMs: number;
  }>;
  portals: Array<{ instanceId: string; portalId: string; shape: PortalPlacementShape }>;
  spawnPoints: Array<{ instanceId: string; id: string; x: number; y: number }>;
  collision: { tileSize: number; blocked: number[][] };
}

type PortalPlacementShape = { type: "circle"; x: number; y: number; radius: number };

export interface EmitOptions {
  /** Content map id for the emitted layout (e.g. `map_dungeon_seed_123`). */
  mapId: string;
  /** Pixel size of one grid tile (upstream tiles are unitless; our runtime is pixel-space). */
  tileSize: number;
  /** tier (1..3) -> monsterId. Any tier not present is skipped (its spawns are dropped). */
  monsterByTier: Record<number, string>;
  /** Optional boss-room exit portal. When omitted, no portal is emitted. */
  bossPortalId?: string;
  /** Spawn-point content id (defaults to `spawn_dungeon_entrance`). */
  entranceSpawnId?: string;
  /** maxAlive per emitted monster spawn (default 1). */
  maxAlive?: number;
  /** respawnMs per emitted monster spawn (default 5000). */
  respawnMs?: number;
}

/** Pixel center of a grid tile. */
function tileCenter(coord: number, tileSize: number): number {
  return Math.round(coord * tileSize + tileSize / 2);
}

/**
 * Emit a valid ZoneLayout-shaped object from a generated Dungeon. Pure and deterministic:
 * given the same Dungeon + options, byte-identical output.
 */
export function emitLayout(dungeon: Dungeon, options: EmitOptions): EmittedLayout {
  const { mapId, tileSize } = options;
  const maxAlive = options.maxAlive ?? 1;
  const respawnMs = options.respawnMs ?? 5000;
  const entranceSpawnId = options.entranceSpawnId ?? "spawn_dungeon_entrance";

  const bounds = { width: dungeon.W * tileSize, height: dungeon.H * tileSize };

  // collision.blocked: every WALL cell as [col,row]. Row-major scan keeps output stable.
  const blocked: number[][] = [];
  for (let y = 0; y < dungeon.H; y++) {
    for (let x = 0; x < dungeon.W; x++) {
      if (dungeon.grid[y * dungeon.W + x] === WALL) blocked.push([x, y]);
    }
  }

  // spawnPoints: entrance room center. Schema requires >=1, so fall back to grid center
  // if there is no entrance (only happens for a degenerate/invalid dungeon).
  const entranceRoom = dungeon.rooms[dungeon.entrance];
  const spawnCx = entranceRoom ? entranceRoom.cx : Math.floor(dungeon.W / 2);
  const spawnCy = entranceRoom ? entranceRoom.cy : Math.floor(dungeon.H / 2);
  const spawnPoints = [
    {
      instanceId: `spawn_point_${mapId}_${entranceSpawnId}`,
      id: entranceSpawnId,
      x: tileCenter(spawnCx, tileSize),
      y: tileCenter(spawnCy, tileSize),
    },
  ];

  // portals: optional boss-room exit.
  const portals: EmittedLayout["portals"] = [];
  const bossRoom = dungeon.rooms[dungeon.boss];
  if (options.bossPortalId && bossRoom && bossRoom.type === ROOM_TYPE.BOSS) {
    const radius = Math.max(24, Math.round((Math.min(bossRoom.w, bossRoom.h) * tileSize) / 4));
    portals.push({
      instanceId: `portal_zone_${options.bossPortalId}_1`,
      portalId: options.bossPortalId,
      shape: { type: "circle", x: tileCenter(bossRoom.cx, tileSize), y: tileCenter(bossRoom.cy, tileSize), radius },
    });
  }

  // monsterSpawns: one small rect per generated spawn point, tier -> monsterId. Instance
  // ids carry a trailing ordinal (zone:lint spawn_ids_ordinal invariant) and encode the
  // tile so two spawns never collide.
  const rectPx = tileSize;
  const monsterSpawns: EmittedLayout["monsterSpawns"] = [];
  let ordinal = 0;
  for (const spawn of dungeon.spawns) {
    const monsterId = options.monsterByTier[spawn.tier];
    if (!monsterId) continue;
    ordinal += 1;
    const cx = tileCenter(spawn.x, tileSize);
    const cy = tileCenter(spawn.y, tileSize);
    monsterSpawns.push({
      instanceId: `monster_spawn_t${spawn.tier}_${spawn.x}_${spawn.y}_${ordinal}`,
      monsterId,
      x: cx - Math.round(rectPx / 2),
      y: cy - Math.round(rectPx / 2),
      width: rectPx,
      height: rectPx,
      maxAlive,
      respawnMs,
    });
  }

  return {
    schemaVersion: 1,
    mapId,
    bounds,
    ground: [],
    decals: [],
    props: [],
    npcs: [],
    monsterSpawns,
    portals,
    spawnPoints,
    collision: { tileSize, blocked },
  };
}

// `PortalShape` is imported only to document that `PortalPlacementShape` is a compatible
// subset (a circle portal). Keeping the reference prevents an unused-import lint while
// making the schema linkage explicit for readers.
export type _PortalShapeLink = PortalShape;

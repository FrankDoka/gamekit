import { z } from "zod";
import { AffixId, ItemId, LootTableId, MapId, MonsterId, NpcId, PortalId } from "./ids";
import { PortalShape } from "./manifests";

// Authored zone layout schema (the editor's on-disk shape). Copied faithfully from the game's
// shared/src/zone-layout.ts because the toolkit parses layouts at runtime
// (`ZoneLayout.parse` / `.safeParse` in zone-export/zone-validate/devkit) and derives types
// via `z.infer<typeof ...>`. The shared placement sub-schemas are exported so the
// asset-placement contract and zone tools can reference them.

export const PlacementOrigin = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  })
  .strict();

export const PlacementOpacity = z.number().min(0).max(1);

export const LegacyPixelCollisionBox = z
  .object({
    width: z.number().positive(),
    height: z.number().positive(),
    offsetX: z.number().optional(),
    offsetY: z.number().optional(),
  })
  .strict();

export const AuthoredCollisionShape = z
  .object({
    mode: z.enum(["none", "box"]),
    xPct: z.number().min(0).max(100),
    yPct: z.number().min(0).max(100),
    wPct: z.number().min(0).max(100),
    hPct: z.number().min(0).max(100),
    blocksMovement: z.boolean(),
    blocksPlayers: z.boolean(),
    blocksMonsters: z.boolean(),
  })
  .strict();

export const PropShadowSpec = z
  .object({
    mode: z.enum(["none", "auto", "custom"]),
    offsetX: z.number().optional(),
    offsetY: z.number().optional(),
    wPct: z.number().min(0).max(300).optional(),
    hPct: z.number().min(0).max(300).optional(),
    alpha: z.number().min(0).max(1).optional(),
    blur: z.number().min(0).max(24).optional(),
    rotation: z.number().optional(),
  })
  .strict();

export const PropReflectionSpec = z
  .object({
    enabled: z.boolean(),
    offsetY: z.number().optional(),
    heightPct: z.number().min(0).max(300).optional(),
    alpha: z.number().min(0).max(1).optional(),
    wavePct: z.number().min(0).max(100).optional(),
  })
  .strict();

export const GroundRegion = z.object({
  instanceId: z.string(),
  assetKey: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  zIndex: z.number().int().optional(),
});

export const DecalPlacement = z.object({
  instanceId: z.string(),
  assetKey: z.string(),
  x: z.number(),
  y: z.number(),
  zIndex: z.number().int().optional(),
  scale: z.number().positive().optional(),
  rotation: z.number().optional(),
  origin: PlacementOrigin.optional(),
  opacity: PlacementOpacity.optional(),
});

export const PropPlacement = z.object({
  instanceId: z.string(),
  assetKey: z.string(),
  x: z.number(),
  y: z.number(),
  zIndex: z.number().int().optional(),
  scale: z.number().positive().optional(),
  rotation: z.number().optional(),
  origin: PlacementOrigin.optional(),
  opacity: PlacementOpacity.optional(),
  shadow: PropShadowSpec.optional(),
  reflection: PropReflectionSpec.optional(),
  collision: AuthoredCollisionShape.optional(),
  legacyPixelCollision: LegacyPixelCollisionBox.optional(),
});

export const NpcPlacement = z.object({
  instanceId: z.string(),
  npcId: NpcId,
  x: z.number(),
  y: z.number(),
  radius: z.number().positive(),
  scale: z.number().min(0.25).max(4).optional(),
});

export const ChestPlacement = z.object({
  instanceId: z.string(),
  lootTableId: LootTableId,
  x: z.number(),
  y: z.number(),
  radius: z.number().positive().optional(),
  respawnMs: z.number().int().nonnegative().optional(),
  assetKey: z.string().optional(),
  scale: z.number().min(0.25).max(4).optional(),
});

export const OreNodeZone = z.object({
  instanceId: z.string(),
  itemId: ItemId,
  yieldTier: z.number().int().min(1),
  profession: z.enum(["mining"]),
  x: z.number(),
  y: z.number(),
  radius: z.number().positive().optional(),
  respawnMs: z.number().int().nonnegative().optional(),
  assetKey: z.string().optional(),
  scale: z.number().min(0.25).max(4).optional(),
});

export const MonsterSpawnZone = z.object({
  instanceId: z.string(),
  monsterId: MonsterId,
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  maxAlive: z.number().int().positive(),
  respawnMs: z.number().int().nonnegative(),
  affixPool: z.object({
    weightNone: z.number().nonnegative().default(0),
    entries: z.array(z.object({
      affixId: AffixId,
      weight: z.number().positive(),
    })).min(1),
  }).optional(),
});

export const PortalZone = z.object({
  instanceId: z.string(),
  portalId: PortalId,
  shape: PortalShape,
});

export const LayoutSpawnPoint = z.object({
  instanceId: z.string(),
  id: z.string(),
  x: z.number(),
  y: z.number(),
});

export const ZoneLayout = z
  .object({
    schemaVersion: z.literal(1),
    mapId: MapId,
    bounds: z.object({
      width: z.number().positive(),
      height: z.number().positive(),
    }),
    ground: z.array(GroundRegion),
    decals: z.array(DecalPlacement),
    props: z.array(PropPlacement),
    npcs: z.array(NpcPlacement),
    chests: z.array(ChestPlacement).optional(),
    oreNodes: z.array(OreNodeZone).optional(),
    monsterSpawns: z.array(MonsterSpawnZone),
    portals: z.array(PortalZone),
    spawnPoints: z.array(LayoutSpawnPoint).min(1),
    collision: z.object({
      tileSize: z.number().int().positive(),
      blocked: z.array(z.array(z.number().int())),
    }),
    musicId: z.string().optional(),
  })
  .strict();
export type ZoneLayout = z.infer<typeof ZoneLayout>;

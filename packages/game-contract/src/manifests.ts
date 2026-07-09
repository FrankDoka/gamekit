import { z } from "zod";
import {
  MapId,
  MonsterId,
  ItemId,
  SkillId,
  ClassId,
  PortalId,
  LootTableId,
  CurrencyId,
  NpcId,
  QuestId,
  EventTemplateId,
  AnimationSetId,
  AffixId,
  StageId,
  RecipeId,
} from "./ids";
import { StageManifest } from "./stage-manifests";

// Content-type schemas. Each schema is BOTH the runtime validator and (via z.infer) the
// static type. Copied faithfully from the game's shared/src/manifests.ts because the toolkit's
// validate/zone-export tools iterate `MANIFEST_SCHEMAS` and call `.parse`/`.safeParse` at
// runtime. Field sets are template defaults — a game adds/removes manifest fields to match its
// own content model; the toolkit only depends on the shapes its tools actually read.

const VisualOrigin = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  })
  .strict();

const VisualOpacity = z.number().min(0).max(1);

const LegacyPixelCollisionBox = z
  .object({
    width: z.number().positive(),
    height: z.number().positive(),
    offsetX: z.number().optional(),
    offsetY: z.number().optional(),
  })
  .strict();

const AuthoredCollisionShape = z
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

const PropShadowSpec = z
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

const PropReflectionSpec = z
  .object({
    enabled: z.boolean(),
    offsetY: z.number().optional(),
    heightPct: z.number().min(0).max(300).optional(),
    alpha: z.number().min(0).max(1).optional(),
    wavePct: z.number().min(0).max(100).optional(),
  })
  .strict();

export const CompiledVisual = z.object({
  ground: z.array(z.object({
    instanceId: z.string(),
    assetKey: z.string(),
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    zIndex: z.number().int().optional(),
  })),
  decals: z.array(z.object({
    instanceId: z.string(),
    assetKey: z.string(),
    x: z.number(),
    y: z.number(),
    zIndex: z.number().int().optional(),
    scale: z.number().positive().optional(),
    rotation: z.number().optional(),
    origin: VisualOrigin.optional(),
    opacity: VisualOpacity.optional(),
  })),
  props: z.array(z.object({
    instanceId: z.string(),
    assetKey: z.string(),
    x: z.number(),
    y: z.number(),
    zIndex: z.number().int().optional(),
    scale: z.number().positive().optional(),
    rotation: z.number().optional(),
    origin: VisualOrigin.optional(),
    opacity: VisualOpacity.optional(),
    shadow: PropShadowSpec.optional(),
    reflection: PropReflectionSpec.optional(),
    collision: AuthoredCollisionShape.optional(),
    legacyPixelCollision: LegacyPixelCollisionBox.optional(),
  })),
});

export const CompiledPlacements = z.object({
  npcs: z.array(z.object({
    instanceId: z.string(),
    npcId: NpcId,
    x: z.number(),
    y: z.number(),
    radius: z.number().positive(),
    scale: z.number().min(0.25).max(4).optional(),
  })),
  monsterSpawns: z.array(z.object({
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
  })),
  chests: z.array(z.object({
    instanceId: z.string(),
    lootTableId: LootTableId,
    x: z.number(),
    y: z.number(),
    radius: z.number().positive().optional(),
    respawnMs: z.number().int().nonnegative().optional(),
    assetKey: z.string().optional(),
    scale: z.number().min(0.25).max(4).optional(),
  })).optional(),
  oreNodes: z.array(z.object({
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
  })).optional(),
});

export const PortalShape = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("circle"),
    x: z.number(),
    y: z.number(),
    radius: z.number().positive(),
  }),
  z.object({
    type: z.literal("rect"),
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
]);
export type PortalShape = z.infer<typeof PortalShape>;

export const MapManifest = z
  .object({
    schemaVersion: z.literal(1),
    id: MapId,
    nameKey: z.string(),
    size: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    spawnPoints: z
      .array(z.object({ instanceId: z.string(), id: z.string(), x: z.number(), y: z.number() }))
      .min(1),
    collision: z.object({
      tileSize: z.number().int().positive(),
      blocked: z.array(z.array(z.number().int())),
    }),
    portals: z.array(PortalId),
    portalPlacements: z.array(z.object({
      instanceId: z.string(),
      portalId: PortalId,
      shape: PortalShape,
    })).optional(),
    musicId: z.string().optional(),
    visual: CompiledVisual.optional(),
    placements: CompiledPlacements.optional(),
    compiledFrom: z.union([
      z.string(),
      z.object({
        path: z.string(),
        sourceHash: z.string(),
      }).strict(),
    ]).optional(),
  })
  .strict();
export type MapManifest = z.infer<typeof MapManifest>;

export const PortalManifest = z
  .object({
    schemaVersion: z.literal(1),
    id: PortalId,
    sourceMapId: MapId,
    targetMapId: MapId,
    targetSpawnId: z.string(),
    shape: PortalShape,
    loadingTitleKey: z.string().optional(),
    loadingArtId: z.string().optional(),
    stageId: StageId.optional(),
  })
  .strict();
export type PortalManifest = z.infer<typeof PortalManifest>;

export const MonsterManifest = z
  .object({
    schemaVersion: z.literal(1),
    id: MonsterId,
    nameKey: z.string(),
    rank: z.enum(["normal", "boss"]).default("normal"),
    stats: z.object({
      hp: z.number().int().positive(),
      atk: z.number().int().nonnegative(),
      def: z.number().int().nonnegative(),
      matk: z.number().int().nonnegative(),
      mdef: z.number().int().nonnegative(),
      hit: z.number().int().nonnegative(),
      flee: z.number().int().nonnegative(),
      crit: z.number().int().nonnegative(),
      moveSpeed: z.number().positive(),
    }),
    spawn: z
      .object({
        mapId: MapId,
        maxAlive: z.number().int().positive(),
        respawnMs: z.number().int().nonnegative(),
      })
      .optional(),
    lootTableId: LootTableId,
    behavior: z.enum(["passive", "aggressive"]).default("passive"),
    attackRange: z.number().positive().optional(),
    sightRange: z.number().positive().optional(),
    leashRange: z.number().positive().optional(),
    xpReward: z.number().int().positive().optional(),
    bestiaryId: z.string().optional(),
    portraitId: z.string().optional(),
    animationSetId: AnimationSetId.optional(),
  })
  .strict();
export type MonsterManifest = z.infer<typeof MonsterManifest>;

const AffixMultipliers = z
  .object({
    hp: z.number().positive().default(1),
    atk: z.number().positive().default(1),
    def: z.number().positive().default(1),
    moveSpeed: z.number().positive().default(1),
    attackSpeed: z.number().positive().default(1),
  })
  .strict();

export const AffixManifest = z
  .object({
    schemaVersion: z.literal(1),
    id: AffixId,
    displayPrefix: z.string().min(1),
    tint: z.string().regex(/^0x[0-9a-fA-F]{6}$/, "expected 0xRRGGBB").optional(),
    statMods: AffixMultipliers.default({}),
    rewardMods: z
      .object({
        gold: z.number().positive().default(1),
        xp: z.number().positive().default(1),
      })
      .strict()
      .default({}),
  })
  .strict();
export type AffixManifest = z.infer<typeof AffixManifest>;

export const EquipmentSlot = z.enum([
  "weapon",
  "offhand",
  "head",
  "eyes",
  "mouth",
  "armor",
  "boots",
  "cape",
  "accessory1",
  "accessory2",
]);
export type EquipmentSlot = z.infer<typeof EquipmentSlot>;

export const EquipmentStats = z
  .object({
    atk: z.number().int().optional(),
    def: z.number().int().optional(),
    matk: z.number().int().optional(),
    mdef: z.number().int().optional(),
    hit: z.number().int().optional(),
    flee: z.number().int().optional(),
    crit: z.number().int().optional(),
  })
  .strict();
export type EquipmentStats = z.infer<typeof EquipmentStats>;

export const ItemManifest = z
  .object({
    schemaVersion: z.literal(1),
    id: ItemId,
    nameKey: z.string(),
    type: z.enum(["material", "consumable", "equipment", "currency"]),
    iconId: z.string().optional(),
    equipSlot: EquipmentSlot.optional(),
    stats: EquipmentStats.optional(),
    classRestriction: z.array(ClassId).optional(),
    stackMax: z.number().int().positive(),
    rarity: z.enum(["common", "uncommon", "rare", "epic", "legendary"]),
    sellPrice: z.number().int().nonnegative(),
    use: z.object({
      restoreHp: z.number().int().positive().optional(),
      restoreMp: z.number().int().positive().optional(),
    }).strict().optional(),
  })
  .strict()
  .refine((item) => item.use === undefined || item.type === "consumable", {
    message: "use effects are only valid on consumable items",
    path: ["use"],
  })
  .refine((item) => item.use === undefined || item.use.restoreHp !== undefined || item.use.restoreMp !== undefined, {
    message: "use effects must restore HP or MP",
    path: ["use"],
  });
export type ItemManifest = z.infer<typeof ItemManifest>;

export const SILENT_SFX_SENTINEL = "sfx.placeholder.silent-pending";

const SfxSlotId = z
  .string()
  .regex(/^sfx\.[a-z0-9_.-]+$/, "SFX slot ids must use the sfx. namespace (or the silent-pending sentinel)");

export const SkillManifest = z
  .object({
    schemaVersion: z.literal(1),
    id: SkillId,
    nameKey: z.string(),
    category: z.enum(["attack", "control", "area", "passive", "mobility"]),
    maxLevel: z.number().int().positive(),
    cost: z.object({ mp: z.number().int().nonnegative() }),
    cooldownMs: z.number().int().nonnegative(),
    movementLockMs: z.number().int().nonnegative().optional(),
    range: z.number().nonnegative(),
    targeting: z.enum(["self", "target", "ground"]),
    power: z.number().nonnegative(),
    aoeRadius: z.number().positive().optional(),
    effect: z.object({
      type: z.literal("root"),
      durationMs: z.number().int().positive(),
    }).optional(),
    presentation: z.object({
      castSfxId: SfxSlotId,
      impactSfxId: SfxSlotId,
      impactVfx: z.enum(["spark", "ring", "burst", "trail"]).optional(),
      tier: z.enum(["standard", "spectacle"]).optional(),
      tint: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      banner: z.string().min(1).max(32).optional(),
      reticle: z.object({
        shape: z.literal("circle"),
        radius: z.number().positive(),
      }).strict().optional(),
      composition: z.array(z.string().min(1)).optional(),
    }).strict().optional(),
  })
  .strict()
  .refine((skill) => skill.category !== "area" || skill.aoeRadius !== undefined, {
    message: "area skills require aoeRadius",
    path: ["aoeRadius"],
  })
  .refine((skill) => skill.effect === undefined || skill.category === "control" || skill.category === "area", {
    message: "skill effects are only valid on control or area skills",
    path: ["effect"],
  })
  .refine((skill) => skill.presentation?.reticle === undefined || skill.targeting === "ground" || skill.category === "area", {
    message: "presentation reticles are only valid on ground-target or area skills",
    path: ["presentation", "reticle"],
  });
export type SkillManifest = z.infer<typeof SkillManifest>;

export const SkillNodeManifest = z
  .object({
    schemaVersion: z.literal(1),
    id: SkillId,
    classId: ClassId,
    category: z.enum(["passive", "support", "active", "flexible"]),
    tier: z.number().int().min(1).max(4),
    prerequisites: z.array(z.object({
      type: z.enum(["skill", "class_level", "job_level"]),
      targetId: z.string(),
      requiredLevel: z.number().int().positive(),
    })).optional(),
    unlocks: z.array(SkillId).optional(),
    pointCost: z.number().int().positive().default(1),
    perLevelScaling: z.object({
      power: z.array(z.number()),
      cost: z.array(z.object({ mp: z.number().int() })),
      cooldownMs: z.array(z.number().int()),
    }).optional(),
  })
  .strict();
export type SkillNodeManifest = z.infer<typeof SkillNodeManifest>;

export const LootTableManifest = z
  .object({
    schemaVersion: z.literal(1),
    id: LootTableId,
    entries: z
      .array(
        z.object({
          itemId: ItemId,
          chance: z.number().min(0).max(1),
          min: z.number().int().positive(),
          max: z.number().int().positive(),
        }),
      )
      .min(1),
  })
  .strict();
export type LootTableManifest = z.infer<typeof LootTableManifest>;

export const ClassManifest = z
  .object({
    schemaVersion: z.literal(1),
    id: ClassId,
    nameKey: z.string(),
    startingSkillId: SkillId,
    startingSkillIds: z.array(SkillId).optional(),
    baseStats: z.object({
      str: z.number().int(),
      agi: z.number().int(),
      vit: z.number().int(),
      int: z.number().int(),
      dex: z.number().int(),
      luk: z.number().int(),
    }),
    portraitId: z.string().optional(),
    animationSetId: AnimationSetId.optional(),
    advancesFrom: ClassId.optional(),
    requirements: z.object({
      level: z.number().int().positive(),
      questId: QuestId.optional(),
    }).strict().optional(),
  })
  .strict()
  .refine((cls) => (cls.advancesFrom == null) === (cls.requirements == null), {
    message: "advancement classes must define both advancesFrom and requirements",
    path: ["requirements"],
  });
export type ClassManifest = z.infer<typeof ClassManifest>;

export const CurrencyManifest = z
  .object({
    schemaVersion: z.literal(1),
    id: CurrencyId,
    nameKey: z.string(),
    iconId: z.string().optional(),
  })
  .strict();
export type CurrencyManifest = z.infer<typeof CurrencyManifest>;

export const NpcManifest = z
  .object({
    schemaVersion: z.literal(1),
    id: NpcId,
    nameKey: z.string(),
    mapId: MapId.optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    radius: z.number().positive().optional(),
    portraitId: z.string().optional(),
    animationSetId: AnimationSetId.optional(),
    questId: QuestId.optional(),
    questIds: z.array(QuestId).nonempty().optional(),
    shopItems: z
      .array(
        z.object({
          itemId: ItemId,
          buyPrice: z.number().int().positive(),
          sellPrice: z.number().int().positive().optional(),
        }),
      )
      .optional(),
    dialogue: z.object({
      introKey: z.string(),
      activeKey: z.string(),
      completeKey: z.string(),
      copy: z.record(z.string(), z.string()).optional(),
      options: z.array(z.object({
        labelKey: z.string(),
        action: z.enum(["say", "accept", "turn-in", "advance", "close"]),
        textKey: z.string().optional(),
      }).strict()).optional(),
    }).strict(),
  })
  .strict()
  .refine((npc) => npc.questId === undefined || npc.questIds === undefined, {
    message: "use questId or questIds, not both",
    path: ["questIds"],
  });
export type NpcManifest = z.infer<typeof NpcManifest>;

const QuestReward = z.object({
  xp: z.number().int().nonnegative(),
  gold: z.number().int().nonnegative().optional(),
}).strict();

const QuestBase = z.object({
  schemaVersion: z.literal(1),
  id: QuestId,
  nameKey: z.string(),
  summaryKey: z.string(),
  introKey: z.string().optional(),
  copy: z.record(z.string(), z.string()).optional(),
  prereqQuestIds: z.array(QuestId).optional(),
  autoAccept: z.boolean().optional(),
  reward: QuestReward,
  repeatable: z.boolean().optional(),
});

export const QuestManifest = z.discriminatedUnion("kind", [
  QuestBase.extend({
    kind: z.literal("kill"),
    targetMonsterId: MonsterId,
    requiredKills: z.number().int().positive(),
  }).strict(),
  QuestBase.extend({
    kind: z.literal("talk"),
    targetNpcId: NpcId,
  }).strict(),
  QuestBase.extend({
    kind: z.literal("collect"),
    targetItemId: ItemId,
    requiredCount: z.number().int().positive(),
    consumeOnTurnIn: z.boolean().optional(),
  }).strict(),
  QuestBase.extend({
    kind: z.literal("stage-clear"),
    targetStageId: StageId,
    requiredClears: z.number().int().positive().default(1),
  }).strict(),
]);
export type QuestManifest = z.infer<typeof QuestManifest>;

export const EventTemplateManifest = z
  .object({
    schemaVersion: z.literal(1),
    id: EventTemplateId,
    nameKey: z.string(),
    descriptionKey: z.string(),
    mapId: MapId.optional(),
    durationMs: z.number().int().positive(),
    modifiers: z
      .object({
        spawnRateMultiplier: z.number().positive().optional(),
        goldMultiplier: z.number().positive().optional(),
        bonusLootTableId: LootTableId.optional(),
      })
      .strict(),
    announce: z
      .object({
        startText: z.string(),
        endText: z.string(),
      })
      .strict(),
  })
  .strict();
export type EventTemplateManifest = z.infer<typeof EventTemplateManifest>;

export const EVENT_SCHEDULE_ID = "event_schedule" as const;
export const EventScheduleManifest = z
  .object({
    schemaVersion: z.literal(1),
    id: z.literal(EVENT_SCHEDULE_ID),
    pool: z
      .array(
        z
          .object({
            eventId: EventTemplateId,
            weight: z.number().positive(),
          })
          .strict(),
      )
      .min(1),
    minGapMs: z.number().int().positive(),
    maxGapMs: z.number().int().positive(),
    quietHours: z
      .object({
        startHour: z.number().int().min(0).max(23),
        endHour: z.number().int().min(0).max(23),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((s) => s.maxGapMs >= s.minGapMs, {
    message: "maxGapMs must be >= minGapMs",
    path: ["maxGapMs"],
  });
export type EventScheduleManifest = z.infer<typeof EventScheduleManifest>;

export const RecipeManifest = z
  .object({
    schemaVersion: z.literal(1),
    id: RecipeId,
    nameKey: z.string(),
    station: NpcId,
    inputs: z
      .array(
        z.object({
          itemId: ItemId,
          count: z.number().int().positive(),
        }).strict(),
      )
      .min(1),
    output: z
      .object({
        itemId: ItemId,
        count: z.number().int().positive(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (recipe) => new Set(recipe.inputs.map((i) => i.itemId)).size === recipe.inputs.length,
    { message: "recipe inputs must not list the same item twice", path: ["inputs"] },
  );
export type RecipeManifest = z.infer<typeof RecipeManifest>;

// content/<dir> -> schema. The validator iterates these directories.
export const MANIFEST_SCHEMAS = {
  maps: MapManifest,
  portals: PortalManifest,
  monsters: MonsterManifest,
  affixes: AffixManifest,
  items: ItemManifest,
  skills: SkillManifest,
  "skill-nodes": SkillNodeManifest,
  loot: LootTableManifest,
  classes: ClassManifest,
  currencies: CurrencyManifest,
  npcs: NpcManifest,
  quests: QuestManifest,
  events: EventTemplateManifest,
  stages: StageManifest,
  recipes: RecipeManifest,
} as const;

export type ContentDir = keyof typeof MANIFEST_SCHEMAS;

import { z } from "zod";
import { ItemId, MapId, MonsterId, StageId } from "./ids";

// Stage (instanced encounter) schema. Copied faithfully from the game's
// shared/src/stage-manifests.ts — referenced by MANIFEST_SCHEMAS which the validate tool
// parses at runtime. Field set is a template default.

export const StageManifest = z
  .object({
    schemaVersion: z.literal(1),
    id: StageId,
    nameKey: z.string(),
    bossCeremonyTitle: z.string().optional(),
    mapId: MapId,
    entry: z
      .object({
        minLevel: z.number().int().positive().optional(),
        partyRequired: z.literal(false).default(false),
      })
      .strict()
      .default({ partyRequired: false }),
    spawn: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
      })
      .strict(),
    waves: z.array(
      z
        .object({
          objectiveKey: z.string(),
          monsters: z.array(
            z
              .object({
                monsterId: MonsterId,
                count: z.number().int().positive(),
                x: z.number().finite(),
                y: z.number().finite(),
              })
              .strict(),
          ),
        })
        .strict(),
    ).min(1),
    clearCondition: z.literal("all-waves"),
    rewardBundle: z
      .object({
        xp: z.number().int().nonnegative(),
        gold: z.number().int().nonnegative().optional(),
        items: z.array(
          z
            .object({
              itemId: ItemId,
              quantity: z.number().int().positive(),
            })
            .strict(),
        ).optional(),
        rareItems: z.array(
          z
            .object({
              itemId: ItemId,
              quantity: z.number().int().positive(),
              chance: z.number().min(0).max(1),
            })
            .strict(),
        ).optional(),
      })
      .strict(),
    respawnPolicy: z.literal("wipe"),
  })
  .strict();

export type StageManifest = z.infer<typeof StageManifest>;
export type StageRewardBundle = StageManifest["rewardBundle"];
export type StageResolvedRewardBundle = Omit<StageRewardBundle, "rareItems">;

import { z } from "zod";

// Economy tuning sheet schema + pure consumer math. Copied faithfully from the game's
// shared/src/economy-tuning.ts. The validate tool parses tuning.json against
// `EconomyTuningManifest` and cross-checks loot gold via `checkGoldRangesAgainstSheet`.
// The numeric bands are a template default — a game tunes them; the schema/math is generic.

export const ECONOMY_TUNING_ID = "economy_tuning" as const;

const GoldBand = z
  .object({
    min: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
  })
  .strict();

const IntBand = z
  .object({
    min: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
  })
  .strict();

export const EconomyTuningManifest = z
  .object({
    schemaVersion: z.literal(1),
    id: z.literal(ECONOMY_TUNING_ID),
    goldDrops: z
      .object({
        normal: GoldBand,
        boss: GoldBand,
      })
      .strict(),
    lootChances: z
      .object({
        min: z.number().min(0).max(1),
        max: z.number().min(0).max(1),
      })
      .strict(),
    enhancement: z
      .object({
        success: z.array(z.number().min(0).max(1)).min(1),
        break: z.array(z.number().min(0).max(1)).min(1),
      })
      .strict(),
    materialYields: z.array(IntBand).min(1),
  })
  .strict()
  .superRefine((sheet, ctx) => {
    for (const rank of ["normal", "boss"] as const) {
      const band = sheet.goldDrops[rank];
      if (band.min > band.max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["goldDrops", rank],
          message: `goldDrops.${rank} min ${band.min} exceeds max ${band.max}`,
        });
      }
    }

    if (sheet.lootChances.min > sheet.lootChances.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lootChances"],
        message: `lootChances min ${sheet.lootChances.min} exceeds max ${sheet.lootChances.max}`,
      });
    }

    if (sheet.enhancement.success.length !== sheet.enhancement.break.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["enhancement"],
        message:
          `enhancement.success (${sheet.enhancement.success.length}) and break ` +
          `(${sheet.enhancement.break.length}) must be the same length`,
      });
    }
    for (let i = 1; i < sheet.enhancement.success.length; i++) {
      if (sheet.enhancement.success[i]! > sheet.enhancement.success[i - 1]!) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["enhancement", "success", i],
          message: `enhancement.success must be non-increasing; index ${i} (${sheet.enhancement.success[i]}) rose above index ${i - 1} (${sheet.enhancement.success[i - 1]})`,
        });
      }
    }
    for (let i = 1; i < sheet.enhancement.break.length; i++) {
      if (sheet.enhancement.break[i]! < sheet.enhancement.break[i - 1]!) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["enhancement", "break", i],
          message: `enhancement.break must be non-decreasing; index ${i} (${sheet.enhancement.break[i]}) fell below index ${i - 1} (${sheet.enhancement.break[i - 1]})`,
        });
      }
    }

    for (let i = 0; i < sheet.materialYields.length; i++) {
      const band = sheet.materialYields[i]!;
      if (band.min > band.max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["materialYields", i],
          message: `materialYields tier ${i + 1} min ${band.min} exceeds max ${band.max}`,
        });
      }
      if (i > 0) {
        const prev = sheet.materialYields[i - 1]!;
        if (band.min < prev.min || band.max < prev.max) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["materialYields", i],
            message: `materialYields must be non-decreasing across tiers; tier ${i + 1} (${band.min}-${band.max}) fell below tier ${i} (${prev.min}-${prev.max})`,
          });
        }
      }
    }
  });

export type EconomyTuningManifest = z.infer<typeof EconomyTuningManifest>;

export type MaterialYieldBand = { min: number; max: number };

export function materialYieldBandForTier(
  sheet: Pick<EconomyTuningManifest, "materialYields">,
  yieldTier: number,
): MaterialYieldBand {
  const bands = sheet.materialYields;
  const index = Math.min(Math.max(1, Math.floor(yieldTier)), bands.length) - 1;
  const band = bands[index]!;
  return { min: band.min, max: band.max };
}

export function rollMaterialYield(
  sheet: Pick<EconomyTuningManifest, "materialYields">,
  yieldTier: number,
  rng: () => number = Math.random,
): number {
  const band = materialYieldBandForTier(sheet, yieldTier);
  const span = band.max - band.min + 1;
  return band.min + Math.floor(rng() * span);
}

export function enhancementMaxLevel(
  sheet: Pick<EconomyTuningManifest, "enhancement">,
): number {
  return sheet.enhancement.success.length;
}

export type EnhancementOdds = { success: number; break: number };

export function enhancementOddsForLevel(
  sheet: Pick<EconomyTuningManifest, "enhancement">,
  currentLevel: number,
): EnhancementOdds {
  const idx = Math.floor(currentLevel);
  if (idx < 0) return enhancementOddsForLevel(sheet, 0);
  if (idx >= sheet.enhancement.success.length) return { success: 0, break: 0 };
  return {
    success: sheet.enhancement.success[idx]!,
    break: sheet.enhancement.break[idx]!,
  };
}

export const ENHANCEMENT_BASE_COST = 50;
export const ENHANCEMENT_STEP_COST = 50;

export function enhancementGoldCost(currentLevel: number): number {
  const idx = Math.max(0, Math.floor(currentLevel));
  return ENHANCEMENT_BASE_COST + idx * ENHANCEMENT_STEP_COST;
}

export type EnhancementOutcome = "success" | "break" | "fail";

export function rollEnhancement(
  odds: EnhancementOdds,
  rng: () => number = Math.random,
): EnhancementOutcome {
  const roll = rng();
  if (roll < odds.success) return "success";
  if (roll < odds.success + odds.break) return "break";
  return "fail";
}

export const ENHANCEMENT_STAT_BONUS_PER_LEVEL = 0.05;

export function enhancementStatMultiplier(level: number): number {
  const n = Math.max(0, Math.floor(level));
  return 1 + n * ENHANCEMENT_STAT_BONUS_PER_LEVEL;
}

// Monster rank as it appears in MonsterManifest.rank.
export type MonsterRank = "normal" | "boss";

export type GoldConsumerInputs = {
  sheet: EconomyTuningManifest;
  goldItemId: string;
  monsters: Array<{ id: string; rank: MonsterRank; lootTableId: string }>;
  lootTables: Array<{
    id: string;
    entries: Array<{ itemId: string; min: number; max: number }>;
  }>;
};

export function checkGoldRangesAgainstSheet(input: GoldConsumerInputs): string[] {
  const errors: string[] = [];
  const bandFor = (rank: MonsterRank) => input.sheet.goldDrops[rank];
  const lootById = new Map(input.lootTables.map((t) => [t.id, t]));

  for (const monster of input.monsters) {
    const table = lootById.get(monster.lootTableId);
    if (!table) continue;
    const goldEntry = table.entries.find((e) => e.itemId === input.goldItemId);
    if (!goldEntry) continue;
    const band = bandFor(monster.rank);
    if (goldEntry.min < band.min || goldEntry.max > band.max) {
      errors.push(
        `loot ${table.id} gold ${goldEntry.min}-${goldEntry.max} is outside the ` +
          `${monster.rank} band ${band.min}-${band.max} governed by the economy ` +
          `tuning sheet (monster ${monster.id})`,
      );
    }
  }
  return errors;
}

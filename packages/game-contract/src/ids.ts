import { z } from "zod";

// Nominal, prefix-enforced content IDs. Each ID is defined once: the Zod schema gives
// runtime validation, z.infer gives the compile-time nominal type. These are the generic
// "type_slug" identity primitives the toolkit's schemas reference — a game keeps the same
// prefix convention (template default: a game may add/rename prefixes to match its slate).
//
// Copied faithfully from the game's shared/src/ids.ts because the toolkit's zod manifests
// (below) reference these schemas at runtime (`.parse`/`z.infer<typeof ...>`), not just as
// types.

const prefixed = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[a-z0-9_]+$`), `expected ${prefix}_<slug>`);

export const MapId = prefixed("map").brand<"MapId">();
export const MonsterId = prefixed("monster").brand<"MonsterId">();
export const ItemId = prefixed("item").brand<"ItemId">();
export const SkillId = prefixed("skill").brand<"SkillId">();
export const ClassId = prefixed("class").brand<"ClassId">();
export const PortalId = prefixed("portal").brand<"PortalId">();
export const StageId = prefixed("stage").brand<"StageId">();
export const LootTableId = prefixed("loot").brand<"LootTableId">();
export const CurrencyId = prefixed("currency").brand<"CurrencyId">();
export const NpcId = prefixed("npc").brand<"NpcId">();
export const QuestId = prefixed("quest").brand<"QuestId">();
export const EventTemplateId = prefixed("event").brand<"EventTemplateId">();
export const AnimationSetId = prefixed("animation").brand<"AnimationSetId">();
export const AffixId = prefixed("affix").brand<"AffixId">();
export const RecipeId = prefixed("recipe").brand<"RecipeId">();

// Any well-formed `type_slug` content id.
export const ContentId = z
  .string()
  .regex(/^[a-z]+_[a-z0-9_]+$/, "expected <type>_<slug>")
  .brand<"ContentId">();

export type MapId = z.infer<typeof MapId>;
export type MonsterId = z.infer<typeof MonsterId>;
export type ItemId = z.infer<typeof ItemId>;
export type SkillId = z.infer<typeof SkillId>;
export type ClassId = z.infer<typeof ClassId>;
export type PortalId = z.infer<typeof PortalId>;
export type StageId = z.infer<typeof StageId>;
export type LootTableId = z.infer<typeof LootTableId>;
export type CurrencyId = z.infer<typeof CurrencyId>;
export type NpcId = z.infer<typeof NpcId>;
export type QuestId = z.infer<typeof QuestId>;
export type EventTemplateId = z.infer<typeof EventTemplateId>;
export type AnimationSetId = z.infer<typeof AnimationSetId>;
export type AffixId = z.infer<typeof AffixId>;
export type RecipeId = z.infer<typeof RecipeId>;
export type ContentId = z.infer<typeof ContentId>;

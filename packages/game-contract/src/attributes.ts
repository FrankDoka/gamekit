// Attribute allocation primitives. Referenced by the messages contract (ClientIntent
// attribute.allocate) and the runtime intent validator. Copied faithfully from the game's
// shared/src/attributes.ts (template default — a game tunes the attribute set/keys).

export const ATTRIBUTE_KEYS = ["str", "agi", "vit", "int", "dex", "luk"] as const;

export type AttributeKey = (typeof ATTRIBUTE_KEYS)[number];

export type AttributeAllocations = Record<AttributeKey, number>;

export const EMPTY_ATTRIBUTE_ALLOCATIONS: AttributeAllocations = {
  str: 0,
  agi: 0,
  vit: 0,
  int: 0,
  dex: 0,
  luk: 0,
};

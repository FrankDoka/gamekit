import type { SheetConfig } from "./animation-assets";

// Boot asset-tier shapes + template boot payloads. In the game these are derived from its
// promoted asset registry (client/src/config/map-assets.ts); the toolkit consumes the SHAPES
// (MapAssetSet, BootAssetTier) and the tier partitioning. The concrete asset lists here are a
// template default (empty) — a game populates them from its promoted registry, at which point
// its own map-assets.test.ts asserts the partition. The capture-zone tool reads whichever
// tiers/sets a game supplies.

type ImageAsset = { key: string; path: string };
type AudioAsset = { key: string; path: string };

export type MapAssetSet = {
  sprites?: ImageAsset[];
  sheets?: SheetConfig[];
  tiles?: ImageAsset[];
  decals?: ImageAsset[];
  props?: ImageAsset[];
  audio?: AudioAsset[];
};

export type AssetTierId = "tier0" | "tier1";

export type BootAssetTier = {
  id: AssetTierId;
  label: string;
  assets: MapAssetSet;
};

// Template default — a game lists the assets visible at its first spawn / first fight.
export const STARTUP_SPAWN_VISIBLE_ASSET_KEYS = {
  tiles: [] as string[],
  decals: [] as string[],
  props: [] as string[],
  sprites: [] as string[],
} as const;

// Template default — a game lists the sprites/sfx its first combat needs blocking-loaded.
export const FIRST_FIGHT_ASSET_KEYS = {
  sprites: [] as string[],
  sfx: [] as string[],
} as const;

// Template default — the full pre-tiering startup payload a game boots with.
export const STARTUP_OLD_BOOT_ASSETS: MapAssetSet = {
  sprites: [],
  sheets: [],
  tiles: [],
  decals: [],
  props: [],
  audio: [],
};

export const BOOT_TIER0_ASSETS: MapAssetSet = {
  sprites: [],
  sheets: [],
  tiles: [],
  decals: [],
  props: [],
  audio: [],
};

function assetIdentity(kind: keyof MapAssetSet, asset: ImageAsset | AudioAsset | SheetConfig): string {
  return `${kind}:${asset.key}`;
}

function subtractAssetSet(full: MapAssetSet, loaded: MapAssetSet): MapAssetSet {
  const loadedIds = new Set<string>();
  for (const kind of ["sprites", "sheets", "tiles", "decals", "props", "audio"] as const) {
    for (const asset of loaded[kind] ?? []) loadedIds.add(assetIdentity(kind, asset));
  }
  const output: MapAssetSet = {};
  for (const kind of ["sprites", "sheets", "tiles", "decals", "props", "audio"] as const) {
    const remaining = (full[kind] ?? []).filter((asset) => !loadedIds.has(assetIdentity(kind, asset)));
    if (remaining.length > 0) {
      output[kind] = remaining as never;
    }
  }
  return output;
}

export const BOOT_TIER1_ASSETS: MapAssetSet = subtractAssetSet(STARTUP_OLD_BOOT_ASSETS, BOOT_TIER0_ASSETS);

export const BOOT_ASSET_TIERS: Record<AssetTierId, BootAssetTier> = {
  tier0: {
    id: "tier0",
    label: "blocking spawn and first fight",
    assets: BOOT_TIER0_ASSETS,
  },
  tier1: {
    id: "tier1",
    label: "deferred startup map remainder",
    assets: BOOT_TIER1_ASSETS,
  },
};

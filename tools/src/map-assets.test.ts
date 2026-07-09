import { describe, expect, it } from "vitest";
import {
  BOOT_ASSET_TIERS,
  FIRST_FIGHT_ASSET_KEYS,
  STARTUP_OLD_BOOT_ASSETS,
  STARTUP_SPAWN_VISIBLE_ASSET_KEYS,
  type MapAssetSet,
} from "@gamekit/game-contract";

function tierEntries(assets: MapAssetSet): string[] {
  const entries: string[] = [];
  for (const kind of ["sprites", "sheets", "tiles", "decals", "props", "audio"] as const) {
    for (const asset of assets[kind] ?? []) entries.push(`${kind}:${asset.key}`);
  }
  return entries;
}

function tierKeys(kind: keyof MapAssetSet, assets: MapAssetSet): string[] {
  return (assets[kind] ?? []).map((asset) => asset.key);
}

describe("boot asset tiers", () => {
  it("partitions the old startup payload across tier-0 and tier-1 without overlap", () => {
    const oldPayload = new Set(tierEntries(STARTUP_OLD_BOOT_ASSETS));
    const tier0 = tierEntries(BOOT_ASSET_TIERS.tier0.assets);
    const tier1 = tierEntries(BOOT_ASSET_TIERS.tier1.assets);
    const combined = new Set([...tier0, ...tier1]);

    expect(new Set(tier0).size).toBe(tier0.length);
    expect(new Set(tier1).size).toBe(tier1.length);
    expect(tier0.filter((entry) => tier1.includes(entry))).toEqual([]);
    expect(combined).toEqual(oldPayload);
  });

  it("keeps spawn-visible ground, decals, props, and sprites in tier-0", () => {
    const tier0 = BOOT_ASSET_TIERS.tier0.assets;

    expect(tierKeys("tiles", tier0)).toEqual(expect.arrayContaining([...STARTUP_SPAWN_VISIBLE_ASSET_KEYS.tiles]));
    expect(tierKeys("decals", tier0)).toEqual(expect.arrayContaining([...STARTUP_SPAWN_VISIBLE_ASSET_KEYS.decals]));
    expect(tierKeys("props", tier0)).toEqual(expect.arrayContaining([...STARTUP_SPAWN_VISIBLE_ASSET_KEYS.props]));
    expect(tierKeys("sprites", tier0)).toEqual(expect.arrayContaining([...STARTUP_SPAWN_VISIBLE_ASSET_KEYS.sprites]));
  });

  it("keeps first-fight monster art and combat sounds in tier-0", () => {
    const tier0 = BOOT_ASSET_TIERS.tier0.assets;

    // Structural invariant (not game-specific keys): whatever first-fight sprites/sfx a game
    // declares must be blocking-loaded in tier-0. Vacuously true for the empty template default.
    expect(tierKeys("sprites", tier0)).toEqual(expect.arrayContaining([...FIRST_FIGHT_ASSET_KEYS.sprites]));
    expect(tierKeys("audio", tier0)).toEqual(expect.arrayContaining([...FIRST_FIGHT_ASSET_KEYS.sfx]));
  });
});

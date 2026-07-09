import { describe, expect, it } from "vitest";
import { promoteKeyFromPath } from "./promote-key.js";

// Parity guard for card-toolsuite-unify: the DevKit editor and the Asset Bank must derive
// the SAME promote key for the same asset, or promoting from the two surfaces forks the
// registry key + runtime filename (the split-brain this card kills). Both call sites now
// import promoteKeyFromPath; this test locks its normalization contract so it can never
// silently drift back.

describe("promoteKeyFromPath — normalization contract", () => {
  it.each([
    // [input, expected]
    ["props/Harbor_Barrel_Cluster.png", "harbor_barrel_cluster"], // lowercase
    ["tiles/cobble_128x128.png", "cobble"], // strip _NxN dimension suffix
    ["props/lamp_clean.png", "lamp"], // strip pipeline suffix
    ["props/crate_raw.png", "crate"], // strip pipeline suffix
    ["props/sign_candidate.png", "sign"], // strip pipeline suffix
    ["props/banner_alpha_preview.png", "banner"], // strip pipeline suffix
    ["props/rug_preview.png", "rug"], // strip pipeline suffix
    ["props/well_clean_preview.png", "well"], // strip repeated/stacked suffixes
    ["decals/moss patch (v2).webp", "moss_patch_v2"], // sanitize + collapse + trim
    ["props/__weird__.png", "weird"], // trim leading/trailing underscores
    // Order matters: the _NxN strip is anchored at the END, so it only fires when the
    // dimension is the trailing token. Here `_clean` is trailing, so it is stripped but the
    // now-interior `_64x64` is NOT — matching DevKit's authoritative behavior verbatim.
    ["props/barrel_64x64_clean.png", "barrel_64x64"],
  ])("normalizes %s -> %s", (input, expected) => {
    expect(promoteKeyFromPath(input)).toBe(expected);
  });

  it("never returns an empty key (hash fallback for a fully-stripped basename)", () => {
    const key = promoteKeyFromPath("props/!!!.png");
    expect(key).not.toBe("");
    expect(key).toMatch(/^asset_[a-z0-9]+$/);
  });
});

describe("promoteKeyFromPath — cross-call-path parity", () => {
  // The Asset Bank promote passes an ABSOLUTE source path (asset-bank.ts safeAssetPath),
  // while the DevKit editor passes a BANK-RELATIVE path (devkit.ts sourceRel). For the same
  // asset those two strings differ only in their directory prefix — the derived key MUST be
  // identical either way, or the two surfaces fork the registry.
  const cases = [
    ["Z:/Assets/props/Harbor_Barrel_Cluster.png", "props/Harbor_Barrel_Cluster.png"],
    ["Z:/Assets/decals/moss patch (v2).webp", "decals/moss patch (v2).webp"],
    ["Z:/Assets/tiles/cobble_128x128.png", "tiles/cobble_128x128.png"],
    ["Z:/Assets/props/!!!.png", "props/!!!.png"], // empty-normalizing -> hash fallback must also match
  ];

  it.each(cases)("absolute and relative paths agree: %s == %s", (absolute, relative) => {
    expect(promoteKeyFromPath(absolute)).toBe(promoteKeyFromPath(relative));
  });
});

import { ASSET_BASIS_SCALE } from "./render-constants";

// 1440p-basis asset scale factor. Generic algorithm copied from the game's
// client/src/config/asset-scale.ts. In the game, the set of "authored-at-screen-resolution"
// assets is a runtime-promoted registry; the toolkit can't know a game's promoted set, so the
// template default is EMPTY — every asset resolves to factor 1 (no basis rescale). A game
// wires its real basis-asset set via `setBasisAssetKeys` (or replaces this module) so its
// large props render 1:1.

// Template default: empty. A game populates this with its promoted 1440p-basis asset keys.
const BASIS_ASSET_KEYS = new Set<string>();

/** Register the game's set of 1440p-basis asset keys (assets authored at screen resolution). */
export function setBasisAssetKeys(keys: Iterable<string>): void {
  BASIS_ASSET_KEYS.clear();
  for (const key of keys) BASIS_ASSET_KEYS.add(key);
}

export function assetBasisFactor(assetKey: string): number {
  return BASIS_ASSET_KEYS.has(assetKey) ? ASSET_BASIS_SCALE : 1;
}

export function assetRenderScale(assetKey: string, authoredScale: number | undefined): number {
  return (authoredScale ?? 1) * assetBasisFactor(assetKey);
}

export function authoredScaleFromImage(assetKey: string, imageScaleX: number): number {
  return imageScaleX / assetBasisFactor(assetKey);
}

import { z } from "zod";
import {
  AuthoredCollisionShape,
  LegacyPixelCollisionBox,
  PlacementOpacity,
  PlacementOrigin,
  PropReflectionSpec,
  PropShadowSpec,
} from "./zone";

// Editor asset-placement defaults + the merge algorithm the editor/zone-export use to resolve
// a placement's effective transform/collision. Copied faithfully from the game's
// shared/src/asset-placement.ts — the toolkit parses asset-editor-metadata.json against
// `AssetEditorMetadata` at runtime and calls `assetPlacementDefaultsFor`/`resolveAssetPlacement`.
// Generic editor machinery; the CONTENT it validates is game-authored.

export const AssetPlacementKind = z.enum(["prop", "decal", "tile", "sprite"]);

export const AssetSourceSize = z
  .object({
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .strict();

export const AssetPlacementDefaults = z
  .object({
    assetKey: z.string().min(1),
    bankAssetId: z.string().min(1).optional(),
    promotedRegistryKey: z.string().min(1).optional(),
    placementKind: AssetPlacementKind,
    sourceSize: AssetSourceSize.optional(),
    defaultScale: z.number().positive().optional(),
    origin: PlacementOrigin.optional(),
    rotation: z.number().optional(),
    opacity: PlacementOpacity.optional(),
    zIndex: z.number().int().optional(),
    collision: AuthoredCollisionShape.optional(),
    shadow: PropShadowSpec.optional(),
    reflection: PropReflectionSpec.optional(),
    placementTags: z.array(z.string().min(1)).optional(),
    placementNotes: z.string().min(1).optional(),
  })
  .strict();
export type AssetPlacementDefaults = z.infer<typeof AssetPlacementDefaults>;

export const PlacementClass = z
  .object({
    match: z.array(z.string().min(1)).min(1),
    priority: z.number().int().optional(),
    placementKind: AssetPlacementKind.optional(),
    collision: AuthoredCollisionShape.optional(),
    shadow: PropShadowSpec.optional(),
    origin: PlacementOrigin.optional(),
    notes: z.string().min(1).optional(),
  })
  .strict();
export type PlacementClass = z.infer<typeof PlacementClass>;

export const AssetEditorMetadata = z
  .object({
    schemaVersion: z.literal(1),
    placementClasses: z.record(PlacementClass).optional(),
    assets: z.record(AssetPlacementDefaults),
  })
  .strict()
  .superRefine((metadata, ctx) => {
    for (const [assetKey, defaults] of Object.entries(metadata.assets)) {
      if (assetKey !== defaults.assetKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["assets", assetKey, "assetKey"],
          message: `must match registry key "${assetKey}"`,
        });
      }
    }
  });
export type AssetEditorMetadata = z.infer<typeof AssetEditorMetadata>;

export type AssetPlacementOverride = {
  assetKey: string;
  scale?: number;
  origin?: z.infer<typeof PlacementOrigin>;
  rotation?: number;
  opacity?: z.infer<typeof PlacementOpacity>;
  zIndex?: number;
  collision?: z.infer<typeof AuthoredCollisionShape>;
  shadow?: z.infer<typeof PropShadowSpec>;
  reflection?: z.infer<typeof PropReflectionSpec>;
  legacyPixelCollision?: z.infer<typeof LegacyPixelCollisionBox>;
};

export type ResolvedAssetPlacement = {
  assetKey: string;
  placementKind?: z.infer<typeof AssetPlacementKind>;
  sourceSize?: z.infer<typeof AssetSourceSize>;
  scale: number;
  origin: z.infer<typeof PlacementOrigin>;
  rotation: number;
  opacity: z.infer<typeof PlacementOpacity>;
  zIndex?: number;
  collision?: z.infer<typeof AuthoredCollisionShape>;
  shadow?: z.infer<typeof PropShadowSpec>;
  reflection?: z.infer<typeof PropReflectionSpec>;
  legacyPixelCollision?: z.infer<typeof LegacyPixelCollisionBox>;
  placementTags?: string[];
  placementNotes?: string;
};

const DEFAULT_PROP_ORIGIN = { x: 0.5, y: 1 } as const;
const DEFAULT_DECAL_ORIGIN = { x: 0.5, y: 0.5 } as const;
const DEFAULT_TILE_ORIGIN = { x: 0, y: 0 } as const;

function defaultOriginFor(kind?: z.infer<typeof AssetPlacementKind>): z.infer<typeof PlacementOrigin> {
  if (kind === "decal") {
    return DEFAULT_DECAL_ORIGIN;
  }
  if (kind === "tile") {
    return DEFAULT_TILE_ORIGIN;
  }
  return DEFAULT_PROP_ORIGIN;
}

export function resolveAssetPlacement(
  placement: AssetPlacementOverride,
  defaults?: AssetPlacementDefaults,
): ResolvedAssetPlacement {
  return {
    assetKey: placement.assetKey,
    placementKind: defaults?.placementKind,
    sourceSize: defaults?.sourceSize,
    scale: placement.scale ?? defaults?.defaultScale ?? 1,
    origin: placement.origin ?? defaults?.origin ?? defaultOriginFor(defaults?.placementKind),
    rotation: placement.rotation ?? defaults?.rotation ?? 0,
    opacity: placement.opacity ?? defaults?.opacity ?? 1,
    zIndex: placement.zIndex ?? defaults?.zIndex,
    collision: placement.collision ?? defaults?.collision,
    shadow: placement.shadow ? { ...defaults?.shadow, ...placement.shadow } : defaults?.shadow,
    reflection: placement.reflection ? { ...defaults?.reflection, ...placement.reflection } : defaults?.reflection,
    legacyPixelCollision: placement.legacyPixelCollision,
    placementTags: defaults?.placementTags ? [...defaults.placementTags] : undefined,
    placementNotes: defaults?.placementNotes,
  };
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** The highest-priority placement class whose glob patterns match the asset key, if any. */
export function placementClassFor(
  metadata: AssetEditorMetadata,
  assetKey: string,
): PlacementClass | undefined {
  const classes = metadata.placementClasses;
  if (!classes) return undefined;
  let best: PlacementClass | undefined;
  let bestPriority = Number.NEGATIVE_INFINITY;
  let bestName = "";
  for (const [name, cls] of Object.entries(classes)) {
    if (!cls.match.some((glob) => globToRegExp(glob).test(assetKey))) continue;
    const priority = cls.priority ?? 0;
    if (priority > bestPriority || (priority === bestPriority && name < bestName) || best === undefined) {
      if (priority >= bestPriority) {
        best = cls;
        bestPriority = priority;
        bestName = name;
      }
    }
  }
  return best;
}

export function assetPlacementDefaultsFor(
  metadata: AssetEditorMetadata,
  assetKey: string,
): AssetPlacementDefaults | undefined {
  const own = metadata.assets[assetKey];
  const cls = placementClassFor(metadata, assetKey);
  if (!cls) return own;
  const base: AssetPlacementDefaults = {
    assetKey,
    placementKind: own?.placementKind ?? cls.placementKind ?? "prop",
  };
  const merged: AssetPlacementDefaults = { ...base, ...(own ?? {}) };
  merged.collision = own?.collision ?? cls.collision;
  merged.shadow = own?.shadow ?? cls.shadow;
  merged.origin = own?.origin ?? cls.origin;
  return merged;
}

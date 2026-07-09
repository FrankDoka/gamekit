import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  AssetEditorMetadata,
  assetPlacementDefaultsFor,
  AuthoredCollisionShape,
  DecalPlacement as DecalPlacementSchema,
  MapManifest,
  PropPlacement as PropPlacementSchema,
  resolveAssetPlacement,
  ZoneLayout,
} from "@gamekit/game-contract";
import type { z } from "zod";
import { assetBasisFactor } from "@gamekit/game-contract";

const ROOT = process.cwd();
const ZONES_DIR = join(ROOT, "content", "zones");
const MAPS_DIR = join(ROOT, "content", "maps");
const ASSET_EDITOR_METADATA_PATH = join(ROOT, "content", "asset-editor-metadata.json");

type DecalPlacement = z.infer<typeof DecalPlacementSchema>;
type PropPlacement = z.infer<typeof PropPlacementSchema>;
type SourceSize = { width: number; height: number };

const args = process.argv.slice(2);
const zoneArg = args.find((a) => a.startsWith("--zone="))?.split("=")[1];
const dryRun = args.includes("--dry-run");

function loadJson<T>(path: string, schema: z.ZodType<T>): T {
  const raw = readFileSync(path, "utf-8");
  return schema.parse(JSON.parse(raw));
}

function stableStringify(obj: unknown): string {
  return JSON.stringify(obj, null, 2) + "\n";
}

function sourceHash(raw: string): string {
  return createHash("sha256").update(raw.replace(/\r\n/g, "\n")).digest("hex");
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripUndefined(entry)) as T;
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) {
        output[key] = stripUndefined(entry);
      }
    }
    return output as T;
  }
  return value;
}

function loadAssetEditorMetadata(): AssetEditorMetadata {
  if (!existsSync(ASSET_EDITOR_METADATA_PATH)) {
    return { schemaVersion: 1, assets: {} };
  }
  return loadJson(ASSET_EDITOR_METADATA_PATH, AssetEditorMetadata);
}

function readPngSourceSize(path: string): SourceSize | undefined {
  if (!existsSync(path)) return undefined;
  const header = readFileSync(path).subarray(0, 24);
  const signature = header.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") return undefined;
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function loadPromotedSourceSizes(metadata: AssetEditorMetadata): Map<string, SourceSize> {
  const registryPath = join(ROOT, "client", "public", "assets", "promoted-registry.json");
  const output = new Map<string, SourceSize>();
  if (existsSync(registryPath)) {
    const raw = JSON.parse(readFileSync(registryPath, "utf-8")) as {
      promoted?: Record<string, { targetName?: unknown; targetPath?: unknown }>;
    };
    for (const entry of Object.values(raw.promoted ?? {})) {
      if (typeof entry.targetName !== "string") continue;
      const runtimeSize =
        typeof entry.targetPath === "string"
          ? readPngSourceSize(join(ROOT, "client", "public", entry.targetPath))
          : undefined;
      if (runtimeSize) {
        output.set(entry.targetName, runtimeSize);
      }
    }
  }
  for (const asset of Object.values(metadata.assets)) {
    if (
      asset.sourceSize &&
      asset.sourceSize.width > 0 &&
      asset.sourceSize.height > 0
    ) {
      output.set(asset.assetKey, asset.sourceSize);
    }
  }
  return output;
}

function compileDecalPlacement(decal: DecalPlacement, metadata: AssetEditorMetadata): DecalPlacement {
  const defaults = assetPlacementDefaultsFor(metadata, decal.assetKey);
  if (!defaults) {
    return decal;
  }

  const resolved = resolveAssetPlacement(decal, defaults);
  return stripUndefined({
    ...decal,
    scale: resolved.scale,
    origin: resolved.origin,
    rotation: resolved.rotation,
    opacity: resolved.opacity,
    zIndex: resolved.zIndex,
  });
}

function compilePropPlacement(prop: PropPlacement, metadata: AssetEditorMetadata): PropPlacement {
  const defaults = assetPlacementDefaultsFor(metadata, prop.assetKey);
  if (!defaults) {
    return prop;
  }

  const resolved = resolveAssetPlacement(prop, defaults);
  return stripUndefined({
    ...prop,
    scale: resolved.scale,
    origin: resolved.origin,
    rotation: resolved.rotation,
    opacity: resolved.opacity,
    zIndex: resolved.zIndex,
    collision: resolved.collision,
    shadow: resolved.shadow,
    reflection: resolved.reflection,
    legacyPixelCollision: resolved.legacyPixelCollision,
  });
}

// A blocking placement: anything with a resolved box footprint that mirrors the
// renderer's displayed size (props AND ore nodes — ore nodes render as network
// entities, not props, so they miss the compileProps path, but their footprint is
// authored the same way in asset-editor-metadata.json — lr5 ore collision).
type BlockingPlacement = {
  assetKey: string;
  x: number;
  y: number;
  scale?: number;
  origin?: { x: number; y: number };
  collision: z.infer<typeof AuthoredCollisionShape>;
};

function blockTilesFor(
  placement: BlockingPlacement,
  sourceSizes: Map<string, SourceSize>,
  tileSize: number,
  maxTileX: number,
  maxTileY: number,
  blocked: Set<string>,
): void {
  const collision = placement.collision;
  if (!collision || collision.mode !== "box" || !collision.blocksMovement) return;
  const sourceSize = sourceSizes.get(placement.assetKey);
  if (!sourceSize) return;
  const scale = placement.scale ?? 1;
  const origin = placement.origin ?? { x: 0.5, y: 1 };
  // Mirror the renderer EXACTLY: a 1440p-basis asset authors its pixels at
  // screen resolution (world px × 2.517) and renders DOWN by ASSET_BASIS_SCALE,
  // so its DISPLAYED world size = sourceSize × authoredScale × assetBasisFactor
  // (client/config/asset-scale.ts assetRenderScale). Collision must be built
  // from that displayed size, not the raw file pixels — otherwise every basis
  // prop's box is ~2.517× oversized and overhangs the sprite (owner walk
  // 2026-07-03: windmill/blossom/pockets). assetBasisFactor is 1 for legacy
  // (non-basis) assets, so their boxes are unchanged.
  const renderScale = scale * assetBasisFactor(placement.assetKey);
  const displayWidth = sourceSize.width * renderScale;
  const displayHeight = sourceSize.height * renderScale;
  const visualLeft = placement.x - displayWidth * origin.x;
  const visualTop = placement.y - displayHeight * origin.y;
  const left = visualLeft + (displayWidth * collision.xPct) / 100;
  const top = visualTop + (displayHeight * collision.yPct) / 100;
  const right = left + (displayWidth * collision.wPct) / 100;
  const bottom = top + (displayHeight * collision.hPct) / 100;
  if (right <= left || bottom <= top) return;

  const leftTile = Math.max(0, Math.floor(left / tileSize));
  const rightTile = Math.min(maxTileX, Math.floor((right - 1e-9) / tileSize));
  const topTile = Math.max(0, Math.floor(top / tileSize));
  const bottomTile = Math.min(maxTileY, Math.floor((bottom - 1e-9) / tileSize));
  for (let tileY = topTile; tileY <= bottomTile; tileY += 1) {
    for (let tileX = leftTile; tileX <= rightTile; tileX += 1) {
      blocked.add(`${tileX},${tileY}`);
    }
  }
}

function compileCollision(
  baseCollision: z.infer<typeof ZoneLayout>["collision"],
  bounds: z.infer<typeof ZoneLayout>["bounds"],
  props: PropPlacement[],
  oreNodes: z.infer<typeof ZoneLayout>["oreNodes"],
  metadata: AssetEditorMetadata,
  sourceSizes: Map<string, SourceSize>,
): z.infer<typeof ZoneLayout>["collision"] {
  const tileSize = baseCollision.tileSize;
  const blocked = new Set(baseCollision.blocked.map(([tileX, tileY]) => `${tileX},${tileY}`));
  const maxTileX = Math.ceil(bounds.width / tileSize) - 1;
  const maxTileY = Math.ceil(bounds.height / tileSize) - 1;

  for (const prop of props) {
    if (!prop.collision) continue;
    blockTilesFor(prop as BlockingPlacement, sourceSizes, tileSize, maxTileX, maxTileY, blocked);
  }

  // Ore nodes carry no collision field in the layout — resolve their footprint
  // from asset-editor-metadata.json (placement class or per-asset) by assetKey,
  // then block the base box exactly as props do (lr5: "ore should have collision").
  for (const node of oreNodes ?? []) {
    if (!node.assetKey) continue;
    const defaults = assetPlacementDefaultsFor(metadata, node.assetKey);
    if (!defaults?.collision) continue;
    blockTilesFor(
      { assetKey: node.assetKey, x: node.x, y: node.y, scale: node.scale, collision: defaults.collision },
      sourceSizes,
      tileSize,
      maxTileX,
      maxTileY,
      blocked,
    );
  }

  return {
    tileSize,
    blocked: [...blocked]
      .map((key) => key.split(",").map(Number) as [number, number])
      .sort((a, b) => a[1] - b[1] || a[0] - b[0]),
  };
}

if (!existsSync(ZONES_DIR)) {
  console.log("[zone:export] No content/zones/ directory — nothing to export.");
  process.exit(0);
}

const layoutFiles = readdirSync(ZONES_DIR).filter((f) => f.endsWith(".layout.json"));
if (layoutFiles.length === 0) {
  console.log("[zone:export] No .layout.json files found.");
  process.exit(0);
}

const targets = zoneArg
  ? layoutFiles.filter((f) => f === `${zoneArg}.layout.json`)
  : layoutFiles;

if (targets.length === 0) {
  console.error(`[zone:export] Layout not found for --zone=${zoneArg}`);
  process.exit(1);
}

let exported = 0;
const assetEditorMetadata = loadAssetEditorMetadata();
const promotedSourceSizes = loadPromotedSourceSizes(assetEditorMetadata);

for (const file of targets) {
  const layoutPath = join(ZONES_DIR, file);
  const layoutRaw = readFileSync(layoutPath, "utf-8");
  const layout = ZoneLayout.parse(JSON.parse(layoutRaw));
  const mapFile = `${layout.mapId}.json`;
  const mapPath = join(MAPS_DIR, mapFile);

  if (!existsSync(mapPath)) {
    console.error(`[zone:export] Map manifest not found: ${mapPath}`);
    process.exit(1);
  }

  const existingRaw = readFileSync(mapPath, "utf-8");
  const existing = MapManifest.parse(JSON.parse(existingRaw));

  const compiledProps = layout.props.map((prop) => compilePropPlacement(prop, assetEditorMetadata));
  const compiledDecals = layout.decals.map((decal) => compileDecalPlacement(decal, assetEditorMetadata));

  // Build compiled map manifest — spread layout data directly to preserve branded IDs
  const compiled = {
    schemaVersion: 1 as const,
    id: existing.id,
    nameKey: existing.nameKey,
    size: { width: layout.bounds.width, height: layout.bounds.height },
    spawnPoints: layout.spawnPoints.map(({ instanceId, id, x, y }) => ({ instanceId, id, x, y })),
    collision: compileCollision(
      layout.collision,
      layout.bounds,
      compiledProps,
      layout.oreNodes,
      assetEditorMetadata,
      promotedSourceSizes,
    ),
    portals: layout.portals.map((p) => p.portalId),
    portalPlacements: layout.portals,
    ...(layout.musicId ? { musicId: layout.musicId } : {}),
    visual: {
      ground: layout.ground,
      decals: compiledDecals,
      props: compiledProps,
    },
    placements: {
      npcs: layout.npcs,
      monsterSpawns: layout.monsterSpawns,
      ...(layout.chests?.length ? { chests: layout.chests } : {}),
      ...(layout.oreNodes?.length ? { oreNodes: layout.oreNodes } : {}),
    },
    compiledFrom: {
      path: `zones/${file}`,
      sourceHash: sourceHash(layoutRaw),
    },
  };

  // Validate compiled output
  MapManifest.parse(compiled);

  const output = stableStringify(compiled);

  if (dryRun) {
    const changed = output !== existingRaw;
    console.log(`[zone:export] ${mapFile}: ${changed ? "WOULD CHANGE" : "no change"}`);
    if (changed) {
      console.log(output);
    }
  } else {
    writeFileSync(mapPath, output);
    console.log(`[zone:export] ${mapFile}: exported from ${file}`);
  }
  exported++;
}

console.log(`[zone:export] Done — ${exported} map(s) ${dryRun ? "checked" : "exported"}.`);

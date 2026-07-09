import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { AssetEditorMetadata, ZoneLayout, MANIFEST_SCHEMAS, type ContentDir } from "@gamekit/game-contract";

const ROOT = process.cwd();
const ZONES_DIR = join(ROOT, "content", "zones");
const CONTENT_DIR = join(ROOT, "content");
const REGISTRY_PATH = join(ROOT, "client", "public", "assets", "promoted-registry.json");
const ASSET_EDITOR_METADATA_PATH = join(ROOT, "content", "asset-editor-metadata.json");

const errors: string[] = [];

type PromotedRegistryEntry = {
  targetName?: unknown;
  type?: unknown;
  basis?: unknown;
};

type PromotedRegistry = {
  promoted?: Record<string, PromotedRegistryEntry>;
};

function loadJsonDir(dir: ContentDir): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  const fullDir = join(CONTENT_DIR, dir);
  if (!existsSync(fullDir)) return map;
  const schema = MANIFEST_SCHEMAS[dir];
  for (const file of readdirSync(fullDir).filter((f) => f.endsWith(".json") && !f.includes(".layout."))) {
    const where = `${dir}/${file}`;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(join(fullDir, file), "utf-8"));
    } catch {
      errors.push(`${where}: invalid JSON`);
      continue;
    }
    // Schema-validate the manifest body against its @gamekit/game-contract schema so a
    // schema-invalid content file (missing/mistyped fields) fails here, not silently at
    // runtime. Existence-only checks below still need the id, so register it regardless.
    const result = schema.safeParse(data);
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push(`${where}: schema — ${issue.path.join(".")} ${issue.message}`);
      }
    }
    const record = data as Record<string, unknown>;
    if (typeof record.id === "string") {
      map.set(record.id, record);
    }
  }
  return map;
}

const maps = loadJsonDir("maps");
const monsters = loadJsonDir("monsters");
const npcs = loadJsonDir("npcs");
const portals = loadJsonDir("portals");

let promotedAssetKeys = new Set<string>();
let promotedRegistryKeys = new Set<string>();
const promotedEntriesByTargetName = new Map<string, PromotedRegistryEntry>();
if (existsSync(REGISTRY_PATH)) {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8")) as PromotedRegistry;
  promotedRegistryKeys = new Set(Object.keys(registry.promoted ?? {}));
  for (const entry of Object.values(registry.promoted ?? {})) {
    if (typeof entry.targetName === "string" && entry.targetName.length > 0) {
      promotedEntriesByTargetName.set(entry.targetName, entry);
    }
  }
  promotedAssetKeys = new Set(
    Object.values(registry.promoted ?? {})
      .map((entry) => entry.targetName)
      .filter((targetName): targetName is string => typeof targetName === "string" && targetName.length > 0)
  );
}

if (existsSync(ASSET_EDITOR_METADATA_PATH)) {
  const metadata = AssetEditorMetadata.safeParse(JSON.parse(readFileSync(ASSET_EDITOR_METADATA_PATH, "utf-8")));
  if (!metadata.success) {
    for (const issue of metadata.error.issues) {
      errors.push(`asset-editor-metadata.json: schema — ${issue.path.join(".")} ${issue.message}`);
    }
  } else {
    for (const [assetKey, defaults] of Object.entries(metadata.data.assets)) {
      if (promotedAssetKeys.size > 0 && !promotedAssetKeys.has(assetKey)) {
        errors.push(`asset-editor-metadata.json: assetKey "${assetKey}" not found in promoted-registry.json targetName values`);
      }
      if (defaults.promotedRegistryKey && !promotedRegistryKeys.has(defaults.promotedRegistryKey)) {
        errors.push(`asset-editor-metadata.json: promotedRegistryKey "${defaults.promotedRegistryKey}" not found in promoted-registry.json object keys`);
      }
    }
  }
}

// Report any manifest/metadata schema errors accumulated above even when there are no
// zone layouts to validate, so a schema-invalid content file can't slip through the
// "nothing to validate" early exit.
function reportAndExit(message: string): never {
  if (errors.length > 0) {
    console.error(`[zone:validate] FAILED with ${errors.length} error(s):\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(message);
  process.exit(0);
}

if (!existsSync(ZONES_DIR)) {
  reportAndExit("[zone:validate] No content/zones/ directory — nothing to validate.");
}

const layoutFiles = readdirSync(ZONES_DIR).filter((f) => f.endsWith(".layout.json"));
if (layoutFiles.length === 0) {
  reportAndExit("[zone:validate] No .layout.json files found — nothing to validate.");
}

for (const file of layoutFiles) {
  const where = `zones/${file}`;
  const raw = readFileSync(join(ZONES_DIR, file), "utf-8");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    errors.push(`${where}: invalid JSON`);
    continue;
  }

  const result = ZoneLayout.safeParse(data);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(`${where}: schema — ${issue.path.join(".")} ${issue.message}`);
    }
    continue;
  }

  const layout = result.data;

  // mapId must reference an existing map manifest
  if (!maps.has(layout.mapId)) {
    errors.push(`${where}: mapId "${layout.mapId}" not found in content/maps/`);
  }

  // Filename must match mapId
  const expectedFile = `${layout.mapId}.layout.json`;
  if (file !== expectedFile) {
    errors.push(`${where}: filename should be "${expectedFile}" to match mapId "${layout.mapId}"`);
  }

  // Collect all instanceIds for uniqueness check
  const instanceIds = new Set<string>();
  function checkInstanceId(id: string, section: string): void {
    if (instanceIds.has(id)) {
      errors.push(`${where}: duplicate instanceId "${id}" in ${section}`);
    }
    instanceIds.add(id);
  }

  // Layout assetKey is the runtime texture key, which matches promoted targetName.
  // The promoted registry object key is a separate source identity.
  function checkAssetKey(key: string, section: string): void {
    if (promotedAssetKeys.size > 0 && !promotedAssetKeys.has(key)) {
      errors.push(`${where}: ${section} assetKey "${key}" not found in promoted-registry.json targetName values`);
    }
  }

  function check1440pBasisScale(key: string, scale: number | undefined, section: string, instanceId: string): void {
    const entry = promotedEntriesByTargetName.get(key);
    if (entry?.basis !== "1440p-display-px") return;
    const authoredScale = scale ?? 1;
    if (Math.abs(authoredScale - 1) > 0.0001) {
      errors.push(
        `${where}: ${section} "${instanceId}" (${key}) is a 1440p-display-px promoted asset and must keep layout scale 1.0; runtime applies ASSET_BASIS_SCALE for texel-perfect 1440p display`,
      );
    }
  }

  for (const region of layout.ground) {
    checkInstanceId(region.instanceId, "ground");
    checkAssetKey(region.assetKey, "ground");
  }

  for (const decal of layout.decals) {
    checkInstanceId(decal.instanceId, "decals");
    checkAssetKey(decal.assetKey, "decals");
    check1440pBasisScale(decal.assetKey, decal.scale, "decals", decal.instanceId);
  }

  for (const prop of layout.props) {
    checkInstanceId(prop.instanceId, "props");
    checkAssetKey(prop.assetKey, "props");
    check1440pBasisScale(prop.assetKey, prop.scale, "props", prop.instanceId);
    // Shimmer/1:1 rule (zone-building-guide top section; D3-v2): props ship at exact
    // display px for the 1440p native-render basis and place at scale 1.0. A far-off
    // scale means an oversized master is being GPU-minified — the washed-out/mushy look
    // the owner keeps rejecting.
    const propScale = prop.scale ?? 1;
    if (propScale < 0.85 || propScale > 1.15) {
      errors.push(
        `${where}: props "${prop.instanceId}" (${prop.assetKey}) scale ${propScale} violates the 1440p-basis 1:1 rule — re-derive the PNG at display size (resize-prop.py) and place at 1.0`,
      );
    }
  }

  // NPC references
  for (const npc of layout.npcs) {
    checkInstanceId(npc.instanceId, "npcs");
    if (!npcs.has(npc.npcId)) {
      errors.push(`${where}: npcId "${npc.npcId}" not found in content/npcs/`);
    }
  }

  // Monster references
  for (const spawn of layout.monsterSpawns) {
    checkInstanceId(spawn.instanceId, "monsterSpawns");
    if (!monsters.has(spawn.monsterId)) {
      errors.push(`${where}: monsterId "${spawn.monsterId}" not found in content/monsters/`);
    }
  }

  // Portal references
  for (const portal of layout.portals) {
    checkInstanceId(portal.instanceId, "portals");
    if (!portals.has(portal.portalId)) {
      errors.push(`${where}: portalId "${portal.portalId}" not found in content/portals/`);
    }
  }

  // Spawn point IDs unique within layout
  const spawnIds = new Set<string>();
  for (const sp of layout.spawnPoints) {
    checkInstanceId(sp.instanceId, "spawnPoints");
    if (spawnIds.has(sp.id)) {
      errors.push(`${where}: duplicate spawnPoint id "${sp.id}"`);
    }
    spawnIds.add(sp.id);
  }

  console.log(`[zone:validate] ${where}: parsed OK (${layout.ground.length} ground, ${layout.decals.length} decals, ${layout.props.length} props, ${layout.npcs.length} npcs, ${layout.monsterSpawns.length} spawns, ${layout.portals.length} portals)`);
}

if (errors.length > 0) {
  console.error(`[zone:validate] FAILED with ${errors.length} error(s):\n  - ${errors.join("\n  - ")}`);
  process.exit(1);
}

console.log(`[zone:validate] OK — ${layoutFiles.length} layout(s) validated.`);

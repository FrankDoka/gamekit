import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assetsMetadataRoot } from "./toolkit-config.js";

type JsonRecord = Record<string, unknown>;

export type RepointRegistryEntry = {
  assetId?: string;
  sourcePath?: string;
  targetPath?: string;
  targetName?: string;
};

export type EntityRepointChange = {
  entityId: string;
  slot: string;
  from: string;
  to: string;
  registryKey: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export function repointEntityProfiles(
  profiles: JsonRecord,
  promoted: Record<string, RepointRegistryEntry>,
  options: { sourceAssetId?: string; sourcePath?: string } = {},
): { profiles: JsonRecord; changes: EntityRepointChange[] } {
  const entities = isRecord(profiles.entities) ? profiles.entities : {};
  const entries = Object.entries(promoted);
  const changes: EntityRepointChange[] = [];

  for (const [entityId, entity] of Object.entries(entities)) {
    if (!isRecord(entity)) continue;
    const slots = isRecord(entity.slots) ? entity.slots : {};
    for (const [slot, slotValue] of Object.entries(slots)) {
      if (!isRecord(slotValue)) continue;
      const current = typeof slotValue.assetId === "string" ? slotValue.assetId : "";
      if (!current) continue;
      const match = entries.find(([, entry]) => {
        if (!entry.targetPath) return false;
        if (options.sourceAssetId && current === options.sourceAssetId && entry.assetId === options.sourceAssetId) return true;
        if (options.sourcePath && current === options.sourcePath && entry.sourcePath === options.sourcePath) return true;
        return current === entry.assetId || current === entry.sourcePath;
      });
      if (!match) continue;
      const [registryKey, entry] = match;
      const targetPath = entry.targetPath;
      if (!targetPath || current === targetPath) continue;
      slotValue.assetId = targetPath;
      slotValue.status = "reviewed";
      slotValue.promoted = true;
      slotValue.runtimeTargetPath = targetPath;
      if (entry.targetName) slotValue.runtimeTargetName = entry.targetName;
      slotValue.previousAssetId = current;
      changes.push({ entityId, slot, from: current, to: targetPath, registryKey });
    }
  }

  profiles.generated_at = new Date().toISOString();
  return { profiles, changes };
}

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(argValue("--repo-root") ?? ".");
  const metadataRoot = path.resolve(argValue("--metadata-root") ?? assetsMetadataRoot());
  const profilesPath = path.resolve(argValue("--profiles") ?? path.join(metadataRoot, "_review", "entity-profiles.json"));
  const registryPath = path.resolve(argValue("--registry") ?? path.join(repoRoot, "client", "public", "assets", "promoted-registry.json"));
  const apply = process.argv.includes("--apply");
  const json = process.argv.includes("--json");
  const profiles = await readJson<JsonRecord>(profilesPath, { entities: {} });
  const registry = await readJson<{ promoted?: Record<string, RepointRegistryEntry> }>(registryPath, { promoted: {} });
  const result = repointEntityProfiles(profiles, registry.promoted ?? {});
  if (apply && result.changes.length) await writeJson(profilesPath, result.profiles);
  const payload = { ok: true, apply, profilesPath, registryPath, changes: result.changes, changed: result.changes.length };
  if (json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else {
    console.log(`${apply ? "Repointed" : "Would repoint"} ${result.changes.length} entity-profile binding(s).`);
    for (const change of result.changes) {
      console.log(`- ${change.entityId}.${change.slot}: ${change.from} -> ${change.to}`);
    }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url && existsSync(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

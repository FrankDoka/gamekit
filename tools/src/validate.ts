import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import type { z } from "zod";
import {
  AssetEditorMetadata,
  MANIFEST_SCHEMAS,
  EconomyTuningManifest,
  EventScheduleManifest,
  checkGoldRangesAgainstSheet,
  type ContentDir,
  type MonsterRank,
} from "@gamekit/game-contract";
import { renderAnimationClientModule } from "./animation-sync-client";
import { HOT_DOC_BUDGETS, estimateTokens, findStaleHotDocNotes, largestMarkdownSections } from "./docs-hygiene";
import { verifyDigestAnchors } from "./lane-digest";

// Real validation v0 (RFC §5): typecheck runs separately (`pnpm -r typecheck`); this script does
// manifest parse + ID uniqueness + referential integrity + filename=ID + manifest-path integrity
// + docs link integrity. Exits non-zero on any failure.

const ROOT = process.cwd();
const CONTENT = join(ROOT, "content");
const DOCS = join(ROOT, "docs");
const SPRITES = join(ROOT, "client", "public", "assets", "sprites");
const PROMOTED_REGISTRY = join(ROOT, "client", "public", "assets", "promoted-registry.json");
const ASSET_EDITOR_METADATA = join(CONTENT, "asset-editor-metadata.json");

// Optional absolute-doc-root prefix (e.g. "Z:/MyGame") that a game uses in its markdown
// links; when set, such links are resolved against ROOT. Unset = the toolkit's own docs
// use only relative links, so no special case is applied.
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const absDocRoot = process.env.GAME_DOCS_ABS_ROOT?.trim();
// Match either separator regardless of how the prefix was written by splitting on / or \.
const absDocRootRe = absDocRoot
  ? new RegExp(`^${absDocRoot.split(/[\\/]/).map(escapeRe).join("[\\\\/]")}[\\\\/](.*)$`, "i")
  : null;

const errors: string[] = [];
const warnings: string[] = [];
const fail = (msg: string): void => {
  errors.push(msg);
};
const warn = (msg: string): void => {
  warnings.push(msg);
};

type Loaded = { dir: ContentDir; file: string; id: string; data: Record<string, unknown> };
type PromotedRegistryEntry = {
  targetName?: unknown;
};
type PromotedRegistry = {
  promoted?: Record<string, PromotedRegistryEntry>;
};

// ---- load + schema parse + filename=ID + uniqueness ----
const loaded: Loaded[] = [];
const idsSeen = new Map<string, string>();
const byType: Record<string, Set<string>> = {};

for (const dir of Object.keys(MANIFEST_SCHEMAS) as ContentDir[]) {
  byType[dir] = new Set();
  const dirPath = join(CONTENT, dir);
  if (!existsSync(dirPath)) continue;
  for (const file of readdirSync(dirPath)) {
    if (!file.endsWith(".json")) continue;
    const full = join(dirPath, file);
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(full, "utf8"));
    } catch (e) {
      fail(`json: content/${dir}/${file} -> ${(e as Error).message}`);
      continue;
    }
    const schema = MANIFEST_SCHEMAS[dir] as z.ZodTypeAny;
    const res = schema.safeParse(json);
    if (!res.success) {
      for (const issue of res.error.issues) {
        fail(`schema: content/${dir}/${file} -> ${issue.path.join(".") || "(root)"}: ${issue.message}`);
      }
      continue;
    }
    const data = res.data as Record<string, unknown> & { id: string };
    const id = data.id;
    const expected = `${id}.json`;
    if (file !== expected) {
      fail(`filename: content/${dir}/${file} has id "${id}"; file should be "${expected}"`);
    }
    const where = `content/${dir}/${file}`;
    if (dir === "skill-nodes") {
      if (byType[dir].has(id)) fail(`duplicate id "${id}" in ${where} and another content/${dir} manifest`);
    } else {
      const prior = idsSeen.get(id);
      if (prior) fail(`duplicate id "${id}" in ${where} and ${prior}`);
      else idsSeen.set(id, where);
    }
    byType[dir].add(id);
    loaded.push({ dir, file, id, data });
  }
}

const promotedRegistryKeys = new Set<string>();
const promotedTargetNames = new Set<string>();
if (existsSync(PROMOTED_REGISTRY)) {
  try {
    const registry = JSON.parse(readFileSync(PROMOTED_REGISTRY, "utf8")) as PromotedRegistry;
    for (const [registryKey, entry] of Object.entries(registry.promoted ?? {})) {
      promotedRegistryKeys.add(registryKey);
      if (typeof entry.targetName === "string" && entry.targetName.length > 0) {
        promotedTargetNames.add(entry.targetName);
      }
    }
  } catch (e) {
    fail(`json: client/public/assets/promoted-registry.json -> ${(e as Error).message}`);
  }
}

if (existsSync(ASSET_EDITOR_METADATA)) {
  try {
    const parsed = AssetEditorMetadata.safeParse(JSON.parse(readFileSync(ASSET_EDITOR_METADATA, "utf8")));
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        fail(`schema: content/asset-editor-metadata.json -> ${issue.path.join(".") || "(root)"}: ${issue.message}`);
      }
    } else {
      for (const [assetKey, defaults] of Object.entries(parsed.data.assets)) {
        if (!promotedTargetNames.has(assetKey)) {
          fail(`ref: content/asset-editor-metadata.json assets.${assetKey} -> not found in promoted-registry.json targetName values`);
        }
        if (defaults.promotedRegistryKey && !promotedRegistryKeys.has(defaults.promotedRegistryKey)) {
          fail(`ref: content/asset-editor-metadata.json assets.${assetKey}.promotedRegistryKey -> unknown registry key "${defaults.promotedRegistryKey}"`);
        }
      }
    }
  } catch (e) {
    fail(`json: content/asset-editor-metadata.json -> ${(e as Error).message}`);
  }
}

const has = (dir: ContentDir, id: string): boolean => byType[dir]?.has(id) ?? false;
const getLoaded = (dir: ContentDir, id: string): Loaded | undefined => loaded.find((l) => l.dir === dir && l.id === id);
const isInsideMapBounds = (x: number, y: number, map: Record<string, unknown>): boolean => {
  const size = map.size as { width: number; height: number };
  return x >= 0 && x <= size.width && y >= 0 && y <= size.height;
};

// ---- referential integrity ----
for (const { dir, file, data } of loaded) {
  const where = `content/${dir}/${file}`;
  if (dir === "maps") {
    const seenPortalIds = new Set<string>();
    for (const p of data.portals as string[]) {
      if (!has("portals", p)) fail(`ref: ${where} portals -> unknown portal "${p}"`);
      if (seenPortalIds.has(p)) fail(`ref: ${where} portals contains duplicate portal "${p}"`);
      seenPortalIds.add(p);
      const portal = getLoaded("portals", p);
      if (portal && portal.data.sourceMapId !== data.id) {
        fail(`ref: ${where} lists portal "${p}" but its sourceMapId is "${portal.data.sourceMapId}"`);
      }
    }
    const spawnIds = new Set<string>();
    for (const spawn of data.spawnPoints as { id: string; x: number; y: number }[]) {
      if (spawnIds.has(spawn.id)) fail(`ref: ${where} spawnPoints contains duplicate spawn "${spawn.id}"`);
      spawnIds.add(spawn.id);
      if (!isInsideMapBounds(spawn.x, spawn.y, data)) {
        fail(`bounds: ${where} spawn "${spawn.id}" is outside map bounds (${spawn.x}, ${spawn.y})`);
      }
    }
  } else if (dir === "portals") {
    const sourceMapId = data.sourceMapId as string;
    const targetMapId = data.targetMapId as string;
    const targetSpawnId = data.targetSpawnId as string;
    if (!has("maps", sourceMapId)) fail(`ref: ${where} sourceMapId -> unknown map "${sourceMapId}"`);
    if (!has("maps", targetMapId)) fail(`ref: ${where} targetMapId -> unknown map "${targetMapId}"`);
    const sourceMap = getLoaded("maps", sourceMapId);
    if (sourceMap) {
      const sourcePortals = sourceMap.data.portals as string[];
      if (!sourcePortals.includes(data.id as string)) {
        fail(`ref: ${where} is not listed in source map ${sourceMapId}.portals`);
      }
      const shape = data.shape as { type: string; x?: number; y?: number } | undefined;
      if (shape && shape.x != null && shape.y != null) {
        if (!isInsideMapBounds(shape.x, shape.y, sourceMap.data)) {
          fail(`bounds: ${where} trigger is outside source map bounds (${shape.x}, ${shape.y})`);
        }
      }
    }
    const targetMap = getLoaded("maps", targetMapId);
    if (targetMap) {
      const spawns = (targetMap.data.spawnPoints as { id: string }[]).map((s) => s.id);
      if (!spawns.includes(targetSpawnId)) {
        fail(`ref: ${where} targetSpawnId "${targetSpawnId}" not a spawn in ${targetMapId}`);
      }
    }
  } else if (dir === "monsters") {
    const lootTableId = data.lootTableId as string;
    const spawn = data.spawn as { mapId: string } | undefined;
    if (!has("loot", lootTableId)) fail(`ref: ${where} lootTableId -> unknown loot table "${lootTableId}"`);
    if (spawn && !has("maps", spawn.mapId)) fail(`ref: ${where} spawn.mapId -> unknown map "${spawn.mapId}"`);
  } else if (dir === "loot") {
    for (const entry of data.entries as { itemId: string; min: number; max: number }[]) {
      if (!has("items", entry.itemId)) fail(`ref: ${where} entries -> unknown item "${entry.itemId}"`);
      if (entry.min > entry.max) fail(`ref: ${where} entry "${entry.itemId}" has min ${entry.min} greater than max ${entry.max}`);
    }
  } else if (dir === "classes") {
    const startingSkillId = data.startingSkillId as string;
    if (!has("skills", startingSkillId)) fail(`ref: ${where} startingSkillId -> unknown skill "${startingSkillId}"`);
    const advancesFrom = data.advancesFrom as string | undefined;
    const requirementQuestId = (data.requirements as { questId?: string } | undefined)?.questId;
    if (advancesFrom && !has("classes", advancesFrom)) fail(`ref: ${where} advancesFrom -> unknown class "${advancesFrom}"`);
    if (requirementQuestId && !has("quests", requirementQuestId)) fail(`ref: ${where} requirements.questId -> unknown quest "${requirementQuestId}"`);
  } else if (dir === "skill-nodes") {
    const skillId = data.id as string;
    const classId = data.classId as string;
    if (!has("skills", skillId)) fail(`ref: ${where} id -> unknown skill "${skillId}"`);
    if (!has("classes", classId)) fail(`ref: ${where} classId -> unknown class "${classId}"`);
    for (const prerequisite of (data.prerequisites ?? []) as { type: string; targetId: string }[]) {
      if (prerequisite.type === "skill" && !has("skills", prerequisite.targetId)) {
        fail(`ref: ${where} prerequisites -> unknown skill "${prerequisite.targetId}"`);
      }
    }
    for (const unlock of (data.unlocks ?? []) as string[]) {
      if (!has("skills", unlock)) fail(`ref: ${where} unlocks -> unknown skill "${unlock}"`);
    }
  } else if (dir === "npcs") {
    const mapId = data.mapId as string | undefined;
    const questId = data.questId as string | undefined;
    const questIds = data.questIds as string[] | undefined;
    if (mapId && !has("maps", mapId)) fail(`ref: ${where} mapId -> unknown map "${mapId}"`);
    if (questId && !has("quests", questId)) fail(`ref: ${where} questId -> unknown quest "${questId}"`);
    for (const chainedQuestId of questIds ?? []) {
      if (!has("quests", chainedQuestId)) fail(`ref: ${where} questIds -> unknown quest "${chainedQuestId}"`);
    }
    if (mapId) {
      const npcMap = getLoaded("maps", mapId);
      if (npcMap && !isInsideMapBounds(data.x as number, data.y as number, npcMap.data)) {
        fail(`bounds: ${where} position is outside map bounds (${data.x}, ${data.y})`);
      }
    }
    for (const item of (data.shopItems ?? []) as { itemId: string }[]) {
      if (!has("items", item.itemId)) fail(`ref: ${where} shopItems -> unknown item "${item.itemId}"`);
    }
  } else if (dir === "quests") {
    const kind = data.kind as string;
    for (const prereqQuestId of (data.prereqQuestIds ?? []) as string[]) {
      if (!has("quests", prereqQuestId)) fail(`ref: ${where} prereqQuestIds -> unknown quest "${prereqQuestId}"`);
    }
    if (kind === "kill") {
      const targetMonsterId = data.targetMonsterId as string;
      if (!has("monsters", targetMonsterId)) {
        fail(`ref: ${where} targetMonsterId -> unknown monster "${targetMonsterId}"`);
      }
    } else if (kind === "talk") {
      const targetNpcId = data.targetNpcId as string;
      if (!has("npcs", targetNpcId)) fail(`ref: ${where} targetNpcId -> unknown NPC "${targetNpcId}"`);
    } else if (kind === "collect") {
      const targetItemId = data.targetItemId as string;
      if (!has("items", targetItemId)) fail(`ref: ${where} targetItemId -> unknown item "${targetItemId}"`);
    } else if (kind === "stage-clear") {
      const targetStageId = data.targetStageId as string;
      if (!has("stages", targetStageId)) fail(`ref: ${where} targetStageId -> unknown stage "${targetStageId}"`);
    }
    const questNpc = loaded.find((l) => l.dir === "npcs" && getManifestQuestIds(l.data).includes(data.id as string));
    if (!questNpc) fail(`ref: ${where} has no NPC with questId "${data.id}"`);
    const targetMonsterId = data.targetMonsterId as string | undefined;
    const targetMonster = targetMonsterId ? getLoaded("monsters", targetMonsterId) : undefined;
    if (questNpc && targetMonster) {
      const questMapId = questNpc.data.mapId as string | undefined;
      const monsterMapId = (targetMonster.data.spawn as { mapId: string } | undefined)?.mapId;
      if (questMapId && monsterMapId) {
        const questMap = getLoaded("maps", questMapId);
        if (questMap && questMapId !== monsterMapId) {
          const reachablePortal = (questMap.data.portals as string[]).some((portalId) => getLoaded("portals", portalId)?.data.targetMapId === monsterMapId);
          if (!reachablePortal) warn(`quest route: ${where} starts at ${questMapId}, target monster spawns on ${monsterMapId}, and no direct portal links those maps`);
        }
      }
    }
  } else if (dir === "events") {
    const mapId = data.mapId as string | undefined;
    const modifiers = data.modifiers as { bonusLootTableId?: string } | undefined;
    const bonusLootTableId = modifiers?.bonusLootTableId;
    if (mapId && !has("maps", mapId)) fail(`ref: ${where} mapId -> unknown map "${mapId}"`);
    if (bonusLootTableId && !has("loot", bonusLootTableId)) {
      fail(`ref: ${where} modifiers.bonusLootTableId -> unknown loot table "${bonusLootTableId}"`);
    }
  }
}

for (const cycle of findQuestPrereqCycles(loaded.filter((l) => l.dir === "quests"))) {
  fail(`ref: quest prereq cycle -> ${cycle.join(" -> ")}`);
}
for (const cycle of findClassAdvancementCycles(loaded.filter((l) => l.dir === "classes"))) {
  fail(`ref: class advancement cycle -> ${cycle.join(" -> ")}`);
}

function getManifestQuestIds(npc: { questId?: unknown; questIds?: unknown }): string[] {
  if (Array.isArray(npc.questIds)) return npc.questIds.filter((questId): questId is string => typeof questId === "string");
  return typeof npc.questId === "string" ? [npc.questId] : [];
}

function findQuestPrereqCycles(quests: Loaded[]): string[][] {
  const graph = new Map<string, string[]>(
    quests.map((quest) => [
      quest.id,
      Array.isArray(quest.data.prereqQuestIds)
        ? quest.data.prereqQuestIds.filter((questId): questId is string => typeof questId === "string")
        : [],
    ]),
  );
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (questId: string): void => {
    if (visited.has(questId)) return;
    if (visiting.has(questId)) {
      const start = path.indexOf(questId);
      cycles.push([...path.slice(Math.max(0, start)), questId]);
      return;
    }
    visiting.add(questId);
    path.push(questId);
    for (const prereqQuestId of graph.get(questId) ?? []) {
      if (graph.has(prereqQuestId)) visit(prereqQuestId);
    }
    path.pop();
    visiting.delete(questId);
    visited.add(questId);
  };

  for (const questId of graph.keys()) visit(questId);
  return cycles;
}

function findClassAdvancementCycles(classes: Loaded[]): string[][] {
  const graph = new Map<string, string[]>(
    classes.map((cls) => [
      cls.id,
      typeof cls.data.advancesFrom === "string" ? [cls.data.advancesFrom] : [],
    ]),
  );
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (classId: string): void => {
    if (visited.has(classId)) return;
    if (visiting.has(classId)) {
      const start = path.indexOf(classId);
      cycles.push([...path.slice(Math.max(0, start)), classId]);
      return;
    }
    visiting.add(classId);
    path.push(classId);
    for (const sourceClassId of graph.get(classId) ?? []) {
      if (graph.has(sourceClassId)) visit(sourceClassId);
    }
    path.pop();
    visiting.delete(classId);
    visited.add(classId);
  };

  for (const classId of graph.keys()) visit(classId);
  return cycles;
}

// ---- economy tuning sheet: singleton + range gates + gold consumer cross-check ----
// The single economy NUMBER source (solo-scale-doctrine.md §10). Not part of
// MANIFEST_SCHEMAS (that loop is per-directory multi-file with a shared shape);
// this is a SINGLETON with cross-field range rules, so it is validated here.
const ECONOMY_DIR = join(CONTENT, "economy");
if (existsSync(ECONOMY_DIR)) {
  const economyFiles = readdirSync(ECONOMY_DIR).filter((f) => f.endsWith(".json"));
  if (economyFiles.length !== 1) {
    fail(`economy: content/economy must contain exactly one tuning sheet, found ${economyFiles.length} (singleton rule)`);
  }
  if (economyFiles.length === 1) {
    const file = economyFiles[0]!;
    let raw: unknown;
    let parseOk = false;
    try {
      raw = JSON.parse(readFileSync(join(ECONOMY_DIR, file), "utf8"));
      parseOk = true;
    } catch (e) {
      fail(`json: content/economy/${file} -> ${(e as Error).message}`);
    }
    if (parseOk) {
      const res = EconomyTuningManifest.safeParse(raw);
      if (!res.success) {
        for (const issue of res.error.issues) {
          fail(`economy: content/economy/${file} -> ${issue.path.join(".") || "(root)"}: ${issue.message}`);
        }
      } else {
        const sheet = res.data;
        // Canonical path is the fixed singleton content/economy/tuning.json
        // (solo-scale-doctrine.md §10). The id literal is `economy_tuning`
        // (ECONOMY_TUNING_ID) and is enforced by the schema; the filename is
        // the doctrine-named `tuning.json` rather than filename=id, because
        // there is exactly one file (the singleton guard above) — no id-to-file
        // ambiguity to protect against.
        if (file !== "tuning.json") {
          fail(`economy: the tuning sheet must be content/economy/tuning.json, found content/economy/${file}`);
        }
        // Consumer cross-check: loot-table gold entries must fall inside the
        // sheet's rank band. Loot tables stay the single SPAWN source; the sheet
        // is the single NUMBER source. Drift FAILS validate.
        const monsters = loaded
          .filter((l) => l.dir === "monsters")
          .map((l) => ({
            id: l.id,
            rank: ((l.data.rank as MonsterRank | undefined) ?? "normal"),
            lootTableId: l.data.lootTableId as string,
          }));
        const lootTables = loaded
          .filter((l) => l.dir === "loot")
          .map((l) => ({
            id: l.id,
            entries: (l.data.entries as { itemId: string; min: number; max: number }[]),
          }));
        for (const err of checkGoldRangesAgainstSheet({ sheet, goldItemId: "item_gold", monsters, lootTables })) {
          fail(`economy: ${err}`);
        }
      }
    }
  }
} else {
  fail("economy: content/economy is missing — the tuning sheet is required (solo-scale-doctrine.md §10)");
}

// ---- event schedule singleton: shape + pool referential integrity ----
// The event-rotation schedule (card-events-v2-scheduler, S24) is a SINGLETON
// config, NOT a per-template manifest, so it lives OUTSIDE content/events/ at
// content/event-schedule/schedule.json and is validated here. It is optional
// (absent = no auto-rotation); when present it must parse and every pool eventId
// must resolve to a loaded event template.
const EVENT_SCHEDULE_DIR = join(CONTENT, "event-schedule");
if (existsSync(EVENT_SCHEDULE_DIR)) {
  const scheduleFiles = readdirSync(EVENT_SCHEDULE_DIR).filter((f) => f.endsWith(".json"));
  if (scheduleFiles.length !== 1) {
    fail(`events: content/event-schedule must contain exactly one schedule file, found ${scheduleFiles.length} (singleton rule)`);
  }
  if (scheduleFiles.length === 1) {
    const file = scheduleFiles[0]!;
    if (file !== "schedule.json") {
      fail(`events: the schedule must be content/event-schedule/schedule.json, found content/event-schedule/${file}`);
    }
    let raw: unknown;
    let parseOk = false;
    try {
      raw = JSON.parse(readFileSync(join(EVENT_SCHEDULE_DIR, file), "utf8"));
      parseOk = true;
    } catch (e) {
      fail(`json: content/event-schedule/${file} -> ${(e as Error).message}`);
    }
    if (parseOk) {
      const res = EventScheduleManifest.safeParse(raw);
      if (!res.success) {
        for (const issue of res.error.issues) {
          fail(`events: content/event-schedule/${file} -> ${issue.path.join(".") || "(root)"}: ${issue.message}`);
        }
      } else {
        for (const [i, entry] of res.data.pool.entries()) {
          if (!has("events", entry.eventId)) {
            fail(`ref: content/event-schedule/${file} pool[${i}].eventId -> unknown event "${entry.eventId}"`);
          }
        }
      }
    }
  }
}

// ---- sprite ↔ manifest integrity ----
const animationSpriteFiles = new Set<string>();
const ASSET_INDEX = join(ROOT, "client", "public", "assets", "index.json");
if (existsSync(ASSET_INDEX)) {
  try {
    const index = JSON.parse(readFileSync(ASSET_INDEX, "utf8")) as { animations?: Record<string, { path?: string }> };
    for (const animation of Object.values(index.animations ?? {})) {
      if (animation.path) animationSpriteFiles.add(animation.path.split(/[\\/]/).pop() ?? "");
    }
  } catch (e) {
    fail(`json: client/public/assets/index.json -> ${(e as Error).message}`);
  }
}
if (existsSync(SPRITES)) {
  for (const file of readdirSync(SPRITES)) {
    if (!file.startsWith("monster_") || !file.endsWith(".png")) continue;
    if (animationSpriteFiles.has(file)) continue;
    const monsterId = file.slice(0, -".png".length);
    if (!has("monsters", monsterId)) {
      fail(`sprite: client/public/assets/sprites/${file} has no content/monsters/${monsterId}.json`);
    }
  }
}

// ---- manifest path integrity: any path-like string value must resolve (content + reference/**) ----
// `source_video` is intentionally external/non-durable (the reference manifest documents this).
const EXCLUDE_PATH_KEYS = new Set(["source_video"]);

const walkPaths = (value: unknown, where: string): void => {
  if (typeof value === "string") {
    if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("./") || value.startsWith("../")) {
      const abs = /^[A-Za-z]:[\\/]/.test(value) ? value : resolve(ROOT, value);
      if (!existsSync(abs)) fail(`path: ${where} references missing path "${value}"`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) walkPaths(v, where);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (EXCLUDE_PATH_KEYS.has(k)) continue;
      walkPaths(v, where);
    }
  }
};

// content manifests
for (const { dir, file, data } of loaded) walkPaths(data, `content/${dir}/${file}`);

// reference/** JSON manifests (RFC §5.8): all path-like values must resolve.
const REFERENCE = join(ROOT, "reference");
const refJsonFiles: string[] = [];
const collectJson = (d: string): void => {
  if (!existsSync(d)) return;
  for (const entry of readdirSync(d)) {
    const full = join(d, entry);
    if (statSync(full).isDirectory()) collectJson(full);
    else if (entry.endsWith(".json")) refJsonFiles.push(full);
  }
};
collectJson(REFERENCE);
for (const jf of refJsonFiles) {
  try {
    walkPaths(JSON.parse(readFileSync(jf, "utf8")), relative(ROOT, jf));
  } catch (e) {
    fail(`json: ${relative(ROOT, jf)} -> ${(e as Error).message}`);
  }
}

// ---- docs link integrity ----
const mdFiles: string[] = [];
const collectMd = (d: string): void => {
  if (!existsSync(d)) return;
  for (const entry of readdirSync(d)) {
    const full = join(d, entry);
    if (statSync(full).isDirectory()) collectMd(full);
    else if (entry.endsWith(".md")) mdFiles.push(full);
  }
};
collectMd(DOCS);
for (const f of ["README.md", "AGENTS.md", "CLAUDE.md"]) {
  const full = join(ROOT, f);
  if (existsSync(full)) mdFiles.push(full);
}

const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
for (const md of mdFiles) {
  const text = readFileSync(md, "utf8");
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(text)) !== null) {
    const raw = m[1].trim();
    let target = raw.split(/\s+/)[0];
    if (!target || /^(https?:|mailto:|#)/i.test(target)) continue;
    target = target.split("#")[0];
    if (!target) continue;
    // Some games write docs links as an absolute `<repo root>/...` path; resolve those
    // against the actual repo root so the check stays portable (CI runners have no such
    // drive — the absolute convention made CI red until it was resolved this way). The
    // game names its absolute-doc-root prefix via GAME_DOCS_ABS_ROOT.
    const zRoot = absDocRootRe?.exec(target) ?? null;
    const abs = zRoot
      ? join(ROOT, zRoot[1])
      : /^[A-Za-z]:[\\/]/.test(target)
        ? target
        : resolve(dirname(md), target);
    // reference/ is intentionally local-only (not pushed to the remote); when the whole
    // directory is absent (CI checkout), links into it are unverifiable, not broken.
    if (!existsSync(join(ROOT, "reference")) && resolve(abs).startsWith(resolve(ROOT, "reference"))) continue;
    if (!existsSync(abs)) fail(`docs link: ${relative(ROOT, md)} -> broken link "${raw}"`);
  }
}


// ---- active-session/worktree drift ----
// Moved to sessions-sync.ts --check (runs as a separate validate step via `pnpm sessions:check`).
// That tool compares the generated roster markers against git worktree list + .session-card files
// and exits non-zero on drift.
// ---- generated animation runtime config drift check ----
const ANIMATION_INDEX = join(ROOT, "client/public/assets/index.json");
const GENERATED_ANIMATION_CONFIG = join(ROOT, "client/src/config/animation-assets.ts");
if (existsSync(ANIMATION_INDEX) || existsSync(GENERATED_ANIMATION_CONFIG)) {
  if (!existsSync(ANIMATION_INDEX)) {
    fail("animation index: missing client/public/assets/index.json");
  } else if (!existsSync(GENERATED_ANIMATION_CONFIG)) {
    fail("animation index: missing generated client/src/config/animation-assets.ts; run pnpm animation-sync-client");
  } else {
    try {
      const index = JSON.parse(readFileSync(ANIMATION_INDEX, "utf8"));
      const expected = renderAnimationClientModule(index);
      // Normalize CRLF so a Windows checkout (core.autocrlf) does not trip the byte comparison.
      const actual = readFileSync(GENERATED_ANIMATION_CONFIG, "utf8").replace(/\r\n/g, "\n");
      if (actual !== expected) {
        fail("animation index: client/src/config/animation-assets.ts is stale; run pnpm animation-sync-client");
      }
      if (typeof index === "object" && index && typeof (index as { animations?: unknown }).animations === "object") {
        for (const [animationId, animation] of Object.entries((index as { animations: Record<string, unknown> }).animations)) {
          if (!animation || typeof animation !== "object") continue;
          const spritePath = (animation as { path?: unknown }).path;
          if (typeof spritePath !== "string" || spritePath.length === 0) continue;
          const sidecarPath = join(ROOT, "client", "public", "assets", spritePath + ".anchors.json");
          if (!existsSync(sidecarPath)) {
            warn(
              `animation anchors: ${animationId} is missing ${relative(ROOT, sidecarPath).replace(/\\/g, "/")} ` +
                "(WARN now; becomes blocking when the attachment renderer lands)",
            );
          }
        }
      }
    } catch (e) {
      fail(`animation index: ${(e as Error).message}`);
    }
  }
}

// ---- cold-start context hygiene warnings (non-failing) ----
for (const [relPath, maxTokens] of Object.entries(HOT_DOC_BUDGETS)) {
  const full = join(ROOT, relPath);
  if (!existsSync(full)) continue;
  const docText = readFileSync(full, "utf8");
  const estTokens = estimateTokens(docText);
  if (estTokens > maxTokens) {
    const largest = largestMarkdownSections(docText)
      .map((section) => `${section.title} @ line ${section.line} (~${section.tokens} tokens)`)
      .join("; ");
    warn(`context budget: ${relPath} is ~${estTokens} tokens (budget ${maxTokens}); largest sections: ${largest}; move detail to devlogs/task cards/archive`);
  }
  for (const stale of findStaleHotDocNotes(docText)) {
    warn(`hot doc stale cue: ${relPath}:${stale.line} matched "${stale.match}"; ${stale.note}`);
  }
}

// Boot order has ONE home: AGENTS.md "Boot Order". Any other doc that ENUMERATES the boot
// sequence (a numbered AGENTS.md link followed by a numbered session-brief link) will drift —
// it must link to AGENTS.md instead. Generic guard replacing the retired per-file
// STALE_BOOT_GUIDANCE regexes (docs single-homed 2026-07-01, Fable hygiene sweep).
const BOOT_LIST_PATTERN = /\d\.\s+(?:Read\s+)?\[AGENTS\.md\][\s\S]{0,260}?\d\.\s+(?:Read\s+)?\[session-brief/;
for (const md of mdFiles) {
  const relative = md.slice(ROOT.length + 1).replace(/\\/g, "/");
  if (relative.startsWith("docs/archive/") || relative === "AGENTS.md") continue;
  if (BOOT_LIST_PATTERN.test(readFileSync(md, "utf8"))) {
    warn(`boot-order duplication: ${relative} enumerates the boot sequence; AGENTS.md is its single home — link to it instead`);
  }
}
// ---- control-character scan (mechanized 2026-07-06, 2nd occurrence in one session) ----
// Text sources must not contain raw control bytes (NUL etc.): a literal NUL in
// toast.ts made git treat the file as BINARY (killing textual diff/merge), and a
// second NUL landed in a task card via an editing tool the same day. Escapes like
// backslash-u0000 belong in source as ESCAPE SEQUENCES, never raw bytes.
// Loud escape hatch: GAMEKIT_CONTROL_CHARS_SKIP=1 (use only for a deliberate binary-ish fixture).
const CONTROL_SCAN_DIRS = ["client/src", "server/src", "shared/src", "tools/src", "content"].map((d) => join(ROOT, d));
const CONTROL_SCAN_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".css", ".json", ".md", ".html", ".py"]);
const ALLOWED_CONTROL_BYTES = new Set([9, 10, 13]); // tab, LF, CR
if (process.env.GAMEKIT_CONTROL_CHARS_SKIP === "1") {
  warn("control-chars: scan SKIPPED via GAMEKIT_CONTROL_CHARS_SKIP=1");
} else {
  const textFiles: string[] = [...mdFiles];
  const collectText = (d: string): void => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) collectText(full);
      else if (CONTROL_SCAN_EXTS.has(entry.slice(entry.lastIndexOf(".")))) textFiles.push(full);
    }
  };
  for (const d of CONTROL_SCAN_DIRS) collectText(d);
  for (const tf of new Set(textFiles)) {
    const buf = readFileSync(tf);
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (b < 32 && !ALLOWED_CONTROL_BYTES.has(b)) {
        const line = buf.subarray(0, i).filter((c) => c === 10).length + 1;
        fail(`control-chars: ${relative(ROOT, tf).replace(/\\/g, "/")}:${line} contains raw control byte 0x${b.toString(16).padStart(2, "0")} at offset ${i} — use an escape sequence in source, never the raw byte (git treats the file as binary)`);
        break; // one report per file is enough
      }
    }
  }
}

// ---- lane-digest anchor integrity (mechanized: fail PRE-COMMIT, not next spawn) ----
// generateLaneDigest hard-reads a fixed set of anchored headings/rule-bullets from
// AGENTS.md, session-brief.md, ai-architecture.md and (conditionally) animation.md; if a
// heading or rule line is reworded, spawns break. This leg re-exercises the SAME anchor
// tables read-only so a broken anchor fails `pnpm validate` at commit time instead.
for (const msg of verifyDigestAnchors(ROOT)) {
  fail(`lane-digest anchor: ${msg}`);
}

// ---- report ----
const counts = Object.fromEntries(
  (Object.keys(MANIFEST_SCHEMAS) as ContentDir[]).map((d) => [d, byType[d]?.size ?? 0]),
);
console.log(`[validate] content manifests: ${loaded.length}`, counts);
console.log(`[validate] docs scanned: ${mdFiles.length} markdown files`);
console.log(`[validate] reference json scanned: ${refJsonFiles.length}`);
if (warnings.length > 0) {
  console.warn(`[validate] warnings: ${warnings.length}`);
  for (const w of warnings) console.warn("  - " + w);
}

if (errors.length > 0) {
  console.error(`\n[validate] FAILED with ${errors.length} error(s):`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log("[validate] OK — all checks passed.");

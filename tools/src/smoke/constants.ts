import {
  NPC_FOOTPRINT_OFFSET_Y,
  NPC_INTERACT_RANGE,
  PLAYER_FOOT_OFFSET_Y,
} from "@gamekit/game-contract";

export const ROOT = process.cwd().replace(/\\/g, "/");
export const TIMEOUT = 20_000;
export const QUEST_STATUS_TIMEOUT = 30_000;
export const SERVER_PORT_START = readPortEnv("GAMEKIT_SMOKE_SERVER_PORT_START", 27100);
export const SERVER_PORT_END = readPortEnv("GAMEKIT_SMOKE_SERVER_PORT_END", 27120);
export const CLIENT_PORT_START = readPortEnv("GAMEKIT_SMOKE_CLIENT_PORT_START", 27130);
export const CLIENT_PORT_END = readPortEnv("GAMEKIT_SMOKE_CLIENT_PORT_END", 27150);
export { NPC_FOOTPRINT_OFFSET_Y, NPC_INTERACT_RANGE, PLAYER_FOOT_OFFSET_Y };

function readPortEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// Zone-1 Reset (2026-07-03): the explicit field smoke leg still proves the
// Bloomvale Plains <-> R1 pilot pair.
export const HARBOR_MAP_ID = "map_harbor_outskirts";
export const FIELD_MAP_ID = "map_harbor_r1_pilot";

// Bloomvale -> R1 pilot portal (content/portals/portal_bloomvale_to_r1_pilot.json).
export const HARBOR_TO_FIELD_PORTAL_ID = "portal_bloomvale_to_r1_pilot";
export const PORTAL_X = 300;
export const PORTAL_Y = 900;
export const PORTAL_TARGET_Y = PORTAL_Y - PLAYER_FOOT_OFFSET_Y;

// R1 pilot -> Bloomvale return portal (content/portals/portal_r1_pilot_to_bloomvale.json).
export const FIELD_TO_HARBOR_PORTAL_ID = "portal_r1_pilot_to_bloomvale";
export const FIELD_TO_HARBOR_PORTAL_X = 760;
export const FIELD_TO_HARBOR_PORTAL_Y = 845;
export const FIELD_TO_HARBOR_PORTAL_TARGET_Y = FIELD_TO_HARBOR_PORTAL_Y - PLAYER_FOOT_OFFSET_Y;

// Lanternwake tutorial zone (content/portals/portal_bloomvale_to_lanternwake.json).
export const LANTERNWAKE_MAP_ID = "map_lanternwake_skiff";
export const SECOND_ZONE_MAP_ID = LANTERNWAKE_MAP_ID;
export const BLOOMVALE_TO_LANTERNWAKE_PORTAL_ID = "portal_bloomvale_to_lanternwake";
export const BLOOMVALE_TO_LANTERNWAKE_PORTAL_X = 2040;
export const BLOOMVALE_TO_LANTERNWAKE_PORTAL_Y = 660;
export const BLOOMVALE_TO_LANTERNWAKE_PORTAL_TARGET_Y = BLOOMVALE_TO_LANTERNWAKE_PORTAL_Y - PLAYER_FOOT_OFFSET_Y;
export const LANTERNWAKE_TO_BLOOMVALE_PORTAL_ID = "portal_lanternwake_to_bloomvale";
export const LANTERNWAKE_TO_BLOOMVALE_PORTAL_X = 420;
export const LANTERNWAKE_TO_BLOOMVALE_PORTAL_Y = 500;
export const LANTERNWAKE_TO_BLOOMVALE_PORTAL_TARGET_Y = LANTERNWAKE_TO_BLOOMVALE_PORTAL_Y - PLAYER_FOOT_OFFSET_Y;

// Generic second-zone smoke aliases target live Lanternwake, not the retired
// Fernwatch/Mossgrove path.
export const SECOND_ZONE_PORTAL_ID = BLOOMVALE_TO_LANTERNWAKE_PORTAL_ID;
export const SECOND_ZONE_PORTAL_X = BLOOMVALE_TO_LANTERNWAKE_PORTAL_X;
export const SECOND_ZONE_PORTAL_Y = BLOOMVALE_TO_LANTERNWAKE_PORTAL_Y;
export const SECOND_ZONE_PORTAL_TARGET_Y = SECOND_ZONE_PORTAL_Y - PLAYER_FOOT_OFFSET_Y;

// Harbor NPCs (placements in content/maps/map_harbor_outskirts.json).
// Warden moved 2026-07-05 (card-smoke-warden-path): (520,440) put the ONLY
// straight-line approach from spawn through the bloomvale_windmill's
// "structure"-class collision box (world rect x[506,664] y[399,498],
// content/asset-editor-metadata.json placementClasses.structure); the player's
// real collision footprint (server: player.y + footOffsetY 95.25, halfWidth 14,
// height 18 — server/config/game.json) clips that box ~130px out, well outside
// this shop's 70px approach radius. New spot is east of the windmill/plaza-
// barrel cluster, fully clear on the straight line from both smoke spawns
// (verified via tools/src/smoke/movement.ts's footprint-aware approach).
// instanceId keeps its legacy _520_440_ suffix (opaque id, not parsed for
// coordinates — see EmbeddedEditorEntityPlacement.ts's `_(\d+)$` counter regex).
export const HARBOR_WARDEN_ID = "npc_placement_npc_harbor_warden_520_440_1";
// Warden relocated again 2026-07-07 (card-world-spawn-fixes spawn relayout): moved off
// the chest/windmill cluster into the open village green at (560,660). Default spawn
// also moved south to (600,860), so the straight-line approach from spawn is clear grass
// (well is east at 850,705; windmill north; chest east at 1050,640). Coords must match
// content/zones/map_harbor_outskirts.layout.json npc_harbor_warden.
export const HARBOR_WARDEN_X = 560;
export const HARBOR_WARDEN_Y = 660;
export const COMBAT_TRAINER_ID = "npc_placement_npc_combat_trainer_420_820_2";
export const COMBAT_TRAINER_X = 420;
export const COMBAT_TRAINER_Y = 820;

// quest_embers_in_ruin is ACCEPT-ONLY in the smoke run: its kill target
// (monster_ember_wisp) lives on map_emberglass_ruins, four portal hops from the
// harbor giver, so the smoke only verifies the accept path (active 0/5).
export const HARBOR_QUEST_NPC_ID = "npc_placement_npc_emberglass_scout_820_470_4";
export const HARBOR_QUEST_NPC_X = 820;
export const HARBOR_QUEST_NPC_Y = 470;
export const HARBOR_QUEST_ID = "quest_embers_in_ruin";
export const HARBOR_QUEST_REQUIRED = 5;

// Fernwatch quest loop (content/quests/quest_dawncap_gathering.json + npc_fernwatch_ranger).
export const FIELD_QUEST_NPC_ID = "npc_fernwatch_ranger";
export const FIELD_QUEST_NPC_X = 360;
export const FIELD_QUEST_NPC_Y = 620;
export const FIELD_QUEST_ID = "quest_dawncap_gathering";
export const FIELD_QUEST_REQUIRED = 4;
export const FIELD_QUEST_REWARD_XP = 120;
export const FIELD_QUEST_REWARD_GOLD = 35;

// Fernwatch combat targets (content/monsters/monster_dawncap_shroom.json).
export const FIELD_MONSTER_ID = "monster_dawncap_shroom";
export const FIELD_MONSTER_XP = 34;
export const FIELD_MONSTER_MIN_COUNT = 2;

// Aggressive monster check. monster_mire_biter has placements on BOTH harbor
// (1480,1340 maxAlive 2) and fernwatch (1200,900 maxAlive 2); the server keys
// monsters as `${monsterId}-${i}` per map, so the second map processed
// overwrites the first and only one map's copies survive (known server bug,
// backlogged). Callers must select alive copies by mapId at runtime.
export const AGGRESSIVE_MONSTER_ID = "monster_mire_biter";
export const AGGRO_MAP_ID = HARBOR_MAP_ID;
export const AGGRESSIVE_SPAWN_ZONES: Record<string, { x: number; y: number }> = {
  [HARBOR_MAP_ID]: { x: 1480, y: 1340 },
  [FIELD_MAP_ID]: { x: 1200, y: 900 },
};

// Bloomvale slime roster (card-bloomvale-revival, 2026-07-03). map_harbor_outskirts
// IS Bloomvale Plains (id frozen). The combat step kills a passive Meadow Slime and
// checks per-kill XP; the aggro step drives the aggressive Honey Slime through
// approach -> damage -> leash reset. Both run on the live Bloomvale map, no portals.
export const BLOOMVALE_MAP_ID = HARBOR_MAP_ID;
export const SLIME_COMBAT_MONSTER_ID = "monster_meadow_slime";
export const SLIME_COMBAT_XP = 12;
export const SLIME_AGGRO_MONSTER_ID = "monster_honey_slime";
export const BLOOMVALE_FIRST_HUNT_QUEST_ID = "quest_bloomvale_first_hunt";
export const BLOOMVALE_FIRST_HUNT_REQUIRED = 5;
export const BLOOMVALE_FIRST_HUNT_REWARD_XP = 100;
export const BLOOMVALE_FIRST_HUNT_REWARD_GOLD = 100;
export const BLOOMVALE_DEWDROP_CULL_QUEST_ID = "quest_bloomvale_dewdrop_cull";
export const BLOOMVALE_DEWDROP_CULL_REQUIRED = 2;
export const BLOOMVALE_DEWDROP_CULL_REWARD_XP = 180;
export const BLOOMVALE_DEWDROP_CULL_REWARD_GOLD = 150;
export const BLOOMVALE_DEWDROP_CULL_MONSTER_ID = "monster_dew_slime";
export const BLOOMVALE_DEWDROP_CULL_MONSTER_XP = 18;
export const BLOOMVALE_WARDEN_BRIEFING_QUEST_ID = "quest_bloomvale_warden_briefing";
export const BLOOMVALE_WARDEN_BRIEFING_REWARD_XP = 75;
export const BLOOMVALE_WARDEN_BRIEFING_REWARD_GOLD = 40;
export const BLOOMVALE_MOSS_SAMPLES_QUEST_ID = "quest_bloomvale_moss_samples";
export const BLOOMVALE_MOSS_SAMPLES_REQUIRED = 3;
export const BLOOMVALE_MOSS_SAMPLES_REWARD_XP = 120;
export const BLOOMVALE_MOSS_SAMPLES_REWARD_GOLD = 60;
export const BLOOMVALE_PATROL_QUEST_ID = "quest_bloomvale_meadow_patrol";
export const BLOOMVALE_PATROL_REQUIRED = 6;
export const BLOOMVALE_PATROL_REWARD_XP = 260;
export const BLOOMVALE_PATROL_REWARD_GOLD = 200;
export const BLOOMVALE_PATROL_MONSTER_ID = "monster_blossom_slime";
export const BLOOMVALE_PATROL_MONSTER_XP = 26;
export const LANTERNWAKE_QUEST_NPC_ID = "npc_placement_npc_mara_bellweather_300_460_1";
export const LANTERNWAKE_QUEST_NPC_X = 300;
export const LANTERNWAKE_QUEST_NPC_Y = 460;
export const LANTERNWAKE_QUEST_ID = "quest_lanternwake";
export const LANTERNWAKE_QUEST_REWARD_XP = 50;
export const LANTERNWAKE_QUEST_REWARD_GOLD = 25;

// Items.
export const GOLD_ID = "item_gold";
export const MINOR_HEALTH_POTION_ID = "item_minor_health_potion";
export const MINOR_MANA_POTION_ID = "item_minor_mana_potion";
export const MOSS_SPORE_ID = "item_moss_spore";
// Live Bloomvale reward material from loot_meadow_slime; also sold/bought by the warden.
export const LOOT_MATERIAL_ID = MOSS_SPORE_ID;

// Crafting pilot (card-crafting-station-ui): the Minor Health Potion recipe
// consumes 2 Moss Spore at Warden Bray's station and outputs 1 Minor Health Potion.
export const CRAFT_RECIPE_OUTPUT_ID = MINOR_HEALTH_POTION_ID;
export const CRAFT_RECIPE_INPUT_ID = MOSS_SPORE_ID;
export const CRAFT_RECIPE_INPUT_COUNT = 2;

// Player/NPC footprint + interaction geometry. These are tuning constants (template default —
// a game tunes them to its sprite scale). Copied faithfully from the game's shared/src/geometry.ts.
// The smoke harness derives portal target-Y and interaction ranges from these.

export const PLAYER_DISPLAY_SIZE = 96;
export const PLAYER_VISUAL_BASELINE_Y = PLAYER_DISPLAY_SIZE * 0.9921875;
export const PLAYER_FOOT_OFFSET_Y = PLAYER_VISUAL_BASELINE_Y;

export const NPC_INTERACT_RANGE = 160;
export const NPC_FOOTPRINT_OFFSET_Y = 28;

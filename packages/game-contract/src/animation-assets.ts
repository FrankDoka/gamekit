// Animation sheet config shapes + a template PLAYER_SHEET_CONFIG. Copied from the game's
// client/src/config/animation-assets.ts. In the game this file is GENERATED from the promoted
// runtime registry; here the values are a template default (a game regenerates it from its own
// promoted sheets). The toolkit consumes the SHAPES (SheetConfig/PlayerSheetConfig) and reads
// PLAYER_SHEET_CONFIG's per-action entries in the player-facing proof.

export type SheetAction = "idle" | "walk" | "attack" | "gather";

export type SheetConfig = {
  key: string;
  path: string;
  frameWidth: number;
  frameHeight: number;
  frames: number;
  fps: number;
  repeat: number;
  anchorY: number;
  anchorX: number;
  bodyHeight: number;
  displayBodyHeight?: number;
  nativeFacesRight: boolean;
};

export type PlayerSheetAction = SheetAction;
export type PlayerSheetConfig = SheetConfig & {
  south?: SheetConfig;
};
export type EntitySheetConfig = Partial<Record<SheetAction, SheetConfig>>;

// Template default — a game regenerates this from its promoted player sheets.
export const PLAYER_SHEET_CONFIG = {
  idle: {
    key: "player_idle_east",
    path: "assets/sprites/player_idle_east.png",
    frameWidth: 256,
    frameHeight: 256,
    frames: 10,
    fps: 6,
    repeat: -1,
    anchorY: 255,
    anchorX: 143,
    bodyHeight: 222,
    nativeFacesRight: true,
  },
  walk: {
    key: "player_walk_east",
    path: "assets/sprites/player_walk_east.png",
    frameWidth: 256,
    frameHeight: 256,
    frames: 10,
    fps: 10,
    repeat: -1,
    anchorY: 255,
    anchorX: 173,
    bodyHeight: 222,
    nativeFacesRight: true,
  },
  attack: {
    key: "player_attack_east",
    path: "assets/sprites/player_attack_east.png",
    frameWidth: 384,
    frameHeight: 320,
    frames: 11,
    fps: 22,
    repeat: 0,
    anchorY: 319,
    anchorX: 188,
    bodyHeight: 222,
    nativeFacesRight: true,
  },
  gather: {
    key: "player_gather_east",
    path: "assets/sprites/player_gather_east.png",
    frameWidth: 256,
    frameHeight: 256,
    frames: 8,
    fps: 8,
    repeat: -1,
    anchorY: 255,
    anchorX: 128,
    bodyHeight: 222,
    nativeFacesRight: true,
  },
} as const satisfies Record<PlayerSheetAction, PlayerSheetConfig>;

// Template default — a game regenerates this from its promoted entity sheets.
export const ENTITY_SHEET_CONFIG: Record<string, EntitySheetConfig> = {};

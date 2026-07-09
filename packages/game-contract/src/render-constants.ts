import { PLAYER_VISUAL_BASELINE_Y } from "./geometry";

// Camera + player-footprint render constants. These are tuning constants (template default —
// a game tunes camera framing and footprint sizes to its art scale). The generic bit is
// `getCameraZoomForViewportHeight`, a pure function deriving a fixed camera zoom from the
// viewport height so framing stays constant across window sizes. Copied faithfully from the
// game's client/src/config/constants.ts (only the symbols the capture/zone tools consume).

export const PLAYER_BODY_DISPLAY_HEIGHT = 88;
// D3-v2 basis: render at native window resolution and derive a fixed camera zoom from viewport
// height so framing stays constant. 1440 / (88 * 6.5) ≈ 2.517.
export const CAMERA_NATIVE_BASIS_HEIGHT = 1440;
export const CAMERA_REFERENCE_PLAYER_BODY_HEIGHTS = 6.5;
export const CAMERA_ZOOM_1440P_BASIS = CAMERA_NATIVE_BASIS_HEIGHT / (PLAYER_BODY_DISPLAY_HEIGHT * CAMERA_REFERENCE_PLAYER_BODY_HEIGHTS);
export const ASSET_BASIS_SCALE = 1 / CAMERA_ZOOM_1440P_BASIS;

export const PLAYER_FOOTPRINT_HALF_WIDTH = 14;
export const PLAYER_FOOTPRINT_HEIGHT = 18;

// The shadow baseline is derived from the shared visual baseline so footprint helpers agree
// with the game's grounding math.
export const PLAYER_SHADOW_Y = PLAYER_VISUAL_BASELINE_Y - 1;

/** Fixed camera zoom for a given viewport height so on-screen framing stays constant. Pure. */
export function getCameraZoomForViewportHeight(viewportHeight: number): number {
  const safeHeight = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : CAMERA_NATIVE_BASIS_HEIGHT;
  return safeHeight / (PLAYER_BODY_DISPLAY_HEIGHT * CAMERA_REFERENCE_PLAYER_BODY_HEIGHTS);
}

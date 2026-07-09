/**
 * Deterministic full-map sweep grid — the single source of truth for how many
 * overlapping gameplay-zoom framings tile a map, shared by `capture:zone --sweep`
 * (which drives the camera) and `zone:dod` (which checks a captureDir has full
 * sweep coverage). Keeping the math here means the two can never disagree on the
 * expected shot count. See card-zone-gates.
 */
export const SWEEP_OVERLAP = 0.2;

// The capture viewport `capture:zone --sweep` renders at: 16:9 at the 1440p native
// basis. Kept here so `zone:dod` derives the SAME expected shot count from map size +
// gameplay zoom (must equal capture-zone.ts CAPTURE_VIEWPORT).
export const SWEEP_CAPTURE_WIDTH = 2560;
export const SWEEP_CAPTURE_HEIGHT = 1440;

/** Grid for the sweep capture at a given gameplay zoom (world-view = viewport / zoom). */
export function sweepGridForCapture(mapWidth: number, mapHeight: number, zoom: number): SweepGrid {
  return sweepGrid(mapWidth, mapHeight, SWEEP_CAPTURE_WIDTH / zoom, SWEEP_CAPTURE_HEIGHT / zoom);
}

/**
 * Cell centers spanning [view/2, extent - view/2] with the far edge always covered.
 * A map narrower than one view collapses to a single centered shot.
 */
export function sweepCenters(extent: number, view: number, overlap = SWEEP_OVERLAP): number[] {
  if (extent <= view) return [Math.round(extent / 2)];
  const step = view * (1 - overlap);
  const count = Math.ceil((extent - view) / step) + 1;
  const first = view / 2;
  const last = extent - view / 2;
  const gap = count > 1 ? (last - first) / (count - 1) : 0;
  return Array.from({ length: count }, (_, i) => Math.round(first + i * gap));
}

export type SweepGrid = { xs: number[]; ys: number[]; cols: number; rows: number; count: number };

export function sweepGrid(
  mapWidth: number,
  mapHeight: number,
  viewWidth: number,
  viewHeight: number,
  overlap = SWEEP_OVERLAP,
): SweepGrid {
  const xs = sweepCenters(mapWidth, viewWidth, overlap);
  const ys = sweepCenters(mapHeight, viewHeight, overlap);
  return { xs, ys, cols: xs.length, rows: ys.length, count: xs.length * ys.length };
}

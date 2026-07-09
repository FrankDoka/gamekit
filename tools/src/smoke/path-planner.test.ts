import { describe, expect, it } from "vitest";
import {
  computeCollisionAwarePath,
  PATH_PLANNER_CONSTANTS,
  type PathBounds,
  type PathPoint,
} from "./path-planner";

// The planner is the collision-aware smoke mover's brain (movement.ts feeds it
// the live client oracle). These tests pin its contract against synthetic prop
// clusters so a regression is caught in Node, without booting a browser.

const BOUNDS: PathBounds = { width: 2000, height: 2000 };

/** Axis-aligned blocked rectangle → an isBlocked predicate. */
function rectBlocker(rect: { left: number; right: number; top: number; bottom: number }) {
  return (x: number, y: number): boolean => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/** Does the straight segment a→b ever pass through a blocked point (fine sampling)? */
function segmentHitsBlock(a: PathPoint, b: PathPoint, isBlocked: (x: number, y: number) => boolean): boolean {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const samples = Math.max(1, Math.ceil(dist / 4));
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples;
    if (isBlocked(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) return true;
  }
  return false;
}

/** Walk start → waypoints and assert no leg clips the obstacle and the goal is reached. */
function assertRouteIsClear(
  start: PathPoint,
  goal: PathPoint,
  waypoints: PathPoint[],
  isBlocked: (x: number, y: number) => boolean,
): void {
  let cur = start;
  for (const wp of waypoints) {
    expect(segmentHitsBlock(cur, wp, isBlocked), `leg (${cur.x},${cur.y})->(${wp.x},${wp.y}) clips a prop`).toBe(false);
    cur = wp;
  }
  const last = waypoints[waypoints.length - 1];
  expect(Math.hypot(last.x - goal.x, last.y - goal.y)).toBeLessThanOrEqual(1);
}

describe("computeCollisionAwarePath", () => {
  it("returns the direct target when the straight line is clear", () => {
    const start = { x: 100, y: 100 };
    const goal = { x: 900, y: 100 };
    const path = computeCollisionAwarePath(start, goal, () => false, BOUNDS);
    expect(path).toEqual([{ x: 900, y: 100 }]);
  });

  it("routes around a prop cluster squarely blocking the straight line", () => {
    // Player at (200,600); NPC-style destination at (1000,600). A prop box sits
    // dead centre on the straight line — the coordinate-coupling flake class.
    const start = { x: 200, y: 600 };
    const goal = { x: 1000, y: 600 };
    const isBlocked = rectBlocker({ left: 540, right: 660, top: 400, bottom: 800 });
    // Sanity: the direct line really is blocked, so this test is meaningful.
    expect(segmentHitsBlock(start, goal, isBlocked)).toBe(true);

    const path = computeCollisionAwarePath(start, goal, isBlocked, BOUNDS);
    expect(path.length).toBeGreaterThan(1); // it inserted at least one detour waypoint
    assertRouteIsClear(start, goal, path, isBlocked);
  });

  it("routes around an L-shaped cluster requiring a two-turn detour", () => {
    const start = { x: 200, y: 900 };
    const goal = { x: 1100, y: 300 };
    // An L: a vertical wall and a horizontal wall meeting near the mid-line.
    const wallA = rectBlocker({ left: 560, right: 640, top: 200, bottom: 900 });
    const wallB = rectBlocker({ left: 560, right: 1100, top: 560, bottom: 640 });
    const isBlocked = (x: number, y: number): boolean => wallA(x, y) || wallB(x, y);
    expect(segmentHitsBlock(start, goal, isBlocked)).toBe(true);

    const path = computeCollisionAwarePath(start, goal, isBlocked, BOUNDS);
    assertRouteIsClear(start, goal, path, isBlocked);
  });

  it("fails open (direct target) when the goal is fully walled in", () => {
    const start = { x: 200, y: 600 };
    const goal = { x: 1000, y: 600 };
    // A blocker that surrounds the goal on all sides but leaves the start clear:
    // no clear step exists, so the planner must bail to the direct target rather
    // than loop — the caller's resend loop then reports an honest stall.
    const isBlocked = rectBlocker({ left: 900, right: 1100, top: 500, bottom: 700 });
    const path = computeCollisionAwarePath(start, goal, isBlocked, BOUNDS);
    expect(path).toEqual([{ x: 1000, y: 600 }]);
  });

  it("keeps waypoints inside map bounds when detouring near an edge", () => {
    const start = { x: 40, y: 600 };
    const goal = { x: 40, y: 1400 };
    // A prop hard against the west edge forces the sidestep east, never off-map.
    const isBlocked = rectBlocker({ left: 0, right: 120, top: 900, bottom: 1100 });
    const path = computeCollisionAwarePath(start, goal, isBlocked, BOUNDS);
    for (const wp of path) {
      expect(wp.x).toBeGreaterThanOrEqual(0);
      expect(wp.x).toBeLessThanOrEqual(BOUNDS.width);
      expect(wp.y).toBeGreaterThanOrEqual(0);
      expect(wp.y).toBeLessThanOrEqual(BOUNDS.height);
    }
    assertRouteIsClear(start, goal, path, isBlocked);
  });

  it("exposes stable tuning constants", () => {
    expect(PATH_PLANNER_CONSTANTS.STEP).toBeGreaterThan(0);
    expect(PATH_PLANNER_CONSTANTS.MAX_STEPS).toBeGreaterThan(0);
    expect(PATH_PLANNER_CONSTANTS.ARRIVE).toBeGreaterThan(0);
  });
});

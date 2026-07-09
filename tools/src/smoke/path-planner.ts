// Pure, browser-safe collision-aware path planner shared by the smoke mover
// (movement.ts, run inside page.evaluate) and its unit test
// (path-planner.test.ts, run in Node).
//
// IMPORTANT — self-containment contract: movement.ts serializes
// `computeCollisionAwarePath.toString()` into the browser and re-evaluates it
// there, so this function MUST NOT reference ANY module-scope binding (no other
// top-level functions, no exported consts) or DOM/Node globals. Everything it
// needs is a local `const`/closure inside its body. The exported
// PATH_PLANNER_CONSTANTS below mirror the same literals purely for tests/tuning
// visibility; a test asserts they stay in sync so the two never drift.
//
// Algorithm: greedy-with-wall-follow ("bug"-style). Each step it heads straight
// at the goal if that step is clear; when a prop blocks the straight line it
// hugs the obstacle face (committed rotational direction) until it can see the
// goal again, then commits. It tries the turn sense that frees up soonest first
// and retries the opposite sense if that one dead-ends in a map-edge pocket. If
// both are boxed in it FAILS OPEN — returns the direct target so the caller's
// resend loop reports an honest stall instead of looping forever.

export type PathPoint = { x: number; y: number };
export type PathBounds = { width: number; height: number };
export type IsBlocked = (x: number, y: number) => boolean;

// Canonical tuning values, mirrored as local literals inside
// computeCollisionAwarePath (kept in sync by path-planner.test.ts). Do not make
// the function reference this object — see the self-containment contract above.
export const PATH_PLANNER_CONSTANTS = {
  STEP: 28,
  ARRIVE: 24,
  MAX_STEPS: 400,
  // True-cycle (loop) budget before failing open; wall-following legitimately
  // moves away from the goal, so we detect coarse-cell revisits, not distance.
  STUCK_LIMIT: 90,
  // Sampling resolution (px) for straight-line clearance checks. Kept fine so
  // the "can I see the goal now?" early-exit does not miss an obstacle corner
  // between samples and commit a final leg that clips the prop.
  LINE_SAMPLE_PX: 6,
  // Wall-follow rotational increment (rad) and max sweep before boxed-in.
  ROT: Math.PI / 8,
  MAX_ROT_TRIES: 12,
} as const;

/**
 * Plan a collision-aware path from `start` to `goal`. Returns a list of clear
 * waypoints ending at the goal. If the straight line is already clear, returns
 * `[goal]` (no waypoints inserted). Self-contained (see file header).
 */
export function computeCollisionAwarePath(
  start: PathPoint,
  goal: PathPoint,
  isBlocked: IsBlocked,
  bounds: PathBounds,
): PathPoint[] {
  const STEP = 28;
  const ARRIVE = 24;
  const MAX_STEPS = 400;
  const STUCK_LIMIT = 90;
  const LINE_SAMPLE_PX = 6;
  const ROT = Math.PI / 8;
  const MAX_ROT_TRIES = 12;

  const direct: PathPoint[] = [{ x: goal.x, y: goal.y }];
  const clampX = (x: number): number => Math.max(0, Math.min(bounds.width, x));
  const clampY = (y: number): number => Math.max(0, Math.min(bounds.height, y));

  const lineClear = (ax: number, ay: number, bx: number, by: number): boolean => {
    const dist = Math.hypot(bx - ax, by - ay);
    const samples = Math.max(1, Math.ceil(dist / LINE_SAMPLE_PX));
    for (let i = 1; i <= samples; i += 1) {
      const t = i / samples;
      if (isBlocked(clampX(ax + (bx - ax) * t), clampY(ay + (by - ay) * t))) return false;
    }
    return true;
  };

  if (lineClear(start.x, start.y, goal.x, goal.y)) return direct;

  // Prefer the turn sense whose first clear step is nearer the goal bearing (the
  // shorter way around); ties break CCW. Self-correcting: the caller retries the
  // opposite sense if the preferred one dead-ends.
  const chooseTurn = (): 1 | -1 => {
    const goalAngle = Math.atan2(goal.y - start.y, goal.x - start.x);
    const firstClearOffset = (dir: 1 | -1): number => {
      for (let k = 1; k <= MAX_ROT_TRIES; k += 1) {
        const angle = goalAngle + dir * ROT * k;
        const nx = clampX(start.x + Math.cos(angle) * STEP);
        const ny = clampY(start.y + Math.sin(angle) * STEP);
        if (!isBlocked(nx, ny) && lineClear(start.x, start.y, nx, ny)) return k;
      }
      return Number.POSITIVE_INFINITY;
    };
    return firstClearOffset(1) <= firstClearOffset(-1) ? 1 : -1;
  };

  // Run the wall-follow stepper committed to one rotational direction. Returns a
  // waypoint list ending at the goal, or null if it got boxed in / cycled.
  const follow = (turn: 1 | -1): PathPoint[] | null => {
    const waypoints: PathPoint[] = [];
    let curX = start.x;
    let curY = start.y;
    let heading = Math.atan2(goal.y - curY, goal.x - curX);
    let lastPushed: PathPoint = { x: curX, y: curY };
    const visited = new Set<string>();
    const cellKey = (x: number, y: number): string => `${Math.round(x / STEP)},${Math.round(y / STEP)}`;
    let revisits = 0;

    const pushWaypoint = (x: number, y: number): void => {
      if (Math.hypot(x - lastPushed.x, y - lastPushed.y) < 0.5) return;
      waypoints.push({ x, y });
      lastPushed = { x, y };
    };
    const tryStep = (angle: number, stepLen: number): boolean => {
      const nx = clampX(curX + Math.cos(angle) * stepLen);
      const ny = clampY(curY + Math.sin(angle) * stepLen);
      if (isBlocked(nx, ny)) return false;
      if (!lineClear(curX, curY, nx, ny)) return false;
      curX = nx;
      curY = ny;
      heading = angle;
      pushWaypoint(curX, curY);
      return true;
    };

    for (let stepIdx = 0; stepIdx < MAX_STEPS; stepIdx += 1) {
      const toGoal = Math.hypot(goal.x - curX, goal.y - curY);
      if (toGoal <= ARRIVE) break;
      if (lineClear(curX, curY, goal.x, goal.y)) break;

      const stepLen = Math.min(STEP, toGoal);
      const goalAngle = Math.atan2(goal.y - curY, goal.x - curX);

      if (!tryStep(goalAngle, stepLen)) {
        let moved = false;
        for (let k = 1; k <= MAX_ROT_TRIES; k += 1) {
          if (tryStep(heading + turn * ROT * k, stepLen)) {
            moved = true;
            break;
          }
        }
        if (!moved) return null; // fully boxed in
      }

      const key = cellKey(curX, curY);
      if (visited.has(key)) {
        revisits += 1;
        if (revisits >= STUCK_LIMIT) return null; // true cycle
      } else {
        visited.add(key);
      }
    }

    waypoints.push({ x: goal.x, y: goal.y });
    return waypoints;
  };

  const preferred = chooseTurn();
  return follow(preferred) ?? follow(preferred === 1 ? -1 : 1) ?? direct;
}

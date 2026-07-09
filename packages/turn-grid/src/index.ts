// @gamekit/turn-grid — pure, genre-reusable turn-based grid logic.
//
// NO Phaser, NO Colyseus, NO DOM. Everything here is a plain function over plain
// data so it can be unit-tested in isolation and reused across games without
// dragging a runtime with it. A Colyseus server (which owns @colyseus/schema
// state) and a Phaser client both call INTO this module; this module never
// imports from them.
//
// This is the canonical library version. The examples/tactics-game embeds a
// snapshot of this engine for fork-portability; keep the two in sync at the
// logic level, but neither depends on the other.

// ---------------------------------------------------------------------------
// Grid model + passability
// ---------------------------------------------------------------------------

export type Tile = { x: number; y: number };

export type Grid = {
  width: number;
  height: number;
  /** row-major impassable flags, length = width*height; true = blocked terrain. */
  blocked: boolean[];
};

export function makeGrid(width: number, height: number, blocked: Tile[] = []): Grid {
  const flags = new Array<boolean>(width * height).fill(false);
  for (const b of blocked) {
    if (inBounds(width, height, b.x, b.y)) flags[b.y * width + b.x] = true;
  }
  return { width, height, blocked: flags };
}

export function inBounds(width: number, height: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < width && y < height;
}

/** A tile is passable if it is in bounds and not blocked terrain. Occupancy by a
 * unit is handled separately by the caller (see reachableTiles' `occupied`). */
export function isPassable(grid: Grid, x: number, y: number): boolean {
  if (!inBounds(grid.width, grid.height, x, y)) return false;
  return !grid.blocked[y * grid.width + x];
}

// ---------------------------------------------------------------------------
// BFS reachable tiles (movement range over passable, unoccupied tiles)
// ---------------------------------------------------------------------------

export type ReachOptions = {
  /** tiles occupied by OTHER units — cannot be moved through or onto. Keyed "x,y". */
  occupied?: Set<string>;
};

export function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

/**
 * Breadth-first flood from (startX,startY) out to `range` orthogonal steps.
 * Returns every reachable tile (EXCLUDING the start tile) that is passable and
 * not occupied. 4-connected (no diagonals) — classic tactics movement.
 */
export function reachableTiles(
  grid: Grid,
  startX: number,
  startY: number,
  range: number,
  opts: ReachOptions = {},
): Tile[] {
  const occupied = opts.occupied ?? new Set<string>();
  const dist = new Map<string, number>();
  const out: Tile[] = [];
  const startKey = tileKey(startX, startY);
  dist.set(startKey, 0);
  const queue: Tile[] = [{ x: startX, y: startY }];
  let head = 0;
  const steps: Tile[] = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
  ];
  while (head < queue.length) {
    const cur = queue[head++];
    const d = dist.get(tileKey(cur.x, cur.y)) ?? 0;
    if (d >= range) continue;
    for (const s of steps) {
      const nx = cur.x + s.x;
      const ny = cur.y + s.y;
      const k = tileKey(nx, ny);
      if (dist.has(k)) continue;
      if (!isPassable(grid, nx, ny)) continue;
      if (occupied.has(k)) continue; // cannot enter/pass through an occupied tile
      dist.set(k, d + 1);
      out.push({ x: nx, y: ny });
      queue.push({ x: nx, y: ny });
    }
  }
  return out;
}

export function isReachable(
  grid: Grid,
  startX: number,
  startY: number,
  range: number,
  targetX: number,
  targetY: number,
  opts: ReachOptions = {},
): boolean {
  if (startX === targetX && startY === targetY) return false;
  return reachableTiles(grid, startX, startY, range, opts).some(
    (t) => t.x === targetX && t.y === targetY,
  );
}

// ---------------------------------------------------------------------------
// Turn order / team rotation
// ---------------------------------------------------------------------------

export type Team = "A" | "B";

export function otherTeam(team: Team): Team {
  return team === "A" ? "B" : "A";
}

/** Minimal per-unit shape the rotation + validation helpers reason about. A
 * server's schema Unit is a superset of this (adds runtime/@type fields). */
export type UnitLike = {
  unitId: string;
  team: Team;
  x: number;
  y: number;
  hp: number;
  hasMoved: boolean;
  hasActed: boolean;
};

export function livingUnits(units: UnitLike[], team: Team): UnitLike[] {
  return units.filter((u) => u.team === team && u.hp > 0);
}

/** Has the given team finished its turn? True when it has at least one living
 * unit and every living unit has acted (a unit is "done" once it hasActed). */
export function teamTurnComplete(units: UnitLike[], team: Team): boolean {
  const living = livingUnits(units, team);
  if (living.length === 0) return true; // a wiped team has nothing left to do
  return living.every((u) => u.hasActed);
}

/**
 * Given the team that just finished, return the next active team. Skips a team
 * that has no living units (so a near-dead board still rotates sanely). Returns
 * null when NEITHER team can act (game is decided).
 */
export function nextActiveTeam(units: UnitLike[], finished: Team): Team | null {
  const candidate = otherTeam(finished);
  if (livingUnits(units, candidate).length > 0) return candidate;
  if (livingUnits(units, finished).length > 0) return finished;
  return null;
}

/** Reset the per-turn action flags for every living unit on a team (called when
 * that team's turn begins). Pure: returns new unit objects, does not mutate. */
export function beginTeamTurn(units: UnitLike[], team: Team): UnitLike[] {
  return units.map((u) =>
    u.team === team && u.hp > 0 ? { ...u, hasMoved: false, hasActed: false } : u,
  );
}

/** The winning team if the game is decided (opponent fully wiped), else null. */
export function winner(units: UnitLike[]): Team | null {
  const aAlive = livingUnits(units, "A").length > 0;
  const bAlive = livingUnits(units, "B").length > 0;
  if (aAlive && !bAlive) return "A";
  if (bAlive && !aAlive) return "B";
  return null;
}

// ---------------------------------------------------------------------------
// Legal-move / legal-attack validation
// ---------------------------------------------------------------------------

export type Validation = { ok: true } | { ok: false; reason: string };

export function manhattan(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

export function isAdjacent(ax: number, ay: number, bx: number, by: number): boolean {
  return manhattan(ax, ay, bx, by) === 1;
}

function occupiedByOthers(units: UnitLike[], selfId: string): Set<string> {
  const set = new Set<string>();
  for (const u of units) {
    if (u.unitId === selfId) continue;
    if (u.hp <= 0) continue;
    set.add(tileKey(u.x, u.y));
  }
  return set;
}

/**
 * Validate a move intent: it must be this unit's team's turn, the unit alive and
 * not yet moved, and the target within movement range over passable/unoccupied
 * tiles. `moveRange` is the unit's movement allowance in tiles.
 */
export function validateMove(
  grid: Grid,
  units: UnitLike[],
  activeTeam: Team,
  unitId: string,
  targetX: number,
  targetY: number,
  moveRange: number,
): Validation {
  const unit = units.find((u) => u.unitId === unitId);
  if (!unit) return { ok: false, reason: "no-such-unit" };
  if (unit.hp <= 0) return { ok: false, reason: "unit-dead" };
  if (unit.team !== activeTeam) return { ok: false, reason: "not-your-turn" };
  if (unit.hasMoved) return { ok: false, reason: "already-moved" };
  if (unit.hasActed) return { ok: false, reason: "already-acted" };
  if (!inBounds(grid.width, grid.height, targetX, targetY))
    return { ok: false, reason: "out-of-bounds" };
  const occupied = occupiedByOthers(units, unitId);
  if (!isReachable(grid, unit.x, unit.y, moveRange, targetX, targetY, { occupied }))
    return { ok: false, reason: "out-of-range" };
  return { ok: true };
}

/**
 * Validate an attack intent: this unit's turn, unit alive and not yet acted, the
 * target an enemy that is adjacent and alive.
 */
export function validateAttack(
  units: UnitLike[],
  activeTeam: Team,
  attackerId: string,
  targetId: string,
): Validation {
  const attacker = units.find((u) => u.unitId === attackerId);
  if (!attacker) return { ok: false, reason: "no-such-attacker" };
  if (attacker.hp <= 0) return { ok: false, reason: "attacker-dead" };
  if (attacker.team !== activeTeam) return { ok: false, reason: "not-your-turn" };
  if (attacker.hasActed) return { ok: false, reason: "already-acted" };
  const target = units.find((u) => u.unitId === targetId);
  if (!target) return { ok: false, reason: "no-such-target" };
  if (target.hp <= 0) return { ok: false, reason: "target-dead" };
  if (target.team === attacker.team) return { ok: false, reason: "friendly-fire" };
  if (!isAdjacent(attacker.x, attacker.y, target.x, target.y))
    return { ok: false, reason: "not-adjacent" };
  return { ok: true };
}

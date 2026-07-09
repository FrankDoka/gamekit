import { describe, it, expect } from "vitest";
import {
  makeGrid,
  reachableTiles,
  isReachable,
  tileKey,
  nextActiveTeam,
  teamTurnComplete,
  beginTeamTurn,
  winner,
  validateMove,
  validateAttack,
  type UnitLike,
} from "./index";

// --- BFS reachable-tiles -----------------------------------------------------

describe("reachableTiles / isReachable", () => {
  it("range 1 on an open grid yields 4 orthogonal neighbours, excluding start", () => {
    const grid = makeGrid(5, 5);
    const tiles = reachableTiles(grid, 2, 2, 1);
    expect(tiles.length).toBe(4);
    const keys = new Set(tiles.map((t) => tileKey(t.x, t.y)));
    expect(keys.has("2,1")).toBe(true);
    expect(keys.has("2,3")).toBe(true);
    expect(keys.has("1,2")).toBe(true);
    expect(keys.has("3,2")).toBe(true);
    expect(keys.has("2,2")).toBe(false); // start tile excluded
  });

  it("range 2 on an open grid yields the 12-tile Manhattan diamond", () => {
    const grid = makeGrid(7, 7);
    const tiles = reachableTiles(grid, 3, 3, 2);
    expect(tiles.length).toBe(12);
  });

  it("respects blocked terrain and routes around it", () => {
    const grid = makeGrid(4, 3, [
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
    ]);
    // (1,0) is blocked so (2,0) is NOT reachable in 2 steps from (0,0).
    expect(isReachable(grid, 0, 0, 2, 2, 0, {})).toBe(false);
    // (0,2) is reachable straight down.
    expect(isReachable(grid, 0, 0, 2, 0, 2, {})).toBe(true);
  });

  it("treats occupied tiles as impassable (cannot pass through units)", () => {
    const grid = makeGrid(5, 1);
    const occupied = new Set<string>([tileKey(1, 0)]);
    // Unit at (0,0), range 3, but (1,0) occupied -> nothing to the right is reachable.
    const tiles = reachableTiles(grid, 0, 0, 3, { occupied });
    expect(tiles.length).toBe(0);
  });

  it("isReachable returns false for the start tile itself", () => {
    const grid = makeGrid(5, 5);
    expect(isReachable(grid, 2, 2, 3, 2, 2, {})).toBe(false);
  });
});

// --- Turn order / team rotation ---------------------------------------------

function mkUnit(over: Partial<UnitLike> & Pick<UnitLike, "unitId" | "team">): UnitLike {
  return { x: 0, y: 0, hp: 10, hasMoved: false, hasActed: false, ...over };
}

describe("turn rotation", () => {
  it("nextActiveTeam rotates A -> B when B has living units", () => {
    const units = [mkUnit({ unitId: "a1", team: "A" }), mkUnit({ unitId: "b1", team: "B" })];
    expect(nextActiveTeam(units, "A")).toBe("B");
    expect(nextActiveTeam(units, "B")).toBe("A");
  });

  it("nextActiveTeam skips a wiped team and returns null when both are wiped", () => {
    const units = [
      mkUnit({ unitId: "a1", team: "A", hp: 5 }),
      mkUnit({ unitId: "b1", team: "B", hp: 0 }),
    ];
    // B is wiped, so after A finishes, A acts again (B has nobody).
    expect(nextActiveTeam(units, "A")).toBe("A");
    const dead = [
      mkUnit({ unitId: "a1", team: "A", hp: 0 }),
      mkUnit({ unitId: "b1", team: "B", hp: 0 }),
    ];
    expect(nextActiveTeam(dead, "A")).toBeNull();
  });

  it("teamTurnComplete is true only when every living unit has acted", () => {
    const units = [
      mkUnit({ unitId: "a1", team: "A", hasActed: true }),
      mkUnit({ unitId: "a2", team: "A", hasActed: false }),
    ];
    expect(teamTurnComplete(units, "A")).toBe(false);
    units[1].hasActed = true;
    expect(teamTurnComplete(units, "A")).toBe(true);
  });

  it("teamTurnComplete is true for a wiped team (nothing left to do)", () => {
    const units = [mkUnit({ unitId: "a1", team: "A", hp: 0 })];
    expect(teamTurnComplete(units, "A")).toBe(true);
  });

  it("beginTeamTurn clears flags only for the active team's living units", () => {
    const units = [
      mkUnit({ unitId: "a1", team: "A", hasMoved: true, hasActed: true }),
      mkUnit({ unitId: "a2", team: "A", hp: 0, hasMoved: true, hasActed: true }),
      mkUnit({ unitId: "b1", team: "B", hasMoved: true, hasActed: true }),
    ];
    const next = beginTeamTurn(units, "A");
    expect(next[0].hasMoved).toBe(false); // living A unit reset
    expect(next[0].hasActed).toBe(false);
    expect(next[1].hasActed).toBe(true); // dead A unit untouched
    expect(next[2].hasActed).toBe(true); // B unit untouched
    // Pure: original array not mutated.
    expect(units[0].hasMoved).toBe(true);
  });

  it("winner is decided only when one team is fully wiped", () => {
    expect(
      winner([mkUnit({ unitId: "a1", team: "A" }), mkUnit({ unitId: "b1", team: "B" })]),
    ).toBeNull();
    expect(
      winner([mkUnit({ unitId: "a1", team: "A" }), mkUnit({ unitId: "b1", team: "B", hp: 0 })]),
    ).toBe("A");
  });
});

// --- Validation --------------------------------------------------------------

describe("validateMove", () => {
  it("accepts an in-range move on the active team's turn", () => {
    const grid = makeGrid(5, 5);
    const units = [
      mkUnit({ unitId: "a1", team: "A", x: 0, y: 0 }),
      mkUnit({ unitId: "b1", team: "B", x: 4, y: 4 }),
    ];
    expect(validateMove(grid, units, "A", "a1", 2, 0, 3)).toEqual({ ok: true });
  });

  it("rejects wrong-turn, out-of-range, and already-moved", () => {
    const grid = makeGrid(5, 5);
    const units = [
      mkUnit({ unitId: "a1", team: "A", x: 0, y: 0 }),
      mkUnit({ unitId: "b1", team: "B", x: 4, y: 4 }),
    ];
    // Not B's turn.
    expect(validateMove(grid, units, "A", "b1", 3, 4, 3)).toEqual({
      ok: false,
      reason: "not-your-turn",
    });
    // Out of range (range 1, target 3 away).
    expect(validateMove(grid, units, "A", "a1", 3, 0, 1)).toEqual({
      ok: false,
      reason: "out-of-range",
    });
    // Already moved.
    const moved = [{ ...units[0], hasMoved: true }, units[1]];
    expect(validateMove(grid, moved, "A", "a1", 1, 0, 3)).toEqual({
      ok: false,
      reason: "already-moved",
    });
  });

  it("rejects a target that is out of bounds", () => {
    const grid = makeGrid(5, 5);
    const units = [mkUnit({ unitId: "a1", team: "A", x: 0, y: 0 })];
    expect(validateMove(grid, units, "A", "a1", 9, 9, 3)).toEqual({
      ok: false,
      reason: "out-of-bounds",
    });
  });
});

describe("validateAttack", () => {
  it("requires an adjacent, living enemy on your turn", () => {
    const units = [
      mkUnit({ unitId: "a1", team: "A", x: 1, y: 1 }),
      mkUnit({ unitId: "b1", team: "B", x: 2, y: 1 }),
      mkUnit({ unitId: "b2", team: "B", x: 4, y: 4 }),
      mkUnit({ unitId: "a2", team: "A", x: 1, y: 2 }),
    ];
    expect(validateAttack(units, "A", "a1", "b1")).toEqual({ ok: true }); // adjacent enemy
    expect(validateAttack(units, "A", "a1", "b2")).toEqual({ ok: false, reason: "not-adjacent" });
    expect(validateAttack(units, "A", "a1", "a2")).toEqual({ ok: false, reason: "friendly-fire" });
    expect(validateAttack(units, "B", "a1", "b1")).toEqual({ ok: false, reason: "not-your-turn" });
  });

  it("rejects attacking a dead target", () => {
    const units = [
      mkUnit({ unitId: "a1", team: "A", x: 1, y: 1 }),
      mkUnit({ unitId: "b1", team: "B", x: 2, y: 1, hp: 0 }),
    ];
    expect(validateAttack(units, "A", "a1", "b1")).toEqual({ ok: false, reason: "target-dead" });
  });
});

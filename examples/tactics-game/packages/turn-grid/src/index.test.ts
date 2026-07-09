import { strict as assert } from "node:assert";
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

// A tiny node:assert test runner so the package needs ZERO test-framework deps
// (keeps it pure and cheap to graduate). Run with tsx: `node tsx cli src/index.test.ts`.
let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

// --- BFS reachable-tiles -----------------------------------------------------

test("BFS range 1 on open grid yields 4 orthogonal neighbours", () => {
  const grid = makeGrid(5, 5);
  const tiles = reachableTiles(grid, 2, 2, 1);
  assert.equal(tiles.length, 4);
  const keys = new Set(tiles.map((t) => tileKey(t.x, t.y)));
  assert.ok(keys.has("2,1") && keys.has("2,3") && keys.has("1,2") && keys.has("3,2"));
  assert.ok(!keys.has("2,2"), "start tile is excluded");
});

test("BFS range 2 open grid yields the 12-tile diamond", () => {
  const grid = makeGrid(7, 7);
  const tiles = reachableTiles(grid, 3, 3, 2);
  // Manhattan diamond of radius 2 minus the center = 12 tiles.
  assert.equal(tiles.length, 12);
});

test("BFS respects blocked terrain and routes around it", () => {
  // Wall of blocked tiles at x=1 for y=0..2 forces a detour.
  const grid = makeGrid(4, 3, [
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 1, y: 2 },
  ]);
  // From (0,0) with range 2: (1,0) is blocked so (2,0) is NOT reachable in 2 steps.
  assert.ok(!isReachable(grid, 0, 0, 2, 2, 0, {}));
  // (0,1) and (0,2) are reachable straight down.
  assert.ok(isReachable(grid, 0, 0, 2, 0, 2, {}));
});

test("BFS treats occupied tiles as impassable (cannot pass through units)", () => {
  const grid = makeGrid(5, 1);
  const occupied = new Set<string>([tileKey(1, 0)]);
  // Unit at (0,0), range 3, but (1,0) occupied -> nothing to the right is reachable.
  const tiles = reachableTiles(grid, 0, 0, 3, { occupied });
  assert.equal(tiles.length, 0);
});

// --- Turn order / team rotation ---------------------------------------------

function mkUnit(over: Partial<UnitLike> & Pick<UnitLike, "unitId" | "team">): UnitLike {
  return { x: 0, y: 0, hp: 10, hasMoved: false, hasActed: false, ...over };
}

test("nextActiveTeam rotates A -> B when B has living units", () => {
  const units = [mkUnit({ unitId: "a1", team: "A" }), mkUnit({ unitId: "b1", team: "B" })];
  assert.equal(nextActiveTeam(units, "A"), "B");
  assert.equal(nextActiveTeam(units, "B"), "A");
});

test("nextActiveTeam skips a wiped team and returns null when both wiped", () => {
  const units = [
    mkUnit({ unitId: "a1", team: "A", hp: 5 }),
    mkUnit({ unitId: "b1", team: "B", hp: 0 }),
  ];
  // B is wiped, so after A finishes, A acts again (B has nobody).
  assert.equal(nextActiveTeam(units, "A"), "A");
  const dead = [
    mkUnit({ unitId: "a1", team: "A", hp: 0 }),
    mkUnit({ unitId: "b1", team: "B", hp: 0 }),
  ];
  assert.equal(nextActiveTeam(dead, "A"), null);
});

test("teamTurnComplete true only when every living unit has acted", () => {
  const units = [
    mkUnit({ unitId: "a1", team: "A", hasActed: true }),
    mkUnit({ unitId: "a2", team: "A", hasActed: false }),
  ];
  assert.equal(teamTurnComplete(units, "A"), false);
  units[1].hasActed = true;
  assert.equal(teamTurnComplete(units, "A"), true);
});

test("beginTeamTurn clears flags only for the active team's living units", () => {
  const units = [
    mkUnit({ unitId: "a1", team: "A", hasMoved: true, hasActed: true }),
    mkUnit({ unitId: "a2", team: "A", hp: 0, hasMoved: true, hasActed: true }),
    mkUnit({ unitId: "b1", team: "B", hasMoved: true, hasActed: true }),
  ];
  const next = beginTeamTurn(units, "A");
  assert.equal(next[0].hasMoved, false, "living A unit reset");
  assert.equal(next[0].hasActed, false);
  assert.equal(next[1].hasActed, true, "dead A unit untouched");
  assert.equal(next[2].hasActed, true, "B unit untouched");
});

test("winner is decided only when one team is fully wiped", () => {
  assert.equal(winner([mkUnit({ unitId: "a1", team: "A" }), mkUnit({ unitId: "b1", team: "B" })]), null);
  assert.equal(
    winner([mkUnit({ unitId: "a1", team: "A" }), mkUnit({ unitId: "b1", team: "B", hp: 0 })]),
    "A",
  );
});

// --- Validation --------------------------------------------------------------

test("validateMove rejects wrong-turn, already-moved, and out-of-range", () => {
  const grid = makeGrid(5, 5);
  const units = [
    mkUnit({ unitId: "a1", team: "A", x: 0, y: 0 }),
    mkUnit({ unitId: "b1", team: "B", x: 4, y: 4 }),
  ];
  // A's turn, a1 moves 2 tiles right -> ok.
  assert.deepEqual(validateMove(grid, units, "A", "a1", 2, 0, 3), { ok: true });
  // Not B's turn.
  assert.equal(validateMove(grid, units, "A", "b1", 3, 4, 3).ok, false);
  // Out of range (range 1, target 3 away).
  assert.equal(validateMove(grid, units, "A", "a1", 3, 0, 1).ok, false);
  // Already moved.
  const moved = [{ ...units[0], hasMoved: true }, units[1]];
  assert.equal(validateMove(grid, moved, "A", "a1", 1, 0, 3).ok, false);
});

test("validateAttack requires adjacent living enemy on your turn", () => {
  const units = [
    mkUnit({ unitId: "a1", team: "A", x: 1, y: 1 }),
    mkUnit({ unitId: "b1", team: "B", x: 2, y: 1 }),
    mkUnit({ unitId: "b2", team: "B", x: 4, y: 4 }),
    mkUnit({ unitId: "a2", team: "A", x: 1, y: 2 }),
  ];
  assert.deepEqual(validateAttack(units, "A", "a1", "b1"), { ok: true }); // adjacent enemy
  assert.equal(validateAttack(units, "A", "a1", "b2").ok, false); // too far
  assert.equal(validateAttack(units, "A", "a1", "a2").ok, false); // friendly fire
  assert.equal(validateAttack(units, "B", "a1", "b1").ok, false); // not A's turn
});

console.log(`\n${passed} turn-grid assertions passed.`);

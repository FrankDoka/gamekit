# @gamekit/turn-grid

Pure, genre-reusable **turn-based grid logic** for tactics-style games: grid
passability, BFS movement range, team turn rotation, and legal move/attack
validation.

Everything here is a plain function over plain data — **no Phaser, no Colyseus,
no DOM, zero runtime dependencies**. A server (which owns authoritative state)
and a client (which renders) both call *into* this module; it never imports from
them. That purity is what makes it deterministic and trivially unit-testable.

## What's in it

- **Grid model** — `makeGrid`, `inBounds`, `isPassable` over a row-major
  `blocked` flag array.
- **Movement range** — `reachableTiles` (4-connected BFS to a step budget,
  excluding the start tile, honoring blocked terrain and an `occupied` set) and
  `isReachable`.
- **Turn rotation** — `livingUnits`, `teamTurnComplete`, `nextActiveTeam`
  (skips a wiped team, returns `null` when the game is decided), `beginTeamTurn`
  (pure flag reset), and `winner`.
- **Validation** — `validateMove` and `validateAttack` return a discriminated
  `Validation` (`{ ok: true }` | `{ ok: false; reason }`) so a server can reject
  illegal intents with a stable reason string.

## Usage

```ts
import { makeGrid, reachableTiles, validateMove, type UnitLike } from "@gamekit/turn-grid";

const grid = makeGrid(8, 8, [{ x: 3, y: 3 }]); // one blocked tile

const units: UnitLike[] = [
  { unitId: "a1", team: "A", x: 0, y: 0, hp: 10, hasMoved: false, hasActed: false },
  { unitId: "b1", team: "B", x: 7, y: 7, hp: 10, hasMoved: false, hasActed: false },
];

// Where can a1 go with 3 movement?
const options = reachableTiles(grid, 0, 0, 3);

// Is a specific move legal on A's turn?
const check = validateMove(grid, units, "A", "a1", 2, 0, 3);
if (check.ok) {
  // apply the move in your authoritative state
} else {
  console.warn("illegal move:", check.reason);
}
```

## Canonical library vs. embedded snapshot

This package is the **canonical library version**. The `examples/tactics-game`
embeds a snapshot of this engine (under its own `packages/turn-grid`) so the
example remains a self-contained, forkable project. Keep the two in sync at the
logic level, but neither depends on the other.

# @gamekit/summon

Pure, genre-reusable **gacha "summon" logic**: a seeded RNG, a weighted banner
drop table, a hard-pity guarantee, and roster/currency reducers.

Everything here is a plain function over plain data — **no express, no DOM, no
server/UI deps, zero runtime dependencies**. A server (which owns per-guest
session state and validates currency) and a client (which renders the pool) both
call *into* this module; it never imports from them. Same seed + same starting
state + same banner ⇒ identical pulls, so rates and pity are deterministically
testable.

## What's in it

- **Seeded RNG** — a self-contained `mulberry32` (`makeRng`, `nextRandom`) that
  threads a single `uint32` through state so a guest's pull stream is
  reproducible and resumable.
- **Banner model** — `Banner` (per-rarity `rates`, a unit pool, and a
  `hardPity5` threshold). A `REFERENCE_BANNER` ships from the `./banner` entry.
- **Pull reducers** — `pull(state, banner) -> { result, nextState }` and
  `pullMany`: roll a rarity band by rate, pick a unit within it, force a 5★ when
  pity is reached, reset/increment the pity counter, and append to the roster.
- **Currency + roster helpers** — `PULL_COST`, `pullCost`, `canAfford` (pricing
  policy the server enforces around the pull), and `rosterList`.

> The RNG is kept **local on purpose** (no cross-package dependency) so this
> engine stays standalone. A separate `@gamekit/rng` package exists for callers
> that want a shared generator; consolidation is intentionally left out of here.

## Usage

```ts
import { makeSummonState, pull, pullMany, canAfford } from "@gamekit/summon";
import { REFERENCE_BANNER } from "@gamekit/summon/banner";

let state = makeSummonState(/* seed */ 2026);

// A single pull:
const { result, nextState } = pull(state, REFERENCE_BANNER);
state = nextState;
console.log(result.unit.name, result.pity ? "(pity!)" : "");

// A "Pull x10" — validate currency in your server first:
if (canAfford(/* currency */ 1000, 10)) {
  const batch = pullMany(state, REFERENCE_BANNER, 10);
  state = batch.nextState;
}
```

## Canonical library vs. embedded snapshot

This package is the **canonical library version**. The `examples/gacha-game`
embeds a snapshot of this engine (under its own `packages/summon`) so the example
remains a self-contained, forkable project. Keep the two in sync at the logic
level, but neither depends on the other.

# @gamekit/rng

Seeded, deterministic random-number generation. Pure TypeScript, zero runtime dependencies.

The core is `mulberry32` — a small, fast 32-bit PRNG. A single stream threaded through a
generator makes a seed rebuild the exact same output, which is what deterministic procgen
relies on. `@gamekit/game-contract` re-exports `mulberry32` from here so its procgen keeps the
same symbol.

## API

- `mulberry32(seed: number): () => number` — raw stream, each call returns a float in `[0, 1)`.
- `class Rng` / `makeRng(seed)` — a stateful generator over one mulberry32 stream:
  - `.next(): number` — float in `[0, 1)`.
  - `.int(min, max): number` — integer in `[min, max]` (inclusive).
  - `.bool(p = 0.5): boolean` — true with probability `p`.
  - `.pick(array): T` — uniform element (throws on empty).
  - `.shuffle(array): T[]` — a **new** Fisher-Yates-shuffled copy (input untouched).
  - `.weighted(entries): T` — pick `entry.value` proportional to `entry.weight`.

Every method advances the same stream, so a given seed yields a fully reproducible sequence.

## Usage

```ts
import { Rng } from "@gamekit/rng";

const rng = new Rng(1337);

rng.next();                    // 0.0 .. <1.0
rng.int(1, 6);                 // a d6 roll
rng.bool(0.25);                // true 25% of the time
rng.pick(["sword", "shield"]); // uniform choice
rng.shuffle([1, 2, 3, 4]);     // new shuffled array

rng.weighted([
  { value: "common", weight: 90 },
  { value: "rare", weight: 10 },
]); // "common" ~90% of the time

// Reseeding reproduces the exact same sequence:
new Rng(1337).next() === new Rng(1337).next(); // true
```

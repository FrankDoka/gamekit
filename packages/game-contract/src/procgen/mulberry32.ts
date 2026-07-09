/**
 * Deterministic RNG — mulberry32 + makeRng. The `mulberry32` stream now lives in
 * `@gamekit/rng` (ported VERBATIM from majidmanzarpour/threejs-procedural-dungeon, MIT) and is
 * re-exported here so procgen/dungeon/emitter keep using the same symbol. A single mulberry32
 * stream threaded through every generation stage is what makes a seed rebuild the exact same
 * dungeon. Game-agnostic.
 *
 * The `Rng` interface + `makeRng` below are game-contract's own procgen-shaped helper API
 * (f/i/pick/chance/raw/gauss) and are intentionally kept here — they are a different surface
 * from `@gamekit/rng`'s `Rng` class.
 */

/** Raw mulberry32 stream: 32-bit seed in, () => float in [0,1). Re-exported from @gamekit/rng. */
export { mulberry32 } from "@gamekit/rng";
import { mulberry32 } from "@gamekit/rng";

export interface Rng {
  /** uniform float in [a, b) */
  f(a: number, b: number): number;
  /** uniform integer in [a, b] inclusive */
  i(a: number, b: number): number;
  /** uniform pick from a non-empty array */
  pick<T>(arr: readonly T[]): T;
  /** true with probability p */
  chance(p: number): boolean;
  /** the raw stream */
  raw(): number;
  /** Box-Muller normal (mu, sigma) */
  gauss(mu: number, sig: number): number;
}

export function makeRng(seed: number): Rng {
  const r = mulberry32(seed);
  return {
    f: (a, b) => a + r() * (b - a),
    i: (a, b) => a + Math.floor(r() * (b - a + 1)),
    pick: (arr) => arr[Math.floor(r() * arr.length)],
    chance: (p) => r() < p,
    raw: r,
    gauss(mu, sig) {
      let u = 0;
      let v = 0;
      while (u === 0) u = r();
      while (v === 0) v = r();
      return mu + sig * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
}

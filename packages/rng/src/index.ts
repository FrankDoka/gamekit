/**
 * @gamekit/rng — seeded, deterministic RNG.
 *
 * The core `mulberry32` stream is byte-identical to the algorithm ported VERBATIM from
 * majidmanzarpour/threejs-procedural-dungeon (MIT): a single mulberry32 stream threaded
 * through a generator makes a seed rebuild the exact same output. `@gamekit/game-contract`
 * re-exports `mulberry32` from here so procgen keeps the same symbol.
 *
 * Pure TypeScript. No runtime deps. Everything below is deterministic from the seed.
 */

/** Raw mulberry32 stream: 32-bit seed in, () => float in [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A weighted-pick entry: `value` selected with probability proportional to `weight`. */
export interface WeightedEntry<T> {
  value: T;
  weight: number;
}

/**
 * A small stateful RNG over a single mulberry32 stream. Construct with a numeric seed;
 * every method advances the same stream, so a given seed produces a fully reproducible
 * sequence of calls.
 */
export class Rng {
  private readonly stream: () => number;

  constructor(seed: number) {
    this.stream = mulberry32(seed);
  }

  /** Uniform float in [0, 1). Advances the stream by one draw. */
  next(): number {
    return this.stream();
  }

  /**
   * Uniform integer in [minInclusive, maxInclusive]. If min > max the bounds are swapped
   * so the range is always non-empty.
   */
  int(minInclusive: number, maxInclusive: number): number {
    let lo = Math.ceil(minInclusive);
    let hi = Math.floor(maxInclusive);
    if (lo > hi) {
      const tmp = lo;
      lo = hi;
      hi = tmp;
    }
    return lo + Math.floor(this.stream() * (hi - lo + 1));
  }

  /** true with probability p (default 0.5). */
  bool(p = 0.5): boolean {
    return this.stream() < p;
  }

  /** Uniform pick from a non-empty array. Throws on an empty array. */
  pick<T>(array: readonly T[]): T {
    if (array.length === 0) {
      throw new Error("Rng.pick: cannot pick from an empty array");
    }
    return array[Math.floor(this.stream() * array.length)];
  }

  /**
   * Returns a NEW array that is a shuffled copy of the input (Fisher-Yates). The input
   * is not mutated.
   */
  shuffle<T>(array: readonly T[]): T[] {
    const out = array.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.stream() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  /**
   * Weighted pick: selects `entry.value` with probability proportional to `entry.weight`.
   * Weights must be finite and non-negative and sum to a positive total; throws otherwise.
   */
  weighted<T>(entries: readonly WeightedEntry<T>[]): T {
    if (entries.length === 0) {
      throw new Error("Rng.weighted: cannot pick from an empty entry list");
    }
    let total = 0;
    for (const e of entries) {
      if (!(e.weight >= 0) || !Number.isFinite(e.weight)) {
        throw new Error("Rng.weighted: weights must be finite and non-negative");
      }
      total += e.weight;
    }
    if (total <= 0) {
      throw new Error("Rng.weighted: total weight must be positive");
    }
    let roll = this.stream() * total;
    for (const e of entries) {
      roll -= e.weight;
      if (roll < 0) {
        return e.value;
      }
    }
    // Floating-point guard: return the last entry if rounding leaves roll >= 0.
    return entries[entries.length - 1].value;
  }
}

/** Factory mirror of `new Rng(seed)`. */
export function makeRng(seed: number): Rng {
  return new Rng(seed);
}

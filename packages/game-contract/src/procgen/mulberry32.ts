/**
 * Deterministic RNG — mulberry32 + makeRng. Ported VERBATIM from
 * majidmanzarpour/threejs-procedural-dungeon (MIT). A single mulberry32 stream threaded through
 * every generation stage is what makes a seed rebuild the exact same dungeon. Game-agnostic.
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

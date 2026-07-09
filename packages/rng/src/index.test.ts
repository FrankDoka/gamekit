import { describe, it, expect } from "vitest";
import { mulberry32, Rng, makeRng } from "./index.js";

describe("mulberry32", () => {
  it("is deterministic: same seed produces the same stream", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA = [a(), a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it("returns floats in [0, 1)", () => {
    const r = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("different seeds produce different streams", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toBe(b());
  });
});

describe("Rng determinism", () => {
  it("same seed produces identical call sequences", () => {
    const r1 = new Rng(42);
    const r2 = makeRng(42);
    const seq1 = [r1.next(), r1.int(0, 100), r1.bool(), r1.pick([1, 2, 3])];
    const seq2 = [r2.next(), r2.int(0, 100), r2.bool(), r2.pick([1, 2, 3])];
    expect(seq1).toEqual(seq2);
  });

  it("makeRng and new Rng agree", () => {
    const a = new Rng(999);
    const b = makeRng(999);
    expect(a.next()).toBe(b.next());
  });
});

describe("Rng.int", () => {
  it("stays within inclusive bounds and hits both endpoints", () => {
    const r = new Rng(3);
    let sawMin = false;
    let sawMax = false;
    for (let i = 0; i < 5000; i++) {
      const v = r.int(5, 8);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(8);
      expect(Number.isInteger(v)).toBe(true);
      if (v === 5) sawMin = true;
      if (v === 8) sawMax = true;
    }
    expect(sawMin).toBe(true);
    expect(sawMax).toBe(true);
  });

  it("handles a single-value range", () => {
    const r = new Rng(1);
    for (let i = 0; i < 20; i++) {
      expect(r.int(4, 4)).toBe(4);
    }
  });

  it("swaps reversed bounds", () => {
    const r = new Rng(1);
    for (let i = 0; i < 100; i++) {
      const v = r.int(10, 2);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(10);
    }
  });
});

describe("Rng.bool", () => {
  it("p=1 is always true, p=0 always false", () => {
    const r = new Rng(11);
    for (let i = 0; i < 50; i++) {
      expect(r.bool(1)).toBe(true);
      expect(r.bool(0)).toBe(false);
    }
  });

  it("p=0.5 is roughly balanced", () => {
    const r = new Rng(77);
    let trues = 0;
    const n = 10000;
    for (let i = 0; i < n; i++) if (r.bool()) trues++;
    const ratio = trues / n;
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeLessThan(0.55);
  });
});

describe("Rng.pick", () => {
  it("returns an element of the array", () => {
    const r = new Rng(5);
    const arr = ["a", "b", "c", "d"];
    for (let i = 0; i < 500; i++) {
      expect(arr).toContain(r.pick(arr));
    }
  });

  it("throws on empty array", () => {
    const r = new Rng(1);
    expect(() => r.pick([])).toThrow();
  });
});

describe("Rng.shuffle", () => {
  it("returns a permutation without mutating the input", () => {
    const r = new Rng(8);
    const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const copy = input.slice();
    const shuffled = r.shuffle(input);
    // Input untouched
    expect(input).toEqual(copy);
    // New array, same multiset
    expect(shuffled).not.toBe(input);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(copy);
  });

  it("is deterministic per seed", () => {
    const a = new Rng(20).shuffle([1, 2, 3, 4, 5]);
    const b = new Rng(20).shuffle([1, 2, 3, 4, 5]);
    expect(a).toEqual(b);
  });
});

describe("Rng.weighted", () => {
  it("respects weights over many draws", () => {
    const r = new Rng(1234);
    const entries = [
      { value: "common", weight: 90 },
      { value: "rare", weight: 10 },
    ];
    const counts: Record<string, number> = { common: 0, rare: 0 };
    const n = 20000;
    for (let i = 0; i < n; i++) counts[r.weighted(entries)]++;
    const commonRatio = counts.common / n;
    // Expect ~0.9 common; allow tolerance.
    expect(commonRatio).toBeGreaterThan(0.86);
    expect(commonRatio).toBeLessThan(0.94);
    expect(counts.rare).toBeGreaterThan(0);
  });

  it("never returns a zero-weight entry", () => {
    const r = new Rng(55);
    const entries = [
      { value: "yes", weight: 1 },
      { value: "never", weight: 0 },
    ];
    for (let i = 0; i < 1000; i++) {
      expect(r.weighted(entries)).toBe("yes");
    }
  });

  it("throws on empty, all-zero, or negative weights", () => {
    const r = new Rng(1);
    expect(() => r.weighted([])).toThrow();
    expect(() => r.weighted([{ value: "x", weight: 0 }])).toThrow();
    expect(() => r.weighted([{ value: "x", weight: -1 }])).toThrow();
  });

  it("is deterministic per seed", () => {
    const entries = [
      { value: "a", weight: 1 },
      { value: "b", weight: 1 },
      { value: "c", weight: 1 },
    ];
    const s1 = Array.from({ length: 10 }, () => 0);
    const r1 = new Rng(321);
    const r2 = new Rng(321);
    const out1 = s1.map(() => r1.weighted(entries));
    const out2 = s1.map(() => r2.weighted(entries));
    expect(out1).toEqual(out2);
  });
});

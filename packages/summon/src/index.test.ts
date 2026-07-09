import { describe, it, expect } from "vitest";
import {
  makeSummonState,
  makeRng,
  nextRandom,
  pull,
  pullMany,
  pullCost,
  canAfford,
  rosterList,
  type Banner,
  type Rarity,
} from "./index";
import { REFERENCE_BANNER } from "./banner";

// --- Seeded RNG determinism --------------------------------------------------

describe("seeded RNG", () => {
  it("nextRandom is deterministic and in [0,1) for a fixed seed", () => {
    const a = nextRandom(makeRng(12345));
    const b = nextRandom(makeRng(12345));
    expect(a.value).toBe(b.value); // same seed -> same value
    expect(a.value).toBeGreaterThanOrEqual(0);
    expect(a.value).toBeLessThan(1);
    // A different seed generally gives a different value.
    const c = nextRandom(makeRng(999));
    expect(a.value).not.toBe(c.value);
  });

  it("pull is a pure reducer: same seed+banner -> identical pull, input untouched", () => {
    const s = makeSummonState(42);
    const one = pull(s, REFERENCE_BANNER);
    const two = pull(s, REFERENCE_BANNER);
    expect(one.result.unit.unitId).toBe(two.result.unit.unitId);
    expect(one.nextState.pityCounter).toBe(two.nextState.pityCounter);
    // Input state was not mutated.
    expect(s.pityCounter).toBe(0);
    expect(Object.keys(s.roster).length).toBe(0);
  });
});

// --- Drop rates respected over many seeded pulls (within tolerance) ----------

describe("drop rates", () => {
  it("respects the base rates over 20000 seeded pulls within tolerance", () => {
    // Push pity out of reach so hard pity never distorts the base-rate sample.
    const noPityBanner: Banner = { ...REFERENCE_BANNER, hardPity5: 10_000_000 };
    let state = makeSummonState(2026);
    const N = 20000;
    const counts: Record<Rarity, number> = { 3: 0, 4: 0, 5: 0 };
    for (let i = 0; i < N; i++) {
      const step = pull(state, noPityBanner);
      counts[step.result.unit.rarity] += 1;
      state = step.nextState;
    }
    const p3 = counts[3] / N;
    const p4 = counts[4] / N;
    const p5 = counts[5] / N;
    // Base rates are 0.79 / 0.18 / 0.03. Allow ±0.02 sampling tolerance.
    expect(Math.abs(p3 - 0.79)).toBeLessThan(0.02);
    expect(Math.abs(p4 - 0.18)).toBeLessThan(0.02);
    expect(Math.abs(p5 - 0.03)).toBeLessThan(0.02);
  });
});

// --- Hard pity forces a 5★ at the guaranteed count ---------------------------

describe("hard pity", () => {
  it("forces a 5★ exactly at hardPity5 and resets the counter", () => {
    const banner: Banner = { ...REFERENCE_BANNER, hardPity5: 20 };
    // Force base rates to never roll a 5★ naturally, isolating pity.
    const noNat5: Banner = { ...banner, rates: { 3: 0.8, 4: 0.2, 5: 0 } };
    let state = makeSummonState(7);
    let firstFive = -1;
    let pityFlagAt = -1;
    for (let i = 1; i <= 20; i++) {
      const step = pull(state, noNat5);
      if (step.result.unit.rarity === 5 && firstFive === -1) firstFive = i;
      if (step.result.pity && pityFlagAt === -1) pityFlagAt = i;
      state = step.nextState;
    }
    expect(firstFive).toBe(20); // no natural 5★ (rate 0) -> first 5★ is the pity pull #20
    expect(pityFlagAt).toBe(20); // pity flag set on pull 20
    expect(state.pityCounter).toBe(0); // counter reset after the guaranteed 5★
  });

  it("increments the pity counter on a non-5★ and resets it on any 5★", () => {
    const banner: Banner = { ...REFERENCE_BANNER, hardPity5: 100 };
    // Guarantee an early natural 5★ by forcing rate 1.0 on 5★.
    const all5: Banner = { ...banner, rates: { 3: 0, 4: 0, 5: 1 } };
    const state = makeSummonState(1);
    const step = pull(state, all5);
    expect(step.result.unit.rarity).toBe(5);
    expect(step.nextState.pityCounter).toBe(0); // 5★ resets pity to 0

    const no5: Banner = { ...banner, rates: { 3: 1, 4: 0, 5: 0 } };
    const s2 = pull(state, no5);
    expect(s2.nextState.pityCounter).toBe(1); // non-5★ increments pity
  });
});

// --- Roster / currency bookkeeping ------------------------------------------

describe("roster + currency reducers", () => {
  it("pullMany appends every result to the roster with correct counts", () => {
    const state = makeSummonState(123);
    const { results, nextState } = pullMany(state, REFERENCE_BANNER, 10);
    expect(results.length).toBe(10);
    const totalOwned = Object.values(nextState.roster).reduce((n, u) => n + u.count, 0);
    expect(totalOwned).toBe(10); // roster total count == number of pulls
    for (const r of results) {
      expect(nextState.roster[r.unit.unitId]).toBeTruthy();
    }
  });

  it("duplicate pulls increment count rather than adding a new roster line", () => {
    const banner: Banner = {
      ...REFERENCE_BANNER,
      // Single-unit pool -> every pull is the same unit.
      units: [{ unitId: "only", name: "Only", rarity: 3 }],
      rates: { 3: 1, 4: 0, 5: 0 },
      hardPity5: 1000,
    };
    const { nextState } = pullMany(makeSummonState(5), banner, 4);
    expect(Object.keys(nextState.roster).length).toBe(1);
    expect(nextState.roster["only"].count).toBe(4);
  });

  it("currency helpers: cost scales with count and the affordability gate is exact", () => {
    expect(pullCost(1)).toBe(100);
    expect(pullCost(10)).toBe(1000);
    expect(canAfford(1000, 10)).toBe(true);
    expect(canAfford(999, 10)).toBe(false);
    expect(canAfford(100, 1)).toBe(true);
    expect(canAfford(99, 1)).toBe(false);
  });

  it("rosterList sorts by rarity desc then name", () => {
    const banner: Banner = { ...REFERENCE_BANNER, rates: { 3: 1, 4: 0, 5: 0 }, hardPity5: 1000 };
    const { nextState } = pullMany(makeSummonState(9), banner, 30);
    const list = rosterList(nextState.roster);
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].rarity).toBeGreaterThanOrEqual(list[i].rarity);
    }
  });
});

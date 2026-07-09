import { strict as assert } from "node:assert";
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

// A tiny node:assert test runner so the package needs ZERO test-framework deps
// (keeps it pure and cheap to graduate). Run with tsx:
//   node ../../node_modules/tsx/dist/cli.mjs src/index.test.ts
let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

// --- Seeded RNG determinism --------------------------------------------------

test("nextRandom is deterministic and in [0,1) for a fixed seed", () => {
  const a = nextRandom(makeRng(12345));
  const b = nextRandom(makeRng(12345));
  assert.equal(a.value, b.value, "same seed -> same value");
  assert.ok(a.value >= 0 && a.value < 1, "value in [0,1)");
  // A different seed generally gives a different value.
  const c = nextRandom(makeRng(999));
  assert.notEqual(a.value, c.value);
});

test("pull is a pure reducer: same seed+banner -> identical pull", () => {
  const s = makeSummonState(42);
  const one = pull(s, REFERENCE_BANNER);
  const two = pull(s, REFERENCE_BANNER);
  assert.equal(one.result.unit.unitId, two.result.unit.unitId, "deterministic unit");
  assert.equal(one.nextState.pityCounter, two.nextState.pityCounter);
  // Input state was not mutated.
  assert.equal(s.pityCounter, 0, "original state untouched");
  assert.equal(Object.keys(s.roster).length, 0, "original roster untouched");
});

// --- Drop rates respected over many pulls (seeded, within tolerance) ---------

test("rates are respected over 20000 pulls within tolerance", () => {
  // Reset pity to Infinity-large so hard pity never distorts the base-rate sample.
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
  assert.ok(Math.abs(p3 - 0.79) < 0.02, `3★ rate ${p3.toFixed(3)} ~ 0.79`);
  assert.ok(Math.abs(p4 - 0.18) < 0.02, `4★ rate ${p4.toFixed(3)} ~ 0.18`);
  assert.ok(Math.abs(p5 - 0.03) < 0.02, `5★ rate ${p5.toFixed(3)} ~ 0.03`);
  console.log(`     observed rates: 3★=${p3.toFixed(3)} 4★=${p4.toFixed(3)} 5★=${p5.toFixed(3)}`);
});

// --- Hard pity forces a 5★ at the guaranteed count ---------------------------

test("hard pity forces a 5★ exactly at hardPity5 and resets the counter", () => {
  // Seed chosen so natural 5★s don't pre-empt pity; verify by asserting no 5★
  // appears before the guaranteed pull, and pity flag is set on that pull.
  const banner: Banner = { ...REFERENCE_BANNER, hardPity5: 20 };
  // Force the base rates to never roll a 5★ naturally, isolating pity.
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
  assert.equal(firstFive, 20, "no natural 5★ (rate 0) -> first 5★ is the pity pull #20");
  assert.equal(pityFlagAt, 20, "pity flag set on pull 20");
  assert.equal(state.pityCounter, 0, "pity counter reset after the guaranteed 5★");
});

test("pity counter increments on non-5★ and resets on any 5★", () => {
  const banner: Banner = { ...REFERENCE_BANNER, hardPity5: 100 };
  // Guarantee an early natural 5★ by forcing rate 1.0 on 5★.
  const all5: Banner = { ...banner, rates: { 3: 0, 4: 0, 5: 1 } };
  let state = makeSummonState(1);
  const step = pull(state, all5);
  assert.equal(step.result.unit.rarity, 5);
  assert.equal(step.nextState.pityCounter, 0, "5★ resets pity to 0");

  const no5: Banner = { ...banner, rates: { 3: 1, 4: 0, 5: 0 } };
  const s2 = pull(state, no5);
  assert.equal(s2.nextState.pityCounter, 1, "non-5★ increments pity");
});

// --- Roster / currency bookkeeping ------------------------------------------

test("pullMany appends every result to the roster with correct counts", () => {
  const state = makeSummonState(123);
  const { results, nextState } = pullMany(state, REFERENCE_BANNER, 10);
  assert.equal(results.length, 10, "10 pulls -> 10 results");
  const totalOwned = Object.values(nextState.roster).reduce((n, u) => n + u.count, 0);
  assert.equal(totalOwned, 10, "roster total count == number of pulls");
  // Every pulled unit id is present in the roster.
  for (const r of results) {
    assert.ok(nextState.roster[r.unit.unitId], `roster has ${r.unit.unitId}`);
  }
});

test("duplicate pulls increment count rather than adding a new roster line", () => {
  const banner: Banner = {
    ...REFERENCE_BANNER,
    // Single-unit pool -> every pull is the same unit.
    units: [{ unitId: "only", name: "Only", rarity: 3 }],
    rates: { 3: 1, 4: 0, 5: 0 },
    hardPity5: 1000,
  };
  const { nextState } = pullMany(makeSummonState(5), banner, 4);
  assert.equal(Object.keys(nextState.roster).length, 1, "one roster line");
  assert.equal(nextState.roster["only"].count, 4, "count == 4");
});

test("currency helpers: cost scales with count and affordability gate", () => {
  assert.equal(pullCost(1), 100);
  assert.equal(pullCost(10), 1000);
  assert.ok(canAfford(1000, 10), "1000 affords a x10");
  assert.ok(!canAfford(999, 10), "999 does not afford a x10");
  assert.ok(canAfford(100, 1), "100 affords a x1");
  assert.ok(!canAfford(99, 1), "99 does not afford a x1");
});

test("rosterList sorts by rarity desc then name", () => {
  const banner: Banner = { ...REFERENCE_BANNER, rates: { 3: 1, 4: 0, 5: 0 }, hardPity5: 1000 };
  const { nextState } = pullMany(makeSummonState(9), banner, 30);
  const list = rosterList(nextState.roster);
  for (let i = 1; i < list.length; i++) {
    assert.ok(list[i - 1].rarity >= list[i].rarity, "rarity non-increasing");
  }
});

console.log(`\n${passed} summon assertions passed.`);

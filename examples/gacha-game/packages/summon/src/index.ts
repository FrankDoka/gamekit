// @gacha/summon — pure, genre-reusable gacha "summon" logic.
//
// NO express, NO DOM, NO server/UI deps. Everything here is a plain function over
// plain data so it can be unit-tested in Node and later graduate to a top-level
// packages/* without dragging a runtime with it. The HTTP server (which owns the
// per-guest session state) and the browser client both call INTO this module; this
// module never imports from them.
//
// The core is a seeded RNG + a weighted banner drop table + a hard-pity guarantee,
// exposed as PURE reducers: `pull(state, table) -> { result, nextState }` and
// `pullMany`. Same seed + same starting state + same table => identical pulls, so
// rates and pity are deterministically testable.

// ---------------------------------------------------------------------------
// Rarity + banner drop-table model
// ---------------------------------------------------------------------------

export type Rarity = 3 | 4 | 5;

/** One selectable unit on a banner, with the rarity that governs its drop rate. */
export type BannerUnit = {
  unitId: string;
  name: string;
  rarity: Rarity;
};

/**
 * A banner: the pool of pullable units plus the per-rarity base rates and the
 * hard-pity threshold. `rates` are the probabilities of each rarity BAND on a
 * normal pull (must sum to ~1); which specific unit within a band is chosen is
 * uniform over that band's members. `hardPity5` is the pull count at which a 5★
 * is guaranteed if the pity counter reaches it (classic "guaranteed by N").
 */
export type Banner = {
  bannerId: string;
  name: string;
  units: BannerUnit[];
  rates: Record<Rarity, number>;
  /** A 5★ is forced on the pull whose pityCounter would reach this value. */
  hardPity5: number;
};

// ---------------------------------------------------------------------------
// Seeded RNG — mulberry32. Small, fast, and deterministic from a uint32 seed.
// ---------------------------------------------------------------------------

/** Deterministic RNG state = a single uint32. Kept in session state so a guest's
 * pull stream is reproducible and the NEXT pull continues the same sequence. */
export type RngState = { seed: number };

export function makeRng(seed: number): RngState {
  // Force to uint32 so callers can pass any integer seed safely.
  return { seed: seed >>> 0 };
}

/**
 * Advance the RNG one step, returning a float in [0,1) and the next RngState.
 * Pure: does not mutate the input. mulberry32 — well-distributed for this use.
 */
export function nextRandom(rng: RngState): { value: number; next: RngState } {
  let t = (rng.seed + 0x6d2b79f5) >>> 0;
  let x = t;
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  const value = ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  return { value, next: { seed: t } };
}

// ---------------------------------------------------------------------------
// Session state the reducers thread through
// ---------------------------------------------------------------------------

/** An owned unit line in a roster: the unit + how many copies are owned. */
export type OwnedUnit = {
  unitId: string;
  name: string;
  rarity: Rarity;
  count: number;
};

/**
 * The per-guest summon state the reducers own. The HTTP server stores one of
 * these per guest session (plus currency); currency spend is validated by the
 * server BEFORE calling pull/pullMany (see canAfford), keeping this module free
 * of pricing policy.
 */
export type SummonState = {
  rng: RngState;
  /** Pulls since the last 5★. Resets to 0 whenever a 5★ is pulled. Drives pity. */
  pityCounter: number;
  /** roster keyed by unitId for O(1) count bookkeeping. */
  roster: Record<string, OwnedUnit>;
};

export function makeSummonState(seed: number): SummonState {
  return { rng: makeRng(seed), pityCounter: 0, roster: {} };
}

// ---------------------------------------------------------------------------
// The pull reducer
// ---------------------------------------------------------------------------

export type PullResult = {
  unit: BannerUnit;
  /** true when this specific pull was forced to 5★ by hard pity. */
  pity: boolean;
};

const RARITIES: Rarity[] = [3, 4, 5];

/** Pick a rarity band from the banner rates using a [0,1) roll. Falls through to
 * the highest band if rounding leaves a sliver (defensive; rates should sum ~1). */
function rollRarity(banner: Banner, roll: number): Rarity {
  let acc = 0;
  for (const r of RARITIES) {
    acc += banner.rates[r] ?? 0;
    if (roll < acc) return r;
  }
  return 5;
}

/** Uniformly pick one unit of the given rarity from the banner pool. Assumes the
 * banner has at least one unit of every rarity it advertises a rate for. */
function pickUnitOfRarity(banner: Banner, rarity: Rarity, roll: number): BannerUnit {
  const pool = banner.units.filter((u) => u.rarity === rarity);
  if (pool.length === 0) {
    // Defensive: if a band is empty, fall back to any unit so a pull never fails.
    return banner.units[Math.min(banner.units.length - 1, Math.floor(roll * banner.units.length))];
  }
  const idx = Math.min(pool.length - 1, Math.floor(roll * pool.length));
  return pool[idx];
}

function addToRoster(roster: Record<string, OwnedUnit>, unit: BannerUnit): Record<string, OwnedUnit> {
  const existing = roster[unit.unitId];
  const nextLine: OwnedUnit = existing
    ? { ...existing, count: existing.count + 1 }
    : { unitId: unit.unitId, name: unit.name, rarity: unit.rarity, count: 1 };
  return { ...roster, [unit.unitId]: nextLine };
}

/**
 * Perform ONE pull against a banner. Pure reducer:
 *   - if the pity counter would reach `hardPity5` on this pull, force a 5★;
 *   - otherwise roll a rarity band by `rates`, then a unit within that band;
 *   - reset the pity counter to 0 on a 5★, else increment it;
 *   - append the unit to the roster (incrementing its count).
 * Returns the pulled unit (with a `pity` flag) and the next state. Does NOT touch
 * currency — the caller (server) validates + spends currency around this.
 */
export function pull(state: SummonState, banner: Banner): { result: PullResult; nextState: SummonState } {
  // Two rolls per pull: one for the rarity band, one to pick within the band.
  const rollA = nextRandom(state.rng);
  const rollB = nextRandom(rollA.next);

  const willHitPity = state.pityCounter + 1 >= banner.hardPity5;
  let rarity: Rarity;
  let pity = false;
  if (willHitPity) {
    rarity = 5;
    pity = true;
  } else {
    rarity = rollRarity(banner, rollA.value);
  }

  const unit = pickUnitOfRarity(banner, rarity, rollB.value);
  const nextPity = rarity === 5 ? 0 : state.pityCounter + 1;

  const nextState: SummonState = {
    rng: rollB.next,
    pityCounter: nextPity,
    roster: addToRoster(state.roster, unit),
  };
  return { result: { unit, pity }, nextState };
}

/**
 * Perform `count` pulls in sequence, threading state through each. Returns all
 * results in order plus the final state. This is what a "Pull x10" invokes.
 */
export function pullMany(
  state: SummonState,
  banner: Banner,
  count: number,
): { results: PullResult[]; nextState: SummonState } {
  let cur = state;
  const results: PullResult[] = [];
  for (let i = 0; i < count; i++) {
    const step = pull(cur, banner);
    results.push(step.result);
    cur = step.nextState;
  }
  return { results, nextState: cur };
}

// ---------------------------------------------------------------------------
// Currency helper (policy the server enforces; kept here so both ends agree)
// ---------------------------------------------------------------------------

/** Cost per pull in soft currency. A x10 costs 10x — no discount, keep it simple. */
export const PULL_COST = 100;

export function pullCost(count: number): number {
  return PULL_COST * count;
}

export function canAfford(currency: number, count: number): boolean {
  return currency >= pullCost(count);
}

/** Flatten a roster map to a stable, display-friendly array (rarity desc, then
 * name) — used by the client Roster screen and handy in tests. */
export function rosterList(roster: Record<string, OwnedUnit>): OwnedUnit[] {
  return Object.values(roster).sort(
    (a, b) => b.rarity - a.rarity || a.name.localeCompare(b.name),
  );
}

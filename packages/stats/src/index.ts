/**
 * @gamekit/stats — a generic, string-keyed stat block with named modifiers.
 *
 * Pure TypeScript, no engine/DOM/framework dependencies, zero runtime deps.
 * Usable by any genre: RPG attributes, tactics unit stats, gacha unit power.
 *
 * ## Stacking order (well-defined, deterministic)
 *
 * For each stat, starting from its base value `b`:
 *   1. `flat`        — all `flat` modifier values are SUMMED and ADDED first.
 *   2. `percentAdd`  — all `percentAdd` values are SUMMED, then applied ONCE as
 *                      a single `(1 + sum)` multiplier against the post-flat value.
 *   3. `percentMult` — each `percentMult` value is applied as its OWN
 *                      `(1 + value)` multiplier, MULTIPLIED together sequentially.
 *
 * So the resolved value is:
 *
 *   resolved = (b + Σflat) * (1 + ΣpercentAdd) * Π(1 + percentMult_i)
 *
 * `percentAdd` models additive-percentage buffs that share diminishing returns
 * (e.g. "+10% atk" from two sources = +20% total), while `percentMult` models
 * independent multiplicative buffs that compound (e.g. two "+50%" = ×2.25).
 *
 * A stat present in `base` but with no modifiers resolves to its base value.
 * A stat that appears ONLY in a modifier (not in `base`) is treated as base 0.
 */

export type ModifierOp = "flat" | "percentAdd" | "percentMult";

export interface Modifier {
  /** Unique-ish identifier for targeted removal. */
  id: string;
  /** The stat key this modifier applies to. */
  stat: string;
  op: ModifierOp;
  value: number;
  /** Optional grouping tag (e.g. a buff/equipment id) for bulk removal. */
  source?: string;
}

export type BaseStats = Record<string, number>;
export type ResolvedStats = Record<string, number>;

/** Per-stat clamp bounds. Either bound is optional. */
export interface ClampRange {
  min?: number;
  max?: number;
}
export type ClampSpec = Record<string, ClampRange>;

/**
 * Resolve `base` under `modifiers` using the documented stacking order.
 * Stats appearing only in modifiers are seeded from base 0.
 */
export function compute(base: BaseStats, modifiers: readonly Modifier[]): ResolvedStats {
  // Seed accumulators for every stat that appears in base OR in a modifier.
  const flat: Record<string, number> = {};
  const percentAdd: Record<string, number> = {};
  const percentMult: Record<string, number> = {};
  const keys = new Set<string>(Object.keys(base));

  for (const key of keys) {
    flat[key] = 0;
    percentAdd[key] = 0;
    percentMult[key] = 1;
  }

  for (const mod of modifiers) {
    if (!(mod.stat in flat)) {
      keys.add(mod.stat);
      flat[mod.stat] = 0;
      percentAdd[mod.stat] = 0;
      percentMult[mod.stat] = 1;
    }
    switch (mod.op) {
      case "flat":
        flat[mod.stat] += mod.value;
        break;
      case "percentAdd":
        percentAdd[mod.stat] += mod.value;
        break;
      case "percentMult":
        percentMult[mod.stat] *= 1 + mod.value;
        break;
    }
  }

  const out: ResolvedStats = {};
  for (const key of keys) {
    const b = base[key] ?? 0;
    out[key] = (b + flat[key]) * (1 + percentAdd[key]) * percentMult[key];
  }
  return out;
}

/** Apply per-stat clamp bounds to an already-resolved stat map. Non-mutating. */
export function clamp(stats: ResolvedStats, spec: ClampSpec): ResolvedStats {
  const out: ResolvedStats = { ...stats };
  for (const [key, range] of Object.entries(spec)) {
    if (!(key in out)) continue;
    let v = out[key];
    if (range.min !== undefined && v < range.min) v = range.min;
    if (range.max !== undefined && v > range.max) v = range.max;
    out[key] = v;
  }
  return out;
}

/**
 * A mutable holder for base stats + a modifier list, with add/remove helpers
 * and lazy resolution. Purely a convenience wrapper over `compute`/`clamp`.
 */
export class StatBlock {
  private base: BaseStats;
  private modifiers: Modifier[];
  private clampSpec: ClampSpec;

  constructor(base: BaseStats = {}, clampSpec: ClampSpec = {}) {
    this.base = { ...base };
    this.modifiers = [];
    this.clampSpec = { ...clampSpec };
  }

  /** Read-only view of current base values. */
  getBase(): BaseStats {
    return { ...this.base };
  }

  /** Replace the base value of a single stat. */
  setBase(stat: string, value: number): this {
    this.base[stat] = value;
    return this;
  }

  /** Read-only snapshot of the current modifier list. */
  getModifiers(): Modifier[] {
    return this.modifiers.map((m) => ({ ...m }));
  }

  /** Add a modifier. If a modifier with the same id exists it is replaced. */
  addModifier(mod: Modifier): this {
    const existing = this.modifiers.findIndex((m) => m.id === mod.id);
    if (existing >= 0) this.modifiers[existing] = { ...mod };
    else this.modifiers.push({ ...mod });
    return this;
  }

  /** Remove a modifier by its id. Returns true if one was removed. */
  removeModifierById(id: string): boolean {
    const before = this.modifiers.length;
    this.modifiers = this.modifiers.filter((m) => m.id !== id);
    return this.modifiers.length !== before;
  }

  /** Remove every modifier tagged with `source`. Returns the count removed. */
  removeModifiersBySource(source: string): number {
    const before = this.modifiers.length;
    this.modifiers = this.modifiers.filter((m) => m.source !== source);
    return before - this.modifiers.length;
  }

  /** Remove all modifiers. */
  clearModifiers(): this {
    this.modifiers = [];
    return this;
  }

  /** Set (or replace) the clamp spec applied by `resolve`. */
  setClamp(spec: ClampSpec): this {
    this.clampSpec = { ...spec };
    return this;
  }

  /** Resolve current base + modifiers, then apply the clamp spec (if any). */
  resolve(): ResolvedStats {
    const computed = compute(this.base, this.modifiers);
    return Object.keys(this.clampSpec).length > 0 ? clamp(computed, this.clampSpec) : computed;
  }

  /** Resolve and read a single stat (0 if the stat is unknown). */
  get(stat: string): number {
    return this.resolve()[stat] ?? 0;
  }
}

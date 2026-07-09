import { describe, it, expect } from "vitest";
import { compute, clamp, StatBlock, type Modifier } from "./index";

describe("compute — stacking order", () => {
  it("returns base values when there are no modifiers", () => {
    expect(compute({ atk: 10, def: 5 }, [])).toEqual({ atk: 10, def: 5 });
  });

  it("applies flat before percentAdd before percentMult", () => {
    // base 100, +20 flat -> 120; +10% & +10% percentAdd (sum 20%) -> 144;
    // then +50% percentMult -> 216
    const mods: Modifier[] = [
      { id: "f", stat: "atk", op: "flat", value: 20 },
      { id: "a1", stat: "atk", op: "percentAdd", value: 0.1 },
      { id: "a2", stat: "atk", op: "percentAdd", value: 0.1 },
      { id: "m", stat: "atk", op: "percentMult", value: 0.5 },
    ];
    expect(compute({ atk: 100 }, mods).atk).toBeCloseTo(216, 10);
  });

  it("percentAdd sums into a single multiplier (not compounding)", () => {
    // two +50% percentAdd on base 100 = *(1+1.0) = 200
    const mods: Modifier[] = [
      { id: "a1", stat: "hp", op: "percentAdd", value: 0.5 },
      { id: "a2", stat: "hp", op: "percentAdd", value: 0.5 },
    ];
    expect(compute({ hp: 100 }, mods).hp).toBeCloseTo(200, 10);
  });

  it("percentMult modifiers compound independently", () => {
    // two +50% percentMult on base 100 = 100 * 1.5 * 1.5 = 225
    const mods: Modifier[] = [
      { id: "m1", stat: "hp", op: "percentMult", value: 0.5 },
      { id: "m2", stat: "hp", op: "percentMult", value: 0.5 },
    ];
    expect(compute({ hp: 100 }, mods).hp).toBeCloseTo(225, 10);
  });

  it("seeds a stat that only appears in a modifier from base 0", () => {
    expect(compute({}, [{ id: "f", stat: "crit", op: "flat", value: 7 }]).crit).toBe(7);
    // base-0 stat with a percent op stays 0
    expect(
      compute({}, [{ id: "p", stat: "crit", op: "percentMult", value: 5 }]).crit,
    ).toBe(0);
  });
});

describe("StatBlock — add/remove", () => {
  it("adds and resolves modifiers", () => {
    const sb = new StatBlock({ atk: 10 });
    sb.addModifier({ id: "b", stat: "atk", op: "flat", value: 5 });
    expect(sb.get("atk")).toBe(15);
  });

  it("removes a modifier by id", () => {
    const sb = new StatBlock({ atk: 10 });
    sb.addModifier({ id: "b", stat: "atk", op: "flat", value: 5 });
    expect(sb.removeModifierById("b")).toBe(true);
    expect(sb.removeModifierById("nope")).toBe(false);
    expect(sb.get("atk")).toBe(10);
  });

  it("removes all modifiers from a source", () => {
    const sb = new StatBlock({ atk: 10, def: 10 });
    sb.addModifier({ id: "b1", stat: "atk", op: "flat", value: 5, source: "rage" });
    sb.addModifier({ id: "b2", stat: "def", op: "flat", value: 3, source: "rage" });
    sb.addModifier({ id: "b3", stat: "def", op: "flat", value: 1, source: "armor" });
    expect(sb.removeModifiersBySource("rage")).toBe(2);
    expect(sb.get("atk")).toBe(10);
    expect(sb.get("def")).toBe(11); // armor buff survives
  });

  it("replaces a modifier when re-added with the same id", () => {
    const sb = new StatBlock({ atk: 10 });
    sb.addModifier({ id: "b", stat: "atk", op: "flat", value: 5 });
    sb.addModifier({ id: "b", stat: "atk", op: "flat", value: 20 });
    expect(sb.getModifiers()).toHaveLength(1);
    expect(sb.get("atk")).toBe(30);
  });
});

describe("clamp", () => {
  it("clamps min and max per stat, leaving unlisted stats alone", () => {
    const clamped = clamp({ hp: 250, mp: -5, atk: 42 }, {
      hp: { max: 200 },
      mp: { min: 0 },
    });
    expect(clamped).toEqual({ hp: 200, mp: 0, atk: 42 });
  });

  it("StatBlock applies its clamp spec on resolve", () => {
    const sb = new StatBlock({ hp: 100 }, { hp: { max: 120 } });
    sb.addModifier({ id: "big", stat: "hp", op: "percentMult", value: 1 }); // ->200
    expect(sb.get("hp")).toBe(120);
  });
});

describe("derived-stat example", () => {
  it("maxHp derived from vitality: maxHp = vitality * 10, buffed", () => {
    // Model a derived stat by seeding base maxHp from vitality, then buffing it.
    const vitality = 8;
    const sb = new StatBlock({ maxHp: vitality * 10 });
    sb.addModifier({ id: "hpUp", stat: "maxHp", op: "percentAdd", value: 0.25 });
    expect(sb.get("maxHp")).toBeCloseTo(100, 10); // 80 * 1.25
  });
});

describe("edge cases", () => {
  it("empty base + empty modifiers yields an empty map", () => {
    expect(compute({}, [])).toEqual({});
  });

  it("get() returns 0 for an unknown stat", () => {
    expect(new StatBlock({ atk: 1 }).get("mystery")).toBe(0);
  });
});

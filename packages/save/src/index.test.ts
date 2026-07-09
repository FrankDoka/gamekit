import { describe, it, expect } from "vitest";
import {
  defineSave,
  xpForLevel,
  levelForXp,
  xpToNextLevel,
  type Migrate,
  type PowerCurve,
  type TableCurve,
} from "./index.js";
// `Migrate` is a single (unknown -> unknown) signature; test ladders are typed inline below.

interface StateV2 {
  name: string;
  hp: number;
  gold: number;
}

describe("defineSave — round-trip", () => {
  it("serialize -> deserialize returns an equal state", () => {
    const codec = defineSave<StateV2>({ version: 2 });
    const state: StateV2 = { name: "Pancake", hp: 30, gold: 5 };
    const json = codec.serialize(state);
    expect(codec.deserialize(json)).toEqual(state);
  });

  it("serialize stamps the current version", () => {
    const codec = defineSave<StateV2>({ version: 2 });
    const json = codec.serialize({ name: "x", hp: 1, gold: 0 });
    expect(JSON.parse(json).version).toBe(2);
  });
});

describe("defineSave — migration", () => {
  // v1 had { name, hp }. v2 adds gold. The migrate ladder is authored one step at a time.
  const migrate: Migrate = (old, from) => {
    let s = old as Record<string, unknown>;
    if (from < 2) {
      s = { ...s, gold: 0 };
    }
    return s;
  };

  it("migrates a v1 payload to v2, transforming the shape", () => {
    const v1Codec = defineSave<{ name: string; hp: number }>({ version: 1 });
    const oldJson = v1Codec.serialize({ name: "Old", hp: 12 });

    const v2Codec = defineSave<StateV2>({ version: 2, migrate });
    const migrated = v2Codec.deserialize(oldJson);
    expect(migrated).toEqual({ name: "Old", hp: 12, gold: 0 });
  });

  it("does not migrate a payload already at the current version", () => {
    let called = false;
    const codec = defineSave<StateV2>({
      version: 2,
      migrate: (old) => {
        called = true;
        return old;
      },
    });
    const json = codec.serialize({ name: "cur", hp: 5, gold: 9 });
    expect(codec.deserialize(json)).toEqual({ name: "cur", hp: 5, gold: 9 });
    expect(called).toBe(false);
  });

  it("runs a multi-step ladder v1 -> v3", () => {
    // v1: {a}, v2 adds b, v3 adds c
    const ladder: Migrate = (old, from) => {
      let s = old as Record<string, unknown>;
      if (from < 2) s = { ...s, b: 100 };
      if (from < 3) s = { ...s, c: 200 };
      return s;
    };
    // Author migrate one step per call: this ladder handles each `from` correctly.
    const stepLadder: Migrate = (old, from) => {
      const s = old as Record<string, unknown>;
      if (from === 1) return { ...s, b: 100 };
      if (from === 2) return { ...s, c: 200 };
      return s;
    };
    const v1 = defineSave<{ a: number }>({ version: 1 });
    const oldJson = v1.serialize({ a: 7 });
    const v3 = defineSave<{ a: number; b: number; c: number }>({ version: 3, migrate: stepLadder });
    expect(v3.deserialize(oldJson)).toEqual({ a: 7, b: 100, c: 200 });
    // keep `ladder` referenced to avoid unused-var lint
    expect(typeof ladder).toBe("function");
  });
});

describe("defineSave — errors", () => {
  it("throws when deserializing a newer version than supported", () => {
    const newerCodec = defineSave<StateV2>({ version: 3 });
    const futureJson = newerCodec.serialize({ name: "future", hp: 1, gold: 1 });
    const olderCodec = defineSave<StateV2>({ version: 2, migrate: (s) => s });
    expect(() => olderCodec.deserialize(futureJson)).toThrow(/newer than supported/);
  });

  it("throws on malformed JSON", () => {
    const codec = defineSave<StateV2>({ version: 1 });
    expect(() => codec.deserialize("{not json")).toThrow(/invalid JSON/);
  });

  it("throws on a missing version envelope", () => {
    const codec = defineSave<StateV2>({ version: 1 });
    expect(() => codec.deserialize(JSON.stringify({ state: {} }))).toThrow(/missing version/);
  });

  it("throws when a migration is needed but none was provided", () => {
    const v1 = defineSave<{ a: number }>({ version: 1 });
    const oldJson = v1.serialize({ a: 1 });
    const v2NoMigrate = defineSave<{ a: number; b: number }>({ version: 2 });
    expect(() => v2NoMigrate.deserialize(oldJson)).toThrow(/no migrate/);
  });

  it("rejects a non-positive version at define time", () => {
    expect(() => defineSave({ version: 0 })).toThrow();
  });
});

describe("progression — power curve", () => {
  const curve: PowerCurve = { base: 100, exponent: 2 };

  it("level 1 requires 0 xp", () => {
    expect(xpForLevel(1, curve)).toBe(0);
  });

  it("xpForLevel is strictly monotonic increasing", () => {
    let prev = -1;
    for (let lvl = 1; lvl <= 50; lvl++) {
      const xp = xpForLevel(lvl, curve);
      expect(xp).toBeGreaterThan(prev);
      prev = xp;
    }
  });

  it("levelForXp is the inverse of xpForLevel", () => {
    for (let lvl = 1; lvl <= 50; lvl++) {
      const xp = xpForLevel(lvl, curve);
      expect(levelForXp(xp, curve)).toBe(lvl);
    }
  });

  it("levelForXp is monotonic non-decreasing in xp", () => {
    let prev = 0;
    for (let xp = 0; xp <= 300000; xp += 137) {
      const lvl = levelForXp(xp, curve);
      expect(lvl).toBeGreaterThanOrEqual(prev);
      prev = lvl;
    }
  });

  it("xpToNextLevel closes the gap to the next threshold", () => {
    const xp = xpForLevel(5, curve) + 10; // partway into level 5
    const next = xpForLevel(6, curve);
    expect(xpToNextLevel(xp, curve)).toBe(next - xp);
  });

  it("xp below level 1 threshold reports level 1", () => {
    expect(levelForXp(0, curve)).toBe(1);
    expect(levelForXp(-500, curve)).toBe(1);
  });
});

describe("progression — table curve", () => {
  const curve: TableCurve = { thresholds: [0, 50, 150, 400] };

  it("maps xp to the right level", () => {
    expect(levelForXp(0, curve)).toBe(1);
    expect(levelForXp(49, curve)).toBe(1);
    expect(levelForXp(50, curve)).toBe(2);
    expect(levelForXp(399, curve)).toBe(3);
    expect(levelForXp(400, curve)).toBe(4);
    expect(levelForXp(99999, curve)).toBe(4); // clamped to top
  });

  it("xpForLevel matches the table and clamps beyond it", () => {
    expect(xpForLevel(1, curve)).toBe(0);
    expect(xpForLevel(3, curve)).toBe(150);
    expect(xpForLevel(4, curve)).toBe(400);
    expect(xpForLevel(10, curve)).toBe(400); // clamped
  });

  it("xpToNextLevel is 0 at max level", () => {
    expect(xpToNextLevel(400, curve)).toBe(0);
    expect(xpToNextLevel(500, curve)).toBe(0);
    expect(xpToNextLevel(0, curve)).toBe(50);
  });

  it("inverse-consistency across table levels", () => {
    for (let lvl = 1; lvl <= curve.thresholds.length; lvl++) {
      expect(levelForXp(xpForLevel(lvl, curve), curve)).toBe(lvl);
    }
  });
});

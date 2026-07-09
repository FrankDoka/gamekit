# @gamekit/stats

A generic, string-keyed **stat block with named modifiers**. Pure TypeScript, no
engine/DOM/framework dependencies, zero runtime deps. Usable by any genre — RPG
attributes, tactics unit stats, gacha unit power.

## Concepts

- **Base stats** — a plain `Record<string, number>` (e.g. `{ atk: 100, hp: 500 }`).
- **Modifier** — `{ id, stat, op, value, source? }` where `op` is one of
  `"flat" | "percentAdd" | "percentMult"`. `id` is used for targeted removal;
  `source` is an optional group tag for bulk removal (e.g. remove a whole buff).

## Stacking order

For each stat, from its base value `b`:

1. **flat** — all `flat` values are summed and **added** first.
2. **percentAdd** — all `percentAdd` values are summed, then applied **once** as a
   single `(1 + Σ)` multiplier. Two `+10%` sources = `+20%` total.
3. **percentMult** — each `percentMult` value applies its own `(1 + value)`
   multiplier, **multiplied together**. Two `+50%` sources = `×2.25`.

```
resolved = (b + Σflat) * (1 + ΣpercentAdd) * Π(1 + percentMult_i)
```

A stat present in `base` with no modifiers resolves to its base value. A stat that
appears only in a modifier is seeded from base `0`.

## Usage

```ts
import { StatBlock } from "@gamekit/stats";

const sb = new StatBlock({ atk: 100 }, { atk: { min: 0 } });

sb.addModifier({ id: "weapon", stat: "atk", op: "flat", value: 20 });
sb.addModifier({ id: "rage", stat: "atk", op: "percentAdd", value: 0.1, source: "buff:rage" });
sb.addModifier({ id: "crit", stat: "atk", op: "percentMult", value: 0.5, source: "buff:rage" });

sb.get("atk"); // (100 + 20) * 1.1 * 1.5 = 198

sb.removeModifiersBySource("buff:rage"); // drops rage + crit at once
sb.get("atk"); // 120
```

The functional core is also exported directly:

```ts
import { compute, clamp } from "@gamekit/stats";

const resolved = compute({ hp: 100 }, [{ id: "m", stat: "hp", op: "percentMult", value: 0.5 }]);
clamp(resolved, { hp: { max: 120 } });
```

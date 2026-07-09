# @gamekit/save

Versioned save state plus simple XP/level progression. Pure TypeScript, schema-agnostic, zero
runtime dependencies.

## Versioned saves

`defineSave({ version, migrate })` returns a codec generic over your game's state type.
`serialize` wraps the state in a `{ version, state }` envelope and stringifies it. `deserialize`
parses the JSON and runs the migration chain from the stored version up to the current one —
throwing on malformed JSON, a missing version, or a version newer than the codec supports.

Author `migrate` one step at a time (`from === 1` returns the v2 shape, `from === 2` the v3
shape, …); the codec calls it repeatedly, bumping the version by one each pass.

```ts
import { defineSave } from "@gamekit/save";

interface SaveV2 { name: string; hp: number; gold: number }

const codec = defineSave<SaveV2>({
  version: 2,
  // v1 had { name, hp }; v2 adds gold.
  migrate: (old, from) => (from < 2 ? { ...(old as object), gold: 0 } : old),
});

const json = codec.serialize({ name: "Pancake", hp: 30, gold: 5 });
const state = codec.deserialize(json); // migrates older payloads forward automatically
```

## Progression (XP <-> level)

A curve is either a **power curve** (`{ base, exponent }` → cumulative XP to reach a level is
`base * (level-1)^exponent`) or a **table curve** (`{ thresholds }`, cumulative XP per level).

```ts
import { xpForLevel, levelForXp, xpToNextLevel } from "@gamekit/save";

const curve = { base: 100, exponent: 2 };

xpForLevel(5, curve);      // cumulative XP to reach level 5
levelForXp(1600, curve);   // the level that XP total corresponds to
xpToNextLevel(1200, curve); // XP still needed for the next level
```

`levelForXp` and `xpForLevel` are inverse-consistent, and both are monotonic in their input.

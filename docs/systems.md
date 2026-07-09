# Systems — the reusable modules the kit ships

GameKit isn't just tooling; it ships a **core-systems library**: pure, tested, zero-dependency
`@gamekit/*` packages a game reuses. There are two ways to consume them, and both are first-class:

- **Library model** — build your game in this workspace (or install the packages) and depend on
  `@gamekit/*` directly. DRY, versioned, one source of truth.
- **Fork model** — copy a reference template (`examples/*`). Each template **embeds a snapshot** of the
  genre engine it needs, so a fork stays self-contained and copy-portable.

For the genre-to-starter mapping, see [genres.md](genres.md).

---

## The core-systems library (`packages/*`)

Every package is pure TypeScript — **no Phaser / Colyseus / Express / DOM**, zero runtime deps — and
ships **vitest tests that validate its API** (so it's proven, not speculative). All are workspace
members: `pnpm -r typecheck` and `pnpm test` cover them.

| Package | What it gives any game | Tests |
|---|---|---|
| [`@gamekit/game-contract`](../packages/game-contract/) | The **spatial content contract** the game-aware toolkit (`capture:zone`, `zone:*`, `smoke:*`, DevKit) reads a game through — map manifests, zone layout (bounds/spawn/collision), message shapes, editor metadata, render constants, + generic algorithms (camera math, collision, procgen). | (typecheck) |
| [`@gamekit/rng`](../packages/rng/) | Seeded, deterministic RNG — `mulberry32` + `int`/`bool`/`pick`/`shuffle`/`weighted`. The one home for randomness; `game-contract`'s procgen re-exports `mulberry32` from here. | 18 |
| [`@gamekit/save`](../packages/save/) | Versioned save serializer with a **migration chain** (`defineSave`/`serialize`/`deserialize`) + xp/level **progression** curves (`levelForXp`/`xpForLevel`/`xpToNextLevel`). | 20 |
| [`@gamekit/stats`](../packages/stats/) | A stat block with named **modifiers** (flat / percentAdd / percentMult) and a defined stacking order, add/remove by id or source, clamping, derived stats. RPG attributes, tactics unit stats, gacha power. | 14 |
| [`@gamekit/inventory`](../packages/inventory/) | A **slot/stack inventory** — `add`/`remove`/`move`/`count`/`has` with capacity + `maxStack`, merge/split/swap, overflow returns. Action loot, gacha roster, crafting mats. | 19 |
| [`@gamekit/turn-grid`](../packages/turn-grid/) | Turn-based grid engine — BFS reachable-tiles (blocked terrain + occupancy), team rotation, legal move/attack validation. Server authority + client highlights share it. | 16 |
| [`@gamekit/summon`](../packages/summon/) | Gacha engine — seeded weighted rarity table, **hard pity**, pure `pull`/`pullMany` reducers, currency/roster bookkeeping. | 9 |

`turn-grid` and `summon` are the **canonical** versions; `examples/tactics-game` and
`examples/gacha-game` embed a **snapshot** of each so a fork stays self-contained (fork model). Edit
the canonical package for the library model; the template copy is the fork's own to grow. The four
core systems (`rng`, `save`, `stats`, `inventory`) are library-only — a game adopts what it needs.

### Why this is "contract v2"

`@gamekit/game-contract` stays the **spatial** contract the toolkit reads (maps/zones/assets). The
generic, non-spatial game systems every genre needs — RNG, save, stats, inventory, turn/grid,
summon — now live in their **own** packages instead of being crammed into the spatial contract or
reinvented per game. A menu-driven game (gacha) uses `rng`/`save`/`inventory`/`summon` and never
touches `game-contract`; a spatial game uses both. That separation is the v2.

---

## The three server patterns

Each reference game demonstrates one server runtime shape. The toolkit assumes none of them — the
`#auth-guest` guest entry, `GAMEKIT_SMOKE_RUN_ID` boot-log handshake, and an inspectable global are the
only conventions, and all three honor them.

| Pattern | Demonstrated by | Shape |
|---|---|---|
| **Real-time room** | [starter-game `server/`](../examples/starter-game/server/) | Colyseus room `"game"`, per-tick simulation, positions synced to clients, `move.to` intent. |
| **Authoritative-turn** | [tactics-game `server/`](../examples/tactics-game/server/) | Colyseus room `"game"`, **no** tick — state mutates only on validated `move` / `attack` / `endTurn` intents; illegal intents rejected on a `"rejected"` channel. |
| **Request/response HTTP** | [gacha-game `server/`](../examples/gacha-game/server/) | Express JSON API — `POST /api/guest`, `GET /api/state`, `POST /api/summon`; no socket, no room, no tick; state changes only in response to a request. |

**Toolkit-tooling caveat:** the smoke/capture state reader
([`tools/src/smoke/state.ts`](../tools/src/smoke/state.ts)) drives only the real-time room; the
`capture:tactics` / `capture:gacha` siblings cover the other two genres. See the
[genres.md roadmap note](genres.md#known-limitation--roadmap--the-smokecapture-reader-is-action-only).

# Systems — the reusable modules the kit ships

GameKit isn't just tooling; it ships a small set of **pure, testable systems** that a game reuses.
This catalog covers what each one is, where it lives, that forking a template carries it along, and
why it's a pure/testable module. For the genre-to-starter mapping, see [genres.md](genres.md).

Two shapes of reusable system exist here:

1. **The contract** — one top-level package the toolkit reads every game through.
2. **Extracted genre engines** — pure horizontals that live *inside* the reference templates so a
   fork stays self-contained.
3. **Server patterns** — the three server runtimes, each demonstrated by a starter.

---

## 1. `@gamekit/game-contract` — the spatial content contract

- **Lives in:** [`packages/game-contract/`](../packages/game-contract/) (a real top-level workspace
  package, `@gamekit/game-contract`).
- **What it does:** the single interface the game-aware toolkit (`capture:zone`, `zone:*`,
  `smoke:*`, DevKit) reads a game through — map manifests, zone layout (bounds / spawn / collision
  grid), chat + intent message shapes, editor metadata, render constants + asset-scale, plus generic
  reference algorithms (camera math, collision, procgen: `mulberry32`, `dungeon`, `emitter`). See
  [`src/index.ts`](../packages/game-contract/src/index.ts) for the full re-export surface.
- **Pure / testable:** types + generic algorithms only — **no game logic**. The toolkit imports
  ONLY from `@gamekit/game-contract`, never from a specific game's source tree, so a game either
  points these accessors at its own modules or re-exports its real `shared/` symbols under this
  package name. `pnpm --filter @gamekit/game-contract typecheck` is green standalone.
- **Forking:** every reference game already conforms to it, so a fork inherits a validated content
  shape on day one.

## 2. Extracted genre engines

Both are written with **zero framework dependencies** and shipped with a plain `node:assert` test
(no test-framework dep), so they run with a bare `tsx` invocation. They live inside their templates
by design (see the honest note below).

### `@tactics/turn-grid` — turn-based grid logic

- **Lives in:** [`examples/tactics-game/packages/turn-grid/`](../examples/tactics-game/packages/turn-grid/)
  (`@tactics/turn-grid`).
- **What it does:** grid model + passability (`makeGrid`, `inBounds`, `isPassable`), **BFS
  reachable-tiles** (`reachableTiles`, `isReachable` — 4-connected, honors blocked terrain and
  occupied tiles), turn order / team rotation (`nextActiveTeam`, `teamTurnComplete`, `beginTeamTurn`,
  `winner`), and legal-move / legal-attack validation (`validateMove`, `validateAttack`).
- **Pure / testable:** no Phaser, no Colyseus. Both the server (authoritative validation) and the
  client (move-range highlights) import this **one** module, so the highlighted tiles match server
  truth by construction. Test: [`src/index.test.ts`](../examples/tactics-game/packages/turn-grid/src/index.test.ts)
  (11 `node:assert` cases — BFS range/blocked/occupancy + rotation/validation).
- **Forking:** copying `tactics-game/` carries the engine + its test with the game.

### `@gacha/summon` — gacha pull logic

- **Lives in:** [`examples/gacha-game/packages/summon/`](../examples/gacha-game/packages/summon/)
  (`@gacha/summon`).
- **What it does:** seeded RNG (`makeRng`, `nextRandom` — mulberry32, deterministic), weighted banner
  drop table (per-rarity rates + uniform pick within a band), **hard-pity guarantee** (forces a 5★ at
  `hardPity5`, resets the counter on any 5★), pure reducers (`pull` / `pullMany` thread state without
  mutation, so the same seed + banner replays identically), and currency/roster bookkeeping
  (`pullCost`, `canAfford`, `rosterList`). The reference banner is [`src/banner.ts`](../examples/gacha-game/packages/summon/src/banner.ts).
- **Pure / testable:** no Express, no DOM. Both the server (authoritative pulls) and the client
  (banner/rarity display) import this **one** module, so the two ends can never disagree about the
  drop table. Test: [`src/index.test.ts`](../examples/gacha-game/packages/summon/src/index.test.ts)
  (11 `node:assert` cases — RNG determinism, **drop rates within ±0.02 over 20 000 pulls**, hard pity
  forces + resets, currency/roster bookkeeping).
- **Forking:** copying `gacha-game/` carries the engine + its test with the game.

### Honest gap — engines live inside their templates, not as shared top-level packages

`turn-grid` and `summon` are **not** shared top-level `packages/*` (only `game-contract` is). They
live inside their reference games. This is **deliberate for fork-portability**: a fork must be
self-contained and copy-portable, so the genre engine ships *with* the game you clone rather than as
an external dependency you'd have to also vendor. Each is written pure and each README notes it
"could later graduate to a top-level `packages/*`" if a second genre needs the same horizontal —
until then, keeping it in the fork is the feature, not a shortcoming.

## 3. The three server patterns

Each reference game demonstrates one server runtime shape. The toolkit assumes none of them — the
`#auth-guest` guest entry, `GAMEKIT_SMOKE_RUN_ID` boot-log handshake, and inspectable global are the
only conventions, and all three honor them.

| Pattern | Demonstrated by | Shape |
|---|---|---|
| **Real-time room** | [starter-game `server/`](../examples/starter-game/server/) | Colyseus room `"game"`, per-tick simulation, positions synced to clients, `move.to` intent. |
| **Authoritative-turn** | [tactics-game `server/`](../examples/tactics-game/server/) | Colyseus room `"game"`, **no** tick — state mutates only on validated `move` / `attack` / `endTurn` intents; illegal intents rejected on a `"rejected"` channel. |
| **Request/response HTTP** | [gacha-game `server/`](../examples/gacha-game/server/) | Express JSON API — `POST /api/guest`, `GET /api/state`, `POST /api/summon`; no socket, no room, no tick; state changes only in response to a request. |

**Toolkit-tooling caveat:** the smoke/capture state reader
([`tools/src/smoke/state.ts`](../tools/src/smoke/state.ts)) currently drives only the real-time
room. See the [genres.md roadmap note](genres.md#known-limitation--roadmap--the-smokecapture-reader-is-action-only)
for the turn-based and request/response smoke siblings that would extend it.

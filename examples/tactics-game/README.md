# tactics-game — a turn-based grid GameKit reference

A tiny, runnable **turn-based tactics** game (think Fire Emblem / Advance Wars, not an
action MMO). It exists to prove the [GameKit](../../README.md) dev kit is not hard-wired to
real-time genres: the same server/client/asset conventions as the action
[`starter-game`](../starter-game/) carry a **non-real-time, authoritative-turn** game just fine.

It is intentionally minimal: **one board, two teams, two units each.**

![tactics-game — 12×10 grid, two teams, rock obstacles, and a selected unit's BFS move range highlighted](screenshot.png)

_(see the multi-genre overview in [docs/genres.md](../../docs/genres.md).)_

- **Board:** 12×10 tiles at 64px, with 6 impassable "rock" tiles (a 2×2 block in the middle
  plus a few scattered).
- **Teams:** A (blue) starts on the left, B (red) on the right — 2 units each.
- **A unit's activation:** move within its movement range (BFS over passable, unoccupied
  tiles), then one melee attack on an adjacent enemy, then it's done. When every living unit
  on a team has acted (or you hit **End Turn**), the turn passes to the other team.
- **Win** when a team has no living units left.

The **server is authoritative**: every `move` / `attack` / `endTurn` intent is validated
against whose turn it is and the legal ranges; illegal intents are rejected (the server
sends a `rejected` message and leaves state untouched).

## Layout

```
tactics-game/
  packages/turn-grid/          # the extracted horizontal — PURE, no Phaser/Colyseus
    src/index.ts               #   grid+passability, BFS reachable-tiles, team rotation,
    src/index.test.ts          #   move/attack validation  + a node:assert test (11 cases)
  server/                      # Colyseus room "game": turn-based (NOT tick-based)
    src/{index.ts,GameRoom.ts,state.ts}
  client/                      # Vite + Phaser 4: #auth-guest -> join -> render + play
    index.html, src/main.ts
  client/public/assets/        # PIL-generated placeholder PNGs (units + tiles, 64px, 1:1)
```

This is a **separate project** from the toolkit (its own `node_modules`), so the game-aware
tools run against it with `cwd = this folder` — same isolation as `starter-game`.

## The turn-based protocol

**State** (`server/src/state.ts`, synced to the client):

| field | meaning |
|---|---|
| `width`, `height`, `tileSize` | board dimensions (12×10×64) |
| `blocked[]` | row-major impassable-terrain flags, length `width*height` |
| `units[]` | each: `unitId`, `team` (`"A"`/`"B"`), `x`, `y`, `hp`, `maxHp`, `atk`, `moveRange`, `hasMoved`, `hasActed` |
| `activeTeam` | whose turn it is (`"A"`/`"B"`) |
| `phase` | `"playing"` \| `"gameover"` |
| `winnerTeam` | `""` until decided, then `"A"`/`"B"` |

**Intents** — the client sends `room.send("intent", …)`:

- `{ type: "move", unitId, x, y }` — move a unit to a tile within its `moveRange` (BFS).
- `{ type: "attack", unitId, targetId }` — melee an adjacent enemy; spends the activation.
- `{ type: "endTurn" }` — mark the active team done and rotate.

The server replies `{ reason }` on a `"rejected"` channel for any illegal intent.

## The extracted horizontal — `@tactics/turn-grid`

The pure, genre-reusable logic lives in [`packages/turn-grid/`](packages/turn-grid/) with **no
Phaser and no Colyseus deps**, so it is trivially unit-testable and could later graduate to a
top-level `packages/*`:

- **grid model + passability** — `makeGrid`, `inBounds`, `isPassable`
- **BFS reachable-tiles** — `reachableTiles`, `isReachable` (4-connected, honors blocked
  terrain and occupied tiles)
- **turn order / team rotation** — `nextActiveTeam`, `teamTurnComplete`, `beginTeamTurn`,
  `winner`
- **legal-move / legal-attack validation** — `validateMove`, `validateAttack`

Both the **server** (authoritative validation) and the **client** (move-range highlights)
import from this one module, so the highlighted tiles match server truth by construction.

The unit test (`src/index.test.ts`, plain `node:assert` — zero test-framework deps) covers
the BFS (range, blocked routing, occupancy) and the turn rotation/validation.

## Run it

```sh
# one-time install (isolated from the toolkit workspace)
pnpm install --ignore-workspace                          # root: tsx
cd server && pnpm install --ignore-workspace && cd ..     # links @tactics/turn-grid
cd client && pnpm install --ignore-workspace && cd ..

# unit test for the extracted module
node node_modules/tsx/dist/cli.mjs packages/turn-grid/src/index.test.ts

# boot the server + client manually
(cd server && PORT=2600 ALLOW_GUEST_LOGIN=true GAMEKIT_SMOKE_RUN_ID=probe \
   node ../node_modules/tsx/dist/cli.mjs src/index.ts)
(cd client && VITE_COLYSEUS_URL=ws://127.0.0.1:2600 \
   node node_modules/vite/bin/vite.js --host 127.0.0.1)
# open the printed URL, click "Play as Guest"
#   - click a lit-up (active) unit to select it -> its move range highlights
#   - click a highlighted tile to move; click an adjacent enemy (red highlight) to attack
#   - use "End Turn" to pass the turn
```

> Each `pnpm install --ignore-workspace` ends with `ERR_PNPM_IGNORED_BUILDS: … esbuild…` and a
> non-zero exit — **expected, not a failure** (pnpm skips one native post-install script; the game
> still boots). Ignore it.
>
> **Windows (PowerShell):** the boot lines use POSIX inline-env syntax. In PowerShell set the vars
> first, e.g. `$env:PORT='2600'; $env:ALLOW_GUEST_LOGIN='true'; $env:GAMEKIT_SMOKE_RUN_ID='probe'; node ../node_modules/tsx/dist/cli.mjs src/index.ts`
> (and `$env:VITE_COLYSEUS_URL='ws://127.0.0.1:2600'` for the client). Or run them from Git Bash as written.

## How it demonstrates the turn-based genre on GameKit

It reuses the action starter's conventions **exactly** — isolated `pnpm install
--ignore-workspace`, `tsx` at the game root, `vite` in `client/`, a Colyseus room named
`"game"`, an `#auth-guest` "Play as Guest" button, `globalThis.__GAME` exposing a scene keyed
`"game"`, and a server boot log echoing `GAMEKIT_SMOKE_RUN_ID` for the ownership handshake —
but the **runtime shape is turn-based, not real-time**: no per-tick simulation, state mutates
only in response to validated intents, and the room holds abstract board units per *team*
rather than one entity per connection.

### Toolkit tooling — the turn-based capture sibling

The toolkit's action capture reader
([`tools/src/smoke/state.ts`](../../tools/src/smoke/state.ts)) is **action-oriented**: it
reads `scene.room.state.players` keyed by `sessionId`, `scene.playerObjects`, and real-time
fields (`hp/mp/xp/inventory/quests`, `monsters[]`). A tactics game has none of those — its
entities are `units[]` keyed by `unitId` and owned by a team, not a connection — so the action
capture tool can't drive it (it would find zero `players`/`playerObjects`).

The genre-appropriate sibling now ships as
[`tools/src/capture-tactics.ts`](../../tools/src/capture-tactics.ts) (script `pnpm
capture:tactics`). It reuses the action harness's boot mechanics **verbatim** — the same
port-reservation guard and the same `smokeRunId` ownership handshake, factored into the
genre-neutral [`tools/src/smoke/genre-harness.ts`](../../tools/src/smoke/genre-harness.ts) —
and adds a small **units-by-team reader** off the `"game"` scene's `room`/`board`/`units`/
`activeTeam` (it does **not** modify the action `state.ts`). It drives one legal move via a
`move` intent, asserts the unit moved in `room.state`, and screenshots the board before + after
(see `_shots/tactics-board-{before,after}.png`).

This script is **game-aware** — it needs this wired game. Run it from the toolkit root with
`GAME_ROOT` pointing here (or from this folder), optionally passing an out-dir:

```sh
GAME_ROOT=examples/tactics-game pnpm capture:tactics            # -> _shots/tactics-board-*.png
GAME_ROOT=examples/tactics-game pnpm capture:tactics <outDir>
```

The finding held: the genre fits the *conventions*, and the one action-specific reader just
needed a turn-based sibling — which reuses (not forks) the shared boot.

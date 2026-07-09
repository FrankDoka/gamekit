# gacha-game — a menu-driven GACHA GameKit reference

A tiny, runnable **gacha / collection** game (think a summon banner in a mobile RPG).
It exists to prove the [GameKit](../../README.md) dev kit is not hard-wired to real-time or
turn-based genres: the same isolated-install / guest-auth / asset conventions as the action
[`starter-game`](../starter-game/) and the [`tactics-game`](../tactics-game/) carry a
**menu-driven, non-real-time, request/response** game just fine.

The two other references run **stateful game servers** (a Colyseus room). This one deliberately
does **not** — its server is a **plain request/response HTTP API** (Express). That contrast is
the point: GameKit's conventions don't assume a socket/room runtime.

It is intentionally minimal: **one banner, one summon engine, three screens.**

![gacha-game — the Summon screen: banner art, Pull x1 / x10, and a x10 result reveal with a 5★ pity pull](screenshot.png)

_(see the multi-genre overview in [docs/genres.md](../../docs/genres.md).)_

- **Home:** shows currency + pity progress, buttons to Summon / Roster.
- **Summon:** banner art, `Pull x1` / `Pull x10`, a result reveal of each pulled unit's rarity.
- **Roster:** a grid of owned units with rarity and duplicate counts.

The **server is authoritative**: it owns each guest's currency / roster / pity counter in
memory, validates every summon (currency check + spend) **before** running the pure summon
engine, and rejects a pull it can't afford (`402`). Nothing about the outcome is trusted from
the client.

## Layout

```
gacha-game/
  packages/summon/             # the extracted horizontal — PURE, no express/DOM
    src/index.ts               #   seeded RNG, weighted drop table, hard-pity, roster/currency
    src/banner.ts              #   the reference banner data (shared by server + client)
    src/index.test.ts          #   node:assert test (11 cases: rates, pity, bookkeeping)
  server/                      # request/response HTTP API (Express) — NOT a Colyseus room
    src/index.ts               #   POST /api/guest, GET /api/state, POST /api/summon
  client/                      # Vite: #auth-guest -> POST /api/guest -> Home/Summon/Roster
    index.html, src/main.ts    #   a DOM screen router (this genre is ~70% UI)
  client/public/assets/        # PIL-generated placeholder art (units 88px 1:1, banner)
```

This is a **separate project** from the toolkit (its own `node_modules`), so the game-aware
tools run against it with `cwd = this folder` — same isolation as the other two references.

## The request/response API

Everything is JSON over HTTP; the client stores the session token from `/api/guest` and echoes
it in the `x-gacha-session` header. No sockets, no ticking — state changes **only** in response
to a request.

| endpoint | body | does |
|---|---|---|
| `POST /api/guest` | — | start a guest session, grant starting currency (3000), return `{ token, banner, state }`. Gated by `ALLOW_GUEST_LOGIN`. |
| `GET /api/state` | — | return `{ banner, state }` for the session (`x-gacha-session` header). |
| `POST /api/summon` | `{ count: 1 \| 10 }` | authoritative: validate count, check + spend currency, run the seeded engine, apply pity, append to roster, return `{ results, state }`. `402` if insufficient currency. |

`state` = `{ currency, pityCounter, hardPity5, roster[], pullCostX1, pullCostX10 }`; each
`results[]` entry is `{ unitId, name, rarity, pity }` (`pity: true` when a hard-pity 5★).

The server boot log echoes `GAMEKIT_SMOKE_RUN_ID` as `{"msg":"listening","port":…,"smokeRunId":…}`
— the same ownership handshake the other references use. `PORT` and `ALLOW_GUEST_LOGIN` are honored.

## The extracted horizontal — `@gacha/summon`

The pure, genre-reusable logic lives in [`packages/summon/`](packages/summon/) with **no express
and no DOM deps**, so it is trivially unit-testable and could later graduate to a top-level
`packages/*`:

- **seeded RNG** — `makeRng`, `nextRandom` (mulberry32; deterministic from a uint32 seed).
- **weighted banner drop table** — per-rarity rates (`3★`/`4★`/`5★`) + uniform pick within a band.
- **hard-pity guarantee** — a 5★ is forced when `pityCounter` reaches `hardPity5`; the counter
  resets on any 5★.
- **pure reducers** — `pull(state, banner) -> { result, nextState }` and `pullMany` thread state
  through without mutation, so the same seed + banner replays identically.
- **currency/roster bookkeeping** — `pullCost`, `canAfford`, roster count increments, `rosterList`.

Both the **server** (authoritative pulls) and the **client** (banner/rarity display + types)
import from this one module, so the two ends can never disagree about the drop table.

The unit test ([`src/index.test.ts`](packages/summon/src/index.test.ts), plain `node:assert` —
zero test-framework deps) proves: RNG determinism, drop **rates respected over 20 000 seeded
pulls within ±0.02**, **hard pity forces a 5★ at the guaranteed count** (and resets the counter),
and currency/roster bookkeeping.

## Run it

```sh
# one-time install (isolated from the toolkit workspace)
pnpm install --ignore-workspace                          # root: tsx
cd server && pnpm install --ignore-workspace && cd ..     # links @gacha/summon
cd client && pnpm install --ignore-workspace && cd ..

# unit test for the extracted module
node node_modules/tsx/dist/cli.mjs packages/summon/src/index.test.ts

# boot the request/response server
(cd server && PORT=2610 ALLOW_GUEST_LOGIN=true GAMEKIT_SMOKE_RUN_ID=probe \
   node ../node_modules/tsx/dist/cli.mjs src/index.ts)

# boot the client
(cd client && VITE_API_BASE=http://127.0.0.1:2610 \
   node node_modules/vite/bin/vite.js --host 127.0.0.1)
# open the printed URL, click "Play as Guest" -> Home
#   - Summon -> Pull x1 / Pull x10 -> watch the result reveal
#   - Roster -> your owned units with rarity + duplicate counts
```

> Each `pnpm install --ignore-workspace` ends with `ERR_PNPM_IGNORED_BUILDS: … esbuild…` and a
> non-zero exit — **expected, not a failure** (pnpm skips one native post-install script; the game
> still boots). Ignore it.
>
> **Windows (PowerShell):** the boot lines use POSIX inline-env syntax. In PowerShell set the vars
> first, e.g. `$env:PORT='2610'; $env:ALLOW_GUEST_LOGIN='true'; $env:GAMEKIT_SMOKE_RUN_ID='probe'; node ../node_modules/tsx/dist/cli.mjs src/index.ts`
> (and `$env:VITE_API_BASE='http://127.0.0.1:2610'` for the client). Or run them from Git Bash as written.

`globalThis.__GACHA = { token, banner, state, screen, lastResults }` is exposed so the app is
inspectable/driveable from devtools or a smoke harness — same spirit as the action starter's
`globalThis.__GAME`.

## How it demonstrates the gacha genre on GameKit

It reuses the reference conventions **exactly** — isolated `pnpm install --ignore-workspace`,
`tsx` at the game root, `vite` in `client/`, an `#auth-guest` "Play as Guest" entry, an
inspectable global, a server boot log echoing `GAMEKIT_SMOKE_RUN_ID`, and a pure engine extracted
into `packages/*` — but the **runtime shape is request/response, not a stateful game loop**: the
server is Express (no Colyseus room, no WebSocket, no per-tick simulation), and state mutates only
in response to an authoritative HTTP request.

### Toolkit tooling — the request/response capture sibling

This genre breaks the action pipeline's two core assumptions, and the capture sibling handles both:

- **The reader is action-oriented.** The toolkit's state reader
  ([`tools/src/smoke/state.ts`](../../tools/src/smoke/state.ts)) reads a Colyseus `scene.room.state`
  and real-time fields (players by `sessionId`, `monsters[]`, `hp/mp/xp`). A gacha game has none of
  those — its inspectable state is `globalThis.__GACHA` (currency / roster / banner), not a room. The
  sibling reads `__GACHA` instead.
- **The guest handshake is a POST, not a room join.** `#auth-guest` here fires `POST /api/guest`, not
  a socket join. The sibling still clicks `#auth-guest` (the shared convention holds) and waits on the
  HTTP session landing in `__GACHA`.

The genre-appropriate sibling now ships as
[`tools/src/capture-gacha.ts`](../../tools/src/capture-gacha.ts) (script `pnpm capture:gacha`). It
reuses the action harness's boot mechanics **verbatim** via the genre-neutral
[`tools/src/smoke/genre-harness.ts`](../../tools/src/smoke/genre-harness.ts) — including the SAME
`smokeRunId` ownership handshake (this HTTP server echoes the same `{"msg":"listening",…,"smokeRunId":…}`
boot log, so the gate works unchanged) — then drives the DOM UI: `#auth-guest` → Summon → **Pull x10**
→ Roster. It reads `__GACHA`, asserts **currency decreased + roster grew** (3000 → 2000, 0 → 10 copies),
and screenshots Home + Summon-results + Roster (`_shots/gacha-{home,summon-results,roster}.png`).

This script is **game-aware** — it needs this wired game. Run it from the toolkit root with
`GAME_ROOT` pointing here (or from this folder), optionally passing an out-dir:

```sh
GAME_ROOT=examples/gacha-game pnpm capture:gacha            # -> _shots/gacha-*.png
GAME_ROOT=examples/gacha-game pnpm capture:gacha <outDir>
```

The finding held: the genre fits the **conventions**, and the action-specific tools just needed a
request/response sibling — which reuses (not forks) the shared boot.

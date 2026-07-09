# GameKit — a reusable 2D game dev kit

A game-agnostic toolkit for building 2D games: an **Asset Bank + DevKit**, **art/audio pipelines**,
**zone + capture/smoke tooling**, and an **AI-dev harness** for building with parallel AI coding
sessions. It ships no game — you wire yours by implementing `@gamekit/game-contract`.

**A runnable reference game lives in [examples/starter-game](examples/starter-game)** — one zone,
one controllable entity (Colyseus + Phaser 4). It's the fastest way to start: copy it, rename, and
replace the placeholder rectangles with real art. The docs deep-dive is in [docs/README.md](docs/README.md).

## What's inside

| Area | What it is | Game coupling |
|---|---|---|
| **Orchestration harness** | `lane-*`, `intake*`, `integrator-*`, `sessions-*`, `docs-budget`, `coverage-ratchet` | None — pure how-you-build tooling |
| **Asset Bank + DevKit** | `asset-bank*`, `bank-*`, `devkit-hub`, web shell | Paths only (see config) |
| **Audio pipeline** | `audio-*` (ElevenLabs + mock providers) | None |
| **Art pipeline (Python)** | `tools/art-pipeline/`, `tools/asset-cleanup/` (spritesheets, bg-removal, fringe, tint) | None |
| **Game-aware tools** | `capture-*`, `smoke-*`, `zone-*`, `gm-*-proof`, `funnel-report` | Via `@gamekit/game-contract` |

## How a new game plugs in

**Fastest path: fork the reference game.** [examples/starter-game](examples/starter-game) is a
working, minimal game (Colyseus server + Phaser 4 client + contract-conformant content) that every
game-aware tool already runs against. Copy it, rename, and grow it — its README shows the exact
runtime surface the tools expect. The steps below explain the seams if you'd rather wire from scratch.

The game-aware tools depend on **`@gamekit/game-contract`** (`packages/game-contract/`) — a
types-only interface (map manifests, zone layout, chat events, editor metadata, render constants)
plus generic reference algorithms (camera math, collision, procgen). A new game implements this
contract; the capture/zone/smoke tooling then works against it. No game logic lives in the toolkit.

Concrete steps:

1. **Implement `@gamekit/game-contract`.** Either (a) edit the type/const modules in
   `packages/game-contract/src/` to describe your game and point the accessors at your own modules,
   or (b) delete this package's `src` and re-export your game's real `shared/` symbols through a
   package published under the name `@gamekit/game-contract`. The toolkit imports ONLY from
   `@gamekit/game-contract`, never from a specific game's source tree, so either shape works.
   Run `pnpm --filter @gamekit/game-contract typecheck` until green.

2. **Point the filesystem roots at your game** (env vars, resolved by
   `tools/src/toolkit-config.ts` — no hardcoded paths):

   - `GAME_ROOT` — the game repo the tools operate on (default: this toolkit repo until set)
   - `ASSETS_ROOT` — external asset data bank (default: `<GAME_ROOT>/assets-bank`)
   - `ASSETS_METADATA_ROOT` — review-metadata store (default: `<ASSETS_ROOT>-metadata`)

3. **Wire the game-aware scripts.** The `capture-*`, `smoke-*`, `zone-*`, and DevKit tools need a
   running game (client + server) to act on. In your **game** repo's `package.json`, add the
   scripts the docs reference (`build:client`, `boot:server`, `dev:client`, `capture:zone`,
   `smoke:client`, `qa`) so they launch your game and invoke the toolkit tools. These are the game's
   responsibility — this toolkit deliberately ships only the standalone scripts (see below).

### What runs standalone vs needs a wired game

| Runs standalone (no game) | Needs a wired game |
|---|---|
| `pnpm -r typecheck` | `pnpm capture:zone <out>` (boots client+server) |
| `pnpm validate` → `pnpm selftest` (fixture-based) | `pnpm build:client` / `boot:server` / `dev:client` / `qa` |
| `pnpm test` (vitest) | `pnpm smoke:*` (joins a live server) |
| `pnpm assets:scan/check/despill` (operate on files) | `pnpm devkit` zone editor against real assets |
| `pnpm lane:*`, `pnpm intake*`, `pnpm sessions:*`, `pnpm docs:budget` (orchestration) | the `zone-*` / `gm-*-proof` / `funnel-report` tools |

The lane/intake/asset/audio tooling and the selftest gate are pure process/asset tooling and run
against this repo alone. The capture/smoke/zone tools compile standalone (typecheck is green) but do
nothing useful until a game exposes the contract and the launch scripts above.

## The AI-dev doc harness

`docs/` ships the reusable methodology this toolkit was extracted around — parallel AI coding lanes,
the Integrator Conductor Loop, card/checklist model, cold-boot test. Start at
[docs/README.md](docs/README.md) for the reading order.

## CI / Database / Git hooks

**CI** — [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the *standalone* gates on
push/PR to `main`: `pnpm install`, `pnpm -r typecheck`, `pnpm test` (vitest), and `pnpm selftest`
(the Python asset fixtures — the job installs Python 3.11 + Pillow + numpy). The game-aware gates
(`capture:zone`, `smoke:client`, `build:client`, `boot:server`) are intentionally excluded — they
need a wired game; add those in your game repo.

**Database** — [`docker-compose.yml`](docker-compose.yml) ships the Postgres the DevKit
(`tools/src/devkit-hub.ts`) expects: `docker compose up -d` starts container `gamekit-db-1` on
`:5432` (db/user `gamekit`, password `gamekit_dev`, volume `gamekit_pgdata`), giving the DevKit's
`pg_dump`/`psql` backup+restore a working target. [`db/schema.sql`](db/schema.sql) is a minimal
bootstrap only — **a wired game owns its real schema/migrations.**

**Git hooks** — [`.githooks/`](.githooks) holds generic, game-agnostic hooks; enable with
`git config core.hooksPath .githooks` (the `prepare` script does this on install). `pre-commit`
runs guards + typecheck (set `GAMEKIT_PRECOMMIT_FULL=1` for full `validate`); `precommit-guards.cjs`
blocks empty commits, unresolved merge markers, and likely secrets; `commit-msg` enforces
`<type>(<scope>): <summary>`; `pre-push` softly warns on direct pushes to `main`/`master`. All
prior-game-specific gates (visual-proof, zoom-lock, zone-DoD, lane-branch push blocks) were removed.

## Status

- [x] Tools code copied + pruned (large capture/lane debris → real code only)
- [x] Standalone workspace scaffold (`package.json`, `pnpm-workspace.yaml`, tsconfig, `.gitignore`)
- [x] Config-indirection module (`toolkit-config.ts`) — `GAME_ROOT` / `ASSETS_ROOT` / `ASSETS_METADATA_ROOT`
- [x] `game-contract` package populated with types + generic algorithms
- [x] Game-aware tools repointed onto `@gamekit/game-contract`
- [x] `pnpm -r typecheck` green (tools + game-contract)
- [x] AI-dev doc harness copied and genericized (`docs/**`, indexed by `docs/README.md`)
- [x] `game-contract` given a runtime `exports` entry — the 17 contract-importing tools now RUN, not just typecheck
- [x] Functional hardcoded-path sweep: `asset-bank.ts` promotion destinations + `lane-spawn.ts` worktree path routed off the hardcoded absolute repo root; Python `Z:/Assets` + the `.cmd`/`start-devkit.ps1` launchers fixed
- [x] Game-content-coupled tests/selftests guarded to skip-when-absent (auto-reactivate on a wired game)
- [x] `git init` (branch `main`; initial commit intentionally left to the owner)
- [x] **Verified standalone:** `pnpm -r typecheck` green · `pnpm test` 148 passed / 2 skipped · `pnpm selftest` green
- [x] Fully de-branded — no source-game name remains anywhere in the repo; deployment couplings are env seams (`GAME_ONLINE_HOST`, `GAME_SERVER_PACKAGE`/`GAME_CLIENT_PACKAGE`)
- [x] **Runnable reference game** at [examples/starter-game](examples/starter-game) — Colyseus + Phaser 4; `zone:validate`/`lint`/`export` green; `capture:zone` (sweep + plain) boots + screenshots it; cross-client `move.to` replication verified

### Known residuals (intentional — legitimate game-wiring seams or later slices)

- `tools/src/smoke-persistence.ts` spawns the game's server/client workspace filters — a **legitimate
  whole-game E2E seam** (it needs a running game; the workspace names are the game's). The package names
  are env-configurable via `GAME_SERVER_PACKAGE` / `GAME_CLIENT_PACKAGE` (defaults `@game/server` /
  `@game/client`); point them at your game's workspace names.
- Remaining `Z:/Assets` strings in `tools/src/` are **comments, `--help` text, and test
  fixtures** (e.g. `bank-*.ts` help, `promote-key.test.ts`) — no runtime path behavior.
- `.githooks/` (pre-commit/commit-msg/pre-push/precommit-guards.cjs) have been **audited and
  genericized** — all prior-game-specific gates removed, generic guards (empty-commit, merge-marker,
  secret detection, conventional commit-msg) kept. Safe to enable via `core.hooksPath` (see the
  "CI / Database / Git hooks" section above).
- The game-aware wrapper scripts (`capture:zone`, `build:client`, `boot:server`, `smoke:client`,
  `qa`, `dev:client`) and a few doc-referenced orchestration scripts (`integrator:start/park`,
  `lane:security-scan`, `imagegen:extract`) are named in the docs but not in root `package.json` —
  they belong to a wired game or a later slice.

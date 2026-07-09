# tools/

The GameKit toolchain — the executable half of the dev kit. Every script here is wired into the
root `package.json`; see the repo [README](../README.md) for which run standalone vs. need a wired
game, and [docs/README.md](../docs/README.md) for how the pieces fit together.

## What's in here

| Path | What it does |
|---|---|
| `src/asset-bank*.ts`, `src/bank-*.ts` | **Asset Bank** — catalog, review, rate, and promote art/audio into the game's runtime tree. Backed by a local web server. |
| `src/devkit*.ts`, `devkit/` | **DevKit** — the unified local web shell (asset review, audio review, frame picker, zone editor launcher, stack ops). |
| `art-pipeline/` (Python) | **Art pipeline** — spritesheet assembly, background removal, frame extraction, anchor measurement, animation intake/validation. |
| `asset-cleanup/` (Python) | **Asset cleanup/validation** — fringe/despill, tiling, tint recolor, vibrancy, and the defect/animation regression gates. |
| `src/audio-*.ts` | **Audio pipeline** — generation (ElevenLabs + mock providers), review, and client-sync. |
| `src/capture-*.ts` | **Capture/proof** — boot the game headless and screenshot zones/HUD/UI for visual verification. Needs a wired game. |
| `src/zone-*.ts` | **Zone tools** — lint, validate, export, and DoD-check game zone layouts. |
| `src/smoke-*.ts`, `src/smoke/` | **Smoke harness** — end-to-end behavior checks against a running client+server. Needs a wired game. |
| `src/lane-*.ts`, `src/lanes-*.ts`, `src/intake*.ts`, `src/integrator-*.ts` | **AI-dev orchestration** — spawn parallel coding "lanes", watch/merge them, run intake. See the harness docs. |
| `src/sessions-sync.ts`, `src/tasks-sweep.ts`, `src/docs-budget.ts`, `src/coverage-ratchet.ts` | **Project hygiene** — session roster, task sweep, docs budget, coverage ratchet. |
| `src/toolkit-config.ts` | **Config indirection** — resolves `GAME_ROOT` / `ASSETS_ROOT` / `ASSETS_METADATA_ROOT`. Every path-aware tool reads from here. |

## The game boundary

Game-aware tools (`capture-*`, `zone-*`, `smoke-*`, parts of `devkit`) import from
[`@gamekit/game-contract`](../packages/game-contract/) — the interface a game implements — never
from a game's source tree directly. Wire a game by implementing that contract and setting the
`GAME_ROOT`/`ASSETS_ROOT` env vars; the game-aware tools then operate on it.

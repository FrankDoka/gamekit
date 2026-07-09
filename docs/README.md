# GameKit Documentation

**GameKit is a reusable 2D game dev kit.** It gives a new game a mature toolchain on day one — an
asset bank, art + audio pipelines, an in-browser DevKit, zone/capture/smoke tooling — plus an
optional harness for building the game with parallel AI coding sessions. It ships no game: you wire
your game to it by implementing [`@gamekit/game-contract`](../packages/game-contract/).

Start at the repo [README](../README.md) for setup and the "wire a new game" steps — the fastest of
which is `pnpm create:game <name>`, which scaffolds a fresh game from
[examples/starter-game](../examples/starter-game) (copies it, rewires names/title/README, writes
`.env.example`, and seeds `docs/state/*` harness stubs). This folder is the deeper reference, split
into two tracks.

---

## Track 1 — The game toolchain (what the kit *does*)

The tools you use to build and ship game content. Overview and per-category map:
[tools/README.md](../tools/README.md).

**Starting a game?** Read [genres.md](genres.md) first — it maps your genre (pixel tactics, gacha
mobile, action MMO/roguelike) to one of the three forkable [reference games](../examples/) and is
honest about what each fork gives vs. what you build. [systems.md](systems.md) catalogs the reusable
pure systems those forks carry (`@gamekit/game-contract`, `@tactics/turn-grid`, `@gacha/summon`, and
the three server patterns).

| Area | Entry point | Runs standalone? |
|---|---|---|
| **Asset Bank** — catalog / review / rate / promote art + audio | `pnpm devkit` → asset review; `pnpm bank:*` | Yes (operates on your assets) |
| **DevKit** — local web shell (review, frame picker, zone editor, stack ops) | `pnpm devkit` | Yes |
| **Art pipeline** — spritesheets, bg-removal, frames, anchors, animation intake | `tools/art-pipeline/` (Python) | Yes |
| **Asset validation** — fringe/despill/tint/tiling + defect & animation gates | `pnpm assets:*`, `pnpm selftest` | Yes |
| **Audio pipeline** — generate (ElevenLabs/mock), review, sync | `pnpm audio:*` | Yes |
| **Zone tools** — lint / validate / export / DoD a game's zone layouts | `pnpm zone:*` | Needs a wired game |
| **Capture/proof** — headless screenshots of zones/HUD/UI | `pnpm capture:*` | Needs a wired game |
| **Smoke harness** — end-to-end behavior against a live client+server | `pnpm smoke:*` | Needs a wired game |

The game-aware areas depend on the **contract**, not on a game's source. See
[packages/game-contract](../packages/game-contract/) for the interface a game fills in.

## Track 2 — Building with AI (the orchestration harness)

An optional but battle-tested methodology for building the game with parallel AI coding sessions
("lanes"): fan out work, verify against the code, merge cleanly, keep docs from drifting. It is
game-agnostic — adopt it on any project. Read in this order:

1. **[AGENTS.md](AGENTS.md)** — entry point. Boot order, mandatory checks, working modes,
   source-of-truth precedence, git/worktree rules. Every AI session reads this first.
2. **[architecture/ai-architecture.md](architecture/ai-architecture.md)** — the operating model:
   grounded fan-out (explorers → verifier → implementors, citations mandatory), the card
   orchestration model, the model-role charter, token discipline + return contracts, and the
   Integrator Conductor Loop a session runs top to bottom.
3. **[process/task-templates.md](process/task-templates.md)** — paste-ready card + handoff templates.
4. **[process/parallel-sessions.md](process/parallel-sessions.md)** — the worktree checklist: one
   session = one branch = one worktree.
5. **[process/orchestration-mechanics.md](process/orchestration-mechanics.md)** — the task-routed
   "how": watch lanes, verify a READY lane, merge, steer, drive a headless generation engine, and
   the reusable verification recipes.
6. **[process/cold-boot-test.md](process/cold-boot-test.md)** — protocol proving a fresh AI session
   can do real work from a tiny context bundle. Run it when you change the boot docs.

---

## Adopting the AI harness on your game

The harness references a few project docs by role (a cold-start brief, an active-session snapshot, a
resume/handoff cursor, a durable project-memory, and a decisions doc). Create those for your game,
point AGENTS.md and the templates at them, and record your model-role mapping (which real models
play senior-decision / executor / generation / evidence) in your decisions doc. Everything else in
Track 2 is project-agnostic by design. Track 1 needs no adoption beyond wiring the contract and
setting `GAME_ROOT` / `ASSETS_ROOT`.

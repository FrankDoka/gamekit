# Adopting the AI-Dev Harness — Day 1

A concrete "start here" for a team that wants to build their game using GameKit's parallel-AI
orchestration harness (Track 2). Read this **before** the deep docs — it tells you the minimum you
must do, in order, and is honest about what is turnkey versus what you wire yourself.

If you only want the game toolchain (asset bank, pipelines, capture) and NOT the AI methodology,
skip this file — Track 1 in [README.md](README.md) is all you need.

---

## What the harness actually is

A **methodology plus a set of scripts** for building a game with several AI coding sessions running
at once. One session is the **integrator** (drives everything); the others are **lanes** (each owns
one branch + one worktree + one card of work). The integrator hands out cards, watches lanes finish,
verifies each finished lane against the real code, and merges. The full model is in
[architecture/ai-architecture.md](architecture/ai-architecture.md); this page just gets you running.

It is **battle-tested but opinionated**, and it was extracted from a single origin project. Parts are
turnkey (the `lane:*` / `intake*` / `sessions:*` scripts run today); parts are conventions you adapt
(which real models play which role; where your state docs live). This guide separates the two.

---

## Prerequisites (once)

```sh
corepack enable          # if pnpm is not on PATH
pnpm install
pnpm -r typecheck        # expect exit 0
pnpm validate            # typecheck + toolkit selftests (no game required); expect exit 0
git config core.hooksPath .githooks   # the `prepare` script already does this on install
```

You need an AI coding tool that can (a) run multiple sessions and (b) let one session spawn/drive
others headlessly. The harness scripts are agent-agnostic — they manage git worktrees, a lane
registry, and intake gates; your agent tool provides the sessions.

---

## Step 1 — Scaffold or wire your game

Fastest path (real-time genre):

```sh
pnpm create:game my-game        # --dir <path> to place elsewhere; --dry-run to preview
```

`create:game` copies [examples/starter-game](../examples/starter-game), rewires names/title/README,
writes `.env.example`, and **seeds the five harness state docs under `docs/state/`** (see Step 2).
For turn-based or gacha, copy `examples/tactics-game/` or `examples/gacha-game/` and create the
state docs by hand (Step 2). Either way, set `GAME_ROOT` (and `ASSETS_ROOT` if you use the asset
bank) per the game's `.env.example`.

---

## Step 2 — The five state docs (the harness's memory)

The harness has no database — its memory is a handful of markdown files. **`create:game` seeds these
as stubs; if you wired by hand, create them yourself.** Roles (names are convention — keep them or
rename and point AGENTS.md at the new paths):

| Role | Default path | What it holds |
|---|---|---|
| Cold-start brief | `docs/state/session-brief.md` | Current phase, what works, the single next step |
| Active-sessions snapshot | `docs/state/active-sessions.md` | Live lanes/worktrees (synced by `sessions:sync`) |
| Resume cursor / handoff | `docs/state/handoff.md` | Exact in-flight detail for the next session |
| Durable project-memory | `docs/state/project-memory.md` | Hard-won facts a cold session would otherwise repeat |
| Decisions | `docs/state/decisions.md` | Ratified decisions, newest on top — **incl. your model-role map** |

These are the docs [AGENTS.md](AGENTS.md) §Boot Order routes a fresh session through. Keep them thin
and current: a stale brief is a bug (see the cold-boot test, Step 5).

> **Optional sixth doc — a context-routing map.** The boot order mentions "the context-routing map"
> for larger projects: a short index of *which system/architecture doc to read for which task*. It is
> **not scaffolded and not required** — small games route fine from the brief alone. Create
> `docs/state/context-map.md` (or fold a "routing" section into the brief) only once you have enough
> system docs that a cold session can't guess which to open, then point AGENTS.md §Boot Order at it.

---

## Step 3 — Wire the model-role charter to real models

The charter in [ai-architecture.md](architecture/ai-architecture.md#model-role-charter) is written by
**role**, not brand. Before running lanes, decide which real model plays each role and **record it in
your `decisions.md`** — this is the one piece of the charter you cannot skip:

| Role | Does | Pick a model that is… |
|---|---|---|
| Senior decision | Intent, architecture, card decomposition, review, canonical docs | Your strongest reasoning model (the integrator usually runs here) |
| Primary executor | The default code-lane worker | A strong general coding model |
| Generation engine | Image/animation/asset generation lanes | Your art/animation generation tool (headless) |
| Cheap evidence | Discovery, summaries, checklist verification | A small fast model |

Also record your **engine split** (what share of *code* lanes, if any, the generation engine takes
vs. the executor) — the charter references "the current engine split recorded in your decisions doc"
and there is no default. If you have only one code model, the split is trivially "executor does all
code"; write that line anyway so a cold session isn't left guessing.

---

## Step 4 — Run the loop (a first real wave)

The integrator session runs [The Integrator Conductor Loop](architecture/ai-architecture.md#the-integrator-conductor-loop-run-sessions-exactly-this-way).
A first pass, mapped to the real scripts:

1. **Write 1–3 cards** from the template in [process/task-templates.md](process/task-templates.md),
   file-disjoint so lanes don't collide. Summarize them in `handoff.md` so they survive a `/clear`.
2. **Spawn a lane** per card. Executor/generation lanes go headless via
   `pnpm lane:spawn <card> --engine <engine>` (`--engine agent` composes an agent-tool prompt;
   `--dry-run` previews). This creates the worktree + branch and registers the lane. Run it from the
   **primary worktree only** (it writes the registry). Interactive sessions instead follow the
   [worktree checklist](process/parallel-sessions.md).
3. **Watch mechanically:** `pnpm lanes:watch --events ready --timeout-mins 30` as a background task.
   It prints one `EVENT` line and exits; re-arm after every event and merge. Mechanics:
   [orchestration-mechanics.md §Watch](process/orchestration-mechanics.md#watch--mechanical-lane-watching).
4. **Verify a READY lane — never trust its numbers.** Start with `pnpm intake:brief <lane>` for the
   binding routing verdict, then run the risk-scaled ritual
   ([§Ritual](process/orchestration-mechanics.md#ritual--ready-verification-never-trust-lane-numbers)).
   `pnpm intake <lane>` one-shots commit-from-staged + gates + proof legs.
5. **Merge same-turn, one step per command** (`git merge --ff-only` → push → `pnpm lane:close <wt>`
   from the primary tree → flip the card → sync docs → re-arm). Detail:
   [§Merge](process/orchestration-mechanics.md#merge--merge-ritual-same-turn-no-gaps--crash-recovery).
6. **Keep the roster current:** `pnpm sessions:sync` (integrator-only, primary worktree) rebuilds
   `active-sessions.md` from `git worktree list` + each lane's `.session-card`.

Start with **one lane** your first time; add parallelism once the loop feels mechanical.

---

## Step 5 — Prove it cold-boots

Once your state docs exist and describe a real next step, run the
[cold-boot test](process/cold-boot-test.md) from a **fresh** session (not the one that wrote the
docs). If a cold session can author the probe task from the boot bundle alone and `pnpm validate`
exits 0, your on-ramp works. If it stumbles, fix the canonical doc it needed — don't loosen the
rubric. Re-run this whenever you change the boot docs.

---

## Turnkey vs. adapt — an honest inventory

| Piece | Status on a fresh GameKit clone |
|---|---|
| `lane:spawn` / `lanes:watch` / `lanes:board` / `lane:close` / `lane:recover` | **Turnkey** — real `pnpm` scripts |
| `intake` / `intake:brief` / `sessions:sync` / `docs:budget` / `coverage:check` | **Turnkey** — real `pnpm` scripts |
| `integrator:start` / `integrator:park` / `lane:security-scan` / `imagegen:extract` | **Tool exists** under `tools/src/`, but **not yet wired as a `pnpm` script** — run via `node node_modules/tsx/dist/cli.mjs tools/src/<name>.ts`, or add the script to `package.json` |
| `capture:zone` (visual proof) | **Reader exists** (`tools/src/capture-zone.ts`) but is **not a `pnpm` script**; it needs a wired game + `GAME_ROOT`. The toolkit wires only `capture:tactics` / `capture:gacha`. See [AGENTS.md §Seeing The Game](AGENTS.md#seeing-the-game-visual-verification--do-not-re-derive-this). |
| Model-role charter | **Adapt** — map roles to your models in `decisions.md` (Step 3) |
| State docs | **Seeded by `create:game`**, else **create by hand** (Step 2) |
| Context-routing map | **Not provided** — create only if your project needs it (Step 2) |
| Git hooks (validate, commit-msg, secret/marker guards) | **Turnkey** — `.githooks/`, enabled on install |
| CI standalone gates | **Turnkey** — `.github/workflows/ci.yml`; game-aware gates you add in your game repo |

The **methodology** (grounded fan-out, the card model, the ritual, token discipline) is fully
project-agnostic and transfers as-is. The **script surface** is real but has the wiring gaps noted
above; the **role charter and state docs** are the deliberate adaptation points. Nothing here is
secretly origin-specific — where a doc still shows an example path or model, it says so.

---

## Where to go next

- Deep operating model: [architecture/ai-architecture.md](architecture/ai-architecture.md)
- Card + handoff templates: [process/task-templates.md](process/task-templates.md)
- Worktree checklist: [process/parallel-sessions.md](process/parallel-sessions.md)
- Task-routed mechanics (watch/verify/merge/steer/recipes): [process/orchestration-mechanics.md](process/orchestration-mechanics.md)
- Cold-boot test: [process/cold-boot-test.md](process/cold-boot-test.md)

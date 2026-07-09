# AGENTS.md

Shared instructions for AI collaborators working on a game built with this toolkit.
Replace `<GAME>` / `<repo root>` with your project's name and path when you adopt this file.

## Project Root

The canonical project root is `<repo root>` (the wired game repo, or this toolkit repo until a
game is wired). Do not treat any tool-specific default folder as the project root. Tools resolve
filesystem roots through `tools/src/toolkit-config.ts` (env vars `GAME_ROOT`, `ASSETS_ROOT`,
`ASSETS_METADATA_ROOT`) — never hardcode absolute paths.

## Boot Order

A game that adopts this harness keeps a small set of state docs (names are conventions, not
hard-wired — point these at wherever your project keeps them):

1. Read this file.
2. Read the current cold-start state doc (e.g. `docs/state/session-brief.md`).
3. Read the active-session snapshot (e.g. `docs/state/active-sessions.md`), then run
   `git worktree list` before any edit.
4. Read the context-routing map only far enough to route the current task.
5. Read the resume-cursor doc (e.g. `docs/state/handoff.md`) only when resuming detailed prior
   work or when the brief points there.
6. Read the durable project-memory doc only when durable history/current-state detail is needed
   beyond the brief.

Load at most one routed system, architecture, pipeline, proposal, or archive doc unless the task
explicitly needs more. Do not open archive-sized docs by default.

Cold-start context budget: keep the boot pass compact. Prefer targeted reads (`rg`, headings, or
small sections) over printing whole large files. Durable-history, resume-cursor, parallel-session,
proposal, and archive docs are intentionally not default full reads.

## Mandatory Checks

- **Before editing ANY file, run `git worktree list` and check the active-session snapshot.**
  Do this every time. If another session/worktree is active, use a clean reusable integrator
  worktree or create a worktree + branch. Never edit the shared primary tree alongside an active
  side worktree. Load the full protocol only when creating, merging, tearing down, or debugging a
  worktree.
- **Never kill a process you did not spawn.** Tear down only pids you spawned; never sweep by
  name/port — that evicts other lanes' tooling. A needed port held by a foreign process = fail
  loudly and pick another, never evict the owner.
- **Edit-target hard stop:** immediately before the first file edit, confirm `pwd`,
  `git branch --show-current`, `git status --short`, and `git rev-parse --show-toplevel` match the
  intended worktree. If an edit tool cannot bind there, do not use it.
- **If the game uses a rendering engine with a documented skill/convention** (e.g. a Phaser
  gamedev skill for a Phaser client), read it before any client/gameplay/rendering/runtime work,
  and follow its spritesheet-inspection protocol before loading or changing any spritesheet
  (measure frame size, spacing, margins, and source dimensions first). Mention that check in the
  closeout, along with the validation or visual QA that was run.
- **Verify any visual change before claiming done (see "Seeing The Game"); inspect EVERY frame of
  an animated result, never frame 0 + a metric; no verdict words on a visual — the owner judges.**
- **Quantify before diagnosing; cite before claiming.** Any claim about code you did not just read
  carries a `file:line` citation. Any visual/asset defect diagnosis gets a pixel-level measurement
  first (PIL, the fringe/despill tools), never a guess. In audits, uncited claims are discarded.
  Tasks spanning more than ~3 subsystems use the grounded fan-out protocol in
  `docs/architecture/ai-architecture.md`.

## Engine Roles & Lane Communication

The integrator spawns and drives ALL lanes headlessly — no owner relay. Read the charter, workload
split, return contracts, and high-risk rules in `docs/architecture/ai-architecture.md` first.
Non-negotiables: **blocked lanes state the question in their final message and STOP** (the
integrator resumes with the answer; interactive sessions re-check their worktree steer file at
every turn start); **replies use the named return contract or the card's boxes**; test output is
failures only.

## Working Modes

Use one of four modes by default:

| Mode | Use for | Typical output |
| --- | --- | --- |
| Plan | scope, roadmap, architecture, decisions | docs, decisions, task cards |
| Build | client/server/shared/tool code and tests | code, validation passing |
| Content | manifests, writing, assets | content files, validation passing |
| Review | read-only audit and closure checks | findings, risks, handoff |

For large or multi-subsystem tasks, use the grounded fan-out protocol (explorers → verifier →
implementors, citations mandatory) in `docs/architecture/ai-architecture.md`.

## Gates

A task is done only when:

1. Validation passes, or the missing validation is specifically blocked and explained.
2. Handoff state is updated when current state or next task changes. Update durable project-memory
   only for durable current-state facts, not every verification log.

`pnpm validate` is the normal validation gate (see "Running The Toolkit"). Game-aware gates
(`build:client`, `boot:server`, `capture:zone`) require a wired game and its scripts.

## Source Of Truth

For implemented behavior, current reality is:

`code > manifests > durable project-memory > system docs > archive docs`

For intended change, target reality is:

`direct owner instruction or a ratified decisions doc > existing code until code catches up`

If code and docs disagree about current behavior, fix the docs. If an owner-locked decision says
behavior should change, update code/manifests to match in the scoped task.

## Canonical Homes

Each fact lives in exactly one place. A game that adopts this harness picks concrete paths; the
roles are:

- Boot order and shared rules: `AGENTS.md`
- Cold-start state / active-session snapshot / durable history / resume cursor: the state docs
- Durable decisions: a decisions doc
- Task and handoff templates: `docs/process/task-templates.md`
- Cold-boot test protocol: `docs/process/cold-boot-test.md`
- Content ID policy, manifest schemas, message contracts: the game's shared package (which the
  toolkit sees only through `@gamekit/game-contract`)

## Repo Tree

A wired game is typically a monorepo: `client/ server/ shared/ content/ tools/ docs/ …`. This
toolkit itself ships `tools/ packages/game-contract/ docs/`. See root `README.md` for the shape.

## Running The Toolkit

pnpm is via corepack (pinned). If `pnpm` is missing from a shell's PATH, run `corepack enable`
first.

Standalone (no wired game — run from this toolkit repo):

```text
corepack enable            # only if pnpm not found
pnpm install
pnpm -r typecheck          # typechecks tools + game-contract
pnpm validate              # typecheck + toolkit selftests (fixture-based, no game required)
```

Game-aware (require a wired game exposing `@gamekit/game-contract` and its own scripts):

```text
pnpm build:client          # the game's client build (game script)
BOOT_CHECK=1 pnpm boot:server   # the game's server boot-check (game script)
pnpm devkit                # DevKit + zone editor
pnpm capture:zone <outDir> # headless zone capture (see "Seeing The Game")
```

## Seeing The Game (visual verification — do not re-derive this)

**You are NOT blind. Don't hunt for a way to see the game or ask the owner for screenshots — use
the built-in tool** (available once a game is wired):

```text
pnpm capture:zone <outDir>     # e.g. pnpm capture:zone tools/_capture
```

It boots the game's server + client, logs in as guest, joins the spawn zone, pans the camera to
several framings and writes a PNG each into `<outDir>`. Open them and look before declaring ANY
visual change (zone/tile/prop/decal/rendering/camera) done; then iterate. Reframe via the `SHOTS`
array in `tools/src/capture-zone.ts`. Shimmer is a *motion* artifact (compare frames, not one
still).

## Asset Bank Rules

Full protocol lives in the game's asset-bank workflow doc + the `asset-review` skill — read BOTH
before any review/accept/categorize/generation work. The non-negotiables:

- **Visually inspect every image (Read tool) before any decision**; review notes describe what you
  saw. No bulk-accepts; file each decision immediately (accepted → the category tree under
  `ASSETS_ROOT`, rejected → `_rejected/`, then rescan).
- **Defect gate:** fringe / chroma-bg / opaque cut-outs are blocked from acceptance
  (`pnpm assets:check` inside `pnpm validate`). Cleanup uses the fringe/despill tools; never naive
  chroma-key.
- **Single-writer:** ONE session writes the review-metadata store (`ASSETS_METADATA_ROOT`) at a
  time (concurrent writers can wipe it).
- **Generation:** work against locked art direction and a concrete need only; clean + per-asset QA
  every output.

## Change Discipline

- Make the smallest correct change in scope.
- Preserve user and other-agent changes. Do not revert unrelated work.
- Keep docs, code, content, and handoff state aligned. After code or content changes, skim the hot
  state docs and any system/task docs you relied on; update only stale current-state or next-task
  facts. Do not open or churn archive docs unless the task depended on them.
- **HARD RULE:** whenever a session discovers something that works, modifies a technique, or a
  decision changes intent, it MUST update the canonical doc where a cold session would look for it
  in the same task. A discovery or change without its doc update is an unfinished task — stale
  guidance is a bug, not noise.
- If the owner explicitly asks for an out-of-scope enhancement to be remembered, do not implement
  it — add one terse line to a backlog doc with `[area · size]` tags for review at a milestone. Do
  not auto-capture every passing brainstorm.
- Do not read or print secrets, `.env*`, local databases, credentials, or private config unless
  explicitly told and necessary.

## Git

Git is initialized for durable history. **A session may commit its own branch/worktree work
without per-commit owner authorization** when relevant gates pass (`pnpm -r typecheck`,
`pnpm validate`, plus `build`/`smoke` when applicable). Devlogs are for milestones and substantive
features only — routine fixes rely on the commit message. Never commit secrets, `.env*`, local
DBs, or large binaries. A session may merge its rebased branch into `master` after green gates.
**After every green merge to `master`, push to `origin` immediately**; no network → note it in the
handoff. No force-push, history rewrite, or hard-reset on shared branches. The owner signs off
architecture-class decisions.

For any commit, use:

```text
<mode>(<area>): <summary>

Task: <task-id>
Co-Authored-By: <AI/tool name>
```

Before ending a session that produced useful code, tooling, content, or accepted assets, the
session must either merge its branch into `master` after the normal gates pass, or leave an
explicit handoff naming the branch, commits, paths, validation status, and exact restore/merge
steps. Do not rely on a side branch, `tmp/` output, local downloads, or verbal context as the only
copy of work the owner wants to keep.

### Parallel sessions (worktrees)

**One session = one branch = one git worktree** by default. Before edits, run `git worktree list`
and check the active-session snapshot. If any side worktree is active, use a clean reusable
integrator worktree or create a temporary worktree + branch and respect ownership boundaries.
Never edit the shared primary tree beside another active session. Main-tree work is acceptable
only when `git worktree list` confirms you are the sole session, and only for small changes.
See [parallel-sessions.md](process/parallel-sessions.md).

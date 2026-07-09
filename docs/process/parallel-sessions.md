# Parallel Sessions — Worktree Checklist

One session = one branch = one git worktree. Sessions never share a working tree.

> The `lane:*`, `intake*`, and `sessions:*` commands below are real `pnpm` scripts. The
> `integrator:start` / `integrator:park` reusable-worktree helpers referenced here have a tool under
> `tools/src/` but **no `pnpm` binding yet** — run them via `tsx tools/src/integrator-start.ts` /
> `integrator-park.ts` (or add the scripts to `package.json`). See the inventory in
> [adopting-the-harness.md](../adopting-the-harness.md).

**Lane-saturation doctrine:** keep **3–4+ lanes running in parallel** at all times — never idle
waiting on 1–2 sessions while file-disjoint work sits queued. The orchestrator proactively hands
the owner paste-ready cards whenever live lanes drop below ~4 (docs-only research cards are always
safe fills); only true file conflicts and owner-gated items are sequenced. The owner can spawn many
concurrent sessions.

## Start a session

1. Check what's active: read the active-session snapshot + run `git worktree list`.
2. Create a worktree and branch (from the primary tree):
   ```bash
   git worktree add ../<game>-<name> -b <branch>
   cd ../<game>-<name> && pnpm install
   ```
   Or reuse the integrator worktree: `pnpm integrator:start <task-branch>`.
3. Drop a `.session-card` file in the worktree root (git-ignored; read by `pnpm sessions:sync` to
   fill the generated roster's Role/Notes columns):
   ```text
   session: <CARD-ID>
   role: build | plan | content | review
   notes: <one line: scope + files touched, so other lanes can avoid them>
   ```
4. Before any edit, verify you're in the right tree:
   ```bash
   pwd && git branch --show-current && git rev-parse --show-toplevel
   ```

## While working

- Commit green checkpoints often. Include devlogs with substantive code commits.
- Rebase onto `master` at batch boundaries, not just before merge.
- Never edit files in another worktree. If an edit lands in the wrong tree, move it immediately.

## Finish

1. Rebase onto latest `master`, run full gate (`pnpm validate`, `pnpm test`, build/boot as
   relevant).
2. Merge to `master` (self-service once green). Do NOT edit the state docs — the integrator syncs
   the roster/brief/handoff on master (`pnpm sessions:sync` is integrator-only and refuses to run
   outside the primary worktree). **Merges serialize:** if another lane is mid-merge in the shared
   tree, wait — never stage, resolve conflicts, or commit in the shared tree while someone else's
   merge is in flight.
3. Clean up — **declaring a lane DONE and tearing it down are ONE action.** The integrator runs
   `pnpm lane:close <worktree-path> [branch]` in the same turn as the closure verdict — removes the
   worktree, deletes the merged branch, prunes, deletes the folder, sweeps all husk folders,
   re-syncs the roster. A folder held by a Windows process is reported LOCKED; the owner closes
   that terminal/server, then `pnpm lane:close --sweep` finishes. A "done" declared without
   lane:close is an unfinished closure. (A reusable integrator worktree uses `pnpm integrator:park`
   instead of close.)

## Escalation

If two sessions need the server/persistence simultaneously, use a per-session DB via separate
`DATABASE_URL`.

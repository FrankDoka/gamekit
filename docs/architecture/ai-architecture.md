# AI Architecture And Operating Model

Integrator/orchestration BOOT CORE: the multi-agent protocol + the rituals' prose. The operating
model lives in [AGENTS.md](../AGENTS.md) + your project's decisions doc; the mechanics (watcher
commands, ritual detail, headless-engine mechanics, verification recipes, toolkit) live in
[orchestration-mechanics.md](../process/orchestration-mechanics.md) — load that doc when doing the
act, not at boot.

Modes: see AGENTS.md §Working Modes. Ordinary tasks are one session in one mode; escalate to the
protocol below only when a task spans >~3 subsystems or needs verification you can't do inline.
Source of truth / precedence: AGENTS.md §Source Of Truth.

> **Model roles are described by ROLE, not brand.** This harness assigns four roles — a senior
> decision model, a primary executor, a generation engine, and a cheap evidence model. Map them to
> whatever models your team uses, and record that mapping (and any re-tuning) in your decisions
> doc. The example mapping in the Charter below is illustrative.
>
> **First-time adopters:** wire the roles and the state docs before running any lane — the concrete
> steps and an honest turnkey-vs-adapt inventory of the scripts referenced below (some are real
> `pnpm` scripts; a few — `integrator:start/park`, `lane:security-scan`, `imagegen:extract`,
> `capture:zone` — have a tool under `tools/src/` but no `pnpm` binding yet) are in
> [adopting-the-harness.md](../adopting-the-harness.md).

## Grounded Fan-Out Protocol (anti-hallucination by construction)

Three contracts, in order. Agent-capable sessions spawn them as subagents
(`ground-explorer` / `plan-verifier` / `implementor`); a single-context session runs the same
contracts as sequential phases — the contracts, not the tooling, are the protocol.

1. **Ground explorers** (read-only, parallel). Each takes a disjoint slice and returns findings
   where **every claim carries a `file:line` citation or a command output**. An uncited claim is
   discarded — not softened, discarded. Explorers never propose designs and never edit.
2. **Plan verifier / planner** (read-only). Builds or checks the plan using ONLY explorer-cited
   facts; anything assumed gets re-verified against the code before use; anything unverifiable is an
   explicit risk. Output: steps with citations + a risk list.
3. **Implementors.** Execute plan steps bound to the standard gates (`pnpm validate` green,
   capture-and-look for anything visual, hooks respected) and the closeout contract: what changed,
   how verified, what was NOT verified and why.

Checklist form (any model, single context): split into slices and read the actual code — no memory,
no summary docs; write findings as `claim — file:line` and delete what you cannot cite; plan only
from cited findings; implement smallest-correct with gates green per batch; closeout states verified
vs not-verified.

## Card Orchestration Model

Work ships as **cards on parallel lanes** with one integrator:

- **Cards** are self-contained and paste-ready: setup (own worktree+branch), scope + file
  boundaries naming LIVE lanes to avoid, verify steps incl. capture/smoke, closeout contract, merge
  policy. Card summaries live in the handoff so they survive `/clear`. Resume-anchor cards on master
  let a dead lane resume from disk.
- **Steers are addressed** (`TO <LANE-ID>:`); every closeout states its lane ID; a session receiving
  another lane's instruction refuses and flags it. When a lane's self-understanding is in doubt,
  paste an authoritative lane-state card ("supersedes anything contradictory") and require a
  RESTATED echo; a muddled echo = close the session and resume fresh from disk (everything durable
  lives on disk; sessions are replaceable).
- **Lane saturation:** keep 3-4+ lanes running; below ~4 with unblocked cards waiting, the
  integrator proactively spawns disjoint work.
- **Integrator review contract:** every merged lane is reviewed from the diff (never the report
  alone) — scope vs card, independent gate re-runs, in-engine capture inspection for anything
  visual, a live spot-check of ≥1 behavioral claim. **Every steer ships its canonical-doc update the
  SAME turn** — a paste teaches one session, the doc teaches all future ones.
- **Integrator-only hot-state writes:** lane sessions NEVER edit the shared state docs; the
  integrator syncs roster/brief/handoff on master.
- **Owner gates:** design forks go to the owner as clickable veto prompts with a recommendation
  first; every answer is recorded in the decisions doc same turn. Design docs are RATIFIED only when
  stamped with answers.
- **Sessions cross boundaries:** lanes keep running through an integrator `/clear`; the successor
  inherits via the handoff. Integrators end with: hygiene sweep → validation → cold-boot probe →
  `/clear` handoff.
- **Techniques outlive the integrator:** any verification technique gets written into the mechanics
  doc §Recipes at copy-paste level, same turn — future orchestrators may be smaller models.

## Model Role Charter

Roles below; brand-map them in your decisions doc. Example mapping used by the project this harness
was extracted from: senior = a frontier reasoning model; executor = a strong general coding model;
generation engine = an image/animation generation tool; evidence = a small fast model.

**Senior decision model** — judgment, not labor. **Owns:** real owner intent + scope; architecture
and approach; decomposing ambiguous work into dependency-aware cards; tradeoffs; hidden risk;
resolving inter-agent disagreement; reviewing outputs that matter; the final answer to the owner —
plus ALL canonical-doc authorship. Does labor only when delegating costs more than the task.

**Generation engine** — ALL image/animation/asset generation lanes, plus any share of code lanes
per the current engine split recorded in your decisions doc. Headless, integrator-driven
(`pnpm lane:spawn <card> --engine <engine>`; mechanics doc §Codex). A blocked generation lane never
waits for a human: it states the blocking question and stops; the integrator resumes with the
answer. Use owner subscription/entitlement billing, not per-call API keys, where that applies.

**Primary executor** — the default Claude/agent executor for code lanes; a fallback model only when
the primary is unavailable. **Subagents never run the senior model** — every Agent call passes an
explicit lesser `model`, and steers/resumes to executor lanes go via FRESH executor spawns
(SendMessage inherits the parent session's model).

**Cheap evidence model** — discovery, summaries, checklist verification: facts, never direction.

Boundary test: mostly searching/reading/editing/testing → an executor engine; intent, design,
tradeoffs, risk, disagreement, final approval → the senior model. **High-risk areas** (auth,
billing, permissions, security, migrations, data loss, shared state, concurrency, public APIs): the
senior model makes the call, the executor handles/reviews the hard parts, cheaper agents verify with
evidence; NO engine improvises — ambiguity stops and surfaces. **Escalation ladder:** cheap-model
garbage once → retry tighter; twice → up a tier. An executor failing a scoped task twice → STOP,
escalate with both failure reports attached (never a third retry). Executor-vs-verifier disagreement
→ senior decides. Escalation always carries failure evidence. A generation lane failing a card twice
→ reassign off-engine with the evidence.

## Token Discipline & Return Contracts

Every delegated task states its output contract up front; the worker returns the contract and
NOTHING else — a wall of raw output is a failed task. **Scout (cheap evidence):** ≤15 lines,
`file:line` + one-sentence facts, never paste contents. **Build report (executor/generation code
lane):** ≤20 lines — files + line ranges, what ran, pass/fail, ambiguities punted; diffs only ≤30
lines; cards additionally require the box-by-box closeout (the card IS the contract). **Deep
(senior/executor deep dive):** ≤40 lines, conclusion first. **Asset (generation art lane):** ≤20
lines — files + bank paths, per-asset QA results, cost vs cap, capture paths; never inline pixels.
**Test runs:** failures only.

**Delegation prompt = exactly four parts:** 1. Goal (one sentence). 2. Scope (in-bounds AND
out-of-bounds). 3. Contract (which format above). 4. Done-means (the observable check). **Context
hygiene (all engines, workers included):** grep before read, read ranges not files, never re-read
unchanged files, noisy ops in isolated sub-contexts, cite `file:line` never paste logs; a report
violating its contract is a FAILED deliverable. **Parallel/serial:** fan out read-only work;
serialize anything destructive — one at a time, verified; never two writers on overlapping files.
**Senior spend:** read reports not transcripts; >~3 tool calls of searching = delegation smell; one
clarifying owner question beats guessing wrong.

**Integrator economics:** (a) watch with `lanes:watch --events ready` so mid-flight commits never
wake you; (b) ROTATE the session at wave end via the handoff KICKOFF block; (c) batch
verdict+steer+doc-update per turn; (d) `risk: mechanical` → mini models; (e) rotate headless
generation threads at context-pressure via fresh-exec continuation; (f) lanes return ≤40-line
executive summaries, full reports as files; (g) `pnpm intake <branch>` replaces hand-orchestrated
intake; (h) every high-cost merge gets a cheap second-verifier on the diff; (i) rationale written
ONCE, linked elsewhere; (k) Documentation duty travels with the change — whoever changes behavior
updates the canonical doc in the SAME deliverable; the integrator verifies it landed at intake.
(l) **Intake reading contract:** every intake starts with `pnpm intake:brief <lane>` and OBEYS its
routing — large diffs go VERIFIER-FIRST (a lesser-model verifier reads the full diff; the integrator
reads the brief + verdict + ≤3 named spot-checks, never the full diff inline); gate re-runs are
always output-filtered; captures are viewed as crops except for zone-level verdicts; a lane report
over its length contract is bounced, not read. The cold-session test is the bar: after any merge, a
cold boot reading the canonical chain must already see the new truth. Efficiency changes where tokens
sit, never which rituals run.

**Final gate before answering the owner:** real request handled; senior reasoning spent only where
it mattered; delegated work returned with evidence; non-trivial work verified; remaining risk stated.
Response = what was done/decided, verification result, remaining risk. Nothing else.

## The Integrator Conductor Loop (run sessions exactly this way)

A senior/integrator session IS this loop; deviation is a bug. Division of labor: the integrator
personally does integration, architecture, complex judgment, UX, canonical docs — and spawns/drives
all lanes ITSELF (the owner is not a relay), per the engine split in your decisions doc.

1. **Evidence before carding.** Quantify first: art defects get pixel measurements, code claims get
   `file:line` from real source, owner repros become numbered acceptance checks verbatim. Cards
   state VERIFIED vs SUSPECTED, with "line numbers drift; re-grep".
2. **Card contract.** Status → Read-first (incl. any rendering-engine skill when client-touching) →
   cited ground truth → `risk: mechanical|standard|high` → numbered scope → gates as checkboxes with
   named proof per box → an explicit `**Proof leg:**` line naming the runnable proof command (intake
   fails closed without one) → merge-policy line. Constraint-vs-cardinality check: before stamping
   "no schema changes" on a content card, verify the schema can EXPRESS the card's shape; if not,
   authorize the minimal additive field.
3. **Watch mechanically.** `pnpm lanes:watch --events ready --timeout-mins 30` as a background task;
   re-arm after every event and merge; timeout = the stall-sweep heartbeat. Full mechanics + spawn
   commands: mechanics doc §Watch.
4. **READY verification ritual — NEVER trust lane numbers.** Risk-scaled; full order (closeout
   box-by-box → full diff → own gate re-runs → eyes-on → regression-test new gates → verdict) + the
   capture-proof and fallback-expiry rules: mechanics doc §Ritual. Union conflicts: §Unions.
5. **Merge ritual (same turn, no gaps).** One step per command; tip re-parse before merge;
   porcelain-check before any lane:close; owner-live dev-server rule after client merges; then KEEP
   DRAINING — never end a turn with unprocessed READY lanes. Detail + crash recovery: mechanics doc
   §Merge.
6. **Steers.** Fix at the source; sibling audit; blast radius + re-verification list; closeout
   records the superseded hypothesis; the steer's durable lesson lands in its canonical doc the same
   turn. Channels + headless-engine mechanics: mechanics doc §Steers/§Codex.
7. **Mechanize recurring failures.** SECOND occurrence of any failure class → executable gate the
   same task, failing closed with a loud escape hatch, regression-tested against the failure that
   motivated it.
8. **Owner interface.** PENDING-OWNER ledger explicit and minimal; questions as clickable options
   with a recommendation first; paid runs state REAL cost with a hard cap before asking.
9. **Docs current, always.** Every merge/decision/steer updates handoff/cards/decisions/roadmap same
   turn. THE TEST IS THE COLD SESSION: a cold boot that would do the OLD thing means the docs are the
   bug. Cold-start chain audit is part of every wave close. Push after every green commit.

## Handoff Model

Every meaningful session leaves a durable handoff per
[task-templates.md](../process/task-templates.md#canonical-session-handoff-template). Update the
cold-start brief and resume-cursor doc when state or next task changes; durable project-memory only
for durable facts. If two authority areas conflict, record the tradeoff in the decisions doc — a
cold session must not settle a major conflict by editing whichever file it opened first.

## Enforcement Layers (who keeps sessions honest)

| Layer | Applies to | Home |
| --- | --- | --- |
| Git hooks: validate gate, commit-msg format, visual-proof gate, zoom/scale lock | any model | `.githooks/` |
| Agent hooks: registry-writer block, rendering-skill gate, advisories | agent sessions | `.claude/hooks/` (game-side) |
| CI (`pnpm validate`): typecheck, manifests, IDs/refs, docs links, docs budget, asset defect gate, control-char scan (fail closed) | any model | `tools/src/validate.ts` |
| This protocol + AGENTS.md citation rule | any model | docs |

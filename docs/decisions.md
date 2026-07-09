# Decisions — owner-ratified rulings

Durable owner decisions that bind the [roadmap](roadmap.md) and future work. Per the harness rule
([architecture/ai-architecture.md](architecture/ai-architecture.md) §Card Orchestration Model),
owner answers are recorded here the same turn they're given; a plan is RATIFIED only when stamped.
Format: one ruling per line — date · ruling · one-line rationale. Newest section first.

## 2026-07-09 — roadmap v1 ratification (20 rulings, 5 question rounds)

**Strategy**
- **License: Apache-2.0.** Patent grant + contribution terms suit a kit expecting third-party
  plugins/contributors (roadmap Phase 1 gate). Add `license` fields to every `package.json` when
  the LICENSE lands.
- **Audience: dual-track, owner's game leads.** The owner's game sets phase priority; every
  deliverable ships public-ready as a byproduct. The public-product fork decision point is Phase 6.
- **First move: none this session** — roadmap + decisions docs only; implementation starts on a
  later explicit go.
- **Phase 10 showcase genre: real-time action.** Exercises the most of the kit; as the
  `create:game` template, its AI-lane build ledger doubles as the canonical tutorial.

**Architecture**
- **GameDriver placement: interface (types-only) in `@gamekit/game-contract`; implementations in
  `tools/src`** beside capture/smoke where Playwright already lives — keeps `packages/*` pure.
- **`@gamekit/server-guard` shape: pure core package + framework adapters beside the reference
  servers** (turn-grid pattern; invariant 5).
- **Persistence backends: Postgres + in-memory only** in Phase 3 (pg adapter beside the servers).
  SQLite deliberately deferred — one real backend to harden.
- **Phase 4 stays one double-budget phase, run as parallel per-package lanes** (disjoint
  workspace members); split 4a/4b only if forced to work sequentially.

**AI harness**
- **Harness v2 distribution: `@gamekit/harness` inside this monorepo**, versioned in lock-step
  with the docs it seeds; published with the rest at Phase 6.
- **Live-model cold-boot probe: owner-triggered with a stated cost cap.** The mechanical digest
  `--check` runs free in CI; the paid probe never runs automatically.
- **Structured report contracts: warn one wave, then fail-closed.** Calibrate schemas against
  real lane output before mechanical bouncing.
- **Agent-SDK bridge: minimal reference adapter** enforcing the two charter guards (no
  senior-model subagents; fresh-spawn steers). Full integration waits for demand.

**Platform & scale**
- **Mobile packaging: PWA-only.** Installable PWA recipe, no app-store/native toolchain in the
  kit; Capacitor is a documented fork seam.
- **Phase 9 load gate: 500 bots across ≥2 nodes, ≥99% join success, no cross-node divergence.**
- **Observability: Prometheus-shape `/metrics` + structured logs.** No OTel dependency in the
  reference servers; OTel can wrap it later.
- **CI database: GitHub Actions service container** for the persistence suite; local dev keeps
  `docker-compose.yml`; same env vars target both.

**Process & governance**
- **This docs wave: commit and push** (secret-scan first, per invariant 7).
- **Rulings live here, in `docs/decisions.md`** — created by this ruling; binding choices also
  folded into the roadmap text where they apply.
- **Phase tracking: roadmap exit-gate checkboxes + HANDOFF "current phase / next task".** No
  GitHub milestones until the Phase 6 community on-ramp makes them worth the duplicate bookkeeping.
- **CI real-Actions proof (backlog #6): with this docs push** — ship the wave as a short-lived
  branch + PR so the workflow proves itself on a zero-risk docs-only diff.

# Roadmap — ten phases beyond today's baseline

This is the forward plan for GameKit: **ten sequenced phases** that take the kit from "verified
multi-genre baseline" to "versioned, scalable, self-hosting 1.0 ecosystem". It extends the
near-term backlog in [HANDOFF.md](HANDOFF.md) — backlog items are absorbed into Phases 1–5; this
doc owns everything past them.

**How to read it.** Each phase has a theme, the workstreams that make it real (grounded in files
that exist today), an **AI-harness thread** (Track 2 evolves in lock-step with Track 1 — see
[README.md](README.md) for the two tracks), and **exit gates** — observable checks, not vibes.
A phase is done when its gates pass, exactly like a task card
([process/task-templates.md](process/task-templates.md)). Owner rulings that bind this plan
(license, showcase genre, architecture shapes…) are recorded in [decisions.md](decisions.md);
the standing audience ruling: **dual-track — the owner's game leads phase priority; every
deliverable ships public-ready as a byproduct.**

**Sequencing.** Phases are ordered by dependency, not calendar. 1→2→3 are strictly ordered
(security before drivers before persistence-backed tests). 4 needs 3 (quest/save integration);
5 needs only 2. 6 gates 7, 9's deploy/publish legs, and 10. 8 is harness-only and can start any
time after 2 — but its `npx` exit gate needs Phase 6's publish pipeline (or an interim
git/tarball install path). 9 needs 1+2+3. 10 needs everything; start its long-lead showcase the
moment 8 closes.

| # | Theme | Depends on | Headline gate |
|---|---|---|---|
| 1 | Hardened reference servers + legal baseline | — | hostile-client suites pass; LICENSE committed |
| 2 | Verification parity across genres | 1 | all three starters smoke-tested in CI |
| 3 | Persistence & accounts | 2 | state survives a server kill in every genre |
| 4 | Playable depth (double-budget) | 3 | kill→loot→quest chain asserted in one smoke run |
| 5 | Cross-platform clients | 2 | all three starters playable by touch at 390×844 |
| 6 | Versioned releases & fork lifecycle | 4, 5 | `npm i @gamekit/rng` works in a clean external project |
| 7 | Content pipeline v2 | 6 | full imagegen loop headless in CI with a mock provider |
| 8 | Harness v2: orchestration as a product | 2 (publish leg: 6) | fresh repo → first carded lane merged in <30 min |
| 9 | Scale & live-ops | 1, 2, 3 | 500-bot multi-node load run, report committed |
| 10 | Ecosystem & 1.0 | all | third-party plugin with zero kit patches; 1.0 published |

---

## Phase 0 — the baseline (today, for reference)

What exists and is verified green (2026-07):

- **Toolchain (Track 1):** asset bank + DevKit, Python art/asset-cleanup pipelines, audio pipeline
  (ElevenLabs + mock providers), zone lint/validate/export, capture/smoke tools, all path-routed
  through `tools/src/toolkit-config.ts` and coupled to games only via
  [`@gamekit/game-contract`](../packages/game-contract/).
- **Core-systems library:** 7 pure packages — `game-contract`, `rng`, `save`, `stats`, `inventory`,
  `turn-grid`, `summon` ([systems.md](systems.md)). All are today `private: true` with source-only
  `exports` (see Phase 6).
- **Three forkable genre starters** ([genres.md](genres.md)): real-time action
  ([starter-game](../examples/starter-game/)), turn-based tactics
  ([tactics-game](../examples/tactics-game/)), request/response gacha
  ([gacha-game](../examples/gacha-game/)) + the `pnpm create:game` scaffolder
  (`tools/src/create-game.ts`).
- **AI-dev harness (Track 2):** grounded fan-out, card orchestration, model-role charter, lane
  tooling (`lane:*`, `intake*`, `lanes:watch`), state-doc conventions
  ([architecture/ai-architecture.md](architecture/ai-architecture.md)).
- **Gates:** `pnpm -r typecheck` (tools + 7 packages), `pnpm test` (244 passed / 2 skipped),
  `pnpm selftest`, CI workflow, git hooks, brand-leak grep = 0.

Known honest gaps (the seeds of Phases 1–5): all three example servers are DEV ONLY; the
smoke/capture state reader drives only the real-time genre; gacha state is in-memory;
`db/schema.sql` is a marker; action/tactics clients are desktop-only; `@gamekit/*` is unpublished
— and the public repo currently ships **no LICENSE**, which Phase 1 fixes first.

---

## Phase 1 — Hardened reference servers + the legal baseline

**Theme:** the three reference servers graduate from `DEV ONLY` to *deploy-shaped* — still small,
but safe to put on a network, and every fork inherits that safety on day one. And the repo gets
the license a fork-based strategy legally requires.

**Why now:** it's the top of the current backlog for a reason — every fork copies these servers
verbatim, so today the kit *teaches* insecure defaults. Fix the teacher. Same logic for the
license: a public repo with no LICENSE grants no fork rights at all, and every phase after this
one assumes forks.

**Workstreams**

1. **License & legal floor** — commit the **Apache-2.0** LICENSE (ratified —
   [decisions.md](decisions.md)), add the `license` field to every `package.json`, and note
   third-party asset/tool license expectations in the README. Nothing external can safely adopt
   the kit until this lands.
2. **Shared hardening module** — a new `@gamekit/server-guard` package (pure core; Express and
   Colyseus adapters live beside the reference servers, not in the pure package). Pinned token
   design so nothing improvises: session tokens are either opaque ≥128-bit `crypto.randomBytes`
   values looked up server-side or HMAC-signed (key from env, never a default); comparisons
   outside a Map lookup use `timingSafeEqual`; TTL everywhere; rotation on any privilege change.
   Plus per-IP + per-session rate limiting and input schema validation helpers.
3. **Per-genre fixes** in `examples/*/server`:
   - all three: origin allowlist from env (default `localhost` only) — **enforced at the right
     layer**: HTTP CORS for Express routes AND `Origin`-header validation on the WebSocket
     upgrade/`onAuth` for the Colyseus servers (CORS alone does not cover WS); baseline security
     headers (helmet or equivalent); guest-session TTL + cap; JSON body-size limits; structured
     4xx rejections.
   - action + tactics (Colyseus): room `maxClients`, join-rate limits, message-rate limits.
   - tactics: **team-ownership auth** — a session may only issue intents for its own team
     (server-side check in the intent handlers, mirrored by a `turn-grid` helper so client and
     server agree by construction, same pattern as move validation).
   - gacha: the mutating routes already 401 without a session token
     (`examples/gacha-game/server/src/index.ts`) — but the token is an unsigned `randomUUID` and
     the RNG seed is `Date.now() ^ Math.random()`. Fix both: forgery-resistant tokens per
     workstream 2, session RNG seeded from `crypto.randomBytes` (pulls carry monetary value in
     real forks), and a bounded guest store (LRU + TTL).
4. **Hostile-client test suite** — vitest suites per server that connect as a misbehaving client
   and assert rejection: spoofed team, replayed/stale token, unbounded pulls, oversized payloads,
   cross-origin HTTP **and cross-origin WebSocket join**, forged `X-Forwarded-For`. These are the
   regression net for every future server change.
5. **`docs/security.md`** — the deploy checklist a fork follows: env vars, what the guards cover,
   `trust proxy` / which hop supplies the client IP (so rate limits survive a load balancer),
   and what the kit deliberately doesn't cover (DDoS, TLS termination, secrets management —
   pointers only). Ships with the pre-push secret-scan hook (graduating that rule from handoff
   prose to `.githooks/`), including a note on the pre-commit guard's known blind spots
   (`precommit-guards.cjs` skips fixtures/lockfiles) so forks don't over-trust it.

**AI-harness thread:** wire `pnpm lane:security-scan` (`tools/src/lane-security-scan.ts`) into the
intake path for any card touching `examples/*/server`, and add a "hostile-client proof leg" recipe
to [process/orchestration-mechanics.md](process/orchestration-mechanics.md) §Recipes.

**Exit gates**
- [ ] Hostile-client suites pass against all three servers (and fail if a guard is removed).
- [ ] A cross-origin WebSocket join is rejected by both Colyseus servers (regression-tested).
- [ ] `DEV ONLY` banners deleted from the three servers; replaced by a pointer to `docs/security.md`.
- [ ] `create:game` output inherits the hardened server + `.env.example` gains the security vars.
- [ ] LICENSE committed; every `package.json` carries the `license` field.
- [ ] All Phase-0 gates still green.

**Risks:** Colyseus rate-limit/auth hooks are version-sensitive (pinned `colyseus.js` 0.16) —
verify against the pinned server version, don't upgrade in the same phase.

---

## Phase 2 — Verification parity across genres

**Theme:** the smoke/capture loop — the kit's biggest differentiator ("you are NOT blind") — works
for **all three** runtime shapes, not just real-time.

**Why now:** [genres.md](genres.md) is honest that `tools/src/smoke/state.ts` reads only a
Colyseus `players`-by-session shape. Phases 3–5 change game behavior in all three genres; they
need this safety net first.

**Workstreams**

1. **`GameDriver` seam in the contract** — a small driver interface: `boot`, `connectAsGuest`,
   `readState` (normalized: entities, ownership, scalar stats), `sendIntent`, `screenshot`.
   Placement (ratified): the **interface — types only — joins `@gamekit/game-contract`**; the
   implementations live in `tools/src` beside capture/smoke, where Playwright and
   process-spawning already live, so `packages/*` stays pure (invariant 5). The three shapes:
   - **real-time driver** — wraps today's `smoke/state.ts` logic (no behavior change).
   - **turn-based driver** — reads `units[]`-by-team + turn state from `globalThis.__GAME`.
   - **request/response driver** — drives the HTTP API + `globalThis.__GACHA`.
2. **Retarget the suites** — `capture-zone.ts`, `capture-tactics.ts`, `capture-gacha.ts` and the
   `smoke-*` tools consume drivers instead of hard-reading room state. `capture:tactics`/
   `capture:gacha` stop being one-off siblings and become thin configs of one capture engine.
   This refactor also retires `capture-zone.ts`'s `EDITOR_MAP_ID` default-framing-map residual
   (HANDOFF backlog #7 — it lives in the capture tool, not the zone editor). Note:
   `capture-zone.ts` is ~300 lines today; HANDOFF's 1000+-line Edit-tool hazard note dates from
   before it was slimmed — the one-edit-mechanism-per-file lesson still stands for any large file.
3. **Full smoke suites for tactics + gacha** — mirror the real-time suite: guest entry, one legal
   intent, one *illegal* intent (rejected — this doubles as the Phase-1 regression), state
   assertion, capture.
4. **CI uplift** — a `smoke-examples` CI job boots each starter headless and runs its smoke suite
   (the game-aware gate the current CI intentionally skips becomes runnable *for the examples*,
   because the examples are wired games).

**AI-harness thread:** card "Proof leg" lines can now name a genre-true smoke command for any
starter; the READY-verification ritual gains "run the genre smoke suite" as a standard recipe.

**Exit gates**
- [ ] One capture engine + three drivers; `pnpm smoke:tactics` / `pnpm smoke:gacha` exist and pass.
- [ ] The genres.md "known limitation" section is rewritten to past tense.
- [ ] CI runs all three starters' smoke suites headless and green.
- [ ] Real-time capture output: the pre-refactor SHOTS framings reproduce with zero pixel diff on
      static frames (any intentional deviation is listed in the closeout with before/after crops).

**Risks:** driver abstraction over-generalizing — keep `readState` minimal (what the smoke
assertions actually use), not a universal game-state schema.

---

## Phase 3 — Persistence & accounts

**Theme:** state survives a restart. The kit ships a real data layer and an account model, and
`@gamekit/save`'s migration chain gets a database home.

**Why now:** gacha state is in-memory per guest; `db/schema.sql` is a marker;
`docker-compose.yml` already ships Postgres (`gamekit-db-1`) that only the DevKit uses. Phases
4/9 (progression depth, live-ops) are meaningless without persistence.

**Workstreams**

1. **`@gamekit/persistence`** — a thin repository layer: `accounts`, `saves` (versioned blobs run
   through `@gamekit/save`'s `defineSave` migration chain), `sessions`. The **pure interface + an
   in-memory adapter** live in the package (keeping tests and zero-dependency forks working); the
   `pg` adapter lives beside the reference servers — same placement rule as Phase 1's guards, so
   `packages/*` stays dependency-pure (invariant 5).
2. **Guest → registered upgrade path** — guest sessions (Phase 1 tokens) can be promoted to an
   account without losing state. **Auth scope pinned:** 1.x ships **no password storage** —
   promotion binds to a magic-link email or OAuth identity (or a fork-supplied verifier); if a
   fork insists on passwords, `docs/security.md` prescribes argon2id + the checklist. Promotion
   always **issues a fresh session token and revokes the guest token** (session-fixation guard);
   the hostile-client suite asserts the old token is dead. Reference implementation in the gacha
   server first (it has the clearest "roster you'd hate to lose"), then the action starter's
   player save.
3. **`db/schema.sql` becomes real** — the bootstrap schema for the above + compose hardening
   (Postgres bound to `127.0.0.1`, non-default password required outside dev — today it publishes
   `5432` on all interfaces with `gamekit`/`gamekit_dev`) + a `docs/persistence.md` describing the
   migration discipline (a fork owns its schema; the kit owns the save-blob versioning pattern).
4. **Crash-recovery smoke** — extend each genre's Phase-2 smoke suite: mutate state → kill server
   → reboot → assert state. `tools/src/smoke-persistence.ts` was born for this; to target the
   examples it needs them to gain the `boot`/`db:migrate` scripts its workspace-filter harness
   spawns (they have none today).

**AI-harness thread:** add a "migration card" template (schema changes are `risk: high`, senior
model signs off per the charter's high-risk rule); DB-touching cards get a mandatory
crash-recovery proof leg.

**Exit gates**
- [ ] Pull ×10 in gacha, kill the server, reboot: roster + pity counter intact.
- [ ] Same for action-starter position/save scalars.
- [ ] Promote a guest to an account: state carried over, old guest token rejected afterward.
- [ ] A `@gamekit/save` migration (v1→v2 field rename) executes against stored blobs in a test.
- [ ] In-memory adapter keeps `pnpm test` green with no DB running; CI provides Postgres via a
      GitHub Actions **service container** for the persistence suite only (local dev keeps
      docker-compose; same env vars target both).

**Risks:** scope creep toward an ORM — the repository interface stays at "load/store/migrate
blobs + accounts", full query modeling is a fork's business.

---

## Phase 4 — Playable depth (the "you build" list shrinks)

**Theme:** each starter's honest "you build" list ([genres.md](genres.md)) loses its biggest
items — not by bloating the demos, but by shipping the missing horizontals as **pure `@gamekit/*`
packages** the demos then consume (the `turn-grid`/`summon` graduation pattern, repeated).

**Sizing note:** this is a **double-budget phase** — four packages plus three starter upgrades.
Run it as parallel per-package lanes (they're disjoint workspace members by construction), or
split it 4a (`combat` + `abilities` + starter combat loops) / 4b (`quest` + `behavior` + AI
opponent) if working sequentially.

**Workstreams**

1. **`@gamekit/combat`** — attack resolution: damage formulas over `@gamekit/stats` blocks,
   hit/crit/mitigation, damage types, death hooks. Consumed by action (real-time HP) and tactics
   (attack intent resolution) — one source of combat truth for two genres.
2. **`@gamekit/abilities`** — data-driven ability definitions: costs, cooldowns, targeting shapes
   (self/single/line/AoE — tactics range shapes extend `turn-grid`'s `validateAttack`), effect
   lists that apply `stats` modifiers. Powers tactics unit classes AND the gacha battle screen.
   (Plural name is deliberate — `stats` set the precedent.)
3. **`@gamekit/quest`** — objective/progress/reward state machine (kill N / reach zone / collect
   item), pure reducers, save-chain integration. The action starter's smoke reader *already*
   expects quest fields (`tools/src/smoke/state.ts`) — this closes that loop.
4. **`@gamekit/behavior`** — minimal FSM/utility-AI for server-side monsters (idle/aggro/leash);
   action starter's slimes get real behavior; tactics gets an optional AI opponent for
   single-player testing.
5. **Starter upgrades that prove the packages:** tactics ships 3 unit classes + 3 maps; action
   ships combat/loot/one quest; gacha ships a battle screen (uses `combat`+`abilities` with
   collected units) + a second banner. Each starter stays small — the packages carry the depth.

**AI-harness thread:** this is the first *content-heavy* phase — run it as parallel lanes per
package, with the constraint-vs-cardinality check from the Conductor Loop applied to every content
card. First extend `coverage-ratchet` with a `packages` workspace bucket (today it buckets only
`server/shared/client` path prefixes — `tools/src/coverage-ratchet.ts`), then raise it as each
package lands tests.

**Exit gates**
- [ ] 4 new packages, pure (no Phaser/Colyseus/Express/DOM), each ≥15 vitest tests, in `pnpm -r typecheck`.
- [ ] Tactics: captures of two different unit classes differ in their ability-range highlight
      tiles (asserted by capture diff, then eyes-on); the AI opponent finishes a match with only
      legal intents (driver-verified).
- [ ] Action: kill a slime → loot drops → inventory increments → quest progresses (one smoke run asserts the chain).
- [ ] Gacha: battle screen resolves with collected units; rate tests still pass.
- [ ] genres.md "you build" lists rewritten — each at least one major item shorter.

**Risks:** the demos becoming games (scope). Rule: a starter demonstrates *one* use of each new
package; everything else stays a fork's job.

---

## Phase 5 — Cross-platform clients

**Theme:** the kit's client story works on a phone. Today all three clients ship a viewport meta,
but only gacha has any real mobile awareness (`touch-action: manipulation` + a ≤480px media
query) — and none has safe-area handling.

**Workstreams**

1. **`@gamekit/input`** — an input-intent mapper: keyboard/mouse/touch/virtual-stick sources
   normalize to the intents the servers already speak (`move.to`, tile taps, button presses).
   Pure core; thin Phaser + DOM bindings beside the starters.
2. **Responsive shells** — action: virtual joystick + camera-scale for small viewports; tactics:
   tap-select with hit-area inflation, portrait board layout; both get the touch-action /
   portrait-media-query treatment gacha already has, plus safe-area insets (new for all three).
3. **Capture matrix** — the Phase-2 capture engine gains device presets (desktop / tablet /
   portrait-phone); every visual proof leg can name a preset. Committed per-starter screenshots
   grow a mobile column ([README.md](../README.md) table).
4. **PWA packaging (lightweight)** — manifest + service-worker recipe in the starters, documented
   as a fork seam, not a hard dependency.

**AI-harness thread:** visual verification rules ([AGENTS.md](AGENTS.md) §Seeing The Game) extend
to the device matrix — a client-touching card's capture proof runs ≥2 presets; every-frame
inspection discipline unchanged.

**Exit gates**
- [ ] All three starters playable via touch in a 390×844 viewport (verified by capture + a touch-event smoke run).
- [ ] `@gamekit/input` tested; the pre-existing desktop input smoke assertions pass unchanged
      after the keyboard/mouse paths move onto the mapper.
- [ ] Capture matrix wired; mobile screenshots committed for all three starters.

**Risks:** virtual-joystick feel is subjective — gate on "server receives correct intents +
owner eyes-on", never on an agent's feel verdict (no-verdict-words rule applies).

---

## Phase 6 — Versioned releases & the fork lifecycle

**Theme:** `@gamekit/*` becomes consumable *outside* this repo, and forks get an upgrade story.
This is the phase that turns a repo into a product.

**Why now:** Phases 4–5 grew the package surface; freezing an API you can version beats vendoring
forever. Everything after this phase benefits from semver discipline.

**Workstreams**

1. **Make the packages publishable at all** — today every `packages/*` is `private: true` with
   source-only `exports: "./src/index.ts"` and **no build step**. First: a build pipeline
   (tsup/tsc → `dist/` with dual ESM+types exports) across all packages, de-privatize, per-package
   READMEs. Then changesets-based versioning and a CI release job on tag with the supply chain
   locked down: **OIDC trusted publishing (no long-lived npm tokens), 2FA enforced on the org,
   npm provenance, a per-package `files` allowlist audit**, a dependency-audit gate
   (`pnpm audit`/OSV) added to CI *now* and kept in the standalone gates, and workflow actions
   pinned by SHA (today they float on `@v4`/`@v5` tags).
2. **Library-model scaffolds** — `create:game` gains `--packages published` (depend on npm
   versions) vs. today's workspace/vendored mode; template snapshots (`turn-grid`, `summon`
   copies inside examples) get a drift check against their canonical packages so snapshots can't
   silently rot.
3. **Fork upgrade path** — `gamekit upgrade` (new tool): diffs a fork's vendored kit files
   against the template version it was scaffolded from (scaffold stamps a
   `.gamekit-version`), applies clean updates, reports conflicts. Modeled as a codemod runner,
   not magic.
4. **Community on-ramp** — CONTRIBUTING.md, issue/PR templates, a discussions channel, and a
   "good first issue" seed list. Phase 10 expects third-party plugins and templates; the funnel
   that produces those contributors starts here.
5. **DX debt from the backlog:** cross-platform `pnpm dev` launcher for scaffolded games;
   "skip selftest without Python" note; quiet the `git dubious ownership` warning
   ([HANDOFF.md](HANDOFF.md) backlog #5); confirm CI green in real GitHub Actions with a PR
   (backlog #6).
6. **Docs site v1** — the `docs/` tree published (static site from the markdown; the existing
   `docs-hygiene` link gate keeps it honest), **version-pinned per release tag** so a fork's
   `.gamekit-version` links it to the doc snapshot it was scaffolded from.

**AI-harness thread:** release lanes — a "release card" template with the changeset check as a
fail-closed intake gate.

**Exit gates**
- [ ] `npm i @gamekit/rng` works in a clean external project; all packages published at 0.x;
      every published tarball carries the LICENSE and passes the `files`-allowlist audit.
- [ ] A game scaffolded from the previous kit version upgrades via `gamekit upgrade` with zero
      manual edits (clean case); the conflict report lists every conflicted file with both
      versions' hunks (dirty case).
- [ ] Snapshot-drift check fails CI when a template's embedded engine diverges from its package.
- [ ] Real GitHub Actions run is green (link committed in HANDOFF); dependency-audit gate active.
- [ ] One external PR merged by a contributor following only CONTRIBUTING.md.

**Risks:** publishing is one-way (unpublish is restricted) — dry-run with `npm pack` +
a scoped dist-tag first; secret-scan the tarballs.

---

## Phase 7 — Content pipeline v2

**Theme:** the art/audio pipelines become provider-pluggable and turnkey-verifiable, the way the
audio pipeline already is (ElevenLabs + mock). Today `imagegen:extract` is generation-engine
specific and the art loop's provider is bring-your-own ([HANDOFF.md](HANDOFF.md) backlog #6).

**Workstreams**

1. **Image-generation provider interface** — mirror `tools/src/audio-*`'s provider seam:
   `generate(brief) → candidate images`, with a **mock provider** producing deterministic fixtures
   so the *entire* loop (generate → clean → defect-gate → review → promote → sync) runs headless
   in CI with zero keys. Real providers plug in behind env config; provider API keys follow the
   `docs/security.md` secrets guidance (env-only, never committed, scan-covered).
2. **Animation intake turnkey** — the Python `art-pipeline` (spritesheets, bg-removal, anchors,
   `anim-validator-gate`) gets one entry command per intake shape + fixture selftests folded into
   `pnpm selftest`; document the matting/despill decision tree in one place.
3. **DevKit editor growth** — multi-map switching in the zone editor, prop palettes from the
   promoted registry, undo/redo, and a layout-export drift gate
   (`check-layout-export-drift.ts` generalized).
4. **Art-direction lockfile** — a per-game `art-direction.json` (palette, outline, resolution,
   style tags) that generation briefs and the defect gate both read — the "locked art direction"
   the asset rules assume ([AGENTS.md](AGENTS.md) §Asset Bank Rules) becomes a checkable artifact.

**AI-harness thread:** generation *cards* name a pipeline provider via `--provider`/env config —
distinct from `lane:spawn --engine`, which selects which agent CLI runs the lane; the charter's
engine split is about lanes, not pipeline providers. Per-asset QA contracts (§Token Discipline
"Asset" contract) reference the lockfile checks.

**Exit gates**
- [ ] `pnpm imagegen:loop --provider mock` runs generate→gate→promote headless in CI, green, no keys.
- [ ] A real-provider run is documented with cost caps (owner-billed, per the charter).
- [ ] Zone editor: two maps edited in one session; export-drift gate green.
- [ ] Defect gate reads the art-direction lockfile (tint/outline checks parameterized, fixtures updated).

**Risks:** the mock provider drifting from real-provider output shapes — pin the provider
interface with fixture contract tests so a real provider must satisfy the same shapes the mock
proves.

---

## Phase 8 — Harness v2: orchestration as a product

**Theme:** Track 2 graduates from "docs + scripts in this repo" to an **installable harness** any
repo can adopt in minutes — the same leap `create:game` gave Track 1.

**Why now:** the harness is proven but its adoption cost is a doc-reading afternoon
([adopting-the-harness.md](adopting-the-harness.md)); its state docs are convention; its report
formats are prose. Mechanize what's stable — and credit what already exists: `pnpm intake`
already fails closed on a missing `## Closeout` / `**Proof leg:**`, and
`tools/src/boot-successor-digest.ts` already implements a fail-closed boot-digest probe. Phase 8
generalizes these; it does not rebuild them.

**Workstreams**

0. **Self-host substrate (prerequisite)** — the lane tooling hardcodes `docs/tasks/card-<lane>.md`
   and `docs/state/*` paths that exist in scaffolded games but **not in this repo**. Seed this
   repo's own state docs + `docs/tasks/`, or make the paths configurable via the
   `harness.config.json` below — without this, the dogfood rule can't run here.
1. **`@gamekit/harness`** — packages the lane/intake/watch/sessions tools + seeds the five state
   docs + AGENTS.md into any repo (`npx @gamekit/harness init`), with the model-role charter
   captured as a config file (`harness.config.json`: role→model map, engine split, gate commands,
   state-doc paths) instead of prose-only decisions-doc entries. The decisions doc still ratifies
   it; the config makes it executable.
2. **Structured report contracts** — what's genuinely new here (closeout-shape bouncing already
   exists in `intake`/`intake:brief`): JSON Schemas for the Scout/Build/Deep/Asset **report
   texts** (§Token Discipline), plus mechanical length-contract enforcement — an oversized or
   schema-violating report is bounced by `intake:brief` without the integrator reading it.
   Rollout (ratified): the first wave **warns without bouncing** so schemas calibrate against
   real lane output; the second wave flips to fail-closed.
3. **Cold-boot gate, generalized** — `boot-successor-digest.ts` exists but is hardcoded to
   origin-project residue (probe anchors, model names) and has no `pnpm` binding. Generalize it:
   probe questions/answer keys move into `harness.config.json`. The gate then **splits**:
   (a) a mechanical bundle/digest integrity check (`--check`, fail-closed) that runs in CI on
   every boot-doc change — no model, no cost; (b) the full live-model probe from
   [process/cold-boot-test.md](process/cold-boot-test.md) as an **owner-triggered** job with a
   stated cost cap (per the charter's owner-billing rule), with a toolkit-shaped probe task
   (this repo has no game content to probe against).
4. **Lane telemetry** — aggregate the usage data the codex event stream already carries
   (`lanes-watch.ts` parses per-turn `input_tokens` today) into the lane registry; agent lanes
   (which write no event log) get turn-count + gate-rerun counts. `lanes:board` grows a cost
   column; wave retros get data instead of anecdotes.
5. **Steer mechanization** — `lane:steer <lane>` writes the steer file + a registry event so
   `lanes:watch`/`lanes:board` surface un-acked steers (today steer files are pure convention).
6. **Harness gates into CI, fail-closed** — `docs:budget`, `coverage:check`, `sessions:check` run
   in CI (today `ci.yml` runs none of them and `validate.ts` only WARNs on docs budget), closing
   the drift with ai-architecture.md's Enforcement Layers table, which already claims CI covers
   the docs budget.
7. **Agent-SDK bridge** — a reference adapter that maps cards to Agent-SDK/Workflow-style
   subagent spawns (the grounded fan-out contracts as reusable prompts) — and **enforces the
   charter's two mechanizable guards as config-checked invariants**: subagents never run the
   senior model (every spawn passes an explicit lesser model), and steers/resumes go via fresh
   spawns, never session-inheriting sends.

**AI-harness thread:** *is* the phase. Dogfood rule: once WS0 lands, the remaining workstreams
run as carded lanes on this repo — and the generalized cold-boot check must pass here before the
phase closes.

**Exit gates**
- [ ] Harness init on a fresh non-game repo (via `npx` once Phase 6's pipeline exists, or the
      interim git/tarball path) → first carded lane merged in under 30 minutes, following only
      the generated docs.
- [ ] An oversized/schema-violating lane *report* is mechanically bounced by `intake:brief`
      (fixture-tested) — distinct from the closeout-shape bounce that exists today.
- [ ] The mechanical cold-boot digest check runs in CI and passes; a deliberately broken boot doc
      makes it fail. One owner-triggered live probe run is documented with its cost.
- [ ] One full wave on this repo ships with telemetry captured and a data-backed retro in the
      handoff; `lanes:board` shows per-lane cost/turn counts.

**Risks:** over-mechanizing judgment — the charter's boundary (senior model owns intent/design/
risk) stays prose+config; only *contracts and gates* get mechanized.

---

## Phase 9 — Scale & live-ops

**Theme:** a fork can serve real concurrent players and see what's happening. The reference
architecture grows from single-process to horizontally scalable, observable, and load-tested.

**Why now:** needs Phase 1 (guards), 2 (drivers — the load bots reuse them), 3 (persistence).
This is where "starter" becomes "launchable".

**Workstreams**

1. **Multi-node reference** — Colyseus presence/driver via Redis (compose gains a `redis`
   service beside `gamekit-db-1` — with `requirepass`/ACL and never port-published in the prod
   profile; session/presence data is credential-equivalent), sticky-session notes,
   room-count/process metrics; the gacha API goes stateless-behind-a-balancer using Phase-3
   session storage (it's request/response — it scales first and easiest). The Phase-1
   `trust proxy` guidance gets its production test here: rate limits must key on the real client
   IP behind the balancer.
2. **Matchmaking + channels** — a small lobby service pattern: named channels/instances for the
   action genre, match assembly for tactics (2 humans or human+AI), reusing the guest/account
   identity from Phases 1/3.
3. **Observability seams** — structured logging + a metrics endpoint (Prometheus-shape) in the
   reference servers; a `docs/operations.md` runbook (what to watch, what breaks first); funnel
   events standardized so `tools/src/funnel-report.ts` runs against any fork.
4. **Load harness** — retarget/extend `tools/src/loadtest.ts` (an existing 90-line Colyseus bot
   swarm, currently aimed at a wired game's `"world"` room rather than the starters' `"game"`
   room) onto the Phase-2 `GameDriver`, so bot swarms speak every genre; `pnpm load:action
   --bots 500` style entry; latency/tick-budget report out.
5. **Deploy recipes** — Dockerfiles for each starter, compose-prod profile, and one worked
   example (Fly/Render-class) documented end-to-end with the security checklist from Phase 1.

**AI-harness thread:** load/perf lanes get a numeric proof-leg convention (p95 tick time, join
success rate) so "faster/slower" claims are banned the way visual verdict words already are.

**Exit gates**
- [ ] 500-bot load run on starter-game across ≥2 server processes: join success ≥99%, no
      state divergence between nodes (driver-verified), report artifact committed.
- [ ] Kill one node mid-run: players rejoin, persistence intact (crash smoke at scale).
- [ ] Metrics endpoint scraped in the load run; runbook cites the actual dashboards/queries used.
- [ ] Tactics matchmaking assembles and completes a full match between two headless drivers.

**Risks:** Colyseus presence/driver packages couple to the pinned 0.16 line — validate the Redis
driver against the pin before any version move, and treat a Colyseus upgrade as its own card,
never a rider on this phase.

---

## Phase 10 — Ecosystem & 1.0

**Theme:** GameKit becomes self-sustaining: a plugin architecture so the community extends it
without forking the kit, a showcase that proves the whole stack, and a 1.0 contract.

**Workstreams**

1. **Contract v3 — capability negotiation** — `@gamekit/game-contract` grows optional
   *capability declarations* (spatial, turn-based, request/response, persistence, combat…) so
   tools discover what a game supports instead of assuming (the Phase-2 drivers formalized the
   shapes; v3 lets a game declare *which* it implements and tools degrade gracefully).
   Existing games remain valid (additive, defaulted).
2. **Plugin surface** — stable extension points, versioned: DevKit panels, capture drivers,
   generation/audio providers, zone-lint rules, harness gates. Each documented with a worked
   third-party example living *outside* this repo to prove the boundary is real.
3. **Template registry** — community starters beyond the three (`create:game --template <src>`),
   with a conformance suite: the genre conventions from [genres.md](genres.md) (guest entry,
   inspectable global, smoke-run handshake) as executable checks — **plus the safety floor:
   no lifecycle install scripts, pinned integrity hashes for listed templates, and a visible
   "templates run code — review before scaffolding" warning in the CLI.**
4. **The showcase (dogfood proof — long-lead, starts the moment Phase 8 closes)** — one
   small-but-complete vertical-slice game — **ratified genre: real-time action** (it exercises
   the most of the kit, and as the `create:game` template its case study doubles as the
   canonical tutorial) — built **entirely** via the Phase-8 harness by AI lanes, from
   `create:game` to a deployed Phase-9 instance, with the build's
   cards/handoffs/telemetry published as a case study. This is the kit's founding thesis —
   documentation-as-project-memory enabling model-swappable development — demonstrated end-to-end
   in public. Run it in parallel with the 1.0 engineering below so the release isn't hostage to a
   demo game's schedule.
5. **1.0 release engineering** — API freeze + semver commitment for `@gamekit/*` and the contract;
   third-party security review of the server-guard + **the full auth/session path including
   Phase 3 persistence (account promotion, save blobs) and Phase 9 multi-node session sharing**,
   plus a threat-model pass on the plugin/template surfaces; deprecation policy; upgrade guide
   from every 0.x.

**AI-harness thread:** the case study doubles as the harness's public benchmark; the cold-boot
test and conformance suite become the "works with GameKit" badge criteria.

**Exit gates**
- [ ] A third-party plugin (out-of-repo) adds a DevKit panel + a lint rule with zero kit patches.
- [ ] A community-shaped template passes conformance (including the safety checks) and scaffolds
      via `create:game --template`.
- [ ] Showcase game is publicly playable; its full harness ledger (cards → merges → telemetry) is
      published; a cold session can answer "how was this built?" from the ledger alone.
- [ ] `@gamekit/*@1.0.0` published; security review findings closed or accepted-with-rationale.

**Risks:** the plugin surface freezing too early — every extension point ships `experimental`
first and stabilizes only after the third-party example exercises it; the 1.0 tag waits for the
security review, not for the showcase.

---

## Cross-phase invariants (never break these)

These hold in every phase; any card violating one is auto-bounced:

1. **De-branded, always** — the brand-leak grep stays 0 ([HANDOFF.md](HANDOFF.md) ground rule).
2. **Standalone gates stay green** — `pnpm -r typecheck`, `pnpm test`, `pnpm selftest` at every
   merge; new suites *add* gates, never replace them.
3. **Contract-only coupling** — tools never import a game's source tree; new tool↔game needs go
   through `@gamekit/game-contract` (that's what Phases 2 and 10 are for).
4. **Forks stay self-contained** — templates embed what they need
   ([systems.md](systems.md) fork model); Phase 6 adds drift *checks*, not runtime coupling.
5. **Pure packages stay pure** — `packages/*` never grow Phaser/Colyseus/Express/DOM/driver deps;
   adapters live beside the consumers (Phase 1 guards and Phase 3 `pg` adapter both follow this).
6. **Honesty sections survive** — every phase that closes a documented limitation updates the doc
   that admitted it (genres.md, README residuals) the same merge; new limitations get written
   down with the same candor.
7. **Public-repo hygiene** — secret-scan before every push; example creds stay obviously fake.

## Phase-to-backlog map

Current [HANDOFF.md](HANDOFF.md) backlog → where it lands: #1 servers → Phase 1 · #2 genre depth
→ Phase 4 · #3 smoke/capture parity → Phase 2 · #4 mobile → Phase 5 · #5 DX polish → Phase 6 ·
#6 infra (CI PR, schema, asset-tool turnkey) → Phases 6/3/7 · #7 minors (`EDITOR_MAP_ID` →
Phase 2's capture refactor; `Int16Array` procgen cap → opportunistic).

*This document was reviewed through four lenses (technical grounding, security, AI-harness
fidelity, product/docs) before adoption; stale sibling-doc facts found during that review
(README test count, genres.md capture-sibling note, HANDOFF capture-zone size) were fixed in the
same change, per invariant 6.*

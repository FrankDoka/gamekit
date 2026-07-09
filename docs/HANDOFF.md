# GameKit — session handoff (for a reviewer/continuer)

You're picking up **GameKit**, a reusable, de-branded 2D game dev kit. This orients a cold session
to review or extend it. Read this, run the gates, then pick from the backlog.

- **Repo:** `Z:\Game-Architecture` → **https://github.com/FrankDoka/gamekit** (public, `main`).
- **What it is:** a game-agnostic toolkit (asset bank, DevKit, art/audio pipelines, zone/capture/smoke
  tools, an AI-dev harness) + a `packages/*` core-systems library + three forkable genre starter games.
  It ships no game; you build one by forking a starter or depending on `@gamekit/*` packages.

## ⛔ Ground rule
GameKit was extracted from a private parent repo (a sibling folder on `Z:\`) where other sessions
actively work — the maintainer's kickoff prompt and memory name that path. **Never read/write/git
any repo other than this one.** GameKit is fully de-branded: the brand-leak grep below must stay
**0** (its pattern uses a char-class so this doc doesn't match itself).
Everything you do lives in `Z:\Game-Architecture`.

## Verify it's healthy (run these first)
```sh
cd Z:/Game-Architecture
corepack enable && pnpm install            # pnpm 11.7 via corepack
pnpm -r typecheck                          # 9 workspace projects → exit 0
pnpm test                                  # vitest → 244 passed / 2 skipped
pnpm selftest                              # python+ts fixture gates → exit 0 (needs Python 3.11 + Pillow + numpy)
grep -rinI 'lum[o]ria' . --exclude-dir=node_modules --exclude-dir=.git   # brand-leak gate — must be 0
```
Game-aware captures (boot a game + screenshot): from `examples/starter-game`,
`node ../../node_modules/tsx/dist/cli.mjs ../../tools/src/capture-zone.ts _out --map=map_starter_field --sweep`;
plus `pnpm capture:tactics` / `pnpm capture:gacha`. Inspect the PNGs yourself — don't trust exit codes alone.

## Repo map
- `tools/` — the toolchain (see `tools/README.md`). `tools/src/*.ts` + Python `art-pipeline`/`asset-cleanup`.
- `packages/*` — the core-systems library: `game-contract` (spatial contract), `rng`, `save`, `stats`,
  `inventory`, `turn-grid`, `summon`. Pure, tested, workspace members.
- `examples/*-game` — three self-contained starter games (real-time action / turn-based tactics /
  request-response gacha), each with its **own isolated install**. `create:game` scaffolds from starter-game.
- `docs/` — start at `docs/README.md` (two tracks: the game toolchain + the AI-dev harness). Genre map:
  `docs/genres.md`. Systems: `docs/systems.md`. Harness on-ramp: `docs/adopting-the-harness.md`.
- Root `README.md` — the product front door + a "Known residuals" section.

## Backlog (prioritized — pick from here)
> Long-range plan: [roadmap.md](roadmap.md) sequences ten phases beyond this backlog (items below
> map to Phases 1–7; see its "Phase-to-backlog map"). Owner rulings that bind it (license,
> architecture shapes, showcase genre…): [decisions.md](decisions.md). Phase progress is tracked
> as roadmap exit-gate checkboxes + this doc's "current phase / next task".
1. **Production-harden the reference servers** (top item before shipping any fork). All three
   `examples/*/server` are `DEV ONLY`: open CORS, unauthenticated guests, unbounded guest sessions
   (gacha), no room `maxClients`/rate-limits (Colyseus), tactics has no team-ownership/auth.
2. **Per-genre "you build" depth** (see `docs/genres.md`): tactics needs unit classes/abilities +
   more maps; action needs combat/AI/inventory/quests; gacha needs a battle screen + more banners.
3. **Smoke/capture genre parity:** `tools/src/smoke/state.ts` reads only the real-time Colyseus room.
   `capture:tactics`/`capture:gacha` exist, but a richer turn-based + request/response smoke *state
   reader* would let those genres use the full smoke suite.
4. **Mobile:** only gacha got touch/portrait; action + tactics clients are desktop-only.
5. **DX polish:** a cross-platform `pnpm dev` launcher for scaffolded games; a "skip selftest without
   Python" note; quiet the `git dubious ownership` warning during `pnpm test`.
6. **Infra:** ~~confirm `.github/workflows/ci.yml` goes green in real Actions~~ **done 2026-07-09**
   — PR #1's "standalone gates" job passed (first real run). Remaining: flesh out `db/schema.sql`
   (currently a marker — roadmap Phase 3); verify which asset tools are turnkey vs. bring-your-own
   (`audio:*` needs an ElevenLabs key; `imagegen:extract` was generation-engine-specific — Phase 7).
7. **Minor:** `capture-zone.ts` keeps `EDITOR_MAP_ID = "map_harbor_outskirts"` as a harmless default;
   `procgen/dungeon.ts` has an `Int16Array` roomId cap (footgun only at huge room counts).

## Gotchas / hard-won lessons (don't relearn these)
- **The Edit tool clobbers large files.** Bit us on `tools/src/capture-zone.ts` back when it was
  1000+ lines (it's ~300 now, post-strip): the Edit tool rewrites from its own snapshot and silently
  reverts external `node`/`fs` writes — this killed an agent mid-strip. The lesson stands for ANY
  large file: use ONE edit mechanism per file; for big surgical deletes, node splices.
- **`.gitattributes` pins LF.** `core.autocrlf` on Windows caused CRLF churn (files show "modified"
  with no content change) and once truncated a file via `git stash`. It's fixed; don't remove it.
- **Isolated game installs** print `ERR_PNPM_IGNORED_BUILDS` (esbuild) — harmless (prebuilt binaries).
  Append `--config.dangerouslyAllowAllBuilds=true` for a clean exit 0. `--ignore-workspace` ignores the
  game's `pnpm-workspace.yaml`/package.json build-approval, so that flag is the only fix.
- **Verify yourself; never trust agent-reported numbers.** Re-run gates; for any visual result inspect
  EVERY frame and describe neutrally (no verdict words) — let the owner judge.
- **Public repo:** secret-scan before any push (only fake test creds should exist).
- **Delegation pattern that worked:** opus subagents on disjoint file slices, each verifying its own
  gates + returning a structured report; then the integrator re-verifies the merged tree and commits.

## Commit history (most recent first)
`core-systems library` → `de-stale README` → `review-wave (onboarding/security/AI-harness)` →
`finish multi-genre roadmap` → `multi-genre consolidation` → `gacha starter` → `tactics starter` →
`review-wave hardening` → `GameKit initial baseline`. All green at each push.

Durable project context also lives in the maintainer's memory (`project_gamekit-toolkit`).

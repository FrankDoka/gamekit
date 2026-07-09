# assets-bank/

This game's **asset data bank** — the default `ASSETS_ROOT` the GameKit DevKit browses and promotes
from (`pnpm devkit`). Drop raw/candidate art here to review it, or leave it empty and work entirely
from the game's in-repo `client/public/assets/` (which the bank also catalogs as read-only rows).

The Asset Bank generates its review metadata **alongside** this folder at `../assets-bank-metadata/`
(`_review/`, `_promotion-plans/generated/`) — created empty on first `pnpm devkit` and self-populating
as you review. That metadata is **per-game, generated state**: it's gitignored and must never be copied
from another game (see `.gitignore` and `tools/devkit/README.md` in the toolkit).

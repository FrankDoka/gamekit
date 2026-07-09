# GameKit Dev Kit

Unified local shell for GameKit asset workflows.

Run:

```powershell
pnpm devkit
```

Default URL:

```text
http://127.0.0.1:8787/
```

Desktop shortcuts can point at `start-devkit.ps1` and `stop-devkit.ps1` in this folder.
The start helper opens the Dev Kit URL and runs the local server from the repo root; the
stop helper stops the listener on port `8787`.

The Dev Kit is the canonical entry point for:

- Asset Bank review and promotion plans.
- Audio review refresh and listening dashboard.
- Pipeline v4 Frame Picker launcher.
- Cleanup/best-first queue discovery.
- Promotion plan location and guardrails.

This repo folder owns the durable app shell and launch workflow.

## Where asset data + review metadata live (per game, generated — never copied)

The Asset Bank resolves its locations from config, not hardcoded paths (`tools/src/toolkit-config.ts`,
consumed in `asset-bank.ts`):

- **`ASSETS_ROOT`** — the asset data bank the DevKit browses/promotes (default `<GAME_ROOT>/assets-bank`).
  The bank also catalogs the game's in-repo `client/public/assets/` as read-only "repo" rows.
- **`ASSETS_METADATA_ROOT`** — the review-metadata store (default `<ASSETS_ROOT>-metadata`). Under it the
  bank creates and owns `_review/` (catalog `asset-review-data.json`, `asset-review-status.json`,
  `related-groups.json`, `entity-profiles.json`, `zone-packs.json`, `asset-collections.json`, `queues/`)
  and `_promotion-plans/generated/`.

`asset-bank.ts` `init()` **creates this structure empty on first `pnpm devkit`** and fills it as you review
**your** game's assets. It is **generated, per-game state** — do NOT copy another game's `_review/` into a
new game (that would import that game's catalog, ratings, and entity profiles). A new game starts with an
empty, self-populating bank; keep the metadata out of version control (see the game's `.gitignore`).

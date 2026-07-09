-- Minimal bootstrap schema for the DevKit's local Postgres (docker-compose.yml).
--
-- A WIRED GAME OWNS ITS REAL SCHEMA/MIGRATIONS. This toolkit is game-agnostic, so it
-- ships no game tables here. This file exists only so a freshly-created `gamekit` DB
-- is non-empty and the DevKit's pg_dump/psql backup+restore round-trip has something
-- real to move. Replace or drop it once your game's migrations run against this DB.
--
-- Runs exactly once, via /docker-entrypoint-initdb.d, when the pgdata volume is first
-- created (i.e. `docker compose up -d` on a fresh volume). It does NOT re-run on an
-- existing volume — use your game's migration tool for evolving schema.

CREATE SCHEMA IF NOT EXISTS gamekit;

-- Provenance marker: proves the init script ran and gives backups a stable row.
CREATE TABLE IF NOT EXISTS gamekit.toolkit_meta (
    key         text PRIMARY KEY,
    value       text NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO gamekit.toolkit_meta (key, value)
VALUES ('schema_bootstrap', 'gamekit-toolkit docker-compose init')
ON CONFLICT (key) DO NOTHING;

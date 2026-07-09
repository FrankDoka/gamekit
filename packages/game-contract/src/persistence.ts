// Persistence contract (the shape the funnel-report telemetry tool reads). The game's real
// implementation is Postgres/Kysely-backed; the toolkit only needs the query surface the tool
// touches: `handle.db.selectFrom(table).select(cols).execute()` plus `handle.close()`.
//
// Per the extraction policy the DB implementation is NOT copied. The contract declares the
// interface and ships a default `createPersistenceHandle` that THROWS — a game must provide a
// real handle (e.g. via a thin adapter over its DB layer) for funnel-report to run.

/** The row shape funnel-report reads back from the gameplay_events log after aliasing columns
 *  (`event_type as eventType`, `character_id as characterId`). A game's real query layer (Kysely
 *  et al.) narrows this precisely; the contract types the exact columns the one consumer reads so
 *  the tool typechecks without `any`. */
export interface PersistenceRow {
  at: unknown;
  eventType: string;
  characterId: string | null;
  payload: unknown;
}

/** Minimal query-builder surface funnel-report drives. Kept structural (not tied to any ORM)
 *  so a game can back it with Kysely, Drizzle, raw SQL, etc. `select` accepts the aliased column
 *  list; `execute` yields rows shaped by `PersistenceRow`. */
export interface QueryBuilder {
  select(columns: readonly string[]): QueryBuilder;
  execute(): Promise<PersistenceRow[]>;
}

export interface PersistenceDb {
  selectFrom(table: string): QueryBuilder;
}

export interface PersistenceHandle {
  /** The query surface, or null when no database is configured. */
  db: PersistenceDb | null;
  /** Release the underlying connection/pool. */
  close(): Promise<void>;
}

/**
 * Default (unwired) persistence handle. A game overrides this by providing its own handle
 * factory; the toolkit ships a loud failure so funnel-report never silently reports on a
 * phantom database.
 */
export function createPersistenceHandle(): PersistenceHandle {
  throw new Error("PersistenceHandle not wired — a game must provide one");
}

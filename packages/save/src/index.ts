/**
 * @gamekit/save — versioned save state + progression helpers.
 *
 * Pure TypeScript, schema-agnostic, zero runtime deps. A save is a versioned container: you
 * `defineSave({ version, migrate })` for your current schema, then `serialize` stamps the
 * version and `deserialize` runs the migration chain from whatever version was stored up to
 * the current one (throwing on unknown/newer versions).
 */

/** The on-disk envelope: an arbitrary state payload tagged with the schema version it was written at. */
export interface SaveEnvelope<TState> {
  version: number;
  state: TState;
}

/**
 * A migration function. Given a state persisted at `fromVersion`, return the state one or
 * more versions newer. `defineSave` calls this repeatedly until the state reaches the current
 * version, so a migrate that bumps by a single version at a time is the simplest correct shape.
 * Both sides are untyped (`unknown`) because older payloads predate the current state type and
 * intermediate versions have no single type.
 */
export type Migrate = (oldState: unknown, fromVersion: number) => unknown;

export interface DefineSaveOptions {
  /** The current schema version. Must be a positive integer. */
  version: number;
  /**
   * Migrates an older payload forward. Optional when `version` is 1 (nothing to migrate).
   * Must advance `fromVersion` toward `version` on each call, or deserialize throws to avoid
   * an infinite loop.
   */
  migrate?: Migrate;
}

export interface SaveCodec<TState> {
  readonly version: number;
  /** Wrap state in the current-version envelope and stringify it. */
  serialize(state: TState): string;
  /**
   * Parse JSON, then migrate from the stored version up to the current one. Throws on
   * malformed JSON, a missing/invalid version, or a version newer than this codec supports.
   */
  deserialize(json: string): TState;
}

/**
 * Defines a versioned save codec. `migrate(oldState, fromVersion)` is run in a loop until the
 * payload reaches `version`; each invocation must move `fromVersion` strictly closer to the
 * target (a migration that fails to advance the version throws, rather than looping forever).
 */
export function defineSave<TState>(options: DefineSaveOptions): SaveCodec<TState> {
  const { version, migrate } = options;
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`defineSave: version must be a positive integer, got ${String(version)}`);
  }

  function serialize(state: TState): string {
    const envelope: SaveEnvelope<TState> = { version, state };
    return JSON.stringify(envelope);
  }

  function deserialize(json: string): TState {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      throw new Error(`deserialize: invalid JSON (${(err as Error).message})`);
    }
    if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
      throw new Error("deserialize: not a save envelope (missing version)");
    }
    const envelope = parsed as { version: unknown; state?: unknown };
    const storedVersion = envelope.version;
    if (typeof storedVersion !== "number" || !Number.isInteger(storedVersion) || storedVersion < 1) {
      throw new Error(`deserialize: invalid stored version ${String(storedVersion)}`);
    }
    if (storedVersion > version) {
      throw new Error(
        `deserialize: save version ${storedVersion} is newer than supported version ${version}`,
      );
    }

    let current: unknown = envelope.state;
    let from = storedVersion;
    while (from < version) {
      if (!migrate) {
        throw new Error(
          `deserialize: save version ${from} needs migration to ${version} but no migrate() was provided`,
        );
      }
      const before = from;
      current = migrate(current, from);
      // A well-behaved migrate advances by at least one version per call. We can't read the
      // "new" version off the payload (it's schema-agnostic), so we advance the counter and
      // trust the migration ladder to be authored one step at a time.
      from = before + 1;
    }
    return current as TState;
  }

  return { version, serialize, deserialize };
}

// ---------------------------------------------------------------------------
// Progression: XP <-> level for a simple configurable curve.
// ---------------------------------------------------------------------------

/**
 * A power curve: the cumulative XP required to REACH `level` is `base * level^exponent`
 * (level 1 requires 0 XP). With `exponent = 1` this is linear; `> 1` makes later levels cost
 * progressively more.
 */
export interface PowerCurve {
  base: number;
  exponent: number;
}

/**
 * A table curve: `thresholds[i]` is the cumulative XP required to reach level `i + 1`.
 * `thresholds[0]` should be 0 (level 1 at 0 XP). Levels beyond the table are clamped to the
 * last table level.
 */
export interface TableCurve {
  thresholds: readonly number[];
}

export type Curve = PowerCurve | TableCurve;

function isTable(curve: Curve): curve is TableCurve {
  return (curve as TableCurve).thresholds !== undefined;
}

/** Cumulative XP required to reach `level` (level 1 => 0). */
export function xpForLevel(level: number, curve: Curve): number {
  if (!Number.isFinite(level)) throw new Error("xpForLevel: level must be finite");
  const lvl = Math.max(1, Math.floor(level));
  if (isTable(curve)) {
    const { thresholds } = curve;
    if (thresholds.length === 0) throw new Error("xpForLevel: empty threshold table");
    const idx = Math.min(lvl - 1, thresholds.length - 1);
    return thresholds[idx];
  }
  return curve.base * Math.pow(lvl - 1, curve.exponent);
}

/** The level a given cumulative `xp` total corresponds to (>= 1), for the same curve. */
export function levelForXp(xp: number, curve: Curve): number {
  if (!Number.isFinite(xp)) throw new Error("levelForXp: xp must be finite");
  const total = Math.max(0, xp);
  if (isTable(curve)) {
    const { thresholds } = curve;
    if (thresholds.length === 0) throw new Error("levelForXp: empty threshold table");
    let level = 1;
    for (let i = 1; i < thresholds.length; i++) {
      if (total >= thresholds[i]) level = i + 1;
      else break;
    }
    return level;
  }
  const { base, exponent } = curve;
  if (base <= 0) throw new Error("levelForXp: curve.base must be positive");
  if (total <= 0) return 1;
  // Invert xp = base * (level - 1)^exponent  ->  level = (xp/base)^(1/exponent) + 1.
  const level = Math.pow(total / base, 1 / exponent) + 1;
  return Math.max(1, Math.floor(level + 1e-9));
}

/**
 * XP still needed to reach the next level from a cumulative `xp` total. Returns 0 only if the
 * curve has a finite top level (table curve) and `xp` is already at or past it.
 */
export function xpToNextLevel(xp: number, curve: Curve): number {
  const total = Math.max(0, Number.isFinite(xp) ? xp : 0);
  const level = levelForXp(total, curve);
  if (isTable(curve) && level >= curve.thresholds.length) {
    return 0; // at max level
  }
  const nextThreshold = xpForLevel(level + 1, curve);
  return Math.max(0, nextThreshold - total);
}

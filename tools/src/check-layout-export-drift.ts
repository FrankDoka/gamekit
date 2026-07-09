import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const MAPS_DIR = join(ROOT, "content", "maps");
const ZONES_DIR = join(ROOT, "content", "zones");

/** Layout source hash — the ONE hash both the drift gate and the DevKit apply-status card
 * compare against `content/maps/<map>.json`'s `compiledFrom.sourceHash`. `\r\n` is normalized
 * so a line-ending flip alone is not reported as drift. */
export function hashLayout(raw: string): string {
  return createHash("sha256").update(raw.replace(/\r\n/g, "\n")).digest("hex");
}

export type LayoutDriftRow = {
  mapId: string;
  file: string;
  /** true when the compiled map is up to date with its layout source. */
  fresh: boolean;
  /** Present when the row is stale/misconfigured — the reason the gate would report. */
  error?: string;
  layoutPath?: string;
  layoutHash?: string;
  compiledHash?: string;
};

/**
 * Compute layout→export drift for every compiled map. Reused by:
 *  - the `pnpm cohesion:check` gate (CLI below), and
 *  - the DevKit apply-status card (GET /api/hub/apply-status),
 * so both read one drift implementation and can never disagree. No state is stored.
 */
export function computeLayoutExportDrift(): LayoutDriftRow[] {
  const rows: LayoutDriftRow[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(MAPS_DIR).filter((name) => name.endsWith(".json"));
  } catch {
    return rows;
  }
  for (const file of files) {
    const mapPath = join(MAPS_DIR, file);
    let map: { id?: unknown; compiledFrom?: string | { path?: unknown; sourceHash?: unknown } };
    try {
      map = JSON.parse(readFileSync(mapPath, "utf8"));
    } catch {
      continue;
    }
    if (!map.compiledFrom) continue;
    const mapId = typeof map.id === "string" ? map.id : file;

    if (typeof map.compiledFrom === "string") {
      rows.push({ mapId, file, fresh: false, error: "compiledFrom is missing sourceHash; run pnpm zone:export" });
      continue;
    }
    if (typeof map.compiledFrom.path !== "string" || typeof map.compiledFrom.sourceHash !== "string") {
      rows.push({ mapId, file, fresh: false, error: "compiledFrom record must include path and sourceHash" });
      continue;
    }

    const layoutPath = join(ROOT, "content", map.compiledFrom.path);
    if (!layoutPath.startsWith(ZONES_DIR) || !existsSync(layoutPath)) {
      rows.push({ mapId, file, fresh: false, error: `compiledFrom path is missing or outside content/zones (${map.compiledFrom.path})` });
      continue;
    }

    const compiledHash = map.compiledFrom.sourceHash;
    const layoutHash = hashLayout(readFileSync(layoutPath, "utf8"));
    if (layoutHash !== compiledHash) {
      rows.push({ mapId, file, fresh: false, error: `layout export is stale for ${map.compiledFrom.path}; run pnpm zone:export`, layoutPath: map.compiledFrom.path, layoutHash, compiledHash });
      continue;
    }
    rows.push({ mapId, file, fresh: true, layoutPath: map.compiledFrom.path, layoutHash, compiledHash });
  }
  return rows;
}

// CLI gate: fail on any stale/misconfigured compiled map. Kept byte-for-byte in behavior
// (same messages, same exit code) so `pnpm cohesion:check` is unchanged.
function main(): void {
  const errors = computeLayoutExportDrift()
    .filter((row) => !row.fresh)
    .map((row) => `${row.mapId}: ${row.error}`);

  if (errors.length > 0) {
    console.error(`[layout-export] FAILED with ${errors.length} stale map export(s):`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log("[layout-export] OK — compiled maps match layout source hashes.");
}

// Only run the gate when invoked directly (node/tsx …/check-layout-export-drift.ts), so the
// DevKit endpoint can import computeLayoutExportDrift without triggering process.exit.
const invokedPath = process.argv[1] ? process.argv[1].replace(/\\/g, "/") : "";
if (invokedPath.endsWith("/check-layout-export-drift.ts") || invokedPath.endsWith("/check-layout-export-drift.js")) {
  main();
}

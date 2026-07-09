import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assetsMetadataRoot } from "./toolkit-config.js";
import { defaultRepoRoots, isRepoSourceDeliverable, repoCatalogPath, repoRootFromModule, walkRepoRoot } from "./bank-repo-roots.js";

/**
 * bank:coverage — the permanent anti-drift gate for the repo asset roots.
 *
 * Every asset file under the repo roots (client/public/assets + assets/sources/accepted)
 * MUST have a matching row in the bank catalog snapshot (asset-review-data.json). If a
 * delivery landed but the catalog never picked it up, the owner goes blind to it — exactly
 * the failure this card fixes. This gate makes that regression a red CI signal instead of a
 * silent hole: it exits 1 and names every uncovered file.
 *
 * A repo file is "covered" when a catalog row exists whose `path` equals its expected catalog
 * path (`runtime-only/<rel>` or `repo-source/<rel>`) — the SAME scheme the bank scan writes.
 * We match on path, not id, because the id may legitimately be a reused registry key.
 *
 * Flags:
 *   --warn-only          report but exit 0 (validate wiring, warning-first per zone:lint)
 *   --metadata-root <p>  metadata root to read the catalog from (default Z:/Assets-metadata)
 *   --data <file>        explicit catalog snapshot path (overrides --metadata-root)
 *   --repo-root <p>      repo worktree root (default: this module's worktree)
 *   --selftest           run the built-in red/green self-test and exit
 */

type CatalogAsset = { id?: string; path?: string; origin?: string };
type Catalog = { assets?: CatalogAsset[] };

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function readCatalog(dataPath: string): Promise<Catalog> {
  try {
    return JSON.parse(await readFile(dataPath, "utf8")) as Catalog;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { assets: [] };
    throw error;
  }
}

export type CoverageResult = {
  ok: boolean;
  totalRepoFiles: number;
  covered: number;
  missing: Array<{ root: string; rel: string; expectedPath: string }>;
};

export async function computeCoverage(repoRoot: string, dataPath: string): Promise<CoverageResult> {
  const catalog = await readCatalog(dataPath);
  const catalogPaths = new Set(
    (catalog.assets ?? [])
      .map((asset) => (typeof asset.path === "string" ? asset.path.replaceAll("\\", "/").toLowerCase() : ""))
      .filter(Boolean),
  );
  const roots = defaultRepoRoots(repoRoot);
  const missing: CoverageResult["missing"] = [];
  let totalRepoFiles = 0;
  for (const repo of roots) {
    for (const rel of await walkRepoRoot(repo.root)) {
      if (repo.origin === "repo-source" && !isRepoSourceDeliverable(rel)) continue;
      // repo-runtime: manifests/registry are data, not catalog assets (the scan skips them too).
      if (repo.origin === "repo-runtime" && path.extname(rel).toLowerCase() === ".json") continue;
      totalRepoFiles += 1;
      const expected = repoCatalogPath(repo.prefix, rel);
      if (!catalogPaths.has(expected.toLowerCase())) missing.push({ root: repo.origin, rel, expectedPath: expected });
    }
  }
  return { ok: missing.length === 0, totalRepoFiles, covered: totalRepoFiles - missing.length, missing };
}

async function selftest(): Promise<void> {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const tmp = await mkdtemp(path.join(os.tmpdir(), "bank-coverage-selftest-"));
  try {
    const repoRoot = tmp;
    const runtimeDir = path.join(repoRoot, "client", "public", "assets", "props");
    const sourceDir = path.join(repoRoot, "assets", "sources", "accepted", "monster_test", "idle", "runtime");
    await mkdir(runtimeDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(runtimeDir, "widget.png"), "png");
    await writeFile(path.join(sourceDir, "widget_idle_sheet.png"), "png");
    const dataPath = path.join(tmp, "asset-review-data.json");

    // GREEN: catalog covers both files.
    await writeFile(
      dataPath,
      JSON.stringify({
        assets: [
          { id: "props_widget", path: "runtime-only/props/widget.png", origin: "repo-runtime" },
          { id: "src_widget", path: "repo-source/monster_test/idle/runtime/widget_idle_sheet.png", origin: "repo-source" },
        ],
      }),
    );
    const green = await computeCoverage(repoRoot, dataPath);
    if (!green.ok || green.covered !== 2) throw new Error(`selftest GREEN failed: ${JSON.stringify(green)}`);

    // RED: drop the runtime row -> coverage must fail naming that exact file.
    await writeFile(
      dataPath,
      JSON.stringify({ assets: [{ id: "src_widget", path: "repo-source/monster_test/idle/runtime/widget_idle_sheet.png", origin: "repo-source" }] }),
    );
    const red = await computeCoverage(repoRoot, dataPath);
    if (red.ok) throw new Error("selftest RED failed: coverage passed with a removed catalog row");
    if (!red.missing.some((m) => m.expectedPath === "runtime-only/props/widget.png")) {
      throw new Error(`selftest RED did not name the removed file: ${JSON.stringify(red.missing)}`);
    }
    console.log("bank:coverage selftest passed (green covers 2; red names runtime-only/props/widget.png).");
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) {
    await selftest();
    return;
  }
  const warnOnly = args.includes("--warn-only");
  const repoRoot = path.resolve(argValue(args, "--repo-root") ?? repoRootFromModule());
  const metadataRoot = path.resolve(argValue(args, "--metadata-root") ?? assetsMetadataRoot());
  const dataPath = argValue(args, "--data") ?? path.join(metadataRoot, "_review", "asset-review-data.json");

  if (!existsSync(dataPath)) {
    const msg = `bank:coverage: catalog snapshot not found at ${dataPath} — is the metadata root correct?`;
    if (warnOnly) {
      console.warn(`WARNING: ${msg}`);
      return;
    }
    console.error(msg);
    process.exitCode = 1;
    return;
  }

  const result = await computeCoverage(repoRoot, dataPath);
  const label = `bank:coverage: ${result.covered}/${result.totalRepoFiles} repo asset files covered by the catalog (${dataPath})`;
  if (result.ok) {
    console.log(`${label} — OK`);
    return;
  }
  const lines = result.missing.slice(0, 50).map((m) => `  [${m.root}] ${m.expectedPath}`);
  const overflow = result.missing.length > 50 ? `  ...and ${result.missing.length - 50} more` : "";
  const body = [`${result.missing.length} repo asset file(s) are MISSING from the bank catalog (owner would be blind to them):`, ...lines, overflow]
    .filter(Boolean)
    .join("\n");
  if (warnOnly) {
    console.warn(`WARNING: ${label}\n${body}\n(warn-only: not failing the build yet — will block after one green week, same as zone:lint)`);
    return;
  }
  console.error(`${label}\n${body}\nFix: start/reload the Asset Bank so it rescans (POST :8765/api/catalog/rescan), or run pnpm intake.`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

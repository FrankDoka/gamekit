import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assetsMetadataRoot } from "./toolkit-config.js";
import { repoCategory, repoRootFromModule } from "./bank-repo-roots.js";

/**
 * bank:audit — the permanent bank-hygiene gate.
 *
 * Where bank:coverage guards the OTHER direction (every repo file has a catalog row), bank:audit
 * guards the catalog's own internal health: no mystery `unknown` categories, no duplicate ids,
 * category consistent with path conventions, repo rows carry a matching `origin:*` tag, and review
 * rows join to catalog rows. It reads the SAME JSON snapshots the bank server writes
 * (`asset-review-data.json` + `asset-review-status.json`) — it never talks to :8765, so it is safe
 * to run in CI and against a scratch copy of the real stores.
 *
 * It fails closed (exit 1) so a hygiene regression is a red signal, with `--warn-only` for the
 * warning-first validate ramp (same pattern as zone:lint / bank:coverage). `--fix` applies the
 * SAFE, mechanical remediations via the bank's own path-convention module (never a guess): it
 * re-categorizes path-derivable `unknown` rows, adds the missing `origin:*` tag to repo rows, and
 * ARCHIVES (never deletes) orphan review rows to a dated sidecar. Ambiguous rows are LISTED for the
 * integrator, never mutated.
 *
 * Flags:
 *   --fix                apply safe auto-fixes in place (writes data + status; sidecars orphans)
 *   --warn-only          report but exit 0 (validate wiring, warning-first)
 *   --json               print the verdict as JSON (machine-readable) instead of the human report
 *   --metadata-root <p>  metadata root (default Z:/Assets-metadata); reads <root>/_review/*.json
 *   --data <file>        explicit catalog snapshot path (overrides --metadata-root)
 *   --status <file>      explicit review-status snapshot path (overrides --metadata-root)
 *   --repo-root <p>      repo worktree root (default: this module's worktree)
 *   --selftest           run the built-in red/green self-test and exit
 */

type AssetRecord = {
  id?: string;
  path?: string;
  category?: string;
  kind?: string;
  origin?: string;
  tags?: string[];
  [key: string]: unknown;
};
type ReviewRecord = { id?: string; path?: string; [key: string]: unknown };
type Catalog = { assets?: AssetRecord[]; [key: string]: unknown };
type Status = { reviews?: ReviewRecord[]; [key: string]: unknown };

/**
 * Documented allowlist: legacy `Z:/Assets`-origin rows that are GENUINELY category-less and must
 * not trip the unknown-category rule. These are branding PNGs, docs, excluded raw source video, and
 * the zone-loading-art batch — none are miscategorized deliverables (integrator ruling, s21
 * card-bank-repo-roots closeout). Matched as path prefixes on a bank-origin row. Extend this list
 * (with a reason) rather than weakening the rule.
 */
export const UNKNOWN_CATEGORY_ALLOWLIST: ReadonlyArray<{ prefix: string; reason: string }> = [
  { prefix: "_devkit/", reason: "devkit docs, not a visual asset" },
  { prefix: "_incoming-unsorted/discord-branding-", reason: "discord branding, not game content" },
  { prefix: "_incoming-unsorted/p-anim-raw-video-excluded-", reason: "excluded raw source video" },
  { prefix: "generated/imagegen-zone-loading-art-", reason: "zone loading art + manifests, category-less batch" },
];

function isAllowlistedUnknown(asset: AssetRecord): boolean {
  const origin = asset.origin ?? "bank";
  if (origin !== "bank") return false;
  const rel = String(asset.path ?? "").replaceAll("\\", "/");
  return UNKNOWN_CATEGORY_ALLOWLIST.some((entry) => rel.startsWith(entry.prefix));
}

/** A `.md`/`.json`/`.txt` note is legitimately category-less (it is a document, not an asset). */
function isDocumentRow(asset: AssetRecord): boolean {
  if (asset.kind === "document") return true;
  const ext = path.extname(String(asset.path ?? "")).toLowerCase();
  return [".md", ".json", ".txt"].includes(ext);
}

/** The `origin:*` tag a repo row must carry so the UI/guards/gates can tell it apart. */
function expectedOriginTag(origin: string | undefined): string | undefined {
  if (origin === "repo-runtime") return "origin:repo-runtime";
  if (origin === "repo-source") return "origin:repo-source";
  return undefined;
}

/** Category the path conventions expect for a row (used by both the audit rule and --fix). */
function derivedCategory(asset: AssetRecord): string | undefined {
  const rel = String(asset.path ?? "").replaceAll("\\", "/");
  if (rel.startsWith("repo-source/")) return repoCategory("repo-source", rel.slice("repo-source/".length));
  if (rel.startsWith("runtime-only/")) return repoCategory("repo-runtime", rel.slice("runtime-only/".length));
  return undefined; // bank-origin rows use the server's detectCategory; audit only spot-checks them (see rule below)
}

export type AuditFinding = { rule: string; id: string; path: string; detail: string; fixable: boolean };
export type AuditVerdict = {
  ok: boolean;
  counts: { assets: number; reviews: number };
  findings: AuditFinding[];
  byRule: Record<string, number>;
};

const RULES = {
  unknownCategory: "unknown-category",
  duplicateId: "duplicate-id",
  categoryPathMismatch: "category-path-mismatch",
  missingOriginTag: "missing-origin-tag",
  orphanReview: "orphan-review",
  missingFile: "missing-file",
} as const;

/**
 * Audit a catalog + review snapshot. `repoRoot` is used to resolve repo-origin row files for the
 * missing-file rule; pass undefined to skip that rule (e.g. when the tree isn't present).
 */
export function auditBank(catalog: Catalog, status: Status, repoRoot?: string): AuditVerdict {
  const assets = (catalog.assets ?? []).filter((a): a is AssetRecord => a !== null && typeof a === "object");
  const reviews = (status.reviews ?? []).filter((r): r is ReviewRecord => r !== null && typeof r === "object");
  const findings: AuditFinding[] = [];
  const add = (rule: string, asset: AssetRecord, detail: string, fixable: boolean) =>
    findings.push({ rule, id: String(asset.id ?? "(no-id)"), path: String(asset.path ?? ""), detail, fixable });

  // Rule: no unknown-category rows (except the documented allowlist + document notes).
  for (const asset of assets) {
    if ((asset.category ?? "unknown") !== "unknown") continue;
    if (isAllowlistedUnknown(asset) || isDocumentRow(asset)) continue;
    const derived = derivedCategory(asset);
    add(RULES.unknownCategory, asset, derived ? `path implies category "${derived}"` : "no category and none derivable from path", Boolean(derived));
  }

  // Rule: category consistent with path conventions (spot rules for repo rows + /audio/).
  for (const asset of assets) {
    const cat = asset.category ?? "unknown";
    if (cat === "unknown") continue; // handled by the unknown-category rule
    const rel = String(asset.path ?? "").replaceAll("\\", "/").toLowerCase();
    // Spot rule: anything under an /audio/ segment (or an audio ext) must be category audio.
    const isAudio = [".mp3", ".wav", ".ogg"].includes(path.extname(rel)) || rel.split("/").includes("audio");
    if (isAudio && cat !== "audio") {
      add(RULES.categoryPathMismatch, asset, `path is audio but category is "${cat}"`, true);
      continue;
    }
    // Spot rule: repo rows must match their path-derived category.
    const derived = derivedCategory(asset);
    if (derived && derived !== "unknown" && derived !== cat) {
      add(RULES.categoryPathMismatch, asset, `path implies "${derived}" but category is "${cat}"`, true);
    }
  }

  // Rule: no duplicate ids.
  const seen = new Map<string, number>();
  for (const asset of assets) {
    const id = typeof asset.id === "string" ? asset.id : "";
    if (!id) continue;
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  for (const asset of assets) {
    const id = typeof asset.id === "string" ? asset.id : "";
    if (id && (seen.get(id) ?? 0) > 1) add(RULES.duplicateId, asset, `id appears ${seen.get(id)}× in the catalog`, false);
  }
  // de-dupe the duplicate-id findings to one per id (report each colliding id once)
  {
    const reported = new Set<string>();
    for (let i = findings.length - 1; i >= 0; i--) {
      if (findings[i].rule !== RULES.duplicateId) continue;
      if (reported.has(findings[i].id)) findings.splice(i, 1);
      else reported.add(findings[i].id);
    }
  }

  // Rule: repo-origin rows carry the matching `origin:*` tag.
  for (const asset of assets) {
    const want = expectedOriginTag(asset.origin);
    if (!want) continue;
    const tags = Array.isArray(asset.tags) ? asset.tags.map(String) : [];
    if (!tags.includes(want)) add(RULES.missingOriginTag, asset, `${asset.origin} row missing tag "${want}"`, true);
  }

  // Rule: review rows join to a catalog row (orphans listed, archived by --fix, never deleted).
  const assetIds = new Set(assets.map((a) => a.id).filter((id): id is string => typeof id === "string"));
  for (const review of reviews) {
    const id = typeof review.id === "string" ? review.id : "";
    if (!id || assetIds.has(id)) continue;
    findings.push({ rule: RULES.orphanReview, id, path: String(review.path ?? ""), detail: "review row has no matching catalog asset", fixable: true });
  }

  // Rule: every catalog row's file exists on disk (origin-aware resolution).
  if (repoRoot) {
    for (const asset of assets) {
      const resolved = resolveAssetFile(asset, repoRoot);
      if (resolved === undefined) continue; // unresolvable path shape (e.g. bank rows without an assets root here) — skip, coverage/health own that
      if (!existsSync(resolved)) add(RULES.missingFile, asset, `backing file missing on disk (${resolved})`, false);
    }
  }

  const byRule: Record<string, number> = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  return { ok: findings.length === 0, counts: { assets: assets.length, reviews: reviews.length }, findings, byRule };
}

/**
 * Resolve a catalog row's backing file for the missing-file rule. Only repo-origin rows are
 * resolvable from a repoRoot alone; bank-origin rows live under Z:/Assets (not necessarily present
 * in a scratch/CI checkout) so we return undefined for them (their coverage is health's job).
 */
function resolveAssetFile(asset: AssetRecord, repoRoot: string): string | undefined {
  const rel = String(asset.path ?? "").replaceAll("\\", "/");
  if (rel.startsWith("runtime-only/")) return path.resolve(repoRoot, "client", "public", "assets", rel.slice("runtime-only/".length));
  if (rel.startsWith("repo-source/")) return path.resolve(repoRoot, "assets", "sources", "accepted", rel.slice("repo-source/".length));
  return undefined;
}

export type FixResult = {
  categorized: Array<{ id: string; from: string; to: string; path: string }>;
  taggedOrigin: Array<{ id: string; tag: string }>;
  archivedOrphans: string[];
  listedForIntegrator: AuditFinding[];
  sidecar?: string;
};

/**
 * Apply the SAFE, mechanical fixes to the in-memory catalog + status. Returns what changed and what
 * was LEFT for the integrator (unfixable findings: duplicate ids, missing files, underivable
 * unknowns). Never guesses a category — only path-derivable ones are re-categorized.
 */
export function applyFixes(catalog: Catalog, status: Status, repoRoot?: string): FixResult {
  const assets = (catalog.assets ?? []).filter((a): a is AssetRecord => a !== null && typeof a === "object");
  const result: FixResult = { categorized: [], taggedOrigin: [], archivedOrphans: [], listedForIntegrator: [] };

  for (const asset of assets) {
    // Re-categorize path-derivable unknowns (and path-mismatched repo rows) from conventions.
    const cat = asset.category ?? "unknown";
    if (cat === "unknown" && !isAllowlistedUnknown(asset) && !isDocumentRow(asset)) {
      const derived = derivedCategory(asset);
      if (derived && derived !== "unknown") {
        result.categorized.push({ id: String(asset.id ?? ""), from: cat, to: derived, path: String(asset.path ?? "") });
        asset.category = derived;
      }
    }
    // Add the missing origin:* tag to repo rows.
    const want = expectedOriginTag(asset.origin);
    if (want) {
      const tags = Array.isArray(asset.tags) ? asset.tags.map(String) : [];
      if (!tags.includes(want)) {
        tags.push(want);
        asset.tags = tags;
        result.taggedOrigin.push({ id: String(asset.id ?? ""), tag: want });
      }
    }
  }

  // Archive (do NOT delete) orphan review rows: move them out of status.reviews into a sidecar list.
  const assetIds = new Set(assets.map((a) => a.id).filter((id): id is string => typeof id === "string"));
  const reviews = (status.reviews ?? []).filter((r): r is ReviewRecord => r !== null && typeof r === "object");
  const kept: ReviewRecord[] = [];
  const orphans: ReviewRecord[] = [];
  for (const review of reviews) {
    const id = typeof review.id === "string" ? review.id : "";
    if (id && !assetIds.has(id)) orphans.push(review);
    else kept.push(review);
  }
  if (orphans.length) {
    status.reviews = kept;
    result.archivedOrphans = orphans.map((r) => String(r.id));
    (result as FixResult & { _orphanRows?: ReviewRecord[] })._orphanRows = orphans;
  }

  // Everything the audit still flags after fixes is what the integrator must resolve by hand.
  result.listedForIntegrator = auditBank(catalog, status, repoRoot).findings;
  return result;
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

/** Atomic-ish write mirroring the bank's own .prev rotation so --fix respects single-writer stores. */
async function writeJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  if (existsSync(filePath)) await copyFile(filePath, `${filePath}.prev`).catch(() => undefined);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, filePath);
}

function reportVerdict(verdict: AuditVerdict, label: string): string {
  const ruleLines = Object.entries(verdict.byRule)
    .sort((a, b) => b[1] - a[1])
    .map(([rule, n]) => `  ${rule}: ${n}`);
  const examples = verdict.findings.slice(0, 30).map((f) => `    [${f.rule}] ${f.id} ${f.path} — ${f.detail}`);
  const overflow = verdict.findings.length > 30 ? `    ...and ${verdict.findings.length - 30} more` : "";
  return [
    label,
    ...(ruleLines.length ? ["by rule:", ...ruleLines, "findings:", ...examples, overflow] : ["  no findings — catalog is clean"]),
  ]
    .filter(Boolean)
    .join("\n");
}

async function selftest(): Promise<void> {
  const os = await import("node:os");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const tmp = await mkdtemp(path.join(os.tmpdir(), "bank-audit-selftest-"));
  try {
    // GREEN fixture: one clean bank row, one clean repo row, one allowlisted unknown, one doc note.
    const green: Catalog = {
      assets: [
        { id: "monsters_slime", path: "characters/monsters/slime.png", category: "monsters", origin: "bank", tags: ["ext:png"] },
        { id: "src_slime_idle", path: "repo-source/monster_x/idle/slime_idle.png", category: "monsters", origin: "repo-source", tags: ["ext:png", "origin:repo-source"] },
        { id: "brand", path: "_incoming-unsorted/discord-branding-20260702/icon.png", category: "unknown", origin: "bank", tags: [] },
        { id: "note", path: "repo-source/pkg/notes/recipe.md", category: "unknown", kind: "document", origin: "repo-source", tags: ["origin:repo-source"] },
      ],
    };
    const greenStatus: Status = { reviews: [{ id: "monsters_slime", decision: "accepted" }] };
    const gv = auditBank(green, greenStatus);
    if (!gv.ok) throw new Error(`selftest GREEN failed — expected clean, got: ${JSON.stringify(gv.byRule)}`);

    // RED fixture: one of every violation.
    const red: Catalog = {
      assets: [
        { id: "dup", path: "a.png", category: "props", origin: "bank", tags: [] },
        { id: "dup", path: "b.png", category: "props", origin: "bank", tags: [] }, // duplicate-id
        { id: "harbor_prop", path: "repo-source/r1_harbor_vibrancy_pilot_20260702/final/props/anchor.png", category: "unknown", origin: "repo-source", tags: ["origin:repo-source"] }, // unknown, derivable
        { id: "mystery", path: "weird/thing.png", category: "unknown", origin: "bank", tags: [] }, // unknown, NOT derivable
        { id: "audio_miscat", path: "audio/sfx/hit.mp3", category: "vfx", origin: "bank", tags: [] }, // category-path-mismatch (audio)
        { id: "runtime_untagged", path: "runtime-only/sprites/npc_x.png", category: "npcs", origin: "repo-runtime", tags: ["runtime-only-source"] }, // missing-origin-tag
      ],
    };
    const redStatus: Status = { reviews: [{ id: "ghost", decision: "accepted" }] }; // orphan-review
    const rv = auditBank(red, redStatus);
    const need = ["duplicate-id", "unknown-category", "category-path-mismatch", "missing-origin-tag", "orphan-review"];
    for (const rule of need) if (!rv.byRule[rule]) throw new Error(`selftest RED failed — rule "${rule}" did not fire: ${JSON.stringify(rv.byRule)}`);
    // exactly one duplicate-id finding despite two rows sharing the id
    if (rv.byRule["duplicate-id"] !== 1) throw new Error(`selftest RED: expected 1 duplicate-id finding, got ${rv.byRule["duplicate-id"]}`);
    // "mystery" is unfixable; "harbor_prop" is fixable
    if (!rv.findings.some((f) => f.id === "mystery" && f.rule === "unknown-category" && !f.fixable)) throw new Error("selftest RED: mystery should be an unfixable unknown");
    if (!rv.findings.some((f) => f.id === "harbor_prop" && f.rule === "unknown-category" && f.fixable)) throw new Error("selftest RED: harbor_prop should be a fixable unknown");

    // --fix on the RED fixture: derivable unknown → categorized, origin tag added, orphan archived.
    const fx = applyFixes(red, redStatus);
    if (!fx.categorized.some((c) => c.id === "harbor_prop" && c.to === "props")) throw new Error("selftest FIX: harbor_prop not categorized to props");
    if (!fx.taggedOrigin.some((t) => t.id === "runtime_untagged")) throw new Error("selftest FIX: runtime_untagged not tagged");
    if (!fx.archivedOrphans.includes("ghost")) throw new Error("selftest FIX: orphan 'ghost' not archived");
    if (redStatus.reviews?.some((r) => r.id === "ghost")) throw new Error("selftest FIX: orphan 'ghost' still present in reviews (should be archived out)");
    // after fix, remaining findings are ONLY the genuinely unfixable ones (dup-id + underivable unknown)
    const remainingRules = new Set(fx.listedForIntegrator.map((f) => f.rule));
    if (remainingRules.has("missing-origin-tag") || remainingRules.has("orphan-review")) throw new Error("selftest FIX: a fixable rule survived --fix");
    if (!remainingRules.has("duplicate-id") || !remainingRules.has("unknown-category")) throw new Error("selftest FIX: expected dup-id + underivable-unknown to remain for the integrator");

    console.log("bank:audit selftest passed (green clean; red fires all 5 catalog rules + orphan; --fix categorizes/tags/archives and leaves only the unfixable for the integrator).");
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
  const asJson = args.includes("--json");
  const fix = args.includes("--fix");
  const repoRoot = path.resolve(argValue(args, "--repo-root") ?? repoRootFromModule());
  const metadataRoot = path.resolve(argValue(args, "--metadata-root") ?? assetsMetadataRoot());
  const dataPath = argValue(args, "--data") ?? path.join(metadataRoot, "_review", "asset-review-data.json");
  const statusPath = argValue(args, "--status") ?? path.join(metadataRoot, "_review", "asset-review-status.json");

  if (!existsSync(dataPath)) {
    const msg = `bank:audit: catalog snapshot not found at ${dataPath} — is the metadata root correct?`;
    if (warnOnly) {
      console.warn(`WARNING: ${msg}`);
      return;
    }
    console.error(msg);
    process.exitCode = 1;
    return;
  }

  const catalog = await readJson<Catalog>(dataPath, { assets: [] });
  const status = await readJson<Status>(statusPath, { reviews: [] });

  const repoRootForFileCheck = existsSync(path.join(repoRoot, "client", "public", "assets")) ? repoRoot : undefined;
  if (fix) {
    const fixResult = applyFixes(catalog, status, repoRootForFileCheck);
    if (fixResult.archivedOrphans.length) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/T/, "-").slice(0, 19);
      const sidecar = path.join(path.dirname(statusPath), `orphan-reviews-archived-${stamp}.json`);
      const orphanRows = (fixResult as FixResult & { _orphanRows?: ReviewRecord[] })._orphanRows ?? [];
      await writeJson(sidecar, { archived_at: new Date().toISOString(), reason: "bank:audit --fix: review rows with no matching catalog asset (report-don't-delete)", reviews: orphanRows });
      (status as Status & { generated_at?: string }).generated_at = new Date().toISOString().replace(/\.\d{3}Z$/, "");
      await writeJson(statusPath, status);
      fixResult.sidecar = sidecar;
    }
    if (fixResult.categorized.length || fixResult.taggedOrigin.length) {
      (catalog as Catalog & { generated_at?: string }).generated_at = new Date().toISOString().replace(/\.\d{3}Z$/, "");
      await writeJson(dataPath, catalog);
    }
    const summary = {
      categorized: fixResult.categorized.length,
      taggedOrigin: fixResult.taggedOrigin.length,
      archivedOrphans: fixResult.archivedOrphans.length,
      sidecar: fixResult.sidecar,
      listedForIntegrator: fixResult.listedForIntegrator.length,
    };
    if (asJson) {
      console.log(JSON.stringify({ ok: true, fix: summary, listed: fixResult.listedForIntegrator }, null, 2));
    } else {
      console.log(
        [
          `bank:audit --fix applied (${dataPath}):`,
          `  re-categorized: ${summary.categorized}`,
          `  origin:* tags added: ${summary.taggedOrigin}`,
          `  orphan reviews archived: ${summary.archivedOrphans}${fixResult.sidecar ? ` → ${path.basename(fixResult.sidecar)}` : ""}`,
          `  LEFT for the integrator (ambiguous, never guessed): ${summary.listedForIntegrator}`,
          ...fixResult.listedForIntegrator.slice(0, 30).map((f) => `    [${f.rule}] ${f.id} ${f.path} — ${f.detail}`),
          fixResult.listedForIntegrator.length > 30 ? `    ...and ${fixResult.listedForIntegrator.length - 30} more` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    return;
  }

  const verdict = auditBank(catalog, status, repoRootForFileCheck);
  const label = `bank:audit: ${verdict.counts.assets} catalog rows, ${verdict.counts.reviews} reviews, ${verdict.findings.length} hygiene finding(s) (${dataPath})`;

  if (asJson) {
    console.log(JSON.stringify(verdict, null, 2));
    if (!verdict.ok && !warnOnly) process.exitCode = 1;
    return;
  }

  if (verdict.ok) {
    console.log(`${label} — OK`);
    return;
  }
  const body = reportVerdict(verdict, label);
  if (warnOnly) {
    console.warn(`WARNING: ${body}\n(warn-only: not failing the build yet — will block after one green week, same ramp as zone:lint/bank:coverage)\nFix: run pnpm bank:audit --fix (safe auto-fixes), then re-run.`);
    return;
  }
  console.error(`${body}\nFix: run pnpm bank:audit --fix for the safe auto-fixes; resolve any LEFT-for-integrator rows by hand.`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

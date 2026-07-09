/**
 * Animation-validator fail-closed gate (card-anim-validators, 2026-07-07).
 *
 * When a staged diff adds/modifies an animation sheet under
 * assets/sources/accepted or client/public/assets/sprites, intake refuses to
 * commit unless ALL FOUR validator artifacts are staged alongside it:
 *
 *   <stem>.motion-arc-verdict.json        (recipes.py motion-arc, result PASS)
 *   <stem>.identity-palette-verdict.json  (recipes.py identity-palette, result PASS)
 *   <stem>.opaque-ring-verdict.json       (fringe.py opaque-magenta-ring, result PASS)
 *   <stem>.panel.png                      (anim_panel.py native-scale acceptance panel)
 *
 * where <stem> is the sheet path minus its final extension (X.clean.png ->
 * X.clean.*, Y.webp -> Y.*) - exactly the defaults those tools write.
 *
 * The panel is NOT optional: motion-arc/identity-palette catch
 * duplicate-tiling, flat motion, and costume drift only; geometric
 * incoherence (plank-rotation deaths, anatomy garble) is owned by the panel
 * + adversary/owner eyes-on layer (integrator ruling 2026-07-07 - see the
 * ANIMATION-VALIDATOR DOCTRINE block in tools/asset-cleanup/recipes.py).
 *
 * The opaque-ring verdict (card-anim-opaque-ring-wiring, 2026-07-07) is the
 * FOURTH artifact: it catches the video-keying failure where a despill ring
 * hardened to full opacity survives as a hard magenta outline that the
 * semi-transparent halo checks are blind to. Its foreign-hue calibration
 * spares legitimately-pink subjects (see fringe.py opaque_magenta_ring).
 *
 * Loud escape hatch: GAMEKIT_ANIM_VALIDATORS_SKIP=1 (handled by the caller).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type AnimGateFinding = {
  sheet: string;
  artifact: string;
  problem: "not staged" | "missing on disk" | "verdict not PASS" | "unreadable verdict";
};

export type AnimGateResult = {
  sheets: string[];
  findings: AnimGateFinding[];
  ok: boolean;
};

const SHEET_ROOTS = /^(assets\/sources\/accepted|client\/public\/assets\/sprites)\//i;
const SHEET_EXT = /\.(png|webp)$/i;
// Files that live next to sheets but are never the sheet itself. "panel" also
// keeps the gate from demanding artifacts-for-the-artifact.
const NON_SHEET = /(panel|preview|audit|contact|anchor|thumb|icon|portrait|raw|swatch|board|grid|recovered|reference|mask|overlay)/i;
// Motion vocabulary actually used by the pipeline (slate.ts states + phase-3 set).
const ANIM_TOKEN =
  /(^|[_-])(idle|walk|run|attack|gather|sit|hurt|death|die|block|brace|swing|stab|heavy|cast|jump|roll|dash|dodge|cheer|emote|spin|charge)([_-]|\.|\d|$)/i;

export function normalizeRepoPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function isAnimationSheet(path: string): boolean {
  const p = normalizeRepoPath(path);
  if (!SHEET_ROOTS.test(p)) return false;
  if (!SHEET_EXT.test(p)) return false;
  // qa/, reports/, preview/ dirs hold proof/comparison images by pipeline
  // convention, never runtime sheets (first bite: lr3's
  // qa/idle-vs-gather-same-framing-pair.png flagged as a sheet, 2026-07-07).
  if (/\/(qa|reports|preview)\//i.test(p)) return false;
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (/\.clean\.png$/i.test(base)) return true;
  if (NON_SHEET.test(base)) return false;
  return ANIM_TOKEN.test(base);
}

export function requiredArtifactsFor(sheetPath: string): {
  motionArc: string;
  identityPalette: string;
  opaqueRing: string;
  panel: string;
} {
  const stem = normalizeRepoPath(sheetPath).replace(SHEET_EXT, "");
  return {
    motionArc: `${stem}.motion-arc-verdict.json`,
    identityPalette: `${stem}.identity-palette-verdict.json`,
    opaqueRing: `${stem}.opaque-ring-verdict.json`,
    panel: `${stem}.panel.png`,
  };
}

function verdictProblem(worktree: string, artifact: string): AnimGateFinding["problem"] | null {
  const onDisk = join(worktree, artifact);
  if (!existsSync(onDisk)) return "missing on disk";
  try {
    const parsed = JSON.parse(readFileSync(onDisk, "utf8")) as { result?: unknown };
    return parsed.result === "PASS" ? null : "verdict not PASS";
  } catch {
    return "unreadable verdict";
  }
}

/**
 * Evaluate the staged file list. Verdict artifacts must be staged AND parse
 * with result === "PASS"; the panel must be staged AND exist on disk.
 */
export function evaluateAnimValidatorArtifacts(worktree: string, stagedPaths: string[]): AnimGateResult {
  const staged = new Set(stagedPaths.map((p) => normalizeRepoPath(p).toLowerCase()));
  const sheets = stagedPaths.map(normalizeRepoPath).filter(isAnimationSheet);
  const findings: AnimGateFinding[] = [];
  for (const sheet of sheets) {
    const artifacts = requiredArtifactsFor(sheet);
    for (const [kind, artifact] of Object.entries(artifacts) as [keyof typeof artifacts, string][]) {
      if (!staged.has(artifact.toLowerCase())) {
        findings.push({ sheet, artifact, problem: "not staged" });
        continue;
      }
      if (kind === "panel") {
        if (!existsSync(join(worktree, artifact))) findings.push({ sheet, artifact, problem: "missing on disk" });
        continue;
      }
      const problem = verdictProblem(worktree, artifact);
      if (problem) findings.push({ sheet, artifact, problem });
    }
  }
  return { sheets, findings, ok: findings.length === 0 };
}

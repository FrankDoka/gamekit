import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

export type LaneClass = "code" | "client" | "content" | "art" | "tooling";

export type SourceSection = {
  file: string;
  heading: string;
  text: string;
  hash: string;
};

export type LaneDigest = {
  laneClass: LaneClass;
  ambiguousClass: boolean;
  text: string;
  byteSize: number;
  replacedDocsByteSize: number;
  replacedDocs: string[];
};

type GenerateDigestOptions = {
  root: string;
  cardPathAbs: string;
};

const SOURCE_FILES = ["AGENTS.md", "docs/state/session-brief.md", "docs/architecture/ai-architecture.md"] as const;

const CLASS_DEFAULTS: Record<LaneClass, string[]> = {
  code: [
    "`pnpm -r typecheck`",
    "`pnpm validate`",
    "add focused tests for touched behavior",
  ],
  client: [
    "`pnpm -r typecheck`",
    "`pnpm validate`",
    "Phaser 4 skill must be cited before client/editor/runtime work",
    "`pnpm capture:zone <outDir>` with PNG inspection for visual/editor/runtime changes",
  ],
  content: [
    "`pnpm validate`",
    "manifest/ID/reference integrity",
    "schema can express the requested content shape before claiming no schema work",
  ],
  art: [
    "`pnpm validate`",
    "asset defect gates",
    "pixel-level measurements before defect claims",
    "in-engine capture for runtime visual changes",
  ],
  tooling: [
    "`pnpm -r typecheck`",
    "`pnpm validate`",
    "unit tests for tool behavior and failure modes",
    "dry-run/proof output for lane automation changes",
  ],
};

type Classification = {
  laneClass: LaneClass;
  ambiguous: boolean;
};

function repoPath(root: string, file: string): string {
  return join(root, file).replace(/\\/g, "/");
}

function normalizeRoot(root: string): string {
  return root.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function sha(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

export function gitHead(root: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "no-git";
  }
}

// ---- Single source of truth for the anchors generateLaneDigest depends on ----
// generateLaneDigest reads its source sections and rule bullets THROUGH these tables
// (see `readAnchoredSections` below), and verifyDigestAnchors re-exercises the SAME
// tables read-only. Adding/removing an anchor the digest reads means editing here once,
// so the spawn-time reads and the validate-time check can never drift apart.
//
// `key` is the internal handle generateLaneDigest uses; `bullets` are the rule-line
// regexes bullet() must find inside that section for the digest to build.
type AnchorSpec = {
  key: string;
  file: string;
  heading: string;
  bullets: RegExp[];
};

const SECTION_ANCHORS: AnchorSpec[] = [
  { key: "mandatory", file: "AGENTS.md", heading: "## Mandatory Checks", bullets: [/Before editing ANY file/, /Edit-target hard stop/, /Quantify before diagnosing/] },
  { key: "modes", file: "AGENTS.md", heading: "## Working Modes", bullets: [/Build \|/] },
  { key: "gates", file: "AGENTS.md", heading: "## Gates Before MVP-0", bullets: [/Validation passes/] },
  { key: "change", file: "AGENTS.md", heading: "## Change Discipline", bullets: [/Preserve/] },
  { key: "git", file: "AGENTS.md", heading: "## Git", bullets: [/For any commit/] },
  { key: "brief", file: "docs/state/session-brief.md", heading: "## Current Snapshot", bullets: [/Normal gate:/] },
  { key: "cardContract", file: "docs/architecture/ai-architecture.md", heading: "2. **Card contract.**", bullets: [] },
  {
    key: "token",
    file: "docs/architecture/ai-architecture.md",
    heading: "## Token Discipline & Return Contracts",
    bullets: [/grep before read, read ranges/, /Documentation duty travels with the change/, /Build report/],
  },
];

// Conditional: the animation/art funnel anchor is only read for art-class or
// animation-touching cards. Its heading + bullets live here so verify can exercise
// them just like the digest does (verify always checks it — the funnel laws must exist
// whether or not the current card happens to be an art card).
const FUNNEL_ANCHOR: AnchorSpec = {
  key: "funnel",
  file: "docs/pipelines/animation.md",
  heading: "### The funnel (video route), in order — every step is executable",
  bullets: [/This list is EXHAUSTIVE/, /Chroma law:/, /A speckle COUNT alone/, /canon torso close-up/],
};

export function readSection(root: string, file: string, heading: string): SourceSection {
  const text = readFileSync(repoPath(root, file), "utf8");
  const lines = text.split(/\r?\n/);
  const isMarkdownHeading = heading.startsWith("#");
  const start = lines.findIndex((line) => {
    const trimmed = line.trim();
    return isMarkdownHeading ? trimmed === heading : trimmed.startsWith(heading);
  });
  if (start === -1) {
    throw new Error(`[lane-digest] source anchor missing: ${file} :: ${heading}`);
  }
  const level = heading.match(/^#+/)?.[0].length ?? 0;
  const out = [lines[start]];
  if (level === 0) {
    const sectionText = out.join("\n").trim();
    return { file, heading, text: sectionText, hash: sha(sectionText) };
  }
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const nextLevel = line.match(/^(#+)\s/)?.[1].length ?? 0;
    if (nextLevel > 0 && nextLevel <= level) break;
    out.push(line);
  }
  const sectionText = out.join("\n").trim();
  return { file, heading, text: sectionText, hash: sha(sectionText) };
}

function bullet(section: SourceSection, pattern: RegExp): string {
  const lines = section.text.split(/\r?\n/);
  const start = lines.findIndex((candidate) => pattern.test(candidate));
  if (start === -1) {
    throw new Error(`[lane-digest] rule pattern missing in ${section.file} :: ${section.heading}: ${pattern}`);
  }
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const next = lines[i];
    if (!next.trim()) break;
    if (/^\s*[-*]\s+/.test(next) || /^#+\s/.test(next) || /^\|/.test(next) || /^\s*\d+\.\s/.test(next)) break;
    // A bolded law/rule marker starts a new extractable unit — stop the previous one
    // (funnel step text chains several **Law:** blocks inside one numbered item).
    if (/^\s*\*\*[A-Z]/.test(next)) break;
    out.push(next);
  }
  return out
    .join(" ")
    .replace(/^\s*[-*]\s*/, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyFromHint(cardText: string): LaneClass | null {
  const match = cardText.match(/(?:^|\n)\s*class:\s*(code|client|content|art|tooling)\b/i);
  return match ? (match[1].toLowerCase() as LaneClass) : null;
}

function scopeText(cardText: string): string {
  const lines = cardText.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\*\*Scope\b.*\*\*/.test(line.trim()));
  if (start === -1) return "";
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (i > start && /^\*\*[A-Za-z]/.test(line.trim())) break;
    out.push(line);
  }
  return out.join("\n");
}

function pathWeights(text: string): Record<LaneClass, number> {
  const weights: Record<LaneClass, number> = { code: 0, client: 0, content: 0, art: 0, tooling: 0 };
  const matches = text.match(/[A-Za-z0-9_.@/-]+(?:\/|\*\*)[A-Za-z0-9_.@*/-]*|[A-Za-z][A-Za-z0-9]+\.ts/g) ?? [];
  for (const raw of matches) {
    const path = raw.toLowerCase().replace(/\\/g, "/").replace(/[*`),.;:]+$/g, "");
    if (path.startsWith("client/src/")) weights.client += 1;
    else if (/^(embeddededitor|editorinspectorschema|paneldom)/.test(path)) weights.client += 1;
    else if (path.startsWith("content/")) weights.content += 1;
    else if (path.startsWith("tools/") || path.startsWith(".githooks/")) weights.tooling += 1;
    else if (path.startsWith("server/src/") || path.startsWith("shared/src/")) weights.code += 1;
    else if (path.startsWith("client/public/assets/") || path.startsWith("assets/") || path.startsWith("reference/") || path.startsWith("z:/assets")) weights.art += 1;
  }
  return weights;
}

function dominantClass(weights: Record<LaneClass, number>): Classification | null {
  const entries = Object.entries(weights) as Array<[LaneClass, number]>;
  const max = Math.max(...entries.map(([, count]) => count));
  if (max === 0) return null;
  const winners = entries.filter(([, count]) => count === max).map(([laneClass]) => laneClass);
  return winners.length === 1 ? { laneClass: winners[0], ambiguous: false } : { laneClass: "code", ambiguous: true };
}

function classifyLaneCardDetailed(_cardPathAbs: string, cardText: string): Classification {
  const hinted = classifyFromHint(cardText);
  if (hinted) return { laneClass: hinted, ambiguous: false };
  const body = dominantClass(pathWeights(cardText));
  if (body && !body.ambiguous) return body;
  const scope = dominantClass(pathWeights(scopeText(cardText)));
  if (scope) return scope;
  return body ?? { laneClass: "code", ambiguous: true };
}

export function classifyLaneCard(cardPathAbs: string, cardText: string): LaneClass {
  return classifyLaneCardDetailed(cardPathAbs, cardText).laneClass;
}

function extractReadFirst(cardText: string): string | null {
  const match = cardText.match(/\*\*Read first:\*\*\s*([^\n]+)/i);
  return match ? match[1].trim() : null;
}

function extractCardGates(cardText: string): string[] {
  const lines = cardText.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\*\*Gates\b.*\*\*/.test(line.trim()));
  if (start === -1) return [];
  const gates: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\*\*[A-Za-z]/.test(line.trim())) break;
    const checkbox = line.match(/^\s*-\s*\[[ xX]\]\s*(.+)$/);
    if (checkbox) {
      const gateLines = [checkbox[1]];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (!next.trim()) break;
        if (/^\s*-\s*\[[ xX]\]\s*/.test(next) || /^\*\*[A-Za-z]/.test(next.trim())) break;
        gateLines.push(next);
        i = j;
      }
      gates.push(gateLines.join(" ").replace(/\s+/g, " ").trim());
    }
  }
  return gates;
}

function shortCardPath(root: string, cardPathAbs: string): string {
  const rel = relative(root, cardPathAbs).replace(/\\/g, "/");
  return rel.startsWith("..") ? cardPathAbs.replace(/\\/g, "/") : rel;
}

/**
 * Read-only pre-flight for every anchor generateLaneDigest depends on. Returns a list
 * of missing-anchor messages (empty === all anchors present); never throws for a missing
 * anchor and never writes. Wired into `pnpm validate` so a reworded anchored heading/bullet
 * fails PRE-COMMIT instead of only at the next lane spawn.
 *
 * It exercises the same SECTION_ANCHORS + FUNNEL_ANCHOR tables the digest reads, so the
 * two cannot drift. The funnel anchor is checked unconditionally: its laws must exist in
 * animation.md regardless of which card is being spawned.
 */
export function verifyDigestAnchors(root: string): string[] {
  const normalized = normalizeRoot(root);
  const missing: string[] = [];
  for (const spec of [...SECTION_ANCHORS, FUNNEL_ANCHOR]) {
    let section: SourceSection;
    try {
      section = readSection(normalized, spec.file, spec.heading);
    } catch (err) {
      missing.push(err instanceof Error ? err.message : String(err));
      continue; // can't check bullets in a section that isn't there
    }
    for (const pattern of spec.bullets) {
      try {
        bullet(section, pattern);
      } catch (err) {
        missing.push(err instanceof Error ? err.message : String(err));
      }
    }
  }
  return missing;
}

export function generateLaneDigest(options: GenerateDigestOptions): LaneDigest {
  const root = normalizeRoot(options.root);
  const cardText = readFileSync(options.cardPathAbs, "utf8");
  const classification = classifyLaneCardDetailed(options.cardPathAbs, cardText);
  const { laneClass } = classification;
  const head = gitHead(root);

  // Read the source sections through SECTION_ANCHORS so the digest and verifyDigestAnchors
  // share one anchor list (order/content of the reads is unchanged from the inline form).
  const sections: Record<string, SourceSection> = {};
  for (const spec of SECTION_ANCHORS) {
    sections[spec.key] = readSection(root, spec.file, spec.heading);
  }
  const { mandatory, modes, gates, change, git, brief, cardContract, token } = sections;

  // Animation/art hard laws ride the digest itself: the 2026-07-08 cast canary proved
  // card-cited read-first docs are not reliably absorbed by generation lanes (a Codex
  // lane invented a palette-quantization step and destroyed the sheet). Any card that
  // is art-class OR touches the animation pipeline gets the funnel laws inlined,
  // anchored to animation.md so digest generation FAILS CLOSED if the laws move.
  const animCard =
    laneClass === "art" ||
    /docs\/pipelines\/animation\.md|runtime sheet|sprite ?sheet|frames-qa|motion-arc|player_baldbase|seedance/i.test(cardText);
  const funnel = animCard ? readSection(root, FUNNEL_ANCHOR.file, FUNNEL_ANCHOR.heading) : null;

  const cardGates = extractCardGates(cardText);
  const readFirst = extractReadFirst(cardText);
  const headerClass = classification.ambiguous ? `${laneClass}; class: ambiguous` : laneClass;
  const digestLines = [
    `LANE BOOT DIGEST (${headerClass}; generated from ${head}; card ${shortCardPath(root, options.cardPathAbs)})`,
    `Provenance: AGENTS.md@${head}#${mandatory.hash}/${change.hash}/${git.hash}; session-brief.md@${head}#${brief.hash}; ai-architecture.md@${head}#${cardContract.hash}/${token.hash}`,
    "",
    "Boot:",
    `- Work only in the assigned worktree/branch; before edits confirm active sessions + worktree list, then pwd/branch/status/top-level. ${bullet(mandatory, /Before editing ANY file/)}`,
    `- ${bullet(mandatory, /Edit-target hard stop/)}`,
    `- ${bullet(mandatory, /Quantify before diagnosing/)}`,
    `- Current gate baseline: ${bullet(brief, /Normal gate:/)}`,
    "",
    "Scope:",
    `- Mode: ${laneClass === "content" || laneClass === "art" ? "Content" : "Build"}; ${bullet(modes, /Build \|/)}`,
    "- Inspect relevant code/docs/tests first; make the smallest correct scoped change.",
    `- Preserve other sessions' work. ${bullet(change, /Preserve/)}`,
    "- Keep docs/state aligned only when current-state or next-task facts change.",
    `- Worker token discipline: ${bullet(token, /grep before read, read ranges/)}`,
    `- ${bullet(token, /Documentation duty travels with the change/)}`,
    readFirst ? `- Card Read-first remains binding: ${readFirst}` : "- Card Read-first remains binding when present.",
    ...(funnel
      ? [
          "",
          `Animation/Art HARD LAWS (extracts; the canonical home docs/pipelines/animation.md@${head}#${funnel.hash} GOVERNS — read it before any frame/sheet work):`,
          `- ${bullet(funnel, /This list is EXHAUSTIVE/)}`,
          `- ${bullet(funnel, /Chroma law:/)}`,
          `- ${bullet(funnel, /A speckle COUNT alone/)}`,
          `- ${bullet(funnel, /canon torso close-up/)}`,
          "- Metrics are pre-filters, never acceptance: per-frame native-scale eyes (integrator+owner) are the acceptance authority; neutral observations only, no verdict words about visual results.",
        ]
      : []),
    "",
    "Gates:",
    `- Class defaults: ${CLASS_DEFAULTS[laneClass].join("; ")}.`,
    ...(cardGates.length ? cardGates.slice(0, 5).map((gate) => `- Card gate: ${gate}`) : ["- Card gate: read the card's **Gates** block directly."]),
    `- Done requires validation or an explicit blocked reason. ${bullet(gates, /Validation passes/)}`,
    "",
    "Closeout:",
    `- Use the card's boxes/contract only; ${bullet(token, /Build report/)}`,
    `- At READY: rebase onto master, green gates, STOP; integrator merges. ${cardContract.file}: ${cardContract.hash}`,
    "- At gates-green: attempt `git commit`; on an index.lock permission failure (known structural — docs/tasks/notes-p0-failure-signatures.md §1) fall back to `git add -A` + write the FULL commit message to `.commit-msg.txt` in the worktree root and STOP. Either state is READY; the integrator completes via `pnpm intake`.",
    `- ${bullet(git, /For any commit/)}`,
    "- Closeout is BOTH: your FINAL MESSAGE (box-by-box, file:line citations, executive summary first) AND a `## Closeout` section with checked `- [x]` boxes APPENDED TO THE CARD FILE in your worktree (the card is always checked out there; `pnpm intake` FAILS CLOSED if the branch card lacks a checked closeout — 2 lanes bounced on this 2026-07-07). If you already committed, amend or add a follow-up commit with the card append. PROOF ARTIFACTS: run the card's Proof-leg command into the EXACT output dir it names and cite that path VERBATIM on ONE line (never wrap a path mid-filename; never substitute your own dir) — the intake artifact checker fails closed on both (2 lanes bounced 2026-07-07). Never edit the docs/state HOT-STATE files (handoff.md, session-brief.md, active-sessions.md, decisions.md, project-memory.md — integrator-only); a minimal docs/state/context-loading-map.md ROUTING line is allowed when your card's docs-duty gate names it.",
    "- If blocked, state the blocking question and stop.",
  ];

  const text = digestLines.join("\n");
  return {
    laneClass,
    ambiguousClass: classification.ambiguous,
    text,
    byteSize: Buffer.byteLength(text, "utf8"),
    replacedDocsByteSize: SOURCE_FILES.reduce((sum, file) => sum + Buffer.byteLength(readFileSync(repoPath(root, file), "utf8"), "utf8"), 0),
    replacedDocs: [...SOURCE_FILES],
  };
}

export type MdSectionSize = { title: string; line: number; tokens: number };
export type StaleHotDocNote = { line: number; match: string; note: string };
export type RetiredTermNote = { line: number; match: string; note: string };

export const HOT_DOC_BUDGETS: Record<string, number> = {
  "AGENTS.md": 3500,
  "docs/state/session-brief.md": 2200,
  "docs/state/context-loading-map.md": 3500,
  "docs/state/project-memory.md": 7000,
  "docs/state/handoff.md": 10000,
  // Slimmed 2026-07-07 (owner-ordered aggressive slim; plan:
  // docs/reviews/2026-07-07-doctrine-slim-plan.md). Ceilings lock the win —
  // the next addition archives detail rather than re-growing the boot cost.
  "docs/architecture/ai-architecture.md": 5500,
  "docs/state/decisions.md": 6500,
  "docs/process/orchestration-mechanics.md": 12000,
};

export const estimateTokens = (text: string): number => Math.round(text.length / 4);

export const largestMarkdownSections = (text: string, count = 3): MdSectionSize[] => {
  const lines = text.split(/\r?\n/);
  const headings: { title: string; line: number; index: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^(#{1,6})\s+(.+)$/.exec(lines[i]);
    if (match) headings.push({ title: match[2], line: i + 1, index: i });
  }
  if (headings.length === 0) {
    return [{ title: "(entire file)", line: 1, tokens: estimateTokens(text) }];
  }
  return headings
    .map((heading, i) => {
      const end = i + 1 < headings.length ? headings[i + 1].index : lines.length;
      const sectionText = lines.slice(heading.index, end).join("\n");
      return { title: heading.title, line: heading.line, tokens: estimateTokens(sectionText) };
    })
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, count);
};

const STALE_HOT_DOC_PATTERNS: { pattern: RegExp; note: string }[] = [
  { pattern: /\bPending:/i, note: "replace pending evidence with the actual result or move it to a task card" },
  { pattern: /\bat last update\b/i, note: "avoid snapshot wording that becomes stale; point readers to git for exact hashes" },
  { pattern: /\bfinish(?:ing)? this [\w-]* ?branch\b/i, note: "remove branch-local next steps from hot docs after merge" },
  { pattern: /\bcomplete .* validation and merge\b/i, note: "remove branch-local closeout steps from hot docs after merge" },
  { pattern: /\bbefore this (?:pass|branch)\b/i, note: "avoid self-referential pass/branch wording in cold-start docs" },
  { pattern: /\bthis (?:hot-doc|helper|hygiene) (?:pass|branch)\b/i, note: "avoid self-referential pass/branch wording in cold-start docs" },
];

const lineNumberAt = (text: string, index: number): number => text.slice(0, index).split(/\r?\n/).length;

export const findStaleHotDocNotes = (text: string): StaleHotDocNote[] => {
  const notes: StaleHotDocNote[] = [];
  for (const { pattern, note } of STALE_HOT_DOC_PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const globalPattern = new RegExp(pattern.source, flags);
    let match: RegExpExecArray | null;
    while ((match = globalPattern.exec(text)) !== null) {
      notes.push({ line: lineNumberAt(text, match.index), match: match[0], note });
    }
  }
  return notes.sort((a, b) => a.line - b.line || a.match.localeCompare(b.match));
};

// Hot docs scanned for retired-term drift. Includes CLAUDE.md, which is NOT in
// HOT_DOC_BUDGETS but is a cold-start doc that can name retired systems.
export const RETIRED_TERM_SCAN_DOCS: string[] = [
  "AGENTS.md",
  "CLAUDE.md",
  "docs/state/session-brief.md",
  "docs/state/context-loading-map.md",
  "docs/state/project-memory.md",
  "docs/state/handoff.md",
  "docs/state/decisions.md",
  "docs/architecture/ai-architecture.md",
  "docs/process/orchestration-mechanics.md",
];

// A term is treated as historical (no warning) when a retirement marker sits on
// the same line or an immediately adjacent line. WARN-first: this scan never
// fails the build — it only reports terms lacking a nearby marker.
const RETIRED_MARKER = /\b(RETIRED|SUPERSEDED|retired|superseded|historical|archives?)\b/;

// Curated retired-term list. Keying is deliberate to avoid live-usage false
// positives (see card FALSE-POSITIVE TRAP):
//   - `sonnet-default` / `sonnet 5 default` (NOT bare "sonnet 5": ai-architecture
//     "Sonnet 5 unused" is correct live text).
//   - `50/50` only when it modifies a split (NOT `80/20`, which is LIVE as the
//     lane-MIX rule in the masterplan pre-rulings — excluded from this list).
//   - `role lanes` used as a live process noun.
const RETIRED_TERM_PATTERNS: { pattern: RegExp; note: string }[] = [
  { pattern: /\bCodeBoss\b/, note: "CodeBoss is retired; mark the reference RETIRED/SUPERSEDED or remove it" },
  { pattern: /\bsonnet[-\s]?5?\s*default\b/i, note: "the sonnet-default model policy is superseded (Opus 4.8 default); mark it or update" },
  { pattern: /\b50\/50\s*(?:split)?\b/i, note: "the 50/50 engine split is superseded; mark it RETIRED/SUPERSEDED or update" },
  { pattern: /\brole lanes\b/i, note: "role lanes are retired as a live process; mark the reference RETIRED/SUPERSEDED" },
];

export const findRetiredTermNotes = (text: string): RetiredTermNote[] => {
  const lines = text.split(/\r?\n/);
  const notes: RetiredTermNote[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const context = [lines[i - 1] ?? "", line, lines[i + 1] ?? ""].join("\n");
    const marked = RETIRED_MARKER.test(context);
    for (const { pattern, note } of RETIRED_TERM_PATTERNS) {
      const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
      const globalPattern = new RegExp(pattern.source, flags);
      let match: RegExpExecArray | null;
      while ((match = globalPattern.exec(line)) !== null) {
        if (!marked) notes.push({ line: i + 1, match: match[0], note });
        if (match.index === globalPattern.lastIndex) globalPattern.lastIndex++;
      }
    }
  }
  return notes.sort((a, b) => a.line - b.line || a.match.localeCompare(b.match));
};

/**
 * ui-kit-lint — mechanical gate for the P5 tool-surface design-system contract
 * (docs/reviews/appendices/appendix-A-ui-design-system.md, Phase 3.5).
 *
 * Rules, applied to each surface's <style> blocks (inline style attributes and
 * JS-drawn canvas palettes are data-viz territory and out of scope):
 *   1. no-hex        — no literal hex colors; chrome comes from var(--lm-*)
 *   2. no-remap      — no :root local aliasing of --lm-* tokens into page vars
 *   3. no-lm-redef   — no local CHROME on .lm-* component classes (color,
 *                      background, border, font, shadow, radius live in
 *                      client/src/ui/tokens.css only); pure LAYOUT rules that
 *                      reference kit classes (width/margin/alignment) are fine
 *
 * MIGRATED surfaces fail the run (exit 1) on any finding; unmigrated surfaces
 * report warnings only, and their migration card flips the flag. A style-block
 * line containing "ui-kit-lint-exempt" is skipped (loud, greppable escape).
 *
 * Usage: pnpm ui:lint [--warn-only]
 */
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

const ROOT = process.cwd();
const EDITOR_MODULE_DIR = process.env.UI_KIT_LINT_EDITOR_DIR ?? "client/src/editor";

const SURFACES: { file: string; migrated: boolean }[] = [
  { file: "client/index.html", migrated: true },
  { file: "tools/devkit/index.html", migrated: true },
  { file: "tools/devkit/zone-editor.html", migrated: true },
  { file: "tools/devkit/asset-review-server.html", migrated: true },
  { file: "tools/src/api-docs.ts", migrated: true },
];

type Finding = { rule: string; line: number; text: string };
type SourceFinding = Finding & { file: string };

function styleBlocks(source: string): { css: string; startLine: number }[] {
  const blocks: { css: string; startLine: number }[] = [];
  const re = /<style>([\s\S]*?)<\/style>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const startLine = source.slice(0, m.index).split("\n").length;
    blocks.push({ css: m[1], startLine });
  }
  return blocks;
}

function lintCss(css: string, startLine: number): Finding[] {
  const findings: Finding[] = [];
  const lines = css.split("\n");
  let inRoot = false;
  lines.forEach((line, i) => {
    const n = startLine + i;
    if (line.includes("ui-kit-lint-exempt")) return;
    if (/#[0-9a-fA-F]{3,8}\b/.test(line)) {
      findings.push({ rule: "no-hex", line: n, text: line.trim() });
    }
    if (/:root\s*\{/.test(line)) inRoot = true;
    if (inRoot && /--(?!lm-)[a-z][\w-]*\s*:/.test(line)) {
      findings.push({ rule: "no-remap", line: n, text: line.trim() });
    }
    if (inRoot && line.includes("}")) inRoot = false;
    const lmRule = /^\s*[^/*{}]*\.lm-[a-z][\w-]*[^{]*\{([^}]*)/.exec(line);
    if (
      lmRule &&
      /(?:^|[\s;{])(color|background|border|box-shadow|font|text-transform|letter-spacing|border-radius|backdrop-filter|opacity)[^:]*:/.test(
        lmRule[1],
      )
    ) {
      findings.push({ rule: "no-lm-redef", line: n, text: line.trim() });
    }
  });
  return findings;
}

function editorModuleFiles(): string[] {
  const dir = isAbsolute(EDITOR_MODULE_DIR) ? EDITOR_MODULE_DIR : join(ROOT, EDITOR_MODULE_DIR);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(dir, name))
    .sort();
}

function displayPath(file: string): string {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  return rel.startsWith("..") ? file.replace(/\\/g, "/") : rel;
}

function lintEditorModule(source: string): Finding[] {
  const findings: Finding[] = [];
  source.split("\n").forEach((line, i) => {
    if (line.includes("ui-kit-lint-exempt")) return;
    if (/#[0-9a-fA-F]{3,8}\b/.test(line)) {
      findings.push({ rule: "editor-no-hex", line: i + 1, text: line.trim() });
    }
    if (/rgba?\(/.test(line)) {
      findings.push({ rule: "editor-no-rgb", line: i + 1, text: line.trim() });
    }
  });
  return findings;
}

function main(): number {
  const warnOnly = process.argv.includes("--warn-only");
  let failed = false;
  for (const surface of SURFACES) {
    let source: string;
    try {
      source = readFileSync(join(ROOT, surface.file), "utf8");
    } catch {
      console.error(`[ui:lint] MISSING surface file: ${surface.file}`);
      failed = true;
      continue;
    }
    const findings = styleBlocks(source).flatMap((b) => lintCss(b.css, b.startLine));
    if (!findings.length) {
      console.log(`[ui:lint] PASS ${surface.file}`);
      continue;
    }
    const blocking = surface.migrated && !warnOnly;
    const label = blocking ? "FAIL" : "WARN (unmigrated)";
    console.log(`[ui:lint] ${label} ${surface.file} — ${findings.length} finding(s)`);
    for (const f of findings.slice(0, 12)) {
      console.log(`  ${f.rule} L${f.line}: ${f.text.slice(0, 120)}`);
    }
    if (findings.length > 12) console.log(`  ... ${findings.length - 12} more`);
    if (blocking) failed = true;
  }
  const editorFindings: SourceFinding[] = [];
  for (const file of editorModuleFiles()) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      console.error(`[ui:lint] MISSING editor file: ${displayPath(file)}`);
      failed = true;
      continue;
    }
    editorFindings.push(...lintEditorModule(source).map((finding) => ({ ...finding, file: displayPath(file) })));
  }
  if (editorFindings.length) {
    const label = warnOnly ? "WARN" : "FAIL";
    console.log(`[ui:lint] ${label} ${EDITOR_MODULE_DIR.replace(/\\/g, "/")}/*.ts — ${editorFindings.length} finding(s)`);
    for (const f of editorFindings.slice(0, 16)) {
      console.log(`  ${f.file}:${f.line} ${f.rule}: ${f.text.slice(0, 120)}`);
    }
    if (editorFindings.length > 16) console.log(`  ... ${editorFindings.length - 16} more`);
    if (!warnOnly) failed = true;
  } else {
    console.log(`[ui:lint] PASS ${EDITOR_MODULE_DIR.replace(/\\/g, "/")}/*.ts`);
  }
  if (failed) {
    console.error(
      "[ui:lint] BLOCKED: migrated surfaces and editor DOM modules must take chrome from the lm-* kit (tokens.css).",
    );
    return 1;
  }
  console.log("[ui:lint] OK");
  return 0;
}

process.exit(main());

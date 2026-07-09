import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const ROOT = process.cwd();
const TOOLS_SRC = resolve(ROOT, "tools", "src");
const BLOCKED_ROOTS = [
  resolve(ROOT, "client", "src"),
  resolve(ROOT, "server", "src"),
];

const ALLOWLIST = new Set([
  "tools/src/capture-hud.ts -> client/src/config/constants.ts",
  "tools/src/capture-lr4-ui.ts -> client/src/config/constants.ts",
  "tools/src/capture-zone.ts -> client/src/config/constants.ts",
  "tools/src/capture-zone.ts -> client/src/config/map-assets.ts",
  "tools/src/map-assets.test.ts -> client/src/config/map-assets.ts",
  "tools/src/player-facing-proof.ts -> client/src/config/animation-assets.ts",
  "tools/src/zone-dod.ts -> client/src/config/constants.ts",
  "tools/src/zone-export.ts -> client/src/config/asset-scale.ts",
  "tools/src/zone-lint.ts -> client/src/config/constants.ts",
  "tools/src/smoke/zone-reload.ts -> server/src/content/registry.ts",
  "tools/src/smoke/zone-reload.ts -> server/src/zone-reload.ts",
  "tools/src/devkit.ts -> server/src/procgen/dungeon.ts",
  "tools/src/devkit.ts -> server/src/procgen/emitter.ts",
  "tools/src/funnel-report.ts -> server/src/db.ts",
]);

function normalize(path: string): string {
  return path.replace(/\\/g, "/");
}

function collectTsFiles(dir: string, output: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      collectTsFiles(full, output);
    } else if (entry.endsWith(".ts")) {
      output.push(full);
    }
  }
  return output;
}

function candidateTargets(importer: string, specifier: string): string[] {
  if (!specifier.startsWith(".")) return [];
  const base = resolve(dirname(importer), specifier);
  const targets = [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")];
  if (base.endsWith(".js")) targets.push(`${base.slice(0, -3)}.ts`);
  return targets;
}

function isBlocked(target: string): boolean {
  return BLOCKED_ROOTS.some((root) => target === root || target.startsWith(`${root}\\`) || target.startsWith(`${root}/`));
}

function importEdge(importer: string, target: string): string {
  return `${normalize(relative(ROOT, importer))} -> ${normalize(relative(ROOT, target))}`;
}

const importRe =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
const errors: string[] = [];

for (const file of collectTsFiles(TOOLS_SRC)) {
  const source = readFileSync(file, "utf8");
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(source)) !== null) {
    const specifier = match[1] ?? match[2];
    if (!specifier) continue;
    for (const target of candidateTargets(file, specifier)) {
      if (!existsSync(target) || !isBlocked(target)) continue;
      const edge = importEdge(file, target);
      if (!ALLOWLIST.has(edge)) {
        errors.push(edge);
      }
      break;
    }
  }
}

if (errors.length > 0) {
  console.error("[cross-package-imports] tools/src imports from client/src or server/src without allowlist entries:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`[cross-package-imports] OK — ${ALLOWLIST.size} existing tool import edge(s) allowlisted.`);

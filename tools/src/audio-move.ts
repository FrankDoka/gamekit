import { mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { assetsRoot } from "./toolkit-config.js";

const DEFAULT_ROOT = path.join(assetsRoot(), "audio", "generated");

interface CliOptions {
  root: string;
  plan: string;
  force: boolean;
}

interface MovePlanEntry {
  source: string;
  destination: string;
}

interface MovePlan {
  moves: MovePlanEntry[];
}

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  pnpm audio:move -- --root Z:/Assets/audio/generated --plan audio-move-plan.json",
      "",
      "Options:",
      "  --root <path>    Generated audio root. Default: Z:/Assets/audio/generated",
      "  --plan <path>    JSON move plan. Default: <root>/audio-move-plan.json",
      "  --force          Overwrite existing destination files.",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): CliOptions {
  if (argv[0] === "--") {
    argv = argv.slice(1);
  }

  let root = DEFAULT_ROOT;
  let plan = "";
  let force = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--root") {
      if (!next) throw new Error("--root requires a path.");
      root = next;
      i += 1;
      continue;
    }

    if (arg === "--plan") {
      if (!next) throw new Error("--plan requires a path.");
      plan = next;
      i += 1;
      continue;
    }

    if (arg === "--force") {
      force = true;
      continue;
    }

    usage();
  }

  const resolvedRoot = path.resolve(root);
  return {
    root: resolvedRoot,
    plan: plan ? path.resolve(plan) : path.join(resolvedRoot, "audio-move-plan.json"),
    force,
  };
}

function assertInsideRoot(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to move outside root: ${candidate}`);
  }
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("../") || normalized === "..") {
    throw new Error(`Invalid relative path: ${value}`);
  }
  return normalized;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rawPlan = JSON.parse(await readFile(options.plan, "utf8")) as MovePlan;

  if (!Array.isArray(rawPlan.moves)) {
    throw new Error("Move plan must contain a moves array.");
  }

  for (const move of rawPlan.moves) {
    const sourceRelative = normalizeRelativePath(move.source);
    const destinationRelative = normalizeRelativePath(move.destination);
    const sourcePath = path.resolve(options.root, sourceRelative);
    const destinationPath = path.resolve(options.root, destinationRelative);

    assertInsideRoot(options.root, sourcePath);
    assertInsideRoot(options.root, destinationPath);

    if (!options.force) {
      try {
        await readFile(destinationPath);
        throw new Error(`Destination exists; rerun with --force if intended: ${destinationRelative}`);
      } catch (error: unknown) {
        if (error instanceof Error && !("code" in error)) {
          throw error;
        }
        if (typeof error === "object" && error && "code" in error && error.code !== "ENOENT") {
          throw error;
        }
      }
    }

    await mkdir(path.dirname(destinationPath), { recursive: true });
    await rename(sourcePath, destinationPath);
    console.log(`${sourceRelative} -> ${destinationRelative}`);
  }

  console.log(`Moved ${rawPlan.moves.length} audio file(s).`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

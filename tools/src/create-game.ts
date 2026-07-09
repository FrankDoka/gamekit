/**
 * create-gamekit-game — scaffold a new GameKit game from the read-only reference
 * game (`examples/starter-game`). One command takes a new dev from zero to a
 * runnable game with contract-conformant content and the AI-dev harness stubs.
 *
 *   pnpm create:game <game-name> [--dir <path>] [--dry-run]
 *
 * It COPIES the starter game (minus install/build/capture artifacts), REWIRES
 * the copy's package names / html title / README, WIRES a `.env.example`, and
 * SEEDS `docs/state/*` harness stubs. It never mutates `examples/starter-game`.
 *
 * Node built-ins only (fs/path/url) — no new deps. Windows-path aware.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Toolkit repo root (…/Game-Architecture), derived from this module's location. */
const TOOLKIT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const TEMPLATE_DIR = path.join(TOOLKIT_ROOT, "examples", "starter-game");

/** Basenames excluded from the copy at ANY depth (fresh install/build later). */
const EXCLUDE_NAMES = new Set([
  "node_modules",
  "dist",
  "pnpm-lock.yaml",
  ".git",
]);

/** Directory-name patterns excluded at any depth (regenerable capture/version output). */
const EXCLUDE_DIR_PATTERNS = [
  /^_capture/, // _capture, _capture-foo, …
  /^_v/, // _v_*, _v1, … (task: `_v*`)
];

interface CliOptions {
  gameName: string;
  targetDir: string;
  dryRun: boolean;
}

interface PlanEntry {
  action: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const usage = (): string =>
  [
    "Usage: pnpm create:game <game-name> [--dir <path>] [--dry-run]",
    "",
    "  <game-name>   kebab-case name for the new game (e.g. my-rpg)",
    "  --dir <path>  target directory (default: sibling ../<game-name> of the toolkit)",
    "  --dry-run     print the plan and exit; copy/write nothing",
  ].join("\n");

/** Validate the game name: safe as a package name and a directory basename. */
const isValidGameName = (name: string): boolean =>
  /^[a-z0-9][a-z0-9-]*$/.test(name) && !name.includes("--") && !name.endsWith("-");

const parseArgs = (argv: string[]): CliOptions => {
  let gameName: string | undefined;
  let dirArg: string | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--dir") {
      dirArg = argv[++i];
      if (dirArg === undefined) {
        throw new Error("--dir requires a path argument");
      }
    } else if (arg.startsWith("--dir=")) {
      dirArg = arg.slice("--dir=".length);
    } else if (arg === "-h" || arg === "--help") {
      console.log(usage());
      process.exit(0);
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown flag: ${arg}`);
    } else if (gameName === undefined) {
      gameName = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }

  if (!gameName) {
    throw new Error("missing required <game-name>\n\n" + usage());
  }
  if (!isValidGameName(gameName)) {
    throw new Error(
      `invalid game name "${gameName}" — use kebab-case: lowercase letters, digits, single hyphens (e.g. my-rpg)`,
    );
  }

  // Default target: sibling of the toolkit repo, ../<game-name>.
  const targetDir = dirArg
    ? path.resolve(dirArg)
    : path.resolve(TOOLKIT_ROOT, "..", gameName);

  return { gameName, targetDir, dryRun };
};

// ---------------------------------------------------------------------------
// Copy with excludes
// ---------------------------------------------------------------------------

const isExcluded = (entrySrcPath: string): boolean => {
  const base = path.basename(entrySrcPath);
  if (EXCLUDE_NAMES.has(base)) return true;
  return EXCLUDE_DIR_PATTERNS.some((re) => re.test(base));
};

/** Recursively copy TEMPLATE_DIR → targetDir, skipping excluded names. */
const copyTemplate = (targetDir: string): void => {
  cpSync(TEMPLATE_DIR, targetDir, {
    recursive: true,
    filter: (src) => !isExcluded(src),
  });
};

// ---------------------------------------------------------------------------
// Rewire the copy
// ---------------------------------------------------------------------------

/** Rewrite the `name` field of a package.json in-place. */
const rewritePackageName = (pkgPath: string, newName: string): void => {
  const raw = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as { name?: string; [k: string]: unknown };
  pkg.name = newName;
  // Preserve 2-space indentation + trailing newline (matches the template).
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
};

/** Rewrite the <title> in client/index.html. */
const rewriteHtmlTitle = (htmlPath: string, title: string): void => {
  const raw = readFileSync(htmlPath, "utf8");
  const next = raw.replace(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`);
  writeFileSync(htmlPath, next);
};

/**
 * Human-friendly title from a kebab game name: "my-rpg" -> "My Rpg".
 * Used for README heading + html <title>.
 */
const titleCase = (name: string): string =>
  name
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

/**
 * How the new game references the toolkit. When the game lives as the default
 * sibling (../<game-name>), the toolkit is `../<toolkit-basename>`. For a custom
 * --dir we compute the real relative path; if that escapes oddly we fall back to
 * the absolute toolkit path so the printed commands always work.
 */
const toolkitPathFrom = (gameDir: string): string => {
  const rel = path.relative(gameDir, TOOLKIT_ROOT);
  if (!rel || rel.startsWith("..") === false) {
    // rel is empty or points *into* the game (shouldn't happen) — use absolute.
    return TOOLKIT_ROOT.replace(/\\/g, "/");
  }
  return rel.replace(/\\/g, "/");
};

const buildReadme = (gameName: string, toolkitRel: string): string => {
  const title = titleCase(gameName);
  const toolkitAbs = TOOLKIT_ROOT.replace(/\\/g, "/");
  return `# ${title}

A GameKit game, scaffolded from the reference game (\`examples/starter-game\`). It ships one zone
and one controllable entity over a Colyseus server rendered with Phaser 4 — a **runnable starting
point**, not a finished game.

> **TODO for you:** rename the placeholder content id \`map_starter_field\` (in \`content/maps\`,
> \`content/zones\`, and the client/server code that references it) to your own map id, and replace
> the placeholder rectangle art under \`client/public/assets/\` with real sprites/tiles as you build.

## Layout

\`\`\`
${gameName}/
  content/                         # contract-conformant game content (validated by zone:* tools)
    maps/map_starter_field.json    #   MapManifest        (TODO: rename)
    zones/map_starter_field.layout.json  # ZoneLayout     (TODO: rename)
  server/                          # Colyseus room "game": guest join, move.to intent, state sync
  client/                          # Vite + Phaser 4: #auth-guest -> join -> render players
\`\`\`

This is a **standalone project** (its own \`node_modules\`), separate from the GameKit toolkit. The
toolkit's game-aware tools run against it with \`cwd = this folder\`.

## Run it

\`\`\`sh
# one-time install (isolated — each sub-project installs its own deps).
# --config.dangerouslyAllowAllBuilds=true auto-approves esbuild's build (it ships prebuilt
# binaries, so the "build" is a no-op) — this is what makes the isolated install exit 0.
pnpm install --ignore-workspace --config.dangerouslyAllowAllBuilds=true                 # root: tsx
cd server && pnpm install --ignore-workspace --config.dangerouslyAllowAllBuilds=true && cd ..
cd client && pnpm install --ignore-workspace --config.dangerouslyAllowAllBuilds=true && cd ..

# boot the server + client manually
(cd server && PORT=2567 ALLOW_GUEST_LOGIN=true node ../node_modules/tsx/dist/cli.mjs src/index.ts)
(cd client && VITE_COLYSEUS_URL=ws://127.0.0.1:2567 node node_modules/vite/bin/vite.js --host 127.0.0.1)
# open the printed URL, click "Play as Guest", move with WASD / click
\`\`\`

> Without the \`--config.dangerouslyAllowAllBuilds=true\` flag, the install still works but ends with a
> harmless \`ERR_PNPM_IGNORED_BUILDS: … esbuild…\` + non-zero exit (a pnpm prompt, not a real failure).
>
> **Windows (PowerShell):** the boot lines use POSIX inline-env syntax. In PowerShell set the vars
> first, e.g. \`$env:PORT='2567'; $env:ALLOW_GUEST_LOGIN='true'; node ../node_modules/tsx/dist/cli.mjs src/index.ts\`
> (and \`$env:VITE_COLYSEUS_URL='ws://127.0.0.1:2567'\` for the client). Or run from Git Bash as written.

## Exercise the toolkit against it

The GameKit toolkit lives at \`${toolkitAbs}\` (from here: \`${toolkitRel}\`). Run its tools from
this folder so \`cwd\` is the game root:

\`\`\`sh
TOOLKIT=${toolkitRel}
# static content tools (no runtime)
node $TOOLKIT/node_modules/tsx/dist/cli.mjs $TOOLKIT/tools/src/zone-validate.ts
node $TOOLKIT/node_modules/tsx/dist/cli.mjs $TOOLKIT/tools/src/zone-lint.ts --all
node $TOOLKIT/node_modules/tsx/dist/cli.mjs $TOOLKIT/tools/src/zone-export.ts
# headless capture (boots server+client, screenshots the zone)
node $TOOLKIT/node_modules/tsx/dist/cli.mjs $TOOLKIT/tools/src/capture-zone.ts _capture --map=map_starter_field --sweep
\`\`\`

Or set \`GAME_ROOT=<this folder>\` and run the tools from anywhere (see \`.env.example\`).

## The contract it satisfies

The client/server consume their own JSON content; the **toolkit** reads that content through
\`@gamekit/game-contract\` to validate it. The runtime surface the capture/smoke tools require — a
Colyseus room named \`"game"\`, \`globalThis.__GAME\` exposing a scene keyed \`"game"\` with
\`localSessionId\` / \`room.state.players\` / \`playerObjects\` / \`cameras.main\`, an \`#auth-guest\`
button, a \`move.to\` intent, and a server boot log echoing \`smokeRunId\` — is all in \`server/src\`
and \`client/src\`. Keep that surface as you build and every game-aware tool keeps working.
`;
};

/** `.env.example` mirroring the roots in tools/src/toolkit-config.ts + the three runtime env vars. */
const buildEnvExample = (gameDir: string): string => {
  const gameRootPosix = gameDir.replace(/\\/g, "/");
  return `# GameKit environment for this game. Copy to .env and adjust, or export these before
# running the toolkit's tools. All are optional; defaults shown in comments.

# GAME_ROOT — the game repo the toolkit's tools operate on. Point it here so tools run from
# anywhere. Default when unset: the toolkit repo root (i.e. tools act on themselves — not useful).
GAME_ROOT=${gameRootPosix}

# ASSETS_ROOT — external asset data bank browsed/promoted by the Asset Bank + DevKit.
# Default: <GAME_ROOT>/assets-bank
# ASSETS_ROOT=

# ASSETS_METADATA_ROOT — review-metadata store (acceptance/rating state; never mixed with binaries).
# Default: <ASSETS_ROOT>-metadata
# ASSETS_METADATA_ROOT=

# GAME_ONLINE_HOST — public hostname the DevKit hub reports for the deployed game.
# Default: yourgame.example
# GAME_ONLINE_HOST=

# GAME_SERVER_PACKAGE — package name of the game server, used by the persistence smoke.
# Default: @game/server
GAME_SERVER_PACKAGE=${path.basename(gameDir)}-server

# GAME_CLIENT_PACKAGE — package name of the game client, used by the persistence smoke.
# Default: @game/client
GAME_CLIENT_PACKAGE=${path.basename(gameDir)}-client
`;
};

/** Seed docs/state/* stubs for the AI-dev harness (Track-2), one-line "fill me in" scaffolds. */
const HARNESS_STUBS: Record<string, string> = {
  "session-brief.md": `# Session brief — {{GAME}}

<!-- Compact cold-start snapshot: current phase, what works, the single next step. Fill me in. -->

- **Phase:** scaffolded from GameKit starter-game. Not yet started.
- **Next step:** rename \`map_starter_field\`, replace placeholder art, build the first real system.
`,
  "decisions.md": `# Decisions — {{GAME}}

<!-- Durable, ratified decisions (one entry per decision, newest on top). Fill me in. -->

_No decisions recorded yet._
`,
  "handoff.md": `# Handoff — {{GAME}}

<!-- Exact resume detail for the next session: in-flight work, how to continue. Fill me in. -->

_Fresh scaffold — nothing in flight._
`,
  "project-memory.md": `# Project memory — {{GAME}}

<!-- Durable project history + hard-won facts a cold session would otherwise repeat. Fill me in. -->

_Fresh scaffold — no history yet._
`,
  "active-sessions.md": `# Active sessions — {{GAME}}

<!-- Live worktrees / sessions roster (kept in sync by sessions:sync). Fill me in. -->

_No active sessions._
`,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = (): void => {
  const opts = parseArgs(process.argv.slice(2));
  const { gameName, targetDir, dryRun } = opts;

  if (!existsSync(TEMPLATE_DIR)) {
    throw new Error(`template not found: ${TEMPLATE_DIR}`);
  }
  if (existsSync(targetDir)) {
    throw new Error(
      `target already exists (refusing to clobber): ${targetDir}`,
    );
  }

  const toolkitRel = toolkitPathFrom(targetDir);
  const title = titleCase(gameName);

  // Build the plan (shared by dry-run and real run).
  const plan: PlanEntry[] = [
    {
      action: "COPY",
      detail: `${TEMPLATE_DIR}  ->  ${targetDir}  (excluding: node_modules/, _capture*/, _v*/, dist/, pnpm-lock.yaml, .git/)`,
    },
    { action: "RENAME", detail: `package.json name -> "${gameName}"` },
    {
      action: "RENAME",
      detail: `server/package.json name -> "${gameName}-server"`,
    },
    {
      action: "RENAME",
      detail: `client/package.json name -> "${gameName}-client"`,
    },
    { action: "RENAME", detail: `client/index.html <title> -> "${title}"` },
    { action: "WRITE", detail: `README.md (game-specific)` },
    { action: "WRITE", detail: `.env.example (GAME_ROOT + toolkit env vars)` },
    ...Object.keys(HARNESS_STUBS).map((f) => ({
      action: "WRITE",
      detail: `docs/state/${f} (harness stub)`,
    })),
  ];

  console.log(`\ncreate-gamekit-game — "${gameName}"`);
  console.log(`  toolkit : ${TOOLKIT_ROOT}`);
  console.log(`  target  : ${targetDir}`);
  console.log(`  mode    : ${dryRun ? "DRY RUN (no changes)" : "real"}\n`);
  console.log("Plan:");
  for (const p of plan) {
    console.log(`  ${p.action.padEnd(7)} ${p.detail}`);
  }
  console.log("");

  if (dryRun) {
    console.log("Dry run — nothing was copied or written.\n");
    printNextSteps(targetDir, toolkitRel);
    return;
  }

  // 1. Copy template (with excludes).
  copyTemplate(targetDir);

  // 2. Rewire package names + html title.
  rewritePackageName(path.join(targetDir, "package.json"), gameName);
  rewritePackageName(
    path.join(targetDir, "server", "package.json"),
    `${gameName}-server`,
  );
  rewritePackageName(
    path.join(targetDir, "client", "package.json"),
    `${gameName}-client`,
  );
  rewriteHtmlTitle(path.join(targetDir, "client", "index.html"), title);

  // 3. Game-specific README.
  writeFileSync(
    path.join(targetDir, "README.md"),
    buildReadme(gameName, toolkitRel),
  );

  // 4. .env.example.
  writeFileSync(
    path.join(targetDir, ".env.example"),
    buildEnvExample(targetDir),
  );

  // 5. Harness stubs under docs/state/.
  const stateDir = path.join(targetDir, "docs", "state");
  mkdirSync(stateDir, { recursive: true });
  for (const [file, body] of Object.entries(HARNESS_STUBS)) {
    writeFileSync(
      path.join(stateDir, file),
      body.replace(/\{\{GAME\}\}/g, title),
    );
  }

  console.log(`Scaffolded "${gameName}" at ${targetDir}\n`);
  printNextSteps(targetDir, toolkitRel);
};

const printNextSteps = (targetDir: string, toolkitRel: string): void => {
  const targetPosix = targetDir.replace(/\\/g, "/");
  console.log("Next steps:");
  console.log(`  1. Install deps (isolated from the toolkit workspace):`);
  console.log(`       cd "${targetPosix}"`);
  console.log(`       pnpm install --ignore-workspace --config.dangerouslyAllowAllBuilds=true`);
  console.log(`       cd server && pnpm install --ignore-workspace --config.dangerouslyAllowAllBuilds=true && cd ..`);
  console.log(`       cd client && pnpm install --ignore-workspace --config.dangerouslyAllowAllBuilds=true && cd ..`);
  console.log(
    `     (the flag auto-approves esbuild's no-op prebuilt-binary build so the install exits 0; without`,
  );
  console.log(
    `      it the install still works but ends with a harmless "ERR_PNPM_IGNORED_BUILDS … esbuild" prompt.)`,
  );
  console.log(`  2. Boot it (POSIX shell shown; on Windows use PowerShell — see the game's README):`);
  console.log(
    `       (cd server && PORT=2567 ALLOW_GUEST_LOGIN=true node ../node_modules/tsx/dist/cli.mjs src/index.ts)`,
  );
  console.log(
    `       (cd client && VITE_COLYSEUS_URL=ws://127.0.0.1:2567 node node_modules/vite/bin/vite.js --host 127.0.0.1)`,
  );
  console.log(`  3. Point the toolkit's tools at this game (from the game dir):`);
  console.log(
    `       node ${toolkitRel}/node_modules/tsx/dist/cli.mjs ${toolkitRel}/tools/src/zone-validate.ts`,
  );
  console.log(
    `     …or set GAME_ROOT="${targetPosix}" and run the tools from anywhere (see .env.example).`,
  );
  console.log("");
};

try {
  main();
} catch (err) {
  console.error(
    `\ncreate-game: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}

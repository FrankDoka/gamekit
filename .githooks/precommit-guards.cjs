#!/usr/bin/env node
/**
 * GameKit toolkit pre-commit guards (generic). Exit 1 blocks the commit.
 *
 * GENERICIZED from the prior game project. The original carried four game-specific
 * gates that DO NOT apply to a reusable toolkit and referenced files/paths that do
 * not exist here — all removed:
 *   B3 visual-proof gate   (keyed on client/src/render/, client/public/assets/ — game paths)
 *   B4 zoom lock           (keyed on client/src/config/constants.ts CAMERA_ZOOM_* — game config)
 *   B6 zone-DoD guard      (keyed on content/zones/*, tools/zone-gen/ — game content)
 * plus a `pnpm validate` battery that chained that game's validate:data / docs:budget /
 * zone:lint:ci scripts.
 *
 * KEPT + ADDED — genuinely generic guards that help any repo:
 *   G1 empty-commit guard  — a commit recording ZERO staged changes is blocked (a ref
 *                            race can leave work uncommitted while the message claims it
 *                            landed). Escape: GAMEKIT_EMPTY_OK=1 git commit ...
 *   G2 merge-marker guard  — staged text must not contain unresolved conflict markers
 *                            (<<<<<<< / ======= / >>>>>>>).
 *   G3 secret guard        — staged text is scanned for high-signal credential patterns
 *                            (AWS keys, private-key blocks, generic api_key/secret=...).
 *                            Escape (false positive): GAMEKIT_SECRET_OK=1 git commit ...
 */
const { execSync } = require("child_process");
const path = require("path");

const REPO = path.resolve(__dirname, "..");

function sh(cmd) {
  return execSync(cmd, { cwd: REPO, timeout: 15000 }).toString();
}

// ---- G1: empty-commit guard ----
const stagedAny = sh("git diff --cached --name-only").split("\n").filter(Boolean);
if (stagedAny.length === 0 && process.env.GAMEKIT_EMPTY_OK !== "1") {
  console.error("[pre-commit] BLOCKED (G1 empty commit): this commit records ZERO staged changes.");
  console.error("[pre-commit] Your changes are probably unstaged, or another session already committed/reverted them.");
  console.error("[pre-commit] Check `git status`, re-stage, and re-verify.");
  console.error("[pre-commit] Deliberate empty commit or message-only amend? GAMEKIT_EMPTY_OK=1 git commit ...");
  process.exit(1);
}

// Files whose staged content we inspect for markers/secrets. Skip binaries.
const staged = sh("git diff --cached --name-only --diff-filter=ACMR").split("\n").filter(Boolean);
const TEXT_SKIP = /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|tar|woff2?|ttf|otf|mp3|wav|ogg|mp4|webm|lock)$/i;

function stagedContent(file) {
  try {
    return execSync(`git show :"${file}"`, { cwd: REPO, timeout: 15000, maxBuffer: 20 * 1024 * 1024 }).toString();
  } catch {
    return "";
  }
}

// ---- G2: merge-conflict marker guard ----
// Anchored to line start so ======= rules / >>> prompts in prose don't trip it.
const MARKER = /^(<{7}|={7}|>{7})(\s|$)/;
const markerHits = [];
// ---- G3: secret guard ----
const SECRET_PATTERNS = [
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: "generic secret assignment", re: /\b(?:api[_-]?key|secret|passwd|password|token)\b\s*[:=]\s*['"][^'"\s]{12,}['"]/i },
  { name: "Slack token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
];
const secretHits = [];

// Test/fixture scaffolding routinely holds throwaway credentials (fake login
// literals in *-proof.ts / smoke-*.ts / *.test.ts). Scanning those for secrets is
// high-false-positive and low-value, so we skip secret checks there — but still run
// the merge-marker check everywhere.
const SECRET_SKIP = /(^|\/)(?:.*\.test\.ts|.*-proof\.ts|smoke-.*\.ts)$|(^|\/)(fixtures|__fixtures__|testdata)\//i;

for (const file of staged) {
  if (TEXT_SKIP.test(file)) continue;
  const content = stagedContent(file);
  if (!content) continue;
  const scanSecrets = process.env.GAMEKIT_SECRET_OK !== "1" && !SECRET_SKIP.test(file);
  const lines = content.split("\n");
  lines.forEach((line, i) => {
    if (MARKER.test(line)) markerHits.push(`${file}:${i + 1}`);
    if (scanSecrets) {
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(line)) secretHits.push(`${file}:${i + 1} — ${name}`);
      }
    }
  });
}

if (markerHits.length > 0) {
  console.error("[pre-commit] BLOCKED (G2 merge markers): unresolved conflict markers in staged files:");
  for (const h of markerHits.slice(0, 20)) console.error(`  - ${h}`);
  process.exit(1);
}

if (secretHits.length > 0) {
  console.error("[pre-commit] BLOCKED (G3 secret guard): possible credential(s) in staged content:");
  for (const h of secretHits.slice(0, 20)) console.error(`  - ${h}`);
  console.error("[pre-commit] Remove the secret (use env vars / a secrets manager).");
  console.error("[pre-commit] False positive (e.g. a fixture)? GAMEKIT_SECRET_OK=1 git commit ...");
  process.exit(1);
}

process.exit(0);

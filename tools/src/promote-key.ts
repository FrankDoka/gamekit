import path from "node:path";

/**
 * Canonical promote-key derivation — the ONE function both promote paths use to turn a
 * source asset path into its runtime registry key / target basename.
 *
 * Before this module existed, the DevKit editor (`cleanKeyFromPath`, devkit.ts) and the
 * Asset Bank (plain `path.basename`, asset-bank.ts) derived promote keys differently, so
 * promoting the *same* asset from the two surfaces forked the registry key and the runtime
 * filename — a tool-suite split-brain (audit 2026-07-03, card-toolsuite-unify). DevKit's
 * normalization is the correct behavior; the bank adopts it here.
 *
 * Rules (order matters — a byte-different sequence forks every key):
 *  - basename without extension, lowercased
 *  - strip a trailing pixel-dimension suffix (`_128x128`)
 *  - strip trailing pipeline suffixes (`_clean`/`_candidate`/`_raw`/`_alpha_preview`/
 *    `_preview`, repeatable)
 *  - sanitize to `[a-z0-9_]`, collapse runs of `_`, trim leading/trailing `_`
 *  - if nothing survives, fall back to a stable djb2 hash of the basename so the key is
 *    never empty (and is independent of whether the caller passed an absolute or a
 *    bank-relative path — the exact difference between the bank and DevKit call sites)
 */
export function promoteKeyFromPath(sourcePath: string): string {
  const base = path.basename(sourcePath, path.extname(sourcePath));
  let key = base.toLowerCase();
  key = key.replace(/_\d+x\d+$/i, "");
  key = key.replace(/(_clean|_candidate|_raw|_alpha_preview|_preview)+$/g, "");
  key = key.replace(/[^a-z0-9_]/g, "_");
  key = key.replace(/_+/g, "_");
  key = key.replace(/^_+|_+$/g, "");
  return key || hashBasename(sourcePath);
}

/**
 * Stable djb2 hash of the basename (not the full path) so an absolute and a bank-relative
 * path to the same file hash identically — keeping the two call sites in parity even for
 * inputs that normalize to an empty key.
 */
function hashBasename(sourcePath: string): string {
  const value = path.basename(sourcePath);
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  }
  return `asset_${(hash >>> 0).toString(36)}`;
}

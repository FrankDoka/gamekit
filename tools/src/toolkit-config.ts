import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Single home for every filesystem root the toolkit used to hardcode as an absolute repo
 * path (e.g. `Z:/<repo root>`, `Z:/Assets`). Tools import from here instead of embedding absolute
 * paths, so the same toolkit runs against any game on any machine.
 *
 * Override via environment (all optional):
 *   GAME_ROOT                — the game repo root the tools operate on (default: this repo root)
 *   ASSETS_ROOT              — external asset data bank (default: <GAME_ROOT>/assets-bank)
 *   ASSETS_METADATA_ROOT     — review metadata store (default: <ASSETS_ROOT>-metadata)
 *   GAME_INTEGRATION_BRANCH  — the branch lanes rebase/merge onto (default: "master"; set =main for a main-trunk repo)
 */

/** Repo root of the toolkit itself (…/Game-Architecture), derived from this module. */
export function toolkitRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** The game repo the tools act on. Defaults to the toolkit root until a game is wired. */
export function gameRoot(): string {
  return process.env.GAME_ROOT ? path.resolve(process.env.GAME_ROOT) : toolkitRoot();
}

/** External asset data bank (browsed/promoted by the Asset Bank + DevKit). */
export function assetsRoot(): string {
  return process.env.ASSETS_ROOT ? path.resolve(process.env.ASSETS_ROOT) : path.join(gameRoot(), "assets-bank");
}

/** Review-metadata store (acceptance/rating state; never mixed with asset binaries). */
export function assetsMetadataRoot(): string {
  return process.env.ASSETS_METADATA_ROOT ? path.resolve(process.env.ASSETS_METADATA_ROOT) : `${assetsRoot()}-metadata`;
}

/**
 * The integration branch lanes rebase onto and are verified/merged against. Defaults to
 * "master" (the harness's origin default, which the lane/intake/integrator tests assume).
 * Set GAME_INTEGRATION_BRANCH to your trunk — e.g. GAME_INTEGRATION_BRANCH=main for a repo
 * on main (like this toolkit's own repo).
 */
export function integrationBranch(): string {
  const raw = process.env.GAME_INTEGRATION_BRANCH?.trim();
  return raw ? raw : "master";
}

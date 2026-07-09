/**
 * Gacha capture — the "boot + drive + screenshot" sibling of capture-zone.ts, for
 * the MENU-DRIVEN, request/response GACHA reference game (examples/gacha-game).
 *
 * This genre breaks the action pipeline's TWO core assumptions: the server is a
 * plain Express HTTP API (NOT a Colyseus room — no socket, no `room.state`), and
 * the client is a DOM screen router (NOT Phaser — no `__GAME`). So it reuses the
 * genre-neutral boot (smoke/genre-harness.ts) — which keeps the SAME
 * port-reservation + `smokeRunId` ownership handshake as the action harness (the
 * gacha server echoes the same `{"msg":"listening",...,"smokeRunId":...}` boot
 * log, so the ownership gate works unchanged) — and drives the DOM UI:
 *   click #auth-guest (POST /api/guest) -> Summon -> Pull x10 -> Roster.
 * It reads `globalThis.__GACHA`, asserts currency DECREASED + roster GREW, and
 * screenshots Home + Summon-results + Roster.
 *
 * Usage:  GAME_ROOT=<abs path to gacha-game> tsx tools/src/capture-gacha.ts [outDir]
 *   (defaults: GAME_ROOT=examples/gacha-game, outDir=examples/gacha-game/_shots)
 * This tool is GAME-AWARE: it needs a wired gacha game at GAME_ROOT.
 */
import { existsSync, mkdirSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import type { Page } from "@playwright/test";
import { bootGenreCapture, clickGuest } from "./smoke/genre-harness";

type GachaRosterEntry = { unitId: string; count: number };
type GachaState = {
  currency: number;
  pityCounter: number;
  roster: GachaRosterEntry[];
  pullCostX1: number;
  pullCostX10: number;
};
type GachaGlobal = {
  token: string;
  banner: { name?: string } | null;
  state: GachaState | null;
  screen: string;
  lastResults: Array<{ unitId: string; name: string; rarity: number; pity: boolean }>;
};

// Reader for the gacha inspectable global (the analogue of __GAME for this genre).
async function readGacha(page: Page): Promise<GachaGlobal | null> {
  return page.evaluate(() => {
    const g = (globalThis as { __GACHA?: GachaGlobal }).__GACHA;
    if (!g) return null;
    return {
      token: g.token,
      banner: g.banner ? { name: g.banner.name } : null,
      state: g.state
        ? {
            currency: g.state.currency,
            pityCounter: g.state.pityCounter,
            roster: g.state.roster.map((r) => ({ unitId: r.unitId, count: r.count })),
            pullCostX1: g.state.pullCostX1,
            pullCostX10: g.state.pullCostX10,
          }
        : null,
      screen: g.screen,
      lastResults: g.lastResults.map((r) => ({ unitId: r.unitId, name: r.name, rarity: r.rarity, pity: r.pity })),
    };
  });
}

function rosterTotal(roster: GachaRosterEntry[]): number {
  return roster.reduce((n, r) => n + r.count, 0);
}

async function main(): Promise<void> {
  const gameRoot = pathResolve(process.env.GAME_ROOT ?? "examples/gacha-game");
  const outDir = pathResolve(process.argv[2] ?? `${gameRoot}/_shots`);
  if (!existsSync(`${gameRoot}/server/src/index.ts`)) {
    throw new Error(`GAME_ROOT does not look like a gacha game (no server/src/index.ts): ${gameRoot}`);
  }
  mkdirSync(outDir, { recursive: true });

  const harness = await bootGenreCapture({
    gameRoot,
    // The gacha DOM client fetches the HTTP API from VITE_API_BASE.
    clientEnv: { VITE_API_BASE: "http://127.0.0.1:{{SERVER_PORT}}" },
    viewport: { width: 900, height: 900 },
  });

  try {
    // #auth-guest -> POST /api/guest -> Home screen renders.
    await clickGuest(harness.page);
    await harness.page.waitForFunction(
      () => {
        const g = (globalThis as { __GACHA?: { token: string; state: unknown } }).__GACHA;
        return Boolean(g?.token) && Boolean(g?.state);
      },
      null,
      { timeout: 20_000 },
    );
    // Home renders when the screen container shows the Home card.
    await harness.page.locator("#go-summon").waitFor({ state: "visible", timeout: 20_000 });
    const home = await readGacha(harness.page);
    if (!home?.state) throw new Error("gacha state missing after guest login");
    const currencyBefore = home.state.currency;
    const rosterBefore = rosterTotal(home.state.roster);
    console.log(`[gacha] guest joined; banner=${home.banner?.name} currency=${currencyBefore} roster=${rosterBefore}`);

    const homeShot = `${outDir}/gacha-home.png`;
    await harness.page.screenshot({ path: homeShot });

    // Navigate to Summon and do a 10-pull via the UI button (POST /api/summon).
    await harness.page.locator("#go-summon").click();
    await harness.page.locator("#pull10").waitFor({ state: "visible", timeout: 20_000 });
    await harness.page.locator("#pull10").click();

    // Wait for the summon to resolve: 10 results land in __GACHA.lastResults and
    // the currency drops by (at least) the x10 cost. Compare against the currency we
    // actually observed pre-pull (currencyBefore) rather than a hardcoded starting
    // balance, so this stays correct if the server's STARTING_CURRENCY ever changes.
    await harness.page.waitForFunction(
      ({ expectedCost, before }) => {
        const g = (globalThis as { __GACHA?: GachaGlobal }).__GACHA;
        return (g?.lastResults?.length ?? 0) >= 10 && typeof g?.state?.currency === "number" && g.state.currency <= before - expectedCost;
      },
      { expectedCost: home.state.pullCostX10, before: currencyBefore },
      { timeout: 20_000 },
    );
    // Let the result-reveal DOM paint before the screenshot.
    await harness.page.locator("#results .unit").first().waitFor({ state: "visible", timeout: 20_000 });
    const summonShot = `${outDir}/gacha-summon-results.png`;
    await harness.page.screenshot({ path: summonShot });

    const afterPull = await readGacha(harness.page);
    if (!afterPull?.state) throw new Error("gacha state missing after summon");
    const currencyAfter = afterPull.state.currency;
    const rosterAfter = rosterTotal(afterPull.state.roster);
    const pulled = afterPull.lastResults.length;

    // Assertions: currency decreased, roster grew.
    if (!(currencyAfter < currencyBefore)) {
      throw new Error(`currency did not decrease: before=${currencyBefore} after=${currencyAfter}`);
    }
    if (!(rosterAfter > rosterBefore)) {
      throw new Error(`roster did not grow: before=${rosterBefore} after=${rosterAfter}`);
    }
    if (pulled !== 10) {
      throw new Error(`expected 10 pull results, got ${pulled}`);
    }

    // Navigate to Roster and screenshot the owned units.
    await harness.page.locator("#nav-roster").click();
    await harness.page.waitForFunction(() => (globalThis as { __GACHA?: GachaGlobal }).__GACHA?.screen === "roster", null, { timeout: 20_000 });
    await harness.page.locator("#screen .grid .unit").first().waitFor({ state: "visible", timeout: 20_000 });
    const rosterShot = `${outDir}/gacha-roster.png`;
    await harness.page.screenshot({ path: rosterShot });

    if (harness.consoleErrors.length) {
      console.warn(`[gacha] browser console errors:\n${harness.consoleErrors.join("\n")}`);
    }

    console.log("\n=== GACHA CAPTURE PASSED ===");
    console.log(`10-pull: currency ${currencyBefore} -> ${currencyAfter} (spent ${currencyBefore - currencyAfter}); roster ${rosterBefore} -> ${rosterAfter} copies; ${pulled} units pulled`);
    console.log(`screenshots:\n  ${homeShot}\n  ${summonShot}\n  ${rosterShot}`);
  } finally {
    await harness.browser.close();
    await harness.stop();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});

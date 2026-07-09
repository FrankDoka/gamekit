/**
 * Live proof for the monster affix framework v1 (card-affix-framework).
 *
 * Boots the world server + client into map_harbor_outskirts (which has three
 * guaranteed-affix spawns authored in the layout source: swift dew_slime,
 * stout blossom_slime, gilded honey_slime), then reads the LIVE Colyseus state to prove:
 *   1. affixed monster instances carry the expected `affixId` on their synced schema;
 *   2. the server applied the stat multiplier to `maxHp` (stout scales blossom_slime 1.8x);
 *   3. non-stat affixes (swift/gilded) leave base hp untouched.
 *
 * The HUD name-prefix path (getMonsterDisplayName) is covered by a client unit test
 * (client/src/config/content.test.ts); this script proves the SERVER-authoritative half.
 *
 * Usage:  pnpm affix:proof   (writes tools/_capture/affix-proof/affix-live-proof.json)
 * This is a headless, deterministic gate — no owner screenshots needed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createSmokeHarness, stopChildProcesses } from "./smoke/harness";
import { ROOT } from "./smoke/constants";
import type { Page } from "@playwright/test";

type LiveAffixRow = {
  id: string;
  monsterId: string;
  affixId: string;
  hp: number;
  maxHp: number;
};

async function readAffixedMonsters(page: Page): Promise<LiveAffixRow[]> {
  return page.evaluate(() => {
    const scene = (globalThis as { __GAME?: { scene?: { getScene?(k: string): unknown } } }).__GAME?.scene?.getScene?.("game") as
      | { room?: { state?: { monsters?: { forEach(cb: (m: Record<string, unknown>, id: string) => void): void } } } }
      | undefined;
    const rows: LiveAffixRow[] = [];
    scene?.room?.state?.monsters?.forEach((monster, id) => {
      const affixId = String(monster.affixId ?? "");
      if (!affixId) return;
      rows.push({
        id,
        monsterId: String(monster.monsterId ?? ""),
        affixId,
        hp: Number(monster.hp),
        maxHp: Number(monster.maxHp),
      });
    });
    return rows;
  });
}

async function main(): Promise<void> {
  const outDir = `${ROOT}/tools/_capture/affix-proof`;
  mkdirSync(outDir, { recursive: true });
  const harness = await createSmokeHarness({ pageAQuery: "devMap=map_harbor_outskirts" });
  try {
    // Give the server a moment to finish spawning the full monster field.
    await harness.pageA.waitForTimeout(1500);
    const rows = await readAffixedMonsters(harness.pageA);

    const byAffix = new Map(rows.map((row) => [row.affixId, row]));
    const expect = (cond: boolean, msg: string) => {
      if (!cond) throw new Error(`affix proof FAILED: ${msg}\nlive rows=${JSON.stringify(rows, null, 2)}`);
    };

    expect(rows.length >= 3, `expected >=3 affixed monsters, saw ${rows.length}`);

    const swift = byAffix.get("affix_swift");
    const stout = byAffix.get("affix_stout");
    const gilded = byAffix.get("affix_gilded");
    expect(Boolean(swift), "no affix_swift instance live");
    expect(Boolean(stout), "no affix_stout instance live");
    expect(Boolean(gilded), "no affix_gilded instance live");

    // Modified stats: stout scales hp 1.8x. blossom_slime base hp = 50 -> round(50*1.8) = 90.
    expect(stout!.monsterId.includes("blossom_slime"), `stout not on blossom_slime: ${stout!.monsterId}`);
    expect(stout!.maxHp === 90, `stout maxHp expected 90 (50 base * 1.8), got ${stout!.maxHp}`);
    // gilded has no stat mod -> honey_slime base hp unchanged (68).
    expect(gilded!.monsterId.includes("honey_slime"), `gilded not on honey_slime: ${gilded!.monsterId}`);
    expect(gilded!.maxHp === 68, `gilded maxHp expected 68 (unchanged), got ${gilded!.maxHp}`);
    // swift has no hp mod -> dew_slime base hp unchanged (40).
    expect(swift!.monsterId.includes("dew_slime"), `swift not on dew_slime: ${swift!.monsterId}`);
    expect(swift!.maxHp === 40, `swift maxHp expected 40 (unchanged), got ${swift!.maxHp}`);

    const summary = { pass: true, rows };
    writeFileSync(`${outDir}/affix-live-proof.json`, JSON.stringify(summary, null, 2));
    console.log("[affix:proof] PASS");
    for (const row of rows) {
      console.log(`  ${row.affixId} (${row.monsterId}) maxHp=${row.maxHp}`);
    }
  } finally {
    await harness.browser.close();
    await stopChildProcesses();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

/**
 * card-npc-interact-flow scope-3 visual proof: screenshot the quest-offer panel for a quest that
 * grants NO rewards ({ xp: 0, gold: 0 }, e.g. Wayfarer Orders) and confirm the rewards block is
 * absent (no empty "X · 0 XP" chip), plus a second capture of a rewarding quest to show the block
 * still renders when rewards exist. Boots the same headless harness the client smoke uses.
 *
 * Usage: pnpm tsx tools/src/capture-quest-offer.ts [outDir]
 */
import { ROOT } from "./smoke/constants";
import { createSmokeHarness, stopChildProcesses } from "./smoke/harness";
import type { Page } from "@playwright/test";

const outDir = process.argv[2] ?? `${ROOT}/tools/captures/quest-offer`;

type OfferEvent = {
  type: "npc.dialogue";
  npcId: string;
  npcName: string;
  body: string;
  questId: string;
  questName: string;
  questStatus: "available";
  progress: number;
  required: number;
  rewardXp: number;
  rewardGold: number;
  choices: Array<{ id: string; label: string; action: "accept" | "close" }>;
};

function offer(rewardXp: number, rewardGold: number): OfferEvent {
  return {
    type: "npc.dialogue",
    npcId: "npc_capture_target",
    npcName: "Combat Trainer",
    body: "Bring your field record and choose which old order you will petition.",
    questId: "quest_wayfarer_orders",
    questName: "Petition the Orders",
    questStatus: "available",
    progress: 0,
    required: 1,
    rewardXp,
    rewardGold,
    choices: [
      { id: "accept", label: "Accept", action: "accept" },
      { id: "close", label: "Later", action: "close" },
    ],
  };
}

async function openOfferModal(page: Page, event: OfferEvent): Promise<void> {
  await page.evaluate((ev) => {
    const scene = (globalThis as { __GAME?: { scene?: { getScene?: (k: string) => unknown } } }).__GAME
      ?.scene?.getScene?.("game") as { qaShowDialogue?: (e: unknown) => void } | undefined;
    if (!scene?.qaShowDialogue) throw new Error("qaShowDialogue hook missing on game scene");
    scene.qaShowDialogue({ ...ev, serverTimeMs: Date.now() });
  }, event);
  // Click the dialogue's Accept choice to open the offer modal (the real render path).
  const panelOpen = await page.locator("#dialogue").waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false);
  if (!panelOpen) throw new Error("dialogue panel did not open after qaShowDialogue");
  const clicked = await page.evaluate(() => {
    type Btn = { textContent: string | null; click(): void };
    const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<Btn> } }).document;
    const button = Array.from(doc.querySelectorAll("#dialogue-choices button")).find((b) => b.textContent === "Accept");
    if (!button) return false;
    button.click();
    return true;
  });
  if (!clicked) throw new Error("Accept choice button not found in #dialogue-choices");
  await page.locator(".quest-offer-modal").waitFor({ state: "visible", timeout: 10_000 });
}

async function main(): Promise<void> {
  const fs = await import("node:fs");
  fs.mkdirSync(outDir, { recursive: true });
  const harness = await createSmokeHarness();
  const page = harness.pageA;

  try {
    // 1) No-reward quest: rewards block must be absent.
    await openOfferModal(page, offer(0, 0));
    const emptyRewardCards = await page.locator(".quest-offer-rewards").count();
    await page.locator(".quest-offer-modal").screenshot({ path: `${outDir}/offer-no-rewards.png` });
    // Reset the panel (JS click; the modal scrim sits above the game canvas).
    await page.evaluate(() => {
      const doc = (globalThis as unknown as { document: { querySelector(s: string): { click(): void } | null } }).document;
      doc.querySelector(".quest-offer-close")?.click();
    });
    await page.locator(".quest-offer-modal").waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);

    // 2) Rewarding quest: rewards block present (control).
    await openOfferModal(page, offer(50, 25));
    const rewardCards = await page.locator(".quest-offer-reward-card").count();
    await page.locator(".quest-offer-modal").screenshot({ path: `${outDir}/offer-with-rewards.png` });

    console.log(`[capture] offer-no-rewards.png rewardsBlockCount=${emptyRewardCards} (expected 0)`);
    console.log(`[capture] offer-with-rewards.png rewardCardCount=${rewardCards} (expected >=1)`);
    if (emptyRewardCards !== 0) throw new Error(`empty-reward quest still rendered a rewards block (${emptyRewardCards})`);
    if (rewardCards < 1) throw new Error(`rewarding quest rendered no reward card (${rewardCards})`);
    console.log(`[capture] PASS — screenshots in ${outDir}`);
  } finally {
    await harness.browser.close();
    await stopChildProcesses();
  }
}

main().catch((err) => {
  console.error("[capture] FAILED:", err);
  process.exitCode = 1;
  void stopChildProcesses();
});

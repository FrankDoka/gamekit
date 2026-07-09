/**
 * card-event-sfx-banner visual proof: screenshot the world-event banner shown on
 * a typed `worldEvent` start broadcast. Drives the real client handler
 * (GameScene.handleWorldEvent -> HudController.showEventBanner -> ZoneBanner) via
 * the qaShowWorldEvent QA hook, then captures the visible #arrival-title-overlay
 * lockup. Boots the same headless harness the client smoke uses (no admin/DB).
 *
 * Usage: pnpm tsx tools/src/capture-event-banner.ts [outDir]
 */
import { ROOT } from "./smoke/constants";
import { createSmokeHarness, stopChildProcesses } from "./smoke/harness";
import type { Page } from "@playwright/test";

const outDir = process.argv[2] ?? `${ROOT}/tools/captures/event-banner`;

type WorldEventStart = {
  type: "event.start";
  eventId: string;
  name: string;
  endsAtMs: number;
  serverTimeMs: number;
};

async function fireWorldEvent(page: Page, event: WorldEventStart): Promise<void> {
  await page.evaluate((ev) => {
    const scene = (globalThis as { __GAME?: { scene?: { getScene?: (k: string) => unknown } } }).__GAME
      ?.scene?.getScene?.("game") as { qaShowWorldEvent?: (e: unknown) => void } | undefined;
    if (!scene?.qaShowWorldEvent) throw new Error("qaShowWorldEvent hook missing on game scene");
    scene.qaShowWorldEvent(ev);
  }, event);
  // The banner fades in on the next animation frame; wait for is-visible.
  await page
    .locator("#arrival-title-overlay.is-visible")
    .waitFor({ state: "visible", timeout: 5_000 });
}

async function main(): Promise<void> {
  const fs = await import("node:fs");
  fs.mkdirSync(outDir, { recursive: true });
  const harness = await createSmokeHarness();
  const page = harness.pageA;

  try {
    await fireWorldEvent(page, {
      type: "event.start",
      eventId: "event_gold_rush",
      name: "Gold Rush",
      endsAtMs: Date.now() + 60_000,
      serverTimeMs: Date.now(),
    });
    const bannerText = await page.locator("#arrival-title-overlay").textContent();
    await page.screenshot({ path: `${outDir}/event-banner-start.png` });

    console.log(`[capture] event-banner-start.png bannerText=${JSON.stringify(bannerText)} (expected "Gold Rush")`);
    if (bannerText?.trim() !== "Gold Rush") {
      throw new Error(`event banner text mismatch: ${JSON.stringify(bannerText)}`);
    }
    console.log(`[capture] PASS — screenshot in ${outDir}`);
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

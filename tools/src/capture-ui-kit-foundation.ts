/**
 * UI Kit Foundation capture — headless proof for card-ui-kit-foundation (Phase 0 of
 * docs/design/ui-redesign-v2.md). Boots server+client via the standard smoke harness,
 * opens the throwaway kit-foundation demo window (frame primitive in all variants +
 * window open/close/Esc/backdrop + tooltip hover/focus/edge-flip), and screenshots
 * each state. This is the in-engine self-verification loop for this card only; delete
 * alongside `client/src/ui/kitFoundationDemo.ts` once a real consumer exists.
 *
 * Usage: tsx tools/src/capture-ui-kit-foundation.ts <outDir>
 */
import { mkdirSync } from "node:fs";
import { createSmokeHarness, stopChildProcesses } from "./smoke/harness";
import type { SmokeBrowserGlobal } from "./smoke/types";

type KitFoundationQaGlobal = typeof globalThis & {
  document: SmokeBrowserGlobal["document"];
  __GAMEKIT_QA__?: {
    openUiKitFoundationDemo?: () => void;
    closeUiKitFoundationDemo?: () => void;
  };
};

async function main(): Promise<void> {
  const outDir = process.argv[2] ?? "tools/_capture-ui-kit-foundation";
  mkdirSync(outDir, { recursive: true });

  const harness = await createSmokeHarness({});
  const page = harness.pageA;
  await page.waitForTimeout(500);

  const shoot = async (label: string): Promise<void> => {
    await page.screenshot({ path: `${outDir}/kit-${label}.png` });
    console.log(`[capture-ui-kit-foundation] ${label} -> ${outDir}/kit-${label}.png`);
  };

  // 1) Open the demo window: proves the frame primitive (panel/dock/chip visible
  // inline) + window header/title/close X + dimmed backdrop + cozy-bounce-in.
  await page.evaluate(() => {
    (globalThis as KitFoundationQaGlobal).__GAMEKIT_QA__?.openUiKitFoundationDemo?.();
  });
  await page.waitForTimeout(300);
  await shoot("window-open");

  // 2) Hover the tooltip anchor: proves pointer-hover trigger + chip frame variant.
  await page.hover("[data-kit-foundation-tooltip-anchor]");
  await page.waitForTimeout(200);
  await shoot("tooltip-hover");

  // 3) Move away, then Tab-focus the anchor: proves keyboard-focus trigger (distinct
  // code path from hover) without relying on mouse state.
  await page.mouse.move(5, 5);
  await page.waitForTimeout(150);
  await page.focus("[data-kit-foundation-tooltip-anchor]");
  await page.waitForTimeout(200);
  await shoot("tooltip-keyboard-focus");

  // 3b) Hover the bottom-right corner anchor: proves viewport-edge flipping. A
  // tooltip anchored there has no room below/right, so it must flip up/left
  // (asserted via the data-flip-y/-x attributes the tooltip core sets).
  await page.mouse.move(5, 5);
  await page.waitForTimeout(150);
  await page.hover("[data-kit-foundation-corner-anchor]");
  await page.waitForTimeout(150);
  const flip = await page.evaluate(() => {
    const el = (globalThis as KitFoundationQaGlobal).document.querySelector(".lm-tooltip-v2");
    return el?.dataset ? { flipY: el.dataset.flipY, flipX: el.dataset.flipX } : null;
  });
  console.log("[capture-ui-kit-foundation] corner tooltip flip state:", JSON.stringify(flip));
  if (flip?.flipY !== "up" || flip?.flipX !== "left") {
    throw new Error(`edge-flip not proven: expected {flipY:"up",flipX:"left"}, got ${JSON.stringify(flip)}`);
  }
  await shoot("tooltip-edge-flip");

  // 4) Esc closes the window: proves the Esc-to-close path.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await shoot("window-closed-esc");

  // 5) Re-open, then click the backdrop: proves the backdrop-click-to-close path.
  await page.evaluate(() => {
    (globalThis as KitFoundationQaGlobal).__GAMEKIT_QA__?.openUiKitFoundationDemo?.();
  });
  await page.waitForTimeout(300);
  await page.mouse.click(10, 10);
  await page.waitForTimeout(300);
  await shoot("window-closed-backdrop");

  await harness.browser.close();
  stopChildProcesses();
  console.log(`[capture-ui-kit-foundation] done -> ${outDir}`);
}

main().catch((err) => {
  console.error("[capture-ui-kit-foundation] FATAL:", err);
  stopChildProcesses();
  process.exit(1);
});

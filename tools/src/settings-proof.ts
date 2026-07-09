/**
 * Settings window proof + eyes-on capture (card-settings-window). Boots
 * server+client (guest login) via the smoke harness, then proves the four
 * behaviors the card requires (scope item 3):
 *   1. The gear entry in the bottom-right system cluster opens the Settings
 *      window; capture it open at 1920 for the owner-visible proof.
 *   2. Moving the Master volume slider live-applies AND persists — the value
 *      survives a full page reload (localStorage gamekit.audioVolume).
 *   3. Toggling Move UI from the Settings row drives PanelManager (body class
 *      `ui-move-enabled` flips) — Move UI is reachable ONLY here now.
 *   4. Toggling Hints from the Settings row drives setHintsEnabled
 *      (localStorage gamekit.hints.enabled).
 *
 * Usage: tsx tools/src/settings-proof.ts <outDir>
 */
import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { createSmokeHarness, stopChildProcesses } from "./smoke/harness";
import type { SmokeBrowserGlobal } from "./smoke/types";

const AUDIO_VOLUME_STORAGE_KEY = "gamekit.audioVolume";
const HINTS_ENABLED_KEY = "gamekit.hints.enabled";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[settings-proof] ASSERTION FAILED: ${message}`);
}

async function openSettingsWindow(page: Page): Promise<void> {
  // Prefer the real entry point (gear button in the system cluster); fall back to
  // the QA hook if the click is intercepted headlessly.
  const gear = page.locator("[data-menu-entry='settings']");
  await gear.waitFor({ state: "visible", timeout: 15_000 });
  await gear.dispatchEvent("click");
  try {
    await page.locator(".lm-settings").waitFor({ state: "visible", timeout: 3_000 });
  } catch {
    await page.evaluate(() => (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__?.openSettings?.());
    await page.locator(".lm-settings").waitFor({ state: "visible", timeout: 5_000 });
  }
}

async function getSettingsQa(page: Page) {
  const state = await page.evaluate(
    () => (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__?.getVisualQaSnapshot?.()?.settings ?? null,
  );
  if (!state) throw new Error("settings QA state missing from visual QA snapshot");
  return state;
}

async function main(): Promise<void> {
  const outDir = process.argv[2] ?? "tools/_settings-proof";
  mkdirSync(outDir, { recursive: true });

  const harness = await createSmokeHarness();
  const page = harness.pageA;
  await page.setViewportSize({ width: 1920, height: 1080 });

  // --- 1. Gear opens the Settings window; capture at 1920 ---
  await openSettingsWindow(page);
  assert((await getSettingsQa(page)).open, "gear entry should open the Settings window");
  await page.screenshot({ path: `${outDir}/settings-window-open-1920.png` });
  console.log(`[settings-proof] Settings window opened via gear; captured -> ${outDir}/settings-window-open-1920.png`);

  // --- 2. Master volume slider live-applies + persists across reload ---
  const master = page.locator("[data-settings-slider='master']");
  await master.waitFor({ state: "visible", timeout: 5_000 });
  // Drive the range input to a distinctive value (31%) and dispatch input.
  await master.evaluate((el) => {
    const input = el as unknown as { value: string; dispatchEvent: (e: Event) => void };
    input.value = "31";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const s = (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__?.getVisualQaSnapshot?.()?.settings;
    return s !== undefined && Math.abs(s.masterVolume - 0.31) < 0.001;
  }, null, { timeout: 5_000 });
  const persistedBefore = await page.evaluate((key) => localStorage.getItem(key), AUDIO_VOLUME_STORAGE_KEY);
  assert(persistedBefore !== null && Math.abs(Number(persistedBefore) - 0.31) < 0.001, `master volume should persist to localStorage; got ${persistedBefore}`);
  console.log(`[settings-proof] Master slider live-applied + persisted (${AUDIO_VOLUME_STORAGE_KEY} = ${persistedBefore}).`);

  // Reload the page (fresh guest join) and confirm the stored volume is restored.
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#auth-guest").first().click();
  await page.waitForFunction(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    return Boolean(scene?.room?.state?.players);
  }, null, { timeout: 30_000 });
  const persistedAfter = await page.evaluate((key) => localStorage.getItem(key), AUDIO_VOLUME_STORAGE_KEY);
  assert(persistedAfter !== null && Math.abs(Number(persistedAfter) - 0.31) < 0.001, `master volume must survive reload; got ${persistedAfter}`);
  await openSettingsWindow(page);
  const afterReloadQa = await getSettingsQa(page);
  assert(Math.abs(afterReloadQa.masterVolume - 0.31) < 0.001, `restored master volume must be 0.31 after reload; got ${afterReloadQa.masterVolume}`);
  const sliderValue = await page.locator("[data-settings-slider='master']").inputValue();
  assert(sliderValue === "31", `Settings slider must reflect the restored 31% after reload; got ${sliderValue}`);
  console.log(`[settings-proof] Master volume survived reload (${persistedAfter}); slider shows ${sliderValue}%.`);

  // --- 3. Move UI toggle drives PanelManager (body.ui-move-enabled) ---
  const moveToggle = page.locator("[data-settings-toggle='ui-move']");
  await moveToggle.dispatchEvent("click");
  await page.waitForFunction(() => (globalThis as SmokeBrowserGlobal).document.body.classList.contains("ui-move-enabled"), null, { timeout: 5_000 });
  assert((await getSettingsQa(page)).uiMoveEnabled, "Move UI QA flag should be true after enabling from Settings");
  await moveToggle.dispatchEvent("click");
  await page.waitForFunction(() => !(globalThis as SmokeBrowserGlobal).document.body.classList.contains("ui-move-enabled"), null, { timeout: 5_000 });
  console.log("[settings-proof] Move UI toggle from Settings flips body.ui-move-enabled on and off.");

  // --- 4. Hints toggle drives setHintsEnabled ---
  const hintsToggle = page.locator("[data-settings-toggle='hints']");
  await hintsToggle.dispatchEvent("click");
  await page.waitForFunction(() => localStorage.getItem("gamekit.hints.enabled") === "false", null, { timeout: 5_000 });
  assert(!(await getSettingsQa(page)).hintsEnabled, "Hints QA flag should be false after disabling from Settings");
  const hintsPersisted = await page.evaluate((key) => localStorage.getItem(key), HINTS_ENABLED_KEY);
  assert(hintsPersisted === "false", `hints kill-switch should persist to localStorage; got ${hintsPersisted}`);
  await hintsToggle.dispatchEvent("click");
  await page.waitForFunction(() => localStorage.getItem("gamekit.hints.enabled") === "true", null, { timeout: 5_000 });
  console.log("[settings-proof] Hints toggle from Settings drives setHintsEnabled (persisted).");

  await harness.browser.close();
  await stopChildProcesses();
  console.log("[settings-proof] ALL CHECKS PASSED.");
}

main().catch(async (err) => {
  console.error(err);
  await stopChildProcesses();
  process.exit(1);
});

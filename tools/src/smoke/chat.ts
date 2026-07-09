import type { Page } from "@playwright/test";
import { TIMEOUT } from "./constants";
import type { SmokeBrowserGlobal } from "./types";

export async function verifyWorldChat(pageA: Page, pageB: Page): Promise<void> {
  const message = `smoke chat ${Date.now()}`;

  await waitForLoginSystemMessage(pageB);
  await verifyChatInputCapturesWasd(pageA);
  await pageA.locator(".hud-chat-input").fill(message);
  await pageA.keyboard.press("Enter");
  await waitForChatFocusReleased(pageA);

  await pageB.waitForFunction((expected) => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const messages = Array.from(doc.querySelectorAll(".hud-chat-message"));
    return messages.some((candidate) => candidate.textContent?.includes(expected));
  }, message, { timeout: TIMEOUT });

  await pageB.waitForFunction((expected) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const bubbles: Array<{ message: string; container?: { visible: boolean } }> = [];
    scene?.chatBubbles?.forEach((bubble) => bubbles.push(bubble));
    return bubbles.some((bubble) => bubble.message === expected && bubble.container?.visible !== false);
  }, message, { timeout: TIMEOUT });

  await verifyChatRateLimitFeedback(pageA);

  console.log(`[smoke] Chat: page B received "${message}" with an overhead bubble and page A saw flood feedback.`);
}

async function waitForChatFocusReleased(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const active = doc.activeElement;
    const chatPanel = doc.getElementById("hud-chat-panel");
    return !active || !chatPanel?.contains(active);
  }, null, { timeout: TIMEOUT });
}

async function waitForLoginSystemMessage(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const messages = Array.from(doc.querySelectorAll(".hud-chat-system"));
    return messages.some((candidate) => candidate.textContent?.includes("logged in"));
  }, null, { timeout: TIMEOUT });
}

/** Chat RESTS collapsed as the pill since session 18 — expand it before any
 * interaction with the input (the input is hidden while collapsed). */
export async function ensureChatExpanded(page: Page): Promise<void> {
  const pill = page.locator(".hud-chat-pill:not([hidden])");
  if ((await pill.count()) > 0 && (await pill.isVisible())) {
    await pill.click();
    await page.locator(".hud-chat-input").waitFor({ state: "visible", timeout: TIMEOUT });
  }
}

async function verifyChatInputCapturesWasd(page: Page): Promise<void> {
  await ensureChatExpanded(page);
  // The player may still be pathing from the previous step (click-to-move settles
  // asynchronously), and residual travel reads as leaked input in the movement
  // assertion below. Q1's faster quest-gate step exposed this (2026-07-02): assert
  // from a stationary player so the check isolates actual WASD leakage.
  await waitForLocalPlayerStationary(page);
  const before = await getLocalPlayerPosition(page);
  const input = page.locator(".hud-chat-input");
  await input.click();
  await page.keyboard.type("wasd space");
  await page.waitForTimeout(350);

  const inputValue = await input.inputValue();
  if (inputValue !== "wasd space") {
    throw new Error(`chat input did not capture WASD/space text; value=${JSON.stringify(inputValue)}`);
  }

  const after = await getLocalPlayerPosition(page);
  const distance = Math.hypot(after.x - before.x, after.y - before.y);
  if (distance > 8) {
    throw new Error(`player moved while typing WASD in chat: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }
}

async function waitForLocalPlayerStationary(page: Page): Promise<void> {
  const deadline = Date.now() + TIMEOUT;
  let prev = await getLocalPlayerPosition(page);
  while (Date.now() < deadline) {
    await page.waitForTimeout(300);
    const next = await getLocalPlayerPosition(page);
    if (Math.hypot(next.x - prev.x, next.y - prev.y) < 1) return;
    prev = next;
  }
  throw new Error("player never became stationary before the chat WASD capture test");
}

async function verifyChatRateLimitFeedback(page: Page): Promise<void> {
  const input = page.locator(".hud-chat-input");
  for (let i = 0; i < 6; i += 1) {
    await input.fill(`flood smoke ${Date.now()} ${i}`);
    await page.keyboard.press("Enter");
  }

  await page.waitForFunction(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const toasts = Array.from(doc.querySelectorAll(".lm-toast__message"));
    const hasToast = toasts.some((el) => el.textContent?.includes("Slow down chat"));
    const systemMessages = Array.from(doc.querySelectorAll(".hud-chat-system"));
    return hasToast || systemMessages.some((candidate) => candidate.textContent?.includes("Slow down"));
  }, null, { timeout: TIMEOUT });
}

async function getLocalPlayerPosition(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    if (!player) throw new Error("missing local player");
    return { x: player.x, y: player.y };
  });
}

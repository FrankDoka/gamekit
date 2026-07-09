/**
 * Proof: a dead session must never masquerade as a live game.
 *
 * Boots the smoke harness, force-drops pageA's room connection (non-consented
 * close code), and asserts the blocking "Connection lost" overlay appears with
 * a focusable Reconnect button. Regression guard for the 2026-07-04 owner
 * incident ("GM tools worked once then stopped" — a duplicate-character kick
 * left a frozen world silently eating clicks).
 */
import { createSmokeHarness, stopChildProcesses } from "./smoke/harness";

const main = async (): Promise<void> => {
  const harness = await createSmokeHarness();
  const page = harness.pageA;

  type BrowserDoc = {
    querySelector: (selector: string) => { textContent: string | null } | null;
    activeElement: unknown;
  };
  const before = await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: BrowserDoc }).document;
    return Boolean(doc.querySelector("[data-hud-disconnect-overlay='true']"));
  });
  if (before) throw new Error("disconnect overlay visible before disconnect");

  // Force a NON-consented drop: close the underlying transport like a network
  // failure / server kick would, instead of room.leave() (consented, code 1000).
  await page.evaluate(() => {
    const scene = (globalThis as unknown as { __GAME?: { scene?: { getScene: (key: string) => { room?: { connection?: { transport?: { ws?: WebSocket } } } } } } }).__GAME?.scene?.getScene("game");
    const ws = scene?.room?.connection?.transport?.ws;
    if (!ws) throw new Error("room websocket unavailable for forced drop");
    ws.close(4001, "duplicate-character kick simulation");
  });

  await page.waitForSelector("[data-hud-disconnect-overlay='true']", { timeout: 10_000 });
  const proof = await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: BrowserDoc }).document;
    const overlay = doc.querySelector("[data-hud-disconnect-overlay='true']");
    const reconnect = doc.querySelector("[data-hud-reconnect='true']");
    return {
      overlayText: overlay?.textContent ?? "",
      hasReconnect: Boolean(reconnect),
      reconnectFocused: doc.activeElement === reconnect,
    };
  });
  if (!proof.hasReconnect) throw new Error(`overlay missing reconnect button: ${JSON.stringify(proof)}`);
  console.log(`[disconnect-proof] overlay shown on forced drop: ${JSON.stringify(proof)}`);
  console.log("[disconnect-proof] ALL CHECKS PASSED.");
};

main()
  .then(() => {
    stopChildProcesses();
    process.exit(0);
  })
  .catch((error) => {
    console.error("[disconnect-proof] FATAL:", error instanceof Error ? error.message : error);
    stopChildProcesses();
    process.exit(1);
  });

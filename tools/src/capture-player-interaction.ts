/**
 * Two-client capture proof for card-player-interaction (§4(c)/§5).
 *
 * HARD-ASSERTS the player-interaction UX added to fix play-test finding #18:
 *   1. Clicking another player on page A renders the interaction context menu
 *      (`.lm-player-menu`) — a player click no longer routes to combat targeting.
 *   2. Choosing "Invite to Party" makes the invite intent hit the server: page B
 *      (the target) receives the `party.invited` toast, which only appears after
 *      the server processes and broadcasts the invite.
 *
 * Writes proof JSON + screenshots (menu open, invite sent, invitee prompt) and
 * exits non-zero if either assertion fails.
 *
 * Usage:  pnpm capture:player-interaction [outDir]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "@playwright/test";
import { createSmokeHarness, stopChildProcesses } from "./smoke/harness";
import { moveLocalPlayerNear } from "./smoke/movement";
import type { SmokeBrowserGlobal } from "./smoke/types";

// `document` is real inside page.evaluate()/waitForFunction (browser context); the tools
// tsconfig has no DOM lib, so declare it here the same way capture-hints.ts does.
declare const document: any; // eslint-disable-line @typescript-eslint/no-explicit-any

type Proof = {
  generatedAt: string;
  cwd: string;
  localSessionA: string;
  localSessionB: string;
  menuEntries: string[];
  inviteTargetSessionId: string;
  screenshots: { menuOpen: string; inviteSent: string; inviteePrompt: string };
  assertions: {
    contextMenuRendered: boolean;
    inviteIntentReachedServer: boolean;
    noCombatInvalidTargetToast: boolean;
  };
};

/** Page-A screen coordinate of another player's sprite (mirrors smoke/click-targets). */
async function playerScreenPoint(page: Page, sessionId: string): Promise<{ screenX: number; screenY: number }> {
  return page.evaluate((wantedId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene.getScene("game");
    if (!scene?.cameras?.main) throw new Error("game scene unavailable");
    const camera = scene.cameras.main;
    const canvasRect = scene.game.canvas.getBoundingClientRect();
    const viewWidth = Number(scene.scale.width ?? scene.game.config.width);
    const viewHeight = Number(scene.scale.height ?? scene.game.config.height);
    const scaleX = canvasRect.width / viewWidth;
    const scaleY = canvasRect.height / viewHeight;
    const player = scene.room.state.players.get(wantedId);
    const render = scene.playerObjects.get(wantedId) as
      | { container: { visible: boolean }; sprite?: { getBounds?(): { centerX: number; centerY: number } } }
      | undefined;
    if (!player || !render?.container.visible) throw new Error(`player ${wantedId} not visible on page A`);
    // Aim at the sprite's bounds center — that is exactly what the client's
    // getPlayerIdAtWorldPoint hit-tests against (render.sprite.getBounds().contains).
    const bounds = render.sprite?.getBounds?.();
    const worldX = bounds?.centerX ?? (render as unknown as { container: { x: number } }).container.x;
    const worldY = bounds?.centerY ?? (render as unknown as { container: { y: number } }).container.y;
    return {
      screenX: canvasRect.left + (worldX - camera.worldView.x) * camera.zoom * scaleX,
      screenY: canvasRect.top + (worldY - camera.worldView.y) * camera.zoom * scaleY,
    };
  }, sessionId);
}

export async function runPlayerInteractionProof(outDirArg = "tools/_capture/player-interaction"): Promise<void> {
  const outDir = resolve(outDirArg).replace(/\\/g, "/");
  mkdirSync(outDir, { recursive: true });
  const harness = await createSmokeHarness();
  const screenshots = {
    menuOpen: `${outDir}/menu-open.png`,
    inviteSent: `${outDir}/invite-sent.png`,
    inviteePrompt: `${outDir}/invitee-prompt.png`,
  };

  try {
    const { pageA, pageB, joinedA, joinedB } = harness;

    // Bring B next to A so A can click B's sprite within the viewport.
    const anchor = await pageA.evaluate(() => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene.getScene("game");
      const p = scene.room.state.players.get(scene.localSessionId);
      return { x: p.x, y: p.y };
    });
    await moveLocalPlayerNear(pageB, anchor.x + 60, anchor.y, 40, 30_000);
    await pageA.waitForTimeout(400);

    // 1) Click B's sprite on page A -> context menu must render.
    const point = await playerScreenPoint(pageA, joinedB.localSessionId);
    await pageA.mouse.click(point.screenX, point.screenY);
    await pageA.waitForSelector(".lm-player-menu", { timeout: 5_000 });
    const menuEntries = await pageA.$$eval(".lm-player-menu__item", (els) => els.map((e) => e.textContent ?? ""));
    const contextMenuRendered = menuEntries.length >= 3;
    await pageA.screenshot({ path: screenshots.menuOpen });

    // A player click must NOT produce a combat "Invalid target" toast (finding #18).
    const invalidToast = await pageA.$(".lm-toast-container .lm-toast--warning");
    const invalidText = invalidToast ? (await invalidToast.textContent()) ?? "" : "";
    const noCombatInvalidTargetToast = !invalidText.includes("Invalid target");

    // 2) Invite to Party -> intent reaches server -> B gets the invited toast.
    await pageA.click(".lm-player-menu__item--invite");
    await pageA.screenshot({ path: screenshots.inviteSent });
    let inviteIntentReachedServer = false;
    try {
      await pageB.waitForFunction(() => {
        const nodes = Array.from(document.querySelectorAll(".lm-toast-container .lm-toast")) as Array<{ textContent: string | null }>;
        return nodes.some((n) => (n.textContent ?? "").includes("invited you to a party"));
      }, undefined, { timeout: 8_000 });
      inviteIntentReachedServer = true;
    } catch {
      inviteIntentReachedServer = false;
    }
    await pageB.screenshot({ path: screenshots.inviteePrompt });

    const proof: Proof = {
      generatedAt: new Date().toISOString(),
      cwd: process.cwd().replace(/\\/g, "/"),
      localSessionA: joinedA.localSessionId,
      localSessionB: joinedB.localSessionId,
      menuEntries,
      inviteTargetSessionId: joinedB.localSessionId,
      screenshots,
      assertions: { contextMenuRendered, inviteIntentReachedServer, noCombatInvalidTargetToast },
    };
    writeFileSync(`${outDir}/player-interaction-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
    console.log(`[player-interaction-proof] wrote ${outDir}/player-interaction-proof.json`);
    console.log(`[player-interaction-proof] menu entries: ${menuEntries.join(", ")}`);

    if (!contextMenuRendered) throw new Error("context menu did not render on player click");
    if (!noCombatInvalidTargetToast) throw new Error("player click produced a combat 'Invalid target' toast");
    if (!inviteIntentReachedServer) throw new Error("invite intent did not reach the server (invitee never got the prompt)");
    if (harness.consoleErrors.length > 0) throw new Error(`console errors: ${harness.consoleErrors.join(" | ")}`);
    console.log("[player-interaction-proof] ALL ASSERTIONS PASSED.");
  } finally {
    await harness.browser.close().catch(() => undefined);
    await stopChildProcesses();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPlayerInteractionProof(process.argv[2] ?? "tools/_capture/player-interaction").catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    stopChildProcesses().finally(() => process.exit(1));
  });
}

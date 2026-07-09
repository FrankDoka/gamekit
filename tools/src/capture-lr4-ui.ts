/**
 * card-lr4-ui-pickups-hotbar proof capture. Boots server+client (guest login) via
 * the smoke harness, then proves the two owner UI findings in the REAL client DOM:
 *
 *  1. Mining a copper node surfaces the yield in the TOP pickup toast (top-center
 *     rich `item-received` toast), not chat-only. Drives a real world.interact on a
 *     live ore node and screenshots the resulting toast.
 *  2. The Assign-to-hotbar picker renders the ACTUAL icons of occupied slots (the
 *     same getBindingIcon source the live hotbar uses), keycap letters intact.
 *     Opens the picker via the hotbar assign button and screenshots the grid.
 *
 * Usage: tsx tools/src/capture-lr4-ui.ts <outDir>
 */
import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { PLAYER_FOOT_OFFSET_Y } from "@gamekit/game-contract";
import { createSmokeHarness, stopChildProcesses } from "./smoke/harness";
import { sendWorldInteractIntent } from "./smoke/intents";
import { moveLocalPlayerNear } from "./smoke/movement";
import { getSmokeState } from "./smoke/state";
import type { SmokeBrowserGlobal } from "./smoke/types";

const VIEWPORT = { width: 1280, height: 720 };

type OreNodeLite = { id: string; x: number; y: number; radius: number; depleted: boolean; mapId: string };

/** Read live ore nodes for the local player's map directly from room state
 * (getSmokeState does not project oreNodes). */
async function readOreNodes(page: Page, mapId: string): Promise<OreNodeLite[]> {
  return page.evaluate((wantMap) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game") as
      | { room?: { state?: { oreNodes?: { forEach(cb: (n: OreNodeLite) => void): void } } } }
      | undefined;
    const out: OreNodeLite[] = [];
    scene?.room?.state?.oreNodes?.forEach((n: OreNodeLite) => {
      if (n.mapId === wantMap && !n.depleted) {
        out.push({ id: n.id, x: n.x, y: n.y, radius: n.radius, depleted: n.depleted, mapId: n.mapId });
      }
    });
    return out;
  }, mapId);
}

async function main(): Promise<void> {
  const outDir = process.argv[2] ?? "tools/_capture-lr4-ui";
  mkdirSync(outDir, { recursive: true });

  const harness = await createSmokeHarness();
  const page = harness.pageA;
  const sessionId = harness.joinedA.localSessionId;
  await page.setViewportSize(VIEWPORT);
  await page.waitForTimeout(800);

  const shoot = async (label: string): Promise<void> => {
    await page.screenshot({ path: `${outDir}/lr4-${label}.png` });
    console.log(`[capture-lr4-ui] ${label} -> ${outDir}/lr4-${label}.png`);
  };

  // ── Finding 2: Assign-to-hotbar picker shows real occupied-slot icons ──
  // Default smoke bindings are skill_spark_shot (1), skill_lantern_burst (2) and
  // item_minor_health_potion (3) — all icon-backed, so occupied slots must render
  // <img.hotbar-assign-slot-icon> not a text abbreviation.
  const assignButton = page.locator(".hotbar-slot .hotbar-bind").first();
  await assignButton.waitFor({ state: "visible", timeout: 15_000 });
  await assignButton.click();
  await page.locator(".hotbar-assign-scrim").waitFor({ state: "visible", timeout: 5_000 });
  await page.waitForTimeout(300);
  const iconCount = await page.locator(".hotbar-assign-slot-icon").count();
  const abbrevLabels = await page
    .locator(".hotbar-assign-slot.is-filled .hotbar-assign-slot-label")
    .count();
  console.log(`[capture-lr4-ui] assign picker: ${iconCount} real slot icons, ${abbrevLabels} filled-slot text labels`);
  if (iconCount < 1) throw new Error("assign picker rendered no real slot icons (finding 2 not proven)");
  if (abbrevLabels > 0) throw new Error("a filled slot still shows a text abbreviation instead of its icon");
  await shoot("assign-dialog-icons");
  // Close the picker before world interaction.
  await page.locator(".hotbar-assign-close").first().click();
  await page.waitForTimeout(200);

  // ── Finding 1: Mining a node surfaces the yield in the top pickup toast ──
  const state = await getSmokeState(page);
  const player = state?.players.find((p) => p.sessionId === sessionId);
  if (!player) throw new Error("local player not found for mining capture");
  const nodes = await readOreNodes(page, player.mapId);
  console.log(`[capture-lr4-ui] ${nodes.length} live ore node(s) on ${player.mapId}: ${nodes.map((n) => `${n.id}@(${Math.round(n.x)},${Math.round(n.y)}) r${n.radius}`).join(", ")}`);
  if (nodes.length === 0) throw new Error(`no live ore nodes on map ${player.mapId} for mining capture`);
  // Nearest first — each node depletes after one mine, so walk the list until one lands.
  nodes.sort((a, b) => Math.hypot(a.x - player.x, a.y - player.y) - Math.hypot(b.x - player.x, b.y - player.y));

  page.on("console", (msg) => {
    const t = msg.text();
    if (t.includes("gather") || t.includes("interact") || t.includes("mined") || t.includes("OUT_OF_RANGE")) {
      console.log(`[browser] ${t}`);
    }
  });

  let toastShown = false;
  for (const node of nodes) {
    if (toastShown) break;
    // The server measures range from the player's FOOT point (player.y + foot
    // offset), so aim the player's center ~foot-offset ABOVE the node to land the
    // foot inside the radius — mirrors the client's own isWithinGatherRange.
    const standY = node.y - PLAYER_FOOT_OFFSET_Y;
    await moveLocalPlayerNear(page, node.x, standY, Math.max(12, node.radius * 0.5)).catch(() => {});
    await page.waitForTimeout(300);
    const cur = (await getSmokeState(page))?.players.find((p) => p.sessionId === sessionId);
    console.log(`[capture-lr4-ui] mining ${node.id}; player at (${Math.round(cur?.x ?? 0)},${Math.round(cur?.y ?? 0)}) foot (${Math.round(cur?.x ?? 0)},${Math.round((cur?.y ?? 0) + PLAYER_FOOT_OFFSET_Y)}) node (${Math.round(node.x)},${Math.round(node.y)}) r${node.radius}`);
    for (let attempt = 0; attempt < 3 && !toastShown; attempt += 1) {
      await sendWorldInteractIntent(page, node.id);
      try {
        await page
          .locator(".lm-toast-container--top-center .lm-toast--item-received")
          .first()
          .waitFor({ state: "visible", timeout: 2000 });
        toastShown = true;
      } catch {
        await page.waitForTimeout(200);
      }
    }
  }
  if (!toastShown) throw new Error("mining did not surface a top-center item-received toast (finding 1 not proven)");
  await page.waitForTimeout(200);
  await shoot("mining-top-toast");

  await harness.browser.close();
  await stopChildProcesses();
  console.log(`[capture-lr4-ui] done -> ${outDir}`);
}

main().catch((err) => {
  console.error("[capture-lr4-ui] FATAL:", err);
  stopChildProcesses();
  process.exit(1);
});

import type { Page } from "@playwright/test";
import {
  FIELD_MAP_ID,
  FIELD_TO_HARBOR_PORTAL_ID,
  FIELD_TO_HARBOR_PORTAL_TARGET_Y,
  FIELD_TO_HARBOR_PORTAL_X,
  BLOOMVALE_TO_LANTERNWAKE_PORTAL_ID,
  BLOOMVALE_TO_LANTERNWAKE_PORTAL_TARGET_Y,
  BLOOMVALE_TO_LANTERNWAKE_PORTAL_X,
  HARBOR_TO_FIELD_PORTAL_ID,
  HARBOR_MAP_ID,
  LANTERNWAKE_MAP_ID,
  LANTERNWAKE_TO_BLOOMVALE_PORTAL_ID,
  LANTERNWAKE_TO_BLOOMVALE_PORTAL_TARGET_Y,
  LANTERNWAKE_TO_BLOOMVALE_PORTAL_X,
  PORTAL_TARGET_Y,
  PORTAL_X,
  SECOND_ZONE_MAP_ID,
  SECOND_ZONE_PORTAL_ID,
  SECOND_ZONE_PORTAL_TARGET_Y,
  SECOND_ZONE_PORTAL_X,
} from "./constants";
import { sendMoveIntent, sendPortalUseIntent } from "./intents";
import { moveLocalPlayerNear } from "./movement";
import { getSmokeState, waitForRenderedCount } from "./state";
import type { JoinedSmokeState, SmokeBrowserGlobal } from "./types";

type PortalRoute = {
  portalId: string;
  x: number;
  /** Move target y (portal y minus the player foot offset). */
  footY: number;
  targetMapId: string;
  waypoints?: Array<{ x: number; footY: number }>;
};

const HARBOR_TO_FIELD_ROUTE: PortalRoute = {
  portalId: HARBOR_TO_FIELD_PORTAL_ID,
  x: PORTAL_X,
  footY: PORTAL_TARGET_Y,
  targetMapId: FIELD_MAP_ID,
  // The leg into this waypoint starts near (660,460) (end of
  // verifyReplicatedMovement's mouse-hold check) — that point sits just outside
  // the bloomvale_windmill's "structure"-class collision box (world rect
  // x[506,664] y[399,498], content/asset-editor-metadata.json
  // placementClasses.structure). A straight line from there to the old (500,650)
  // waypoint clipped the box's south-west corner (smoke mover has no
  // pathfinding). (600,660) clears the windmill box and the plaza barrel's
  // "container"-class box (x[544,608] y[576,608]) on both legs
  // (card-smoke-warden-path, 2026-07-05).
  waypoints: [{ x: 600, footY: 660 }],
};

const FIELD_TO_HARBOR_ROUTE: PortalRoute = {
  portalId: FIELD_TO_HARBOR_PORTAL_ID,
  x: FIELD_TO_HARBOR_PORTAL_X,
  footY: FIELD_TO_HARBOR_PORTAL_TARGET_Y,
  targetMapId: HARBOR_MAP_ID,
};

const FIELD_TO_SECOND_ZONE_ROUTE: PortalRoute = {
  portalId: SECOND_ZONE_PORTAL_ID,
  x: SECOND_ZONE_PORTAL_X,
  footY: SECOND_ZONE_PORTAL_TARGET_Y,
  targetMapId: SECOND_ZONE_MAP_ID,
};

const BLOOMVALE_TO_LANTERNWAKE_ROUTE: PortalRoute = {
  portalId: BLOOMVALE_TO_LANTERNWAKE_PORTAL_ID,
  x: BLOOMVALE_TO_LANTERNWAKE_PORTAL_X,
  footY: BLOOMVALE_TO_LANTERNWAKE_PORTAL_TARGET_Y,
  targetMapId: LANTERNWAKE_MAP_ID,
  waypoints: [
    { x: 900, footY: 760 },
    { x: 1500, footY: 760 },
    { x: 1900, footY: 700 },
  ],
};

const LANTERNWAKE_TO_BLOOMVALE_ROUTE: PortalRoute = {
  portalId: LANTERNWAKE_TO_BLOOMVALE_PORTAL_ID,
  x: LANTERNWAKE_TO_BLOOMVALE_PORTAL_X,
  footY: LANTERNWAKE_TO_BLOOMVALE_PORTAL_TARGET_Y,
  targetMapId: HARBOR_MAP_ID,
};

export async function verifyPortalTransition(pageA: Page, pageB: Page, joinedA: JoinedSmokeState): Promise<void> {
  await verifyPortalRoute(pageA, pageB, joinedA, HARBOR_TO_FIELD_ROUTE, "Portal transition");
}

export async function verifyPortalRoundTrip(page: Page): Promise<void> {
  await traversePortal(page, HARBOR_TO_FIELD_ROUTE);
  await waitForLoadingOverlayHidden(page);
  await assertLocalMap(page, FIELD_MAP_ID, "Portal outbound");
  await traversePortal(page, FIELD_TO_HARBOR_ROUTE);
  await assertLocalMap(page, HARBOR_MAP_ID, "Portal return");
  console.log(`[smoke] Portal round-trip: ${HARBOR_MAP_ID} -> ${FIELD_MAP_ID} -> ${HARBOR_MAP_ID}.`);
}

export async function verifySecondZonePortal(pageA: Page, pageB: Page, joinedA: JoinedSmokeState): Promise<void> {
  await verifyPortalRoute(pageA, pageB, joinedA, FIELD_TO_SECOND_ZONE_ROUTE, "Second zone portal");
}

export async function travelBloomvaleToLanternwake(page: Page): Promise<void> {
  await traversePortal(page, BLOOMVALE_TO_LANTERNWAKE_ROUTE);
  await assertLocalMap(page, LANTERNWAKE_MAP_ID, "Lanternwake outbound");
}

export async function travelLanternwakeToBloomvale(page: Page): Promise<void> {
  await traversePortal(page, LANTERNWAKE_TO_BLOOMVALE_ROUTE);
  await assertLocalMap(page, HARBOR_MAP_ID, "Lanternwake return");
  console.log(`[smoke] Lanternwake portal return: ${LANTERNWAKE_MAP_ID} -> ${HARBOR_MAP_ID}.`);
}

/** Walk into a portal (with portal.use fallback) and wait for the map change. */
export async function travelThroughPortal(
  page: Page,
  portalId: string,
  x: number,
  footY: number,
  targetMapId: string,
): Promise<void> {
  const route: PortalRoute = {
    portalId,
    x,
    footY,
    targetMapId,
    waypoints: portalId === HARBOR_TO_FIELD_ROUTE.portalId ? HARBOR_TO_FIELD_ROUTE.waypoints : undefined,
  };
  await traversePortal(page, route);
}

async function verifyPortalRoute(
  pageA: Page,
  pageB: Page,
  joinedA: JoinedSmokeState,
  route: PortalRoute,
  label: string,
): Promise<void> {
  await traversePortal(pageA, route);

  const stateAAfterPortal = await getSmokeState(pageA);
  const stateBAfterPortal = await waitForRenderedCount(pageB, 1);
  const pageAAfterPortal = stateAAfterPortal?.players.find((player) => player.sessionId === joinedA.localSessionId);
  if (pageAAfterPortal?.mapId !== route.targetMapId || stateAAfterPortal?.renderedCount !== 1 || stateBAfterPortal.renderedCount !== 1) {
    throw new Error(
      `${label} failed: pageA=${JSON.stringify(stateAAfterPortal)}, pageB=${JSON.stringify(stateBAfterPortal)}`,
    );
  }
  console.log(`[smoke] ${label}: page A arrived on ${pageAAfterPortal.mapId}; page B now renders only its own map.`);
}

async function traversePortal(page: Page, route: PortalRoute): Promise<void> {
  for (const waypoint of route.waypoints ?? []) {
    if (await isOnMap(page, route.targetMapId)) return;
    await moveLocalPlayerNear(page, waypoint.x, waypoint.footY, 28, 12_000);
  }
  if (!(await waitForPortalReadyOrTransition(page, route))) {
    await sendPortalUseIntent(page, route.portalId);
  }
  await page.waitForFunction((targetMapId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    return player?.mapId === targetMapId;
  }, route.targetMapId, { timeout: 15_000 });
}

async function assertLocalMap(page: Page, mapId: string, label: string): Promise<void> {
  const state = await getSmokeState(page);
  const local = state?.players.find((player) => player.sessionId === state.localSessionId);
  if (local?.mapId !== mapId) {
    throw new Error(`${label} failed: expected ${mapId}, state=${JSON.stringify(state)}`);
  }
}

async function waitForLoadingOverlayHidden(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const overlay = (globalThis as SmokeBrowserGlobal).document.getElementById("loading-overlay");
    return !overlay || Boolean((overlay as { hidden?: boolean }).hidden);
  }, undefined, { timeout: 15_000 });
}

/**
 * Walk toward the portal, resending move intents (the server clamps a single
 * move.to target to 1200px, so long legs like fernwatch -> dawncap need
 * several sends). Resolves true when the map already changed, false when the
 * player is standing at the portal but has not transitioned.
 */
async function waitForPortalReadyOrTransition(page: Page, route: PortalRoute): Promise<boolean> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < 30_000) {
    if (await isOnMap(page, route.targetMapId)) return true;
    await sendMoveIntent(page, route.x, route.footY);
    try {
      await page.waitForFunction(({ x, y, mapId }) => {
        const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
        const player = scene?.room?.state?.players?.get(scene.localSessionId);
        return player && (player.mapId === mapId || Math.hypot(player.x - x, player.y - y) <= 64);
      }, { x: route.x, y: route.footY, mapId: route.targetMapId }, { timeout: 6_000 });
      return isOnMap(page, route.targetMapId);
    } catch (err) {
      lastError = err;
    }
  }
  const state = await getSmokeState(page);
  throw new Error(`timed out reaching portal target (${route.x}, ${Math.round(route.footY)}); state=${JSON.stringify(state)}`, {
    cause: lastError,
  });
}

async function isOnMap(page: Page, mapId: string): Promise<boolean> {
  return page.evaluate((wantedMapId) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    return player?.mapId === wantedMapId;
  }, mapId);
}

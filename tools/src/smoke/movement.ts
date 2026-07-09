import type { Page } from "@playwright/test";
import { TIMEOUT } from "./constants";
import { getGroundClickPoint, getGroundDragPoints } from "./click-targets";
import { sendMoveIntent } from "./intents";
import { getSmokeState } from "./state";
import { computeCollisionAwarePath, type PathPoint } from "./path-planner";
import type { JoinedSmokeState, SmokeBrowserGlobal, SmokeState } from "./types";

export async function waitForLocalPlayerNear(page: Page, x: number, y: number, radius: number): Promise<void> {
  await page.waitForFunction(({ targetX, targetY, maxDistance }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    return player && Math.hypot(player.x - targetX, player.y - targetY) <= maxDistance;
  }, { targetX: x, targetY: y, maxDistance: radius }, { timeout: TIMEOUT });
}

/**
 * Walk the local player to (x, y), resending the move intent until it arrives.
 * The server clamps a single move.to target to 1200px, so any longer leg needs
 * this resend loop instead of a single sendMoveIntent.
 *
 * The mover walks like a player, not a ruler: it first plans a collision-aware
 * path from the current position to the destination (greedy sidestep off the
 * static collision resolver via the client's `isPlayerPositionBlocked` oracle),
 * then drives the resend loop toward each waypoint in turn. When the straight
 * line is already clear (the common case) the plan is just `[target]`, so this
 * is a no-op for open-field legs. This retires the coordinate-coupled detour
 * waypoints that broke smoke runs whenever a prop moved (notes-p0 §2a).
 */
export async function moveLocalPlayerNear(page: Page, x: number, y: number, radius: number, timeoutMs = 30_000): Promise<void> {
  await installServerErrorTrace(page);
  const finalTarget = await resolveReachableMoveTarget(page, x, y, radius);
  const waypoints = await planCollisionAwarePath(page, finalTarget.x, finalTarget.y);
  const sentRequestIds: string[] = [];

  // Walk the intermediate waypoints (all but the last) with a slack arrival
  // radius — they only exist to steer the straight-line server mover around
  // collision, so we do not need pixel-precise arrival at a corner.
  for (let i = 0; i < waypoints.length - 1; i += 1) {
    const wp = waypoints[i];
    await driveToTarget(page, wp.x, wp.y, x, y, 40, Math.max(timeoutMs, 12_000), sentRequestIds, false);
  }

  // Final leg: honor the caller's arrival radius against the ORIGINAL (x, y).
  const last = waypoints[waypoints.length - 1];
  await driveToTarget(page, last.x, last.y, x, y, radius, Math.max(timeoutMs, 12_000), sentRequestIds, true);
}

/**
 * Resend `move.to (targetX, targetY)` until the player is within `radius` of the
 * arrival reference `(refX, refY)`, or the stall timer expires. `arriveOnRef`
 * chooses whether progress/arrival is measured against the reference (final leg)
 * or the waypoint itself (intermediate legs).
 */
async function driveToTarget(
  page: Page,
  targetX: number,
  targetY: number,
  refX: number,
  refY: number,
  radius: number,
  stallTimeoutMs: number,
  sentRequestIds: string[],
  arriveOnRef: boolean,
): Promise<void> {
  const arrivalX = arriveOnRef ? refX : targetX;
  const arrivalY = arriveOnRef ? refY : targetY;
  const progressEpsilon = 1;
  const pollMs = 250;
  const resendMs = 1_500;
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let lastIntentAt = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  const timeline: Array<{ elapsedMs: number; distance: number; x: number; y: number }> = [];

  while (Date.now() - lastProgressAt <= stallTimeoutMs) {
    const now = Date.now();
    if (now - lastIntentAt >= resendMs) {
      sentRequestIds.push(await sendMoveIntent(page, targetX, targetY));
      lastIntentAt = now;
    }
    const rejection = await getMoveIntentRejection(page, sentRequestIds);
    if (rejection) {
      throw new Error(`move.to rejected while moving near (${Math.round(arrivalX)}, ${Math.round(arrivalY)}); target=${JSON.stringify({ x: targetX, y: targetY })} error=${JSON.stringify(rejection)}`);
    }

    const snapshot = await page.evaluate(({ targetX: aX, targetY: aY }) => {
      const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
      const player = scene?.room?.state?.players?.get(scene.localSessionId);
      if (!player) return null;
      return {
        x: player.x,
        y: player.y,
        distance: Math.hypot(player.x - aX, player.y - aY),
      };
    }, { targetX: arrivalX, targetY: arrivalY });
    if (snapshot && snapshot.distance <= radius) return;
    if (snapshot && snapshot.distance < bestDistance - progressEpsilon) {
      bestDistance = snapshot.distance;
      lastProgressAt = now;
      timeline.push({
        elapsedMs: now - startedAt,
        distance: Math.round(snapshot.distance),
        x: Math.round(snapshot.x),
        y: Math.round(snapshot.y),
      });
    }

    await page.waitForTimeout(pollMs);
  }

  const state = await getSmokeState(page);
  const recentErrors = await getRecentServerErrors(page);
  throw new Error(`stalled moving local player near (${Math.round(arrivalX)}, ${Math.round(arrivalY)}); target=${JSON.stringify({ x: targetX, y: targetY })} bestDistance=${Math.round(bestDistance)} timeline=${JSON.stringify(timeline)} serverErrors=${JSON.stringify(recentErrors)} state=${JSON.stringify(state)}`);
}

/**
 * Plan a collision-aware path from the local player to `(targetX, targetY)` using
 * the client's static-collision oracle (`inputController.isPlayerPositionBlocked`,
 * which resolves the SAME map collision data the server enforces —
 * client/src/input/InputController.ts:1031). Returns a list of clear waypoints
 * ending at the target. If the straight line is already clear, or the oracle is
 * unavailable, returns `[{ targetX, targetY }]` (no behavior change).
 *
 * The planning algorithm is the SINGLE pure implementation in path-planner.ts
 * (`computeCollisionAwarePath`), unit-tested in Node against synthetic prop
 * clusters. Here we serialize that function's source into the browser and feed
 * it the live oracle + map bounds, so the tested logic and the shipped logic are
 * byte-identical — no browser/Node drift.
 */
export async function planCollisionAwarePath(page: Page, targetX: number, targetY: number): Promise<PathPoint[]> {
  const plannerSource = computeCollisionAwarePath.toString();
  // The tsx/esbuild transform that compiles this harness wraps nested functions
  // with a `__name(fn, "…")` helper for stack-trace naming — including inside the
  // page.evaluate callback below and inside the serialized planner source. That
  // helper is a Node-side injection and is absent in the browser, so we install a
  // passthrough `globalThis.__name` FIRST (this tiny callback has no nested
  // functions, so it needs no helper itself). Bare `__name(...)` refs in the
  // following evaluate then resolve up the scope chain to this global shim.
  await ensureNameShim(page);
  return page.evaluate(({ goalX, goalY, source }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    const inputController = scene?.inputController as { isPlayerPositionBlocked?: (x: number, y: number) => boolean } | undefined;
    const map = scene?.getCurrentMap?.();
    const direct = [{ x: goalX, y: goalY }];
    if (!player || !map || !inputController?.isPlayerPositionBlocked) return direct;

    const isBlocked = (x: number, y: number): boolean => inputController.isPlayerPositionBlocked!(x, y);
    // Reconstruct the pure planner from its serialized source and run it against
    // the live oracle. The tsx/esbuild transform that runs this harness injects a
    // `__name(fn, "name")` helper around nested arrows for stack-trace naming; it
    // does not exist in the browser, so we provide a passthrough shim before the
    // eval. `(0, eval)` runs in global scope; the IIFE returns the planner fn.
    const planner = (0, eval)(
      `(function(){var __name=function(f){return f;};return (${source});})()`,
    ) as (
      start: { x: number; y: number },
      goal: { x: number; y: number },
      blocked: (x: number, y: number) => boolean,
      bounds: { width: number; height: number },
    ) => Array<{ x: number; y: number }>;
    return planner(
      { x: player.x, y: player.y },
      { x: goalX, y: goalY },
      isBlocked,
      { width: map.size.width, height: map.size.height },
    );
  }, { goalX: targetX, goalY: targetY, source: plannerSource });
}

/**
 * Install a passthrough `globalThis.__name` in the page so esbuild's injected
 * `__name(fn, "…")` naming helper (present in every transformed page.evaluate
 * callback that has nested functions) resolves instead of throwing
 * `ReferenceError: __name is not defined`. Idempotent; this callback has no
 * nested functions of its own, so it carries no `__name` reference to bootstrap.
 */
async function ensureNameShim(page: Page): Promise<void> {
  // Build the identity function via `new Function` so this installer callback
  // contains NO literal nested function for esbuild to wrap with `__name` — which
  // would reintroduce the very ReferenceError we are bootstrapping around.
  await page.evaluate((body: string) => {
    const g = globalThis as unknown as { __name?: unknown };
    if (typeof g.__name !== "function") {
      g.__name = new Function("fn", body);
    }
  }, "return fn;");
}

async function installServerErrorTrace(page: Page): Promise<void> {
  await page.evaluate(() => {
    const global = globalThis as SmokeBrowserGlobal;
    const scene = global.__GAME?.scene?.getScene?.("game");
    const room = scene?.room;
    if (!room || global.__SMOKE_ERROR_TRACE_INSTALLED__) return;
    global.__SMOKE_ERROR_TRACE_INSTALLED__ = true;
    global.__SMOKE_SERVER_ERRORS__ = [];
    room.onMessage("error", (event) => {
      const trace = global.__SMOKE_SERVER_ERRORS__;
      if (!trace) return;
      trace.push({
        type: event?.type,
        requestId: event?.requestId,
        code: event?.code,
        messageKey: event?.messageKey,
        message: event?.message,
        receivedAtMs: Date.now(),
      });
      if (trace.length > 40) trace.shift();
    });
  });
}

async function getMoveIntentRejection(page: Page, requestIds: string[]) {
  return page.evaluate((ids) => {
    const wanted = new Set(ids);
    return ((globalThis as SmokeBrowserGlobal).__SMOKE_SERVER_ERRORS__ ?? []).find((event) => (
      event.requestId !== undefined && wanted.has(event.requestId)
    )) ?? null;
  }, requestIds);
}

async function getRecentServerErrors(page: Page) {
  return page.evaluate(() => ((globalThis as SmokeBrowserGlobal).__SMOKE_SERVER_ERRORS__ ?? []).slice(-8));
}

async function resolveReachableMoveTarget(page: Page, x: number, y: number, radius: number): Promise<{ x: number; y: number; adjusted: boolean }> {
  return page.evaluate(({ targetX, targetY, arrivalRadius }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const map = scene?.getCurrentMap?.();
    const inputController = scene?.inputController as { isPlayerPositionBlocked?: (x: number, y: number) => boolean } | undefined;
    if (!map || !inputController?.isPlayerPositionBlocked) return { x: targetX, y: targetY, adjusted: false };

    const candidates: Array<{ x: number; y: number }> = [{
      x: Math.max(0, Math.min(map.size.width, targetX)),
      y: Math.max(0, Math.min(map.size.height, targetY)),
    }];
    const rings = [arrivalRadius * 0.35, arrivalRadius * 0.65, Math.max(0, arrivalRadius - 2)];
    for (const ring of rings) {
      if (ring <= 0) continue;
      for (let i = 0; i < 16; i += 1) {
        const angle = (Math.PI * 2 * i) / 16;
        candidates.push({
          x: Math.max(0, Math.min(map.size.width, targetX + Math.cos(angle) * ring)),
          y: Math.max(0, Math.min(map.size.height, targetY + Math.sin(angle) * ring)),
        });
      }
    }

    for (const candidate of candidates) {
      if (!inputController.isPlayerPositionBlocked(candidate.x, candidate.y)) {
        return {
          x: candidate.x,
          y: candidate.y,
          adjusted: Math.hypot(candidate.x - targetX, candidate.y - targetY) > 0.1,
        };
      }
    }
    return { x: targetX, y: targetY, adjusted: false };
  }, { targetX: x, targetY: y, arrivalRadius: radius });
}

/**
 * Hop the local player from the village-green spawn or a persisted southern
 * position into the open arena. The smoke mover is straight-line (no
 * pathfinding), so avoid backtracking north through collision once already
 * south of the village choke point.
 */
export async function stageInOpenField(page: Page): Promise<void> {
  // The mover is collision-aware now (planCollisionAwarePath), so it plans its
  // own route around the windmill/plaza choke point instead of relying on a
  // hardcoded (690,760) staging hop. One move straight to the open arena is
  // enough regardless of the current spawn position.
  await moveLocalPlayerNear(page, 720, 1080, 80, 25_000);
}

export async function verifyMouseWheelZoom(page: Page): Promise<void> {
  const initialState = await getSmokeState(page);
  const initialZoom = initialState?.camera?.zoom;
  if (!initialZoom) throw new Error("camera zoom missing before wheel zoom check");

  await page.mouse.move(480, 270);
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(100);

  const firstWheelState = await getSmokeState(page);
  const firstWheelZoom = firstWheelState?.camera?.zoom;
  if (!firstWheelZoom) throw new Error("camera zoom missing after first wheel zoom check");
  if (Math.abs(firstWheelZoom - initialZoom) <= 0.001) {
    console.log(`[smoke] Mouse wheel zoom is fixed at ${firstWheelZoom}.`);
    return;
  }

  await page.waitForFunction((beforeZoom) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    return scene?.cameras?.main?.zoom < beforeZoom - 0.03;
  }, initialZoom, { timeout: TIMEOUT });

  const zoomedOutState = await getSmokeState(page);
  const zoomedOut = zoomedOutState?.camera?.zoom;
  if (!zoomedOut) throw new Error("camera zoom missing after wheel zoom out");

  await page.mouse.wheel(0, -1200);
  await page.waitForFunction((targetZoom) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    return scene?.cameras?.main?.zoom >= targetZoom - 0.01;
  }, initialZoom, { timeout: TIMEOUT });
}

export async function verifyReplicatedMovement(pageA: Page, pageB: Page, joinedA: JoinedSmokeState, stateB: SmokeState): Promise<void> {
  await prepareGameplayKeyboardInput(pageA);
  const pageAStateBefore = await getSmokeState(pageA);
  const localBefore = pageAStateBefore?.players.find((player) => player.sessionId === joinedA.localSessionId);
  if (!localBefore) {
    throw new Error(`page A missing local player before movement: ${JSON.stringify(pageAStateBefore)}`);
  }
  await pageB.waitForFunction(({ sessionId, expectedX }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(sessionId);
    return player && Math.abs(player.x - expectedX) <= 6;
  }, { sessionId: joinedA.localSessionId, expectedX: localBefore.x }, { timeout: TIMEOUT });
  const freshStateB = await getSmokeState(pageB) ?? stateB;
  const pageAPlayerBefore = freshStateB.players.find((player) => player.sessionId === joinedA.localSessionId);
  if (!pageAPlayerBefore) {
    throw new Error("page B does not see page A before movement");
  }

  await sendMoveIntent(pageA, localBefore.x + 90, localBefore.y);

  try {
    await pageB.waitForFunction(({ sessionId, beforeX }) => {
      const game = (globalThis as SmokeBrowserGlobal).__GAME;
      const scene = game?.scene?.getScene?.("game");
      const player = scene?.room?.state?.players?.get(sessionId);
      return player && player.x > beforeX + 20;
    }, { sessionId: joinedA.localSessionId, beforeX: pageAPlayerBefore.x }, { timeout: TIMEOUT });
  } catch (err) {
    const debug = await getMovementDebug(pageA, joinedA.localSessionId, pageAPlayerBefore.x);
    throw new Error(`keyboard movement did not replicate; debug=${JSON.stringify(debug)}`, { cause: err });
  }

  const stateBAfterKeyboard = await getSmokeState(pageB);
  const pageAPlayerAfterKeyboard = stateBAfterKeyboard?.players.find((player) => player.sessionId === joinedA.localSessionId);
  console.log(
    `[smoke] Movement replicated: page B saw page A move from x=${pageAPlayerBefore.x} to x=${pageAPlayerAfterKeyboard?.x}.`,
  );

  await pageA.mouse.click(620, 310);
  await pageA.waitForTimeout(1200);
  const stateBAfterClick = await getSmokeState(pageB);
  const pageAPlayerAfterClick = stateBAfterClick?.players.find((player) => player.sessionId === joinedA.localSessionId);
  console.log(
    `[smoke] Click-to-move still syncs: page B sees page A at (${pageAPlayerAfterClick?.x}, ${pageAPlayerAfterClick?.y}).`,
  );

  // The click-to-move spot lands next to the Emberglass scout (820,470); a
  // pointer-down at the player's screen position there hits the NPC instead
  // of ground and opens dialogue. Reposition to open west-side road first;
  // the former east-road point routed through the current scout collision.
  const closeDialogue = pageA.locator("#dialogue-choices").getByRole("button", { name: /^(Close|Just passing through\.)$/ });
  if (await closeDialogue.isVisible({ timeout: 500 }).catch(() => false)) {
    await closeDialogue.click();
  }
  await moveLocalPlayerNear(pageA, 500, 650, 24);
  const stateBBeforeHold = await getSmokeState(pageB);
  const beforeMouseHold = stateBBeforeHold?.players.find((player) => player.sessionId === joinedA.localSessionId);
  if (!beforeMouseHold) {
    throw new Error("missing page A state before mouse-hold movement check");
  }
  const drag = await getGroundDragPoints(pageA);
  await pageA.mouse.move(drag.startX, drag.startY);
  await pageA.mouse.down();
  await pageA.mouse.move(drag.endX, drag.endY, { steps: 12 });
  await pageA.waitForTimeout(900);
  await pageA.mouse.up();
  await pageB.waitForFunction(({ sessionId, beforeX, beforeY }) => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(sessionId);
    return player && Math.hypot(player.x - beforeX, player.y - beforeY) > 35;
  }, { sessionId: joinedA.localSessionId, beforeX: beforeMouseHold.x, beforeY: beforeMouseHold.y }, { timeout: TIMEOUT });
  const stateBAfterMouseHold = await getSmokeState(pageB);
  const pageAPlayerAfterMouseHold = stateBAfterMouseHold?.players.find((player) => player.sessionId === joinedA.localSessionId);
  console.log(
    `[smoke] Mouse-hold movement follows pointer: page B sees page A at (${pageAPlayerAfterMouseHold?.x}, ${pageAPlayerAfterMouseHold?.y}).`,
  );
  await moveLocalPlayerNear(pageA, 660, 460, 24);
}

async function prepareGameplayKeyboardInput(page: Page): Promise<void> {
  await page.bringToFront();
  await page.evaluate(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const active = doc.activeElement;
    if (active && active !== doc.body && typeof active.blur === "function") active.blur();
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    scene?.inputController?.clearHeldInput?.();
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    if (player) {
      scene.room.send("intent", {
        type: "move.to",
        requestId: `smoke-stop-${Date.now()}`,
        x: player.x,
        y: player.y,
        clientTimeMs: Date.now(),
      });
    }
  });
  await page.waitForTimeout(350);
  await page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    if (player) {
      scene.room.send("intent", {
        type: "move.to",
        requestId: `smoke-stop-${Date.now()}-settled`,
        x: player.x,
        y: player.y,
        clientTimeMs: Date.now(),
      });
    }
  });
  await page.waitForTimeout(350);
  await page.waitForFunction(() => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const qa = (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__?.getVisualQaSnapshot?.();
    return (
      !doc.body.classList.contains("ui-move-enabled") &&
      (!doc.activeElement || doc.activeElement === doc.body) &&
      qa?.input?.attackHeld === false
    );
  }, null, { timeout: TIMEOUT });
}

async function getMovementDebug(page: Page, sessionId: string, beforeX: number): Promise<Record<string, unknown>> {
  return page.evaluate(({ wantedSessionId, expectedBeforeX }) => {
    const doc = (globalThis as SmokeBrowserGlobal).document;
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    const player = scene?.room?.state?.players?.get(wantedSessionId);
    const render = scene?.playerObjects?.get(wantedSessionId)?.container;
    const qa = (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__?.getVisualQaSnapshot?.();
    return {
      activeTag: doc.activeElement?.tagName,
      bodyClasses: doc.body?.className,
      dialogueHidden: doc.getElementById("dialogue")?.hidden,
      shopHidden: doc.getElementById("shop")?.hidden,
      input: qa?.input,
      beforeX: expectedBeforeX,
      serverX: player?.x,
      renderX: render?.x,
      roomConnected: Boolean(scene?.room),
      localSessionId: scene?.localSessionId,
    };
  }, { wantedSessionId: sessionId, expectedBeforeX: beforeX });
}

export async function clickGroundAfterPortal(page: Page): Promise<void> {
  const clickPoint = await getGroundClickPoint(page, 120, -80);
  await page.mouse.click(clickPoint.screenX, clickPoint.screenY);
  await page.waitForFunction(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene?.("game");
    return scene?.inputController?.targetMarkerVisible === true && scene?.inputController?.targetMarkerDepth >= 8;
  }, null, { timeout: TIMEOUT });
}

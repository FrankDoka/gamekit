/**
 * Tactics capture — the "boot + drive + screenshot" sibling of capture-zone.ts,
 * for the TURN-BASED tactics reference game (examples/tactics-game).
 *
 * The action capture pipeline (capture-zone.ts + smoke/state.ts) reads a Colyseus
 * `room.state.players`-by-sessionId and Phaser `playerObjects` — a tactics game has
 * NEITHER (its entities are `units[]` keyed by unitId, owned by a TEAM, not a
 * connection). So this reuses the genre-neutral boot (smoke/genre-harness.ts —
 * same port-reservation + ownership handshake as the action harness) and adds a
 * small TACTICS-specific reader that keys off the "game" scene's `room`/`board`/
 * `units`/`activeTeam` instead. It drives ONE legal move via a `move` intent and
 * asserts the unit moved in `room.state`, screenshotting the board before + after.
 *
 * Usage:  GAME_ROOT=<abs path to tactics-game> tsx tools/src/capture-tactics.ts [outDir]
 *   (defaults: GAME_ROOT=examples/tactics-game, outDir=examples/tactics-game/_shots)
 * This tool is GAME-AWARE: it needs a wired tactics game at GAME_ROOT.
 */
import { existsSync, mkdirSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import type { Page } from "@playwright/test";
import { bootGenreCapture, clickGuest } from "./smoke/genre-harness";

type UnitView = {
  unitId: string;
  team: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  moveRange: number;
  hasMoved: boolean;
  hasActed: boolean;
};
type TacticsSnapshot = {
  sceneKey: string;
  localSessionId: string | null;
  hasRoom: boolean;
  activeTeam: string;
  phase: string;
  board: { width: number; height: number; tileSize: number; blocked: boolean[] };
  units: UnitView[];
};

// NEW tactics-specific reader — the analogue of smoke/state.ts's getSmokeState,
// but reads units-by-team from the "game" scene's authoritative room.state. Does
// NOT mutate or import the action reader (state.ts) at all.
async function readTacticsState(page: Page): Promise<TacticsSnapshot | null> {
  return page.evaluate(() => {
    const game = (globalThis as { __GAME?: { scene?: { getScene?(k: string): unknown } } }).__GAME;
    const scene = game?.scene?.getScene?.("game") as
      | {
          scene: { key: string };
          localSessionId?: string;
          room?: {
            state?: {
              width: number;
              height: number;
              tileSize: number;
              activeTeam: string;
              phase: string;
              blocked?: { forEach(cb: (v: boolean) => void): void };
              units?: { forEach(cb: (u: UnitView) => void): void };
            };
          };
        }
      | undefined;
    if (!scene) return null;
    const s = scene.room?.state;
    if (!s) return null;
    const blocked: boolean[] = [];
    s.blocked?.forEach((v) => blocked.push(Boolean(v)));
    const units: UnitView[] = [];
    s.units?.forEach((u) =>
      units.push({
        unitId: u.unitId,
        team: u.team,
        x: u.x,
        y: u.y,
        hp: u.hp,
        maxHp: u.maxHp,
        moveRange: u.moveRange,
        hasMoved: u.hasMoved,
        hasActed: u.hasActed,
      }),
    );
    return {
      sceneKey: scene.scene.key,
      localSessionId: scene.localSessionId ?? null,
      hasRoom: Boolean(scene.room),
      activeTeam: s.activeTeam,
      phase: s.phase,
      board: { width: s.width, height: s.height, tileSize: s.tileSize, blocked },
      units,
    };
  });
}

async function waitForTacticsReady(page: Page, timeoutMs: number): Promise<TacticsSnapshot> {
  await page.waitForFunction(
    () => {
      const scene = (globalThis as { __GAME?: { scene?: { getScene?(k: string): unknown } } }).__GAME?.scene?.getScene?.("game") as
        | { localSessionId?: string; room?: { state?: { units?: { forEach(cb: () => void): void } } } }
        | undefined;
      let count = 0;
      scene?.room?.state?.units?.forEach(() => (count += 1));
      return Boolean(scene?.localSessionId) && count > 0;
    },
    null,
    { timeout: timeoutMs },
  );
  const snap = await readTacticsState(page);
  if (!snap) throw new Error("tactics state missing after join");
  return snap;
}

/** Compute a legal 1-tile move for an active-team, not-yet-moved unit. Mirrors the
 * server's move validator (in-bounds, passable, unoccupied, within moveRange). */
function planLegalMove(snap: TacticsSnapshot): { unit: UnitView; x: number; y: number } | null {
  const occupied = new Set(snap.units.filter((u) => u.hp > 0).map((u) => `${u.x},${u.y}`));
  const isBlocked = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= snap.board.width || y >= snap.board.height) return true;
    return Boolean(snap.board.blocked[y * snap.board.width + x]);
  };
  for (const unit of snap.units) {
    if (unit.team !== snap.activeTeam || unit.hasMoved || unit.hp <= 0) continue;
    // Try the 4 orthogonal neighbours (moveRange >= 1 for all start units).
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = unit.x + dx;
      const ny = unit.y + dy;
      if (isBlocked(nx, ny) || occupied.has(`${nx},${ny}`)) continue;
      return { unit, x: nx, y: ny };
    }
  }
  return null;
}

async function main(): Promise<void> {
  const gameRoot = pathResolve(process.env.GAME_ROOT ?? "examples/tactics-game");
  const outDir = pathResolve(process.argv[2] ?? `${gameRoot}/_shots`);
  if (!existsSync(`${gameRoot}/server/src/index.ts`)) {
    throw new Error(`GAME_ROOT does not look like a tactics game (no server/src/index.ts): ${gameRoot}`);
  }
  mkdirSync(outDir, { recursive: true });

  const harness = await bootGenreCapture({
    gameRoot,
    // The tactics client joins Colyseus directly from VITE_COLYSEUS_URL.
    clientEnv: { VITE_COLYSEUS_URL: "ws://127.0.0.1:{{SERVER_PORT}}" },
    viewport: { width: 900, height: 720 },
  });

  try {
    await clickGuest(harness.page);
    const before = await waitForTacticsReady(harness.page, 45_000);
    console.log(`[tactics] joined; scene=${before.sceneKey} activeTeam=${before.activeTeam} units=${before.units.length}`);

    const beforeShot = `${outDir}/tactics-board-before.png`;
    await harness.page.screenshot({ path: beforeShot });

    const plan = planLegalMove(before);
    if (!plan) throw new Error(`no legal move found; state=${JSON.stringify(before)}`);
    const { unit, x, y } = plan;
    const fromX = unit.x;
    const fromY = unit.y;
    console.log(`[tactics] moving ${unit.unitId} (team ${unit.team}) from (${fromX},${fromY}) -> (${x},${y})`);

    // Drive one legal move via a `move` intent through the live room.
    await harness.page.evaluate(
      ({ unitId, tx, ty }) => {
        const scene = (globalThis as { __GAME?: { scene?: { getScene?(k: string): unknown } } }).__GAME?.scene?.getScene?.("game") as
          | { room?: { send(type: string, payload: unknown): void } }
          | undefined;
        scene?.room?.send("intent", { type: "move", unitId, x: tx, y: ty });
      },
      { unitId: unit.unitId, tx: x, ty: y },
    );

    // Assert the unit moved in room.state (authoritative).
    await harness.page.waitForFunction(
      ({ unitId, tx, ty }) => {
        const scene = (globalThis as { __GAME?: { scene?: { getScene?(k: string): unknown } } }).__GAME?.scene?.getScene?.("game") as
          | { room?: { state?: { units?: { forEach(cb: (u: { unitId: string; x: number; y: number; hasMoved: boolean }) => void): void } } } }
          | undefined;
        let moved = false;
        scene?.room?.state?.units?.forEach((u) => {
          if (u.unitId === unitId && u.x === tx && u.y === ty && u.hasMoved) moved = true;
        });
        return moved;
      },
      { unitId: unit.unitId, tx: x, ty: y },
      { timeout: 15_000 },
    );

    const after = await readTacticsState(harness.page);
    const movedUnit = after?.units.find((u) => u.unitId === unit.unitId);
    if (!movedUnit || movedUnit.x !== x || movedUnit.y !== y || !movedUnit.hasMoved) {
      throw new Error(`move assertion failed; unit=${JSON.stringify(movedUnit)} expected (${x},${y})`);
    }
    const afterShot = `${outDir}/tactics-board-after.png`;
    await harness.page.screenshot({ path: afterShot });

    if (harness.consoleErrors.length) {
      console.warn(`[tactics] browser console errors:\n${harness.consoleErrors.join("\n")}`);
    }

    console.log("\n=== TACTICS CAPTURE PASSED ===");
    console.log(`moved ${unit.unitId}: (${fromX},${fromY}) -> (${movedUnit.x},${movedUnit.y}) hasMoved=${movedUnit.hasMoved}`);
    console.log(`screenshots:\n  ${beforeShot}\n  ${afterShot}`);
  } finally {
    await harness.browser.close();
    await harness.stop();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});

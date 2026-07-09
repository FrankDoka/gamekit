/**
 * Playable visual QA route for the game.
 *
 * Starts the same isolated server/client stack as the smoke test, drives a short
 * real game route, and saves screenshots plus Phaser-side geometry snapshots for
 * each checkpoint.
 */

import type { Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { ROOT } from "./smoke/constants";
import { createSmokeHarness, stopChildProcesses, type SmokeHarness } from "./smoke/harness";
import { moveLocalPlayerNear } from "./smoke/movement";
import type { SmokeBrowserGlobal } from "./smoke/types";
import { proofForFiles, visualProofFiles } from "./proof-hash";

type VisualCheckpoint = {
  name: string;
  note: string;
  screenshot: string;
  snapshot: string;
};

type VisualRunManifest = {
  schemaVersion: 1;
  kind: "visual-qa-run";
  createdAt: string;
  outputDir: string;
  visualFiles: Array<{ path: string; sha256: string }>;
  checkpoints: VisualCheckpoint[];
};

type VisualQaEntity = {
  id: string;
  kind: "player" | "monster" | "npc";
  visible: boolean;
  isLocal?: boolean;
  alive?: boolean;
  animation?: { key: string | null; frameIndex: number | null; textureKey: string | null; flipX: boolean };
  sprite?: { screen: { width: number; height: number }; displayWidth: number; displayHeight: number };
  shadow?: { screen: { width: number; height: number } };
};

type VisualQaPortal = {
  id: string;
  visible: boolean;
  screen: { x: number; y: number; radius: number };
};

type VisualQaSnapshot = {
  currentMapId: string;
  expected?: {
    playerAttackAnimationKey?: string;
    groundedKinds?: Array<"player" | "monster" | "npc">;
  };
  canvas: { width: number; height: number; rect: { width: number; height: number } };
  camera: { zoom: number; worldView: { width: number; height: number } };
  players: VisualQaEntity[];
  monsters: VisualQaEntity[];
  npcs: VisualQaEntity[];
  portals: VisualQaPortal[];
};

const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const OUTPUT_DIR = `${ROOT}/tmp/visual-qa/${RUN_ID}`;

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const manifest: VisualRunManifest = {
    schemaVersion: 1,
    kind: "visual-qa-run",
    createdAt: new Date().toISOString(),
    outputDir: OUTPUT_DIR,
    visualFiles: proofForFiles(ROOT, visualProofFiles(ROOT)),
    checkpoints: [],
  };
  let harness: SmokeHarness | undefined;

  try {
    harness = await createSmokeHarness();
    const { pageA, consoleErrors } = harness;

    await captureCheckpoint(pageA, manifest, "01-bloomvale-spawn", "Initial Bloomvale Plains spawn with local/remote players.");

    // Zone-1 Reset (2026-07-03): Bloomvale runs empty — no monsters, portals, or
    // quests until the deeper zones/slime roster return, so the former combat and
    // portal-transition checkpoints are parked. Walk a short, known-open leg on
    // the meadow (proven reachable by the smoke movement route) and re-capture to
    // prove movement + rendering stay healthy in the live zone.
    await moveLocalPlayerNear(pageA, 660, 460, 30);
    await captureCheckpoint(pageA, manifest, "02-bloomvale-walk", "After a short walk on Bloomvale Plains.");

    if (consoleErrors.length > 0) {
      throw new Error(`console errors during visual QA:\n${consoleErrors.join("\n")}`);
    }

    await writeManifest(manifest);
    console.log(`[visual-qa] Complete. Artifacts: ${OUTPUT_DIR}`);
  } finally {
    await writeManifest(manifest);
    await harness?.browser.close();
    stopChildProcesses();
  }
}

async function captureCheckpoint(
  page: Page,
  manifest: VisualRunManifest,
  name: string,
  note: string,
): Promise<void> {
  await page.waitForTimeout(250);
  const screenshot = `${OUTPUT_DIR}/${name}.png`;
  const snapshot = `${OUTPUT_DIR}/${name}.json`;
  const visualSnapshot = await page.evaluate<VisualQaSnapshot | null>(() => {
    const qa = (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__;
    if (!qa?.getVisualQaSnapshot) return null;
    return qa.getVisualQaSnapshot() as unknown as VisualQaSnapshot;
  });
  if (!visualSnapshot) throw new Error(`visual QA snapshot unavailable for ${name}`);
  assertVisualCheckpoint(name, visualSnapshot);
  await page.screenshot({ path: screenshot });
  await writeFile(snapshot, JSON.stringify({ checkpoint: { name, note }, visual: visualSnapshot }, null, 2) + "\n", "utf8");
  manifest.checkpoints.push({ name, note, screenshot, snapshot });
  await writeManifest(manifest);
  console.log(`[visual-qa] ${name}: ${screenshot}`);
}

async function writeManifest(manifest: VisualRunManifest): Promise<void> {
  await writeFile(`${OUTPUT_DIR}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

function assertVisualCheckpoint(name: string, snapshot: VisualQaSnapshot): void {
  assertFinitePositive(snapshot.canvas.width, `${name}: canvas width`);
  assertFinitePositive(snapshot.canvas.height, `${name}: canvas height`);
  assertFinitePositive(snapshot.canvas.rect.width, `${name}: canvas rect width`);
  assertFinitePositive(snapshot.canvas.rect.height, `${name}: canvas rect height`);
  assertFinitePositive(snapshot.camera.zoom, `${name}: camera zoom`);
  assertFinitePositive(snapshot.camera.worldView.width, `${name}: camera world width`);
  assertFinitePositive(snapshot.camera.worldView.height, `${name}: camera world height`);

  const localPlayer = snapshot.players.find((player) => player.isLocal);
  if (!localPlayer) throw new Error(`${name}: missing local player in visual QA snapshot`);
  assertVisibleEntity(name, "local player", localPlayer, snapshot);
  const localPlayerHeight = localPlayer.sprite?.displayHeight ?? 0;
  if (localPlayerHeight < 70 || localPlayerHeight > 130) {
    throw new Error(`${name}: local player display height out of expected range: ${localPlayerHeight}`);
  }

  if (name === "04-shroom-targeted" || name === "05-wayfarer-attack") {
    const visibleMonster = snapshot.monsters.find((monster) => monster.visible && monster.alive);
    if (!visibleMonster) throw new Error(`${name}: expected a visible living monster`);
    assertVisibleEntity(name, "target monster", visibleMonster, snapshot);
  }

  if (name === "05-wayfarer-attack") {
    const animKey = localPlayer.animation?.key;
    const expectedAttackKey = snapshot.expected?.playerAttackAnimationKey ?? "player-attack-south";
    if (animKey !== expectedAttackKey) {
      throw new Error(`${name}: expected attack animation ${expectedAttackKey}, saw ${animKey ?? "none"}`);
    }
  }

  const visiblePortal = snapshot.portals.find((portal) => portal.visible);
  if (visiblePortal) {
    assertFinitePositive(visiblePortal.screen.radius, `${name}: visible portal radius`);
  }
}

function assertVisibleEntity(name: string, label: string, entity: VisualQaEntity, snapshot: VisualQaSnapshot): void {
  if (!entity.visible) throw new Error(`${name}: ${label} is hidden`);
  assertFinitePositive(entity.sprite?.screen.width ?? 0, `${name}: ${label} sprite screen width`);
  assertFinitePositive(entity.sprite?.screen.height ?? 0, `${name}: ${label} sprite screen height`);
  const groundedKinds = snapshot.expected?.groundedKinds ?? ["player", "monster", "npc"];
  if (groundedKinds.includes(entity.kind)) {
    assertFinitePositive(entity.shadow?.screen.width ?? 0, `${name}: ${label} shadow screen width`);
  }
}

function assertFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be positive, got ${value}`);
  }
}

main().catch((err) => {
  console.error("[visual-qa] FATAL:", err);
  stopChildProcesses();
  process.exit(1);
});

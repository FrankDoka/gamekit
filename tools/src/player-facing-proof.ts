import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PLAYER_SHEET_CONFIG } from "@gamekit/game-contract";
import { createSmokeHarness, stopChildProcesses } from "./smoke/harness";
import { moveLocalPlayerNear, stageInOpenField } from "./smoke/movement";
import { sendMoveIntent } from "./smoke/intents";
import type { SmokeBrowserGlobal } from "./smoke/types";

type DirectionLabel = "east" | "west" | "north" | "south" | "diagonal-south-east";

type PlayerFrame = {
  label: DirectionLabel;
  index: number;
  path: string;
  x: number;
  y: number;
  facing?: string;
  facingRight?: boolean;
  animation?: { key: string | null; frameIndex: number | null; textureKey: string | null; flipX: boolean };
  sprite?: { displayWidth: number; displayHeight: number };
};

type QaPlayerFrame = {
  isLocal?: boolean;
  render?: { x: number; y: number };
  facing?: string;
  facingRight?: boolean;
  animation?: PlayerFrame["animation"];
  sprite?: PlayerFrame["sprite"];
};

type Proof = {
  generatedAt: string;
  cwd: string;
  southVariantActions: string[];
  hysteresis: {
    southDominanceRatio: number;
    horizontalDominanceRatio: number;
    horizontalEpsilonPx: number;
    switchFrames: number;
  };
  frames: PlayerFrame[];
  assertions: {
    fourDirectionFrames: boolean;
    diagonalNoOscillation: boolean;
  };
  comparison?: {
    baseline: string;
    comparedFields: string[];
    mismatches: Array<{ label: string; field: string; baseline: unknown; current: unknown }>;
  };
};

const directions: Array<{ label: DirectionLabel; dx: number; dy: number }> = [
  { label: "east", dx: 140, dy: 0 },
  { label: "west", dx: -140, dy: 0 },
  { label: "north", dx: 0, dy: -120 },
  { label: "south", dx: 0, dy: 120 },
  { label: "diagonal-south-east", dx: 70, dy: 120 },
];
let proofOutDir = "tools/_capture/player-facing-proof";

export async function runPlayerFacingProof(outDirArg = "tools/_capture/player-facing-proof", baselinePathArg?: string): Promise<void> {
  const outDir = resolve(outDirArg).replace(/\\/g, "/");
  proofOutDir = outDir;
  const baselinePath = baselinePathArg ? resolve(baselinePathArg).replace(/\\/g, "/") : undefined;
  mkdirSync(outDir, { recursive: true });
  const harness = await createSmokeHarness();
  const frames: PlayerFrame[] = [];
  try {
    const page = harness.pageA;
    await page.setViewportSize({ width: 960, height: 540 });
    await stageInOpenField(page);
    await page.waitForTimeout(300);

    for (const direction of directions) {
      const start = await localPlayerPosition(page);
      await sendMoveIntent(page, start.x + direction.dx, start.y + direction.dy);
      await page.waitForFunction(({ x, y }) => {
        const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
        const player = scene?.room?.state?.players?.get(scene.localSessionId);
        return player && Math.hypot(player.x - x, player.y - y) > 4;
      }, start, { timeout: 5_000 });
      for (let index = 0; index < 8; index += 1) {
        await page.waitForTimeout(110);
        frames.push(await captureFrame(page, direction.label, index));
      }
      await moveLocalPlayerNear(page, start.x + direction.dx, start.y + direction.dy, 28, 12_000);
      await page.waitForTimeout(180);
    }

    const proof: Proof = {
      generatedAt: new Date().toISOString(),
      cwd: process.cwd().replace(/\\/g, "/"),
      southVariantActions: Object.entries(PLAYER_SHEET_CONFIG)
        .filter(([, cfg]) => Boolean("south" in cfg && cfg.south))
        .map(([action]) => action),
      hysteresis: {
        southDominanceRatio: 1.2,
        horizontalDominanceRatio: 1.2,
        horizontalEpsilonPx: 0.5,
        switchFrames: 3,
      },
      frames,
      assertions: {
        fourDirectionFrames: directions.slice(0, 4).every((direction) => frames.some((frame) => frame.label === direction.label)),
        diagonalNoOscillation: hasNoOscillation(frames.filter((frame) => frame.label === "diagonal-south-east").map((frame) => frame.facing)),
      },
    };
    if (baselinePath) {
      proof.comparison = compareWithBaseline(proof, baselinePath);
    }
    writeFileSync(`${outDir}/player-facing-proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
    console.log(`[player-facing-proof] wrote ${outDir}/player-facing-proof.json`);
    if (!proof.assertions.fourDirectionFrames) throw new Error("missing one or more four-direction frame bursts");
    if (!proof.assertions.diagonalNoOscillation) throw new Error("diagonal facing oscillated");
    if (proof.comparison && proof.comparison.mismatches.length > 0) {
      throw new Error(`baseline comparison failed with ${proof.comparison.mismatches.length} mismatch(es)`);
    }
  } finally {
    await harness.browser.close().catch(() => undefined);
    stopChildProcesses();
  }
}

async function localPlayerPosition(page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"]): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const scene = (globalThis as SmokeBrowserGlobal).__GAME?.scene?.getScene("game");
    const player = scene?.room?.state?.players?.get(scene.localSessionId);
    if (!player) throw new Error("local player missing");
    return { x: player.x, y: player.y };
  });
}

async function captureFrame(
  page: Awaited<ReturnType<typeof createSmokeHarness>>["pageA"],
  label: DirectionLabel,
  index: number,
): Promise<PlayerFrame> {
  const file = `${proofOutDir}/${label}-${String(index).padStart(2, "0")}.png`;
  const sample = await page.evaluate(() => {
    const qa = (globalThis as SmokeBrowserGlobal).__GAMEKIT_QA__?.getVisualQaSnapshot?.();
    const players = (qa?.players ?? []) as QaPlayerFrame[];
    const player = players.find((candidate) => candidate.isLocal) ?? players[0];
    if (!player) throw new Error("local visual QA player missing");
    return player;
  });
  await page.screenshot({ path: file });
  return {
    label,
    index,
    path: file.replace(/\\/g, "/"),
    x: sample.render?.x ?? 0,
    y: sample.render?.y ?? 0,
    facing: sample.facing,
    facingRight: sample.facingRight,
    animation: sample.animation,
    sprite: sample.sprite,
  };
}

function hasNoOscillation(values: Array<string | undefined>): boolean {
  const compact = values.filter((value): value is string => Boolean(value));
  let transitions = 0;
  for (let i = 1; i < compact.length; i += 1) {
    if (compact[i] !== compact[i - 1]) transitions += 1;
  }
  return transitions <= 1;
}

function compareWithBaseline(proof: Proof, baselineFile: string): Proof["comparison"] {
  const baseline = JSON.parse(readFileSync(baselineFile, "utf8")) as Proof;
  const comparedFields = ["animation.textureKey", "animation.flipX", "sprite.displayWidth", "sprite.displayHeight"];
  const mismatches: NonNullable<Proof["comparison"]>["mismatches"] = [];
  for (const label of directions.map((direction) => direction.label)) {
    for (const field of comparedFields) {
      const before = valuesForLabel(baseline.frames, label, field);
      const after = valuesForLabel(proof.frames, label, field);
      if (before !== after) {
        mismatches.push({ label, field, baseline: before, current: after });
      }
    }
  }
  return { baseline: baselineFile, comparedFields, mismatches };
}

function valuesForLabel(frames: PlayerFrame[], label: DirectionLabel, field: string): string {
  return [...new Set(frames.filter((frame) => frame.label === label).map((frame) => JSON.stringify(valueAt(frame, field))))].sort().join("|");
}

function valueAt(record: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[key];
  }, record);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baselineArg = process.argv.find((arg) => arg.startsWith("--baseline="));
  runPlayerFacingProof(
    process.argv[2] ?? "tools/_capture/player-facing-proof",
    baselineArg ? baselineArg.slice("--baseline=".length) : undefined,
  ).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    stopChildProcesses();
    process.exit(1);
  });
}

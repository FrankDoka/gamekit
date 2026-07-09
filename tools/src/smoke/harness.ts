import { chromium, type Browser, type Page } from "@playwright/test";
import { type ChildProcess } from "child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import {
  CLIENT_PORT_END,
  CLIENT_PORT_START,
  ROOT,
  SERVER_PORT_END,
  SERVER_PORT_START,
  TIMEOUT,
} from "./constants";
import { getSmokeState, waitForJoined } from "./state";
import { spawnProcessTree, stopProcessTree } from "./process-tree";
import type { JoinedSmokeState, SmokeState } from "./types";

const childProcesses: ChildProcess[] = [];
const childOutput = new WeakMap<ChildProcess, string[]>();
let stoppingChildProcesses = false;
let serverPort = 2567;
let clientPort = 5173;
// Per-run ownership token. The spawned world server echoes this in its
// "server listening" boot log; assertOwnServer refuses to proceed unless the
// process answering on serverPort is proven to be THIS harness's own spawn.
let smokeRunId = "";
let worldServerChild: ChildProcess | undefined;

export type SmokeHarness = {
  browser: Browser;
  pageA: Page;
  pageB: Page;
  consoleErrors: string[];
  joinedA: JoinedSmokeState;
  joinedB: JoinedSmokeState;
  stateA: SmokeState;
  stateB: SmokeState;
  serverPort: number;
  clientPort: number;
};

export type SmokeHarnessOptions = {
  pageAQuery?: string;
  allowSplitMaps?: boolean;
  instantDialogue?: boolean;
  worldEnv?: NodeJS.ProcessEnv;
};

export async function createSmokeHarness(options: SmokeHarnessOptions = {}): Promise<SmokeHarness> {
  smokeRunId = randomUUID();
  // Reserve both ports by holding OS-bound listeners across selection so two
  // parallel runs cannot pick the same free port (the old probe-then-spawn had
  // a TOCTOU gap that let parallel gate batteries collide). A randomized start
  // offset spreads runs across the range so they rarely even contend.
  const serverReservation = await reserveOpenPort(SERVER_PORT_START, SERVER_PORT_END);
  const clientReservation = await reserveOpenPort(CLIENT_PORT_START, CLIENT_PORT_END);
  serverPort = serverReservation.port;
  clientPort = clientReservation.port;

  console.log(`[smoke] Starting world server on :${serverPort} (runId ${smokeRunId})...`);
  serverReservation.release();
  await startWorldServer(options.worldEnv);
  await assertOwnServer();
  console.log("[smoke] World server ready.");

  console.log(`[smoke] Starting dev server on :${clientPort}...`);
  clientReservation.release();
  await startDevServer();
  console.log("[smoke] Dev server ready.");

  const browser = await launchBrowserWithGpu();
  const pageA = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const pageB = await browser.newPage({ viewport: { width: 960, height: 540 } });
  if (options.instantDialogue) {
    await Promise.all([
      pageA.addInitScript(() => {
        (globalThis as { __GAMEKIT_DIALOGUE_INSTANT__?: boolean }).__GAMEKIT_DIALOGUE_INSTANT__ = true;
      }),
      pageB.addInitScript(() => {
        (globalThis as { __GAMEKIT_DIALOGUE_INSTANT__?: boolean }).__GAMEKIT_DIALOGUE_INSTANT__ = true;
      }),
    ]);
  }
  const consoleErrors: string[] = [];
  attachErrorCapture(pageA, "pageA", consoleErrors);
  attachErrorCapture(pageB, "pageB", consoleErrors);

  const pageAUrl = getDevUrl(options.pageAQuery);
  const pageBUrl = getDevUrl();
  console.log("[smoke] Opening two clients at", pageAUrl);
  await Promise.all([
    pageA.goto(pageAUrl, { waitUntil: "networkidle", timeout: TIMEOUT }),
    pageB.goto(pageBUrl, { waitUntil: "networkidle", timeout: TIMEOUT }),
  ]);
  await Promise.all([enterAsGuest(pageA), enterAsGuest(pageB)]);

  const joinedA = await waitForJoined(pageA);
  const joinedB = await waitForJoined(pageB);
  console.log(`[smoke] Page A joined as ${joinedA.localSessionId}; page B joined as ${joinedB.localSessionId}.`);

  const stateA = options.allowSplitMaps
    ? await waitForConnectedPlayerCount(pageA, 2, 45_000)
    : await waitForSmokeSessionsRendered(pageA, [joinedA.localSessionId, joinedB.localSessionId], 45_000);
  const stateB = options.allowSplitMaps
    ? await waitForConnectedPlayerCount(pageB, 2, 45_000)
    : await waitForSmokeSessionsRendered(pageB, [joinedA.localSessionId, joinedB.localSessionId], 45_000);
  if (!options.allowSplitMaps && (stateA.renderedCount < 2 || stateB.renderedCount < 2)) {
    throw new Error(`expected two rendered players, got A=${stateA.renderedCount}, B=${stateB.renderedCount}`);
  }
  console.log(`[smoke] Both pages render the two smoke players (${stateA.players.length} connected session(s) observed).`);

  return { browser, pageA, pageB, consoleErrors, joinedA, joinedB, stateA, stateB, serverPort, clientPort };
}

export async function saveScreenshotAndClose(harness: SmokeHarness): Promise<void> {
  await harness.pageA.screenshot({ path: `${ROOT}/tools/smoke-screenshot.png` });
  console.log("[smoke] Screenshot saved to tools/smoke-screenshot.png.");
  await harness.browser.close();
  await stopChildProcesses();
}

export async function stopChildProcesses(): Promise<void> {
  stoppingChildProcesses = true;
  await Promise.all(childProcesses.map((child) => stopProcessTree(child)));
}

async function startWorldServer(extraEnv: NodeJS.ProcessEnv = {}): Promise<void> {
  const server = spawnProcessTree(process.execPath, [`${ROOT}/node_modules/tsx/dist/cli.mjs`, "src/index.ts"], {
    cwd: `${ROOT}/server`,
    env: { ...process.env, ...extraEnv, PORT: String(serverPort), GAMEKIT_FORCE_LOOT: "always", ALLOW_GUEST_LOGIN: "true", GAMEKIT_QA_DISABLE_MEGA_PROC: "1", GAMEKIT_SMOKE_RUN_ID: smokeRunId },
    stdio: "pipe",
  });
  childProcesses.push(server);
  worldServerChild = server;
  captureChildOutput("server", server);
  await waitUntil("world server", () => isPortOpen(serverPort), TIMEOUT, server);
}

// Ownership handshake: the port being open only proves SOMETHING is listening.
// A stale/foreign server left over from another lane could be bound to the same
// port after the reservation window closed. We refuse to proceed until OUR
// spawned child echoes our unique runId in its "server listening" boot log — a
// foreign server never emits our runId, so this converts any residual collision
// into a loud fail instead of a silent reuse (card-capture-port-lock scope 2).
export function serverOutputProvesOwnership(output: string, runId: string): boolean {
  return runId.length > 0 && output.includes(`"smokeRunId":"${runId}"`);
}

async function assertOwnServer(): Promise<void> {
  const child = worldServerChild;
  if (!child) throw new Error("[smoke] internal: world server child missing before ownership check");
  const startedAt = Date.now();
  while (Date.now() - startedAt < TIMEOUT) {
    const out = (childOutput.get(child) ?? []).join("");
    if (serverOutputProvesOwnership(out, smokeRunId)) return;
    if (child.exitCode !== null) {
      throw new Error(`[smoke] world server exited (code ${child.exitCode}) before proving ownership (runId ${smokeRunId})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const tail = (childOutput.get(child) ?? []).join("").slice(-2000);
  throw new Error(
    `[smoke] refusing to use server on :${serverPort}: it did not announce our runId ${smokeRunId} within ${TIMEOUT}ms ` +
      `(a foreign or stale server may hold this port). Recent server output:\n${tail}`,
  );
}

async function startDevServer(): Promise<void> {
  const devServer = spawnProcessTree(process.execPath, [`${ROOT}/client/node_modules/vite/bin/vite.js`, "--host", "127.0.0.1", "--port", String(clientPort), "--strictPort"], {
    cwd: `${ROOT}/client`,
    env: {
      ...process.env,
      VITE_API_PROXY_TARGET: `http://127.0.0.1:${serverPort}`,
      VITE_COLYSEUS_URL: `ws://127.0.0.1:${serverPort}`,
    },
    stdio: "pipe",
  });
  childProcesses.push(devServer);
  captureChildOutput("client", devServer);
  await waitUntil("client dev server", () => isPortOpen(clientPort), TIMEOUT, devServer);
}

function attachErrorCapture(page: Page, label: string, consoleErrors: string[]): void {
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") {
      if (isOptionalSpriteLoadError(text)) return;
      consoleErrors.push(`${label}: ${text}`);
      console.error(`[browser:${label}:error] ${text}`);
    } else if (msg.type() === "warning" && !text.includes("GL Driver Message")) {
      console.warn(`[browser:${label}:warning] ${text}`);
    }
  });
  page.on("pageerror", (err) => consoleErrors.push(`${label}: ${err.message}`));
}

async function enterAsGuest(page: Page): Promise<void> {
  const guestButton = page.locator("#auth-guest").first();
  await guestButton.waitFor({ state: "visible", timeout: TIMEOUT });
  await guestButton.click();
}

function isOptionalSpriteLoadError(text: string): boolean {
  return (
    (text.startsWith("Failed to process file:") && text.includes("image ")) ||
    text.includes("`setTintFill(color)` is removed as of Phaser 4")
  );
}

function captureChildOutput(label: string, child: ChildProcess): void {
  const output: string[] = [];
  let printedChunks = 0;
  const maxPrintedChunks = 40;
  childOutput.set(child, output);
  const record = (data: Buffer, write: (text: string) => boolean) => {
    const text = data.toString();
    output.push(text);
    if (printedChunks < maxPrintedChunks) {
      write(`[${label}] ${text}`);
      printedChunks += 1;
    } else if (printedChunks === maxPrintedChunks) {
      write(`[${label}] output truncated in smoke log\n`);
      printedChunks += 1;
    }
  };
  child.stdout?.on("data", (data: Buffer) => record(data, (text) => process.stdout.write(text)));
  child.stderr?.on("data", (data: Buffer) => record(data, (text) => process.stderr.write(text)));
  child.on("exit", (code) => {
    if (!stoppingChildProcesses && code !== null && code !== 0) {
      console.error(`[${label}] exited with code ${code}`);
    }
  });
}

async function waitUntil(label: string, check: () => Promise<boolean>, timeoutMs: number, child: ChildProcess): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    if (child.exitCode !== null) {
      throw new Error(`${label} exited early with code ${child.exitCode}:\n${(childOutput.get(child) ?? []).join("")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`${label} did not become ready in ${timeoutMs}ms:\n${(childOutput.get(child) ?? []).join("")}`);
}

export type PortReservation = { port: number; release: () => void };

// Reserve a free port by actually binding a listener to it and HOLDING that
// binding until the real child is about to spawn (caller calls release()).
// This closes the probe-then-spawn TOCTOU race: while we hold the reservation
// the OS reports the port in use, so a parallel run's reserveOpenPort skips it.
// A randomized start offset within the range spreads concurrent runs apart so
// they usually never contend for the same candidate at all.
export async function reserveOpenPort(first: number, last: number): Promise<PortReservation> {
  const span = last - first + 1;
  const offset = Math.floor(Math.random() * span);
  for (let i = 0; i < span; i += 1) {
    const port = first + ((offset + i) % span);
    const server = await tryBind(port);
    if (server) {
      let released = false;
      return {
        port,
        release: () => {
          if (released) return;
          released = true;
          server.close();
        },
      };
    }
  }
  throw new Error(`No open smoke-test port found between ${first} and ${last}.`);
}

// Attempt to bind a listener on the port; resolves to the server on success,
// or null if the port is already taken (EADDRINUSE) or otherwise unbindable.
function tryBind(port: number): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => {
      server.close();
      resolve(null);
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      resolve(server);
    });
  });
}

async function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForConnectedPlayerCount(page: Page, count: number, timeoutMs: number): Promise<SmokeState> {
  await page.waitForFunction((expectedCount) => {
    const scene = (globalThis as { __GAME?: { scene?: { getScene?(key: string): unknown } } }).__GAME?.scene?.getScene?.("game") as
      { room?: { state?: { players?: { forEach(cb: () => void): void } } } } | undefined;
    let playerCount = 0;
    scene?.room?.state?.players?.forEach(() => {
      playerCount += 1;
    });
    return playerCount === expectedCount;
  }, count, { timeout: timeoutMs });
  const state = await getSmokeState(page);
  if (!state) throw new Error("game state missing while waiting for connected players");
  return state;
}

async function waitForSmokeSessionsRendered(page: Page, sessionIds: string[], timeoutMs: number): Promise<SmokeState> {
  try {
    await page.waitForFunction((expectedSessionIds) => {
      const scene = (globalThis as { __GAME?: { scene?: { getScene?(key: string): unknown } } }).__GAME?.scene?.getScene?.("game") as
        { room?: { state?: { players?: { has(id: string): boolean } } }; playerObjects?: { has(id: string): boolean } } | undefined;
      return expectedSessionIds.every((sessionId) => scene?.room?.state?.players?.has(sessionId) && scene?.playerObjects?.has(sessionId));
    }, sessionIds, { timeout: timeoutMs });
  } catch (err) {
    const state = await getSmokeState(page);
    throw new Error(`timed out waiting for smoke sessions to sync/render; expected=${JSON.stringify(sessionIds)} state=${JSON.stringify(state)}`, {
      cause: err,
    });
  }

  const state = await getSmokeState(page);
  if (!state) throw new Error("game state missing while waiting for smoke sessions");
  return state;
}

function getDevUrl(query = ""): string {
  const suffix = query ? (query.startsWith("?") ? query : `?${query}`) : "";
  return `http://127.0.0.1:${clientPort}${suffix}`;
}

const GPU_LAUNCH_ARGS = [
  "--enable-gpu",
  "--ignore-gpu-blocklist",
  "--use-angle=d3d11",
  "--enable-features=Vulkan",
  "--enable-unsafe-swiftshader",
];

async function launchBrowserWithGpu(): Promise<Browser> {
  try {
    const browser = await chromium.launch({ headless: true, args: GPU_LAUNCH_ARGS });
    const probe = await browser.newPage();
    await probe.setContent("<canvas id='c'></canvas>");
    const renderer = await probe.evaluate(() => {
      const doc = globalThis as unknown as { document: { getElementById(id: string): { getContext(t: string): { getExtension(n: string): Record<string, number> | null; getParameter(p: number): string } | null } | null } };
      const canvas = doc.document.getElementById("c");
      if (!canvas) return "no-webgl";
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (!gl) return "no-webgl";
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return ext ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string) : "unknown";
    });
    await probe.close();
    const isSwiftShader = /swiftshader/i.test(renderer);
    if (!isSwiftShader && renderer !== "no-webgl" && renderer !== "unknown") {
      console.log(`[smoke] GPU acceleration active (${renderer}).`);
    } else {
      console.log(`[smoke] GPU flags accepted, renderer: ${renderer}; captures still work.`);
    }
    return browser;
  } catch (err) {
    console.warn(`[smoke] GPU-accelerated launch failed (${err instanceof Error ? err.message : err}), falling back to SwiftShader.`);
    return chromium.launch({ headless: true });
  }
}

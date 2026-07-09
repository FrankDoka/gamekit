/**
 * Genre-neutral capture boot — the shared "boot + drive + screenshot" primitive
 * for reference games that do NOT fit the action-game smoke reader (which assumes
 * a Phaser `__GAME` scene with a Colyseus `room.state.players`-by-sessionId).
 *
 * It reuses the exact same boot mechanics as the action harness
 * (`tools/src/smoke/harness.ts`): the same port-reservation TOCTOU guard
 * (`reserveOpenPort`), the same detached process spawn/stop (`process-tree.ts`),
 * and the same ownership handshake (`serverOutputProvesOwnership` — the spawned
 * server must echo OUR unique `smokeRunId` in its "listening" boot log before we
 * trust the port). The ONLY thing it drops is the action-specific readiness gate:
 * instead of waiting on `__GAME.scene("game").room.state.players`, the caller
 * supplies a genre-appropriate ready predicate (`waitForReady`).
 *
 * This lets a TACTICS game (units-by-team, no `players`) and a GACHA game (DOM UI
 * over an HTTP request/response server, no Colyseus room at all) be tool-driven
 * without touching `harness.ts` / `state.ts` / `capture-zone.ts`. The action-game
 * callers of `createSmokeHarness` are entirely unaffected — this is a sibling, not
 * a modification.
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { type ChildProcess } from "child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import {
  CLIENT_PORT_END,
  CLIENT_PORT_START,
  SERVER_PORT_END,
  SERVER_PORT_START,
  TIMEOUT,
} from "./constants";
// Reuse the action harness's already-exported primitives verbatim (no fork):
// the reservation guard and the ownership-proof predicate are pure and shared.
import { reserveOpenPort, serverOutputProvesOwnership } from "./harness";
import { spawnProcessTree, stopProcessTree } from "./process-tree";

export type GenreCaptureOptions = {
  /** Absolute path to the game project root (holds `server/` and `client/`). */
  gameRoot: string;
  /** Extra env for the server process (merged over the defaults below). */
  serverEnv?: NodeJS.ProcessEnv;
  /**
   * Extra env for the vite client process. Genre-specific wiring goes here —
   * e.g. the gacha client reads `VITE_API_BASE`, the tactics client reads
   * `VITE_COLYSEUS_URL`. Templated `{{SERVER_PORT}}` in a value is replaced with
   * the reserved server port so callers don't need it up front.
   */
  clientEnv?: Record<string, string>;
  /** Viewport for the single driven page. */
  viewport?: { width: number; height: number };
};

export type GenreCaptureHarness = {
  browser: Browser;
  page: Page;
  consoleErrors: string[];
  serverPort: number;
  clientPort: number;
  /** The unique run id this harness's server proved ownership with. */
  smokeRunId: string;
  /** Read accumulated stdout+stderr of the spawned server (for assertions/debug). */
  serverOutput: () => string;
  stop: () => Promise<void>;
};

/**
 * Boot `${gameRoot}/server` (tsx) + `${gameRoot}/client` (vite) on reserved
 * ports, ownership-gate on the boot log, open one browser page at the client, and
 * return handles. Does NOT click guest or wait for any game readiness — the caller
 * drives the genre-specific flow (guest click + ready predicate) itself.
 */
export async function bootGenreCapture(options: GenreCaptureOptions): Promise<GenreCaptureHarness> {
  const gameRoot = options.gameRoot.replace(/\\/g, "/");
  const smokeRunId = randomUUID();
  const childProcesses: ChildProcess[] = [];
  const outputs = new WeakMap<ChildProcess, string[]>();
  let stopping = false;

  const serverReservation = await reserveOpenPort(SERVER_PORT_START, SERVER_PORT_END);
  const clientReservation = await reserveOpenPort(CLIENT_PORT_START, CLIENT_PORT_END);
  const serverPort = serverReservation.port;
  const clientPort = clientReservation.port;

  const captureOutput = (label: string, child: ChildProcess): void => {
    const buf: string[] = [];
    outputs.set(child, buf);
    const record = (data: Buffer, write: (t: string) => boolean) => {
      const text = data.toString();
      buf.push(text);
      write(`[${label}] ${text}`);
    };
    child.stdout?.on("data", (d: Buffer) => record(d, (t) => process.stdout.write(t)));
    child.stderr?.on("data", (d: Buffer) => record(d, (t) => process.stderr.write(t)));
    child.on("exit", (code) => {
      if (!stopping && code !== null && code !== 0) console.error(`[${label}] exited with code ${code}`);
    });
  };
  const serverOutput = (child: ChildProcess): string => (outputs.get(child) ?? []).join("");

  const stop = async (): Promise<void> => {
    stopping = true;
    await Promise.all(childProcesses.map((c) => stopProcessTree(c)));
  };

  // --- server (tsx src/index.ts) --------------------------------------------
  console.log(`[capture] Starting ${gameRoot} server on :${serverPort} (runId ${smokeRunId})...`);
  serverReservation.release();
  const server = spawnProcessTree(process.execPath, [`${gameRoot}/node_modules/tsx/dist/cli.mjs`, "src/index.ts"], {
    cwd: `${gameRoot}/server`,
    env: {
      ...process.env,
      PORT: String(serverPort),
      ALLOW_GUEST_LOGIN: "true",
      GAMEKIT_SMOKE_RUN_ID: smokeRunId,
      ...options.serverEnv,
    },
    stdio: "pipe",
  });
  childProcesses.push(server);
  captureOutput("server", server);
  await waitUntil("server", () => isPortOpen(serverPort), server, () => serverOutput(server));

  // Ownership handshake: same guarantee as the action harness — refuse the port
  // unless OUR spawned child echoed OUR runId, converting any residual collision
  // with a foreign server into a loud fail instead of a silent reuse.
  await assertOwnership(server, smokeRunId, serverPort, () => serverOutput(server));
  console.log("[capture] Server ready (ownership proven).");

  // --- client (vite) ---------------------------------------------------------
  console.log(`[capture] Starting ${gameRoot} client on :${clientPort}...`);
  clientReservation.release();
  const resolvedClientEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.clientEnv ?? {})) {
    resolvedClientEnv[k] = v.replace(/\{\{SERVER_PORT\}\}/g, String(serverPort));
  }
  const client = spawnProcessTree(
    process.execPath,
    [`${gameRoot}/client/node_modules/vite/bin/vite.js`, "--host", "127.0.0.1", "--port", String(clientPort), "--strictPort"],
    {
      cwd: `${gameRoot}/client`,
      env: { ...process.env, ...resolvedClientEnv },
      stdio: "pipe",
    },
  );
  childProcesses.push(client);
  captureOutput("client", client);
  await waitUntil("client", () => isPortOpen(clientPort), client, () => serverOutput(client));
  console.log("[capture] Client ready.");

  // --- browser ---------------------------------------------------------------
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: options.viewport ?? { width: 960, height: 720 } });
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      consoleErrors.push(text);
      console.error(`[browser:error] ${text}`);
    }
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  const url = `http://127.0.0.1:${clientPort}`;
  console.log("[capture] Opening client at", url);
  await page.goto(url, { waitUntil: "networkidle", timeout: TIMEOUT });

  return {
    browser,
    page,
    consoleErrors,
    serverPort,
    clientPort,
    smokeRunId,
    serverOutput: () => serverOutput(server),
    stop,
  };
}

async function assertOwnership(child: ChildProcess, runId: string, port: number, output: () => string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < TIMEOUT) {
    if (serverOutputProvesOwnership(output(), runId)) return;
    if (child.exitCode !== null) {
      throw new Error(`[capture] server exited (code ${child.exitCode}) before proving ownership (runId ${runId})`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `[capture] refusing to use server on :${port}: it did not announce runId ${runId} within ${TIMEOUT}ms.\n` +
      output().slice(-2000),
  );
}

async function waitUntil(label: string, check: () => Promise<boolean>, child: ChildProcess, output: () => string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < TIMEOUT) {
    if (await check()) return;
    if (child.exitCode !== null) {
      throw new Error(`${label} exited early with code ${child.exitCode}:\n${output()}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${label} did not become ready in ${TIMEOUT}ms:\n${output()}`);
}

function isPortOpen(port: number): Promise<boolean> {
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

async function launchBrowser(): Promise<Browser> {
  const args = ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11", "--enable-unsafe-swiftshader"];
  try {
    return await chromium.launch({ headless: true, args });
  } catch {
    return chromium.launch({ headless: true });
  }
}

/** Click `#auth-guest` — the shared guest entry convention across all references. */
export async function clickGuest(page: Page): Promise<void> {
  const button = page.locator("#auth-guest").first();
  await button.waitFor({ state: "visible", timeout: TIMEOUT });
  await button.click();
}

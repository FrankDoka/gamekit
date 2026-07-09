import { chromium, type Page } from "@playwright/test";
import { type ChildProcess, spawn } from "child_process";
import { mkdirSync } from "node:fs";
import net from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CLIENT_PORT_END, CLIENT_PORT_START, ROOT, TIMEOUT } from "./smoke/constants";

const children: ChildProcess[] = [];
let stopping = false;

export async function runAuthCapture(outDirArg = "tools/_capture/auth"): Promise<void> {
  const outDir = resolve(outDirArg).replace(/\\/g, "/");
  mkdirSync(outDir, { recursive: true });
  const clientPort = await findOpenPort(CLIENT_PORT_START, CLIENT_PORT_END);

  await startDevServer(clientPort);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const baseUrl = `http://127.0.0.1:${clientPort}`;
  try {
    await mockAuthEndpoints(page);
    await page.goto(baseUrl, { waitUntil: "networkidle", timeout: TIMEOUT });
    await waitForAuth(page);
    // Login CTA text is game-specific; the game names it via GAME_LOGIN_CTA_TEXT.
    await expectVisibleText(page, process.env.GAME_LOGIN_CTA_TEXT ?? "Enter Game");
    await page.screenshot({ path: `${outDir}/01-login.png`, fullPage: true });

    await seedAuth(page);
    await page.reload({ waitUntil: "networkidle", timeout: TIMEOUT });
    await page.locator("#auth-character-slot-0 .auth-character-login").waitFor({ state: "visible", timeout: TIMEOUT });
    await expectVisibleText(page, "Choose Your Hero");
    await expectVisibleText(page, "Suncradle");
    await page.screenshot({ path: `${outDir}/02-character-select.png`, fullPage: true });

    await page.locator("#auth-character-slot-1").click();
    await page.locator(".auth-character-create").waitFor({ state: "visible", timeout: TIMEOUT });
    await expectVisibleText(page, "Create Slot 2");
    await page.screenshot({ path: `${outDir}/03-character-create.png`, fullPage: true });

    await page.locator(".auth-character-create button", { hasText: "Cancel" }).click();
    await page.locator("#auth-character-slot-0 .auth-character-delete").click();
    await page.locator(".auth-character-delete-confirm").waitFor({ state: "visible", timeout: TIMEOUT });
    await expectVisibleText(page, "Delete Mira Vale?");
    await page.screenshot({ path: `${outDir}/04-delete-confirm.png`, fullPage: true });

    await page.evaluate(() => localStorage.clear());
    await page.goto(`${baseUrl}/?capture=discord#auth=discord_name_required&pendingToken=capture-token&suggestedDisplayName=DiscordScout`, { waitUntil: "networkidle", timeout: TIMEOUT });
    await page.locator("input[name='displayName']").waitFor({ state: "visible", timeout: TIMEOUT });
    await expectVisibleText(page, "Claim Your Name");
    await page.screenshot({ path: `${outDir}/05-discord-name.png`, fullPage: true });

    console.log(`[capture-auth] wrote ${outDir}`);
  } finally {
    await browser.close().catch(() => undefined);
    await stopChildren();
  }
}

async function mockAuthEndpoints(page: Page): Promise<void> {
  await page.route("**/api/auth/config", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ type: "auth.config", allowGuestLogin: true }),
  }));
  await page.route("**/api/auth/characters", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      type: "auth.characters",
      maxSlots: 9,
      characters: [{
        id: "capture-character-1",
        slotIndex: 0,
        name: "Mira Vale",
        level: 7,
        xp: 420,
        mapId: "map_harbor_outskirts",
      }],
    }),
  }));
}

async function seedAuth(page: Page): Promise<void> {
  await page.evaluate((auth) => {
    localStorage.setItem("gamekit.authSessionToken", auth.sessionToken);
    localStorage.setItem("gamekit.authDisplayName", auth.displayName);
    localStorage.setItem("gamekit.authProvider", auth.provider);
    localStorage.removeItem("gamekit.authCharacterId");
    localStorage.removeItem("gamekit.authCharacterName");
  }, { sessionToken: "capture-session-token", displayName: "Capture Scout", provider: "email" });
}

async function waitForAuth(page: Page): Promise<void> {
  await page.locator("#auth-gate:not([hidden])").waitFor({ state: "visible", timeout: TIMEOUT });
}

async function expectVisibleText(page: Page, text: string): Promise<void> {
  await page.getByText(text, { exact: true }).first().waitFor({ state: "visible", timeout: TIMEOUT });
}

async function startDevServer(clientPort: number): Promise<void> {
  const client = spawn(process.execPath, [`${ROOT}/client/node_modules/vite/bin/vite.js`, "--host", "127.0.0.1", "--port", String(clientPort), "--strictPort"], {
    cwd: `${ROOT}/client`,
    env: {
      ...process.env,
      VITE_API_PROXY_TARGET: "http://127.0.0.1:2567",
      VITE_COLYSEUS_URL: "ws://127.0.0.1:2567",
    },
    stdio: "pipe",
  });
  children.push(client);
  pipeOutput("client", client);
  await waitUntil("client dev server", () => isPortOpen(clientPort), TIMEOUT, client);
}

async function stopChildren(): Promise<void> {
  stopping = true;
  await Promise.all(children.map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill();
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 1_000);
  })));
}

function pipeOutput(label: string, child: ChildProcess): void {
  child.stdout?.on("data", (data: Buffer) => process.stdout.write(`[${label}] ${data.toString()}`));
  child.stderr?.on("data", (data: Buffer) => process.stderr.write(`[${label}] ${data.toString()}`));
  child.on("exit", (code) => {
    if (!stopping && code !== null && code !== 0) console.error(`[${label}] exited with code ${code}`);
  });
}

async function waitUntil(label: string, check: () => Promise<boolean>, timeoutMs: number, child: ChildProcess): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`${label} exited early with code ${child.exitCode}`);
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready in ${timeoutMs}ms`);
}

async function findOpenPort(first: number, last: number): Promise<number> {
  for (let port = first; port <= last; port += 1) {
    if (!(await isPortOpen(port))) return port;
  }
  throw new Error(`No open port found between ${first} and ${last}`);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAuthCapture(process.argv[2]).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    void stopChildren().finally(() => process.exit(1));
  });
}

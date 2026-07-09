import type { Page } from "@playwright/test";
import { spawnSync } from "child_process";
import net from "node:net";
import { createSmokeHarness, stopChildProcesses } from "./smoke/harness";
import { ROOT, TIMEOUT } from "./smoke/constants";
import { waitForJoined } from "./smoke/state";

const POSTGRES_IMAGE = "postgres:16-alpine";
const POSTGRES_PASSWORD = "gamekit_smoke";
const POSTGRES_DB = "gamekit_smoke";
let dockerContainerName: string | null = null;

type AuthSuccess = {
  type: "auth.success";
  sessionToken: string;
  displayName: string;
  provider: string;
};

type CharacterCreated = {
  type: "auth.character.created";
  character: { id: string; name: string };
};

export async function runSmokeAuthFlow(): Promise<void> {
  const databaseUrl = await prepareDatabase();
  runCommand("migrate", "pnpm", ["db:migrate"], { DATABASE_URL: databaseUrl });
  const harness = await createSmokeHarness({ allowSplitMaps: true, worldEnv: { DATABASE_URL: databaseUrl } });
  const origin = `http://127.0.0.1:${harness.clientPort}`;
  try {
    await assertGameJoined(harness.pageA, "guest");

    const suffix = Math.random().toString(36).slice(2, 10);
    const account = await createAccountCharacter(origin, suffix);
    const accountPage = await harness.browser.newPage({ viewport: { width: 960, height: 540 } });
    await seedAccount(accountPage, account);
    await accountPage.goto(origin, { waitUntil: "networkidle", timeout: TIMEOUT });
    await accountPage.locator("#auth-character-slot-0 .auth-character-login").waitFor({ state: "visible", timeout: TIMEOUT });
    await accountPage.locator("#auth-character-slot-0 .auth-character-login").click();
    await assertGameJoined(accountPage, "account");
    await accountPage.close();
    console.log("[smoke:auth-flow] guest and account character-select flows passed.");
  } finally {
    await harness.browser.close().catch(() => undefined);
    await stopChildProcesses();
    cleanupDocker();
  }
}

async function createAccountCharacter(origin: string, suffix: string): Promise<AuthSuccess & { characterId: string; characterName: string }> {
  const auth = await post<AuthSuccess>(origin, "/api/auth/register", {
    type: "auth.register",
    email: `authflow-${suffix}@example.test`,
    password: `AuthFlow-${suffix}-Pass1`,
  });
  if (auth.type !== "auth.success") throw new Error(`auth-flow register failed: ${JSON.stringify(auth)}`);

  const created = await post<CharacterCreated>(origin, "/api/auth/characters/create", {
    type: "auth.characters.create",
    sessionToken: auth.sessionToken,
    slotIndex: 0,
    name: `Flow${suffix.slice(0, 6)}`,
  });
  if (created.type !== "auth.character.created") throw new Error(`auth-flow character create failed: ${JSON.stringify(created)}`);
  return { ...auth, characterId: created.character.id, characterName: created.character.name };
}

async function post<T>(origin: string, path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json() as Promise<T>;
}

async function seedAccount(page: Page, account: AuthSuccess & { characterId: string; characterName: string }): Promise<void> {
  await page.addInitScript((seed) => {
    localStorage.setItem("gamekit.authSessionToken", seed.sessionToken);
    localStorage.setItem("gamekit.authDisplayName", seed.displayName);
    localStorage.setItem("gamekit.authProvider", seed.provider);
    localStorage.removeItem("gamekit.authCharacterId");
    localStorage.removeItem("gamekit.authCharacterName");
  }, account);
}

async function assertGameJoined(page: Page, label: string): Promise<void> {
  const joined = await waitForJoined(page);
  if (!joined.localSessionId) throw new Error(`${label} did not join world`);
}

async function prepareDatabase(): Promise<string> {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  ensureDockerAvailable();
  const port = await findOpenPort(55432, 55442);
  dockerContainerName = `gamekit-auth-flow-postgres-${process.pid}`;

  runCommand("docker", "docker", [
    "run",
    "--rm",
    "-d",
    "--name",
    dockerContainerName,
    "-e",
    `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
    "-e",
    `POSTGRES_DB=${POSTGRES_DB}`,
    "-p",
    `${port}:5432`,
    POSTGRES_IMAGE,
  ]);

  await waitForPort("postgres", port, TIMEOUT);
  return `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${port}/${POSTGRES_DB}`;
}

function ensureDockerAvailable(): void {
  const version = spawnSync("docker", ["version"], { shell: true, stdio: "pipe" });
  if (version.status !== 0) {
    throw new Error(`DATABASE_URL is not set and Docker daemon is not available.\n${version.stderr.toString()}`);
  }
}

function runCommand(label: string, command: string, args: string[], env: NodeJS.ProcessEnv = {}): void {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    shell: true,
    stdio: "pipe",
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`${label} failed:\n${result.stdout}\n${result.stderr}`);
}

async function waitForPort(label: string, port: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isPortOpen(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready in ${timeoutMs}ms`);
}

async function findOpenPort(first: number, last: number): Promise<number> {
  for (let port = first; port <= last; port += 1) {
    if (!(await isPortOpen(port))) return port;
  }
  throw new Error(`No open PostgreSQL smoke-test port found between ${first} and ${last}.`);
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

function cleanupDocker(): void {
  if (!dockerContainerName || process.env.DATABASE_URL) return;
  spawnSync("docker", ["rm", "-f", dockerContainerName], { shell: true, stdio: "ignore" });
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  runSmokeAuthFlow().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    cleanupDocker();
    void stopChildProcesses().finally(() => process.exit(1));
  });
}

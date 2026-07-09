/**
 * Live browser proof for the GM panel card.
 *
 * Boots the normal smoke server/client, captures a guest session with no GM button,
 * then joins an env-allowlisted account in a real browser session and drives the
 * GM panel buttons through the chat command path.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { Client, type Room } from "colyseus.js";
import type { ChatEvent } from "@gamekit/game-contract";
import { createSmokeHarness, stopChildProcesses } from "./smoke/harness";
import { ROOT } from "./smoke/constants";

type AuthSuccess = {
  type: "auth.success";
  sessionToken: string;
  accountId: string;
  displayName: string;
};

type CharacterSummary = {
  id: string;
  name: string;
};

type CharacterList = {
  type: "auth.characters";
  characters: CharacterSummary[];
};

type CharacterCreated = {
  type: "auth.character.created";
  character: CharacterSummary;
};

const outDir = process.argv[2] ?? "tools/_gm-panel-proof";
const adminEmail = "admin-gm-panel-proof@example.com";
const adminAllowlistName = "admin-gm-panel-proof";
const adminCharacterName = "AdminGmProof";
const password = "ProofPass123!";
const POSTGRES_IMAGE = "postgres:16-alpine";
const POSTGRES_PASSWORD = "gamekit_smoke";
const POSTGRES_DB = "gamekit_smoke";
let dockerContainerName: string | null = null;

async function main(): Promise<void> {
  process.env.GAMEKIT_ADMIN_ACCOUNTS = process.env.GAMEKIT_ADMIN_ACCOUNTS || adminCharacterName;
  mkdirSync(outDir, { recursive: true });
  const databaseUrl = await prepareDatabase();
  runCommand("migrate", "pnpm", ["db:migrate"], { DATABASE_URL: databaseUrl });
  const harness = await createSmokeHarness({ worldEnv: { DATABASE_URL: databaseUrl } });
  const proof: Record<string, unknown> = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    adminAllowlist: process.env.GAMEKIT_ADMIN_ACCOUNTS,
  };

  try {
    await harness.pageA.screenshot({ path: `${outDir}/guest-gm-hidden.png` });
    const guestButtonVisible = await harness.pageA.locator("#gm-toggle").isVisible();
    proof.guest = {
      screenshot: `${outDir}/guest-gm-hidden.png`,
      gmButtonVisible: guestButtonVisible,
    };
    if (guestButtonVisible) throw new Error("expected guest GM button to be hidden");

    const clientOrigin = new URL(harness.pageA.url()).origin;
    const serverWs = `ws://127.0.0.1:${harness.serverPort}`;
    const auth = await loginOrRegister(clientOrigin);
    const character = await getOrCreateCharacter(clientOrigin, auth.sessionToken, adminCharacterName, 0);
    const adminPage = await harness.browser.newPage({ viewport: { width: 960, height: 540 } });
    await adminPage.addInitScript(
      ({ sessionToken, displayName, characterId, characterName }) => {
        localStorage.setItem("gamekit.authSessionToken", sessionToken);
        localStorage.setItem("gamekit.authDisplayName", displayName);
        localStorage.setItem("gamekit.authCharacterId", characterId);
        localStorage.setItem("gamekit.authCharacterName", characterName);
      },
      {
        sessionToken: auth.sessionToken,
        displayName: auth.displayName,
        characterId: character.id,
        characterName: character.name,
      },
    );
    await adminPage.goto(clientOrigin, { waitUntil: "networkidle", timeout: 20_000 });
    await adminPage.locator(".auth-character-login").first().waitFor({ state: "visible", timeout: 20_000 });
    await adminPage.locator(".auth-character-login").first().click();
    await adminPage.waitForFunction(() => {
      const pageGlobal = globalThis as unknown as { document: { body: { classList: { contains(name: string): boolean } } } };
      return pageGlobal.document.body.classList.contains("game-started");
    }, undefined, { timeout: 20_000 });
    await adminPage.locator("#gm-toggle").waitFor({ state: "visible", timeout: 20_000 });
    await adminPage.screenshot({ path: `${outDir}/admin-gm-visible.png` });

    await adminPage.locator("#gm-toggle").click();
    await adminPage.locator("#gm-panel").waitFor({ state: "visible", timeout: 5_000 });
    await adminPage.locator("#gm-spawn-monster").selectOption("monster_meadow_slime");
    await adminPage.locator("#gm-spawn-count").fill("1");
    await adminPage.getByRole("button", { name: "Spawn", exact: true }).click();
    await adminPage.locator("#gm-panel .gm-panel-reply", { hasText: "GM: spawned 1 monster_meadow_slime" }).waitFor({ timeout: 5_000 });

    await adminPage.locator("#gm-give-item").selectOption("item_gold");
    await adminPage.locator("#gm-give-qty").fill("7");
    await adminPage.getByRole("button", { name: "Give", exact: true }).click();
    await adminPage.locator("#gm-panel .gm-panel-reply", { hasText: "GM: gave 7 item_gold" }).waitFor({ timeout: 5_000 });

    await adminPage.locator("#gm-god").click();
    await adminPage.locator("#gm-panel .gm-panel-reply", { hasText: "GM: god mode enabled" }).waitFor({ timeout: 5_000 });
    await adminPage.screenshot({ path: `${outDir}/admin-panel-commands.png` });

    const commandState = await adminPage.evaluate(() => {
      const scene = (globalThis as {
        __GAME?: { scene?: { getScene?(key: string): unknown } };
      }).__GAME?.scene?.getScene?.("game") as
        | {
            getVisualQaSnapshot?: () => { monsters: Array<{ id: string; kind: string; alive?: boolean }> };
          }
        | undefined;
      const pageGlobal = globalThis as unknown as { document: { querySelector(selector: string): { textContent?: string | null } | null } };
      const reply = pageGlobal.document.querySelector("#gm-panel .gm-panel-reply")?.textContent ?? "";
      const snapshot = scene?.getVisualQaSnapshot?.();
      return {
        reply,
        spawnedMeadowSlimes: snapshot?.monsters.filter((monster) => monster.id.includes("monster_meadow_slime") && monster.alive).length ?? 0,
      };
    });

    const colyseus = new Client(serverWs);
    const adminRoom = await colyseus.joinOrCreate("world", {
      sessionToken: auth.sessionToken,
      characterId: character.id,
    });
    try {
      const serverGateProof = await expectSystem(adminRoom, "/where", "GM:");
      proof.serverGateRoundTrip = serverGateProof.text;
    } finally {
      await adminRoom.leave();
    }

    proof.admin = {
      visibleScreenshot: `${outDir}/admin-gm-visible.png`,
      commandScreenshot: `${outDir}/admin-panel-commands.png`,
      finalReply: commandState.reply,
      spawnedMeadowSlimes: commandState.spawnedMeadowSlimes,
    };

    writeFileSync(`${outDir}/proof.json`, JSON.stringify(proof, null, 2) + "\n", "utf8");
    console.log(`[gm-panel-proof] proof -> ${outDir}/proof.json`);
  } finally {
    await harness.browser.close();
    stopChildProcesses();
    cleanupDocker();
  }
}

async function loginOrRegister(origin: string): Promise<AuthSuccess> {
  const registered = await post<AuthSuccess | { type: "auth.error"; code: string }>(origin, "/api/auth/register", {
    type: "auth.register",
    email: adminEmail,
    password,
    displayName: adminAllowlistName,
  });
  if (registered.type === "auth.success") return registered;

  const loggedIn = await post<AuthSuccess>(origin, "/api/auth/login", {
    type: "auth.login",
    email: adminEmail,
    password,
  });
  if (loggedIn.type !== "auth.success") throw new Error("admin login failed");
  return loggedIn;
}

async function getOrCreateCharacter(origin: string, sessionToken: string, name: string, slotIndex: number): Promise<CharacterSummary> {
  const existing = await post<CharacterList>(origin, "/api/auth/characters", {
    type: "auth.characters.list",
    sessionToken,
  });
  const found = existing.characters.find((character) => character.name === name);
  if (found) return found;
  const created = await post<CharacterCreated>(origin, "/api/auth/characters/create", {
    type: "auth.characters.create",
    sessionToken,
    name,
    slotIndex,
  });
  return created.character;
}

async function post<T>(origin: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json() as T;
  if (!response.ok && !isEmailTaken(json)) {
    throw new Error(`${path} failed ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function isEmailTaken(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "code" in value && value.code === "EMAIL_TAKEN");
}

async function expectSystem(room: Room, command: string, expected: string): Promise<Extract<ChatEvent, { type: "system" }>> {
  const eventPromise = new Promise<Extract<ChatEvent, { type: "system" }>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      remove();
      reject(new Error(`Timed out waiting for system chat containing "${expected}"`));
    }, 5_000);
    const remove = room.onMessage("chat", (event: ChatEvent) => {
      if (event.type !== "system" || !event.text.includes(expected)) return;
      clearTimeout(timeout);
      remove();
      resolve(event);
    });
  });
  room.send("intent", {
    type: "chat.send",
    requestId: `gm-panel-proof-${Date.now()}`,
    text: command,
  });
  return eventPromise;
}

main().catch((error) => {
  console.error("[gm-panel-proof] FATAL:", error);
  stopChildProcesses();
  cleanupDocker();
  process.exit(1);
});

async function prepareDatabase(): Promise<string> {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  ensureDockerAvailable();
  const port = await findOpenPort(55432, 55442);
  dockerContainerName = `gamekit-gm-panel-postgres-${process.pid}`;

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

  await waitUntil("postgres", () => isPortOpen(port), 30_000);
  return `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${port}/${POSTGRES_DB}`;
}

function ensureDockerAvailable(): void {
  const version = spawnSync("docker", ["version"], { shell: true, stdio: "pipe" });
  if (version.status !== 0) {
    throw new Error(
      `DATABASE_URL is not set and Docker daemon is not available. Set DATABASE_URL or start Docker to run the GM panel proof.\n${version.stderr.toString()}`,
    );
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

  if (result.status !== 0) {
    throw new Error(`${label} failed:\n${result.stdout}\n${result.stderr}`);
  }
}

async function waitUntil(label: string, check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready in ${timeoutMs}ms`);
}

async function findOpenPort(first: number, last: number): Promise<number> {
  for (let port = first; port <= last; port += 1) {
    if (!(await isPortOpen(port))) return port;
  }
  throw new Error(`No open PostgreSQL proof port found between ${first} and ${last}.`);
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
  if (!dockerContainerName) return;
  spawnSync("docker", ["rm", "-f", dockerContainerName], { shell: true, stdio: "ignore" });
  dockerContainerName = null;
}

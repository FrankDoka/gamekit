import { Client, type Room } from "colyseus.js";
import type { ChatEvent } from "@gamekit/game-contract";

type AuthSuccess = {
  type: "auth.success";
  sessionToken: string;
  accountId: string;
  displayName: string;
  provider: string;
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

const baseHttp = process.env.GAMEKIT_GM_PROOF_HTTP ?? "http://127.0.0.1:2567";
const baseWs = process.env.GAMEKIT_GM_PROOF_WS ?? baseHttp.replace(/^http/, "ws");
const adminEmail = "admin-gm-proof@example.com";
const nonAdminEmail = "plain-gm-proof@example.com";
const password = "ProofPass123!";
const adminName = "AdminGmProof";
const nonAdminName = "PlainGmProof";
const guestName = "GuestGmProof";

const transcript: string[] = [];

async function main(): Promise<void> {
  const adminAuth = await loginOrRegister(adminEmail);
  const nonAdminAuth = await loginOrRegister(nonAdminEmail);
  const adminCharacter = await getOrCreateCharacter(adminAuth.sessionToken, adminName, 0);
  const nonAdminCharacter = await getOrCreateCharacter(nonAdminAuth.sessionToken, nonAdminName, 0);

  const client = new Client(baseWs);
  const guest = await client.joinOrCreate("world", { guestName, guestToken: "gm-proof-guest" });
  const nonAdmin = await client.joinOrCreate("world", {
    sessionToken: nonAdminAuth.sessionToken,
    characterId: nonAdminCharacter.id,
  });
  const admin = await client.joinOrCreate("world", {
    sessionToken: adminAuth.sessionToken,
    characterId: adminCharacter.id,
  });

  try {
    transcript.push(`# GM command live proof`);
    transcript.push(`server: ${baseHttp}`);
    transcript.push(`guest: ${guestName}`);
    transcript.push(`non-admin: ${nonAdminName}`);
    transcript.push(`admin: ${adminName}`);

    await expectPrivateSystem(guest, "/where", "Unknown command.", "guest rejected");
    await expectPrivateSystem(nonAdmin, "/where", "Unknown command.", "non-admin rejected");

    const adminPlayer = await waitForPlayer(admin, admin.sessionId);
    const targetX = Math.round(adminPlayer.x + 20);
    const targetY = Math.round(adminPlayer.y + 20);

    await expectPrivateSystem(admin, "/where", "GM:", "where");
    await expectPrivateSystem(admin, `/tp ${targetX} ${targetY}`, "GM: teleported", "tp");
    await expectPrivateSystem(admin, `/tpto ${guestName}`, "GM: teleported", "tpto");
    await expectPrivateSystem(admin, "/spawn monster_meadow_slime 2", "GM: spawned 2", "spawn");
    await expectPrivateSystem(admin, "/despawn 9999", "GM: despawned", "despawn");
    await expectPrivateSystem(admin, "/spawn monster_dew_slime 1", "GM: spawned 1", "spawn setup for killall");
    await expectPrivateSystem(admin, "/killall 9999", "GM: killed", "killall");
    await expectPrivateSystem(admin, "/give gold 7", "GM: gave 7 item_gold", "give gold");
    await expectPrivateSystem(admin, "/give item_minor_health_potion 1", "GM: gave 1 item_minor_health_potion", "give item");
    await expectPrivateSystem(admin, "/heal", `GM: healed ${adminName}`, "heal");
    await expectPrivateSystem(admin, "/god", "GM: god mode enabled", "god");
    await expectAnnouncement(admin, guest, "/announce GM proof announcement", "GM proof announcement", "announce");
    await delay(5100);
    await expectPrivateSystem(admin, "/gmhelp", "GM commands:", "gmhelp");

    transcript.push("");
    transcript.push("RESULT: PASS");
    console.log(transcript.join("\n"));
  } finally {
    await Promise.allSettled([admin.leave(), nonAdmin.leave(), guest.leave()]);
  }
}

async function loginOrRegister(email: string): Promise<AuthSuccess> {
  const registered = await post<AuthSuccess | { type: "auth.error"; code: string }>("/api/auth/register", {
    type: "auth.register",
    email,
    password,
  });
  if (registered.type === "auth.success") return registered;

  const loggedIn = await post<AuthSuccess>("/api/auth/login", {
    type: "auth.login",
    email,
    password,
  });
  if (loggedIn.type !== "auth.success") throw new Error(`login failed for ${email}`);
  return loggedIn;
}

async function getOrCreateCharacter(sessionToken: string, name: string, slotIndex: number): Promise<CharacterSummary> {
  const existing = await post<CharacterList>("/api/auth/characters", {
    type: "auth.characters.list",
    sessionToken,
  });
  const found = existing.characters.find((character) => character.name === name);
  if (found) return found;

  const created = await post<CharacterCreated>(
    "/api/auth/characters/create",
    {
      type: "auth.characters.create",
      sessionToken,
      name,
      slotIndex,
    },
  );
  return created.character;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseHttp}${path}`, {
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

async function expectPrivateSystem(room: Room, command: string, expected: string, label: string): Promise<void> {
  const eventPromise = waitForSystemChat(room, expected);
  room.send("intent", {
    type: "chat.send",
    requestId: `gm-proof-${label.replace(/\s+/g, "-")}-${Date.now()}`,
    text: command,
  });
  const event = await eventPromise;
  transcript.push(`- ${label}: sent \`${command}\` -> ${event.text}`);
}

async function expectAnnouncement(admin: Room, guest: Room, command: string, expected: string, label: string): Promise<void> {
  const adminReply = waitForSystemChat(admin, "GM: announcement sent.");
  const guestAnnouncement = waitForSystemChat(guest, expected);
  admin.send("intent", {
    type: "chat.send",
    requestId: `gm-proof-${label}-${Date.now()}`,
    text: command,
  });
  const [reply, announcement] = await Promise.all([adminReply, guestAnnouncement]);
  transcript.push(`- ${label}: sent \`${command}\` -> ${reply.text}; guest saw "${announcement.text}"`);
}

async function waitForSystemChat(room: Room, expectedText: string): Promise<Extract<ChatEvent, { type: "system" }>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      remove();
      reject(new Error(`Timed out waiting for system chat containing "${expectedText}"`));
    }, 5000);
    const remove = room.onMessage("chat", (event: ChatEvent) => {
      if (event.type !== "system" || !event.text.includes(expectedText)) return;
      clearTimeout(timeout);
      remove();
      resolve(event);
    });
  });
}

async function waitForPlayer(room: Room, sessionId: string): Promise<{ x: number; y: number }> {
  const state = room.state as { players?: Map<string, { x: number; y: number }> };
  for (let i = 0; i < 50; i += 1) {
    const player = state.players?.get(sessionId);
    if (player) return player;
    await delay(100);
  }
  throw new Error(`player ${sessionId} did not appear in room state`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("[gm-proof] FATAL:", err);
  process.exit(1);
});

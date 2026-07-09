import { Client as ColyseusClient } from "colyseus.js";
import crypto from "node:crypto";

const ENDPOINT = process.env.LOADTEST_URL || "ws://localhost:2567";
const TARGET_CLIENTS = parseInt(process.env.LOADTEST_CLIENTS || "50", 10);
const RAMP_DELAY_MS = parseInt(process.env.LOADTEST_RAMP_MS || "200", 10);
const MOVE_INTERVAL_MS = 2000;
const DURATION_SEC = parseInt(process.env.LOADTEST_DURATION || "60", 10);

interface BotState {
  id: string;
  room: LoadTestRoom;
  moveTimer?: ReturnType<typeof setInterval>;
}

type LoadTestRoom = {
  send(type: "intent", payload: { type: "move"; x: number; y: number; seq: number }): void;
  leave(): void;
};

const bots: BotState[] = [];
let joinErrors = 0;

async function spawnBot(index: number): Promise<BotState | null> {
  const token = `loadtest-${crypto.randomUUID()}`;
  const client = new ColyseusClient(ENDPOINT);
  try {
    const room = await client.joinOrCreate("world", {
      guestName: `Bot-${index}`,
      guestToken: token,
    });

    const moveTimer = setInterval(() => {
      const x = Math.floor(Math.random() * 1200) + 100;
      const y = Math.floor(Math.random() * 800) + 100;
      room.send("intent", {
        type: "move",
        x,
        y,
        seq: Date.now(),
      });
    }, MOVE_INTERVAL_MS);

    return { id: `Bot-${index}`, room, moveTimer };
  } catch (err) {
    joinErrors++;
    console.error(`Bot-${index} failed to join:`, (err as Error).message);
    return null;
  }
}

async function run(): Promise<void> {
  console.log(`\n  Load Test Configuration`);
  console.log(`  =======================`);
  console.log(`  Endpoint:    ${ENDPOINT}`);
  console.log(`  Target bots: ${TARGET_CLIENTS}`);
  console.log(`  Ramp delay:  ${RAMP_DELAY_MS}ms between joins`);
  console.log(`  Move every:  ${MOVE_INTERVAL_MS}ms`);
  console.log(`  Duration:    ${DURATION_SEC}s\n`);

  for (let i = 0; i < TARGET_CLIENTS; i++) {
    const bot = await spawnBot(i);
    if (bot) bots.push(bot);
    console.log(
      `  [${i + 1}/${TARGET_CLIENTS}] Connected: ${bots.length} | Failed: ${joinErrors}`,
    );
    await new Promise((r) => setTimeout(r, RAMP_DELAY_MS));
  }

  console.log(`\n  Ramp complete. ${bots.length} bots connected, ${joinErrors} failed.`);
  console.log(`  Running for ${DURATION_SEC}s... watch server metrics.\n`);

  await new Promise((r) => setTimeout(r, DURATION_SEC * 1000));

  console.log(`\n  Shutting down...`);
  for (const bot of bots) {
    if (bot.moveTimer) clearInterval(bot.moveTimer);
    try {
      bot.room.leave();
    } catch {}
  }

  console.log(`  Done. ${bots.length} bots ran for ${DURATION_SEC}s.`);
  process.exit(0);
}

run().catch((err) => {
  console.error("Load test error:", err);
  process.exit(1);
});

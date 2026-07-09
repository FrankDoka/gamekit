import http from "node:http";
import express from "express";
import cors from "cors";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { GameRoom } from "./GameRoom";

const PORT = Number(process.env.PORT ?? 2600);
const SMOKE_RUN_ID = process.env.GAMEKIT_SMOKE_RUN_ID ?? "";

const app = express();
// DEV ONLY: wide-open CORS + unauthenticated guest join below are fine for local
// capture/smoke. Lock these down (origin allowlist, real auth) before public use.
app.use(cors());
app.use(express.json());

// Minimal guest auth endpoint — same convention as the action starter. Honors
// ALLOW_GUEST_LOGIN so the guest contract is explicit even though the client
// joins the room directly on the #auth-guest click.
app.get("/api/guest", (_req, res) => {
  if (process.env.ALLOW_GUEST_LOGIN !== "true") {
    res.status(403).json({ error: "guest login disabled" });
    return;
  }
  res.json({ guest: true });
});

const httpServer = http.createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define("game", GameRoom);

httpServer.listen(PORT, () => {
  // Ownership handshake: same convention as starter-game/server — this exact JSON
  // substring echoes GAMEKIT_SMOKE_RUN_ID so a capture/smoke harness can prove it
  // booted THIS server.
  console.log(
    JSON.stringify({ msg: "listening", port: PORT, smokeRunId: SMOKE_RUN_ID }),
  );
});

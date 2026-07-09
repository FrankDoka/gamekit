import http from "node:http";
import express from "express";
import cors from "cors";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { GameRoom } from "./GameRoom";

const PORT = Number(process.env.PORT ?? 2567);
const SMOKE_RUN_ID = process.env.GAMEKIT_SMOKE_RUN_ID ?? "";

const app = express();
// DEV ONLY: wide-open CORS + the unauthenticated guest join below are fine for local
// capture/smoke. Lock these down (origin allowlist, real auth) before exposing publicly.
app.use(cors());
app.use(express.json());

// Minimal guest auth endpoint. The client joins the Colyseus room directly on
// the #auth-guest click, but honoring ALLOW_GUEST_LOGIN here keeps the contract
// explicit and lets a client pre-flight guest identity if it wants to.
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
  // MANDATORY ownership handshake: the smoke/capture harness aborts unless this
  // exact JSON substring echoes GAMEKIT_SMOKE_RUN_ID. See
  // tools/src/smoke/harness.ts serverOutputProvesOwnership().
  console.log(
    JSON.stringify({ msg: "listening", port: PORT, smokeRunId: SMOKE_RUN_ID }),
  );
});

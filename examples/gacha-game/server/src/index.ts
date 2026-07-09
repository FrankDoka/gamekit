// gacha-game server — a REQUEST/RESPONSE HTTP server (NOT a real-time Colyseus
// room). This is the whole point of the reference: it proves the GameKit
// conventions carry a menu-driven, non-real-time, request/response genre.
//
// The server is authoritative: it owns per-guest currency, roster, and pity
// counter in memory, validates every summon (currency check + spend) BEFORE
// running the pure @gacha/summon engine, and returns the pulled units + updated
// state. No ticking, no sockets — a plain Express JSON API keyed by a session token.

import http from "node:http";
import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import {
  makeSummonState,
  pullMany,
  pullCost,
  canAfford,
  rosterList,
  type SummonState,
  type PullResult,
} from "@gacha/summon";
import { REFERENCE_BANNER } from "@gacha/summon/banner";

const PORT = Number(process.env.PORT ?? 2610);
const SMOKE_RUN_ID = process.env.GAMEKIT_SMOKE_RUN_ID ?? "";
const STARTING_CURRENCY = 3000; // enough for ~3 x10 pulls out of the gate.

// --- Per-guest session store (in memory; a real game would persist this) ------
type GuestSession = {
  token: string;
  currency: number;
  summon: SummonState;
};

const sessions = new Map<string, GuestSession>();

/** Public shape of a session returned to the client (no RNG internals leaked). */
function publicState(s: GuestSession) {
  return {
    currency: s.currency,
    pityCounter: s.summon.pityCounter,
    hardPity5: REFERENCE_BANNER.hardPity5,
    roster: rosterList(s.summon.roster),
    pullCostX1: pullCost(1),
    pullCostX10: pullCost(10),
  };
}

/** Serialize pull results for the wire (unit + pity flag). */
function publicResults(results: PullResult[]) {
  return results.map((r) => ({
    unitId: r.unit.unitId,
    name: r.unit.name,
    rarity: r.unit.rarity,
    pity: r.pity,
  }));
}

const app = express();
// DEV ONLY: wide-open CORS + unauthenticated guest sessions below are fine for
// local capture/smoke. Lock these down (origin allowlist, real auth) before public use.
app.use(cors());
app.use(express.json());

// Read the guest's session token from a header. The client stores whatever
// /api/guest returns and echoes it on every subsequent request.
function requireSession(req: express.Request, res: express.Response): GuestSession | null {
  const token = req.header("x-gacha-session") ?? "";
  const s = sessions.get(token);
  if (!s) {
    res.status(401).json({ error: "no active guest session" });
    return null;
  }
  return s;
}

// POST /api/guest — start a guest session, grant starting currency. Honors
// ALLOW_GUEST_LOGIN so the guest contract is explicit (same convention as the
// action starter). Returns the session token + initial state + the banner.
app.post("/api/guest", (_req, res) => {
  if (process.env.ALLOW_GUEST_LOGIN !== "true") {
    res.status(403).json({ error: "guest login disabled" });
    return;
  }
  const token = randomUUID();
  // Seed the RNG per session from a fresh uint32 so each guest's pulls differ but
  // are reproducible within the session.
  const seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
  const session: GuestSession = {
    token,
    currency: STARTING_CURRENCY,
    summon: makeSummonState(seed),
  };
  sessions.set(token, session);
  res.json({
    token,
    banner: REFERENCE_BANNER,
    state: publicState(session),
  });
});

// GET /api/state — current currency + roster + pity for the session.
app.get("/api/state", (req, res) => {
  const s = requireSession(req, res);
  if (!s) return;
  res.json({ banner: REFERENCE_BANNER, state: publicState(s) });
});

// POST /api/summon { count: 1 | 10 } — AUTHORITATIVE summon. Validate the count,
// check + spend currency, run the seeded engine, apply pity, append to roster,
// return the pulled units + updated state. Reject on insufficient currency.
app.post("/api/summon", (req, res) => {
  const s = requireSession(req, res);
  if (!s) return;

  const count = Number((req.body ?? {}).count);
  if (count !== 1 && count !== 10) {
    res.status(400).json({ error: "count must be 1 or 10" });
    return;
  }
  if (!canAfford(s.currency, count)) {
    res.status(402).json({
      error: "insufficient currency",
      required: pullCost(count),
      have: s.currency,
    });
    return;
  }

  // Spend first (authoritative), then run the pure engine and commit the state.
  s.currency -= pullCost(count);
  const { results, nextState } = pullMany(s.summon, REFERENCE_BANNER, count);
  s.summon = nextState;

  res.json({
    results: publicResults(results),
    state: publicState(s),
  });
});

const httpServer = http.createServer(app);
httpServer.listen(PORT, () => {
  // Ownership handshake: same convention as starter-game / tactics-game — this
  // exact JSON substring echoes GAMEKIT_SMOKE_RUN_ID so a capture/smoke harness
  // can prove it booted THIS server.
  console.log(
    JSON.stringify({ msg: "listening", port: PORT, smokeRunId: SMOKE_RUN_ID }),
  );
});

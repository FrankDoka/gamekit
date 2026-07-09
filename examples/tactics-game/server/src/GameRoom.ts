import { Room, type Client } from "@colyseus/core";
import { ArraySchema } from "@colyseus/schema";
import { TacticsState, Unit } from "./state";
import {
  makeGrid,
  beginTeamTurn,
  teamTurnComplete,
  nextActiveTeam,
  winner,
  validateMove,
  validateAttack,
  type Grid,
  type Team,
  type UnitLike,
} from "@tactics/turn-grid";

// Board layout: 12x10, 64px tiles, a few impassable tiles in the middle.
const BOARD_W = 12;
const BOARD_H = 10;
const TILE = 64;
const BLOCKED_TILES: Array<{ x: number; y: number }> = [
  { x: 5, y: 4 },
  { x: 6, y: 4 },
  { x: 5, y: 5 },
  { x: 6, y: 5 },
  { x: 3, y: 7 },
  { x: 8, y: 2 },
];

// Two teams, 2 units each. Team A starts on the left, B on the right.
const START_UNITS: Array<Omit<UnitLike, "hasMoved" | "hasActed"> & { maxHp: number; atk: number; moveRange: number }> = [
  { unitId: "A1", team: "A", x: 0, y: 2, hp: 12, maxHp: 12, atk: 5, moveRange: 3 },
  { unitId: "A2", team: "A", x: 0, y: 6, hp: 12, maxHp: 12, atk: 5, moveRange: 3 },
  { unitId: "B1", team: "B", x: 11, y: 3, hp: 12, maxHp: 12, atk: 5, moveRange: 3 },
  { unitId: "B2", team: "B", x: 11, y: 7, hp: 12, maxHp: 12, atk: 5, moveRange: 3 },
];

type Intent =
  | { type: "move"; unitId?: string; x?: number; y?: number }
  | { type: "attack"; unitId?: string; targetId?: string }
  | { type: "endTurn" };

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function asInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

export class GameRoom extends Room<TacticsState> {
  private grid!: Grid;

  onCreate(): void {
    const state = new TacticsState();
    state.width = BOARD_W;
    state.height = BOARD_H;
    state.tileSize = TILE;
    state.blocked = new ArraySchema<boolean>(
      ...buildBlockedFlags(BOARD_W, BOARD_H, BLOCKED_TILES),
    );
    for (const u of START_UNITS) {
      const unit = new Unit();
      unit.unitId = u.unitId;
      unit.team = u.team;
      unit.x = u.x;
      unit.y = u.y;
      unit.hp = u.hp;
      unit.maxHp = u.maxHp;
      unit.atk = u.atk;
      unit.moveRange = u.moveRange;
      state.units.push(unit);
    }
    state.activeTeam = "A";
    state.phase = "playing";
    this.setState(state);
    this.grid = makeGrid(BOARD_W, BOARD_H, BLOCKED_TILES);

    // Turn-based intents. Server is authoritative: every intent is validated
    // against whose turn it is and legal ranges via the pure @tactics/turn-grid
    // validators; illegal intents are rejected (logged, state untouched).
    this.onMessage("intent", (client, message: Intent) => {
      if (!message || typeof message.type !== "string") return;
      if (this.state.phase !== "playing") {
        this.reject(client, "game-over");
        return;
      }
      switch (message.type) {
        case "move":
          this.handleMove(client, message);
          break;
        case "attack":
          this.handleAttack(client, message);
          break;
        case "endTurn":
          this.handleEndTurn(client);
          break;
        default:
          this.reject(client, "unknown-intent");
      }
    });
  }

  private handleMove(client: Client, msg: { unitId?: string; x?: number; y?: number }): void {
    const unitId = asStr(msg.unitId);
    const x = asInt(msg.x);
    const y = asInt(msg.y);
    if (!unitId || x === null || y === null) {
      this.reject(client, "bad-move-args");
      return;
    }
    const unit = this.findUnit(unitId);
    if (!unit) {
      this.reject(client, "no-such-unit");
      return;
    }
    const v = validateMove(
      this.grid,
      this.unitLikes(),
      this.state.activeTeam as Team,
      unitId,
      x,
      y,
      unit.moveRange,
    );
    if (!v.ok) {
      this.reject(client, v.reason);
      return;
    }
    unit.x = x;
    unit.y = y;
    unit.hasMoved = true;
    this.log("move", { unitId, x, y });
  }

  private handleAttack(client: Client, msg: { unitId?: string; targetId?: string }): void {
    const unitId = asStr(msg.unitId);
    const targetId = asStr(msg.targetId);
    if (!unitId || !targetId) {
      this.reject(client, "bad-attack-args");
      return;
    }
    const v = validateAttack(
      this.unitLikes(),
      this.state.activeTeam as Team,
      unitId,
      targetId,
    );
    if (!v.ok) {
      this.reject(client, v.reason);
      return;
    }
    const attacker = this.findUnit(unitId)!;
    const target = this.findUnit(targetId)!;
    target.hp = Math.max(0, target.hp - attacker.atk);
    // Attacking spends the unit's whole activation (move-then-attack, then done).
    attacker.hasMoved = true;
    attacker.hasActed = true;
    this.log("attack", {
      unitId,
      targetId,
      damage: attacker.atk,
      targetHp: target.hp,
      killed: target.hp <= 0,
    });
    this.checkWinAndRotate();
  }

  private handleEndTurn(client: Client): void {
    // End-turn marks every not-yet-acted living unit on the active team as done,
    // then rotates. (A unit that only moved still ends here.)
    for (const u of this.state.units) {
      if (u.team === this.state.activeTeam && u.hp > 0) u.hasActed = true;
    }
    this.log("endTurn", { team: this.state.activeTeam });
    this.rotateTurn();
  }

  /** After an attack that may have killed a unit, check for a winner; if the
   * active team has now finished (e.g. both units acted), rotate. */
  private checkWinAndRotate(): void {
    const w = winner(this.unitLikes());
    if (w) {
      this.state.phase = "gameover";
      this.state.winnerTeam = w;
      this.log("gameover", { winner: w });
      return;
    }
    if (teamTurnComplete(this.unitLikes(), this.state.activeTeam as Team)) {
      this.rotateTurn();
    }
  }

  private rotateTurn(): void {
    const next = nextActiveTeam(this.unitLikes(), this.state.activeTeam as Team);
    if (!next) {
      // No team can act — decide by whoever remains (or draw, unreachable here).
      const w = winner(this.unitLikes());
      this.state.phase = "gameover";
      this.state.winnerTeam = w ?? "";
      this.log("gameover", { winner: w });
      return;
    }
    this.state.activeTeam = next;
    // Reset the new active team's per-turn flags, writing back to schema units.
    const reset = beginTeamTurn(this.unitLikes(), next);
    for (const r of reset) {
      const u = this.findUnit(r.unitId);
      if (u) {
        u.hasMoved = r.hasMoved;
        u.hasActed = r.hasActed;
      }
    }
    this.log("turn", { activeTeam: next });
  }

  // --- helpers ---------------------------------------------------------------

  private findUnit(unitId: string): Unit | undefined {
    return this.state.units.find((u) => u.unitId === unitId);
  }

  /** Snapshot schema units as plain UnitLike[] for the pure validators. */
  private unitLikes(): UnitLike[] {
    return this.state.units.map((u) => ({
      unitId: u.unitId,
      team: u.team as Team,
      x: u.x,
      y: u.y,
      hp: u.hp,
      hasMoved: u.hasMoved,
      hasActed: u.hasActed,
    }));
  }

  private reject(client: Client, reason: string): void {
    client.send("rejected", { reason });
    this.log("rejected", { sessionId: client.sessionId, reason });
  }

  private log(msg: string, extra: Record<string, unknown>): void {
    console.log(JSON.stringify({ msg, ...extra }));
  }

  onJoin(client: Client): void {
    // Tactics is a shared-board game: a joining client observes/controls the
    // board (both teams, hot-seat style for this minimal reference). No per-join
    // entity is created — units are fixed board pieces.
    this.log("join", { sessionId: client.sessionId });
  }

  onLeave(client: Client): void {
    this.log("leave", { sessionId: client.sessionId });
  }
}

function buildBlockedFlags(
  width: number,
  height: number,
  blocked: Array<{ x: number; y: number }>,
): boolean[] {
  const flags = new Array<boolean>(width * height).fill(false);
  for (const b of blocked) {
    if (b.x >= 0 && b.y >= 0 && b.x < width && b.y < height) flags[b.y * width + b.x] = true;
  }
  return flags;
}

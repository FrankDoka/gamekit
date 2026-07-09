import { Schema, ArraySchema, type } from "@colyseus/schema";

// Turn-based tactics state. Unlike the action starter (players keyed by
// connection sessionId, real-time positions), a TACTICS game has abstract UNITS
// that belong to a TEAM, not to a connection. Field names on Unit mirror the
// pure UnitLike in @tactics/turn-grid so the room can hand schema units straight
// to the validators.

export class Unit extends Schema {
  @type("string") unitId = "";
  @type("string") team = "A"; // "A" | "B"
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") hp = 10;
  @type("number") maxHp = 10;
  @type("number") atk = 4;
  @type("number") moveRange = 3;
  @type("boolean") hasMoved = false;
  @type("boolean") hasActed = false;
}

export class TacticsState extends Schema {
  @type("number") width = 12;
  @type("number") height = 10;
  @type("number") tileSize = 64;
  /** row-major impassable terrain flags, length width*height. */
  @type(["boolean"]) blocked = new ArraySchema<boolean>();
  @type([Unit]) units = new ArraySchema<Unit>();
  @type("string") activeTeam = "A"; // whose turn it is
  @type("string") phase = "playing"; // "playing" | "gameover"
  @type("string") winnerTeam = ""; // "" until decided, then "A" | "B"
}

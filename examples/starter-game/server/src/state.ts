import { Schema, MapSchema, type } from "@colyseus/schema";

export class Player extends Schema {
  @type("string") sessionId = "";
  @type("string") name = "";
  @type("string") mapId = "map_starter_field";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") hp = 100;
  @type("number") maxHp = 100;
  @type("number") level = 1;
}

// Live monster entity. Field names mirror what the toolkit's smoke reader reads
// (tools/src/smoke/state.ts getSmokeState -> monsters[]): x, y, hp, maxHp, alive,
// mapId, monsterId, targetId. Keep these names stable — the harness derives its
// monster snapshot from them.
export class Monster extends Schema {
  @type("string") monsterId = "";
  @type("string") mapId = "map_starter_field";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") hp = 40;
  @type("number") maxHp = 40;
  @type("boolean") alive = true;
  @type("string") targetId = "";
}

export class GameState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: Monster }) monsters = new MapSchema<Monster>();
}

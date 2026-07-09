import Phaser from "phaser";
import { Client, type Room } from "colyseus.js";
import {
  makeGrid,
  reachableTiles,
  tileKey,
  isAdjacent,
  type Grid,
  type Team,
} from "@tactics/turn-grid";

// --- Protocol constants (must agree with server/src) ---
const ROOM_NAME = "game";

const COLYSEUS_URL =
  (import.meta.env.VITE_COLYSEUS_URL as string | undefined) ?? "ws://127.0.0.1:2600";

const TEX = {
  ground: "ground",
  blocked: "blocked",
  A1: "unit_a1",
  A2: "unit_a2",
  B1: "unit_b1",
  B2: "unit_b2",
} as const;

type UnitView = {
  unitId: string;
  team: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  moveRange: number;
  hasMoved: boolean;
  hasActed: boolean;
};

// The gameplay scene, keyed "game". Exposes room / localSessionId / board / units
// on the instance so globalThis.__GAME is inspectable (the toolkit smoke reader
// keys off scene "game"; see README for why the action-oriented fields don't map).
class GameScene extends Phaser.Scene {
  localSessionId = "";
  room?: Room;
  // Inspectable board + unit snapshot (plain data, updated every state sync).
  board = { width: 12, height: 10, tileSize: 64, blocked: [] as boolean[] };
  units: UnitView[] = [];
  activeTeam: Team = "A";
  phase = "playing";
  winnerTeam = "";

  private grid?: Grid;
  private selectedUnitId: string | null = null;
  private unitSprites = new Map<string, Phaser.GameObjects.Sprite>();
  private hpBars = new Map<string, Phaser.GameObjects.Graphics>();
  private highlightLayer?: Phaser.GameObjects.Graphics;
  private boardBuilt = false;

  constructor() {
    super({ key: "game" });
  }

  preload(): void {
    this.load.image(TEX.ground, "/assets/tiles/ground.png");
    this.load.image(TEX.blocked, "/assets/tiles/blocked.png");
    this.load.image(TEX.A1, "/assets/sprites/unit_a1.png");
    this.load.image(TEX.A2, "/assets/sprites/unit_a2.png");
    this.load.image(TEX.B1, "/assets/sprites/unit_b1.png");
    this.load.image(TEX.B2, "/assets/sprites/unit_b2.png");
  }

  create(): void {
    this.highlightLayer = this.add.graphics();
    this.highlightLayer.setDepth(2);

    // Click a tile: if a friendly active unit is selected, either MOVE there or
    // (if an enemy unit sits on that tile and is adjacent) ATTACK it. Clicking a
    // friendly active unit selects it.
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      this.handleClick(pointer.worldX, pointer.worldY);
    });

    // End Turn button -> endTurn intent.
    document.getElementById("end-turn")?.addEventListener("click", () => {
      this.room?.send("intent", { type: "endTurn" });
      this.selectedUnitId = null;
    });

    void this.connect();
  }

  private tileFromWorld(wx: number, wy: number): { tx: number; ty: number } {
    return {
      tx: Math.floor(wx / this.board.tileSize),
      ty: Math.floor(wy / this.board.tileSize),
    };
  }

  private handleClick(wx: number, wy: number): void {
    if (!this.room || this.phase !== "playing") return;
    const { tx, ty } = this.tileFromWorld(wx, wy);
    const clickedUnit = this.units.find((u) => u.x === tx && u.y === ty && u.hp > 0);

    // Clicking an active-team, not-yet-acted unit selects it.
    if (clickedUnit && clickedUnit.team === this.activeTeam && !clickedUnit.hasActed) {
      this.selectedUnitId = clickedUnit.unitId;
      this.drawHighlights();
      return;
    }

    const sel = this.selectedUnitId
      ? this.units.find((u) => u.unitId === this.selectedUnitId)
      : undefined;
    if (!sel) return;

    // Clicked an adjacent living enemy -> attack.
    if (clickedUnit && clickedUnit.team !== sel.team && isAdjacent(sel.x, sel.y, tx, ty)) {
      this.room.send("intent", { type: "attack", unitId: sel.unitId, targetId: clickedUnit.unitId });
      this.selectedUnitId = null;
      return;
    }

    // Otherwise attempt a move onto an empty tile (server re-validates).
    if (!clickedUnit && !sel.hasMoved) {
      this.room.send("intent", { type: "move", unitId: sel.unitId, x: tx, y: ty });
    }
  }

  private connect = async (): Promise<void> => {
    const client = new Client(COLYSEUS_URL);
    const room = await client.joinOrCreate(ROOM_NAME, { name: "guest" });
    this.room = room as unknown as Room;
    this.localSessionId = room.sessionId;
    // Re-render on every authoritative state change (fires once the first full
    // state patch is decoded, then on every mutation).
    room.onStateChange(() => this.syncFromState());
  };

  private syncFromState(): void {
    const s = this.room?.state as unknown as {
      width: number;
      height: number;
      tileSize: number;
      blocked?: { forEach(cb: (v: boolean, i: number) => void): void };
      units?: { forEach(cb: (u: UnitView) => void): void };
      activeTeam: string;
      phase: string;
      winnerTeam: string;
    };
    if (!s) return;

    this.board.width = s.width;
    this.board.height = s.height;
    this.board.tileSize = s.tileSize;
    // Schema collections may not be decoded yet on the very first sync — guard
    // both so an early call can't throw before the first state patch lands.
    if (!s.blocked || !s.units) return;
    const blocked: boolean[] = [];
    s.blocked.forEach((v) => blocked.push(Boolean(v)));
    this.board.blocked = blocked;

    const units: UnitView[] = [];
    s.units.forEach((u) => {
      units.push({
        unitId: u.unitId,
        team: u.team,
        x: u.x,
        y: u.y,
        hp: u.hp,
        maxHp: u.maxHp,
        moveRange: u.moveRange,
        hasMoved: u.hasMoved,
        hasActed: u.hasActed,
      });
    });
    this.units = units;
    this.activeTeam = s.activeTeam as Team;
    this.phase = s.phase;
    this.winnerTeam = s.winnerTeam;

    // Rebuild the static board once (terrain doesn't change), then units/HUD.
    if (!this.boardBuilt) this.buildBoard();
    this.grid = makeGrid(
      this.board.width,
      this.board.height,
      blockedTilesFromFlags(this.board.width, this.board.height, blocked),
    );
    // If the selected unit died or already acted, clear selection.
    const sel = this.selectedUnitId
      ? this.units.find((u) => u.unitId === this.selectedUnitId)
      : undefined;
    if (!sel || sel.hp <= 0 || sel.hasActed || sel.team !== this.activeTeam) {
      this.selectedUnitId = null;
    }
    this.renderUnits();
    this.drawHighlights();
    this.updateHud();
  }

  private buildBoard(): void {
    const t = this.board.tileSize;
    for (let y = 0; y < this.board.height; y += 1) {
      for (let x = 0; x < this.board.width; x += 1) {
        const isBlocked = this.board.blocked[y * this.board.width + x];
        this.add
          .image(x * t, y * t, isBlocked ? TEX.blocked : TEX.ground)
          .setOrigin(0, 0)
          .setDepth(0);
      }
    }
    // Fit the camera to the whole board and letterbox-center it.
    const w = this.board.width * t;
    const h = this.board.height * t;
    this.cameras.main.setBounds(0, 0, w, h);
    this.cameras.main.centerOn(w / 2, h / 2);
    this.boardBuilt = true;
  }

  private renderUnits(): void {
    const t = this.board.tileSize;
    const seen = new Set<string>();
    for (const u of this.units) {
      seen.add(u.unitId);
      const texKey = TEX[u.unitId as keyof typeof TEX] ?? TEX.A1;
      let sprite = this.unitSprites.get(u.unitId);
      if (!sprite) {
        sprite = this.add.sprite(0, 0, texKey).setDepth(5);
        this.unitSprites.set(u.unitId, sprite);
      }
      sprite.setPosition(u.x * t + t / 2, u.y * t + t / 2);
      sprite.setVisible(u.hp > 0);
      // Dim units that have already acted this turn.
      sprite.setAlpha(u.hasActed ? 0.5 : 1);

      // HP bar above the unit.
      let bar = this.hpBars.get(u.unitId);
      if (!bar) {
        bar = this.add.graphics().setDepth(6);
        this.hpBars.set(u.unitId, bar);
      }
      bar.clear();
      if (u.hp > 0) {
        const bx = u.x * t + 8;
        const by = u.y * t + 4;
        const bw = t - 16;
        bar.fillStyle(0x000000, 0.6).fillRect(bx, by, bw, 6);
        const frac = Math.max(0, u.hp / u.maxHp);
        bar.fillStyle(u.team === "A" ? 0x5ab0ff : 0xff6a6a, 1).fillRect(bx, by, bw * frac, 6);
      }
    }
    for (const [id, sprite] of this.unitSprites) {
      if (!seen.has(id)) {
        sprite.destroy();
        this.unitSprites.delete(id);
        this.hpBars.get(id)?.destroy();
        this.hpBars.delete(id);
      }
    }
  }

  private drawHighlights(): void {
    const g = this.highlightLayer;
    if (!g || !this.grid) return;
    g.clear();
    const t = this.board.tileSize;
    const sel = this.selectedUnitId
      ? this.units.find((u) => u.unitId === this.selectedUnitId)
      : undefined;
    if (!sel) return;

    // Selected-unit outline.
    g.lineStyle(3, 0xffe27a, 1).strokeRect(sel.x * t + 1, sel.y * t + 1, t - 2, t - 2);

    // Legal move tiles (only if it hasn't moved yet), computed with the SAME pure
    // module the server validates with — so the highlight matches server truth.
    if (!sel.hasMoved) {
      const occupied = new Set<string>();
      for (const u of this.units) {
        if (u.unitId !== sel.unitId && u.hp > 0) occupied.add(tileKey(u.x, u.y));
      }
      const tiles = reachableTiles(this.grid, sel.x, sel.y, sel.moveRange, { occupied });
      g.fillStyle(0x63d1ff, 0.28);
      for (const tile of tiles) g.fillRect(tile.x * t, tile.y * t, t, t);
    }

    // Attackable adjacent enemies.
    g.fillStyle(0xff5a5a, 0.32);
    for (const u of this.units) {
      if (u.hp > 0 && u.team !== sel.team && isAdjacent(sel.x, sel.y, u.x, u.y)) {
        g.fillRect(u.x * t, u.y * t, t, t);
      }
    }
  }

  private updateHud(): void {
    const ind = document.getElementById("turn-indicator");
    const endBtn = document.getElementById("end-turn") as HTMLButtonElement | null;
    if (this.phase === "gameover") {
      if (ind) ind.textContent = `Team ${this.winnerTeam} wins!`;
      if (endBtn) endBtn.disabled = true;
      return;
    }
    if (ind) ind.textContent = `Team ${this.activeTeam} turn`;
    if (endBtn) endBtn.disabled = false;
  }
}

function blockedTilesFromFlags(
  width: number,
  height: number,
  flags: boolean[],
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i]) out.push({ x: i % width, y: Math.floor(i / width) });
  }
  return out;
}

function boot(): void {
  const game = new Phaser.Game({
    type: Phaser.WEBGL,
    parent: "game",
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: "#0d1017",
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: [GameScene],
  });
  (globalThis as { __GAME?: Phaser.Game }).__GAME = game;
}

// Boot Phaser on the guest click; reveal the HUD.
const guestButton = document.getElementById("auth-guest");
const authOverlay = document.getElementById("auth");
const hud = document.getElementById("hud");
guestButton?.addEventListener("click", () => {
  if (authOverlay) authOverlay.style.display = "none";
  if (hud) hud.style.display = "flex";
  boot();
});

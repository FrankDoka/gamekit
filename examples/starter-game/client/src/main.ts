import Phaser from "phaser";
import { Client, type Room } from "colyseus.js";

// --- Protocol constants (must agree with server/src/GameRoom.ts) ---
const ROOM_NAME = "game";
const MAP_WIDTH = 1600;
const MAP_HEIGHT = 1200;

// Texture keys + asset paths. Files live under client/public/assets and Vite serves
// them at /assets/... The ground key mirrors the promoted-registry.json targetName
// so the asset-pipeline demo (registry -> layout assetKey -> runtime texture) is real.
const TEX_GROUND = "ground_grass";
const TEX_PLAYER = "player";
const TEX_NPC = "npc_guide";
const TEX_SLIME = "slime";

// NPC placement mirrors content/zones/map_starter_field.layout.json (npc_guide_1).
// Rendered purely client-side from content — the guide is static, so no server state
// is needed for it to appear in a capture.
const NPC_PLACEMENTS = [{ instanceId: "npc_guide_1", tex: TEX_NPC, x: 640, y: 520, label: "Guide" }];

const COLYSEUS_URL =
  (import.meta.env.VITE_COLYSEUS_URL as string | undefined) ?? "ws://127.0.0.1:2567";

type PlayerState = { x: number; y: number; sessionId: string };
type MonsterState = { x: number; y: number; alive: boolean; monsterId: string };

// The gameplay scene the smoke/capture harness drives. It is keyed "game" and
// exposes localSessionId, room, playerObjects, and cameras.main per the toolkit
// client contract (tools/src/smoke/state.ts).
class GameScene extends Phaser.Scene {
  localSessionId = "";
  room?: Room;
  playerObjects = new Map<string, Phaser.GameObjects.Sprite>();
  monsterObjects = new Map<string, Phaser.GameObjects.Sprite>();
  private keys?: Record<string, Phaser.Input.Keyboard.Key>;

  constructor() {
    super({ key: "game" });
  }

  preload(): void {
    // Load placeholder art for the asset-pipeline demo. Phaser runs create() only
    // after preload completes, so textures are guaranteed ready when we render.
    this.load.image(TEX_GROUND, "/assets/tiles/ground_grass.png");
    this.load.image(TEX_PLAYER, "/assets/sprites/player.png");
    this.load.image(TEX_NPC, "/assets/sprites/npc_guide.png");
    this.load.image(TEX_SLIME, "/assets/sprites/slime.png");
  }

  create(): void {
    // Ground rendered from the tileable grass texture, tiled across the full zone
    // bounds. This is the runtime end of the promoted-registry -> layout -> texture
    // pipeline (replaces the old solid-color rectangle).
    this.add
      .tileSprite(0, 0, MAP_WIDTH, MAP_HEIGHT, TEX_GROUND)
      .setOrigin(0, 0)
      .setDepth(-2);

    // Faint grid so movement is visible in screenshots.
    const grid = this.add.grid(
      MAP_WIDTH / 2,
      MAP_HEIGHT / 2,
      MAP_WIDTH,
      MAP_HEIGHT,
      64,
      64,
      undefined,
      0,
      0x000000,
      0.12,
    );
    grid.setDepth(-1);

    // Static NPC(s) from content — labeled sprites, always visible in a capture.
    for (const npc of NPC_PLACEMENTS) {
      const sprite = this.add.sprite(npc.x, npc.y, npc.tex);
      sprite.setDepth(5);
      const label = this.add.text(npc.x, npc.y - 34, npc.label, {
        fontFamily: "system-ui, sans-serif",
        fontSize: "14px",
        color: "#ffffff",
      });
      label.setOrigin(0.5, 1);
      label.setDepth(6);
    }

    this.cameras.main.setBounds(0, 0, MAP_WIDTH, MAP_HEIGHT);

    // Register movement keys ONCE here (not per-frame); read them in update().
    this.keys = this.input.keyboard?.addKeys("W,A,S,D,UP,DOWN,LEFT,RIGHT") as
      | Record<string, Phaser.Input.Keyboard.Key>
      | undefined;

    // Click-to-move: send a move.to intent toward the clicked world point.
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      this.sendMoveTo(pointer.worldX, pointer.worldY);
    });

    void this.connect();
  }

  update(): void {
    if (!this.room) return;
    const players = this.room.state.players as
      | { forEach(cb: (p: PlayerState, id: string) => void): void }
      | undefined;
    if (!players) return;

    const seen = new Set<string>();
    players.forEach((player, sessionId) => {
      seen.add(sessionId);
      let obj = this.playerObjects.get(sessionId);
      if (!obj) {
        obj = this.add.sprite(player.x, player.y, TEX_PLAYER);
        obj.setDepth(10);
        // Tint remote players so local vs remote is readable in captures; the local
        // player keeps the untinted sprite.
        if (sessionId !== this.localSessionId) obj.setTint(0xffcc88);
        this.playerObjects.set(sessionId, obj);
        // Follow the local player via Phaser's camera-follow so the capture tool's
        // cameras.main.stopFollow() can release it and pan across the zone. Manual
        // per-tick centering would override the tool and freeze every sweep frame.
        if (sessionId === this.localSessionId) {
          this.cameras.main.startFollow(obj, true);
        }
      }
      obj.setPosition(player.x, player.y);
    });

    // Drop sprites for players that left.
    for (const [sessionId, obj] of this.playerObjects) {
      if (!seen.has(sessionId)) {
        obj.destroy();
        this.playerObjects.delete(sessionId);
      }
    }

    this.syncMonsters();

    // Camera follows the local player via startFollow (set once when its object is
    // created); no manual per-tick centering, so the capture tool can take the camera.

    // WASD nudge -> move.to intent one step in the pressed direction.
    this.pollKeyboard();
  }

  private syncMonsters(): void {
    const monsters = this.room?.state.monsters as
      | { forEach(cb: (m: MonsterState, id: string) => void): void }
      | undefined;
    if (!monsters) return;
    const seen = new Set<string>();
    monsters.forEach((monster, id) => {
      seen.add(id);
      let obj = this.monsterObjects.get(id);
      if (!obj) {
        obj = this.add.sprite(monster.x, monster.y, TEX_SLIME);
        obj.setDepth(8);
        this.monsterObjects.set(id, obj);
      }
      obj.setPosition(monster.x, monster.y);
      obj.setVisible(monster.alive);
    });
    for (const [id, obj] of this.monsterObjects) {
      if (!seen.has(id)) {
        obj.destroy();
        this.monsterObjects.delete(id);
      }
    }
  }

  private pollKeyboard(): void {
    const keys = this.keys;
    if (!keys) return;
    const local =
      this.room && this.localSessionId
        ? (this.room.state.players as { get(id: string): PlayerState | undefined }).get(
            this.localSessionId,
          )
        : undefined;
    if (!local) return;
    const step = 24;
    let dx = 0;
    let dy = 0;
    if (keys.W.isDown || keys.UP.isDown) dy -= step;
    if (keys.S.isDown || keys.DOWN.isDown) dy += step;
    if (keys.A.isDown || keys.LEFT.isDown) dx -= step;
    if (keys.D.isDown || keys.RIGHT.isDown) dx += step;
    if (dx !== 0 || dy !== 0) {
      this.sendMoveTo(local.x + dx, local.y + dy);
    }
  }

  private sendMoveTo(x: number, y: number): void {
    this.room?.send("intent", {
      type: "move.to",
      x,
      y,
      clientTimeMs: Date.now(),
    });
  }

  private async connect(): Promise<void> {
    const client = new Client(COLYSEUS_URL);
    const room = await client.joinOrCreate<{ players: unknown }>(ROOM_NAME, {
      name: "guest",
    });
    this.room = room as unknown as Room;
    this.localSessionId = room.sessionId;
  }
}

function boot(): void {
  const game = new Phaser.Game({
    type: Phaser.WEBGL,
    parent: "game",
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: "#10141c",
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: [GameScene],
  });
  (globalThis as { __GAME?: Phaser.Game }).__GAME = game;
}

// The harness clicks #auth-guest, then waits for globalThis.__GAME + an active
// "game" scene with a joined room. Boot Phaser only on that click.
const guestButton = document.getElementById("auth-guest");
const authOverlay = document.getElementById("auth");
guestButton?.addEventListener("click", () => {
  if (authOverlay) authOverlay.style.display = "none";
  boot();
});

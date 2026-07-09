# starter-game — the GameKit reference game

A tiny, runnable game that implements the [GameKit](../../README.md) contract end to end. It exists
to (a) **prove** the toolkit's seams work and (b) be the **fork-point** for a new game — the fastest
way to fork it is `pnpm create:game <name>` from the toolkit root (copies this folder, rewires
names/title/README, writes `.env.example`, seeds `docs/state/*` harness stubs). Then replace the
placeholder art with your own.

It is intentionally minimal: **one zone, one WASD/click-controllable player.** A tiled-grass ground
(the promoted-registry → layout → texture asset-pipeline demo), player sprites, a static "Guide" NPC,
and a few server-spawned slimes — synced over a Colyseus server and rendered with Phaser 4.

## Layout

```
starter-game/
  content/                         # contract-conformant game content (validated by zone:* tools)
    maps/map_starter_field.json    #   MapManifest
    zones/map_starter_field.layout.json  # ZoneLayout (bounds, spawn, collision grid)
    asset-editor-metadata.json
  server/                          # Colyseus room "game": guest join, move.to intent, state sync
    src/{index.ts,GameRoom.ts,state.ts}
  client/                          # Vite + Phaser 4: #auth-guest -> join -> render players
    index.html, src/main.ts
```

This is a **separate project** from the toolkit (its own `node_modules`), so the game-aware tools
run against it with `cwd = this folder`.

## Run it

```sh
# one-time install (isolated from the toolkit workspace)
pnpm install --ignore-workspace                 # root: tsx
cd server && pnpm install --ignore-workspace && cd ..
cd client && pnpm install --ignore-workspace && cd ..

# boot the server + client manually
(cd server && PORT=2567 ALLOW_GUEST_LOGIN=true node ../node_modules/tsx/dist/cli.mjs src/index.ts)
(cd client && VITE_COLYSEUS_URL=ws://127.0.0.1:2567 node node_modules/vite/bin/vite.js --host 127.0.0.1)
# open the printed URL, click "Play as Guest", move with WASD / click
```

## Exercise the toolkit against it

From this folder (so `cwd` is the game root), pointing at the sibling toolkit:

```sh
TOOLKIT=../..
# static content tools (no runtime)
node $TOOLKIT/node_modules/tsx/dist/cli.mjs $TOOLKIT/tools/src/zone-validate.ts
node $TOOLKIT/node_modules/tsx/dist/cli.mjs $TOOLKIT/tools/src/zone-lint.ts --all
node $TOOLKIT/node_modules/tsx/dist/cli.mjs $TOOLKIT/tools/src/zone-export.ts
# headless capture (boots server+client, screenshots the zone)
node $TOOLKIT/node_modules/tsx/dist/cli.mjs $TOOLKIT/tools/src/capture-zone.ts _capture --map=map_starter_field --sweep
```

## The contract it satisfies

The client/server consume their own JSON content; the **toolkit** reads that content through
[`@gamekit/game-contract`](../../packages/game-contract/) to validate it. The runtime surface the
capture/smoke tools require — a Colyseus room named `"game"`, `globalThis.__GAME` exposing a scene
keyed `"game"` with `localSessionId` / `room.state.players` / `playerObjects` / `cameras.main`, an
`#auth-guest` button, a `move.to` intent, and a server boot log echoing `smokeRunId` — is all in
`server/src` and `client/src`. Match that surface in your own game and every game-aware tool works.
```

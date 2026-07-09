/**
 * Pure, dependency-free room-graph dungeon generator.
 *
 * Ported from majidmanzarpour/threejs-procedural-dungeon `src/main.js` (MIT — see
 * THIRD-PARTY.md). The structural pipeline is kept recognizable and, critically,
 * bit-for-bit deterministic: one mulberry32 stream (mulberry32.ts) threaded through
 * every stage rebuilds the same dungeon for a given seed.
 *
 * What is ported (the expensive-to-invent structural core, upstream :190-541 + delaunay
 * :131):  scatter rooms on a disc with size/shape archetypes -> AABB separation ×300 ->
 * Delaunay (Bowyer-Watson) -> Prim MST -> probabilistic loop edges -> leaf-guard prune ->
 * BFS room semantics (boss/entrance/critical path/treasure/shrine/elite) -> grid carve +
 * L-corridors -> wall/doorway derivation -> flood-fill reachability validation ->
 * tier-graded monster spawn points.
 *
 * What is intentionally DROPPED (upstream :333-345 theme mutations, :427-755 decoration,
 * :767+ rendering): all three.js-flavored theming/props/lighting. This module emits pure
 * structure + gameplay-relevant spawns only. The tile->pixel `layout.json` mapping lives
 * in emitter.ts; this file has zero knowledge of our content schema.
 */

import { makeRng, type Rng } from "./mulberry32.js";

/** Grid cell classes. VOID = untouched, FLOOR = walkable, WALL = derived border. */
export const VOID = 0;
export const FLOOR = 1;
export const WALL = 2;

/** Room semantic type from the BFS gradient. */
export type RoomType = "entrance" | "combat" | "elite" | "treasure" | "shrine" | "boss";
export const ROOM_TYPE: Record<Uppercase<RoomType>, RoomType> = {
  ENTRANCE: "entrance",
  COMBAT: "combat",
  ELITE: "elite",
  TREASURE: "treasure",
  SHRINE: "shrine",
  BOSS: "boss",
};

/** Room shape archetype. */
export type RoomShape = "rect" | "ellipse" | "oct";
/** Size archetype: (s)mall / (m)edium / (l)arge. */
export type RoomArch = "s" | "m" | "l";

export interface DungeonParams {
  /** 32-bit seed; the same (seed, params) always produce the same dungeon. */
  seed: number;
  /** Number of rooms to scatter (upstream `roomCount`). */
  roomCount: number;
  /** Probability a non-MST Delaunay edge becomes a loop (upstream `loopChance`, 0..1). */
  loopChance: number;
}

export interface Room {
  id: number;
  /** Grid-space center (integer after separation + rasterize offset). */
  cx: number;
  cy: number;
  /** Tile width/height. */
  w: number;
  h: number;
  arch: RoomArch;
  shape: RoomShape;
  type: RoomType;
  /** BFS depth from the entrance room (graph hops). */
  depth: number;
  /** 0..1 difficulty gradient derived from depth. */
  difficulty: number;
  /** Graph degree after loop/prune. */
  degree: number;
}

export interface DungeonEdge {
  a: number;
  b: number;
  isLoop: boolean;
  isCritical: boolean;
}

export interface DungeonSpawn {
  /** Grid-space tile position. */
  x: number;
  y: number;
  /** 1..3 difficulty tier (3 = elite). */
  tier: number;
  roomId: number;
}

export interface Dungeon {
  valid: boolean;
  params: DungeonParams;
  seed: number;
  /** Grid dimensions in tiles. */
  W: number;
  H: number;
  /** W*H cell grid of VOID/FLOOR/WALL. */
  grid: Uint8Array;
  /** W*H room-id-per-cell (-1 for non-room cells). */
  roomId: Int16Array;
  /** W*H 1-where-corridor. */
  corridor: Uint8Array;
  /** W*H 1-where a corridor cell touches a room (a door threshold). */
  doorway: Uint8Array;
  rooms: Room[];
  edges: DungeonEdge[];
  entrance: number;
  boss: number;
  maxDepth: number;
  spawns: DungeonSpawn[];
  stats: DungeonStats;
}

export interface DungeonStats {
  rooms: number;
  edges: number;
  loops: number;
  critLen: number;
  floorTiles: number;
  reach: number;
  attempts: number;
}

/**
 * Delaunay triangulation via Bowyer-Watson, returning undirected edges as [lo,hi]
 * index pairs. Verbatim structure of upstream :131-174 (the tiny golden-ratio jitter
 * that breaks cocircular ties is preserved — it is part of the deterministic output).
 */
export function delaunay(pts: ReadonlyArray<{ x: number; y: number }>): Array<[number, number]> {
  const n = pts.length;
  if (n < 2) return [];
  if (n === 2) return [[0, 1]];
  const P = pts.map((p, i) => ({ x: p.x + ((i * 0.618033) % 1) * 1e-3, y: p.y + ((i * 0.414213) % 1) * 1e-3, i }));
  let minX = 1e18;
  let minY = 1e18;
  let maxX = -1e18;
  let maxY = -1e18;
  for (const p of P) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const dm = Math.max(maxX - minX, maxY - minY, 1);
  const mx = (minX + maxX) / 2;
  const my = (minY + maxY) / 2;
  const s1 = { x: mx - 30 * dm, y: my - dm, i: -1 };
  const s2 = { x: mx, y: my + 30 * dm, i: -2 };
  const s3 = { x: mx + 30 * dm, y: my - dm, i: -3 };

  type Vert = { x: number; y: number; i: number };
  type Tri = Vert[] & { ccx: number; ccy: number; r2: number };
  const mkTri = (a: Vert, b: Vert, c: Vert): Tri => {
    const t = [a, b, c] as Tri;
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-12) {
      t.ccx = 0;
      t.ccy = 0;
      t.r2 = Infinity;
      return t;
    }
    const a2 = a.x * a.x + a.y * a.y;
    const b2 = b.x * b.x + b.y * b.y;
    const c2 = c.x * c.x + c.y * c.y;
    t.ccx = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
    t.ccy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
    t.r2 = (a.x - t.ccx) * (a.x - t.ccx) + (a.y - t.ccy) * (a.y - t.ccy);
    return t;
  };
  let tris: Tri[] = [mkTri(s1, s2, s3)];
  for (const p of P) {
    const bad: Tri[] = [];
    const edges: Vert[][] = [];
    for (const t of tris) {
      if ((p.x - t.ccx) * (p.x - t.ccx) + (p.y - t.ccy) * (p.y - t.ccy) < t.r2) bad.push(t);
    }
    for (const t of bad) for (let e = 0; e < 3; e++) edges.push([t[e], t[(e + 1) % 3]]);
    const poly: Vert[][] = [];
    for (let i = 0; i < edges.length; i++) {
      let shared = false;
      for (let j = 0; j < edges.length; j++) {
        if (i === j) continue;
        const a = edges[i];
        const b = edges[j];
        if ((a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0])) {
          shared = true;
          break;
        }
      }
      if (!shared) poly.push(edges[i]);
    }
    tris = tris.filter((t) => !bad.includes(t));
    for (const e of poly) tris.push(mkTri(e[0], e[1], p));
  }
  tris = tris.filter((t) => t[0].i >= 0 && t[1].i >= 0 && t[2].i >= 0);
  const seen = new Set<number>();
  const out: Array<[number, number]> = [];
  for (const t of tris) {
    for (let e = 0; e < 3; e++) {
      const a = t[e].i;
      const b = t[(e + 1) % 3].i;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const k = lo * 4096 + hi;
      if (!seen.has(k)) {
        seen.add(k);
        out.push([lo, hi]);
      }
    }
  }
  return out;
}

/** Retry-on-invalid wrapper (upstream :177-188). Bounded to 5 attempts; the seed is
 * mutated deterministically between tries so a bad layout self-heals reproducibly. */
export function generateDungeon(params: DungeonParams): Dungeon {
  let attempt = 0;
  let seed = params.seed >>> 0;
  let d: Dungeon = tryGenerate(seed, params);
  while (attempt < 5) {
    d = tryGenerate(seed, params);
    if (d.valid) break;
    seed = (Math.imul(seed, 9301) + 49297) >>> 0;
    attempt++;
  }
  d.stats.attempts = attempt + 1;
  return d;
}

function emptyDungeon(seed: number, params: DungeonParams): Dungeon {
  return {
    valid: false,
    params,
    seed,
    W: 0,
    H: 0,
    grid: new Uint8Array(0),
    roomId: new Int16Array(0),
    corridor: new Uint8Array(0),
    doorway: new Uint8Array(0),
    rooms: [],
    edges: [],
    entrance: -1,
    boss: -1,
    maxDepth: 0,
    spawns: [],
    stats: { rooms: params.roomCount, edges: 0, loops: 0, critLen: 0, floorTiles: 0, reach: 0, attempts: 1 },
  };
}

function tryGenerate(seed: number, params: DungeonParams): Dungeon {
  const rng: Rng = makeRng(seed);
  const N = params.roomCount;

  /* -- 1. scatter (upstream :195-215) -- */
  const R = Math.sqrt(N) * 4.6;
  const rooms: Room[] = [];
  const large: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = rng.raw();
    let w: number;
    let h: number;
    let arch: RoomArch;
    if (t < 0.45) {
      arch = "s";
      w = rng.i(5, 7);
      h = rng.i(5, 7);
    } else if (t < 0.85) {
      arch = "m";
      w = rng.i(8, 12);
      h = rng.i(8, 12);
    } else {
      arch = "l";
      w = rng.i(13, 18);
      h = rng.i(13, 18);
      large.push(i);
    }
    const st = rng.raw();
    const shape: RoomShape = st < 0.6 ? "rect" : st < 0.82 ? "ellipse" : "oct";
    const ang = rng.f(0, Math.PI * 2);
    const rad = R * Math.sqrt(rng.raw());
    rooms.push({
      id: i,
      cx: Math.cos(ang) * rad,
      cy: Math.sin(ang) * rad,
      w,
      h,
      arch,
      shape,
      type: ROOM_TYPE.COMBAT,
      depth: 0,
      difficulty: 0.2,
      degree: 0,
    });
  }
  while (large.length < 2) {
    const j = rng.i(0, N - 1);
    if (rooms[j].arch !== "l") {
      rooms[j].arch = "l";
      rooms[j].w = rng.i(13, 18);
      rooms[j].h = rng.i(13, 18);
      rooms[j].shape = "rect";
      large.push(j);
    }
  }

  /* -- 2. separate (upstream :217-235) -- */
  const PAD = 2;
  {
    const CX = new Float64Array(N);
    const CY = new Float64Array(N);
    const HW = new Float64Array(N);
    const HH = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      CX[i] = rooms[i].cx;
      CY[i] = rooms[i].cy;
      HW[i] = rooms[i].w / 2 + PAD / 2;
      HH[i] = rooms[i].h / 2 + PAD / 2;
    }
    for (let iter = 0; iter < 300; iter++) {
      let moved = false;
      for (let i = 0; i < N; i++)
        for (let j = i + 1; j < N; j++) {
          const ox = HW[i] + HW[j] - Math.abs(CX[i] - CX[j]);
          if (ox <= 0) continue;
          const oy = HH[i] + HH[j] - Math.abs(CY[i] - CY[j]);
          if (oy <= 0) continue;
          moved = true;
          if (ox < oy) {
            const s = CX[i] <= CX[j] ? -1 : 1;
            CX[i] += (s * ox) / 2;
            CX[j] -= (s * ox) / 2;
          } else {
            const s = CY[i] <= CY[j] ? -1 : 1;
            CY[i] += (s * oy) / 2;
            CY[j] -= (s * oy) / 2;
          }
        }
      if (!moved) break;
    }
    for (let i = 0; i < N; i++) {
      rooms[i].cx = Math.round(CX[i]);
      rooms[i].cy = Math.round(CY[i]);
    }
  }

  /* -- 3. graph: Delaunay -> MST -> loops (upstream :237-285) -- */
  const centers = rooms.map((r) => ({ x: r.cx, y: r.cy }));
  let delEdges = delaunay(centers);
  if (delEdges.length === 0) {
    delEdges = [];
    for (let i = 0; i < N - 1; i++) delEdges.push([i, i + 1]);
  }
  const elen = (e: [number, number]): number =>
    Math.hypot(centers[e[0]].x - centers[e[1]].x, centers[e[0]].y - centers[e[1]].y);

  const adj: Array<Array<{ b: number; w: number; idx: number }>> = Array.from({ length: N }, () => []);
  delEdges.forEach((e, idx) => {
    const w = elen(e);
    adj[e[0]].push({ b: e[1], w, idx });
    adj[e[1]].push({ b: e[0], w, idx });
  });
  const inT = new Uint8Array(N);
  inT[0] = 1;
  let inCount = 1;
  const mstIdx = new Set<number>();
  while (inCount < N) {
    let best: { b: number; w: number; idx: number } | null = null;
    for (let a = 0; a < N; a++) if (inT[a]) for (const e of adj[a]) if (!inT[e.b] && (!best || e.w < best.w)) best = e;
    if (!best) break;
    inT[best.b] = 1;
    inCount++;
    mstIdx.add(best.idx);
  }
  if (inCount < N) return emptyDungeon(seed, params);

  let mstLenSum = 0;
  for (const i of mstIdx) mstLenSum += elen(delEdges[i]);
  const mstMean = mstLenSum / Math.max(1, mstIdx.size);

  const edges: DungeonEdge[] = [];
  delEdges.forEach((e, idx) => {
    if (mstIdx.has(idx)) edges.push({ a: e[0], b: e[1], isLoop: false, isCritical: false });
    else if (elen(e) < mstMean * 2.2 && rng.chance(params.loopChance))
      edges.push({ a: e[0], b: e[1], isLoop: true, isCritical: false });
  });
  for (const e of edges) {
    rooms[e.a].degree++;
    rooms[e.b].degree++;
  }

  /* leaf guard: prune loop edges until >=3 leaves (upstream :266-285) */
  if (N >= 20) {
    let leafCount = 0;
    for (let i = 0; i < N; i++) if (rooms[i].degree === 1) leafCount++;
    while (leafCount < 3) {
      let bi = -1;
      let bs = -1;
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        if (!e.isLoop) continue;
        const s = (rooms[e.a].degree === 2 ? 1 : 0) + (rooms[e.b].degree === 2 ? 1 : 0);
        const L = Math.hypot(centers[e.a].x - centers[e.b].x, centers[e.a].y - centers[e.b].y);
        const score = s * 10000 + L;
        if (score > bs) {
          bs = score;
          bi = i;
        }
      }
      if (bi < 0) break;
      const e = edges[bi];
      if (--rooms[e.a].degree === 1) leafCount++;
      if (--rooms[e.b].degree === 1) leafCount++;
      edges.splice(bi, 1);
    }
  }

  /* -- 4. semantics before carving (upstream :287-331) -- */
  const gAdj: Array<Array<{ b: number; i: number }>> = Array.from({ length: N }, () => []);
  edges.forEach((e, i) => {
    gAdj[e.a].push({ b: e.b, i });
    gAdj[e.b].push({ b: e.a, i });
  });

  let boss = 0;
  for (let i = 1; i < N; i++) if (rooms[i].w * rooms[i].h > rooms[boss].w * rooms[boss].h) boss = i;

  const distFrom = (src: number): Int32Array => {
    const D = new Int32Array(N).fill(-1);
    D[src] = 0;
    const q = [src];
    for (let h = 0; h < q.length; h++) {
      const a = q[h];
      for (const e of gAdj[a]) if (D[e.b] < 0) {
        D[e.b] = D[a] + 1;
        q.push(e.b);
      }
    }
    return D;
  };
  const dB = distFrom(boss);
  let entrance = -1;
  let bestD = -1;
  for (let i = 0; i < N; i++) if (i !== boss && rooms[i].degree === 1 && dB[i] > bestD) {
    bestD = dB[i];
    entrance = i;
  }
  if (entrance < 0) {
    for (let i = 0; i < N; i++) if (i !== boss && dB[i] > bestD) {
      bestD = dB[i];
      entrance = i;
    }
  }

  const dE = distFrom(entrance);
  let maxDepth = 1;
  for (let i = 0; i < N; i++) if (dE[i] > maxDepth) maxDepth = dE[i];
  rooms.forEach((r, i) => {
    r.depth = Math.max(0, dE[i]);
    r.difficulty = Math.min(1, 0.15 + 0.85 * (r.depth / maxDepth));
  });
  rooms[entrance].type = ROOM_TYPE.ENTRANCE;
  rooms[entrance].difficulty = 0;
  rooms[boss].type = ROOM_TYPE.BOSS;
  rooms[boss].difficulty = 1;

  const par = new Int32Array(N).fill(-1);
  const pe = new Int32Array(N).fill(-1);
  {
    const q = [entrance];
    const vis = new Uint8Array(N);
    vis[entrance] = 1;
    for (let h = 0; h < q.length; h++) {
      const a = q[h];
      for (const e of gAdj[a]) if (!vis[e.b]) {
        vis[e.b] = 1;
        par[e.b] = a;
        pe[e.b] = e.i;
        q.push(e.b);
      }
    }
  }
  const critRooms = new Set<number>();
  let critLen = 0;
  for (let c = boss; c !== -1; c = par[c]) {
    critRooms.add(c);
    if (pe[c] >= 0) {
      edges[pe[c]].isCritical = true;
      critLen++;
    }
    if (c === entrance) break;
  }

  const leaves: number[] = [];
  for (let i = 0; i < N; i++) if (i !== entrance && i !== boss && rooms[i].degree === 1) leaves.push(i);
  leaves.sort((a, b) => rooms[b].depth - rooms[a].depth);
  leaves.slice(0, 4).forEach((i) => {
    rooms[i].type = ROOM_TYPE.TREASURE;
  });

  const shrineC: number[] = [];
  for (let i = 0; i < N; i++) {
    const r = rooms[i];
    if (r.type === ROOM_TYPE.COMBAT && !critRooms.has(i) && r.depth > maxDepth * 0.3 && r.depth < maxDepth * 0.85)
      shrineC.push(i);
  }
  for (let k = 0; k < 2 && shrineC.length > 0; k++) {
    const j = shrineC.splice(rng.i(0, shrineC.length - 1), 1)[0];
    rooms[j].type = ROOM_TYPE.SHRINE;
  }
  const eliteC: number[] = [];
  for (const i of critRooms) {
    const r = rooms[i];
    if (r.type === ROOM_TYPE.COMBAT && r.depth >= maxDepth * 0.55 && r.depth <= maxDepth * 0.85) eliteC.push(i);
  }
  eliteC.sort((a, b) => rooms[a].depth - rooms[b].depth);
  for (let k = 0; k < Math.min(2, eliteC.length); k++) rooms[eliteC[eliteC.length - 1 - k]].type = ROOM_TYPE.ELITE;

  /* -- 5. carve + rasterize (upstream :347-425; theme mutations :333-345 dropped) -- */
  let minX = 1e9;
  let minY = 1e9;
  let maxX = -1e9;
  let maxY = -1e9;
  for (const r of rooms) {
    minX = Math.min(minX, r.cx - Math.ceil(r.w / 2));
    maxX = Math.max(maxX, r.cx + Math.ceil(r.w / 2));
    minY = Math.min(minY, r.cy - Math.ceil(r.h / 2));
    maxY = Math.max(maxY, r.cy + Math.ceil(r.h / 2));
  }
  const PADG = 5;
  const offX = PADG - minX;
  const offY = PADG - minY;
  const W = maxX - minX + PADG * 2 + 1;
  const H = maxY - minY + PADG * 2 + 1;
  for (const r of rooms) {
    r.cx += offX;
    r.cy += offY;
  }

  const grid = new Uint8Array(W * H);
  const roomId = new Int16Array(W * H).fill(-1);
  const corridor = new Uint8Array(W * H);
  const idx = (x: number, y: number): number => y * W + x;
  const inB = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H;

  for (const r of rooms) {
    const rx = r.w / 2;
    const ry = r.h / 2;
    const sh = r.shape;
    const ch = Math.min(rx, ry) * 0.55;
    const irx2 = 1 / (rx * rx);
    const iry2 = 1 / (ry * ry);
    const y0 = Math.max(0, Math.floor(r.cy - ry));
    const y1 = Math.min(H - 1, Math.ceil(r.cy + ry));
    const x0 = Math.max(0, Math.floor(r.cx - rx));
    const x1 = Math.min(W - 1, Math.ceil(r.cx + rx));
    for (let y = y0; y <= y1; y++) {
      const dy = y - r.cy;
      const ady = Math.abs(dy);
      const row = y * W;
      if (ady > ry) continue;
      for (let x = x0; x <= x1; x++) {
        const dx = x - r.cx;
        const adx = Math.abs(dx);
        if (adx > rx) continue;
        let ok = true;
        if (sh === "ellipse") ok = dx * dx * irx2 + dy * dy * iry2 <= 1.0;
        else if (sh === "oct") ok = adx <= rx - ch || ady <= ry - ch || adx - (rx - ch) + (ady - (ry - ch)) <= ch;
        if (ok) {
          const c = row + x;
          grid[c] = FLOOR;
          roomId[c] = r.id;
        }
      }
    }
  }

  const stamp = (x: number, y: number): void => {
    if (inB(x, y) && grid[idx(x, y)] !== FLOOR) {
      grid[idx(x, y)] = FLOOR;
      corridor[idx(x, y)] = 1;
    }
  };
  const offs = (w: number): number[] => (w === 1 ? [0] : w === 2 ? [0, 1] : [-1, 0, 1]);
  const hLine = (x0: number, x1: number, y: number, w: number): void => {
    const o = offs(w);
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) for (const k of o) stamp(x, y + k);
  };
  const vLine = (y0: number, y1: number, x: number, w: number): void => {
    const o = offs(w);
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) for (const k of o) stamp(x + k, y);
  };

  for (const e of edges) {
    const A = rooms[e.a];
    const B = rooms[e.b];
    let w = e.isCritical ? 3 : 2;
    if (!e.isCritical && (rooms[e.a].type === ROOM_TYPE.TREASURE || rooms[e.b].type === ROOM_TYPE.TREASURE) && rng.chance(0.4))
      w = 1;
    const dx = Math.abs(A.cx - B.cx);
    const dy = Math.abs(A.cy - B.cy);
    const ovX = Math.min(A.cx + A.w / 2, B.cx + B.w / 2) - Math.max(A.cx - A.w / 2, B.cx - B.w / 2);
    const ovY = Math.min(A.cy + A.h / 2, B.cy + B.h / 2) - Math.max(A.cy - A.h / 2, B.cy - B.h / 2);
    if (ovX >= w + 2 && dy > 0) {
      const x = Math.round((Math.max(A.cx - A.w / 2, B.cx - B.w / 2) + Math.min(A.cx + A.w / 2, B.cx + B.w / 2)) / 2);
      vLine(A.cy, B.cy, x, w);
    } else if (ovY >= w + 2 && dx > 0) {
      const y = Math.round((Math.max(A.cy - A.h / 2, B.cy - B.h / 2) + Math.min(A.cy + A.h / 2, B.cy + B.h / 2)) / 2);
      hLine(A.cx, B.cx, y, w);
    } else if (rng.chance(0.5)) {
      hLine(A.cx, B.cx, A.cy, w);
      vLine(A.cy, B.cy, B.cx, w);
    } else {
      vLine(A.cy, B.cy, A.cx, w);
      hLine(A.cx, B.cx, B.cy, w);
    }
  }

  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (grid[row + x] !== FLOOR) continue;
      const ya = Math.max(0, y - 1);
      const yb = Math.min(H - 1, y + 1);
      const xa = Math.max(0, x - 1);
      const xb = Math.min(W - 1, x + 1);
      for (let ny = ya; ny <= yb; ny++) {
        const nrow = ny * W;
        for (let nx = xa; nx <= xb; nx++) {
          const ni = nrow + nx;
          if (grid[ni] === VOID) grid[ni] = WALL;
        }
      }
    }
  }

  const doorway = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const c = row + x;
      if (!corridor[c]) continue;
      if (
        (x < W - 1 && roomId[c + 1] >= 0) ||
        (x > 0 && roomId[c - 1] >= 0) ||
        (y < H - 1 && roomId[c + W] >= 0) ||
        (y > 0 && roomId[c - W] >= 0)
      )
        doorway[c] = 1;
    }
  }

  /* -- 6. BFS field + validation (upstream :522-541) -- */
  const total = W * H;
  const bfs = new Int16Array(W * H).fill(-1);
  const ei = idx(rooms[entrance].cx, rooms[entrance].cy);
  let floorTotal = 0;
  for (let i = 0; i < total; i++) if (grid[i] === FLOOR) floorTotal++;
  let reach = 0;
  if (grid[ei] === FLOOR) {
    const q = new Int32Array(floorTotal);
    let qh = 0;
    let qt = 0;
    q[qt++] = ei;
    bfs[ei] = 0;
    reach = 1;
    while (qh < qt) {
      const c = q[qh++];
      const x = c % W;
      const b = bfs[c] + 1;
      let n: number;
      if (x > 0 && grid[(n = c - 1)] === FLOOR && bfs[n] < 0) {
        bfs[n] = b;
        q[qt++] = n;
        reach++;
      }
      if (x < W - 1 && grid[(n = c + 1)] === FLOOR && bfs[n] < 0) {
        bfs[n] = b;
        q[qt++] = n;
        reach++;
      }
      if (c >= W && grid[(n = c - W)] === FLOOR && bfs[n] < 0) {
        bfs[n] = b;
        q[qt++] = n;
        reach++;
      }
      if (c < total - W && grid[(n = c + W)] === FLOOR && bfs[n] < 0) {
        bfs[n] = b;
        q[qt++] = n;
        reach++;
      }
    }
  }
  const valid = reach === floorTotal && floorTotal > 0;

  /* -- 7. tier-graded monster spawns (upstream :593-612; theme/decor prop scatter dropped) -- */
  const spawns: DungeonSpawn[] = [];
  const occ = new Uint8Array(W * H);
  for (const r of rooms) {
    if (r.type === ROOM_TYPE.COMBAT || r.type === ROOM_TYPE.ELITE || r.type === ROOM_TYPE.BOSS) {
      let area = 0;
      for (let y = Math.floor(r.cy - r.h / 2); y <= Math.ceil(r.cy + r.h / 2); y++)
        for (let x = Math.floor(r.cx - r.w / 2); x <= Math.ceil(r.cx + r.w / 2); x++)
          if (inB(x, y) && roomId[idx(x, y)] === r.id) area++;
      let count = Math.round((area / 18) * (0.5 + r.difficulty));
      if (r.type === ROOM_TYPE.ELITE) count = Math.max(2, Math.round(count * 0.6));
      if (r.type === ROOM_TYPE.BOSS) count = rng.i(2, 3);
      const tier = r.type === ROOM_TYPE.ELITE ? 3 : Math.max(1, Math.ceil(r.difficulty * 3));
      let guard = 0;
      while (count > 0 && guard++ < 220) {
        const x = rng.i(Math.floor(r.cx - r.w / 2) + 1, Math.ceil(r.cx + r.w / 2) - 1);
        const y = rng.i(Math.floor(r.cy - r.h / 2) + 1, Math.ceil(r.cy + r.h / 2) - 1);
        if (!inB(x, y)) continue;
        const c = idx(x, y);
        if (roomId[c] === r.id && grid[c] === FLOOR && !occ[c] && !doorway[c]) {
          spawns.push({ x, y, tier, roomId: r.id });
          occ[c] = 1;
          count--;
        }
      }
    }
  }

  const loops = edges.filter((e) => e.isLoop).length;
  return {
    valid,
    params,
    seed,
    W,
    H,
    grid,
    roomId,
    corridor,
    doorway,
    rooms,
    edges,
    entrance,
    boss,
    maxDepth,
    spawns,
    stats: { rooms: N, edges: edges.length, loops, critLen, floorTiles: floorTotal, reach, attempts: 1 },
  };
}

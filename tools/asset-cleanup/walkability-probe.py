#!/usr/bin/env python3
"""Walkability probe: flood-fill the compiled collision grid with the server's
player-footprint semantics and render where the player can actually stand.

Built 2026-07-02 after the second "I'm stuck at the border / can't reach the
cliff" owner walk (first: ghost monster colliders; the band values alone kept
being argued from screenshots). This makes reachability mechanical: invisible
walls, unreachable pockets, and border-gap escapes all show up as pixels.

Footprint semantics mirror server/src/index.ts: feet rect = halfWidth 14,
height 18 above the feet (server/config/game.json player.footprint) tested
against the map's blocked-tile grid.

Usage:
  python tools/asset-cleanup/walkability-probe.py content/maps/<map>.json \
      [--out probe.png] [--step 8]

Prints: reachable feet-y range per 200px column band (how close to the north
cliff / south treeline the player can really get), any walkable-but-unreachable
pockets, and whether the map edge is escapable. Exit 1 if the flood fill
reaches within one footprint of a map edge (border containment breach).
PNG legend: green = reachable, orange = walkable but unreachable pocket,
dark = blocked for the footprint.

Landmark reachability (--landmarks FILE): the "0 unreachable cells" verdict
passed on a zone where the player was hard-stuck (owner walk 2026-07-03) because a
BLOCKED region that SHOULD be walkable is not a "pocket" — the probe had no notion
of where the player is expected to reach. A landmarks file makes that mechanical:
each landmark is a feet-space point the player must be able to STAND near
(a reachable flood-fill cell within `tol` px). Any unreachable landmark -> exit 1.
Schema: {"landmarks":[{"name":"cliff_base","x":1200,"y":215,"tol":40}, ...]}.
This is what gates the "can't reach the cliff base / behind the windmill / the
blossom tree" failure class forever (card-bloomvale-collision-tune scope 4).
"""
import argparse, json, sys
from collections import deque

from PIL import Image

HALF_W, FOOT_H = 14, 18  # keep in sync with server/config/game.json


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("map_json")
    ap.add_argument("--out", default=None)
    ap.add_argument("--step", type=int, default=8)
    ap.add_argument("--landmarks", default=None,
                    help="JSON file of {name,x,y,tol} points the player must reach")
    args = ap.parse_args()

    m = json.load(open(args.map_json))
    W, H = m["size"]["width"], m["size"]["height"]
    ts = m["collision"]["tileSize"]
    blocked = {tuple(t) for t in m["collision"]["blocked"]}
    step = args.step

    def rect_blocked(fx: float, fy: float) -> bool:
        left, right = fx - HALF_W, fx + HALF_W
        top, bottom = fy - FOOT_H, fy
        for ty in range(int(top // ts), int((bottom - 1e-9) // ts) + 1):
            for tx in range(int(left // ts), int((right - 1e-9) // ts) + 1):
                if (tx, ty) in blocked:
                    return True
        return False

    cols, rows = W // step, H // step

    def walkable(cx: int, cy: int) -> bool:
        fx, fy = cx * step, cy * step
        if fx - HALF_W < 0 or fx + HALF_W > W or fy - FOOT_H < 0 or fy > H:
            return False
        return not rect_blocked(fx, fy)

    walk = [[walkable(cx, cy) for cx in range(cols)] for cy in range(rows)]

    # flood fill from the map's first spawn point (feet space = entity y + offset
    # is irrelevant here; spawn points are authored in world space near the feet)
    sp = m["spawnPoints"][0]
    start = (min(cols - 1, max(0, round(sp["x"] / step))),
             min(rows - 1, max(0, round(sp["y"] / step))))
    # snap to nearest walkable cell
    if not walk[start[1]][start[0]]:
        best = None
        for cy in range(rows):
            for cx in range(cols):
                if walk[cy][cx]:
                    d = (cx - start[0]) ** 2 + (cy - start[1]) ** 2
                    if best is None or d < best[0]:
                        best = (d, cx, cy)
        if best is None:
            print("FAIL: no walkable cell anywhere")
            return 1
        start = (best[1], best[2])

    reach = [[False] * cols for _ in range(rows)]
    q = deque([start])
    reach[start[1]][start[0]] = True
    while q:
        cx, cy = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = cx + dx, cy + dy
            if 0 <= nx < cols and 0 <= ny < rows and walk[ny][nx] and not reach[ny][nx]:
                reach[ny][nx] = True
                q.append((nx, ny))

    # per-column-band reachable feet-y extremes
    print(f"map {W}x{H} ts={ts} blocked={len(blocked)} step={step} "
          f"spawn=({sp['x']},{sp['y']})")
    print(f"{'x band':>12} {'min feet-y':>10} {'max feet-y':>10}")
    band = 200
    breach = False
    for bx in range(0, W, band):
        ys = [cy * step for cy in range(rows) for cx in range(cols)
              if bx <= cx * step < bx + band and reach[cy][cx]]
        if ys:
            print(f"{bx:>5}-{bx + band:<6} {min(ys):>10} {max(ys):>10}")
    # containment: reachable cell hugging a map edge = player can walk to raw edge
    for cy in range(rows):
        for cx in range(cols):
            if reach[cy][cx]:
                fx, fy = cx * step, cy * step
                if fx <= HALF_W + step or fx >= W - HALF_W - step or \
                   fy <= FOOT_H + step or fy >= H - step:
                    breach = True
    pockets = sum(walk[cy][cx] and not reach[cy][cx]
                  for cy in range(rows) for cx in range(cols))
    print(f"unreachable walkable cells: {pockets} "
          f"({pockets * 100 // max(1, sum(map(sum, walk)))}% of walkable)")
    print(f"edge containment: {'BREACH' if breach else 'ok'}")

    # --- landmark reachability: each named point must have a REACHABLE cell within
    # tol px, else the player cannot stand there (invisible wall / oversized box). ---
    landmark_fail = False
    if args.landmarks:
        lm = json.load(open(args.landmarks))["landmarks"]
        reachable_pts = [(cx * step, cy * step)
                         for cy in range(rows) for cx in range(cols) if reach[cy][cx]]
        print(f"{'landmark':>20} {'target':>14} {'tol':>5} {'nearest reach':>14}  result")
        for L in lm:
            tx, ty, tol = L["x"], L["y"], L.get("tol", 40)
            best = min(((px - tx) ** 2 + (py - ty) ** 2, px, py)
                       for px, py in reachable_pts) if reachable_pts else (float("inf"), -1, -1)
            dist = best[0] ** 0.5
            ok = dist <= tol
            if not ok:
                landmark_fail = True
            print(f"{L['name']:>20} {f'({tx},{ty})':>14} {tol:>5} "
                  f"{f'({best[1]},{best[2]})':>14}  "
                  f"{'PASS' if ok else 'FAIL d=%.0f' % dist}")
        print(f"LANDMARKS: {'FAIL' if landmark_fail else 'PASS'} ({len(lm)} checked)")

    if args.out:
        img = Image.new("RGB", (cols, rows))
        px = img.load()
        for cy in range(rows):
            for cx in range(cols):
                px[cx, cy] = ((60, 200, 90) if reach[cy][cx]
                              else (235, 140, 40) if walk[cy][cx]
                              else (40, 36, 48))
        img = img.resize((cols * 4, rows * 4), Image.NEAREST)
        img.save(args.out)
        print(f"wrote {args.out}")
    return 1 if (breach or landmark_fail) else 0


if __name__ == "__main__":
    sys.exit(main())

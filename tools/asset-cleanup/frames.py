"""Detect + remove baked border-frame / matte-box / sliver artifacts on cutout assets.

Companion to fringe.py (which handles chroma halos). This handles the SECOND defect class
the 2026-06-30 cleanup surfaced: a faint rectangular frame, guide box, or edge sliver baked
near the canvas border, separated from the subject by transparency.

Detection (`scan`): a straight run of ink (alpha>OP) hugging a canvas edge with a transparent
GAP between it and the subject. Subject content that simply reaches the edge has no gap.
NOTE: this is a heuristic — a long thin subject (a spear, a staff) reaching the border can be
a FALSE POSITIVE. Always visually confirm; do not hard-gate on it.

Fix (`fix`): keep the largest connected blob (the subject) and erase OTHER components that
touch the outer margin and are small relative to it. This cleanly removes DETACHED frames /
slivers and safely ignores false positives (the subject is the largest blob, never erased).
It does NOT remove a frame that is CONNECTED to the subject, or one fainter than OP — those
need a human pass. `fix` reports residual `scan` flags so you know what it couldn't get.

CLI:
  python frames.py scan PATH [--json OUT] [--exclude N ...]
  python frames.py fix  PATH [--backup DIR] [--run] [--exclude N ...]
"""
from __future__ import annotations
import argparse, json, os, shutil, sys, warnings
from collections import deque

warnings.filterwarnings("ignore", message=".*getdata is deprecated.*")
try:
    from PIL import Image
except ImportError:
    sys.stderr.write("frames.py requires Pillow: pip install Pillow\n"); sys.exit(2)

OP = 28
MARGIN = 0.12
SPAN = 0.45        # detection threshold (flag for review)
FRAME_SPAN = 0.82 # erase threshold: only near-full-span lines (a true rectangle frame is
                  # ~0.86; a thin subject reaching the edge, e.g. a spear, is ~0.77) so the
                  # line-erase never eats edge-reaching subjects.
GAP_INNER = 0.12
SMALL = 0.20
SKIP_DIRS = {"_review","_sliced","_cleanup","_cleanup-backups","_rejected","_archive","archive",
             "_runtime-ready-packs","_promotion-plans","thumbs",".thumbs","_previews","frames",
             "node_modules",".git","__pycache__"}


def scan_one(path):
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    a = list(im.getchannel("A").getdata())
    def rowfrac(y): return sum(1 for x in range(w) if a[y * w + x] > OP) / w
    def colfrac(x): return sum(1 for y in range(h) if a[y * w + x] > OP) / h
    my = max(2, int(h * MARGIN)); mx = max(2, int(w * MARGIN))

    def line(coords, frac_fn, step, n):
        for i in coords:
            if frac_fn(i) > SPAN:
                inner = [frac_fn(i + step * d) for d in range(2, 8) if 0 <= i + step * d < n]
                if inner and max(inner) <= GAP_INNER:
                    return round(frac_fn(i), 2)
        return 0.0

    edges = {
        "top": line(range(0, my), rowfrac, +1, h),
        "bottom": line(range(h - 1, h - my, -1), rowfrac, -1, h),
        "left": line(range(0, mx), colfrac, +1, w),
        "right": line(range(w - 1, w - mx, -1), colfrac, -1, w),
    }
    return [e for e, v in edges.items() if v]


def _erase_frame_lines(w, h, px):
    """Erase near-full-span border lines (a true rectangle frame). Operates on the current px;
    only fires for coverage > FRAME_SPAN so edge-reaching subjects (spears) are never touched."""
    a = [px[i][3] for i in range(w * h)]
    def rowfrac(y): return sum(1 for x in range(w) if a[y * w + x] > OP) / w
    def colfrac(x): return sum(1 for y in range(h) if a[y * w + x] > OP) / h
    my = max(2, int(h * MARGIN)); mx = max(2, int(w * MARGIN))
    removed = 0

    def clear_rows(y0, y1):
        nonlocal removed
        for y in range(max(0, y0), min(h, y1 + 1)):
            for x in range(w):
                i = y * w + x
                if px[i][3] > 0:
                    r, g, b, _ = px[i]; px[i] = (r, g, b, 0); removed += 1

    def clear_cols(x0, x1):
        nonlocal removed
        for x in range(max(0, x0), min(w, x1 + 1)):
            for y in range(h):
                i = y * w + x
                if px[i][3] > 0:
                    r, g, b, _ = px[i]; px[i] = (r, g, b, 0); removed += 1

    for y in range(0, my):
        if rowfrac(y) > FRAME_SPAN and max([rowfrac(y + d) for d in range(2, 8) if y + d < h] or [1]) <= GAP_INNER:
            clear_rows(0, y + 1); break
    for y in range(h - 1, h - my, -1):
        if rowfrac(y) > FRAME_SPAN and max([rowfrac(y - d) for d in range(2, 8) if y - d >= 0] or [1]) <= GAP_INNER:
            clear_rows(y - 1, h - 1); break
    for x in range(0, mx):
        if colfrac(x) > FRAME_SPAN and max([colfrac(x + d) for d in range(2, 8) if x + d < w] or [1]) <= GAP_INNER:
            clear_cols(0, x + 1); break
    for x in range(w - 1, w - mx, -1):
        if colfrac(x) > FRAME_SPAN and max([colfrac(x - d) for d in range(2, 8) if x - d >= 0] or [1]) <= GAP_INNER:
            clear_cols(x - 1, w - 1); break
    return removed


def fix_one(path, dst=None):
    """Erase detached border-frame artifacts. Stage 1: drop detached border-touching
    components (keeps subject). Stage 2: erase any near-full-span frame line left behind
    (handles small-subject/large-frame where stage 1's largest-blob assumption flips)."""
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    px = list(im.getdata())
    ink = [1 if px[i][3] > OP else 0 for i in range(w * h)]
    comp = [0] * (w * h)
    comps = []
    mx = max(2, int(w * MARGIN)); my = max(2, int(h * MARGIN))
    cid = 0
    for s in range(w * h):
        if ink[s] and comp[s] == 0:
            cid += 1; q = deque([s]); comp[s] = cid; idxs = []; touch = False
            while q:
                i = q.popleft(); idxs.append(i)
                x, y = i % w, i // w
                if x < mx or x >= w - mx or y < my or y >= h - my:
                    touch = True
                for nx, ny in ((x+1,y),(x-1,y),(x,y+1),(x,y-1)):
                    if 0 <= nx < w and 0 <= ny < h:
                        j = ny * w + nx
                        if ink[j] and comp[j] == 0:
                            comp[j] = cid; q.append(j)
            comps.append((len(idxs), touch, idxs))
    removed = 0
    if comps:
        main = max(range(len(comps)), key=lambda k: comps[k][0])
        main_area = comps[main][0]
        for k, (sz, touch, idxs) in enumerate(comps):
            if k != main and touch and sz < SMALL * main_area:
                for i in idxs:
                    r, g, b, _ = px[i]; px[i] = (r, g, b, 0)
                removed += sz
    removed += _erase_frame_lines(w, h, px)   # stage 2: full-span frame lines
    if removed and dst:
        im.putdata(px); im.save(dst)
    return removed


def _iter(path, exclude=()):
    skip = SKIP_DIRS | set(exclude)
    if os.path.isfile(path):
        if path.lower().endswith(".png"): yield path
        return
    for dp, dns, fns in os.walk(path):
        dns[:] = [d for d in dns if d not in skip]
        for fn in fns:
            if fn.lower().endswith(".png"): yield os.path.join(dp, fn)


def cmd_scan(args):
    base = args.path if os.path.isdir(args.path) else os.path.dirname(args.path)
    hits = []; n = 0
    for p in _iter(args.path, args.exclude):
        n += 1
        try: f = scan_one(p)
        except Exception: continue
        if f: hits.append((os.path.relpath(p, base).replace("\\", "/"), f))
    print(f"scanned {n}; frame-artifact suspects: {len(hits)} (heuristic - confirm visually)")
    for rel, f in hits[:40]:
        print(f"  {','.join(f):22s} {rel}")
    if len(hits) > 40: print(f"  ... and {len(hits)-40} more")
    if args.json:
        json.dump({"scanned": n, "suspects": [r for r, _ in hits]}, open(args.json, "w"), indent=1)
    return 0


def cmd_fix(args):
    base = args.path if os.path.isdir(args.path) else os.path.dirname(args.path)
    fixed = residual = 0
    for p in _iter(args.path, args.exclude):
        try: flags = scan_one(p)
        except Exception: continue
        if not flags: continue
        rel = os.path.relpath(p, base).replace("\\", "/")
        if not args.run:
            print(f"  would fix  {','.join(flags):18s} {rel}"); continue
        if args.backup:
            bp = os.path.join(args.backup, rel); os.makedirs(os.path.dirname(bp), exist_ok=True)
            if not os.path.exists(bp): shutil.copy2(p, bp)
        rem = fix_one(p, p)
        after = scan_one(p)
        if rem:
            fixed += 1
            tag = " RESIDUAL:" + ",".join(after) if after else ""
            print(f"  fixed {rem:6d}px  {rel}{tag}")
        if after:
            residual += 1
            if not rem:
                print(f"  COULD-NOT-FIX (connected/faint or false-positive) {','.join(after):14s} {rel}")
    if args.run:
        print(f"EXECUTED: auto-fixed {fixed}; {residual} still flagged (need human review)")
    else:
        print("DRY RUN (pass --run to apply; --backup DIR to keep originals)")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Border-frame / matte-box artifact detect + fix")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("scan"); s.add_argument("path"); s.add_argument("--json"); s.add_argument("--exclude", nargs="*", default=[]); s.set_defaults(fn=cmd_scan)
    f = sub.add_parser("fix"); f.add_argument("path"); f.add_argument("--backup"); f.add_argument("--exclude", nargs="*", default=[]); f.add_argument("--run", action="store_true"); f.set_defaults(fn=cmd_fix)
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())

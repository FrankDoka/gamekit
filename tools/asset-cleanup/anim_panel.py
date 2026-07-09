"""anim_panel.py - the mandatory native-scale animation acceptance panel.

    python tools/asset-cleanup/anim_panel.py SHEET --cell N [--out PANEL.png] [--scale 2]

Renders every frame of SHEET as a per-frame close-up strip: native pixels
upscaled 2x NEAREST (never smoothed - smoothing hides exactly the garble this
panel exists to expose), checkerboard backing so alpha defects read, frame
indices labeled, gaps between frames. Default output: <sheet-stem>.panel.png
(the exact artifact name the intake fail-closed gate requires staged next to
the sheet).

DOCTRINE (integrator ruling 2026-07-07, card-anim-validators): this panel +
adversary/owner eyes-on OWNS the geometric-incoherence defect class -
plank-rotation deaths, anatomical garble (the reverted B4 death/hurt sheets
are the canonical examples). recipes.py motion-arc/identity-palette catch
duplicate-tiling, flat motion, and costume drift ONLY; they measurably CANNOT
separate geometric garble from legitimate high-motion positives. That is why
intake requires this panel alongside both verdicts - it is not optional.

--cell is MANDATORY and explicit, never inferred from sheet width
(spritesheet protocol: a 1536px sheet mis-split 4x384 vs 6x256 fooled the
integrator once). Exit 0 = panel written; 1 = sheet/cell mismatch; 2 = usage.
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

GAP = 8
HEADER = 22
CHECKER = 16
# DARK checkerboard row (default). A magenta despill ring is invisible against dark
# backing - that is exactly why the video-keying ring was dismissed eyes-on
# (card-anim-opaque-ring-wiring, 2026-07-07).
BG_A = (40, 40, 48, 255)
BG_B = (58, 58, 68, 255)
# LIGHT checkerboard row (added below the dark row). A dark-magenta/despill ring
# reads instantly against a light backing; a legit dark cel outline stays a normal
# outline. Both rows share one panel so the reviewer never has to re-composite.
LIGHT_A = (208, 208, 216, 255)
LIGHT_B = (176, 176, 188, 255)


def _checker(draw, x0, y0, x1, y1, bg_b):
    for y in range(y0, y1, CHECKER):
        for x in range(x0, x1, CHECKER):
            if (x // CHECKER + y // CHECKER) % 2:
                draw.rectangle((x, y, min(x + CHECKER, x1) - 1, min(y + CHECKER, y1) - 1), fill=bg_b)


def build_panel(sheet_path, cell, scale):
    im = Image.open(sheet_path).convert("RGBA")
    w, h = im.size
    if cell <= 0 or w % cell != 0:
        print(f"FAIL: sheet width {w} is not divisible by --cell {cell} "
              f"(remainder {w % cell if cell > 0 else 'n/a'}) - measure the sheet, never guess the cell")
        return None
    n = w // cell
    if n < 1:
        print(f"FAIL: no frames at cell={cell}")
        return None
    fw, fh = cell * scale, h * scale
    panel_w = n * fw + (n + 1) * GAP
    # Two frame rows (dark backing, then light backing) so a magenta despill ring that
    # is invisible on dark reads against light. Layout: HEADER, GAP, row1, GAP, row2, GAP.
    panel_h = HEADER + 2 * fh + 3 * GAP
    panel = Image.new("RGBA", (panel_w, panel_h), BG_A)
    draw = ImageDraw.Draw(panel)
    row1_y = HEADER + GAP
    row2_y = HEADER + fh + 2 * GAP
    # dark checkerboard behind row 1
    _checker(draw, 0, HEADER, panel_w, row2_y, BG_B)
    # light backing (flat + light checkerboard) behind row 2
    draw.rectangle((0, row2_y - GAP, panel_w, panel_h), fill=LIGHT_A)
    _checker(draw, 0, row2_y - GAP, panel_w, panel_h, LIGHT_B)
    draw.text((GAP, 4), f"{Path(sheet_path).name}  cell={cell}  frames={n}  scale={scale}x NEAREST  "
                        f"[top: dark backing · bottom: light backing]",
              fill=(235, 235, 240, 255))
    for i in range(n):
        frame = im.crop((i * cell, 0, (i + 1) * cell, h)).resize((fw, fh), Image.NEAREST)
        x = GAP + i * (fw + GAP)
        panel.alpha_composite(frame, (x, row1_y))
        panel.alpha_composite(frame, (x, row2_y))
        draw.text((x + 2, row1_y + 2), f"f{i:02d}", fill=(255, 220, 120, 255))
        draw.text((x + 2, row2_y + 2), f"f{i:02d}", fill=(40, 30, 10, 255))
    return panel


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    sheet = argv[1]
    opts = {}
    i = 2
    while i < len(argv):
        if not argv[i].startswith("--") or i + 1 >= len(argv):
            print(__doc__)
            return 2
        opts[argv[i]] = argv[i + 1]
        i += 2
    if "--cell" not in opts:
        print("anim_panel requires an EXPLICIT --cell (never inferred from width - "
              "measure the sheet first, spritesheet protocol)")
        return 2
    cell = int(opts["--cell"])
    scale = int(opts.get("--scale", "2"))
    out = Path(opts.get("--out") or Path(sheet).with_suffix("").as_posix() + ".panel.png")
    panel = build_panel(sheet, cell, scale)
    if panel is None:
        return 1
    out.parent.mkdir(parents=True, exist_ok=True)
    panel.convert("RGB").save(out)
    print(f"OK: panel {out} ({panel.size[0]}x{panel.size[1]}) - eyes-on this at gameplay framing; "
          f"the panel layer owns geometric-incoherence acceptance")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

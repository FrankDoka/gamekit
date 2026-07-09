"""Generate the known-bad regression fixtures for the R0 defect-gate hardening
(charter 2026-07-02 item 4). Deterministic — re-run any time to regenerate.

  python make_fixtures.py

Writes into tools/asset-cleanup/_fixtures/known-bad/:
  purple_rim.png       - clean opaque core, semi-transparent edge band biased pink/purple
                          (the class fringe.py's classify() intentionally does NOT catch;
                          rimfix's pink-rim detector must)
  crop_artifact.png     - a residual solid-magenta rectangular block (un-keyed sheet-slice
                          remnant) covering >8% of the opaque area -> full_bg('M')
  dull_gray_tile.png    - fully opaque, low-saturation low-value gray tile: must NOT trip any
                          hard_defect() code, but MUST trip the vibrancy WARNING (advisory only)
"""
from __future__ import annotations
import os
from PIL import Image

OUT_DIR = os.path.join(os.path.dirname(__file__), "_fixtures", "known-bad")


def make_purple_rim(size=40, core=(150, 110, 70, 255), band_px=2):
    """Opaque core blob with a semi-transparent ring whose chroma is pushed toward magenta —
    the exact "soft purple rim" defect class (owner-flagged 2026-07-01, devlog 0185)."""
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = im.load()
    cx = cy = size / 2
    r_core = size / 2 - band_px - 1
    r_outer = size / 2 - 0.5
    for y in range(size):
        for x in range(size):
            d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
            if d <= r_core:
                px[x, y] = core
            elif d <= r_outer:
                # Semi-transparent rim, magenta-biased chroma vs. the tan core.
                t = (d - r_core) / max(1e-6, (r_outer - r_core))
                alpha = int(200 * (1 - t) + 40 * t)
                px[x, y] = (210, 60, 190, max(1, alpha))
            # else: stays fully transparent
    return im


def make_crop_artifact(size=48, block_frac=0.30):
    """A clean-ish subject plus a solid, fully-opaque #ff00ff rectangular remnant in one
    corner — the residual un-keyed sheet-slice crop artifact class."""
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = im.load()
    # Small opaque "subject" circle, unrelated hue, so this isn't ALSO a pink-rim/edge-halo case.
    cx = cy = size * 0.65
    r = size * 0.22
    for y in range(size):
        for x in range(size):
            if ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5 <= r:
                px[x, y] = (90, 150, 90, 255)
    block = int(size * block_frac)
    for y in range(block):
        for x in range(block):
            px[x, y] = (255, 0, 255, 255)  # pure #ff00ff, fully opaque, un-keyed
    return im


def make_dull_gray_tile(size=32, color=(118, 116, 112, 255)):
    """Fully opaque, near-flat low-chroma/low-value gray — should clear every hard_defect
    class but trip the vibrancy WARNING (mean saturation/value below the advisory floor)."""
    return Image.new("RGBA", (size, size), color)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    make_purple_rim().save(os.path.join(OUT_DIR, "purple_rim.png"))
    make_crop_artifact().save(os.path.join(OUT_DIR, "crop_artifact.png"))
    make_dull_gray_tile().save(os.path.join(OUT_DIR, "dull_gray_tile.png"))
    print(f"wrote 3 fixtures -> {OUT_DIR}")


if __name__ == "__main__":
    main()

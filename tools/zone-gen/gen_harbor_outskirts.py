# -*- coding: utf-8 -*-
"""Regenerates content/zones/map_harbor_outskirts.layout.json (Bloomvale Plains).

⚠ STALE vs the LIVE layout (card-world-spawn-fixes, 2026-07-07). The live layout has been
hand-tuned since the last generator run — owner Build-Mode saves (commit 37c7bf0e), the
onboarding slime field move (172b2bd5), the additive loot `chests` array (5f7a8161, which
this generator does NOT emit), and the session-20 spawn relayout (default spawn 600→860,
warden 700,500→560,660, chest instance 700,620→1050,640, barrel_plaza→500,555, monster
field_3→340,1140). Re-running this file blindly would DELETE those edits AND the chest.
`chests` is now preserved verbatim from the existing layout (see `out` below), but the
spawn/NPC/vignette coords here are kept in sync ONLY as documentation — the layout JSON is
the source of truth. If you must regenerate, diff the result against the committed layout
and restore any hand-tuned placements before exporting.

BLOOMVALE REVIVAL BUILD (2026-07-03, card-bloomvale-revival): the nautical prop set
is retired. Ground/trees/bushes use the cel set; vignettes (windmill/granary/hay-cart/
firewood/well/notice-board/chest/barrels + picnic-stump/mossy-log/wildflower-patch),
the north cliff band (left-cap + run + right-cap), and the meadow scatter (wildflowers/
tufts/daisy/bells/stones) are the masswave-bloomvale-20260703 1440p-basis runtimes.
Monster fields spawn the four Bloomvale slimes (meadow/dew/blossom/honey).

Tuned constants (all owner-walked 2026-07-02, see zone-guide THE ZONE PATTERN and
its "Worked example: Bloomvale Plains" section for the full rationale):
- north border: CLIFF BAND segments, BOTTOM-anchored at y=180 so the art clips
  slightly past the map edge and the y210 feet stop reads in front of the rock
  (1123px trimmed art, 1040px step = 83px overlap, no join cracks);
- other borders: staggered double tree rows, 95px spacing, S at H-2/H-72, E/W
  columns at 12/84 and W-12/W-84 starting y=265 (below the cliff) -- continuous,
  NO keep-clear holes;
- perimeter collision: BAND_N 192 (feet stop ~y210, ~30px below the y180 cliff
  base so the player body stays in front of the rock; owner walk 2026-07-03
  rejected the next tile-row stop, y242, as too far south) / BAND_S 40 (thin
  backstop -- the trunk collision boxes are the real south barrier; player walks
  into the treeline and stops at trunk bases, occluded by canopy) / BAND_EW 165;
- monster field: grid 185px + jitter, skip 0.10, quiet radii 240-320 around
  NPCs/vignettes and 170 around player spawns (~30 fields, species-weighted);
- scatter grid y-starts (trees 310 / mid 330 / flora 270) keep scatter OUT of the
  cliff band (cliff art ends ~y=196) -- owner walked into overlaps otherwise;
- display sizes: verify with tools/asset-cleanup/display-audit.py after changes.
NPCs / portals / player spawns / bounds are preserved verbatim from the existing
layout file. After running: pnpm zone:validate && pnpm zone:export && capture.
"""
import json, math

import os, sys
# Deterministic Bloomvale Plains (id map_harbor_outskirts) layout generator - REFERENCE IMPLEMENTATION of the
# one-overlay zone pattern (zone-building-guide "THE ZONE PATTERN"). No RNG: seeded
# hash jitter only, so the same inputs always produce the same layout. Run from the
# repo root (or pass it): python tools/zone-gen/gen_harbor_outskirts.py [repo_root]
WT = sys.argv[1] if len(sys.argv) > 1 else '.'
HERE = os.path.dirname(os.path.abspath(__file__))
lay = json.load(open(f'{WT}/content/zones/map_harbor_outskirts.layout.json'))
specs = json.load(open(f'{HERE}/harbor_specs.json'))

def spec_for(kind, key):
    return dict(specs[kind].get(key, {'scale': 1}))

def jitv(i, salt):
    return (h(i, salt, 42) - 0.5) * 44

def h(i, j, salt):
    v = math.sin(i * 127.1 + j * 311.7 + salt * 74.7) * 43758.5453
    return v - math.floor(v)

W, H = 2400, 1800

# --- reference-game pattern: ONE ground overlay, everything else is scatter ---
ground = [
  {'instanceId': 'g_base_grass', 'assetKey': 'cel_grass_ground_master_1024',
   'x': 0, 'y': 0, 'width': W, 'height': H, 'zIndex': -1},
]

# --- keep-clear zones (cx, cy, radius): vignettes, portal, npcs, spawns ---
CLEAR = [
  (665, 610, 260),    # village green (windmill/board/well + npcs)
  (1180, 650, 170),   # portal turnout
  (1210, 480, 230),   # granary steading
  (2200, 760, 240),   # east farmstead (hay cart + firewood)
  (1702, 1292, 110),  # treasure chest
  (1500, 780, 110),   # picnic-stump rest spot
  (980, 1150, 120),   # mossy-log rest spot
]
for npc in lay['npcs']:
    CLEAR.append((npc['x'], npc['y'], 120))
for sp in lay['spawnPoints']:
    CLEAR.append((sp['x'], sp['y'], 140))
# monster fields: Bloomvale slime roster (decisions.md "Bloomvale Starter Roster").
# Each slime is an INDIVIDUAL small field spread THROUGHOUT the zone; species chosen by
# cumulative weighted hash -- meadow commonest -> honey rarest. maxAlive 1 per field,
# respawnMs staggered by tier (cozy-onboarding, B1 pattern).
SPECIES = [
  ('monster_meadow_slime', 8000, 0.50),
  ('monster_dew_slime', 9000, 0.76),      # cumulative weights (meadow .50/dew .26/blossom .16/honey .08)
  ('monster_blossom_slime', 10000, 0.92),
  ('monster_honey_slime', 12000, 1.01),
]
NPC_QUIET = [(npc['x'], npc['y'], 280) for npc in lay['npcs']]
NPC_QUIET += [(665, 610, 320), (1180, 650, 240), (1210, 480, 280), (2200, 760, 260)]
NPC_QUIET += [(1500, 780, 150), (980, 1150, 150)]  # rest-spot vignette anchors
NPC_QUIET += [(sp['x'], sp['y'], 170) for sp in lay['spawnPoints']]
SPAWNS = []
si = 0
for gx in range(300, 2400 - 280, 185):
    for gy in range(280, 1800 - 300, 185):
        if h(gx, gy, 30) < 0.10:
            continue
        x = gx + (h(gx, gy, 31) - 0.5) * 150
        y = gy + (h(gx, gy, 32) - 0.5) * 150
        if any((x - cx) ** 2 + (y - cy) ** 2 < r * r for cx, cy, r in NPC_QUIET):
            continue
        roll = h(gx, gy, 33)
        mid, ms = next((m, r) for m, r, w in SPECIES if roll < w)
        SPAWNS.append({'monsterId': mid, 'x': round(x), 'y': round(y),
                       'width': 200, 'height': 180, 'maxAlive': 1, 'respawnMs': ms,
                       'instanceId': f'monster_spawn_field_{si}'})
        si += 1
# One guaranteed Honey Slime field in the open southern arena. Honey is the rarest
# hash-weighted species (may land 0-1 times), so this pins a single reachable
# aggressive encounter for early players AND the smoke aggro check. Open ground,
# clear of keep-clear/quiet radii (checked against the collision export).
SPAWNS.append({'monsterId': 'monster_honey_slime', 'x': 1200, 'y': 1200,
               'width': 120, 'height': 100, 'maxAlive': 1, 'respawnMs': 12000,
               'instanceId': f'monster_spawn_field_{si}'})
si += 1

def clear_of(x, y, pad=0):
    return all((x - cx) ** 2 + (y - cy) ** 2 > (r + pad) ** 2 for cx, cy, r in CLEAR)

props = []
def prop(key, x, y, tag, sp=None):
    s = sp if sp is not None else spec_for('props', key)
    props.append({'instanceId': f'p_{tag}', 'assetKey': key, 'x': round(x), 'y': round(y), **s})

# --- vignettes: Bloomvale farmstead props (nautical set retired, card-bloomvale-revival) ---
SZV = {'scale': 1}
# village green (plaza keep-clear 665,610): windmill landmark + well + notice board
prop('bloomvale_windmill', 585, 505, 'windmill', SZV)
prop('bloomvale_notice_board', 770, 475, 'board', SZV)
prop('bloomvale_stone_well', 850, 705, 'well', SZV)
# barrel_plaza relocated to (500,555) in the session-20 spawn relayout (was 905,545 here /
# 576,642 in the owner Build-Mode layout) — kept in sync with the live layout for regen safety.
prop('bloomvale_water_barrel_95px', 500, 555, 'barrel_plaza', SZV)
# granary steading (keep-clear 1210,480)
prop('bloomvale_granary_facade', 1210, 465, 'granary', SZV)
prop('bloomvale_water_barrel_95px', 1080, 430, 'barrel_granary', SZV)
# east farmstead (keep-clear 2200,760): hay cart + firewood
prop('bloomvale_hay_cart_sacks', 2185, 690, 'haycart', SZV)
prop('bloomvale_firewood_pile', 2255, 860, 'firewood', SZV)
# lone treasure chest (its own keep-clear 1702,1292)
prop('bloomvale_treasure_chest_closed', 1702, 1292, 'chest', SZV)
# cozy rest-spot anchors in open field (own keep-clear circles above)
prop('bloomvale_vignette_picnic_stump', 1500, 780, 'picnic', SZV)
prop('bloomvale_vignette_mossy_log', 980, 1150, 'mossy_log', SZV)

SZ1 = {'scale': 1}

# --- perimeter tree WALL (zone-guide DoD: edges themed, never raw cutoff) ---
def wall_tree(x, y, i, tag):
    key = 'cel_conifer_tree_443px' if h(i, 7, 20) < 0.7 else 'cel_round_tree_463px'
    props.append({'instanceId': f'p_wall_{tag}_{i}', 'assetKey': key,
                  'x': round(x), 'y': round(y), **SZ1})
# north edge: Bloomvale cliff band — left cap + run segments + right cap. Props are
# BOTTOM-anchored (origin 0.5,1) so y = the rock-base line. These are 1440p-basis
# runtimes: world width = filePx/2.517 (leftcap 331, run 474, rightcap 286), world
# height 195. y=180 clips the art top slightly past the map edge; centers below give overlaps
# >=74px so no walk-in crack shows at joins (Harbor cliff crack lesson, owner walk #3).
props.append({'instanceId': 'p_cliff_left', 'assetKey': 'bloomvale_border_cliff_left_cap_195px',
              'x': 165, 'y': 180, 'scale': 1})
for ci, cx in enumerate(range(470, 2075, 400)):   # centers 470/870/1270/1670/2070 -> 5 run pieces
    props.append({'instanceId': f'p_cliff_run_{ci}', 'assetKey': 'bloomvale_border_cliff_run_195px',
                  'x': cx, 'y': 180, 'scale': 1})
props.append({'instanceId': 'p_cliff_right', 'assetKey': 'bloomvale_border_cliff_right_cap_195px',
              'x': 2257, 'y': 180, 'scale': 1})
i = 0
for x in range(-20, W + 60, 95):                      # bottom: dense staggered tree rows
    wall_tree(x + jitv(i, 5), H - 2 + jitv(i, 6), i, 's1'); i += 1
    wall_tree(x + 48 + jitv(i, 7), H - 72 + jitv(i, 8), i, 's2'); i += 1
for y in range(265, H - 60, 95):                      # left + right columns, starting BELOW the cliff band
    wall_tree(12 + jitv(i, 9), y + jitv(i, 10), i, 'w1'); i += 1
    wall_tree(84 + jitv(i, 13), y + 48 + jitv(i, 14), i, 'w2'); i += 1
    wall_tree(W - 12 + jitv(i, 11), y + jitv(i, 12), i, 'e1'); i += 1
    wall_tree(W - 84 + jitv(i, 15), y + 48 + jitv(i, 16), i, 'e2'); i += 1

# --- tree scatter: coarse grid, seeded skip/species/jitter (inset from the wall) ---
for gi, gx in enumerate(range(240, W - 200, 280)):
    for gj, gy in enumerate(range(310, H - 180, 260)):
        if h(gi, gj, 1) < 0.38:
            continue
        x = gx + (h(gi, gj, 2) - 0.5) * 180
        y = gy + (h(gi, gj, 3) - 0.5) * 160
        if not clear_of(x, y, 130):
            continue
        r = h(gi, gj, 4)
        key = ('cel_conifer_tree_443px' if r < 0.45 else
               'cel_round_tree_463px' if r < 0.75 else
               'cel_blossom_tree_463px')
        prop(key, x, y, f'tree_{gi}_{gj}', SZ1)

# --- mid scatter: shrubs / boulders / logs ---
MID = ['cel_bush_156px', 'cel_bush_156px',
       'cel_bush_156px', 'cel_bush_156px',
       'bloomvale_scatter_stone_pair_36px', 'bloomvale_scatter_stone_pair_36px']
for gi, gx in enumerate(range(260, W - 80, 340)):
    for gj, gy in enumerate(range(330, H - 60, 320)):
        if h(gi, gj, 5) < 0.35:
            continue
        x = gx + (h(gi, gj, 6) - 0.5) * 240
        y = gy + (h(gi, gj, 7) - 0.5) * 220
        if not clear_of(x, y, 100):
            continue
        key = MID[int(h(gi, gj, 8) * len(MID))]
        prop(key, x, y, f'mid_{gi}_{gj}', SZ1)

# --- floral decal scatter: fine grid (grove zone spec: scale 1, z 4) ---
decals = []
FLORA = ['bloomvale_scatter_wildflower_pink_34px', 'bloomvale_scatter_grass_tuft_a_34px',
         'bloomvale_scatter_wildflower_yellow_34px', 'bloomvale_scatter_grass_tuft_b_34px',
         'bloomvale_scatter_daisy_sprig_34px', 'bloomvale_scatter_grass_tuft_c_34px',
         'bloomvale_scatter_meadow_bells_34px', 'bloomvale_scatter_stone_flat_30px']
for gi, gx in enumerate(range(100, W - 40, 165)):
    for gj, gy in enumerate(range(270, H - 30, 160)):
        if h(gi, gj, 9) < 0.28:
            continue
        x = gx + (h(gi, gj, 10) - 0.5) * 130
        y = gy + (h(gi, gj, 11) - 0.5) * 120
        if not clear_of(x, y, 40):
            continue
        key = FLORA[int(h(gi, gj, 12) * len(FLORA))]
        decals.append({'instanceId': f'd_flora_{gi}_{gj}', 'assetKey': key,
                       'x': round(x), 'y': round(y), 'scale': 1, 'zIndex': 4, 'opacity': 1})

# --- accents: wildflower patches as ground-cover anchors (Bloomvale identity) ---
def dec(key, x, y, tag, sc, op):
    decals.append({'instanceId': f'd_{tag}', 'assetKey': key, 'x': x, 'y': y,
                   'zIndex': 1, 'scale': sc, 'opacity': op})

dec('bloomvale_vignette_wildflower_patch', 560, 700, 'patch_plaza', 1, 1)
dec('bloomvale_vignette_wildflower_patch', 1360, 980, 'patch_mid', 1, 1)
dec('bloomvale_vignette_wildflower_patch', 1900, 1320, 'patch_south', 1, 1)

# perimeter collision aligned to the VISUAL start of the border art per edge:
# north band stops feet south of the cliff base (feet reach ~210, rock base y=180);
# south is a thin BACKSTOP only — the wall trees' trunk-base collision boxes
# (placementClasses "tree") are the real barrier, so the player walks INTO the
# treeline, gets occluded by canopy, and stops at the trunks (owner walk
# 2026-07-02: stopping at canopy tops "doesn't look right"); sides stop at the
# inner canopy edge (~x=170).
ts = lay['collision']['tileSize']
# BAND_N 192 (owner walk 2026-07-03: the next tile-row stop, y242, blocked
# "well south of the visible rock").
# The cliff run art base sits at y=180 (bottom-anchored, world height 195). The band
# blocks tiles whose center < BAND_N; with the 18px foot rect that stops feet at
# (ceil(BAND_N/ts))*ts + FOOT_H. 192 -> feet stop ~y210 (30px below the rock base),
# so the player body stays in front of the face. With 32px collision tiles there is
# no intermediate stop between y210 and the rejected y242 row; moving the visual
# base north is the narrow north-edge fix.
BAND_N, BAND_S, BAND_EW = 192, 40, 165
BLOCKED = []
for tx in range(0, math.ceil(W / ts)):
    for ty in range(0, math.ceil(H / ts)):
        cx, cy = tx * ts + ts / 2, ty * ts + ts / 2
        if cx < BAND_EW or cx > W - BAND_EW or cy < BAND_N or cy > H - BAND_S:
            BLOCKED.append([tx, ty])

out = {
  'schemaVersion': 1,
  'mapId': lay['mapId'],
  'bounds': lay['bounds'],
  'ground': ground,
  'decals': decals,
  'props': props,
  'npcs': lay['npcs'],
  'monsterSpawns': SPAWNS,
  'portals': lay['portals'],
  'spawnPoints': lay['spawnPoints'],
  'collision': {'tileSize': lay['collision']['tileSize'], 'blocked': BLOCKED},
}
# Preserve the additive loot `chests` array verbatim (card-loot-chests 5f7a8161) — the
# generator does not synthesize chests, so without this a regen would silently drop them.
if lay.get('chests'):
    out['chests'] = lay['chests']
if lay.get('musicId'):
    out['musicId'] = lay['musicId']
json.dump(out, open(f'{WT}/content/zones/map_harbor_outskirts.layout.json', 'w'), indent=2)
trees = sum(1 for p in props if 'tree' in p['instanceId'])
mids = sum(1 for p in props if p['instanceId'].startswith('p_mid'))
flora = sum(1 for d in decals if d['instanceId'].startswith('d_flora'))
print(f'layout written: 1 ground region, {len(props)} props ({trees} trees, {mids} shrubs/boulders/logs), {len(decals)} decals ({flora} flora)')

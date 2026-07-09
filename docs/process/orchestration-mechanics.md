# Orchestration Mechanics (task-routed reference)

Companion to [ai-architecture.md](../architecture/ai-architecture.md) (the integrator boot core —
read THAT at session start). Load THIS doc when actually doing the act it covers: spawning/watching
lanes (§Watch), reviewing a READY lane (§Ritual, §Unions), merging (§Merge), steering (§Steers),
running a headless generation engine (§Codex), or intaking art (§Recipes, §Toolkit).

> Paths, env-var names, model slugs, and commit refs below are examples from the project this
> harness was extracted from. Replace `<primary tree>` / `<game>` / `<engine>` and any
> `<TOOL>_*_SKIP` hatch names with your project's values.

## §Watch — mechanical lane watching

Run `pnpm lanes:watch` as a background task — it watches every lane branch tip, every lanes.json
per-engine event log for turn-completed/turn-failed, and worktree appearances; prints ONE `EVENT`
line and exits 0 (the harness notifies; RE-ARM immediately after every event and after every merge).
`tools/_lanes/lanes.json` is a state-machine registry (`spawned→working→ready→merging→closed`, plus
`blocked`/`stalled`) with card path, checkbox counts, thread id, reviewed tip; corrupt JSON is a
loud watcher failure, never silently replaced. Registry writes are transactional. **Stall sweep +
heartbeat:** watchers only see progress, not absence — arm with a SHORT timeout
(`--timeout-mins 30`); the TIMEOUT exit IS the heartbeat. On every timeout wake-up run the stall
sweep: per lane, `git log master..<branch>` + `status --short` vs the card's remaining boxes; a
clean-tree lane with open boxes and no movement gets a steer/resume restating what remains — then
re-arm. Headless stalls auto-resume without owner surfacing; interactive steers need the owner's
send-click. Low-noise mode: `pnpm lanes:watch --events ready` folds mid-flight commits silently and
exits on READY changes, terminal events, stalls, rotations, worktree changes.
`EVENT context-pressure <lane> input=<n>` = rotate that thread via fresh exec before resume failure
is the first signal. Every stall sweep also checks: last event per lane == `turn.failed`/`error` →
treat as DEAD, not working. **Agent lanes** (which write no per-engine event log) are stalled on
branch+heartbeat signals instead — an agent lane whose branch tip has not moved past its baseline
AND whose `updated_at` heartbeat is older than the stall window fires an
`EVENT stall <lane> agent-lane quiet <N>min` within one sweep; the board derives a first-class
READY/WORKING/SPAWNED tail for agent lanes rather than a bare `-`.

Spawn lanes with `pnpm lane:spawn <card> --engine <engine>` (or `--engine agent` for a composed
Agent-tool prompt; `--dry-run` previews). Spawn prompts inline a generated LANE BOOT DIGEST
(a provenance-stamped extract replacing the full AGENTS.md chain; fail-closed on missing anchors;
`--no-digest` restores legacy). `lane:spawn`/`lanes:watch` write the registry → non-dry-run use is
PRIMARY-WORKTREE ONLY. lane:spawn refuses existing worktrees — resume/steer via a FRESH executor
spawn with a resume-from-card prompt (NEVER SendMessage — it inherits the parent session's model).

Operating rules: (a) watcher EXITS on first change — act, then IMMEDIATELY re-arm with baselines
reset (also after every merge / lane-set change); baseline `"none"` fires on branch CREATION.
(b) a firing is a COMMIT signal, not READY — require clean tree + READY closeout before the ritual;
mid-flight commits get acknowledged and re-armed. (c) background-subagent completions interleave with
watcher firings — both are wakeups; never busy-wait.

## §Ritual — READY verification (NEVER trust lane numbers)

**Step (0), before anything: `pnpm intake:brief <lane>`** — it measures the diff and issues a
BINDING routing verdict (DIRECT-READ vs VERIFIER-FIRST), names the spot-check targets and changed
gate surfaces, checks the closeout shape, and restates the output-filter contract (ai-architecture
Token Discipline (l)).

Scale by the card's `risk:` field: `mechanical` = closeout + gate re-run + spot-check; `standard` =
full ritual; `high` = full ritual + `pnpm lane:security-scan <branch>` + a second independent
verifier before merge (spawn it fresh, executor; never the senior model). Full order:
**(a)** closeout box-by-box against the card; **(b)** read the FULL code diff; **(c)** re-run the
applicable gate battery yourself in the lane worktree (`pnpm validate` / `test` / `build:client` /
`smoke:client` + §Recipes below). Art intake additionally re-runs the fringe/defect check on the
delivered files — lane "0 offenders" claims have been false. **[§4(c)]** any change touching
combat/skill/cast OR the HUD MUST also run the matching `capture:zone --<surface>-proof` leg —
capture proofs are the ONLY leg that exercises the real HUD→server path (a live cast regression once
shipped with every other gate green). **(d)** EYES-ON every visual proof at gameplay framing; motion
claims need multi-frame burst comparison. **[§4(d) fallback-proof-expiry]** a proof asserting a
placeholder/fallback state is valid only until the real asset exists — at art intake re-run that
surface's proof asserting the REAL asset renders. **(e)** when the lane shipped a new gate,
regression-test it against the OLD defective state. **(f)** verdict — partial verdicts normal: name
ACCEPTED vs REJECTED, bounce with a numbered paste-ready fix block ending in what must be re-proven.

`pnpm intake <lane>` one-shots commit-from-staged + gates + proof legs. It self-runs the card's
visual proof once on a `BLOCKED (visual proof)` result — a second failure is the problem to bounce.
It fails closed on: missing card `## Closeout` with ≥1 `- [x]` (loud hatch env var); missing the
required animation artifacts per staged sheet (motion-arc + identity-palette + opaque-ring verdicts
+ a `<stem>.panel.png` staged ALONGSIDE); deletions exempt. Artifact citations are read LITERALLY —
verbatim paths one per line, no globs. (Hatch env-var names are project-specific; keep them loud.)

## §Unions — parallel-feature conflict resolution (keep-both, three landmines)

Keep-both is the default for parallel-feature unions, but NEVER blanket-strip markers: (a) hunks
whose shared closing `}`/`};` sits BELOW the markers — re-add the separator/brace or you produce
invalid nesting; (b) semantic unions where both sides extend the SAME boolean condition — merge
clauses into one condition; (c) a shared trailer below the markers (dispatch if-blocks, cleanup
calls, `return`) must be DUPLICATED into both kept branches. Multi-hunk method interleaves: rebuild
the region as [full block A] [full block B] (checkout --ours + graft the other side's added methods
from its commit diff). After EVERY resolution: typecheck immediately (catches (a) instantly), then
re-run one proof mode before continuing. Card both-added conflicts (card landed on master
post-spawn): keep the lane's completed card, verify closeout boxes survive.

## §Merge — merge ritual (same turn, no gaps) + crash recovery

ONE STEP PER COMMAND — never chain destructive steps behind piped commands (`$?` after `| tail`
lies; a masked intake failure once cascaded into deleting a worktree). Record the reviewed tip;
**immediately before merging re-run `git rev-parse <branch>` and abort if it moved.** Then:
`git merge --ff-only` → push → verify `git -C <wt> status --porcelain` EMPTY and branch is ancestor
of master → `pnpm lane:close <worktree>` from the primary tree only (integrator lock; dirty
worktrees BLOCK, `--force-dirty` overrides loudly; husk sweep is explicit `--sweep` only) → delete
branch → flip card Status to MERGED + hash → update handoff board → commit docs → re-arm watcher →
KEEP DRAINING. Bank steps go through the bank API, never raw file edits under a live server.
**Owner-live dev-server rule:** a merge landing CLIENT changes while the owner's dev server is up →
kill it, delete the client's `.vite` (or equivalent) cache, detached restart, verify HTTP 200, tell
the owner to hard-refresh.

Crash recovery: (a) died mid-merge → `git status` + `git log origin/master..master`; push if ahead;
re-run `lane:close` (idempotent). (b) lanes.json lost → run `pnpm lane:recover`: it rebuilds the
roster from `git worktree list` for lane worktrees + recovers each `thread_id` from the matching
session metadata. DIFF-BEFORE-WRITE — no flag prints the diff and writes nothing; `--apply` writes
lanes.json (audit drops any entry whose branch AND worktree are both gone). (c) reboot → worktrees +
thread_ids survive, processes don't; re-arm watcher, resume each non-READY headless lane, re-spawn
agent lanes from their resume-anchor cards. (d) first occurrence of a new quota signature → capture
the event + stderr verbatim, document it.

## §Steers — content + channels

A steer answers a lane's design question as a paste-ready STEER block: fix at the source (never
compensate in data for a code bug), sibling audit at the bug site, blast radius + re-verification
list, closeout records the superseded hypothesis. Every steer's durable lesson lands in its
canonical doc SAME TURN. Channels by lane type: headless generation engine → its `exec resume`
mechanism direct (below); headless agent lane → FRESH executor spawn with a resume-from-card prompt
(SendMessage inherits the senior parent — forbidden); interactive app session → the app's
send-message channel (owner one-click); interactive headless engine → an untracked steer file in its
worktree + owner nudge (prefer fully headless to avoid).

## §Codex — headless generation-engine lane mechanics (copy-paste)

These snippets are specific to a `codex exec`-style headless CLI engine; adapt the command surface to
whatever generation/agent CLI you drive.

Spawn (background; integrator creates the worktree first):

```powershell
# once: git -C <primary tree> worktree add <primary tree>/../<game>-<lane> -b <engine>/card-<name>
<engine> exec `
  -C "<worktree>" `
  -s workspace-write `
  --json `
  -o "<worktree>/.last-message.txt" `
  "<card prompt — cite the card file; at READY: rebase, green gates, STOP>" `
  > "tools/_lanes/<lane>-events.jsonl" 2> "tools/_lanes/<lane>-stderr.txt"
```

Steer/resume (⚠️ THE trap — resume often has NO `-C` flag and does NOT reuse the original cwd;
resuming from the wrong dir writes into the wrong tree):

```powershell
Set-Location "<worktree>"   # MANDATORY
<engine> exec resume <thread_id> --json "<STEER block>"
```

Rules (as they applied to the reference engine — verify against your CLI): (a) `thread_id` = first
`thread.started` line the spawn records. (b) `-s` governs sandbox; there is no separate approval
flag. (c) model tier by risk: default for standard, a mini model + low reasoning for
`risk: mechanical`, default model + high reasoning for the hardest; trust local config + a live probe
for model slugs, never web search. (d) multi-line prompts via a prompt FILE piped in, never shell
quoting. (e) separate stdout/stderr files per lane. (f) the turn-completed event carries token usage
— cite it. (g) auth = subscription/entitlement login, never an API key where a subscription applies.
(h) resume takes a reduced flag set — override sandbox inline before the session id if needed.
(i) a restrictive sandbox can EPERM child-process spawns; auto-upgrade to full access when card gates
mention build/test/capture. (j) detached child processes may not survive — detach via the OS's
process launcher (e.g. PowerShell `Start-Process`). (k) stale `index.lock` on lane commit →
integrator deletes it (verify no live git first), lane retries. (l) thread context exhaustion =
thread dead, WORK survives — continue via a FRESH exec in the same worktree; never retry the resume.
(m) fresh worktrees DON'T inherit gitignored `.env` files — paid-generation lanes boot tokenless and
block; copy the provider `.env` from the primary tree into the lane worktree at spawn for any card
that pays a provider; never commit/print it. (n) headless imagegen bytes may arrive base64 in the
event log — recover with `pnpm imagegen:extract`; 0 events = generation failed → stop-and-surface,
never retry paid calls. (o) quota exhaustion: STOP — no retries, no new spawns, no fallback; work
survives; note reset time, continue non-engine work. (p) a resumed thread's `.last-message.txt` is
STALE (no `-o` on resume) — read the final agent message from the events log instead.

## §Recipes — integrator verification recipes

Run on every matching closeout; **numbers first, eyes second, verdict last.** These are ALSO every
lane's pre-submission bar. **NEVER trust a lane's numbers — re-measure.** The LOOK steps are never
replaced by tools. **Prefer the executable:** wrap any repeatable measurement in a tool that emits a
verdict JSON (this project's are under `tools/asset-cleanup/`); the concrete pixel/tone thresholds
are art-direction-specific and belong in your project's pipeline doc, not here.
**Technique-capture contract:** composing any measurement not already in the recipes/tools = add it
here (or the tool) the SAME turn, before the verdict; every verdict cites the recipe it ran.

Game-agnostic verification patterns (the ones worth carrying to any project):

1. **Closeout arithmetic** — category counts sum to totals; disk file count = reported moves;
   mismatch → stop, ask the lane.
2. **Stray-island / alpha-cluster check** — connected components on the alpha channel; any opaque
   cluster outside the expected content region of a transparent PNG = fail (defect gates do NOT
   catch these).
3. **Byte-identical derivation** — when an asset is claimed to be a padded/cropped copy of a master,
   verify the shared region is byte-identical and the canvas is strictly larger on both axes.
4. **In-capture position localization** — predict a screen coordinate from world coords + camera
   (`sx = W/2 + (worldX - camCenterX) * zoom`); confirm a hairline/seam at the predicted column,
   never by eyeballing alone.
5. **Before/after render comparison** — same shots + same map = deterministic captures; pixel-diff
   two runs; localize by per-column/row changed-pixel counts; a fix is proven when changes
   concentrate exactly where predicted.
6. **Relative-scale sanity (zone verdicts)** — NUMERIC, not ordinal: audit display sizes against the
   project's prop-size table; sweep EVERY framing + a full-zone pan, never a sample; off-plan
   placement and litter density are rejections even when every asset passes gates. The zone verdict
   IS the project's zone Definition-of-Done checklist judged box-by-box from captures.
7. **Animation identity (human checklist)** — extract frames and check vs the locked character
   anchor (costume cut, palette swatches, constant subject scale, weapon per the project's pin);
   back with a numeric identity-palette measure where one exists.
8. **Loop-cycle frame selection** — measured, never vibes. Settle is MEASURED (background mean drift
   below a threshold, excluding the first few pasted-seed frames); pick loop start/end at matching
   cycle peaks (breath peak for idle, alternate stride peaks for walk); match runtime slot N/fps so
   sheets drop in.
9. **Merged-lane code review** — diff (never the report), scope vs card, independent gate re-runs,
   spot-check ≥1 cited claim at file:line, capture inspection for anything visual (capture NEWER than
   last touched file). Three checks that have caught real high-risk defects:
   - **slot/container-keyed state** — for any new state keyed by a slot or container, walk EVERY
     lifecycle path (equip/unequip/swap/join/grant) and confirm each one updates it; a path that
     moves the occupant without touching the keyed state is an inheritance exploit.
   - **two writers, one key space** — when two code paths replace-then-insert DB rows selected by the
     same key columns, diff their WHERE predicates; if neither excludes the other's rows, each write
     silently destroys the other's (durable-progress loss).
   - **optimistic client transitions** — any client state change fired at INTENT-SEND time (fades,
     locks, overlays) must name its recovery path for every server denial/silence: a confirm event,
     an error handler, or a timeout watchdog; "the happy path clears it" is the permanent-black-screen
     bug.
10. **Inherited-feature check** — before rejecting a repeated feature in a derived asset, measure
    whether its SOURCE master has it at similar density; an inherited feature is not a new defect.
11. **Tone/palette adjacency & style side-by-side** — the only style gate that works is cropping the
    same region from candidate + kept reference at native res and LOOKing; numeric tone bands are a
    backstop, not a replacement. Rebuild panels from the ACTUAL files, never judge from a lane's
    supplied panel. Concrete tone/adjacency thresholds are project-specific — keep them in the
    pipeline doc.

BOUNDARY: numeric metrics catch tiling/flatness/costume-drift ONLY — geometric garble is owned by a
native-scale panel view + adversary/owner eyes-on; art intake fails closed without the required
artifacts (see §Ritual).

## §Toolkit — reusable measurement snippets

Wherever a tool implements a measurement, use the tool (its `--help` + verdict JSONs are the doc).
Three genuinely reusable, game-agnostic snippets:

Two-material piece segmentation (whole-region tone vs one master is invalid on e.g. moss+dirt edges —
segment per material, compare each side to ITS master):

```python
op = p[:,:,3] > 200
green = op & (rgb[:,:,1] > rgb[:,:,0]) & (rgb[:,:,1] > rgb[:,:,2] * 1.1)
for side, mask in (('a', green), ('b', op & ~green)):
    px = rgb[mask]; dLum = px.mean() - master.mean()   # band per side, thresholds project-specific
```

Clip frame-selection metrics (`g` = chroma-key mask per frame over `ffmpeg -vsync 0` extracts):

```python
bg = a[g].mean(axis=0)                              # per-frame; drift vs late-clip -> settle
rows = (~g).sum(axis=1); centroid = (np.arange(len(rows))*rows).sum()/rows.sum()  # breath cycle
ys = np.where((~g).any(axis=1))[0]
band = (~g)[int(ys.max()-0.25*(ys.max()-ys.min())):ys.max()+1]
xs = np.where(band.any(axis=0))[0]; legspread = xs.max()-xs.min()  # stride peaks
```

Identity-edit diff-confinement (changed pixels only inside the intended edit region; mask saved as
proof):

```python
diff = (np.abs(a - b).sum(axis=2) > 12)           # ignore compression dust
allowed = np.asarray(Image.open(MASK).convert("L")) > 128
stray = int((diff & ~allowed).sum())              # PASS: stray == 0
```

Cross-state tone: never compare category-masked means across poses — compare a FIXED anatomical box
on near-identical stance frames. Palette-parity steers: measure both sets (HSV means, hue
percentiles, quantized swatches) and steer with numbers + swatches, never adjectives.

# Cold-Boot Test Protocol

Use this protocol to prove that a fresh AI session can do useful work from a tiny context bundle.
The builder who creates or edits this protocol must not run the test in the same warmed-up session.

## Context Bundle

Give each fresh session only the canonical **Boot Order docs from [AGENTS.md](../AGENTS.md)**
(AGENTS.md itself plus the state docs it routes to, applying its own only-when-needed rules), plus
**no more than one routed doc** named by the brief, handoff, or context map.

Do not give archives by default. Opening any archive-sized doc during the probe counts as a
base-context leak unless the task explicitly routes there.

## Probe Task

Use a small, real, mechanically-verifiable task in the game's existing content style. The probe
should be authorable from the boot bundle plus one example, and its success should be a mechanical
result (`pnpm validate` exit 0), not a judgment call. Template probe:

```text
Add one new content manifest (e.g. a small consumable item) in the existing content style and make
`pnpm validate` pass. Do not implement gameplay. Do not commit. This is a throwaway probe — do NOT
update state/handoff/memory docs; the probe output is reset after the run.
```

Swap in any comparable small task with a mechanical validation result.

## Run Matrix

Run in fresh sessions with no prior project context, each with its working directory set to the
primary repo root (a wrong cwd makes glob/find look at the wrong drive):

- Fresh session of your primary model
- Fresh session of a second model/tool if available
- Fresh third model if available

Each session should record what it opened, what it changed, validation result, and anything it
needed but could not find.

## Rubric

A run passes only if:

- It stays inside the compact bundle plus no more than one routed doc unless the task explicitly
  needs more.
- It does not open archive docs by default.
- It produces a valid result for the probe task.
- `pnpm validate` exits 0, or a real blocker is stated with enough detail to reproduce.
- It does not ask for information that should have been in the compact boot bundle or routed docs.
- It leaves a concise handoff or summary of changed files and verification.

A run fails or needs investigation if:

- It opens archives without being routed there.
- It changes gameplay when the probe is manifest-only.
- It cannot find source-of-truth files that should be obvious from the bundle.
- It passes only by reading broad archives or old chat context.

## Interpreting results

Two consistent passes from independent fresh sessions are a clear signal the base is cold-bootable.
When a run stumbles, separate real doc gaps (a source-of-truth file the boot map never names) from
environment artifacts (wrong cwd). Fix real gaps in the canonical doc where a cold session would
look; never paper over drift by loosening the rubric. If two models produce byte-identical output
for the probe, the conventions are unambiguous from the bundle — the desired outcome.

## Needs Log

Append fresh-session results here. Use one entry per run.

### Run Template

```text
Date:
Model/tool:
Probe task:
Bundle provided:
Extra docs opened:
Files changed:
Validation:
Result: pass / fail / needs follow-up
Needed but missing:
Notes:
```

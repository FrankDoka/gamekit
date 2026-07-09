# AI Task Templates

Use these templates to keep AI sessions scoped and easy to review. The "Read first" lists name
state docs by role — point them at your project's concrete paths. The **context-routing map** line
is optional: it is not scaffolded by `create:game`; drop it from the list on projects that don't
keep one (see [adopting-the-harness.md](../adopting-the-harness.md) Step 2).

## Lightweight Task Card

Use this for small, single-role, single-system tasks:

```text
Role:
Goal:
Read:
Scope:
Done means:
Validation:
Handoff:
```

Use the full templates below for multi-role, cross-system, milestone, asset, release, or
review/governance work.

## Implementation Task

```text
Role:
Pipeline:
Issue/branch:
Risk: mechanical | standard | high
Goal:
Read first:
- AGENTS.md
- the cold-start state brief
- the active-session snapshot, then `git worktree list` before edits
- the context-routing map, only far enough to route this task
- durable project-memory only if history/current-state detail is needed beyond the brief
- [system docs]
Allowed scope:
- [folders/files]
Do not change:
- [folders/files]
Acceptance:
- [observable outcomes]
Validation:
- [checks/tests]
- For `risk: high`: include `pnpm lane:security-scan <branch>` output and a second independent
  verifier before merge.
Docs to update:
- [docs]
```

## Review Task

```text
Role: Reviewer / Governance
Pipeline:
Issue/branch:
Goal: Review [system/change] for bugs, drift, missing tests, and scope creep.
Read first:
- AGENTS.md
- the cold-start state brief
- the active-session snapshot, then `git worktree list` before edits
- the context-routing map, only far enough to route this task
- durable project-memory only if history/current-state detail is needed beyond the brief
- the decisions doc
- [relevant docs/source]
Focus:
- correctness
- server authority
- data contract consistency
- missing validation
- docs drift
Output:
- findings first
- open questions
- recommended fixes
```

## Asset Pipeline Task

```text
Role: Imager / Art Producer, Animation Engineer, or Audio Engineer
Pipeline: art / animation / audio
Issue/branch:
Goal:
Read first:
- AGENTS.md
- the cold-start state brief
- the active-session snapshot, then `git worktree list` before edits
- the context-routing map, only far enough to route this task
- durable project-memory only if history/current-state detail is needed beyond the brief
- the pipeline-governance doc
- relevant art/audio/animation sections
Inputs:
- asset request
- style reference
- target manifest ID
Outputs:
- source file
- processed file
- manifest entry
- validation result
- in-game test note
```

## Documentation Task

```text
Role: Manager, Orchestrator, or Reviewer / Governance
Pipeline: documentation
Issue/branch:
Goal:
Read first:
- docs/README.md
- AGENTS.md
- the cold-start state brief
- the active-session snapshot, then `git worktree list` before edits
- the context-routing map
- durable project-memory only if history/current-state detail is needed beyond the brief
Acceptance:
- docs are current
- links resolve
- future session can find the right context quickly
```

## Task IDs

Until an issue tracker exists, use temporary task IDs in this form:

```text
<prefix>-[pipeline]-[yyyymmdd]-[short-name]
```

Examples:

- `TSK-docs-<date>-contract-hardening`
- `TSK-architecture-<date>-repo-skeleton`
- `TSK-content-<date>-tutorial-manifests`
- `TSK-implementation-<date>-movement-slice`

Record active temporary tasks in the cold-start brief or resume-cursor doc when they affect current
work, and larger deferred work in a roadmap doc. Once an issue tracker exists, convert active task
IDs into real issues and preserve the ID in the issue or branch name.

## Canonical Session Handoff Template

This is the only canonical handoff template. Other docs should link here instead of redefining the
field list.

```text
Mode/Role:
Task ID:
Pipeline:
Scope:
Files touched:
Docs changed:
Validation:
Acceptance status:
Unresolved risks:
Next recommended task:
Commit/PR/reference:
```

Field rules:

- `Mode/Role`: use one mode or role from the current task card.
- `Files touched`: use `none` for read-only work.
- `Docs changed`: list docs updated, or `none`.
- `Validation`: list checks run, or explain the blocker.
- `Commit/PR/reference`: include commit hashes when committed; use `none` only when no durable
  reference exists.

For read-only review tasks, use `Files touched: none` and list findings under `Acceptance status`
or `Unresolved risks`.

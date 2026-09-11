# Standing Docs Current State Fixture

Each case records `surface`, `expected`, and a Markdown body.

## Case: blocker-standing-doc-future-contract

- surface: standing-doc
- expected: blocker

```md
# Cadence Review

Cadence will load the standing-docs current-state axis after PH-003 lands. Until
then, reviewers must manually check standing-doc wording.
```

## Case: should-fix-standing-doc-migration-note

- surface: standing-doc
- expected: should-fix

```md
# Runtime Workflow

Use the project base branch when creating task PRs.

This section is temporary during migration and should be revisited after cleanup.
```

## Case: suggestion-standing-doc-relative-wording

- surface: standing-doc
- expected: suggestion

```md
# Agent Guidance

The new guidance route reads one topic and returns the relevant instructions.
```

## Case: none-standing-doc-current-state

- surface: standing-doc
- expected: none

```md
# Cadence Review

Cadence reads the linked Linear issue, PR metadata, changed files, check status,
and current head SHA before posting a PR review.
```

## Case: none-pr-body-transition-narrative

- surface: pr-body
- expected: none

```md
## Summary

This PR adds the standing-docs axis source and fixture. PH-003 wires Cadence
loading later.
```

## Case: none-workpad-transition-narrative

- surface: workpad
- expected: none

```md
## Codex Workpad

Axis source complete. Cadence loading remains pending PH-003.
```

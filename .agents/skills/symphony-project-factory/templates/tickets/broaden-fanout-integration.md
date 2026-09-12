# Broaden fan-out integration approaches

Use only for a specific human-requested additional seed or a ticket specified
by Symphony's reviewed plan. A need for fan-out integration patterns in the
brief does not authorize this ticket at project setup.

Initial status: `Backlog`.

## Scope

Document or refine durable Symphony fan-out integration guidance for temporary
seams, isolated stubs, adapters, compatibility paths, composed validation, and
finalizer cleanup.

Do not use this ticket as a dumping ground for implementation work.

## Assumptions

- Project code: `{{project-code}}`
- Existing pattern sources: `{{existing-pattern-sources}}`
- New pattern need: `{{new-pattern-need}}`
- Cleanup owner: `{{cleanup-owner}}`

## Success Criteria

- New guidance names when the pattern is appropriate and when it is not.
- Temporary artifacts have required marker text and cleanup ownership.
- Validation expectations distinguish clean task PRs from composed validation.
- Downstream implementation tickets can cite the guidance without adding custom
  process text.

## Labels

- Linear labels: `{{linear-labels}}`
- GitHub PR labels: `{{github-pr-labels}}`

## Dependencies

No default hard dependency. If the need comes from an implementation ticket,
record that issue as sequencing context rather than a Linear blocker unless the
human asks.

## Workpad Expectations

Record sources read, patterns added or changed, downstream tickets affected, and
any rejected broader process changes.

## PR Expectations

Branch from `{{base-branch}}`, open against `{{base-branch}}`, and keep the PR
limited to durable guidance or template updates. Apply required project labels.

## Validation Expectations

- Markdown formatting passes.
- Guidance examples are internally consistent with `$SYMPHONY_TOOLING_ROOT/scripts/symphony/runtime-bundle/workflow/WORKFLOW.md`.
- Any generated template changes still include title, scope, assumptions,
  success criteria, labels, dependencies, workpad expectations, PR expectations,
  and validation expectations.

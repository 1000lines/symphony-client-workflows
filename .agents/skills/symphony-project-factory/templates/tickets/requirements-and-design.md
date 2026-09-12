# Create requirements & design doc

Create in `Backlog`. After all three planning seeds and their blocker relations
are created and verified, move all three seeds to `Active` by default. Relations hold dependents until
their predecessors are Done. Leave
it in `Backlog` only when the human explicitly requests a hold or future start.

## Scope

Read the project description and confirmed source material, then create the
canonical in-repo requirements and design document for the project under
`docs/symphony-plans/` or another human-confirmed path.

Do not create the fan-out plan, implementation tickets, or project implementation work from this ticket.

## Assumptions

- Project code: `{{project-code}}`
- Project color: `{{project-color}}`
- Base branch: `{{base-branch}}`
- Human lead: `{{human-lead}}`
- Required source documents: `{{required-source-documents}}`

## Success Criteria

- The requirements/design document records project goal, out-of-scope
  boundaries, acceptance criteria, locked decisions, material open decisions, source
  inputs read, and source inputs unavailable.
- Use available context and reasonable defaults; state material assumptions.
  Ask only when plausible answers would change scope, implementation,
  acceptance criteria, or an authorized next action, and explain which decision
  the answer changes. Do not invent observed values or evidence.
- The document is structured so the plan-project ticket can produce a fan-out
  plan with no further product judgment.
- Routine discovery, generated IDs, CI check names, compatibility tests, and
  externally supplied credentials are execution inputs or verification tasks
  with owners and only the necessary dependencies. They do not become human
  questions or block independent design work merely because values are unknown.

## Labels

- Linear labels: `{{linear-labels}}`
- GitHub PR labels for the requirements/design PR: `{{github-pr-labels}}`

## Dependencies

No default upstream dependency. If a required source is unavailable, record the
access failure and block only conclusions or actions that depend on it. Continue
independent work without guessing the source's contents; use `Human Input
Needed` when no independent work remains and access is required to proceed.

## Workpad Expectations

Keep a single Linear comment headed `## Codex Workpad`. Record the selected base
branch, source-read evidence, unavailable sources, assumptions, unresolved
questions, and validation evidence.

## PR Expectations

If the requirements/design document is committed, branch from `{{base-branch}}`
and open the PR against `{{base-branch}}`. Use branch pattern
`symphony/{{project-code}}/<ticket-id>/<free-text>`. Apply required GitHub PR
labels, including `{{project-color}}` and any project-required labels such as
`symphony`.

## Validation Expectations

- Validate repository changes **local → Docker if needed → mandatory CI**:
  run relevant tests locally and skip Docker if they pass. Use Docker only for
  local environment gaps, then always run CI on the published commit as the
  shared validation surface. Record skips; fix actionable failures before
  publishing. Follow `$SYMPHONY_TOOLING_ROOT/docs/engineering/symphony/proof-of-work.md#validation-order`.
- Markdown formatting passes for the committed document.
- The document is mechanically consumable by the plan-project ticket.
- Required source material is either read successfully or recorded as an
  explicit blocker.

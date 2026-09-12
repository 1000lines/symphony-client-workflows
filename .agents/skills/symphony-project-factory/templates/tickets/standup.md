# Standup Alpha - reality-derived project standup

Use only for a specific human-requested additional seed or a ticket specified
by Symphony's reviewed plan. A need for project monitoring in the brief does
not authorize this ticket at project setup.

Initial status: `Backlog` until the human lead promotes it and the daemon
runtime is configured for the project.

## Scope

Create and maintain one reality-derived standup for this project. On each daemon
wake, sweep this project's Linear tickets and linked GitHub PRs, rewrite the
standup file in full, record drift between claimed state and derived truth, and
take only the alpha remedial actions listed below.

This daemon ticket is the project's scrum master: it keeps the process moving by
identifying process blockers, spotting where everyone is waiting on somebody
else, naming who should move next, and using the licensed alpha actions to
re-alert that person. It does not do implementation, review, merge, or product
decision work itself.

This is a daemon ticket. Do not implement engine changes, seed standups into
other projects, merge work, close or reopen PRs, fire GitHub-to-Linear bridges,
rank the human queue by critical-path impact, adopt `Inactive` or `waiting:*`
labels, or broaden the daemon's write authority beyond the alpha actions below.

## Assumptions

- Project code: `{{project-code}}`
- Project color: `{{project-color}}`
- Base branch: `{{base-branch}}`
- Human lead: `{{human-lead}}`
- Linear labels: `{{linear-labels}}`
- GitHub PR labels: `{{github-pr-labels}}`
- Standup file: `docs/symphony-standups/{{project-code}}.md`
- Standup branch: `symphony/{{project-code}}/standup`
- Standup PR: a draft PR against `{{base-branch}}`, never merged, closed when
  the project closes

## Success Criteria

- Every wake rewrites `docs/symphony-standups/{{project-code}}.md` in full
  rather than appending.
- The standup file records the sweep timestamp, the board, drift rows, remedial
  actions taken with evidence, declined actions, and lifecycle gaps.
- The board is a single Markdown table with this schema:

| Ticket | Derived status | Whose move | Waiting on | Evidence |
| ------ | -------------- | ---------- | ---------- | -------- |

- Board rows are ordered by derived status in the vocabulary order below, then
  by ticket identifier with team keys sorted alphabetically and issue numbers
  sorted numerically.
- Board rewrites preserve unchanged row content when the derived truth and
  evidence have not changed, so standup sweeps avoid unnecessary churn.
- `Waiting on` names the actual GitHub or Linear identity, never a role, and
  links to the exact PR, review, thread, check, blocker ticket, or Linear
  surface where that identity can act.
- `Evidence` is one Markdown hyperlink to recent activity, with one or two words
  of visible link text. Do not put run IDs, comment IDs, PR numbers, or ticket
  numbers in the visible text; those details belong only inside the hyperlink
  target.
- Derived status is computed from reality, not from Linear state claims or
  stale labels.
- Drift between the Linear claim and derived truth is recorded with the claim,
  derived truth, and deciding evidence.
- Only the alpha remedial action classes below are performed.

## Derived Status Vocabulary

Use this alpha vocabulary. It amends the original seven-status proposal by
adding `Backlog`; `Done` is the terminal bucket and may include canceled or
duplicate tickets when the evidence shows those terminal states.

| Status         | Means                                                                                     | Whose move                |
| -------------- | ----------------------------------------------------------------------------------------- | ------------------------- |
| `Backlog`      | Intentionally not eligible for Symphony work                                              | Named human/project owner |
| `Blocked`      | An accepted hard prerequisite has not supplied its required result/merge                  | Another ticket            |
| `Agent`        | Implementable now, or reworking known feedback                                            | Symphony                  |
| `AI review`    | Cadence holds the ball; show `cadence-loop-N of 3`                                        | Cadence                   |
| `Human review` | A named human holds the ball                                                              | That human                |
| `CI`           | Checks are running or failed on the current head; suspected flaky failures may be retried | CI / Symphony             |
| `Merge queue`  | Approved, gates closed, awaiting the human merge action                                   | Named human               |
| `Done`         | Terminal: done, canceled, or duplicate                                                    | None                      |

If a real situation cannot be mapped to this vocabulary while still agreeing
with one of the documented lifecycles, record the gap in the standup file
instead of forcing a status.

## Derivation Inputs

For each ticket in `{{project-code}}`, gather and reconcile:

- Linear state, labels, assignee, project membership, and comments as claims to
  verify, not as derivation inputs.
- Linked PR state: open, draft, ready, merged, closed, current head SHA,
  `mergeStateStatus`, base branch, assignees, and reviewers.
- Required CI evidence: current-head required checks plus emitting App,
  workflow/event/ref, run attempt and child-job provenance. A rollup name or the
  newest run on another head does not prove passing CI.
- Reviews: latest submitted review per reviewer, review state, reviewed commit
  SHA, whether the review is stale relative to the current head, and whether
  any required approval still applies.
- Unresolved review threads, including whether each thread is outdated or still
  attached to the current diff.
- Cadence review state at the current head: reviewed SHA, verdict, matching
  workpad and review-relevant activity since the review. Record `cadence-loop-N`
  labels and the cap of three agent-only rounds; verified human-grounded
  activity resets the loop. An older approval does not establish readiness.
- `blockedBy` relations, each blocker's state, labels, and whether the blocker
  carries `mature`.

Normal human readiness requires passing required CI, a fresh current-head
review, closed mandatory feedback,
a clean task branch and a ready PR. Maturity belongs to the blocker and is
removed for request-changes, rejected/stale evidence or severe regression;
ordinary edits alone do not revoke it. An unmerged hard prerequisite still
requires its accepted landed result. Source availability is not deployment.

Treat daemon tickets according to the daemon lifecycle in
`$SYMPHONY_TOOLING_ROOT/docs/engineering/symphony/project-workflow.md` and the daemon design handoff.
A daemon may be blocked by a normal ticket; a daemon is never a blocker for a
normal ticket. If a daemon appears as a blocker, log a lifecycle gap and do not
make another ticket wait on it.

## Lifecycle References

Use the existing lifecycles rather than inventing a third state model:

- Normal tickets follow `$SYMPHONY_TOOLING_ROOT/docs/engineering/symphony/project-workflow.md` and
  `$SYMPHONY_TOOLING_ROOT/docs/engineering/review/cadence-ai-review.md`: active work, CI, Cadence
  review, human review, merge, terminal states, and documented fallbacks.
- Daemon tickets rest in daemon states, wake into the daemon dispatch state,
  evaluate, write a verdict, and return to `Happy` or `Unhappy`. Retry
  exhaustion parks the daemon back with state-only movement.

Where these docs and live repository behavior disagree, record the evidence and
the declined action in the standup file.

## Standup File

Maintain the standup file on `symphony/{{project-code}}/standup` in a draft PR
against `{{base-branch}}`. Apply `{{github-pr-labels}}`, assign
`{{human-lead}}` when the GitHub identity is known, and keep the PR open until
project close. The PR is a human-facing carrier for the board and conversation;
it is never merged.

The file must contain:

- Sweep timestamp and project metadata.
- Board table using the schema and ordering above.
- Drift list with Linear claim, derived truth, and deciding evidence.
- Remedial actions taken, each with triggering evidence and resulting surface.
- Declined actions, including out-of-scope requests, unsafe review dismissals,
  missing permissions, unmapped lifecycle cases, and ambiguous flaky-CI calls.

## Alpha Remedial Actions

The daemon may perform only these action classes.

1. Correct the Linear status to the derived lifecycle truth.

   - Use the state names and fallbacks documented in
     `$SYMPHONY_TOOLING_ROOT/docs/engineering/symphony/project-workflow.md`.
   - If a correction would hide an unsafe transition or cannot be mapped to the
     documented lifecycle, decline it and record the gap.
   - Do not rewrite labels except where a documented status correction requires
     a narrow companion update.

2. Re-request review after dismissing that reviewer's now-stale earlier review.

   - Only dismiss a review submitted against an earlier head SHA than the
     current PR head.
   - Never dismiss a review submitted against the current head.
   - Dismiss stale approvals from `example-cadence-bot` and the ticket
     owner/assignee before re-requesting review so the current head receives a
     fresh review.
   - Do not dismiss approvals from other human reviewers; those may be merge
     gates the team has already earned.
   - The dismissal message must name the current head SHA that superseded the
     stale review.
   - If dismissal is not permitted or the evidence is ambiguous, do not dismiss;
     record the declined action and evidence.

3. Retry suspected flaky CI.

   - Retry a failed current-head check or run when the evidence makes flakiness
     plausible and a retry surface is available.
   - Record the suspected flaky signal, the retried check or run, and the
     resulting evidence in the standup file.
   - If the evidence is ambiguous or retry is not available, do not retry; record
     the declined action and evidence.

The daemon still does not fire bridges, merge, close or reopen PRs, perform
project work, or promote broader label rewrites.

## Labels

- Linear labels: `{{linear-labels}}`
- GitHub PR labels for the standup PR: `{{github-pr-labels}}`
- The daemon ticket should carry one explicit `wake:*` label when the project
  runtime supports daemon wakes.

## Dependencies

No default hard blocker. The daemon may be blocked by normal tickets when a
project intentionally keeps it dormant, but the daemon is never a blocker for
another ticket.

## Workpad Expectations

Keep a single Linear comment headed `## Codex Workpad` on this daemon ticket.
Record source reads, the selected base branch, wake label, standup PR URL,
status-vocabulary decisions, sweep evidence, actions taken, declined actions,
and validation evidence.

The daemon must never write or edit a comment headed `## Symphony Workpad`.

## PR Expectations

The daemon's durable PR is the standup carrier at
`symphony/{{project-code}}/standup`, opened as a draft PR against
`{{base-branch}}`. Apply `{{github-pr-labels}}`, assign `{{human-lead}}` when
available, and close the PR at project close instead of merging it.

## Validation Expectations

- Markdown formatting passes for the rewritten standup file.
- Every board row has a one- or two-word `Evidence` hyperlink tied to the
  current Linear ticket and current PR head where a PR exists.
- Current-head CI, review staleness, unresolved threads, `cadence-loop-N`, and
  `blockedBy`/`mature` evidence are visible in the standup file.
- Remedial actions are limited to the alpha set and are logged with evidence.

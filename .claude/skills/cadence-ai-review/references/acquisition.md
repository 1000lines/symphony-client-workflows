# Acquisition, Requirement Extraction, and Assignment

Supports the Acquire, Extract, and Assign phases of the Cadence AI review skill.

## Gather per-PR evidence

Use `gh` for PR data:

- `gh pr view <n> --json title,body,baseRefName,headRefName,labels,url`
- `gh pr diff <n>` and `gh pr diff <n> --name-only` for the file list.
- `gh pr checks <n>` for a CI summary, then complete run/attempt, job and check
  evidence at the current head. Verify workflow/event/ref, emitting App and
  required child jobs; a rollup or dispatched run alone is
  insufficient. Pending/missing/failed/skipped/stale checks cannot pass.
- Fully paginated submitted reviews, conversation comments, inline threads and
  replies, plus current Linear comments and verified author permissions. Bind
  feedback IDs/update times to the reviewed head and retained workpad.
  Incomplete history requires full review; generated workpad bookkeeping cannot
  reset the agent-only three-pass cap.

To expand a label into a group:

- `gh pr list --label <label> --state open --json number` and review the
  resulting set as the group.

## Find the Linear issue for acquisition (read-only)

- Use the target config's `linear.teamKey` in the PR title prefix. Fall back to the
  branch name, then the PR body.
- Read the issue with `node scripts/fetch-linear-issue.mjs <identifier>`, which
  returns the description, acceptance criteria, comments, and project as Markdown
  using `LINEAR_API_TOKEN`. This helper is for acquisition only: do not use it to
  write comments or change state.
- Cadence's normal review-state write is the single comment headed
  `## Cadence Workpad` through the helper after synthesis. That workpad
  write is not part of acquisition. See [`linear.md`](./linear.md).
- If a separate Linear comment is ever needed for another issue or explicit
  human handoff, keep it exceptional and scoped; do not use acquisition as a
  backdoor writer and do not mutate issue state, labels, assignees, relations,
  or project metadata.

## Find design and requirement docs

- Extract Google Doc URLs (`docs.google.com/document/d/<id>`) and other
  requirement links from the Linear issue descriptions and the PR bodies.
- Fetch each Google Doc with `node scripts/fetch-google-doc.mjs <url-or-id>`,
  which exports it as Markdown using the service-account credentials in
  `GOOGLE_APPLICATION_CREDENTIALS` (or `GOOGLE_SA_KEY`). The doc must be shared
  with the service-account email. The design/requirement doc is the source of
  truth for intent as amended by later clear human repository-writer decisions;
  acceptance criteria derive from that revised intent. Read those decisions
  from submitted reviews, conversation comments and current issue context, and
  record their source and superseded criteria. The human need not first edit
  the document or seek the original design owner's approval.
- If a referenced doc cannot be read, record a `human-needed` finding naming the
  doc. Do not guess its contents.

## Extract requirements

- From the acceptance criteria and design docs, derive a discrete list of
  testable requirements for the group.
- Assign each a stable ID `REQ-<project>-<n>`, ordered by appearance in the
  source doc so IDs stay stable across reruns.
- Each requirement is a one-line statement plus its source (doc section or AC).
- Keep the full extracted requirement list and source mapping for the Cadence
  workpad. Only include requirement detail in the GitHub-visible review when a
  concise blocker or human-needed assessment depends on it.

## Assign requirements to PRs

- For each requirement, identify the PR(s) in the group whose diff is intended to
  satisfy it, using the PR/ticket scope, changed files, and diff behavior.
- Mark each requirement `covered`, `partial`, or `unassigned`.
- Record the requirement-to-PR mapping. It feeds the workpad coverage table and
  the cross-PR gap review.

## Special PRs in the group

A PR may carry a role label:

- `plan`: treat its body and diff as a derived requirements/assignment source — a
  decomposition of the design doc into the stack. The plan is **not** ground
  truth: the design doc plus subsequent human repository-writer decisions
  establish current intent, and the plan may
  under-cover the doc or diverge from the actual implementation. Use the plan to
  seed the requirement→PR assignment, then verify coverage against the design
  doc. Review the plan PR for plan↔doc coverage, not code nits.
- `integration`: treat as the convergence/finalizer step where cross-PR seams
  close. Anchor seam findings there and review whether it completes the stack.

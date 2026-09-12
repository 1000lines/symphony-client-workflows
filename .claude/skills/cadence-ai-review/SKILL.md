---
name: cadence-ai-review
description: Review a group of opt-in Symphony PRs against their Linear acceptance criteria and linked design docs. Fan out review axes per PR plus cross-PR coverage and seam checks, write detailed review state to one Linear Cadence workpad, then return the incremental workpad assessment for the workflow-owned editable PR comment.
---

# Cadence AI Review

Normal human handoff requires passing required CI and a fresh review of the
current head, closed mandatory feedback, a clean task branch and ready PR.
Record the reviewed SHA, verdict and matching workpad, and inspect incoming
human feedback before publication. Blocker-side `mature` follows those
conditions; remove it for request-changes, rejected/stale evidence or severe
regression, not ordinary edits alone. Human acceptance owns Done. See the
[shared contract](../../../docs/engineering/review/cadence-ai-review.md#acceptance-contract).

Use this skill to review a group of opt-in Symphony PRs before human review. The
review reads evidence, records detailed state in the Linear `## Cadence Workpad`,
and returns an incremental workpad assessment: APPROVE when the PR has no
blocker or human-needed findings, otherwise COMMENT. It never submits the formal
GitHub `REQUEST_CHANGES` event, edits application code, or mutates arbitrary
Linear issue state. The Linear workpad may still record a request-changes
disposition as Cadence's review opinion.

The unit of review is a **group** of PRs evaluated against a shared set of
requirements. A single PR is a group of one.

## Boundaries

- Return the existing incremental `reviewUpdate` JSON to the file named by the
  workflow. Do not submit GitHub reviews, inline comments or conversation
  comments. The workflow persists the workpad and edits one App-owned comment;
  clean approval additionally creates a bodyless APPROVE record.
- Treat Cadence as an advisory reviewer, not a hard merge gate. The skill emits
  review assessments and workpad state, not repository protection or Linear
  workflow outcomes.
- Read Linear issue context through the read-only acquisition path. The Cadence
  workpad helper is the primary Cadence Linear write path for review state:
  write the single Linear issue comment headed `## Cadence Workpad` through it.
  Do not create ad hoc Linear comments as a substitute for the workpad, and
  never change Linear issue state, labels, assignees, relations, or project
  metadata. See [`references/linear.md`](./references/linear.md).
- Do not edit application code.
- Do not expose private machine paths, local workspace paths, credentials,
  tokens, API keys, customer data, or other secrets in any comment.
- Do not post raw per-axis dumps, full requirement matrices, run state, skipped
  event detail, or AI-to-AI scratchpad detail to the PR. Put that detail in the
  Cadence workpad payload and return the concise assessment for publication.

## Sources Of Truth And Judgment

There is no fixed ground truth, and the reviewer's job is to triangulate intent
with skill and judgment — not to defer to any single source.

- Requirements drift. The design doc and ACs are the best available statement of
  intent, not gospel; a demo or conversation can change them mid-stack. Treat
  them as current-best, and flag where they look stale or internally inconsistent.
- A human with verified write access to the target repository can change its
  design. Their clear instruction supersedes the affected accepted decisions
  and execution contract without approval from a separate design owner,
  original author, PM, or project lead. Minute the source and revised criteria
  in the Cadence workpad; Symphony amends the plan/tickets and implements.
  Review against that revised intent. AI disagreement alone is not a blocker
  or a `human-needed` finding. Still identify concrete defects in the resulting
  implementation; do not confuse those with a preference for the old design.
  Keep material technical objections concise in the editable PR assessment so they remain
  findable with the merged change; Symphony includes accepted tradeoffs in the
  PR body. Recording disagreement does not require another approval round.
- AI-authored artifacts are peers, not authorities. The `plan` PR and the code
  under review were written by an AI agent that is as likely to be wrong as this
  reviewer. Never treat plan-adherence or authorship as evidence of correctness.
- When a material choice is unresolved, human directions conflict, or needed
  access is unavailable, name that exact gap. An older document contradicting
  a clear instruction from a human repository writer is resolved by the newer
  instruction, not by another design-owner approval. Establish unknown write
  access through repository permission evidence; do not require a special team
  or title as a substitute.

## Inputs

The group is selected one of two ways:

- An explicit list of PR numbers.
- A PR label. Expand the label to the set of open PRs that carry it, then review
  that set as the group.

## Required Sources To Read

Read these before producing review output. Acquisition mechanics are in
[`references/acquisition.md`](./references/acquisition.md).

Per PR:

- PR title, body, base branch, head SHA, changed files, diff, labels, CI status.
- The associated Linear issue. Use the target config's `linear.teamKey` in the PR title
  prefix, then fall back to the branch or body. Read its description, acceptance
  criteria, and comments through the acquisition helper. **Read-only during
  acquisition.**

For the group:

- Design or requirement docs linked from the Linear issues or PR bodies,
  including Google Docs. Read their content. Treat the design/requirement doc as
  the current baseline for intent, amended by subsequent decisions from human
  repository writers; derive acceptance criteria from that revised intent.

If a required source is missing or cannot be read (no ACs, an unreadable design
doc), record a `human-needed` finding that names the missing evidence. Do not
guess its contents.

## Review Pipeline

- **Acquire** — gather per-PR evidence and the shared design/requirement docs.
  See [`references/acquisition.md`](./references/acquisition.md).
- **Challenge the approach** — before detailed conformance, compare the ticket
  with the current human outcome and feedback. Ask whether the work should
  exist in this form and whether an existing mechanism could satisfy it more
  simply. Estimate conformance and exact file ownership do not prove a good
  design. For a concrete contradiction or unjustified complexity, record the
  evidence and classify the needed remedy: implementation replacement,
  partial replan, or full replan. Use the existing finding classes and advisory
  output rules. First check whether a human repository writer has already made
  the decision. If judgment is still needed, name the decision and stop
  dependent axis work rather than exhaustively reviewing a rejected approach.
  Do not invent a new requirement or block solely on line count.
- **Extract requirements** — derive a discrete, stably-ID'd requirement list for
  the group from the ACs and design docs.
- **Assign requirements to PRs** — build a coverage matrix mapping each
  requirement to the PR(s) expected to satisfy it. Mark each requirement
  `covered`, `partial`, or `unassigned`.
- **Per-PR axis review (fan out)** — for each PR, run bounded review passes
  across the review-agent methodology axes. Always cover reviewability, scope
  coherence, test/evidence, backward compatibility, and architecture fit. Add
  conditional axes when the diff justifies them.
- **Standing-docs current-state axis** — for docs/process PRs that touch
  workflow docs, agent instructions, checked-in skills, runtime-bundle docs, or
  standing operational docs, load
  `scripts/symphony/runtime-bundle/review-axes/standing-docs-current-state.md`
  as an additional review axis.
- **Cross-PR gap review (fan out)** — one or two reviewers over the whole group.
  See [`references/cross-pr-gap-review.md`](./references/cross-pr-gap-review.md).
- **Synthesize** — deduplicate findings semantically across axes and reviewers.
  Produce one concise GitHub-visible assessment per PR and the detailed workpad
  state.
- **Record workpad** — write the detailed state to the associated Linear issue's
  `## Cadence Workpad` through the helper. See
  [`references/linear.md`](./references/linear.md).
- **Return** — incremental workpad JSON for workflow publication. See Output.

## Fan-out

- Prefer one subagent per per-PR axis so passes are independent. Do not run an
  axis with no basis in the diff; that produces noise, not findings.
- Requirements and design PRs use this `cadence-ai-review` skill plus relevant
  methodology and standing-docs axes. Do not select the UI-focused
  `.claude/skills/design-review/SKILL.md` for process requirements or design
  review.
- The cross-PR gap review is one or two reviewers operating over the full set,
  not over a single PR's internals.
- A reviewer may raise an adjacent concern only when it is evidence-backed and
  not a duplicate of another axis.
- Workers return findings and the assessment. The workflow alone publishes
  after identity preflight (see Output).

## Finding IDs

Use stable IDs that survive follow-up agent handoffs:

- Requirements: `REQ-<project>-<n>` — ordered by appearance in the source doc so
  IDs stay stable across reruns.
- Per-PR axis findings: `AR-<issue-id>-<axis-slug>-F<n>`.
- Cross-PR findings: `AR-<project>-coverage-F<n>`, `AR-<project>-seam-F<n>`,
  `AR-<project>-split-F<n>`.

Reuse the same ID when restating, deduplicating, or verifying the same concern.

## Finding Classes And Follow-Up

Classify each finding using the review-agent methodology: `blocker`,
`should-fix`, `suggestion`, or `human-needed`. The presence of any `blocker` or
`human-needed` finding makes the review a `COMMENT`; their absence allows an
`APPROVE`. The skill emits no workflow state outcome.

Record the current overall disposition in the Linear workpad. For open mandatory
follow-up, prefer an explicit workpad disposition such as `request changes` or
`human-needed` so Symphony can tell what action remains. This is a Linear-side
review opinion; it does not change the GitHub event rule above, and Cadence must
return disposition `COMMENT`; it must not submit a formal review.

Treat `blocker` and `human-needed` findings as mandatory follow-up. Treat
`should-fix` and `suggestion` findings as non-blocking Cadence notes unless a
human reviewer or the Linear issue explicitly accepts them as required work. In
GitHub-visible text, label non-blocking follow-up plainly and keep the full
evidence and same-class detail in the Cadence workpad.

## Output

Cadence has two output surfaces with different audiences:

- **Linear `## Cadence Workpad`** — detailed review state for Symphony and future
  Cadence runs.
- **Editable GitHub PR comment** — the only human-facing assessment, with status,
  verdict, findings and measured footer. The workflow owns all publication.

Write the existing incremental payload to the workflow's specified result file.
`reviewUpdate` must contain `lastReviewedSha`, `disposition` (`APPROVE` or
`COMMENT`), `summary`, `githubAssessmentSummary` (at most 1400 characters),
`requirements`, `humanFeedback`, and `findings` with stable IDs, class, status and
summary. Carry unresolved findings forward. `APPROVE` requires no open mandatory,
blocker or human-needed findings. Put the concise assessment and at most three
key findings in `githubAssessmentSummary`; retain full detail in the workpad.
Do not estimate model, duration or tokens; the workflow collects measurements.

The workflow validates the current head and selected provider's success, writes
and reads back the workpad, persists the assessment on the existing App check,
and edits the stable comment. It calls the existing Linear/human handoff directly.
A bodyless APPROVE record preserves the existing approval timeline; COMMENT
records and narrative reviews are no longer published. Historical reviews remain.
Missing results, failed persistence and stale heads cannot produce clean approval.

### Linear Workpad Detail

For each linked Linear issue, prepare the payload for the workflow to update
one `## Cadence Workpad` through `scripts/cadence-linear-workpad.mjs`. Use the incremental
`reviewUpdate` input shape documented in
`docs/engineering/review/cadence-linear-workpad.md`: each workpad write is an
increment on the prior persisted review object, not a free-form replacement.
Include the concise GitHub-visible assessment summary plus the detailed state
that should not live on the PR:

- run status, trigger source, review decision, head SHA, last-reviewed SHA and
  timestamp, current disposition, prior/pending rerun state, and skipped or
  ignored events;
- requirement extraction, assignment, full coverage matrix, and per-requirement
  status updates by stable requirement ID;
- per-axis findings, cross-PR findings, deduplication notes, evidence,
  lifecycle, class, status, and smallest safe actions by stable finding ID;
- new human input and human-feedback learning notes, including mandatory
  same-class follow-up and optional/nice-to-have follow-up;
- for replanning, the triggering human source, superseded decision/criteria,
  affected ticket(s), and whether the node boundary still holds; assess the
  replacement against the revised intent, not stale criteria or an old head;
- AI-to-AI coordination details that help Symphony continue the work but would
  distract human PR reviewers.

### GitHub-Visible Assessment Format

Keep `githubAssessmentSummary` short and useful to a human reviewer. Do not include the
full coverage table or raw scratchpad detail.

Use these shapes:

```md
Assessment: Approve

Why this is acceptable:
<one to three sentences explaining the evidence-backed reason the PR is ready
for human review.>

Non-blocking notes:

- <optional concise should-fix or suggestion, explicitly labeled non-blocking>
```

```md
Assessment: Blocked

Required follow-up:

- `<finding-id>`: <concise blocker and smallest safe action>

Why this matters:
<one or two sentences with the human-readable risk or requirement gap.>

Non-blocking notes:

- <optional concise note, explicitly labeled non-blocking>
```

```md
Assessment: Human input needed

Decision needed:

- `<finding-id>`: <specific product, technical, credential, or scope question>

Why Cadence cannot decide:
<one or two sentences naming the missing authority or evidence.>

Non-blocking notes:

- <optional concise note, explicitly labeled non-blocking>
```

For group reviews, put the detailed requirement coverage table (`REQ` → owning
PR(s) → `covered`/`partial`/`unassigned`) in the Cadence workpad. The
GitHub-visible comment may summarize coverage in one or two sentences only when
it helps the human reviewer understand the assessment.

Include file/line references in the assessment or detailed workpad findings;
never publish inline comments or additional review messages. Do not expose
secrets or private paths.

### Identity and publication

The trusted workflow verifies its minted installation token is scoped to the
caller repository and derives the expected App login from its minted slug.
Providers return data; the workflow alone persists and publishes it. Never
switch to a saved GitHub login or another credential. Missing App identity,
installation access or Linear credentials fails publication.

## Re-review And Idempotency

When invoked on a PR you have reviewed before, do not blindly review again. Run
`node scripts/fetch-pr-review-state.mjs <pr>` and act on its `decision`:

- `first-review` — no prior review by the bot; review the whole PR (normal flow).
- `skip` — you reviewed at `lastReview.oid` and nothing has changed since (no
  commits, comments, or other reviews). Post nothing; record the skipped run in
  the Cadence workpad.
- `incremental` — there is new activity in `since`. Review only the delta
  (`lastReview.oid..headRefOid`) and read the new comments/replies. Reconcile
  your prior findings by their stable `AR-…` ID: mark each resolved, still-open,
  or superseded — and verify a fix in the code, since a reply claiming "fixed"
  is a fallible peer claim. Add new findings only for the delta, then re-decide
  the event (APPROVE if no open `blocker`/`human-needed` remain).
- `full-review-rebased` — the head was force-pushed since your review, so the
  incremental base is unreliable; review the whole PR again.
- `full-review-paged-out` — your prior review is older than the timeline window;
  fall back to a full review and note it.

`since` items are typed (commit / comment / review / force-push / draft
transitions), carry actor and timestamp, and exclude the bot's own activity.
Do not infer complete feedback from this helper alone. Acquire submitted review
summaries, top-level comments, inline threads/replies and Linear comments with
full pagination and current author permission evidence. Missing history requires
full review and prevents a fresh acceptance claim. Generated workpad bookkeeping
does not reset the agent-only three-pass cap. Put review-state detail such as skipped,
ignored, non-human, and pending follow-up events in the Cadence workpad unless a
concise GitHub-visible assessment needs to mention them.

## Learn From Human Reviews

Read the human reviewer comments on the PR and its linked issue. When a human
comment directly identifies required rework, treat that human feedback as
authoritative input for Symphony. Cadence mediation is not required before
Symphony can act on it, and Cadence adding nothing to a human review is
acceptable.

When human feedback reveals the same class of issue elsewhere in the PR, a
reviewer-facing documentation gap, or a broader expectation that remains within
the Linear issue's scope, Cadence may add human-grounded follow-up:

- Mark it mandatory only when it is directly grounded in the human feedback and
  needed to resolve the same issue class, reviewer clarity gap, or in-scope
  requirement gap. Route mandatory follow-up as `blocker` or `human-needed` and
  put enough detail in the workpad for Symphony to perform the Linear-driven
  rework.
- Mark it non-blocking when it is optional, nice-to-have, speculative, or beyond
  the current issue's required outcome. Route it as `should-fix` or
  `suggestion`, label it non-blocking in GitHub if mentioned there, and keep the
  detailed rationale in the workpad.

When a human comment implies an architectural or design principle that should
have been followed but was not, consider whether documenting that principle in an
appropriately scoped `CLAUDE.md` and/or `AGENTS.md` (and the review docs when it
is a review axis) is mandatory same-class follow-up or an optional learning note.
Cite the human comment as evidence in the workpad. The goal is a
self-improving loop: a lesson a human had to point out once becomes durable
guidance instead of a recurring catch.

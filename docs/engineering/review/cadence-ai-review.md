# Cadence AI Review Automation

Cadence AI Review is the mandatory automation lane for Symphony-managed PRs.
The normal gate is the shared `symphony` label; PR-open and synchronize events
from `example-symphony-bot` to its own open PR may run before that label is applied
so the open-then-label race does not drop the first bot-authored update. Cadence reviews
the PR against its Linear acceptance criteria and linked design docs before human
review. Its automated scope is Symphony-managed PRs. It is separate from
ordinary human PR review and from the general review-agent methodology.

The review logic lives in the `cadence-ai-review` skill
(`.claude/skills/cadence-ai-review/`). The GitHub workflows provision
credentials and run Claude Code against that skill. Cadence writes detailed
review state to one Linear comment headed `## Cadence Workpad`, then posts one
concise GitHub PR review per completed pass (`APPROVE` when clean, otherwise `COMMENT`;
never `REQUEST_CHANGES`).

## Acceptance contract

Normal human handoff requires passing required CI and a fresh Cadence review of
the current PR head, a closed mandatory-feedback ledger, a clean task branch,
and a PR marked ready from draft. The Claude runner publishes `APPROVE` when
there are no blocker or human-needed findings, otherwise `COMMENT`. Record the
reviewer, reviewed SHA, verdict and matching Cadence workpad. Human approval and
merge own final acceptance; Cadence approval does not replace required human
branch-protection approval.

Read the required CI checks from the target's selected-base `.symphony.cfg.json`
and branch rules. Verify the current head, workflow/event/ref, emitting App,
applicable run attempts and required child jobs. Missing, ambiguous, pending,
stale, failed, canceled, timed-out or skipped results do not pass. Routing and
review jobs do not implicitly become required product CI.

The timeline helper reports `fresh-approval` or `stale-approval`; a changed head
or review-relevant activity after approval requires another review. Read human
feedback across submitted reviews, conversation comments, inline threads/replies
and Linear comments. Incomplete timeline history requires a full review.
Preserve stable finding IDs and workpad history, and close mandatory feedback
before handoff. Agent-only review loops stop after three passes; verified
human-grounded activity can reset the loop, while generated bookkeeping cannot.
A cap or human-needed finding requires a concrete human handoff, not a clean
acceptance claim.

Apply `mature` to the blocker only at normal readiness. Remove it for
request-changes, rejected or stale acceptance evidence, or a similarly severe
regression that makes dependent work unsafe. Ordinary edits alone do not revoke
maturity. Source availability does not prove installation or live execution;
record those refs and results separately.

## PR Actor Flow

Symphony implements and reworks issues in `Active`. Pending CI waits in
`Unhappy` with `wake:15m`; Cadence review, human review and missing input wait
in `Inactive`. The diagram names
actor phases; those phases are not additional required Linear states.

```mermaid
stateDiagram-v2
  state "Human review (Inactive)" as HumanReview
  state "Missing input (Inactive)" as InputNeeded

  [*] --> HumanDefinesWork
  HumanDefinesWork --> SymphonyImplements
  SymphonyImplements --> CadenceReviewsCurrentHead: PR opened or Symphony push
  CadenceReviewsCurrentHead --> SymphonyReworks: COMMENT with actionable follow-up
  CadenceReviewsCurrentHead --> InputNeeded: COMMENT with missing decision
  CadenceReviewsCurrentHead --> HumanReview: APPROVE or no actionable findings
  SymphonyReworks --> CadenceReviewsCurrentHead: fix pushed
  InputNeeded --> SymphonyReworks: input resolved
  HumanReview --> CadenceReviewsCurrentHead: comment or approval with notes
  HumanReview --> Merging: human approval and required gates closed
  Merging --> Done: human or merge automation updates Linear
  Done --> [*]
```

The [project workflow](../symphony/project-workflow.md) defines current-team
fallbacks. The DEMO team has `Active` and `Inactive`; review bridges use legacy
`Rework` only on teams missing `Active`. Human or accepted merge automation owns
the terminal `Done` transition.

| Phase                       | Owner                     | Responsibility                                                                                                                                       |
| --------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HumanDefinesWork`          | Human                     | Defines the Linear issue, scope, acceptance criteria, and reviewer expectations.                                                                     |
| `SymphonyImplements`        | Symphony                  | Branches from the selected base, implements the issue, records evidence in `## Codex Workpad`, opens or updates the PR, and asks Cadence for review. |
| `CadenceReviewsCurrentHead` | Cadence                   | Reviews the current PR head, writes durable state to `## Cadence Workpad`, and posts a concise `APPROVE` or `COMMENT` PR review.                     |
| `SymphonyReworks`           | Symphony                  | Handles actionable Cadence or human feedback, pushes the smallest appropriate fix, and sends the updated head back through Cadence.                  |
| Missing input               | Human or agent            | Supplies a missing decision, credential, source, or environment detail before Symphony can continue.                                                 |
| Human review                | Human                     | Uses the PR, Cadence review, and workpads to decide merge readiness. A comment without approval is de facto a request for more work.                 |
| `Merging`                   | Human or merge automation | Merges the PR after human approval and required checks/review gates are closed.                                                                      |
| `Done`                      | Human or merge automation | Moves the linked Linear ticket to `Done` after accepted work is complete.                                                                            |

### GitHub Review Handoff Contract

The next actor should be visible through GitHub events wherever possible,
rather than through hidden Symphony or Cadence-only decisions:

- Symphony PR opens, Symphony commits, human PR comments, human PR reviews,
  inline review comments, and ready-for-review events call the existing reviewer
  after the router verifies eligibility and the original feedback author's write
  permission. The Actions run shows queued, running and completed review work.
- A `pull_request_target.review_requested` event whose requested reviewer is
  `example-cadence-bot` invokes the single-PR Cadence review workflow. Review
  requests for other reviewers do not invoke Cadence.
- Cadence posts an `APPROVE` PR review when the current head has no blocker or
  human-needed findings. The Cadence review-submitted workflow then requests
  human review from the PR assignee. If no eligible PR assignee exists, it
  records a visible routing gap instead of requesting a broad human team.
- Cadence posts a `COMMENT` PR review when the current head has actionable
  findings or needs human input. The `cadence-linear-rework.yml` workflow moves
  the linked Linear issue to `Active` for actionable findings and requests
  eligible human PR assignees for human-needed findings. A human-review request
  leaves Linear state unchanged; Symphony records missing decisions in its
  workpad and waits in `Inactive`.
- Human non-approved review summaries with content, `CHANGES_REQUESTED`
  reviews, and nonempty top-level PR comments also wake the linked issue
  directly. Human `APPROVED` reviews do not directly wake Linear, but still
  run Cadence so a human approval with notes receives a Cadence re-look.
- Human reviewers own final merge readiness. Cadence approval is advisory and
  does not satisfy branch-protection human approval requirements.

## Dispatch And PR Selection

The event bridge and manual PR matrix both call
[the existing reviewer](../../../.github/workflows/cadence-ai-review-trigger.yml)
through GitHub's native `workflow_call`. Normal routing does not remove and
re-add a bot review request. The reviewer already reads current PR state, runs
Claude, updates its workpad and applies its existing review cap and handoff.

Events first run the secret-free `cadence-review-ingress.yml`. Its JSON title
contains selectors, never authority. The `workflow_run` consumers execute on
trusted `main`, read current PR/feedback through `actions/github-script`, and
verify the original author's write permission. A failed or denied router cannot
start the dependent review job. Keep `cadence-controller` restricted to `main`.

The reusable call retains the caller's event and actor. GitHub-identified bot
initiators may enter the provider's bot allowlist; humans still pass the provider's
independent write-permission check. Reviews use the configured publishing
credential. Both callers use `secrets: inherit`: explicit mappings left the
protected environment key empty in live reusable runs, matching
[actions/runner#4453](https://github.com/actions/runner/issues/4453).
Inheritance exposes repository secrets to the trusted reviewer; its main-only
`cadence-controller` environment supplies the signing key. Keep the key there,
not in repository secrets or job outputs.
See [GitHub's reusable workflow secret rules](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows#using-inputs-and-secrets-in-a-reusable-workflow).
Manual calls and legacy review requests
retain their existing actor checks. All review execution requires `refs/heads/main`.

GitHub's repository/PR concurrency group keeps one active review and one pending
review (`queue: single`). New arrivals replace intermediate pending jobs without
cancelling the running review. The surviving job reacquires the current PR and
all changes/feedback since the last posted Cadence review; it must not review only
its triggering event. Feedback stays in GitHub even when its queued job is cancelled.
Short admission/publication and Linear handoff queues retain every event.
Closing or merging a PR cancels that group. Review planning also checks that the
PR is still open, so delayed events cannot restart it. Unchanged
duplicate events may still cause another review. The reviewer reacquires
current state; its outcome verifier rejects missing or stale-head reviews.

### Advisory check and human handoff

The reusable reviewer creates `Cadence review` using the configured Cadence
App and its existing `checks:write` grant. Admission captures the actual PR head
and publishes a queued check before entering the long review queue. Starting
the review changes it to in-progress. A new accepted request gets a separate
check, including feedback on the same head; the workflow run, attempt and PR
identify it. Retrying the same admission does not reset a completed check.

Publication requires a new Cadence verdict after this request started, at its
accepted head. A clean approval with a successful handoff (or an already-ready
PR) yields `success`; findings or a review-loop stop yield `action_required`.
Failed execution or a missing new verdict yields
`failure`. Closed PRs, changed heads and requests superseded by newer accepted
work are cancelled. Check summaries link the workflow and, when available, the
review. Older requests cannot overwrite a newer request's pending check.

A clean current-head verdict marks a draft PR ready for human review when no
newer accepted request exists. Already-ready PRs need no transition; findings
leave a draft unchanged. Admission and final publication share a short native
per-PR concurrency group; review execution uses its existing separate queue.
The final job uses a fresh Cadence App token for PR/review reads and check
publication (`pull-requests:read`, `checks:write`). A separate API client uses
the repository's automatic `GITHUB_TOKEN` for `markPullRequestReadyForReview`.
The finish job requests `contents:write` and `pull-requests:write`; the event
and manual reusable-workflow callers must permit both, since a callee cannot
increase its caller's permissions. Other jobs retain their narrower grants.
The privileged finish job runs only on trusted `main`, checks out `main`
without persisted credentials, and rechecks the head before readying a draft.
It does not execute PR code, write contents, change workflows, or merge.
The shared Cadence App does not need an additional grant or credential.

A denied or unconfirmed ready mutation completes the advisory check as
`failure`, retains the clean review link, and fails publication with “Review
approved; marking ready failed” in the check and Actions summary. The diagnostic
links the failed operation's workflow attempt and includes the API error.
Completion recovery preserves that summary; it does not infer an approval from
older reviews when no verified verdict was recorded.
It never falls back to a different actor or
claims a ready handoff without GitHub confirming `isDraft: false`. The operator
should check the finish job and caller permission blocks, then the job log's
effective `GITHUB_TOKEN Permissions`. After correcting access, rerun **all** jobs
to acquire a new guarded verdict; rerunning only publication cannot revive a
completed check. Keep the shared App grants unchanged.

[PR #34's publication job](https://github.com/1000lines/symphony-example/actions/runs/34612573918/job/103307363013)
demonstrates that the Cadence App's `pull-requests:write` and `checks:write`
token was denied with GraphQL `FORBIDDEN`. GitHub documents that PR authors and
repository writers can [change the PR stage](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/changing-the-stage-of-a-pull-request);
PR write alone is not sufficient evidence of that capability. The repository
workflow's proposed contents-write grant still requires live verification on
the deployed workflow; local fixtures do not establish GitHub authorization.

For rollout, record the deployed main SHA, actual draft PR/head, fresh Cadence
review, Actions actor/effective grants, mutation result and completed advisory
check. Exercise the denied case with contents read and PR write, then the same
operation with the finish job's grants. Confirm findings, a superseded same-head
request, changed head and closed PR never become ready. Preserve the protected
environment's main-only policy; a PR checkout is not deployment evidence.

GitHub does not offer a head-conditional draft-to-ready mutation, so a
push concurrent with that last API call remains a platform race; its own check
and review still belong to the new head.

Admission uploads a small recovery pointer **before** creating the check. The
`cadence-review-check-cleanup.yml` completion listener uses it to terminate any
check left pending by cancellation, timeout or failed finalization, including
cancelled queued jobs and heads removed by force-push. It never turns incomplete
execution green or changes a completed verdict. Recovery needs the existing
App credential and GitHub API availability; a failed cleanup run requires an
operator rerun. Rerun all jobs to admit a fresh review attempt; rerunning only
failed jobs does not reset a completed advisory check.

This check is advisory. It is excluded from `CI Required`, repository required
checks and automatic merge gates. Required CI and its Linear wakeups keep their
existing configuration; human approval and merge remain separate decisions.
The client Copier extraction/adoption must carry these reusable jobs, cleanup
workflow and helper with the existing App credentials, without another question,
secret or opt-in setting. The cleanup workflow must be active on the trusted
default branch before claiming live cancellation recovery.

Manual `cadence-ai-review.yml` accepts `pr_numbers` (comma/space separated),
`review_label`, or both, then calls the reviewer once per selected PR. Direct
single-PR dispatch and `review_requested` remain compatibility entry points.
The stale-approval fallback runs inside the reviewer.

CI wakeups and `cadence-linear-rework.yml` keep their existing responsibilities.
There is no second CI evaluator, Linear state machine or human-invitation engine.
Review execution uses Claude. Deployment evidence includes an authorized
feedback event, an unauthorized author, and a manual selection, with Actions
links and actual handoff results. Local tests do not prove live environment
admission or provider execution.

## Automated Triggers And Manual Fallbacks

Automated Cadence review is label-gated and actor-gated:

- A human-facing PR comment, PR review, inline review comment, or
  ready-for-review event can call Cadence when the PR has the
  `symphony` label.
- A review request targeting `example-cadence-bot` invokes the single-PR trigger
  workflow. Non-Cadence reviewer requests do not invoke Cadence.
- A `pull_request_target.opened` or `pull_request_target.synchronize` event from
  `example-symphony-bot` to its own open PR can request Cadence review so Cadence
  reviews new Symphony PRs and commits; the label gate is waived only for this
  bot-authored open/update request path.
- Cadence, Claude, dependency bots, generic `[bot]` actors, closed PRs,
  non-Symphony PRs, and PRs without the `symphony` label outside the bot
  open/update race do not queue review. The router records the reason in the
  Actions summary.
- Human feedback enters the same Cadence/Symphony review loop regardless of
  GitHub review state. Humans do not need to use GitHub's formal
  `CHANGES_REQUESTED` review state; a human comment without approval is de
  facto a request for more work until Cadence re-looks and the next actor is
  explicit.
- Cadence review loop labels (`cadence-loop-N`) are advanced by the single-PR
  workflow. Human-grounded activity resets the next run to `cadence-loop-1`;
  agent-only continuation stops at the configured cap and requests review from
  the PR assignee with the concrete reason in the Cadence workpad. When
  Symphony and Cadence are quiescent with no review-relevant changes, the
  workflow requests the assigned human next actor instead of asking Symphony to
  retry without an action. If there is no eligible PR assignee, the workflow
  records a visible routing gap rather than falling back to a broad human team.

Manual fallbacks remain part of the contract. A human can dispatch the manual
group workflow to re-request Cadence, use the single-PR trigger's direct
dispatch as a break-glass retry, or route Linear state manually when a
credential, team-lookup, or issue-linking problem prevents the automation from
making an authoritative decision.

## Required Configuration

Set these values in Settings → Secrets and variables → Actions → Secrets.
Required when using the workflow that consumes them; there are no credential
defaults. All values come from adopter-owned accounts. Never commit them.

Human feedback routing and the single-PR review trigger require the protected
`cadence-controller` Environment's `CADENCE_APP_ID` variable and
`CADENCE_APP_PRIVATE_KEY` secret. See the
[App permission requirements](./github-actor-classification.md#app-installation-and-rollout).

Repository secrets:

- `CADENCE_AI_REVIEW_ANTHROPIC_API_KEY`: Claude API key for the review.
- `CADENCE_LINEAR_API_TOKEN`: Linear API token used by
  `scripts/fetch-linear-issue.mjs` to read issue context, by
  `scripts/cadence-linear-workpad.mjs` to write the Cadence workpad, and by the
  review workflow when optional Linear-side Cadence state can be written.
- `GOOGLE_SA_KEY`: a Google service-account JSON key. Staged to a file and read
  by `scripts/fetch-google-doc.mjs` to export linked design docs.

- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`: the AWS access-key ID and
  paired secret used only by the host AMI workflow. Supply a principal authorized
  to inspect images in the configured account. These are separate from Cadence's
  review credentials and from the host's AWS Secrets Manager JSON bundles.

Set repository variables in Settings → Secrets and variables → Actions →
Variables. Identity values must name the accounts behind the supplied tokens:

- `SYMPHONY_BOT_USER`: coding bot GitHub login. Required for live attribution;
  synthetic fallback `example-symphony-bot`.
- `CADENCE_REVIEWER`: legacy review-request login and actor exclusion;
  synthetic fallback `example-cadence-bot`. Publishing identity is derived from
  the minted App, independently of this compatibility setting.
- `SYMPHONY_REPOSITORY_OWNER`: GitHub organization slug used for team lookup.
  Optional in workflows (default: `github.repository_owner`); export it for
  standalone helpers, whose fallback `example-org` is synthetic.
- `CADENCE_GIT_EMAIL`: review bot commit email for the AMI workflow. Required
  for real attribution; synthetic fallback `example-cadence-bot@users.noreply.github.com`.
- `AWS_ACCOUNT_ID`: 12 decimal digits identifying the host account. Required
  for the AMI workflow; no default.
- `SYMPHONY_HUMAN_LEAD`: GitHub login to assign AMI update PRs. Optional; default:
  unset (no assignee).

Review model variable:

- `CADENCE_CLAUDE_MODEL`: required Claude model for the review. The trigger
  preflight approves `claude-opus-5` for the Opus 5 review requirement and fails
  before Claude runs when the variable is unset or points to an unapproved
  model.

## Identities

- **Review App**: the configured Cadence App authors reviews with a short-lived,
  single-repository installation token. The trusted token Action's `app-slug`
  determines `CADENCE_REVIEWER_LOGIN` (`<app-slug>[bot]`) for Claude, verification,
  advisory results and Linear handoff. Native review requires no
  `CADENCE_BOT_GITHUB_TOKEN`; manual PR-list reads use `GITHUB_TOKEN`.
  The review token requests metadata, contents and Actions read plus
  pull-requests, issues and checks write from the existing App installation.
  Draft readiness uses the separate repository `GITHUB_TOKEN`.
- **Google service account**: its own `<service-account>@<project>.iam.gserviceaccount.com` email reads
  design docs. Share each doc, folder, or shared drive with that email as
  Viewer. This is a distinct identity from the GitHub bot.
- **Linear API token**: reads ticket context and writes the Cadence workpad.

## Actor Authority

For design decisions, a human with verified repository write access is
authorized to amend accepted designs and execution contracts. No separate
design-owner, project-lead, or team ratification is required. Record the decision
and superseded criteria in the workpad; Symphony updates the affected artifacts
and implements and commits. A stale design document or contrary AI preference
is not a missing human decision. See the
[replanning guide](../symphony/replanning.md#human-design-authority).

Actor classification below identifies humans and bots for event routing; it
does not reserve design authority to a named human or team. If event delivery
excludes a verified human writer, report that as a routing configuration gap,
not a requirement for a design owner to decide again.

Cadence and Symphony use the
[GitHub Actor Classification](./github-actor-classification.md) contract to
identify human-facing, AI, dependency-bot, and unknown activity. Classification
alone does not authorize work. The event router and review handoff verify the
current content author and effective repository write access through GitHub's
permission API before human feedback can request review or wake Symphony.
Read, triage, missing, malformed, and unavailable permission evidence is denied.
The check covers summaries, conversation comments, inline comments, and edits;
no sender, team, allowlist, association, or prose substitutes for permission.

Verified human writers can supply rework and design decisions directly, without
another design-owner approval. GitHub feedback acquired for later review stays
marked untrusted unless its author's current access passes the same check.
Unknown and bot content cannot reset the human review loop.

## What It Reads

For each PR: title, body, base, head SHA, changed files, diff, labels, CI status
(via `gh`). The associated Linear issue's description, acceptance criteria, and
comments (via `scripts/fetch-linear-issue.mjs`, read-only). Design and
requirement docs linked from the Linear issue or PR body, including Google Docs
(via `scripts/fetch-google-doc.mjs`).

Cadence reads the `## Codex Workpad` when a re-review needs Symphony execution
context, such as claimed fixes, validation evidence, deferred decisions, or
human feedback already handled by the coding agent. It reads that workpad as
input only; Cadence does not edit Symphony's workpad.

Both acquisition helpers are dependency-free and run with bare `node` locally
and on the runner, so the review reads the same way in both environments.
For docs/process PRs that touch workflow docs, agent instructions, checked-in
skills, runtime-bundle docs, or standing operational docs, Cadence also loads
`scripts/symphony/runtime-bundle/review-axes/standing-docs-current-state.md`.
Process requirements and design PRs use `cadence-ai-review`; the UI-focused
`.claude/skills/design-review/SKILL.md` skill is not the process reviewer.

## Output

Cadence has two output surfaces with different audiences:

- **Linear `## Cadence Workpad`**: detailed review state for Symphony and future
  Cadence runs, written through the
  [Cadence Linear Workpad](./cadence-linear-workpad.md) helper.
- **GitHub PR review**: concise human-readable assessment for PR reviewers.

The Linear workpad owns run status, trigger source, review decision, head SHA,
last-reviewed SHA and timestamp, prior or pending rerun state, skipped or
ignored events, requirement coverage, detailed findings, human-feedback learning
notes, and AI-to-AI coordination.

Symphony treats the Linear workpad as Cadence's durable handoff. Before
performing Cadence-driven rework, deciding that no Cadence action remains, or
summarizing review state for a human, Symphony should read the current
`## Cadence Workpad` instead of reconstructing Cadence state from GitHub review
text alone.

The GitHub review owns the concise assessment for the reviewed head, with the
reviewed SHA and workpad link. Each completed pass explains why the PR is
acceptable, blocked, or needs human input. Earlier reviews remain in GitHub
history; the single Linear workpad is updated in place.
Line-specific findings may use inline review comments when the exact location
helps a human reviewer act. Raw coverage tables, skipped-event detail, and
scratchpad reasoning stay on Linear.

The review event is chosen by findings: `APPROVE` when the PR has no `blocker`
and no `human-needed` findings, otherwise `COMMENT`. `REQUEST_CHANGES` is never
used. Posting output as PR reviews (not plain conversation comments) keeps the
event surface `pull_request_review`.

Cadence's App approval is advisory; the project still requires human acceptance
before merge. It does not authorize automatic merge or replace required CI.

Reviews are submitted from one verified context. The trusted workflow verifies
its installation token is scoped to the target and derives the expected bot
login from the token Action's App slug. In a fan-out, workers return review bodies
and the orchestrator publishes using that token. Installation tokens use
`GET /installation/repositories` for access preflight, not the user-token-only
`GET /user` endpoint. Missing identity or access aborts publication. The outcome
verifier accepts only `APPROVED` or `COMMENTED` reviews from that App at the
current head; advisory publication also requires a new verdict after admission.

## Human Review And Follow-Up Routing

Cadence is advisory. Human reviewers and the project human lead own final review
judgment, priority, and merge readiness. The automated human handoff requests
eligible PR assignees only. It does not
fall back to the Linear issue assignee, project lead, or a broad human team.
If none is eligible, it records a routing gap in Linear for manual handling.

Verified human-writer feedback is authoritative Symphony input. Symphony can act on direct human
GitHub review feedback without waiting for Cadence to restate it. Cadence should
still receive post-human-review events and re-look unless the state fetch shows
the current Cadence review is still fresh. Cadence adding no findings is
expressed as an `APPROVE` review and `## Cadence Workpad` handoff, not as silent
retry pressure on Symphony.

`pull_request_target` workflow definitions are evaluated from the repository's
default branch. A PR that changes the Cadence review-request trigger cannot
fully dogfood that new trigger until the workflow lands on `main`; use the
workflow's static tests and, if needed, a break-glass manual dispatch to validate
the new trigger before merge.

When human feedback reveals the same class of issue elsewhere in the PR, a
reviewer-facing documentation gap, or an in-scope requirement gap, Cadence may
record human-grounded follow-up:

- **Mandatory follow-up** is directly grounded in human feedback and needed to
  resolve the same issue class, reviewer clarity gap, or in-scope requirement
  gap. Route it as `blocker` or `human-needed`, and put enough evidence in the
  Linear workpad for Symphony to perform Linear-driven rework.
- **Optional follow-up** is nice-to-have, speculative, or beyond the current
  issue's required outcome. Route it as `should-fix` or `suggestion`, label it
  non-blocking if mentioned on GitHub, and keep the detailed rationale in the
  workpad.

The single-PR workflow tracks Cadence review loops with `cadence-loop-N` labels
and a current cap of 3. Agent-to-agent continuation stops before runner
allocation when a Symphony push arrives on a PR already carrying
`cadence-loop-3`; the trigger workflow keeps the same cap as defense in depth
for direct and matrix invocations. Human comments and reviews always route
through and reset the loop back to `cadence-loop-1`.

### Accepted feedback acknowledgement

After the event router accepts eligible feedback and verifies the author's
current repository write access, the configured Cadence App adds 👀 to that
item. This means “seen and accepted for processing”; it does not indicate
approval or completion. The acknowledgement runs in the routing job, before
the reusable review job waits in its per-PR concurrency queue. Ignored and
unauthorized events receive no acknowledgement.

The workflow uses GitHub's native
[`addReaction` mutation](https://docs.github.com/en/graphql/reference/reactions#addreaction)
with `EYES` and the verified item's node ID. It supports PR conversation
comments (`IssueComment`), submitted review bodies
([`PullRequestReview`](https://docs.github.com/en/graphql/reference/pulls#pullrequestreview))
and inline review comments (`PullRequestReviewComment`), including accepted
edits. A submitted review body is a `Reactable` node; the REST review-comment
reactions endpoint addresses inline comments, not that body. No fallback
conversation comment is needed. Repeated delivery adds the same App reaction
instead of toggling or creating another acknowledgement. API failures produce
a step warning and run summary without preventing the queued review.

The existing `cadence-controller` App token requests `issues: write` and
`pull_requests: write` for the target repository; the routing job's automatic
GitHub token remains read-only. No new credential is required. Because routing
loads the default branch, live acceptance follows deployment to `main`: while
a review is running, submit an authorized conversation comment and review,
verify each item's Cadence 👀 and the queued run, then rerun the routing job
and verify one reaction per item from that App. Retain the item URLs, routing
run summaries/reaction IDs and queue timestamps; also verify ignored or
unauthorized feedback receives no reaction. Local fixtures do not establish
that live evidence.

## Request-Changes Enforcement

Three layers keep `REQUEST_CHANGES` off:

1. The skill restricts the event to `APPROVE` or `COMMENT`.
2. The workflow appends a system prompt repeating that constraint.
3. A post-run audit step (`Block request-changes reviews`) dismisses any
   `CHANGES_REQUESTED` review authored by the bot on a target PR and fails the
   job.

## Linear Write-Back

Cadence writes detailed review state only to the single Linear issue comment
headed `## Cadence Workpad`. It does not create ad hoc Linear comments and does
not edit `## Codex Workpad`.

The `## Codex Workpad` remains Symphony-owned execution state. Cadence may read
it during re-review to understand Symphony's latest reasoning and evidence, but
any Cadence assessment, skipped-event detail, rerun state, or AI coordination
must be written back to `## Cadence Workpad` or the concise GitHub PR review as
described above.

The Cadence review skill and event/trigger workflows do not change Linear issue
labels, assignees, relations, or project metadata. `cadence-linear-rework.yml`
is the narrow review state-transition companion. It wakes `Active` for
actionable Cadence output, nonempty human PR conversation comments, non-approved
human review bodies, and human changes-requested reviews after verifying human
writer permission. It requires an open,
Symphony-authored PR with the `symphony` label. Human approvals do not directly
wake Linear. Clean Cadence approval and human-needed findings request eligible
PR assignees without changing Linear state. Symphony owns the `Inactive` wait
and records the current checks and next actor.

The shared wakeup helper prefers `Active`, uses only `Rework` as a legacy
fallback, and fails when neither exists. It preserves `Done`, `Canceled`,
`Cancelled`, `Duplicate`, and terminal Linear categories. The review bridge
pins a writable Cadence workpad and re-reads issue state before waking. It
records actual state/mutation results, actor, reason, PR/head, event id, and run
URL in `coordination.reviewHandoff` and the workflow summary. Independent writers
are not atomic; skipped or failed writes are reported rather than treated as
confirmed transitions.

The [non-review bridge](../symphony/project-workflow.md#github-event-bridges)
shares those wakeup semantics for required-check failures, merge conflicts, and
issue-scoped workflow completions. If Cadence cannot identify the linked Linear
issue or lacks the required Linear token for an optional workpad write, it
reports that visibly instead of guessing.

For a dispatched workflow on a `symphony/` branch, adopters may set their
workflow's top-level `run-name` to begin with `[linear:<issue>] `, followed by a
description. The marker must contain one valid issue identifier and a trailing
space after the closing bracket. This optional marker identifies the issue when
the completion payload has no dispatch inputs or linked PR; it takes precedence
over the PR title and branch. Without it, the bridge resolves the PR title, then
the branch, and rejects missing or ambiguous identity. The extraction supplies
the consumer only; adopters choose whether their own workflows produce this
marker. A marker does not enable completion routing from a non-Symphony branch.

## Slack

Slack notifications are deferred. This workflow does not reference Slack secrets
and does not send Slack messages.

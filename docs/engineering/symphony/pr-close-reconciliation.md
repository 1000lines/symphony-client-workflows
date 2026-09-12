# Reconcile Linear when a PR closes

The existing `cadence-ai-review-trigger.yml` receives `pull_request_target.closed`
(including merges), directly here and through the client template's reusable
caller. Its independent `reconcile-closed` job runs ordinary JavaScript without
a model, provider credential, review gate, or PR-author/label restriction. Closing
still cancels the PR's pending Cadence review through the separate existing job.

The job reads `.symphony.cfg.json` from the caller's current default branch and
uses its Linear team. Helpers are checked out from the trusted shared repository
at `helpers-ref` (normally `main`), never from the PR. No PR code executes.

## Decision and association rules

1. Fetch the triggering PR from GitHub, then paginate Linear's
   `attachmentsForURL` to resolve its issue. If no attachment exists yet, use the
   current `[TEAM-N]` title prefix or branch identifier. Conflicting hints,
   multiple linked issues, missing identity, or a configured-team mismatch stop
   the transition and report the reason.
2. Paginate that issue's attachments, normalize GitHub PR URLs, deduplicate by
   repository/number, and include the triggering PR even when it is not yet
   attached. Unrelated document/commit/issue links are ignored. Malformed PR
   links and unsupported PR hosts fail closed. Associations mean current Linear
   attachments plus the trigger; this does not discover references which Linear
   has not indexed yet or infer PRs from prose/comments.
3. Fetch every PR's current state and explicit `merged` boolean through GitHub's
   PR API, including other repositories. Any open PR leaves the ticket alone.
   All closed with any merged selects Done; all closed with none merged selects
   Canceled (or the team's spelling Cancelled).
4. Resolve the unique matching state ID and category from the actual team's
   paginated workflow states. Never choose a global ID or an arbitrary terminal
   category. A currently matching state is a no-op.

Missing pages, repeated cursors, malformed data, lookup limits (100 pages per
connection), denied requests, and unavailable PRs all prevent an inferred terminal
write. The Actions log and summary retain the evaluated PRs, issue, previous and
confirmed target state, attempts, mutation confirmation, reason, actor, config
revision, and run URL/attempt. The handler does not edit an agent's Linear workpad.

## Concurrency and existing automation

On September 12, 2026, API inspection confirmed the 1000lines Linear workspace
has a GitHub integration. Team 100 maps `start` to Active, `review` to Inactive,
and `merge` to Done, with no branch-specific overrides in those returned records.
These settings are observation, not hardcoded configuration. Linear's native
[GitHub status automation](https://linear.app/docs/github#link-multiple-issues)
already handles multiple PRs but documents waiting for the final linked PR to
reach its configured state. This handler additionally specifies the mixed
merged/abandoned and all-abandoned outcomes required by 100-109. Existing Symphony
CI/review wakeup bridges preserve terminal states; this acceptance handler owns
the explicit Done/Canceled reconciliation based on all associated PRs.

The job shares the repository's `symphony-linear-wakeups` concurrency group with
CI/conflict writes, with cancellation disabled and `queue: max`. It compares two
fresh full snapshots, then re-reads Linear state and `updatedAt` immediately before
a write. Detected changes restart association and PR lookup, up to three attempts.
After one write attempt, a full readback confirms the outcome, including when a
lost response may have hidden a successful mutation. A conflicting readback is
reported without further writes or rollback. Rerunning a close workflow evaluates
the current world again, including a reopened triggering PR.

GitHub concurrency is repository-scoped. It does not lock other repositories,
Linear's native integration, human edits, or association indexing. Linear's issue
mutation has no compare-and-set precondition, and GitHub/Linear reads are not an
atomic snapshot. Changes in the final read/write gap or after readback can still
win. This job does not continuously enforce status or reopen tickets when an open
PR is found. On exhausted contention or an unavailable lookup, inspect the reported
reason and rerun the close workflow after it settles; do not blindly toggle the
status. Queue overflow/canceled jobs and delayed association indexing likewise
need a rerun. Perfect distributed serialization is not claimed.

## Permissions, rollout, and evidence

The close job needs only `GITHUB_TOKEN` with contents/PR read permissions, and the
already-forwarded `CADENCE_LINEAR_API_TOKEN` with issue/attachment/team/state reads
and issue-state writes. No App token or provider is used by this job. The existing
reusable entry point still declares its review secrets for its other jobs.
Public cross-repository PR reads use the same GitHub token; private repositories
outside its access cause a visible failure and no terminal write. The code does
not mint broader tokens or assume inaccessible repositories are closed.

Existing clients consuming the shared trigger and helpers from `main` receive
this behavior on their next close event after merge; no new template caller is
needed. The caller must already be installed/enabled on the client's default
branch. GitHub's
[`pull_request_target` behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target)
means a PR's changed workflow is not a pre-merge live listener. Do not close an
unapproved implementation PR for testing. Its approved merge can supply follow-up
evidence if the installed workflow/helper revision receives the event; otherwise
use a subsequent approved close event or rerun after deployment.

`node --test .github/workflows/scripts/symphony-pr-close.test.mjs` exercises the
decision matrix, pagination/deduplication/cross-repository reads, current-state
guards, ambiguous and incomplete input, duplicate events, native-integration
overlap, bounded contention, uncertain mutation readback, and the actual YAML
JavaScript step with fixture APIs. `npm test` is the repository CI contract.
These fixtures validate wiring and permission declarations, not secret grants,
live event delivery, or a production terminal transition. Retain the real close
run summary and Linear state readback as follow-up evidence. The commissioned
issue explicitly permits that live gap before approval/merge.

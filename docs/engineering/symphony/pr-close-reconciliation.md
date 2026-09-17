# Reconcile Linear when a PR closes

The existing `cadence-ai-review-trigger.yml` receives `pull_request_target.closed`
(including merges), directly here and through the client template's reusable
caller. Unless the caller opts out, its independent `reconcile-closed` job runs ordinary JavaScript without
a model, provider credential, review gate, or PR-author/label restriction. Closing
still cancels the PR's pending Cadence review through the separate existing job.

The job reads `.symphony.cfg.json` from the caller's current default branch and
uses its Linear team. Helpers are checked out from the trusted shared repository
at `helpers-ref` (normally `main`), never from the PR. No PR code executes.

## Caller-owned acceptance

The reusable manual (`cadence-ai-review.yml`), events
(`cadence-ai-review-events.yml`) and trigger (`cadence-ai-review-trigger.yml`)
entry points accept optional boolean `reconcile-pr-close`, default `true`.
Manual/events forward it to the trigger; false skips `reconcile-closed` before
any checkout, configuration read or Linear access. `cancel-closed` remains
independent and still cancels pending review work. Native provider events and
existing callers that omit the input retain their current behavior.

orc-app must set `reconcile-pr-close: false` on all three callers. Its human or
accepted external automation owns Done/Canceled; merging shared source does not
confer acceptance authority. The opt-out does not alter native Linear automation,
CI/review routing, or other clients' policy. It is a trusted workflow input, not
a new `.symphony.cfg.json` field. See the [exact caller wiring and release
handoff](../../../README.md#external-acceptance-authority-and-pinned-callers).

The provider uses `toJSON(inputs.reconcile-pr-close) != 'false'` to distinguish
an explicit boolean false from the absent input on native events. A truthy
fallback (`input || true`) would discard the opt-out; a loose comparison with
boolean false would also treat native empty input as false. Fixtures exercise
both native defaults and all reusable forwarding paths. The decision rules below
apply only when reconciliation is enabled.

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

The summary names `updated`, `unchanged`, `skipped`, or `failed` explicitly.
`updated` includes a mutation request and readback; `mutation.acknowledged`
distinguishes an accepted API response from an ambiguous transport result whose
target state was subsequently observed. Readback alone cannot identify the writer.
`unchanged` / `already-correct` makes no mutation and is not automatic-closure proof.
`skipped` records why no terminal write was appropriate (including exhausted
contention); `failed` fails the job. Inspect this job independently of
`cancel-closed`, which can still be queued after reconciliation finishes.

`timeline` retains each attempt's initial and verification snapshots, final issue
version, retry reason, mutation acknowledgement and readback, with timestamps.
`startedAt`, `completedAt`, and `durationMs` measure the helper; `eventClosedAt`
and `eventToCompletionMs` measure close-to-result latency, including scheduling
and setup. The latter is not necessarily time to a state transition. `helperSha`
identifies the checked-out helper; the run's reusable-workflow revision and
`configurationSha` identify the other inputs. No PR bodies or credentials are
included in the snapshot trace.

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
this behavior on their next close event after merge unless opted out; no new
template caller is needed for the default. Pinned clients select a reviewed
workflow revision and matching `helpers-ref` before activation. The caller must already be installed/enabled on the client's default
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

## Investigation: 100-107 / pytest-memray PR #8

The [reported test](https://linear.app/1000lines/issue/100-115) did **not** prove
automatic closure. Jeremy confirmed that he manually moved 100-107 to Done.
The handler subsequently returned `unchanged` / `already-correct`, attempt 2,
without a mutation. It consumed workflow and helper
`0c7deb90ed3b82a2019ed1982e983b0edcf62e6b`, which already contained PR #16's
handler; this was not a stale-client rollout.

Observed September 12, 2026 UTC, from the [close job log and run](https://github.com/jeremycarroll/pytest-memray/actions/runs/34715518895/job/103611929236),
[PR #8](https://github.com/jeremycarroll/pytest-memray/pull/8), and Linear issue history:

| Event | UTC time | Elapsed since merge |
| --- | --- | --- |
| PR #8 merged | 19:54:17 | 0 s |
| Close workflow created | 19:54:23 | 6 s |
| Reconciliation job started (Jobs API) | 19:54:35 | 18 s |
| Reconciliation script step began (includes config reads) | 19:54:37.777 | 20.777 s |
| Jeremy's Inactive → Done history entry | 19:54:45.878 | 28.878 s |
| Handler logged `already-correct`, no mutation | 19:54:51.360 | 34.360 s |
| Reconciliation job completed (Jobs API) | 19:54:53 | 36 s |
| Independent cancel-closed job started | 19:59:27 | 310 s |
| Entire close workflow completed | 19:59:33 | 316 s |

The handler was still processing when Jeremy intervened, about 8.1 seconds after
the script step started and 5.5 seconds before its result. Revision `0c7deb9`
reaches attempt 2 only when its two full snapshots differ or the final Linear
issue re-read differs. It has no retry sleep; those attempts repeat API reads.
An open associated PR or lookup failure on attempt 1 would have returned, and
a mutation attempt would have returned or failed without entering attempt 2.
Thus the observed run retried a detected change before any mutation.

The original log contains neither initial snapshot nor retry reason/timestamps,
so it cannot establish which comparison changed, its initial state/associations,
or whether that change was Jeremy's edit. His edit is a plausible competing
write, not a proven cause of that particular retry. History has one state
transition in this window (Jeremy's manual change) and a separate actorless
entry at 19:54:46.038 with no state transition. Current attachments contain only
PR #8; they do not reconstruct historical snapshots. Native team automation still
maps merge to Done, but its internal processing/retry timing is unavailable.
There is no evidence here of another state writer reversing an automatic close.

The [review event failure](https://github.com/jeremycarroll/pytest-memray/actions/runs/34715515951/job/103611921453)
and [review handoff failure](https://github.com/jeremycarroll/pytest-memray/actions/runs/34715511482/job/103611910187)
both hit the resolver's open-PR assertion after closure. Neither gates the
independent reconciliation job. The nearby CI wakeup run's mutation job started
at 19:54:55, after reconciliation; the long cancel-closed wait also did not gate it.

No permanent closure defect or normal end-to-end automatic latency is established
by this interrupted observation. Deterministic fixtures now cover both possible
retry sites: a concurrent Done edit yields no write; a nonterminal edit retries
and the handler completes automatically. With no competing edit, an Inactive
fixture reaches Done with one acknowledged mutation/readback. Its 1,500 ms is
**synthetic** (100 ms per fixture API call), not production latency. The closure
decision and three-attempt concurrency safeguards remain unchanged; the added
trace makes a future failure diagnosable.

Live proof belongs to [100-117](https://linear.app/1000lines/issue/100-117) after
[100-116](https://linear.app/1000lines/issue/100-116) provisions the dedicated test
repository. Preserve single merged, single abandoned, any open, all closed with
a merge, all abandoned, deduplication/repeated delivery, and delayed review-event
cases. Use fixture issues and PRs, observe through job completion without manual
status edits, and retain revisions, timing, mutation acknowledgement and API/history
readbacks. No original issue was changed, workflow rerun, PR merged, or runtime
deployed during this investigation. Live proof remains follow-up, not this fix's
merge prerequisite.

# Symphony client workflows

Shared GitHub workflows and helpers for Symphony clients, published on the moving
`alpha` branch. Development uses `main`.

The reusable entry points are:

- `.github/workflows/symphony-client-commands.yml` — run client build/test commands.
- `.github/workflows/symphony-linear-wakeups.yml` — forward CI state and merge conflicts to Linear.
- `.github/workflows/cadence-ai-review-trigger.yml` — review one PR.
- `.github/workflows/cadence-ai-review-events.yml` — route verified ingress feedback to review.
- `.github/workflows/cadence-ai-review.yml` — manually select a PR group.
- `.github/workflows/cadence-linear-rework.yml` — route reviews to Linear or humans.
- `.github/workflows/cadence-review-check-cleanup.yml` — recover unfinished checks.

Use `1000lines/symphony-client-workflows/.github/workflows/<file>@alpha` or a
reviewed commit. For Cadence, pass the same revision as `helpers-ref`; helpers
always come from this shared repository, while GitHub API reads and publication
target the caller. Keep `cadence-controller` restricted to the client's default
branch. Ingress is a secret-free native workflow rendered by the client template.

Review callers explicitly pass `CADENCE_APP_PRIVATE_KEY`,
`CADENCE_LINEAR_API_TOKEN`, `CADENCE_OPENAI_API_KEY`, and
`CADENCE_AI_REVIEW_ANTHROPIC_API_KEY`. Both provider secrets are individually
optional: OpenAI only or both selects Codex; Anthropic only selects Claude;
neither fails before checkout or review work. `CADENCE_OPENAI_API_KEY` maps to
`openai/codex-action` input `openai-api-key`. A selected provider's authentication
failure fails the review without fallback. Both providers use the same Cadence
App identity, review outcome verification, advisory check and Linear handoff.

Keep named secrets at repository scope or organization scope selected for the
client, explicitly forwarding them at every reusable hop; do not use
`secrets: inherit` or shadow forwarded credentials with environment secrets.
Handoff needs App/Linear secrets, cleanup only the App key, and ingress none.
See the [review configuration](docs/engineering/review/cadence-ai-review.md#required-configuration).

## Development

```sh
npm ci
npm test
```

[Publication provenance](PROVENANCE.md) · [Review guide](docs/engineering/review/cadence-ai-review.md)

## Merge conflict wakeups

The reusable `symphony-linear-wakeups.yml` accepts the generated caller's
`pull_request_target`, default-branch `push`, and `schedule` events. Push scans
select open Symphony PRs targeting the pushed branch. Scheduled recovery checks
all open Symphony PRs every 15 minutes, including nondefault bases. GitHub may
return unknown mergeability while computing it; a later scan retries without
waking or consuming a receipt. The CI path yields conflicted PRs to the conflict
bridge. Unknown mergeability during CI evaluation or its final PR recheck puts
waiting issues in `Unhappy` with `wake:15m`; the existing Symphony timer rechecks
the PR and CI even if no further GitHub check event arrives.

Only the explicitly mapped `CADENCE_LINEAR_API_TOKEN` is required. It needs
Linear issue/team/project read access, Cadence workpad writes and issue state
updates. Its actual owner is recorded, without a synthetic display-name gate.
`GITHUB_TOKEN` reads PRs and trusted default-branch config; the reusable workflow
retains its Actions/checks/contents/PR/status read permissions. Keep
`helpers-repository` and `helpers-ref` fixed to reviewed shared code, never the
PR head. No target PR code executes with this credential.

The bridge rechecks open/unmerged status, same-repository ownership, head/base,
conflict and the configured team's issue association before Active (legacy
Rework) transition. Project metadata/color guards and terminal-state protection
remain. Active and parked Backlog work are left alone; recovery can wake a
worker that subsequently becomes Inactive. Workpad receipts per repository/PR
head survive short event-history rotation, suppressing unchanged conflicts even
as the base advances. A new head is eligible again. Linear writes are not atomic
with GitHub reads; failed final evidence writes are surfaced and retried once.
Keep the workflow's repository concurrency group when adopting it.

Publish accepted shared code to `alpha` before activating the updated generated
caller on a client's default branch. Enable Actions and scheduled workflows;
GitHub may delay schedules and disables them after public-repository inactivity.
A deployed base-push/recovery run plus the matching Cadence workpad's confirmed
Inactive-to-Active mutation is live proof. API fixtures (including the executed
YAML step) and Copier tests are implementation proof, not live delivery evidence.

[GitHub event behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
· [Mergeability API behavior](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request)

## Hide copied Cadence reviews

Both providers retain their formal review body, verdict and existing check/Linear
handoff. After copying the complete assessment to the existing App-owned status
comment and reading it back, shared publication hides that same App-owned review
using `minimizeComment` with `DUPLICATE`. It reads back `isMinimized: true` and
`minimizedReason: duplicate`; human/other reviews and the status comment stay
visible. Copy failure never hides the review. Hide failures retry through the
existing completion/recovery path without replacing the comment or footer.

Use matching reviewed workflow/helper refs and propagate callers through Copier.
Live proof must use the actual Cadence App token and retain the hide readback in
the publication/recovery run; a human operator hiding a review is separate proof.

# Symphony client workflows

Shared GitHub workflows and helpers for Symphony clients. Existing clients consume
`main`; merged changes are available to them on their next workflow run. Clients
can instead select a reviewed release or commit, using the same revision for
both the reusable workflow and `helpers-ref`.

The reusable entry points are:

- `.github/workflows/symphony-client-commands.yml` — run client build/test commands.
- `.github/workflows/symphony-linear-wakeups.yml` — forward CI state and merge conflicts to Linear.
- `.github/workflows/cadence-ai-review-trigger.yml` — review one PR and reconcile Linear when a PR closes.
- `.github/workflows/cadence-ai-review-events.yml` — route verified ingress feedback to review.
- `.github/workflows/cadence-ai-review.yml` — manually select a PR group.
- `.github/workflows/cadence-linear-rework.yml` — route reviews to Linear or humans.
- `.github/workflows/cadence-review-check-cleanup.yml` — recover unfinished checks.

The default is `1000lines/symphony-client-workflows/.github/workflows/<file>@main`
and `helpers-ref: main`; helpers always come from this shared repository, while
GitHub API reads and publication
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

## External acceptance authority and pinned callers

`reconcile-pr-close` is an optional **boolean**, default `true`, on these reusable
entry points:

| Entry point                     | Close-policy forwarding       |
| ------------------------------- | ----------------------------- |
| `cadence-ai-review.yml`         | Manual review → trigger       |
| `cadence-ai-review-events.yml`  | Ingress event → trigger       |
| `cadence-ai-review-trigger.yml` | Gates only `reconcile-closed` |

For example, a client whose humans or external automation own Done/Canceled
transitions can set `reconcile-pr-close: false` on **all three entry-point
callers**, including the one receiving `pull_request_target.closed`. This keeps
acceptance authority with that client's existing process. False skips the close
job before checkout, configuration reads or Linear access; closing still cancels pending
Cadence review work. Review, CI, conflict wakeups and their terminal guards
continue independently. Other clients retain existing close reconciliation
unless they explicitly opt out; native provider events retain the same default.

For example, the trigger caller's job wiring is below. `<release>` is an
inspection placeholder: replace both occurrences with a reviewed immutable
release tag or full commit that supports this input, not a task branch or PR head.
The existing caller retains its event and permission declarations.

```yaml
jobs:
  review:
    uses: 1000lines/symphony-client-workflows/.github/workflows/cadence-ai-review-trigger.yml@<release>
    with:
      helpers-ref: <release>
      reconcile-pr-close: false
      pr_number: ${{ format('{0}', github.event.pull_request.number) }}
    secrets:
      CADENCE_APP_PRIVATE_KEY: ${{ secrets.CADENCE_APP_PRIVATE_KEY }}
      CADENCE_LINEAR_API_TOKEN: ${{ secrets.CADENCE_LINEAR_API_TOKEN }}
      CADENCE_OPENAI_API_KEY: ${{ secrets.CADENCE_OPENAI_API_KEY }}
      CADENCE_AI_REVIEW_ANTHROPIC_API_KEY: ${{ secrets.CADENCE_AI_REVIEW_ANTHROPIC_API_KEY }}
```

The manual and events callers use the same two settings, with their own PR
selection/event inputs. Do not use `inputs.reconcile-pr-close || true` when
forwarding: that turns an explicit false into true. The provider compares
`toJSON(inputs.reconcile-pr-close)` with `'false'` to preserve native events'
absent inputs as well as reusable boolean values.

Audit the full release path when adopting:

| Reusable entry/call                | Required named secrets                          | Helper revision                                                                      |
| ---------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| Manual → trigger → review-run      | App key, Linear token, selected provider key(s) | Forward `helpers-ref` at each hop                                                    |
| Events → trigger → review-run      | Same named review secrets                       | Forward `helpers-ref` at each hop                                                    |
| Trigger → review-run               | Same named review secrets                       | Forward `helpers-ref`                                                                |
| `cadence-linear-rework.yml`        | App key, Linear token                           | Explicit `helpers-ref`                                                               |
| `cadence-review-check-cleanup.yml` | App key                                         | Explicit `helpers-ref`                                                               |
| `symphony-linear-wakeups.yml`      | Linear token                                    | Explicit `helpers-ref` and `helpers-repository: 1000lines/symphony-client-workflows` |

Nested reusable `uses: ./.github/workflows/...` paths resolve at their containing
workflow revision. Helper checkouts separately consume `helpers-ref`; supplying
only a pinned top-level `uses` is insufficient. Keep all six public review/wakeup
entry points in the table pinned to the same delivered revision. The internal
`cadence-ai-review-run.yml` stays on that revision through relative calls.
Cleanup and Linear rework do not reconcile PR closure and need no close-policy
input. Setup and ingress stay native. Clients whose existing application CI
covers their configured commands can retain it without adding generated command
CI. Discover the actual required name/workflow/App-ID triples before activating
selected-base config.

`scripts/symphony/repository-config.mjs` provides the shared selected-base reader
and validator; existing review-contract imports remain supported. CI/close code
reads the caller's default-branch configuration, never proposed task-head config,
and does not execute the configured commands. An empty/unavailable required-check
contract cannot establish passing CI. Existing behavior remains pending/missing/
incomplete → Unhappy + wake:15m, success → Inactive, failure/conflict → Active;
leaving CI wait removes only the wake label and retains other labels.

Before pinning callers, verify that the chosen release contains the required
interfaces and has passing provider CI. Record its tag and resolved commit SHA;
do not move an existing immutable tag. Verify named secret scope, controller
default-branch restrictions and required-check identities in the client
repository. Keep client-specific release choices and rollout records there.
Local compatibility fixtures do not establish live caller, App, review or timer
behavior; verify those in the adopting client's environment.

## Issue-scoped workflow completion ownership

The provider helper exports `workflowTicket`, `resolveIssue`, and `runBridge`.
For dispatched completions on Symphony branches it recognizes the anchored
`[linear:TEAM-N] ` run-title marker (using the configured team and issue number),
with explicit ticket ownership taking precedence over a PR title and then branch
identity. Its final run re-read,
run-attempt receipt and terminal guard protect against stale, duplicate and
terminal events. It currently rejects completions outside `symphony/` branches,
even with a marker.

The reusable `symphony-linear-wakeups.yml` calls `runBridge` only for conflicts
(`pull_request_target`, base push, schedule). Its separate CI path looks for an
open PR at the event head and requires a configured CI workflow; it does **not**
invoke the issue-owned dispatched-completion path. A ticket marker alone does
not add that support. Issue-scoped deployment or E2E workflows should not be
added to ordinary required CI just to produce a wakeup.

Clients that need these completion wakeups must retain a **narrowed native
handler** for their ticketed deployment or E2E workflows. Preserve the explicit
ticket input → anchored marker, including ticketed default-branch runs with no
source PR. The ticket owns the completion even when a different issue owns
a PR at the same head. Retain same-repository, dispatch/completed-event,
workflow-path, current run/attempt, deduplication and terminal-state checks.
Remove ordinary CI, check/status, PR-conflict and scheduled-conflict listeners
from that native handler when the shared caller takes ownership of those events.
Keep the repository concurrency group across both handlers. No second ordinary-CI
or conflict listener, new timer, deployment or completion bridge is introduced
by this provider change.

## Development

Unless the caller opts out, the existing close event also runs the deterministic
[Linear PR-close handler](docs/engineering/symphony/pr-close-reconciliation.md).
It checks every associated PR before choosing Done or Canceled; unavailable or
ambiguous data leaves the ticket alone. The guide covers native Linear automation,
permissions, race limits, and default-branch rollout.

This repository also has a Copier-managed client installation from
`symphony-client-template` main at `84c83698fe2e66e066d307ac674727274e61acb2`.
Its recorded answers, client instructions, skills, App setup and PR tooling are
installed at the root. Existing package commands and `Workflow tests` remain
the CI contract; there is no separate build step.

This provider repo uses its existing native ingress, review/handoff/cleanup and
Linear wakeup implementations for its own events. Their generated caller paths
are excluded from Copier so adoption does not overwrite reusable source or add
duplicate listeners. The generated setup workflow is installed. The provider's
review guide above describes its runtime; generated client review guidance is
the template baseline, not a replacement for those native implementations.

From a clean checkout with Copier 9.18.2 installed, preserve these exclusions:

```sh
bash scripts/symphony/update-client.sh main
```

An immutable template commit can replace `main`. `COPIER` may name the executable
in a virtual environment. Do not run bare `copier update` here: its exclusions
are not persisted in the answers file. The separate client/provider ingress
rename remains tracked by 100-65; this installation keeps the existing ingress
authoritative and does not rename or broaden trusted workflow identities.

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
`helpers-repository` fixed to this shared repository and `helpers-ref` at the
reviewed workflow revision (default `main`), never the PR head. No target PR code executes with this credential.

The bridge rechecks open/unmerged status, same-repository ownership, head/base,
conflict and the configured team's issue association before Active (legacy
Rework) transition. Project metadata/color guards and terminal-state protection
remain. Active and parked Backlog work are left alone; recovery can wake a
worker that subsequently becomes Inactive. Workpad receipts per repository/PR
head survive short event-history rotation, suppressing unchanged conflicts even
as the base advances. A new head is eligible again. Linear writes are not atomic
with GitHub reads; failed final evidence writes are surfaced and retried once.
Keep the workflow's repository concurrency group when adopting it.

Merge shared code to `main` before activating the updated generated
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

# Dedicated workflow test repository

Use a disposable repository to exercise installed Symphony workflows without
closing, reopening, or changing production work. [100-116](https://linear.app/1000lines/issue/100-116)
owns setup; [100-117](https://linear.app/1000lines/issue/100-117) owns scenario
execution and actual outcomes. The seed is a dependency-free greeting module;
fixture PRs can add comments to its source without changing behavior.

## Select and prepare

Record an explicit owner, repository and visibility in the setup evidence.
The repository name must match `^test-repo-[1-9][0-9]*$`. Never search for an
arbitrary matching repository or silently reuse an existing one. Public visibility
is appropriate for this harmless seed and the existing public-repository grants.
For a private target, separately verify its effective Actions settings and plan
eligibility through the installed onboarding guide.

Run from a checkout of `1000lines/symphony-client-workflows`. Use Python 3.12,
Copier 9.18.2 and Git, following the supported
[template setup](https://github.com/1000lines/symphony-client-template/blob/main/README.md).
`COPIER` may point to a virtual environment executable. This preparation command
does no GitHub or Linear writes and refuses an existing destination:

```bash
fixture_repo=OWNER/test-repo-N # Replace OWNER and N explicitly.
fixture_dest=../prepared-client
template_sha=$(git ls-remote https://github.com/1000lines/symphony-client-template.git refs/heads/main | cut -f1)
bash scripts/symphony/prepare-test-repository.sh "$fixture_repo" "$fixture_dest" \
  https://github.com/1000lines/symphony-client-template.git "$template_sha"
cd "$fixture_dest"
node --check src/greeting.mjs
node --test test/*.test.mjs
git init --initial-branch=main
git add .
git commit -m 'Install Symphony client and disposable workflow fixture'
```

Review the rendered files before publishing. This uses the real Copier template,
retains `.copier-answers.yml`, and installs the normal configuration, skills and
CI/wakeup/review/ingress/handoff/cleanup/setup callers. There is no replacement
review workflow. Generated callers and helpers continue to consume `main`.
Record the exact template SHA plus the shared workflow main SHA at setup time;
because main moves, record the **actual resolved workflow and helper SHAs for
every later run** as well. Do not copy fixes from unmerged task branches.

The generated config initially has `ci.requiredChecks: []`. This is unconfigured,
not passing CI. Its build/test command arrays are the two commands above;
configured/effective mode is native (omitted), with no ticket Docker override.
The standard Ubuntu command runner already supplies Node; read its version in
the first run if diagnosing a toolchain difference.

## Publish through the normal owner setup

An authorized repository owner runs the template's normal creation command:

```bash
gh repo create "$fixture_repo" --public --source . --remote origin --push
gh repo view "$fixture_repo" --json nameWithOwner,url,visibility,defaultBranchRef
```

Use `--private` only when that visibility was explicitly selected and recorded.
If creation fails or its result is ambiguous, read back this exact repository
before retrying. A 404 may mean absent **or inaccessible**. Never select another
repository automatically, borrow a human credential in the hosted worker, or
expand the author App's permissions to create repositories.

Follow the generated `.github/symphony/APP-SETUP.md` and
`.agents/skills/cadence-onboarding/SKILL.md`. Reuse the normal, distinct Apps:
`1000lines-symphony` (author) and `1000lines-cadence` (reviewer). Verify actual
App ID/slug, installation ID, selected repository ID and accepted permissions;
an App's public metadata is not proof of installation on this target.

| Actions setting                       | Kind              | Required use                                               |
| ------------------------------------- | ----------------- | ---------------------------------------------------------- |
| `CADENCE_APP_PRIVATE_KEY`             | Secret            | Existing Cadence signing key                               |
| `CADENCE_LINEAR_API_TOKEN`            | Secret            | Actual target workspace/team read, workpad and state write |
| `CADENCE_OPENAI_API_KEY`              | Secret            | Codex; individually optional                               |
| `CADENCE_AI_REVIEW_ANTHROPIC_API_KEY` | Secret            | Claude; individually optional                              |
| `CADENCE_APP_ID`                      | Variable          | Verified numeric App ID (expected 4866513; verify)         |
| `CADENCE_REVIEWER`                    | Variable          | Verified `1000lines-cadence[bot]`                          |
| `SYMPHONY_BOT_USER`                   | Variable          | Verified `1000lines-symphony[bot]`                         |
| `CADENCE_CLAUDE_MODEL`                | Variable          | `claude-opus-5` when Claude is selected                    |
| `CADENCE_CODEX_MODEL`                 | Optional variable | Account-accessible override; record resolved model         |

Provision secrets through the owner's hidden prompt or protected-file stdin,
never chat, answers, shell arguments, evidence or commits. Inventory only names
and scopes with `gh secret list` / `gh variable list`, and verify effective
organization grants through `actions/organization-secrets` and
`actions/organization-variables`. Preserve unrelated grants and existing values.
Do not extract credentials from the hosted runtime or substitute a dummy key.
OpenAI wins when both provider keys are present; a failed selected provider must
fail without fallback. 100-117 must record how it selects each provider through
the supported settings without rotating keys or affecting production repositories.

Cadence needs metadata/contents/actions read and issues/PR/checks write. Use
those existing grants; never expand permissions to make review hiding work.
Configure `cadence-controller` with exactly one selected **branch** policy for
`main`, preserving other protection rules. No wildcard, tag, PR-ref admission
or environment secrets/variables shadowing the forwarded settings. Verify it
exists before dispatch so Actions cannot implicitly create it unprotected.

Enable Actions and permit the public shared workflows/vendor Actions. Read back
the environment, branch policies and effective settings. Then verify the callers
are on main and active, and run the native setup probe:

```bash
gh api "repos/$fixture_repo/commits/main" --jq .sha
gh api "repos/$fixture_repo/actions/workflows" --paginate \
  --jq '.workflows[] | {name,path,state}'
gh workflow run symphony-client-setup.yml --repo "$fixture_repo" --ref main
gh run list --repo "$fixture_repo" --workflow symphony-client-setup.yml
```

Require both `Check repository-visible settings` and `Verify job-visible
credentials` to pass. Capture run/attempt, SHA, App and installation IDs, Linear
identity/team and provider result. The hosted injected Linear viewer and the
Actions Linear secret are separate credentials; verify both against workspace
1000lines and team `100`. Probe success proves authentication/read access, not
provider inference, Linear writes or live review hiding.

Observe the real `Symphony Client CI` check runs on the installed main commit.
Record the exact check name (including any reusable-job prefix), workflow path,
App ID and job result, then add that observed requirement to
`.symphony.cfg.json` through a small onboarding PR. The expected child is
`Client Commands` from `.github/workflows/symphony-client-ci.yml`, GitHub Actions
App 15368; this expectation must be confirmed through check-run readback.
Have the owner merge the reviewed config. Do not mark setup complete with the
template's empty list or unverified check names.

## Disposable Linear fixtures and dispatch isolation

Use injected `linear_graphql` in hosted sessions. An operator outside the host
can use the generated Linear skill's authenticated script. Before writes, read
`viewer`, `organization`, the actual team `100`, states, labels and human lead.
Resolve IDs from readback. Never use a fixture from another workspace/team.

Create/reuse the label `workflow-test-fixture`. Each fixture has:

- Title `[DISPOSABLE workflow-test] <case> <run-id>` and that label.
- Team `100`, state **Backlog**, project Symphony workflow reliability, assignee
  Jeremy Carroll. No `wake:15m` or `mature` label.
- Description containing its explicit `repository: OWNER/test-repo-N`,
  `base-branch: main`, setup/runner issue links, case, expected harmless change,
  evidence destination, cleanup owner and an instruction not to implement it.
- A hard dispatch hold: **100-117 blocks the fixture**, created using
  `issueRelationCreate(input: {issueId: RUNNER_UUID, relatedIssueId: FIXTURE_UUID,
type: "blocks"})`. Read back both directions before opening any fixture PR.

The hold is necessary: native Linear GitHub automation currently maps `start`
to Active, `review` to Inactive, and `merge` to Done. Backlog alone cannot prevent
dispatch after association. These are real external transitions to observe;
do not disable/change production integration settings to hide them. Labels
alone do not exclude issues from Symphony. Keep 100-117 nonterminal during
observation and the hard hold in place until cleanup. Only an explicitly
commissioned worker-dispatch case may release its fixture hold. Read back
fixture states/relations again after PR association. A dispatched or edited
fixture invalidates an undisturbed observation and must be recorded.

Create at least a repeated-review fixture and a multi-PR fixture. Use
`issueCreate(input: ...)` with the resolved state, label, project and assignee
IDs. Persist returned IDs immediately; on an ambiguous result, search/read back
the exact run marker instead of creating duplicates. Confirm title, state,
labels, owner, repository and blocker relations. The evidence record lists
the actual created fixture IDs; examples in this guide are not live fixtures.

Before each run, read native settings with:

```graphql
query FixtureSettings($teamId: String!) {
  viewer {
    id
    name
  }
  organization {
    id
    name
  }
  integrations {
    nodes {
      id
      service
    }
  }
  team(id: $teamId) {
    id
    key
    gitAutomationStates {
      nodes {
        id
        event
        state {
          id
          name
          type
        }
        targetBranch {
          id
          branchPattern
        }
      }
    }
  }
}
```

Pass the team UUID resolved by the identity preflight as `teamId`.
Record all pages and repository scope from the native integration's settings UI
when it is not exposed by GraphQL. Distinguish a workspace GitHub integration
from this repository's actual installation/access. Save settings evidence
without credentials; lack of scope visibility remains a named gap.

## Create and associate fixture PRs

After setup passes, bind the normal Symphony author App to the explicit test
repository using the existing host broker. Do not use the provider repository's
token or another identity. Branch every PR from the test repository's current
main, for example `symphony/workflow-reliability/100-N/review-a`. Add only a
comment such as `// Disposable review pass A.` to `src/greeting.mjs`, run the
configured commands, commit and push. Use title `[100-N]: disposable review A`,
assign `jeremycarroll`, and apply verified GitHub labels `symphony`, `purple`,
and `workflow-test-fixture`. Create missing definitions with existing permissions
and verify them; do not copy another repository's label IDs.

Open draft PRs. Link the actual fixture issue in the PR body. Confirm the native
GitHub integration attaches the exact PR URL to the fixture. If needed, use
Linear `attachmentCreate(input: {issueId: FIXTURE_UUID, title: "Disposable PR A",
url: PR_URL})`, then verify both `issue.attachments` and `attachmentsForURL`.
The close handler uses attachments plus its triggering PR; a URL in prose alone
does not prove association. Do not associate fixture PRs with 100-99, 100-115,
100-116, 100-117 or any other production task. No production PR is a test fixture.

For repeated review, keep one PR/issue and add a second harmless comment commit.
Record each head separately and use the installed manual `cadence-ai-review.yml`
input `pr_numbers=NUMBER` when the scenario calls for another review. Normal
ingress events must still be observed; dispatch alone is not event-routing proof.
Keep the original review IDs, bodies/verdicts, stable consolidated-comment ID,
new run links and GraphQL hide readbacks. Never manually hide a review to satisfy
the actual-App requirement. Repeated delivery uses an authorized rerun of the
existing workflow, not a mock publisher or privileged PR-controlled helper.

For multi-PR cases, create independent branches A and B from main and attach both
PRs to the **same disposable issue**. Use separate comment positions/files if
both might merge. Read back the complete association set before observation.
Use a fresh issue for each terminal outcome (single merged, single abandoned,
mixed closed, all abandoned); keep the any-open case nonterminal. 100-117 chooses
the exact event order and safe delayed-event/copy-failure/hide-retry exercises.
No manual Linear status changes during observation. Capture timestamps and
history to distinguish native transitions, handler writes and already-correct skips.

## Reset, evidence and cleanup

Store redacted setup evidence alongside this guide in the provider repository;
store per-case outcomes in 100-117's pinned workpad and linked durable artifacts.
For each record retain the exact repository/default/head refs, Copier version
and template SHA, caller content revision, resolved reusable workflow/helper
SHAs, App/installation/repository IDs, native Linear settings, fixture/PR/review
IDs, run/job URLs and attempts, event/start/end times, check App/results, mutation
reason/result and API/history readbacks. Green Actions alone is not live proof.
Use `unknown`, `blocked`, or `not run` for missing evidence.

Reset by creating a new run-marked fixture and fresh main-based branches. Do not
reopen a terminal fixture to recycle its expected result, delete workpad history,
force-push a reviewed head or silently detach an old PR. A repeated-review case
reuses its open PR deliberately; a multi-PR case deliberately shares one issue.

After observations and in-flight runs finish, save the final readbacks before
closing leftover **disposable** PRs. Record cleanup-generated close/Linear events
separately. Cancel any remaining nonterminal fixture as explicit cleanup, read
it back, then remove its dispatch hold if desired. Clean up all fixtures before
100-117 becomes terminal, so native Active states cannot become newly eligible.
Keep PRs/issues/evidence; delete only the named disposable branches after capture.

When the repository becomes cluttered, the owner may manually choose the next
positive integer, prepare it through the same flow and record the replacement
URL. Preserve/archive the old evidence first. There is no automatic rotation,
fixed threshold, repository deletion, or opportunistic discovery.

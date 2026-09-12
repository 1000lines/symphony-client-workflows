# Symphony client

Repository: "1000lines/symphony-client-workflows". Default branch: "main".
Linear team: "100"; each issue supplies its project in this shared repository.

Read README, AGENTS.md and CLAUDE.md when present. Use `.symphony.cfg.json` command
arrays; preserve setup/lint/application CI. Validate locally, then Docker for gaps,
then mandatory published-head CI. Empty `ci.requiredChecks` is **unconfigured**:
record observed check names/workflow paths/App IDs before activation. Cadence is advisory.

Command CI and native wakeups use reviewed shared code. Omit `symphony-client-ci.yml`
when application CI covers the commands; otherwise align its arrays with config and
supply application setup. It tests the exact head without named secrets. Wakeups
pass only `CADENCE_LINEAR_API_TOKEN`; trusted helpers read default-branch config.

Select `ci.mode` during onboarding without changing the eight Copier answers:

- `native` (or omission): use installed tools. Passing local checks skip Docker;
  missing tools/services may use the client's documented container as fallback.
- `docker`: supply the application's Dockerfile and explicit setup/build/test
  arrays to build and run it. The field does not wrap commands automatically.
  Mount only the issue workspace, use its UID/GID, remove task containers and
  record image digest/results. No generic Dockerfile is supplied.
- `remote`: run available checks, record missing tools and fix known failures, then
  publish for mandatory current-head CI. Unrun checks are not passes; no host/Docker setup.

GitHub CI needs its own working toolchain/commands in every mode. Required CI
pending or missing uses Unhappy with `wake:15m`; failures return nonterminal
tickets to Active; passing checks return them to Inactive for review. Preserve
terminal states and current-head guards. Live mode/bridge proof remains CT-A.

Review event/manual, handoff and cleanup callers share a reviewed workflow/helper
revision and explicit named secrets. Ingress is secret-free. Follow review context
for provider selection; report live execution separately from generated files.

Run the [PR guidance](docs/engineering/symphony/pull-requests.md) fetch/render
commands on creation and every refresh; retain generated state colors and links.

## Merge conflict wakeups

`Symphony Client Wakeups` checks labeled, same-repository open PRs on
`pull_request_target` and default-branch pushes; pushes select PRs targeting that
branch without needing a new head. Recovery at minutes 7, 22, 37 and 52 UTC also
checks other bases and retries unknown mergeability. GitHub may delay schedules
or disable them after inactivity; recovery has no guaranteed 15-minute deadline.

Publish the accepted bridge to `symphony-client-workflows@alpha`, install the
caller on the default branch, and enable Actions/schedules. Map only
`CADENCE_LINEAR_API_TOKEN`: its owner needs issue/team/project reads, Cadence
workpad writes and team issue-state updates. Record the authenticated owner;
no display-name gate. Grant contents/PR/checks/statuses/Actions read only.
No PR write, App key or provider secret is needed. Helpers use the fixed trusted
shared repository/ref, read default-branch config and never execute PR code.

Keep config team, title/branch ticket, project metadata and symphony/project-color
labels consistent; ambiguous/mismatched associations fail closed. Preserve
terminal issues and closed/merged PRs; leave active workers for later recovery.
Confirmed conflicts wake waiting issues to Active (legacy Rework). Cadence workpad
and Actions summary record issue, identity source, actor, PR/head/base, run URL,
resolution instruction and confirmed mutation/skip. Repository/PR/head receipts
survive event-history rotation and base changes; only new heads become eligible again.
CI delegates conflicts to this bridge, never parking them on successful checks.
Unknown CI mergeability uses Unhappy + wake:15m; Symphony's timer rechecks PR/CI
without another GitHub event. Symphony resolves conflicts.

For live proof, advance a disposable task-linked PR's base with a conflict while
its issue is Inactive. Retain the push/recovery run and matching Active mutation,
then verify the unchanged-head duplicate skip. Render/API fixtures are separate proof.

## Client session skills

Load these skills from this generated client in the human-operated session:

- [Project factory](.agents/skills/symphony-project-factory/SKILL.md), retaining
  its `templates/` directory; invoke only when a human requests project setup.
- [Linear GraphQL](.agents/skills/linear-graphql/SKILL.md), retaining
  `agents/openai.yaml` and `scripts/linear-graphql.mjs`. Prefer injected
  `linear_graphql`; when absent in a human-operated factory session, use the
  authenticated script with the same identity/preflight/staging/readback guards.
  Auth failure stops dependent writes without switching identity or transport;
  hosted workers retain injected auth. Already-authorized writes need no extra confirmation.
- Load [Replan](scripts/symphony/runtime-bundle/skills/symphony-replan/SKILL.md) from
  its nested path with the [guide](docs/engineering/symphony/replanning.md) and factory templates.

Keep a separate [reviewed tooling checkout](https://github.com/1000lines/symphony-example/tree/fd383f5760a2ba62ea6f6295bd6dd21cc0cb9e9e)
with locked dependencies and the CT-C reader; verify hosted `ci.mode` support before
setting it. `SYMPHONY_TOOLING_ROOT` resolves workflow/color/DAG/proof/review tooling;
client plans and skill resources resolve locally. Record both refs/locations and
loaded resource paths; the client repository and its Linear projects remain targets.

[CT-O](https://linear.app/1000lines/issue/100-54) verifies initial/repeated/additional-project
loading, including nested replan. Copying skills does not install/run them;
keep the project factory out of the unattended hosted worker profile.

## Review and App setup

Use the [Cadence onboarding skill](.agents/skills/cadence-onboarding/SKILL.md) for credential
names/scopes, App installation/grants and environment admission. `Symphony Client Setup`
checks repository/protected-job credentials without AI review; complete onboarding
requires installed callers and a real review/check/Linear handoff.

Author App: "1000lines-symphony". Reviewer App: "1000lines-cadence".
Reviewer choice: "codex"; see [review context](.github/symphony/REVIEW.md).
Provision credentials separately from answers and commands. At runtime an OpenAI
key selects Codex (including when both keys exist), otherwise an Anthropic key
selects Claude. Neither key fails early; authentication failures never fall back.

Public MVP forks use the existing Cadence App; installation supplies no Actions secrets.
Direct/private targets use the inert [App manifest](.github/symphony/cadence-app-manifest.json)
in the [registration flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest):
repository read, PR/issue/check write, no webhooks/subscriptions; native Actions deliver events.
The owner verifies App grants/IDs and provisions credentials via onboarding; rendering does neither.

## Source and license

Primary source: [Orchestra-Bio/symphony-example](https://github.com/Orchestra-Bio/symphony-example).
Orchestra Bio symphony-example / Copyright 2026 Orchestra Bio, Inc.
Development source and [usage/provenance](https://github.com/1000lines/symphony-example/tree/baa646a45721713231a1801c2271f524ccfc37ce/templates/symphony-client):
1000lines/symphony-example, [Apache-2.0](https://github.com/1000lines/symphony-example/blob/d5e9692b84c3f338014b964fd9713143fb723b55/LICENSE).
Preserve the target's own LICENSE, NOTICE and unrelated files.

# 100-116 setup evidence — September 12, 2026

Setup is **prepared, not provisioned**. The selected target is
`1000lines/test-repo-1`, public, default branch `main`. The intended URL is
`https://github.com/1000lines/test-repo-1`; it is not a verified live repository.
Use the [operator guide](workflow-test-repository.md) and the normal generated
onboarding flow. Actual scenario results remain owned by 100-117.

## Source and local evidence

| Item                      | Observed revision/result                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implementation base       | `1000lines/symphony-client-workflows`, `main@0c7deb90ed3b82a2019ed1982e983b0edcf62e6b`                                                                                                        |
| Supported template        | `1000lines/symphony-client-template@7c99f9e26179b24ba9e451e778c8c48ad622679f` (resolved main)                                                                                                 |
| Copier                    | 9.18.2, Python 3.12 container because host Python is 3.9.25                                                                                                                                   |
| Container base            | `python:3.12.14-bookworm@sha256:581429e3df12d76e6af4be5ab7d0e7fc2013eb57dc23d2de691411c8efdbb970`                                                                                             |
| Built Copier image        | `sha256:359f7691be5b9a142e3d17ae679fcc2dbc60161e4d1d56bee03845ce290552c6`                                                                                                                     |
| Prepared client           | Local commit `6474445d4f928934a4a9ecaccff76d55e60707f5`, 39 files, including nine production workflow files                                                                                   |
| Caller/helper selectors   | `main`; shared main read back as `0c7deb90ed3b82a2019ed1982e983b0edcf62e6b`. No live helper checkout has run on the target.                                                                   |
| CI mode                   | Provider selected-base and generated client: native (omitted); no ticket Docker override                                                                                                      |
| Seed checks               | `node --check src/greeting.mjs`; `node --test test/*.test.mjs`: passed, 1 test                                                                                                                |
| Config                    | Installed skill's `config.mjs validate`: valid. Generated empty required-check list still needs actual CI discovery.                                                                          |
| Selection validation      | Rendered `1000lines/test-repo-1` and `explicit-owner/test-repo-27`; rejected missing owner, zero, leading-zero, negative, extra path and shell-suffix names; refused an existing destination. |
| Provider regression suite | `env -u SYMPHONY_BOT_USER -u CADENCE_REVIEWER -u SYMPHONY_GITHUB_AUTH_MODE npm test`: 669 passed, 0 failed                                                                                    |

The initial suite inherited hosted identity/App-mode settings and failed 207
assertions; clearing the two logins left 19 App-mode fixture failures. Running
with the three unrelated runtime settings removed restored the suite's expected
fixture environment. No live authentication identity, broker config or product
code was changed. Node checks ran locally; Docker was needed only for Copier.

Workspace artifacts are under the issue's `100-116` directory: `publish-client/`
(the prepared Git repository), `copier-public-render.log`,
`copier-alternate-render.log`, `copier-build.log`, and
`workflow-tests-isolated.log`. The committed preparation command can reproduce
the installation without these ephemeral logs. Caller bytes are recorded in
[the checksum inventory](../../../fixtures/workflow-tests/callers-sha256.json).
Repository CI and review evidence are linked from this issue's pinned Codex
workpad and delivery PR; local rendering is not default-branch installation.

## Identity and native integration readback

The author broker successfully bound the provider and template repositories as
App `4866508 / 1000lines-symphony`, installation `160626742`. Provider repository
ID is `1366623630`; template repository ID is `1366632108`. Effective runtime
grants are metadata/actions/checks read, contents/issues/PR/workflows write;
repository administration and credential-setting grants are absent.

`GET /apps/1000lines-cadence` returned App `4866513`, slug `1000lines-cadence`,
owner `1000lines`, with metadata/contents/actions read and issues/PR/checks write.
This verifies public App identity only. Target installation, signing-key match,
provider access and Actions Linear identity are **unverified**.

Injected Linear authentication returned Jeremy Carroll
(`c65b9fbe-e740-47e9-b444-3172d3526ff2`), organization 1000lines
(`afd2ba98-d912-4449-ad6f-3a05d9b6bad8`) and team `100`
(`2d7d1d7e-47ff-45d2-8097-19307ad5a589`). This does not verify the separate
`CADENCE_LINEAR_API_TOKEN` used in Actions.

Paginated integration/settings reads completed with `hasNextPage=false`:

- Workspace GitHub integration: `a9a74918-c6a6-4945-aafd-d51bdf27009a`.
- Native `start` → Active, `review` → Inactive, `merge` → Done. All three returned
  `targetBranch: null`. No native settings were modified.
- Target repository coverage of the native integration is unverified; the owner
  must read it back in the installation/settings UI before observation.

## Created fixtures

| Fixture                                                                      | Confirmed state and protection                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [100-121 — repeated review](https://linear.app/1000lines/issue/100-121)      | Backlog, `workflow-test-fixture`, Jeremy Carroll; 100-117 blocks it |
| [100-122 — multi-PR association](https://linear.app/1000lines/issue/100-122) | Backlog, `workflow-test-fixture`, Jeremy Carroll; 100-117 blocks it |

Both belong to Symphony workflow reliability and explicitly select the planned
test repository in their descriptions. Forward and inverse relation readbacks
confirm the dispatch holds. 100-117 remains Active/nonterminal. Neither fixture
has a PR attachment; no fixture PR or scenario has run. These holds supplement
Backlog because native PR events can move fixtures to Active. Cleanup must make
all fixtures terminal before the runner is accepted.

## Exact missing-access handoff

`GET /repos/1000lines/test-repo-1` returned HTTP 404. The normal author broker
command `bind --repository 1000lines/test-repo-1` then failed with:

```text
GitHub App: HTTP 404 (expired/revoked, suspended, unselected repository or denied grant; no credential fallback). No credential fallback.
```

This does not distinguish absence from inaccessible/private or unselected state.
No creation, installation, secret write, environment change or probe dispatch
was attempted after the failed target preflight. No alternative token was used.

**Jeremy Carroll (`jeremycarroll`)** is the named operator; the provider's
collaborator API confirms GitHub user 549519 has admin access. Required operation:
using the existing owner account, verify/create the explicitly selected public
repository through the template's `gh repo create --public --source . --remote
origin --push` flow, select it in the existing Symphony/Cadence installations,
and configure the normal Actions settings/default-branch-only environment.
This requires repository creation/admin, installation management and Actions
settings permissions; do not grant them to the worker to bypass the boundary.

Readback needed: canonical repository URL/ID/visibility/default branch and main
commit, both App target installations/effective grants, nine installed/active
workflows, environment main-only policy and nonshadowing settings, both native
setup jobs passing with actual App/Linear/provider identities, native Linear
repository coverage, and an observed CI check requirement committed on main.
Then resume 100-116 to finish setup and fixture PR associations; 100-117 owns the
live outcome matrix. Do not mark setup complete or `mature` before this evidence.

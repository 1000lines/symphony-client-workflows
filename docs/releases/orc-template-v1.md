# Client template compatibility release record

Status: candidate verified; compatible tag publication awaits Jeremy's decision.
Readback date: 2026-09-18. This document's legacy `v1` filename is the accepted
task path, not a release version or moving alias.

## Release decision and exact revisions

[Jeremy's decision](https://linear.app/orchestrabio/issue/ABC-641/publish-the-compatible-immutable-shared-workflow-release#comment-802459c0)
selects `v0.1.0`, superseding the accepted plan's `v1.0.0` / next-`v1.0.x` default.
GitHub readback shows that name is already occupied by an older release. Its tree
does not support the required external acceptance policy. Moving or deleting
that tag is excluded; neither its release nor any caller was changed.

**Proposed decision:** approve the currently unused `v0.1.1` at the already merged
provider commit `950f2508f4df2e3eec0f4995fcd694c30c2d24ce`. This proposal is not
authorization to publish. The exact tag/commit pair requires Jeremy's approval
before creation. The existing `v0.1.0` remains unchanged; no `v1` tag is proposed.

| Artifact                   | Full revision / observed status                                                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted template          | `1000lines/symphony-client-template@b6ff05b31686a9bfefe5c7a9233a02f9ef1fcd92`                                                                                                 |
| Provider release candidate | `1000lines/symphony-client-workflows@950f2508f4df2e3eec0f4995fcd694c30c2d24ce`                                                                                                |
| Evidence branch            | `symphony/orc-template/ABC-641/workflow-release`, based on candidate `main`; its PR head is a separate documentation commit                                                   |
| Existing tag               | `refs/tags/v0.1.0` → commit `de1a5cfe722471e2637f76dc2a5a5a4c1b45dd6b`                                                                                                        |
| Existing tag object / peel | Lightweight commit ref: no separate annotated tag object; peeled commit is the same full SHA                                                                                  |
| Existing release           | [Post-hackathon release](https://github.com/1000lines/symphony-client-workflows/releases/tag/v0.1.0), ID `391061559`, published by `jeremycarroll` on 2026-09-17 at 21:08:15Z |
| Proposed tag and release   | `v0.1.1`: both exact Git-ref and release endpoints returned HTTP 404; tag listing contains only `v0.1.0`                                                                      |

The template's [PR #28](https://github.com/1000lines/symphony-client-template/pull/28)
was approved by Jeremy at `f53c6260fd960cd1aad2422a99a80fcd56a0c67e` and merged as
the template revision above. The provider's
[PR #19](https://github.com/1000lines/symphony-client-workflows/pull/19) was approved
at `2775ed059a4f93f3959a84677c7eca6e7113779e` and merged as the provider candidate.
Its three documentation threads are resolved. Those approvals accept source
changes; they do not approve this new release pair.

## Rendered and transitive entry-point audit

Copier 9.18.2 rendered the accepted full template commit twice in disposable
destinations, with `workflow_ref` set to the provider candidate SHA and to the
actual `v0.1.0`. Fixture answers select `Orchestra-Bio/orc-app`, team `ABC`, branch
`main`, author `orc-symphony-bot`, and a synthetic reviewer identity. No App or
credential configuration was inferred from those answers.

The generated inventory contains seven shared calls and six explicit
`helpers-ref` values. Every call and helper uses its selected workflow ref.
Native `symphony-client-setup.yml` and `cadence-review-ingress.yml` are not reusable
provider calls. The following names are relative to `.github/workflows/`:

| Generated caller                   | Provider entry and transitive calls                                    | Named secrets         |
| ---------------------------------- | ---------------------------------------------------------------------- | --------------------- |
| `cadence-ai-review.yml`            | manual → `cadence-ai-review-trigger.yml` → `cadence-ai-review-run.yml` | Review set            |
| `cadence-ai-review-events.yml`     | events → trigger → review-run                                          | Review set            |
| `cadence-ai-review-trigger.yml`    | trigger → review-run                                                   | Review set            |
| `cadence-linear-rework.yml`        | same name; no nested reusable call                                     | App key, Linear token |
| `cadence-review-check-cleanup.yml` | same name; no nested reusable call                                     | App key               |
| `symphony-client-wakeups.yml`      | `symphony-linear-wakeups.yml`; no nested reusable call                 | Linear token          |
| `symphony-client-ci.yml`           | `symphony-client-commands.yml`; no nested reusable call                | None                  |

“Review set” means `CADENCE_APP_PRIVATE_KEY`, `CADENCE_LINEAR_API_TOKEN`,
`CADENCE_OPENAI_API_KEY`, and `CADENCE_AI_REVIEW_ANTHROPIC_API_KEY`. The App key is
required; the review interface declares the other three optional. Runtime needs
at least one provider key: OpenAI takes precedence when both are configured;
authentication failure does not switch providers. Handoff requires App and
Linear secrets; cleanup requires App; wakeups require Linear.

All three nested reusable edges use relative `./.github/workflows/...` paths,
retaining their containing revision. They forward matching helper refs and
explicit named secrets. Every helper checkout resolves to this provider and the
selected ref with `persist-credentials: false`. The command runner instead checks
out the caller's exact `tested-ref`, then executes its configured commands.
Default `main` expressions remain for existing clients; explicit values bypass
those defaults throughout the audited path. No `secrets: inherit` is used.

Eight transitive workflows were inspected. Every third-party Action use has a
full commit pin; the eight distinct uses are:

```text
actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5
actions/create-github-app-token@a8d616148505b5069dccd32f177bb87d7f39123b
actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093
actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd
actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b
actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
anthropics/claude-code-action@30544b674398ee15c84819bd87caf8a87e8c7b55
openai/codex-action@86365089eb2b84e0a8fb0717b304f8bdcb13b20e
```

## Controller and acceptance boundaries

| Caller               | Declared token permissions                                         |
| -------------------- | ------------------------------------------------------------------ |
| Three review callers | `contents`, `issues`, `pull-requests`: write                       |
| Linear handoff       | `contents`, `pull-requests`: read                                  |
| Cleanup              | `contents`, `actions`: read                                        |
| Wakeups              | `actions`, `checks`, `contents`, `pull-requests`, `statuses`: read |
| Command CI           | `contents`: read                                                   |

Review routing/start/execution/publication, handoff, and cleanup jobs use
`cadence-controller`. Its deployed branch admission must remain restricted to
the caller's default branch. The close handler separately narrows its token to
contents/PR read; cancellation declares no token permissions. The audited nested
jobs' declared permissions fit within the generated callers' permissions.
Named secrets must come from repository scope or a selected organization grant;
controller-environment secrets must not shadow them. This is a source audit,
not verification of any client's installed environment, grants, or secret scope.

The template leaves close reconciliation at the provider's default `true`.
For this adoption's external Done/Canceled authority, the disposable interface
audit additionally supplies boolean `reconcile-pr-close: false` to all three
review entry points. The candidate accepts it and preserves false through the
manual/events → trigger hops. Its provider tests verify the close job is skipped
before configuration/Linear reads while close cancellation remains independent.
The adoption owner must apply those three overrides in the real callers.

**Actual published-tag result:** a detached checkout of `v0.1.0` was audited.
Its generic caller interfaces and matching refs/secrets pass, but the required
opt-out is an undeclared input on manual, events, and trigger. Therefore that
published tree is incompatible with the accepted adoption policy. Generic render
success does not establish adoption compatibility.

## Validation evidence

| Target / environment                             | Command or evidence                                                                                                                                        | Actual result and limitation                                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Provider candidate; Node 20.20.0, npm 11.13.0    | `npm ci && npm test`                                                                                                                                       | 739 passed, zero failed/skipped; synthetic fixtures only                                                                |
| Accepted template; Python 3.12.14, Copier 9.18.2 | `python -m pip install -r template/tests/requirements.txt`; from the disposable parent: `python -m unittest discover -s template/tests -v`                 | 24 tests passed in 51.954s, including render/update, preserved answers and explicit refs                                |
| Accepted template → candidate and published tag  | `python -m copier copy --defaults --vcs-ref=b6ff05b31686a9bfefe5c7a9233a02f9ef1fcd92 --data-file render-answers.yml --data workflow_ref=REF template DEST` | Executed with candidate SHA / `render-candidate`, and `v0.1.0` / `render-v0.1.0`; generated provenance retained         |
| Generated callers and both actual provider trees | Disposable `node audit-compatibility.cjs` parses YAML, checks inputs/secrets, follows nested calls and evaluates helper refs                               | Candidate passes default and opt-out profiles; published tag fails exactly the three opt-out interfaces described above |
| Provider candidate                               | [PROVIDER CI](https://github.com/1000lines/symphony-client-workflows/actions/runs/35363646845), job `105660724656`                                         | SUCCESS, attempt 1, exact `950f2508f4df2e3eec0f4995fcd694c30c2d24ce`                                                    |
| Reviewed provider source                         | [PROVIDER PR CI](https://github.com/1000lines/symphony-client-workflows/actions/runs/35360230516)                                                          | SUCCESS at approved `2775ed059a4f93f3959a84677c7eca6e7113779e`                                                          |
| Accepted template                                | [TEMPLATE CI](https://github.com/1000lines/symphony-client-template/actions/runs/35358683106), job `105644253235`                                          | SUCCESS, attempt 1, exact `b6ff05b31686a9bfefe5c7a9233a02f9ef1fcd92`                                                    |
| Reviewed template source                         | [TEMPLATE PR CI](https://github.com/1000lines/symphony-client-template/actions/runs/35357995939)                                                           | SUCCESS at approved `f53c6260fd960cd1aad2422a99a80fcd56a0c67e`                                                          |

Both CI identities are `.github/workflows/ci.yml`, GitHub Actions App `15368`:
`Workflow tests` for PROVIDER and `Client template tests` for TEMPLATE. All
candidate job steps succeeded. Docker is skipped after local success. Python was
installed only in the disposable workspace; no host toolchain was activated.

The evidence PR requires its own current-head PROVIDER check and formatting/diff
checks. Its live PR/workpad records the documentation SHA and that run; candidate
CI does not cover later evidence commits. The audit script, rendered trees and
sanitized raw readbacks are retained in the issue workspace under
`.symphony-local/ABC-641/`; this committed record preserves their outcomes.

## Controls, publication receipt and downstream handoff

Read-only GitHub discovery returned no repository/inherited rulesets and no main
branch rules. The classic required-status-check endpoint returned HTTP 404;
configured PROVIDER CI remains mandatory. The existing release reports
`immutable: false`. Server-enforced immutable publication is not demonstrated,
and no tag-protection setting or permission was changed. Preserve each published
mapping by never moving/deleting it and rechecking the full SHA before adoption.
If publication controls require administrator action, Jeremy owns that separate
handoff; unavailable access does not authorize expanding grants.

Publication remains pending. After Jeremy approves the exact replacement pair:

1. Re-read both the selected tag and release names for availability. Confirm the
   approved full commit is merged and its required CI still matches. If the name
   is occupied, stop that operation; do not overwrite it or choose another name
   without the applicable decision.
2. Create the approved tag and publish its matching release using existing
   permissions. Read back `git/ref/tags/<tag>`, any annotated tag object and its
   recursively peeled commit, plus the release URL and `immutable` field.
3. Audit a fresh checkout of the actual new tag with the accepted template,
   including the three opt-outs; compare it with the approved candidate. Update
   this receipt without moving the tag, and run PROVIDER CI on the evidence head.
4. Deliver full template SHA, approved tag, peeled provider SHA, release URL,
   controls and run links to OT-007 / ABC-643. OT-009 repeats the mapping before
   activation. Keep native application CI and the narrowed ticketed Scratch
   completion handler under the adoption owner's existing contract.

No compatible replacement tag/release, installed caller, live review, deployment,
host restart or activation is claimed. Source availability does not complete
D4 / AC4 / E1 delivery; the read-back compatible release and downstream proof
remain required.

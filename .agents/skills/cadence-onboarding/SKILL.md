---
name: cadence-onboarding
description: Configure and verify Cadence credentials after Copier generation or update, including App grants, caller forwarding, provider selection and live review/Linear handoff evidence.
---

# Cadence onboarding

Work on the adopter named in `.copier-answers.yml`; verify `gh repo view` and the
default branch before writes. Read `.github/symphony/REVIEW.md`, the generated
workflow callers and `.symphony.cfg.json`. Preserve the application's instructions,
CI, existing secrets and unrelated files. Rendering files is only the first stage.

## Guide the operator through credentials

Show this table. Inventory repository and organization Actions **names/scopes**
with `gh secret list` / `gh variable list` using `--repo OWNER/REPO` and, for an
organization, `--org OWNER`. Check effective grants with the repository's
`actions/organization-secrets` and `actions/organization-variables` API endpoints.
If metadata access needs admin, accept an owner's settings screenshots/export;
record unreadable scopes as unverified. Reuse existing settings without rotation.
Organization presence does not establish target access or usable credentials.

| Actions setting | Kind | Purpose / scope |
| --- | --- | --- |
| `CADENCE_APP_PRIVATE_KEY` | Secret | Cadence App PEM signing key: event route, admission, review publication, handoff, cleanup. |
| `CADENCE_LINEAR_API_TOKEN` | Secret | Target Linear team read/workpad write and issue wakeups; needed by review, handoff and CI wakeups. |
| `CADENCE_OPENAI_API_KEY` | Secret, individually optional | OpenAI provider key. Mapped to `openai/codex-action` input `openai-api-key` for the Codex OpenAI provider; no separate Actions secret named `OPENAI_API_KEY` is needed. |
| `CADENCE_AI_REVIEW_ANTHROPIC_API_KEY` | Secret, individually optional | Anthropic provider key, mapped to Claude Action `anthropic_api_key`. |
| `CADENCE_APP_ID` | Variable | Numeric App ID paired with the private key; not the installation ID or App slug. |
| `CADENCE_REVIEWER` | Variable | Actual Cadence App `slug[bot]` login; verified against the minted App identity. |
| `SYMPHONY_BOT_USER` | Variable | Actual author App `slug[bot]` login, distinct from Cadence. |
| `CADENCE_CODEX_MODEL` | Optional variable | Account-accessible Codex model override; omission uses the reviewed provider Action default. Record its resolved model during live review. |
| `CADENCE_CLAUDE_MODEL` | Variable | `claude-opus-5` under the published Claude review contract. Required when Claude is selected. |

At least one provider key is required. OpenAI only selects Codex; Anthropic only
selects Claude; both select Codex; neither is incomplete. A selected invalid key
fails with no fallback. A recorded Copier preference does not override this rule.
Inspect the installed caller/callee revision and verify its selected provider;
an OpenAI secret alone does not establish a working Codex path.

Use repository scope (or an existing organization grant) for **all** table
settings. `GITHUB_TOKEN` is provided by Actions. Do not request
`CADENCE_BOT_GITHUB_TOKEN` or `CADENCE_PRIVATE_KEY`.

Direct the operator to repository or organization Settings → Secrets and variables
→ Actions. For a new org setting, select the target repositories explicitly;
reuse an existing grant when it already covers the adopter. If the organization
has no suitable setting, provision at either scope:

- Repository: `gh secret set NAME --repo OWNER/REPO` (hidden prompt).
- Organization: `gh secret set NAME --org OWNER --visibility selected --repos REPO`
  (hidden prompt; preserve other repository grants when changing existing settings).
- Variables: `gh variable set NAME --repo OWNER/REPO --body VALUE`, or
  `gh variable set NAME --org OWNER --visibility selected --repos REPO --body VALUE`.

A private PEM may be piped from the operator's protected
file with `gh secret set CADENCE_APP_PRIVATE_KEY --repo OWNER/REPO < /secure/key.pem`.
Never request values in chat, Copier answers, command arguments, logs, PRs or tickets.
Never retrieve existing secret values, print key-bearing environment variables,
or rotate working settings during a repeat run. Repository settings override
organization settings of the same name. Check those overrides and GitHub plan
eligibility: organization Actions settings are unavailable to private repositories
on GitHub Free; repository settings are the alternative. See GitHub's
[scope and provisioning guide](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets).

## Check the App and environment

Use the existing Cadence App where available. Installation does not provision
Actions credentials. If an App must be registered, the generated inert manifest
is input to GitHub's App registration flow; rendering the manifest registers
nothing. Verify its numeric App ID, actual slug, target repository installation
and accepted installation grants:

- metadata, contents, actions: **read**;
- pull requests, issues, checks: **write**.

The owner must accept pending permission changes on the installation. A new token
cannot expand its grants. Do not give the Cadence App contents write; draft
readiness uses the caller repository's `GITHUB_TOKEN` with contents/PR write.

Inspect `gh api repos/OWNER/REPO/environments/cadence-controller` and its
`deployment-branch-policies`, `secrets` and `variables` endpoints. Create/configure
this environment through repository Settings if absent. Choose **Selected branches
and tags**, with exactly one **branch** rule naming the actual default branch;
no wildcards, tags or additional branches. Preserve required reviewers and other
protection rules. Confirm the
workflow can satisfy those rules; a waiting job is pending, not configured proof.
Do not widen admission to PR refs to make a probe run. Verify the environment
exists before dispatch: GitHub can implicitly create an unprotected environment.

Environment settings must not shadow names in the table. Environment-only secrets
cannot be forwarded by reusable caller jobs; environment secrets also override
passed values in callee jobs. For an existing environment-only setup, have the
operator securely provision repository/organization scope, then reconcile the
duplicate environment entries through the authorized settings change. Do not
blindly delete or claim to copy an unreadable secret. If metadata access is denied,
record the exact endpoint/HTTP error and have the repository admin read it back.

Check Actions/reusable-workflow access policy permits the pinned public shared
source and vendor Actions. Every `uses` boundary must declare/pass each consumed
secret explicitly, including events → review → setup. The comment ingress has
`permissions: {}` and no secrets or checkout. Review, handoff, cleanup, wakeup and
setup callers must all be installed; a missing caller leaves onboarding pending.
100-64 owns those review interfaces/callers. Do not invent their inputs or copy
unmerged workflow code to make onboarding appear complete.

## Verify three separate stages

1. **Files generated.** Review a scratch Copier render/update before applying its
   diff. Record the template and shared workflow SHAs from the generated files.
   Preserve `.copier-answers.yml` with nonsecret answers only and retain application
   CI. Resolve actual required checks in `.symphony.cfg.json`; an empty list is
   unconfigured. Publish/install the reviewed callers on the default branch.
2. **Credential probe.** Dispatch `symphony-client-setup.yml` on the default
   branch with `gh workflow run symphony-client-setup.yml --repo OWNER/REPO --ref
   DEFAULT_BRANCH`. Inspect both `Check repository-visible settings` and `Verify
   job-visible credentials` jobs. They must pass for this source ref. The probe
   checks repository-visible settings, environment admission, App/key/target
   grants, Linear target-team authentication and selected provider access. It does not
   prove inference, Linear write permission, reusable forwarding or a live review.
   Record **credentials configured** only after inspecting the installed 100-64
   callers/callee declarations and their actual preflight/token/provider job
   results as well. A standalone probe cannot replace those checks.
   Compare the observed provider with the settings inventory: if OpenAI is granted
   but a job selects Claude, resolve the missing key/forwarding before proceeding.
   Do not supply a dummy provider key. Record run/attempt,
   source SHA, App/installation IDs, provider/model, result and any missing setting.
3. **Live review verified.** Use a small authorized, Symphony-authored PR assigned
   to the human lead, labeled `symphony`, linked to a nonterminal Linear issue and
   carrying current-head application CI. Dispatch `cadence-ai-review.yml`
   with `pr_numbers=NUMBER`. Confirm the selected provider executed, a **new**
   Cadence App review and advisory check cover this head, and the linked
   `## Cadence Workpad` records the review. Confirm `cadence-review-ingress.yml`
   and `cadence-linear-rework.yml` ran from the review event and record the
   confirmed Linear write/transition or appropriate human-review handoff/skip.
   Exercise an authorized human PR comment as well; verify event routing reaches
   review and handoff without secrets on ingress. Check cleanup and CI wakeup run
   results. Only link evidence that actually exists; a probe or an old same-head
   review is insufficient. Do not mutate a production issue just to manufacture
   a wakeup; use the commissioned onboarding issue/test PR or name the needed fixture.

For a repeat onboarding, reuse the recorded answers and configured credentials,
review `copier update --vcs-ref=REVIEWED_REF`, and rerun setup. Verify no unintended
file/settings changes, no duplicate callers and no secret rotation. Reuse still
applicable live evidence only if caller/provider/credential/source refs are unchanged.

Report each stage independently, with run/check/review/workpad links and remaining
operator action. Deferred providers, missing callers, inaccessible metadata,
blocked environment admission or failed/pending runs cannot count as completed
onboarding. Stop credential retries after an actionable failure; repair the named
input before retrying. Never replace missing access with another identity's token.

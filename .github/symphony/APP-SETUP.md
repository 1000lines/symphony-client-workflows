# Register and install the Apps

Use Node 20+ and an ordinary operator `gh` login for github.com. Run this after
Copier in the target checkout. Cadence reviews; Symphony authors. Keep their App
IDs and bot logins different. Public MVP forks reuse the accepted existing Apps.
The hosted worker's installation token cannot register Apps or administer secrets.

## Cadence first

Review `cadence-app-manifest.json` and the permission table below. Prepare a local
browser form with the owner, repositories, role and name (substitute your values):

```sh
node .github/symphony/setup-app.mjs prepare --owner example-org \
  --repositories example-org/widget --role cadence --name example-cadence \
  --other-app example-symphony --manifest .github/symphony/cadence-app-manifest.json \
  --directory /secure/cadence-setup
```

Choose a new directory outside Git, under an existing operator-owned directory.
The helper writes a private resume file and HTML form. Open `register.html` in
your local browser, signed into the owning personal account or an account allowed
to register Apps in the organization. Review the owner/name/permissions on GitHub
and submit once. Personal registration uses `/settings/apps/new`; organizations
use `/organizations/OWNER/settings/apps/new`. There is no `gh app create` command.
The presets have no webhook receiver/events; native Actions deliver review events.
The helper adds only a loopback redirect URL, with an unpredictable state value.

GitHub redirects to `http://127.0.0.1:8765/callback`. The browser will report that
the page is unavailable: no server is running. Copy the full URL from its address
bar and complete the exchange within one hour. The callback contains a one-time
credential: do not paste it into chat, shell history, logs or an issue.

Inventory existing settings first using 100-62's provisioning guide. For a **new**
Cadence secret, this Bash command reads the URL without echo and pipes the returned
PEM straight to the existing `gh secret set` process. No conversion response or
private key is printed or saved by this helper:

```bash
set +x
read -r -s -p 'Paste callback URL: ' app_callback
printf '%s' "$app_callback" | node .github/symphony/setup-app.mjs complete \
  --directory /secure/cadence-setup \
  --key-command '["gh","secret","set","CADENCE_APP_PRIVATE_KEY","--repo","example-org/widget"]'
unset app_callback
```

The key command is an argument array executed without a shell; it receives the PEM
on stdin. Its output is suppressed. A vault/provisioning command can be used in
the same way. For a **new** organization secret, use `gh secret set
CADENCE_APP_PRIVATE_KEY --org OWNER --visibility selected --repos REPO1,REPO2`.
Before changing an existing org secret, preserve its other repository grants.
Never replace working secrets on a repeat setup. No secrets belong in Copier answers.

The native conversion is `POST /app-manifests/{code}/conversions`. The helper uses
HTTPS directly for this one call so the code never enters process arguments;
ordinary readback and provisioning use `gh api` and `gh secret set`. Do not run
the raw conversion in a logged terminal: its response contains multiple secrets.

Open the returned `https://github.com/apps/SLUG/installations/new` URL and select
the intended owner and repositories. Registration and installation are separate
browser steps. Private presets (`public:false`) install only on the App owner's
account; review `public:true` if installing an App across owners. Public visibility
does not install it anywhere automatically. Organization approval may be pending.

## Existing Apps and repeats

Add `--existing-app ACTUAL-SLUG` to `prepare` to skip registration entirely. The
App may belong to another owner if its visibility permits installation on yours.
Running the same command with the same directory reuses its saved identity/form;
changed inputs are rejected. Running `complete` again never converts or provisions.
Do not resubmit a form after registration. If a crash/API error made conversion
uncertain, inspect GitHub Settings → Developer settings → GitHub Apps, then use
the actual existing slug in a new setup directory. Never guess that creation failed.
If key handoff failed, recover/generate a key on that existing App and use the
existing provisioning process; `keyHandedOff:false` is not configured credentials.

For a new Symphony App, repeat with `--role symphony`, its name,
`--other-app ACTUAL-CADENCE-SLUG`, and `symphony-app-manifest.json`. Route its PEM
to the host operator's existing secure provisioning command. Author credentials
stay on the host, outside Actions and Copier. If both Apps are new, register both
before verification; the opposite role's actual slug must resolve then. If GitHub
changed a slug, use existing-App setup with the corrected pair in new directories.

## Verify installation readback

Use the App's protected PEM file, or pipe it from your approved vault with
`--key-file -`. GitHub cannot return an existing Actions secret's value; if no
protected copy is retained, use the installed 100-62 job-visible probe for Cadence
or the host broker's preflight for Symphony and record that evidence separately.

```sh
node .github/symphony/setup-app.mjs verify --directory /secure/cadence-setup \
  --key-file /secure/cadence.pem
```

The helper signs a short-lived App JWT in memory. Direct HTTPS supplies the required
Bearer header for `GET /app`, `GET /repos/OWNER/REPO/installation` and `POST
/app/installations/ID/access_tokens`; gh's automatic header uses token auth.
The token is restricted to selected repositories and preset permissions. `gh api`
reads the bot login and paginated `GET /installation/repositories`. It revokes
the temporary token with `DELETE /installation/token`, including on validation
failure. JWTs/tokens stay out of arguments and output. Verification prints/saves
only IDs, slug/bot login, effective grants, selected token repositories and the
installation's `all`/`selected` mode. This mode describes the installation; the
token list does not enumerate other repositories an existing installation covers.

Missing grants, wrong owner/App/key, suspension or repository mismatch fail.
An owner must accept pending installation permission changes in GitHub settings;
minting another token cannot add grants. `all` includes future repositories: use
selected repository installation in the browser where appropriate. Rerun verify
after installation/grant changes; it does not register an App or rotate secrets.

## Permission rationale

| Repository permission | Cadence         | Symphony        | Actual operation                                                                                        |
| --------------------- | --------------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| metadata              | read (implicit) | read (implicit) | Repository identity, collaborators/author authority and installation readback.                          |
| contents              | read            | write           | Read review source/config; author clones, pushes commits and branches.                                  |
| actions               | read            | read            | Inspect runs, jobs, logs/artifacts and review event delivery. Operator dispatch/enablement is separate. |
| pull_requests         | write           | write           | Cadence publishes/dismisses reviews, handles feedback and requests review; author creates/updates PRs.  |
| issues                | write           | write           | PR conversation comments, labels and assignees. Linear uses its own token.                              |
| checks                | write           | read            | Cadence publishes/updates its advisory check and cleanup; author inspects checks.                       |
| statuses              | —               | read            | Author inspects combined commit-status CI, including private repositories.                              |
| workflows             | —               | write           | Author pushes changes under `.github/workflows`.                                                        |

No organization, administration or secret-management permissions are requested.
Cadence must not hold contents/workflows write. Draft readiness uses the caller's
explicit `GITHUB_TOKEN` permissions. Provider execution, Linear access, environment
admission and App installation are not permissions supplied by this manifest.
The helper accepts these reviewed permission sets exactly; broader sets require
a reviewed change to the preset and its operation rationale.

## Credentials and live proof

Continue with [100-62's provisioning/readiness guide](../../.agents/skills/cadence-onboarding/SKILL.md)
and [the installed review contract](REVIEW.md). Verify the installed
`symphony-client-setup.yml` probe from the default branch, then the live callers.
Set repository/org Actions variables
`CADENCE_APP_ID`, `CADENCE_REVIEWER=SLUG[bot]`, `SYMPHONY_BOT_USER=OTHER-SLUG[bot]`.
Installation ID is readback evidence, not a required Actions variable.

Keep `CADENCE_APP_PRIVATE_KEY`, `CADENCE_LINEAR_API_TOKEN` and provider secrets at
repository scope or organization scope granted to the target. OpenAI-only/both
selects Codex (`CADENCE_OPENAI_API_KEY` → `openai-api-key`); Anthropic-only selects
Claude (`CADENCE_AI_REVIEW_ANTHROPIC_API_KEY` → `anthropic_api_key`); neither fails.
Review callers forward all four names; handoff App/Linear; cleanup App; wakeup
Linear; CI/ingress none. Each caller/callee boundary explicitly maps/declares its
subset. `cadence-controller` admits only the default branch and must not shadow
passed secrets. Model variables and detailed environment checks remain in 100-62.

Record three stages separately: files generated; installation/credentials verified;
live operations verified. Use an authorized Symphony-authored PR to prove branch
push, PR creation/updates, labels/comments and current-head CI inspection. Then
record a fresh Cadence provider execution, App-owned review/check at that head,
human-feedback routing and matching Linear workpad/handoff. Include workflow/helper
SHAs, run/attempt and review/check links. Repeat setup must reuse identity/settings.
Fixtures and an old App's successful review do not prove a fresh installation.

References: [manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest),
[permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app),
[App APIs](https://docs.github.com/en/rest/apps/apps),
[installation APIs](https://docs.github.com/en/rest/apps/installations),
[commit statuses](https://docs.github.com/en/rest/commits/statuses).

# Symphony client workflows

Shared GitHub workflows and helpers for Symphony clients, published on the moving
`alpha` branch. Development uses `main`.

The reusable entry points currently available are:

- `.github/workflows/symphony-client-commands.yml` — run client build/test commands.
- `.github/workflows/symphony-linear-wakeups.yml` — forward CI state to Linear.
- `.github/workflows/cadence-ai-review-trigger.yml` — existing Cadence review entry.

Use `1000lines/symphony-client-workflows/.github/workflows/<file>@alpha` and the
inputs/secrets declared by that workflow. Preserve trusted helper source refs.
The other exported Cadence workflows retain their existing native event behavior;
they are not yet all reusable entry points. Codex selection and the remaining
review/handoff/cleanup interfaces are deferred from this initial publication.

## Development

```sh
npm ci
npm test
```

## PR publication helper

`scripts/symphony/ensure-pr-labels.mjs` owns the shared publication/repair helper
distributed as the same path by the Copier template. After pushing the task
branch, run it from the target checkout with Node 20 and the installed `gh`:

```sh
node scripts/symphony/ensure-pr-labels.mjs --issue TEAM-123 --repo OWNER/REPO \
  --publish --base main --head symphony/PROJECT/TEAM-123/DESCRIPTION \
  --title '[TEAM-123]: Brief title' --body-file PR_BODY.md --assignee HUMAN_LOGIN
```

App workers supply their existing repository-bound configuration, private cache
and installed broker through `SYMPHONY_GITHUB_APP_CONFIG`,
`SYMPHONY_GITHUB_APP_CACHE` and `SYMPHONY_GITHUB_APP_AUTH`. Every publication
forces the broker's identity/scope/grant preflight. No signing code or credentials
are copied into clients. Legacy token mode remains available for existing users.
Both modes require Linear read access via `LINEAR_API_TOKEN` or `LINEAR_API_KEY`.

The helper creates a draft through native `gh pr create --label`, rereads the
current project, repairs missing labels and verifies actual PR labels before
reporting completion. An existing matching head is idempotent. Resolve an old
open head before replacing it; a closed legacy PR does not block its replacement.
Omit `--publish` and its creation arguments for repair/readback of another native
publication path. A `no-open-pr` result does not complete publication. Missing
labels require the lead's existing authorized repository/project setup; a denied
write requires the owner to approve the existing App grant and rebind. The helper
never creates repository labels or removes unrelated labels.

Copier updates deliver the helper and publication guidance; the matching review
ingress, forwarded-event reader and router must be deployed together for native
label recovery. Existing wakeup consumers already accept `labeled`. Source tests
do not prove a running host reload or review execution. Keep the existing runtime
tooling checkout for its other helpers; this package does not replace that bundle.

[Publication provenance](PROVENANCE.md) · [Review guide](docs/engineering/review/cadence-ai-review.md)

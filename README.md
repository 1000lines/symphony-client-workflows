# Symphony client workflows

Shared GitHub workflows and helpers for Symphony clients, published on the moving
`alpha` branch. Development uses `main`.

The reusable entry points are:

- `.github/workflows/symphony-client-commands.yml` — run client build/test commands.
- `.github/workflows/symphony-linear-wakeups.yml` — forward CI state to Linear.
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
[100-62](https://linear.app/1000lines/issue/100-62) owns guided provisioning and
readiness checks. Publish the reviewed workflow revision, then propagate the
matching template callers through Copier. Local fixtures do not prove live
provider authentication, review/check publication or Linear handoff.

## Development

```sh
npm ci
npm test
```

[Publication provenance](PROVENANCE.md) · [Review guide](docs/engineering/review/cadence-ai-review.md)

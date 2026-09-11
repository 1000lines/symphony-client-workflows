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

[Publication provenance](PROVENANCE.md) · [Review guide](docs/engineering/review/cadence-ai-review.md)

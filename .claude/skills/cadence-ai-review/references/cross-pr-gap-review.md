# Cross-PR Gap Review

Supports the Cross-PR gap review phase of the Cadence AI review skill. Run one
or two reviewers over the entire PR group. These reviewers do not re-review a
single PR's internals; they evaluate the relationships between PRs and the
requirement set.

## Coverage gaps

- Requirements marked `unassigned`: no PR in the group satisfies them.
- Requirements marked `partial`: covered incompletely, or split across PRs
  without one PR owning the whole behavior.

Finding ID: `AR-<project>-coverage-F<n>`.

## Seam gaps

- One PR produces an interface, type, schema, event, config key, or migration
  that another PR consumes. Check that the contracts match: names, shapes,
  defaults, and ordering.
- Deploy-order or merge-order assumptions between PRs.
- Acceptance consumers must agree on passing required CI, a fresh review of
  the current head, matching workpad evidence, closed mandatory feedback, a
  clean branch and ready status. A prior approval cannot cover new
  review-relevant activity. Blocker-side maturity is removed for rejected/stale
  evidence or severe regression, not ordinary edits alone.
- Distinguish available helper source, installed refs and real execution.
  Name an unwired producer/consumer or missing deployment proof as a seam gap.
  Do not infer live App, provider, timer or CI behavior from fixtures.

Finding ID: `AR-<project>-seam-F<n>`.

## Plan divergence

When the group has a `plan` PR, coverage is measured against the **design doc**,
not the plan (the plan is a derived, fallible map). Surface:

- Doc requirements the plan under-covers or omits.
- Places where the implementation PRs diverge from the plan — whether the
  divergence still satisfies the doc (acceptable drift) or leaves a doc
  requirement unmet (a real gap).

Finding ID: `AR-<project>-plan-divergence-F<n>`.

## Split and duplication gaps

- A single requirement awkwardly spread across PRs that should be consolidated.
- The same behavior implemented in more than one PR.

Finding ID: `AR-<project>-split-F<n>`.

## Output

Produce findings using the methodology finding classes, plus the requirement
coverage table (`REQ` → owning PR(s) → `covered`/`partial`/`unassigned`). These
feed the Cadence workpad. The GitHub-visible review should contain only the
human-readable assessment: a concise approval reason, blocker explanation, or
human-needed question.

Stay in lane: only assert a coverage gap against a stated requirement with a
source. Do not invent requirements. Classify ambiguous product scope as
`human-needed`.

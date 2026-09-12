# Structured reviewer result

[R1 / node V](https://github.com/1000lines/symphony-client-template/blob/e7a9be382c062f141727c9a9129aef384aea8efb/docs/symphony-plans/template-enhancements-design.md#r1--structured-reviewer-deterministic-coordinator)
defines the provider boundary. The [pure adapter](../../../.github/workflows/scripts/cadence-review-result.mjs)
validates data without network access, provider calls or publication. P supplies
trusted acquisition and persistence; N consumes the same persisted output.

## Provider input to the adapter

Supply one JSON object or its JSON string. Markdown fences, prose, missing fields,
unknown fields, duplicate IDs and invalid types throw; they never imply approval.

| Field                                            | Required value                                                                                                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `repository`, `prNumber`, `headSha`, `requestId` | Exact trusted slug, positive integer, full lowercase 40-character SHA and coordinator-issued request ID. No coercion or case folding.                                                                                          |
| `verdict`                                        | `approve`, `request_changes`, `escalate_to_replan`.                                                                                                                                                                            |
| `summary`                                        | Nonempty human-readable disposition, at most 2,000 characters; never routing authority.                                                                                                                                        |
| `requirements`                                   | Every trusted requirement exactly once: `id`, `status`, `summary`, `source`, `evidence`. Status is `satisfied`, `unsatisfied` or `human-needed`; source echoes its trusted URL; evidence is a nonempty array of HTTP(S) links. |
| `findings`                                       | Unique stable `id`, `class`, `status`, boolean `mandatory`, `summary`, nonempty `evidence` links. Classes: `blocker`, `human-needed`, `should-fix`, `suggestion`. Statuses: `open`, `resolved`, `dismissed`.                   |
| `humanFeedback`                                  | Every trusted `(source, id)` exactly once: `id`, `source`, `status`, `reason`, `sourceUrl`. Dispositions: `addressed`, `deferred`, `blocked`. URL must echo trusted acquisition.                                               |

Finding locations may include a repository-relative `path` and positive `line`
(line requires path). Open mandatory, blocker and human-needed findings require
nonempty `nextAction`, `owner` and `recommendedResolution`. Resolutions and
dismissals still require evidence. Existing IDs and classes cannot be replaced
or downgraded; a true mandatory flag cannot become false. Every unresolved prior
finding must appear, including optional findings. New findings receive an ID that
subsequent reviews reuse. Unknown legacy classes require explicit reconciliation,
not an automatic downgrade. Arbitrary old statuses remain unresolved unless
`closed`, `resolved` or `dismissed`.

Optional finding `kind` is `implementation`, `execution-input` or
`requirement-change`; `requirementId`, when supplied, names a covered requirement.
Unavailable credentials are `execution-input`, `human-needed`, mandatory and
`request_changes`. They do not justify replanning by themselves.

`escalate_to_replan` requires a `replan` object with `requirementId`,
`changedRequirement`, `affectedScope` and `recommendedDecision`, all nonempty.
That requirement must be unsatisfied/human-needed and have an open mandatory
`requirement-change` finding referencing it. An open requirement change requires
this verdict. Other verdicts cannot include `replan`. This records a proposal;
the existing human/replan process owns acceptance and any new tickets.

Approval requires all requirements satisfied, no open mandatory/blocker/human-needed
finding, no blocked feedback and all mandatory feedback addressed. A non-approval
requires at least one such unresolved input. This also keeps legacy acceptance
consumers from treating a non-approval as clean based on empty finding lists.

## Trusted acquisition

The second argument is coordinator-owned `trusted`, never merged from model data:

- `repository`, `requestId`, `issueId`: the current acquired target/request.
- `generation`: existing `createReviewGeneration` output for repository ID, PR,
  head/base, configuration/controller refs and complete accepted-feedback watermark.
- `workpad`: parsed existing workpad plus acquired `commentId` and `issueId`.
  Its persisted `reviewContract` must match the live generation and include the
  existing ledger. P queues/persists that generation using the existing helper.
- `inputsComplete: true`, `providerSucceeded: true`: explicit acquisition and
  execution results. False/missing values reject every verdict.
- `requirements`: complete `{id, source}` inventory with trusted source URLs,
  including existing ledger IDs. Retired requirements need human reconciliation.
- `humanFeedback`: complete `{id, source, sourceUrl, updatedAt, mandatory}` inventory.
  Sources are `reviews`, `comments`, `threads`, `linearComments`, `commits`.
  Include inline replies in acquired threads, submitted review summaries,
  conversation and Linear comments, and human commits. Each watermark record
  must have a matching ID/source/timestamp. Retain older ledger feedback too;
  map legacy IDs without a source namespace unambiguously to their actual surface.
- `provenance`: positive `runId`, `runAttempt`, `appId`, `installationId`; nonempty
  `provider`, `model`, `effectiveEffort`, `workflowRef`, `helperRef`. Record observed
  settings; acquisition verifies App identity and trusted refs, not the model.
  Optional `timings` reserves `requestAcceptedAt`, `providerStartedAt`,
  `providerFinishedAt`: each is an observed timestamp or explicit `null` for
  unavailable. Present observations must be chronological. T owns measurement
  and presentation; the adapter neither estimates times nor routes from them.

P/N must acquire complete pages, verify human authority, bind request IDs to the
invocation and re-read current head/base/feedback before action. This pure module
cannot prove that caller-supplied context came from those APIs. A changed head,
base, accepted-feedback watermark or request rejects the old result, even when
the summary says approved. Model-owned routing/provenance fields are rejected.

## Existing ledgers and consumer interface

```js
const incomingWorkpad = adaptReviewerResult(providerJson, trusted);
// P persists through the existing helper with liveGeneration, then reads back.
// N supplies freshly acquired trusted context for the persisted generation:
const output = readReviewerResult(trustedWithPersistedWorkpad);
```

`validateReviewerResult(providerJson, trusted)` returns the same validated
`cadence-review/v1` output without completing the generation. `adaptReviewerResult`
uses `completeReviewGeneration` and returns `{reviewContract, reviewUpdate}` for
`resolveWorkpadInput` / `upsertCadenceWorkpad`. A queued/in-progress generation is
required for completion; completed/superseded attempts cannot complete again.

The output retains R1 fields, adds trusted numeric `repositoryId`, `generationId`,
`sourcesComplete` and `provenance`, and lives in existing `reviewContract.output`
and its existing ledger. There is no second schema or finding store. Requirement
`sourceUrl` retains the link while `source` preserves an existing legacy namespace;
feedback adds trusted `mandatory`/`updatedAt` and uses `reason` as its legacy
`summary`. Full finding actions/locations and feedback reasons/links survive in
the contract even where the old workpad display omits them. Incremental updates
preserve Greek review history, prior entries, learning notes and bridge state.

`readReviewerResult` requires a completed, digest-matching record, revalidates
R1 against current trusted context and rejects unresolved acceptance-ledger
entries. Missing structured output produces an error and a fresh-review handoff,
never reinterpretation of a legacy review's prose. Valid old history remains
readable; an old prose-only approval is not a structured result.

P owns durable write/readback before successful check/review publication, binding
the App-authored review ID to head/request/run/attempt, failure recording and
retry. N verifies that publication binding and App/review authority before any
transition. The adapter's return is neither a persistence receipt nor permission
to publish. Markers carry correlation only. Preserve concurrency, deduplication
and loop caps in their current owners; release P/N compatibly together in B.

## Validation

`node --test .github/workflows/scripts/cadence-review-result.test.mjs` exercises
malformed/partial/adversarial output, stale correlation and feedback, mandatory
coverage, credentials/replanning, all human surfaces including commits, and
actual legacy Markdown/acceptance-helper round trips. Run `npm test` for the
repository suite. These fixtures establish the contract, not live provider,
publication, readiness or Linear-transition evidence.

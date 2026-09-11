# Cadence Linear Workpad

Cadence stores detailed Linear-side review state in one issue comment headed
`## Cadence Workpad`. The [helper](../../../scripts/cadence-linear-workpad.mjs)
finds that comment and updates it, or creates it when it is absent. Symphony pins
and updates its own `## Codex Workpad`; `## Symphony Workpad` is engine-owned.
Neither is a fallback destination for Cadence writes.

Cadence records the reviewed head, findings and verdict in its workpad before
publishing the concise GitHub PR review. Preserve stable finding IDs and
mandatory classifications across reviews. Missing or denied persistence is an
operational failure, not acceptance; an unrelated workpad is not a substitute.
See the [acceptance contract](./cadence-ai-review.md#acceptance-contract).

Normal human handoff requires passing required CI and a fresh Cadence review of
the current head, closed mandatory feedback, a clean branch and a ready PR.
Recheck the head and incoming human feedback before publication. The timeline
helper detects stale approvals and selects incremental or full review; generated
bookkeeping cannot reset the agent-only review cap. Keep ordinary review history
and bridge coordination intact when updating the snapshot.

Cadence review and the retained standalone non-review bridge share this
workpad using the configured Linear credential. The standalone bridge reserves
`coordination.nonReviewWakeups` for ten recent deduplication records and
`coordination.lastNonReviewWakeup` for the latest event's full evidence.
Full snapshot and incremental review writes preserve these fields. Terminal
skips are deduplicated along with confirmed wakeups. Bridge error strings are
bounded; the workflow run summary also records the mutation result and any
evidence-write failure. A failed final evidence write is retried without
repeating or changing the reported outcome of a confirmed issue mutation.
If both final writes fail, the summary is the result record and durable dedup
is unavailable for that event. Bridge jobs serialize their own writes, but
independent Cadence writers still have no atomic update guarantee.

Payloads with `reviewUpdate` merge into the stored review history. Payloads
without it replace the review snapshot: omitted review fields are cleared, while
the two reserved bridge fields are preserved. Cadence's planning workflows send
replacement snapshots. The bridge's own evidence writes retain the complete
review snapshot they read. Callers that need stored review fields must use
`reviewUpdate` or supply a complete snapshot.

The current CI YAML writes conflict instructions and records state results in
its run log; it does not use the standalone bridge's deduplication ledger.
The review handoff bridge records `coordination.reviewHandoff`; the event router
records trigger context and coalescing evidence. Review and non-review bridges use the shared
[wakeup helper](../../../scripts/linear-issue-wakeup.mjs): `Active` first,
`Rework` only when `Active` is missing, with terminal states preserved. A
human-review request leaves Linear state unchanged. A workpad entry records
the actual action or skip; it is not itself a state transition.

Review state for another issue belongs in that issue's own Cadence workpad.
Detailed review records do not become ad hoc conversation comments.

This is separate from `scripts/fetch-linear-issue.mjs`, which remains read-only
for acquisition.

## Usage

```sh
LINEAR_API_TOKEN=... node scripts/cadence-linear-workpad.mjs DEMO-112 workpad.json
```

Use `-` as the JSON path to read the workpad input from stdin.

```sh
node scripts/cadence-linear-workpad.mjs DEMO-112 - < workpad.json
```

The token may be provided as `LINEAR_API_TOKEN` or `LINEAR_API_KEY`. It is sent
in the Linear API authorization header. The token must be able to read issue
comments and create or update comments on the target issue.

## Input Shape

The input file is JSON. Cadence may provide a full current-state workpad object,
which replaces the rendered body while still updating the single existing
comment:

```json
{
  "status": "completed",
  "triggerSource": "pull_request_review",
  "reviewState": "reviewed",
  "lastReviewedSha": "abc1234",
  "lastReviewedAt": "2026-06-27T22:14:00Z",
  "pendingTriggerState": "none",
  "pendingCommentState": "none",
  "githubAssessmentSummary": "No GitHub-visible findings.",
  "detailedFindings": ["No blockers found."],
  "skippedEvents": ["dependabot[bot] comment ignored"],
  "previousRun": "2026-06-27T21:10:00Z",
  "pendingRerun": "none",
  "coordination": "Ready for Symphony handoff."
}
```

For first and follow-up reviews, Cadence should prefer the incremental
`reviewUpdate` shape. The helper reads the existing `## Cadence Workpad`, parses
its persisted review object, assigns the next Greek review id (alpha, beta,
gamma, ...), stamps the update with a UTC `MM-DD HH:mmZ` timestamp when one is not
provided, appends the new review information, and re-renders the same comment.

```json
{
  "status": "completed",
  "triggerSource": "pull_request_review",
  "reviewState": "reviewed",
  "pendingTriggerState": "none",
  "pendingCommentState": "none",
  "reviewUpdate": {
    "range": "c4274ae...def5678",
    "lastReviewedSha": "def5678",
    "humanComments": 1,
    "disposition": "COMMENT",
    "remainingHumanReviewEffort": "low",
    "summary": "Follow-up review after human schema feedback.",
    "humanFeedback": [
      {
        "actor": "@example-lead",
        "id": "DEMO-112-schema-F1",
        "status": "open",
        "summary": "Make the Cadence workpad schema explicit."
      }
    ],
    "requirements": [
      {
        "id": "REQ-WORKPAD-4",
        "status": "partial",
        "source": "Linear",
        "summary": "Cadence Linear workpad writer."
      }
    ],
    "findings": [
      {
        "id": "AR-DEMO-112-schema-F1",
        "lifecycle": "new",
        "class": "human-needed",
        "locality": "local",
        "severity": "medium",
        "status": "open",
        "summary": "The workpad needs explicit incremental history."
      }
    ]
  }
}
```

`reviewUpdate` is the same format for the initial review and later incremental
reviews. On the first review there is no existing Cadence workpad, so the helper
starts a new history with the Greek letter alpha.

The normal display includes these top-level fields and sections:
status, trigger source, review state, last-reviewed PR SHA, last-reviewed
timestamp, pending trigger state, pending comment state, GitHub-visible
assessment summary, detailed findings, skipped or ignored events, previous and
pending rerun information, and AI-to-AI coordination notes.

## Workpad Schema

The workpad has two kinds of state:

- Current state fields describe the latest run: status, trigger source, review
  state, disposition, remaining human review effort, last-reviewed SHA,
  last-reviewed timestamp, pending trigger state, pending comment state, summary,
  GitHub-visible assessment summary, skipped events, rerun state, and
  AI-to-AI coordination.
- Historical sequences preserve review evolution: history, human feedback,
  requirements, findings, learn-from-human notes, see-also links, and other
  review notes.

Findings use explicit dimensions so Cadence can carry them across incremental
reviews without relying on prose conventions:

- `lifecycle`: `new`, `carried`, `resolved`, `partially-resolved`, or `other`.
- `class`: `blocker`, `human-needed`, `suggestion`, `nice-to-have`, or `other`.
- `locality`: `local`, `stacked`, `cross-issue`, or `other`.
- `severity`: free text such as `low`, `medium`, or `high`.
- `status`: free text such as `open`, `closed`, or `deferred`.

Requirements use `status` values such as `satisfied`, `partial`, `unmet`,
`partially-met`, or `other`, plus a `source` field for the owning requirement
boundary. Human feedback and learn-from-human entries carry `review`, `id`,
`status`, and summary fields so Cadence can distinguish human-grounded feedback
from AI-only findings.

The visible Markdown sections are for humans. The final `### Review Object`
JSON block is the canonical persisted state, which lets the helper deserialize
the current Linear comment and serialize it again deterministically. Tests cover
Markdown to internal object to Markdown round trips. Complete Markdown examples
live in `scripts/cadence-linear-workpad-fixtures/`; tests round-trip every file
there and compare incremental review updates against full expected Markdown
snapshots.

The helper keeps the single-comment workpad bounded. It first renders the full
current state. If that body would exceed the configured Linear comment-size
budget, it first omits the duplicate display sections and retains the complete
canonical Review Object. This changes presentation without losing stored data.
If that still exceeds the budget, it compacts older accumulated detail before
writing: current status
fields remain, recent history/findings/requirements remain, long text fields are
shortened, and the `Other` section records that compaction happened. This keeps
Cadence updating the one `## Cadence Workpad` comment instead of failing the
write or appending duplicate scratchpad comments. Treat the workpad as current
handoff state, not an unbounded append-only archive.

The bridge permits the lossless layout but refuses a write that would discard
canonical review data. Cadence's ordinary compaction retains the bridge ledger
and bounds its latest evidence even in the minimal layout. A full snapshot can
repair invalid canonical JSON when the duplicate coordination section remains
readable; incremental updates require readable canonical review history. If
stored bridge fields cannot be recovered, the helper fails without overwriting
the comment.

## Failure Behavior

Missing token configuration exits non-zero with a message asking for
`LINEAR_API_TOKEN` or `LINEAR_API_KEY`.

If Linear rejects comment creation or update, the helper exits non-zero and
asks the operator to confirm comment write access. Error details are included
after token redaction so the configured token is not printed.

The helper does not mutate Linear issue state, does not post GitHub comments or
reviews, and does not touch `## Codex Workpad` comments.

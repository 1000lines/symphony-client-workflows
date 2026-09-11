# Cadence Linear Workpad

Cadence uses Linear in two distinct ways:

- **Acquisition:** read the linked issue context with
  `scripts/fetch-linear-issue.mjs`.
- **Workpad:** write detailed review state to one Linear issue comment headed
  `## Cadence Workpad` with `scripts/cadence-linear-workpad.mjs`.

The workpad helper is the primary Cadence Linear write path. Do not create ad hoc
comments as a substitute for review-state workpad updates, edit
`## Codex Workpad`, or mutate issue state, labels, assignees, relations, or
project metadata.

Preserve the reviewed SHA, stable finding IDs, mandatory classifications and
ordinary review history across workpad writes. A denied write or mismatched
readback is an operational failure, not acceptance. Do not substitute a PR
approval or another workpad for persisted evidence. Normal handoff needs
passing required CI, a fresh current-head review, closed mandatory feedback,
a clean branch and a ready PR.

## Happy Path

1. Read the Linear issue during acquisition:

   ```sh
   node scripts/fetch-linear-issue.mjs DEMO-114
   ```

2. After synthesis, build a workpad JSON payload. Prefer the incremental
   `reviewUpdate` shape from
   `docs/engineering/review/cadence-linear-workpad.md` so the helper can read
   the prior `## Cadence Workpad`, assign the next review identifier, and append
   per-item history.

   Include status, trigger source, review state, disposition, last-reviewed SHA
   and timestamp, pending trigger or comment state, the GitHub-visible
   assessment summary, detailed findings, skipped or ignored events,
   prior/pending rerun state, human feedback, requirement updates, finding
   updates, learn-from-human items, and AI-to-AI coordination.

3. Write the workpad through the helper:

   ```sh
   node scripts/cadence-linear-workpad.mjs DEMO-114 workpad.json
   ```

   Use `-` instead of a file path to read JSON from stdin.

4. Read back the saved head and review state, then post Cadence's
   concise GitHub PR review assessment. The GitHub body should not
   duplicate the full workpad detail.

If the helper or Linear credentials fail, do not bypass this by writing the
Cadence workpad through another path. Report the configuration failure so the
workflow can stop or request human input.

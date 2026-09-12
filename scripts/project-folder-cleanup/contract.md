# Project folder cleanup acquisition contract

Q ([100-79](https://linear.app/1000lines/issue/100-79)) implements read-only R5
acquisition and pure eligibility. X/100-80 owns approval, execution, retry and the
shared workflow; L owns the thin weekly/manual caller. This module creates no
environment, comments, PRs, state changes or deletions.

## Calling boundary

```js
const report = await acquireCandidates({
  ownership, // Exact reviewed plan mappings from the trusted caller.
  readers, // Fixture readers, or createReaders({ linearToken, githubToken }).
  now: new Date().toISOString(),
  stale_days: 60,
});
const { artifact, summary } = renderReport(report);
```

`stale_days` is the sole user input: a positive integer, default 60. `now`,
credentials, repository/base identity and ownership are execution inputs from
the trusted workflow, never additional dispatch inputs. No implicit credentials
or live calls occur on import; tests use fixtures. Readers return GraphQL `data`
objects through `linear(query, variables)` / `github(query, variables)` and a REST
Git tree through `tree(repository, treeSha)`. `createReaders` supplies authenticated
query-only POSTs and tree GETs, denies redirects and hides raw error bodies.

Each ownership record has this shape (SHA placeholders must be real 40-hex IDs):

```json
{
  "projectId": "Linear-project-ID",
  "code": "demo",
  "source": {
    "repository": "owner/repo",
    "path": "docs/symphony-plans/accepted-plan.md",
    "sha": "accepted-plan-commit-SHA"
  },
  "pullRequests": ["https://github.com/owner/repo/pull/12"],
  "repositories": [
    {
      "repository": "owner/repo",
      "baseBranch": "main",
      "baseSha": "reviewed-current-base-SHA",
      "folder": "docs/symphony-plans/demo/",
      "files": [
        {
          "path": "docs/symphony-plans/demo/notes.md",
          "projectId": "Linear-project-ID",
          "disposable": true
        }
      ]
    }
  ]
}
```

These are in-memory evidence records, not a new plan format or model-generated
execution instructions. The caller must obtain them from the accepted plan on a
trusted ref, including its explicit exact folder assignment, exhaustive disposable
coordination-file mapping and PR associations. A readable source blob alone does
not prove acceptance. Never construct ownership by guessing aliases, inspecting
filenames, scanning a directory or interpreting untrusted PR/model text. Missing
reviewed ownership excludes cleanup until that mapping is accepted.

List **all** explicitly project-owned repositories, including those with no
disposable folder (`folder: null, files: []`). At least one folder is required.
Read credentials must cover the complete Linear workspace inventory and every
listed repository. Tokens with silently restricted visibility cannot prove global
identity uniqueness; provision full read visibility before using the live reader.
Plan references used solely as historical citations are not PR associations.

## Acquisition and classification

- Paginate projects, project tickets, comments/replies and attachments with
  `includeArchived: true`. Paginate every owned repository's PRs in all states,
  associated PR comments/reviews/inline comments/commits and selected-base folder
  history. No human/bot filtering or search-result caps.
- Deduplicate PR URLs from ticket descriptions, comments and attachments plus
  explicit accepted-plan associations. Also match exact ticket tokens in titles/
  branches, `[project-code]` titles and `symphony/<code>/<ticket>/...` branches.
  Conflicting branch/ticket identities, unowned links or unresolvable PRs exclude.
- Require one exact `project-code:` metadata field and one matching Linear project
  across the complete inventory, including archived projects. Failures exclude the
  affected project; a failed global inventory excludes all requested candidates.
- Only tracked `docs/symphony-plans/<code>/` qualifies. Compare all tracked blobs
  against the explicit file mapping; verify every ancestor and member. Reject
  symlinks, gitlinks, nested `.git`, traversal, mixed ownership, changed bases and
  unlisted files. No workspace checkout or filesystem traversal is involved.
  Top-level design/plans/`.mmd`, shared/application files and `.github` are outside
  this directory contract. Truncated trees exclude rather than trust partial data.
- Clean means completed/canceled project, every ticket terminal and every PR
  closed/merged. Completed/canceled/duplicate ticket categories and legacy names
  count; archival alone never does. Official category overrides a display name.
- Otherwise stale means elapsed UTC time is **at least** `stale_days * 24h` since
  the maximum creation/update, comment/review creation/edit/submission, PR closure/
  merge, PR commit committer and folder-history committer timestamp. Include bots.
  Empty activity collections leave creation time as the baseline; `updatedAt`
  remains required (normally equal to creation on untouched objects).
- Missing/invalid/future timestamps, unknown states, incomplete pages, repeated
  cursors, duplicate page identities and changing connection counts exclude even
  otherwise clean projects. Open PR closure/merge and unsubmitted review times
  may be null. Re-read project/ticket/PR/base identity after acquisition; observed
  changes exclude. APIs do not supply an atomic cross-provider snapshot.

## Q → X evidence and report handoff

The `project-folder-cleanup/v1` report contains `observedAt`, `stale_days` and
`candidates`. Each candidate contains `identity { projectId, code }`, `eligibility`
(`kind: clean | stale | excluded`, reasons, last activity and known clean-end
predicates), a SHA-256 `fingerprint`, and its acquired `snapshot`.

The snapshot retains the accepted ownership/source blob ID, Linear object IDs,
ticket membership, deduplicated PR URLs/IDs/associations, activities, exact base
SHAs, folder entries with blob modes/SHAs, folder commit IDs, and per-resource
page/cursor/count/completion receipts. Failed candidates retain partial evidence
and exclusion reasons; a failure is never an empty successful membership list.

The fingerprint covers the snapshot, not observation time. It is a comparison
receipt, **not approval or authority to execute**. X must bind human approval to
the reported identities/evidence, reacquire after approval and before each
mutation, compare membership/activity/base/folder contents, distinguish its own
confirmed operations, and abort external changes. Q includes all associated PRs;
X identifies/reuses its cleanup proposal by the confirmed PR ID in its run evidence,
never by trusting a PR-supplied marker. X also rechecks final folder/base diff.

`renderReport` returns JSON artifact text and escaped Markdown summary text only.
The native workflow writes these to its artifact file and `GITHUB_STEP_SUMMARY`,
then uses Actions artifact upload. Do not post dry-run reports to Linear/GitHub
comments: those would create project activity. Reports inherit source visibility;
limit artifact access/retention accordingly. No live approval or execution is
demonstrated by fixtures. W/100-82 owns the controlled operational rehearsal.

Validate with `node --test scripts/project-folder-cleanup/*.test.mjs`, then
`npm test`. See [Linear pagination](https://linear.app/developers/pagination) and
[Git tree modes/truncation](https://docs.github.com/en/rest/git/trees#get-a-tree).

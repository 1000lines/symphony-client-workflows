---
name: linear-graphql
description: Read or write Linear issues, comments, projects and workflow metadata through injected GraphQL or the shipped authenticated script in human sessions.
---

# Linear GraphQL

Prefer injected `linear_graphql` whenever available. Only when absent in a
human-operated session, use [scripts/linear-graphql.mjs](scripts/linear-graphql.mjs).
Hosted Symphony workers retain injected-tool authentication and never install
or run the human-only project factory. Authentication failure stops dependent
reads/writes; do not switch identity or transport to bypass it.

Before source acquisition or writes, verify viewer ID, organization ID/name and
configured team ID/key against the intended account/workspace/project. Resolve
all IDs from actual responses; an example team is not a default.

```graphql
query Identity {
  viewer {
    id
    name
  }
  organization {
    id
    name
  }
  teams {
    nodes {
      id
      key
      name
    }
  }
}
```

Paginate when needed. For factory setup, follow every preflight, preview, staging,
relation and readback guard in the [factory skill](../symphony-project-factory/SKILL.md)
with either transport: source/color/label/state/assignee checks, concrete mutation
inputs, Backlog seeds, both blocker directions, then activation unless held.
Preview-only performs zero mutations. Already-authorized writes need no second
confirmation; otherwise obtain authorization for the concrete mutation scope.
On partial failure, stop dependent writes, record confirmed IDs and actual state,
read back and reuse those IDs on retry. Never infer rollback or create duplicates.

## Script authentication

The script uses `LINEAR_API_KEY`, then `LINEAR_API_TOKEN`, then a token file:
`--token-file`, `LINEAR_TOKEN_FILE`, or `~/.linear-token`. Inspect presence only;
never print, commit, forward or search logs for credentials. `--no-token-file`
disables file lookup. A configured source that fails authentication is not a
reason to try another identity.

AWS Secrets Manager is used only when explicitly selected by `--aws-secret-id`,
`LINEAR_AWS_SECRET_ID` or `SYMPHONY_LINEAR_API_KEY_SECRET_ID`, after environment/file
lookup. `--no-aws-secret` disables it. The known `symphony/linear-api-token` secret
is for explicitly authorized bot automation, never routine human factory work.
Hosted worker authentication is unchanged by these script options.

## Invocation

From the generated client, supply the same query and variables as the tool:

```sh
node .agents/skills/linear-graphql/scripts/linear-graphql.mjs \
  --query-file query.graphql --variables-file variables.json --no-aws-secret
```

The script also accepts stdin queries, `--variables-json`, `--operation-name`,
`--aws-profile` and `--aws-region`. `--help` lists options. Validate request shape
without credentials or network by adding `--dry-run`; that does not verify
identity, preflight or operation. Check errors/exit status before dependent calls.

For an issue, request description, project metadata/content, labels, state,
assignee, comments and attachments. Resolve target state IDs through team states
before `issueUpdate`; resolve label/assignee IDs and read back changed fields.
`commentCreate` takes `issueId` and `body`; use `commentUpdate` for the existing
pinned `## Codex Workpad`. Preserve the engine-owned Symphony workpad.

## Private uploads and evidence

For `uploads.linear.app` files, first look for a local copy. A direct download
uses the raw personal API key in Authorization (OAuth uses Bearer); never print
it. Alternatively re-query the issue/project/comments/attachments with
`--public-file-urls-expire-in 300`, then fetch the short-lived signed URL promptly.
Record an unavailable required source and stop dependent work; don't replace it
with an inferred summary. Keep private source excerpts to what the task needs.

Use existing specialized helpers under `$SYMPHONY_TOOLING_ROOT/scripts/` when
appropriate, including `fetch-linear-issue.mjs`, `cadence-linear-workpad.mjs` and
`cadence-linear-rework.mjs`. Record actual source refs, mutations, readbacks and
failures. Fixture/dry-run results do not prove live factory setup or hosted use.

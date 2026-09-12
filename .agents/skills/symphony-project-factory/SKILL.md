---
name: symphony-project-factory
description: Use only when a human requests Symphony project setup or updates, a specific additional seed, or an existing-ticket move.
---

# Symphony Project Factory

Human-operated setup creates a project brief and exactly three planning seeds.
Preserve the full delivery, review, deployment, cleanup and finalization scope in
that brief; downstream tickets belong to the human-reviewed plan and fan-out.
After planning starts, use replan for shape changes. A specific human request
may still authorize an additional seed or existing-ticket move. Reuse existing
projects/seeds; “start it” or “make tickets Active” never expands the ticket set.
This skill is not for implementation, review rework or finalization, and must
not be installed in the unattended hosted worker profile.

## Transport and identity

Prefer injected `linear_graphql`. Only when absent in a human-operated session,
use the shipped [Linear GraphQL skill](../linear-graphql/SKILL.md) and its
`scripts/linear-graphql.mjs` authenticated transport. Both follow every guard
below. Hosted workers keep injected-tool authentication. Authentication failure
stops dependent reads/writes; never switch identity or transport to bypass it.
Before acquiring sources or writing, query viewer, organization and configured
team; verify viewer ID, workspace ID/name and team ID/key against the intended
account/project. Wrong or unresolved identity stops dependent work.

## Preflight

Read the human request, current issue/project/comments/workpad, all named required
sources (including attachments, prior plans and PRs), relevant fan-out examples,
local skill frontmatter, and the workflow at
`$SYMPHONY_TOOLING_ROOT/scripts/symphony/runtime-bundle/workflow/WORKFLOW.md`.
Record source refs. For missing access, record `Unavailable source`, URL/method
and exact error in the workpad; stop dependent work, continue independent work,
and ask for access or pasted content. Use Inactive when no independent work remains.

Resolve goal, exclusions, acceptance, required sources, `project-code`, repository,
`project-color`, `base-branch` (default main), `human-lead` (default current human),
Linear team, labels and known GitHub lead mapping. Use verified context/defaults;
ask only when the answer materially changes scope, approach, acceptance or the
next authorized action. IDs, checks and credentials are execution inputs, never
invented observations. Preserve explicit holds and specific addition/move requests.

Run `$SYMPHONY_TOOLING_ROOT/scripts/symphony/project-colors.ts`: record availability
and the selected `SYMPHONY_PROJECT_COLOR_HEX` for the project icon. Preserve human
color overrides. Missing helper output permits drafting with
`color-helper-output: unavailable`; writes require verified equivalent output.
Stop writes for no available/unknown/duplicate active color, missing metadata or
multiple colors. Verify required GitHub labels (`symphony` and project color)
and Linear label IDs, Backlog/Active state IDs, required assignee mapping, team,
existing project/seed IDs and relation-aware dispatch. Missing or failed checks
stop dependent writes; never create a Blocked state or use Do Not Use.

## Concrete preview and authorization

Render [project metadata and brief](templates/project-description.md), with
`project-code`, `project-color`, `base-branch`, `human-lead` near the top, plus
repository and the complete acceptance scope. Retain material open decisions.
Preview placeholders are allowed; writes require resolved values and API IDs.
Use the existing templates/schema/criteria without replacing their contracts.

Before writes, record the concrete GraphQL input objects, rendered descriptions
(or paths), verified viewer/workspace/team, source reads/missing sources, color
output, metadata, labels, assignee, initial/final states, relations, existing IDs,
and the exact request for any addition/move. Explicit preview-only means zero
mutations. Otherwise the human's creation/update request authorizes its bounded
writes: no second confirmation once preflight is satisfied.

## Staged writes and readback

For a new project, `projectCreate` with team IDs, rendered brief and color hex,
then `issueCreate` with project/team IDs, rendered descriptions, label IDs,
assignee ID and Backlog state ID for these seeds only:

| Title                            | Template                                                                |
| -------------------------------- | ----------------------------------------------------------------------- |
| Create requirements & design doc | [requirements-and-design](templates/tickets/requirements-and-design.md) |
| Plan project - seed ticket       | [plan-project](templates/tickets/plan-project.md)                       |
| Trigger fan out                  | [trigger-fan-out](templates/tickets/trigger-fan-out.md)                 |

Create and read back both `issueRelationCreate` inputs with `type: blocks`:
`issueId: requirements/design` → `relatedIssueId: plan`, then
`issueId: plan` → `relatedIssueId: fan-out`. IDs must be actual created/reused IDs;
`issueId` is the blocker, `relatedIssueId` the blocked issue. Read back project
metadata, all labels, assignees, Backlog states and both relation directions
before any activation. Then `issueUpdate` all three to Active unless held, and
read back their states. Active dependents wait on relations until predecessors
are Done; a hold suppresses activation, not the two required relations.

Any authentication, lookup, mutation or readback failure stops dependent writes.
Partial creation/relation failure leaves staged work unactivated. Record exact
failures and confirmed project/seed/relation IDs; on retry read them back, reuse
them, and apply only missing authorized operations. Do not replay creation or
claim rollback. Activation failures preserve and report the actual partial state.
For existing projects, apply only requested metadata/state/addition/move changes,
using `projectUpdate`/`issueUpdate` and preserving unrelated fields. A ticket move
updates its `projectId`; it never creates replacement or sibling tickets.
[Standup](templates/tickets/standup.md) and
[broaden integration](templates/tickets/broaden-fanout-integration.md) require a
specific human request or later reviewed plan; template availability grants no scope.

## Planning contract

DAG is the default unless sources explicitly request sequential planning. Require
`%% symphony-dag/v1` Mermaid with reviewable graph diffs, one
`symphony-dag-manifest/v1` block (metadata, defaults, nodes, edges, types, branch/PR
policies, maturity, relation semantics and decisions), a branch manifest, and
Decisions with rationale/enforcing owner. Task/PR bases use the selected base;
no predecessor ancestry, joins, base_node, stack_policy, stack labels,
rebase-on-land or neutralization fields. Fan-in uses direct incoming blockers.
Blocker-side `mature` needs required current-head checks and fresh configured
review approval for a clean, ready PR with mandatory feedback closed.
Fan-out must show live/dry-run issue, branch, label, assignee and relation payload
readbacks and failures; missing required resources fail closed before a partial graph.

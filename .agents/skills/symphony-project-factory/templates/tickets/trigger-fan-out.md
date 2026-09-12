# Trigger fan out

Create in `Backlog`. After all seeds and relations are verified, move to
`Active` unless the human requested a hold. The planning relation
prevents dispatch until the predecessor is Done. Blocking is a property, not a
workflow status; never require `Blocked` or use `Do Not Use`.

## Scope

Create the Linear tickets, including implementation and final wrap-up, specified
by the accepted, human-reviewed project plan. Do not infer extra tickets from
the brief or available templates. Once the accepted plan, required labels,
workflow states, assignee mapping, and Linear ids are resolved, create the issue
set through `linear_graphql` without pausing for a second human response.

Do not implement any spawned ticket work from this ticket.

Unless the human explicitly requests a current hold, generated tickets should
finish fan-out in `Active`, including dependents. Stage them briefly in Backlog,
create and verify all blocker relations, then activate them. Dependencies hold
unfinished work; do not infer a new approval gate from older boilerplate about
parking tickets. Apply fresh human activation direction over older plan defaults.

## Assumptions

- Accepted plan source: `{{accepted-plan-source}}`
- Accepted plan pinned SHA: `{{accepted-plan-sha}}`
- GitHub repository: `{{github-repository}}`
- Project id or name: `{{linear-project}}`
- Human lead: `{{human-lead}}`
- Required Linear labels: `{{linear-labels}}`
- Required workflow states: `{{workflow-states}}`

## Success Criteria

- Every generated ticket is readable without opening the plan: it includes the
  node summary, `creates`, `edits`, `exclusions`, acceptance checks, validation
  commands, direct blockers, directly blocked issues, pinned plan links, labels,
  dependencies, workpad expectations, PR expectations, and validation
  expectations.
- Each generated implementation ticket explicitly orders validation
  **local → Docker if needed → mandatory CI** and carries the plan's applicable commands, container
  image or justified skip, and required CI checks for the published commit.
  If relevant tests pass locally, skip Docker; use it only for local environment
  gaps. CI is the shared validation surface, mandatory even for small/docs-only changes;
  follow `$SYMPHONY_TOOLING_ROOT/docs/engineering/symphony/proof-of-work.md#validation-order`.
- Generated tickets preserve confirmed decisions and material assumptions.
  Carry forward only questions whose answers change the task or an authorized
  next action; name that decision. Assign routine discovery and verification to
  the task that performs them, and external inputs to the work that needs them.
  Do not invent observed values or evidence.
- Initial states match the accepted plan and any human-provided state override.
- If the accepted plan is a DAG, generated tickets and artifacts preserve graph,
  manifest, branch, relation, and maturity semantics from the plan.
- If the accepted plan names an `existing_issue`, update that issue according to
  the plan instead of creating a duplicate. This includes accepted deploy and
  finalize tickets such as `DEMO-383` and `DEMO-384`.
- Missing required labels, workflow states, assignee mappings, existing issues,
  relation endpoints, branch refs, or relation direction fail closed before
  partial live writes.
- Live Linear writes use Symphony's injected `linear_graphql`.
- When the accepted plan includes a Mermaid graph, the graph exists both in the
  plan and as a standalone committed file unless the plan records a specific
  reason not to, and graph node labels for created issues are annotated with the
  resulting Linear identifiers from the payload-key mapping.
- Regenerating a generated ticket body from the same accepted manifest node is
  idempotent and does not append duplicate summaries, links, checks, commands,
  dependencies, or DAG boilerplate.

## Generated Ticket Body Requirements

Each generated or updated issue body must carry the accepted manifest node's
own content inline before any shared DAG execution contract or Symphony
boilerplate. Links remain useful for confirmation, but a reader must be able to
answer "what am I building, and how will I know it is right" from the ticket
body alone.

For each generated ticket, render a node-specific section that includes:

- **Summary:** two to five plain-prose sentences explaining what the node builds
  or changes and why. Source this only from accepted node fields such as
  `summary`, `scope`, `title`, `delivery_notes`, `integration_handoff`,
  `creates`, and `edits`. Do not add new requirements or interpretations. If
  the accepted node does not contain enough information for the summary, stop
  and require a plan amendment instead of inventing prose.
- **Plan reference:** the manifest node id and a pinned GitHub permalink to each
  named repository plan document or repository source document, using the SHA
  already recorded for the accepted plan in this form:
  `https://github.com/<owner>/<repo>/blob/<sha>/<path>`. Add a line or section
  anchor where practical; otherwise keep the unanchored pinned blob link. Do not
  leave a bare repo path as the only reference to a named document.
- **File lists:** copy the node's `creates`, `edits`, and `exclusions` lists
  exactly. Preserve empty lists as `none` rather than omitting the section.
- **Acceptance and validation:** copy the node's `acceptance_checks` and
  `validation_commands` exactly. Preserve empty lists as `none`.
- **Direct relations:** list direct blockers and directly blocked issues as
  clickable Linear issue links when a live issue exists. Use the Linear
  identifier as link text and the issue's Linear `url` or permalink as the link
  target. Fall back to the accepted manifest `payload_key` or node id only until
  the live issue identifier and URL exist. Derive these only from the accepted
  DAG edges or `linear_relation_payloads`; do not infer extra dependencies from
  prose.

Render the generated body in a stable order so repeated generation from the same
manifest node produces the same Markdown. When updating an `existing_issue`,
replace the generated node-content block instead of appending another copy.

## DAG Fan-Out Requirements

Only use this section when the accepted plan contains a `%% symphony-dag/v1`
Mermaid graph or a `symphony-dag-manifest/v1` block.

For a DAG fan-out, preserve:

- the accepted Mermaid graph and manifest as the source of truth for generated
  issue payloads, existing-issue updates, branch refs, node types, PR policies,
  and direct-edge declarations;
- the accepted Mermaid graph in both the plan and a standalone committed graph
  file. If the standalone graph file is absent, create it during fan-out unless
  the accepted plan records a specific reason not to. Keep the plan copy and
  standalone file synchronized from the accepted graph content;
- a branch manifest for task branches. Task branches must use the selected base
  branch as branch base and PR base;
- relation direction exactly: `issueId` is the blocker, `relatedIssueId` is the
  blocked ticket, and `type` is `blocks`;
- one Linear `blocks` relation payload for every direct issue-to-issue DAG
  edge;
- direct fan-in semantics. When multiple blockers feed one downstream issue,
  create one direct blocker-to-blocked relation payload per accepted edge. Do
  not create no-op join tickets or generated join branches;
- existing issue semantics. When a manifest node names an `existing_issue`, read
  the current issue, update its title/description/labels/state only as the plan
  instructs, reuse its issue id in graph annotation and relation payloads, and do
  not create a replacement unless the plan explicitly says the existing issue is
  canceled or unusable;
- blocker-side mature-label instructions in generated ticket bodies: set
  `mature` only when required CI passes and Cadence or the configured reviewer
  approves the current PR head, mandatory feedback is closed, the task branch
  is clean of committed predecessor work absent from the selected base, and the
  PR is ready from draft. Record the reviewed SHA, verdict and matching workpad;
  a prior approval cannot cover new review-relevant activity. Remove maturity
  only for request-changes review, rejected or stale acceptance evidence, or a
  similarly severe regression that makes downstream work unsafe;
- merged source does not establish deployment; record installed refs and actual
  execution separately when deployment is required;
- fail-closed mutation policy for missing labels, workflow states, assignees,
  relation endpoints, existing issue ids, branch refs, or direction checks.

## Labels

- Linear labels: `{{linear-labels}}`
- GitHub PR labels expected on spawned PRs: `{{github-pr-labels}}`

## Dependencies

Blocked by the plan-project ticket. The project factory should create that
Linear blocker relation by default. Do not create additional blocker relations
unless the plan or human says to. For an accepted DAG plan, the graph's
relation payload table is such an explicit instruction; create exactly those
accepted DAG blocker relations and no extra inferred blockers.

## Workpad Expectations

Record the issue payloads, created issue identifiers, updated existing issue
identifiers, initial statuses, label ids, workflow state ids, assignee ids,
blocker relations, branch manifest entries, relation payload direction checks,
generated node-content source fields, direct-relation issue URLs, pinned plan
link SHA/path evidence, standalone graph file path or recorded exception, graph
annotation evidence, and any failed mutation or label/state application.
Until a dedicated transition agent owns it, expect the human to move this ticket
to `Done` after reviewing the fan-out result.

## PR Expectations

This ticket may be metadata-only with no PR. If repo changes are needed, branch
from `{{base-branch}}`, open against `{{base-branch}}`, and apply required PR
labels.

## Validation Expectations

- For repository changes, validate **local → Docker if needed → mandatory CI**:
  skip Docker when relevant tests pass locally; use it for local environment
  gaps. Record skips and current-commit CI evidence per the proof standard.
  Metadata-only writes use API readback evidence; no artificial PR is needed.
- Payload fixture or actual write evidence records mutation input shape and
  resulting issue identifiers.
- Payload fixture or actual write evidence includes at least one generated
  issue body showing the inline node summary, copied `creates`/`edits`/
  `exclusions`, copied acceptance checks, copied validation commands, direct
  blockers, directly blocked issues, and pinned plan links.
- If the accepted plan has a Mermaid graph, write the created Linear identifier
  or reused existing Linear identifier back into each issue node's label using
  the payload-key to Linear identifier mapping. Annotate labels only, leaving
  Mermaid node ids, manifest payload keys, branch templates, relation payloads,
  and edge endpoints unchanged.
- If Mermaid click directives are practical for the target committed graph
  artifact, add or refresh issue-node clicks to point at the mapped Linear issue
  URLs. If they are not practical, record why and keep identifier annotations in
  the node labels.
- Make graph annotation idempotent: if a label already starts with a Linear
  identifier prefix, replace that prefix with the current mapped identifier
  instead of appending a second identifier.
- Ensure the accepted Mermaid graph exists in both the plan and a standalone
  committed graph file unless the accepted plan records a specific reason not
  to. When the graph exists in more than one committed artifact, update all
  copies or regenerate extracts from the accepted plan so the graph does not
  drift.
- No live Linear issues are created when prerequisites are unavailable, required
  labels or states cannot be resolved, existing issues cannot be read, relation
  direction cannot be verified, or the human explicitly requested preview-only
  output.

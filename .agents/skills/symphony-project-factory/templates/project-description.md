# {{project-name}}

```yaml
project-code: <project-code>
project-color: <project-color>
base-branch: <base-branch>
human-lead: <human-lead>
```

## Goal

{{project-goal}}

## Out Of Scope

{{out-of-scope-boundaries}}

## Acceptance Criteria

- {{acceptance-criterion}}

Preserve the full delivery scope here and in the goal, including publishing,
review, deployment, cleanup, and finalization when requested. These outcomes
are input to Symphony's planning and human PR review; they do not authorize
extra tickets during project setup.

## Source Documents

- {{source-document-name-or-url}}: {{source-document-status}}

Google Doc URLs, uploaded documents, Linear comments, repo docs, PRs, and other
human-provided sources are acceptable when they can be read. Mark unreadable
required sources as missing instead of replacing them with weaker context.

## Project Metadata

- GitHub PR labels: `{{github-pr-labels}}`
- Linear issue labels: `{{linear-issue-labels}}`
- Human lead Linear identity: `{{human-lead-linear}}`
- Human lead GitHub identity: `{{human-lead-github}}`
- Color helper output: `{{color-helper-output}}`

## Confirmed Project-Specific Seeds

Default setup creates only requirements/design, plan project, and trigger
fan-out seeds. Use this section only for specific additional seeds or existing
ticket moves explicitly requested by the human. Scope confirmation alone does
not authorize additions. Leave it empty when there are no such requests.

- {{requested-seed-title-or-existing-ticket}}: {{requested-scope-or-move}};
  human request: {{explicit-human-request}}

## Assumptions And Execution Inputs

State material assumptions and use existing conventions or reasonable defaults
for routine choices. Record values to discover during execution and external
inputs with an owner and the specific work they gate. Do not invent observed
IDs, permissions, credentials, or evidence. Independent work can proceed.

- {{assumption-or-execution-input}}

## Open Decisions

Ask only when plausible answers materially change scope, implementation,
acceptance criteria, or an authorized next action and available context cannot
resolve the choice. State the decision affected by each question. Omit this
section when there are no such decisions; routine discovery and verification
belong in execution tasks.

- {{material-question-and-decision-it-changes}}

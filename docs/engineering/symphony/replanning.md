# Replanning From Human Feedback

## Human Design Authority

A clear instruction from a human with repository write access changes the plan.
Record the decision and what it supersedes; no special review verdict or second
approval of the same decision is needed. Ask only about unresolved choices.
List material technical objections in the PR being merged, then proceed.
Before substantive work, reply on the originating PR in one or two lines:
state the interpretation, chosen path and its basis, and what it supersedes.
Update that same reply as needed; proceed without waiting for a second approval.

## Small Changes: Do Them Directly

For a small change—one node added, deleted, or split—update the plan and tickets
directly, creating a Linear ticket only where needed. An implementation rewrite
that keeps the same node also stays in the existing ticket and PR.
Update affected acceptance criteria, ownership, and dependencies; coordinate
with any worker doing the affected work, then implement and validate.
No separate replanning or fan-out tickets are needed.
Use this path only with concrete evidence that the remaining boundaries hold.
If ownership, interfaces, or dependencies remain in doubt, use the larger path.

## Larger Changes: Create Two Tickets

For a broader revision, create two Linear tickets in the existing project:

1. **Replan:** use the [planning template](../../../.agents/skills/symphony-project-factory/templates/tickets/plan-project.md).
   Include the human direction, current plan, and affected work. Revise the plan,
   retaining useful tickets and identifying work to change, replace, or remove.
   Produce the revised plan for review; do not create implementation tickets.
2. **Fan out:** use the [fan-out template](../../../.agents/skills/symphony-project-factory/templates/tickets/trigger-fan-out.md).
   Make it depend on the replanning ticket. Apply the accepted revised plan by
   updating existing tickets and creating only the additional tickets needed.

Adapt the templates to the existing project; do not create another design seed.
Keep unaffected work moving. Record the decision and ticket links in the Codex
workpad; reuse tickets on retries and preserve unresolved feedback. Refresh PRs
and validation after implementation changes, honoring explicit scope limits.

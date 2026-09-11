# Standing Docs Current State Review Axis

## Prompt

For changed durable repo guidance, check whether the doc states the current
behavior a future reader should follow. Transition narrative belongs in the PR
body, Linear workpad, or a dated plan/history document, not in standing guidance.

Use this axis for workflow docs, agent instructions, review docs, checked-in
skills, runtime-bundle docs, and standing operational docs. Skip PR bodies,
workpads, changelogs, and explicitly dated requirements/design/fan-out plans
unless their transition language is copied into standing guidance.

## Severity

- `blocker`: standing guidance presents planned, not-yet-wired, or transitional
  behavior as the current contract, or makes the current contract ambiguous.
- `should-fix`: the current behavior is still understandable, but migration or
  cleanup narration would age poorly in a standing doc.
- `suggestion`: the doc is current-state correct, but wording such as "new",
  "recent", or "now" can be made timeless.
- `human-needed`: the reviewer cannot tell whether the file is standing
  guidance or cannot determine which behavior is current.

## Examples

| Surface        | Text pattern                                                                  | Result       |
| -------------- | ----------------------------------------------------------------------------- | ------------ |
| Standing doc   | "Cadence will load this after PH-003 lands. Until then, check manually."      | `blocker`    |
| Standing doc   | "This temporary section should be revisited after migration cleanup."         | `should-fix` |
| Standing doc   | "The new routing helper reads the selected topic."                            | `suggestion` |
| Standing doc   | "Cadence reads the linked issue, PR metadata, and current head before review" | none         |
| PR body        | "This PR adds the source; PH-003 wires loading later."                        | none         |
| Linear workpad | "Axis source complete; Cadence loading remains pending PH-003."               | none         |

## Non-Goals

- Do not require PR bodies, workpads, plans, designs, or changelogs to be
  current-state only.
- Do not turn this into a broad writing-style review.
- Do not edit host install scripts, runtime manifest wiring, Cadence workflows,
  or runtime loading mechanics. This file is source only; `PH-003` owns Cadence
  consumer loading.

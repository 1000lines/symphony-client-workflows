# Pull requests

Use the [PR template](../../../.github/pull_request_template.md) in UI, CLI and API
sessions. Context explains the change, links the specific project or commissioned
issue goal, and says why it matters. TL;DR states the result in one sentence.
Start Summary with the product outcome; include alternatives only for a useful
tradeoff. Record the selected base and relevant tests. Link workpads and history
instead of repeating logs. Remove instructions and empty sections.
For standalone work without an accepted plan, omit the progress block and record
the linked issue/state and check time; never invent a plan to obtain a diagram.

## Generate progress on creation and refresh

Use Node 20+ and authenticated `gh` with read access to the plan's PR repositories.
`SYMPHONY_TOOLING_ROOT` must name the separate reviewed tooling checkout described
in [SYMPHONY.md](../../../SYMPHONY.md), with its locked dependencies installed
(`npm ci`) and `npm run symphony-dag:build` completed there. The fetcher imports
`tools/symphony-dag/dist/projectManifest.js`'s `parseProjectPlan`; missing tooling
stops generation. Do not copy its parser/schema or add a client Node package.

Set `plan` to the current accepted Markdown plan, `current` to its graph node ID,
and `body_file` to the prepared PR body. Read accepted replans and fresh human
feedback first. The plan remains the only source of graph nodes, IDs and edges.
When its manifest still uses commissioning placeholders, prepare `issue-map.json`
from the accepted fan-out readback, for example `{"G":"100-73"}`. This maps graph
IDs to actual Linear issue identifiers/UUIDs for lookup only; it is not a plan.
Omit `--issue-map` when the manifest already identifies every issue. An unmapped
placeholder is explicitly unknown; initial states and label prose are never used.

1. Before PR creation, emit the read-only Linear query:

   ```sh
   node scripts/symphony/fetch-pr-progress.mjs --plan "$plan" \
     --issue-map issue-map.json --query > progress.graphql
   ```

2. Execute that query with the injected `linear_graphql` tool and save its raw
   `{data, errors}` response as `linear-response.json`. Prefer the injected tool;
   hosted workers keep injected auth. In a human-operated session without that
   tool, use the existing authenticated transport:

   ```sh
   node .agents/skills/linear-graphql/scripts/linear-graphql.mjs \
     --query-file progress.graphql > linear-response.json
   ```

   Follow the [Linear skill](../../../.agents/skills/linear-graphql/SKILL.md) for
   auth. Do not switch identity after an auth failure or put credentials in progress files.
   If lookup fails, save its error response (`{"errors":[{"message":"lookup failed"}]}`
   for a transport failure) so the renderer reports Unknown, never an invented state.

3. Fetch and verify PR links from plan URLs and Linear attachments, then render:

   ```sh
   node scripts/symphony/fetch-pr-progress.mjs --plan "$plan" \
     --issue-map issue-map.json --linear-response linear-response.json \
     --current "$current" > progress.json
   node scripts/symphony/render-pr-progress.mjs progress.json "$body_file"
   gh pr create --draft --base "$base" --title "$title" --body-file "$body_file"
   ```

   The renderer replaces only the single `symphony-pr-progress:start/end` marker
   pair in the body. Keep these markers outside an enclosing HTML comment:
   Mermaid's arrows would end it. With no body argument, it prints the generated
   block. Snapshot JSON is disposable evidence, not a second planning format.

4. Capture the returned real PR URL as `pr_url`. Immediately repeat steps 1–2,
   then fetch with `--current-pr` so the new PR has a verified link:

   ```sh
   node scripts/symphony/fetch-pr-progress.mjs --plan "$plan" \
     --issue-map issue-map.json --linear-response linear-response.json \
     --current "$current" --current-pr "$pr_url" > progress.json
   node scripts/symphony/render-pr-progress.mjs progress.json "$body_file"
   gh pr edit "$pr_url" --body-file "$body_file"
   gh pr view "$pr_url" --json body
   ```

   For UI/API creation and updates, paste/send these exact generated body bytes.
   Every rework handoff and handled status/replan event repeats steps 1–2 and 4,
   even for body-only changes. Refresh Context, TL;DR and Summary when scope changes.
   Do not reuse an old Linear response. When no worker handles a later event,
   the PR owner runs the same refresh; the UTC snapshot time exposes its age.

## What the generated view means

Done is green, Active/Evaluating and legacy implementation states blue,
Inactive/Unhappy and legacy waiting states amber; Backlog, canceled, duplicate
and unknown states are neutral. Each state is named. A separate purple outline
and “Current PR” identify the current node in every state. Never hand-edit classes.
Pending-artifact or checkpoint prose cannot override Done: retain it as a separate
remaining-scope note in Summary, with its owner/evidence link.

The generator preserves the accepted topology and omits diagrams with fewer than
three meaningful nodes **or** two genuine edges, including standalone tasks.
Never invent dependencies to reach this threshold. There is no legend.
Canonical GitHub PR URLs are verified against their issue association and selected
base; missing/failed associations say “no PR yet” with lookup gaps reported below.
For multiple PRs, the current or open PR is clickable and all verified links appear
below as an accessible fallback. PR lifecycle and CI never override ticket color.
Incomplete attachment pagination is reported for separate association verification.

## Verify the handoff

Read back the saved body and open the PR conversation in GitHub. Check Mermaid
rendering, colors, current outline and actual link destinations. Record plan ref,
snapshot time, PR/head, browser and screenshot/walkthrough evidence in the workpad.
Syntax checks and local renders do not prove GitHub rendering. Run relevant local
tests, Docker only for environment gaps, and mandatory CI on the published head;
record commands, results, run/attempt, workflow/App and child jobs. Link concise
proof in Tested and name any missing evidence and its next owner.

For this template's delivery, 100-74 owns root propagation and installed/browser
proof. Link that proof back to 100-61's AC6 before claiming the requirement complete.
See the shared proof and review guides under `SYMPHONY_TOOLING_ROOT/docs/engineering/`.

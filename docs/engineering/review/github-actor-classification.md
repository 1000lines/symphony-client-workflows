# GitHub Actor Classification

`scripts/github-actor-classification.mjs` classifies GitHub actor logins for
Symphony review and rework workflows. It is a dependency-free bare-node helper
so local Symphony runs and GitHub runners can use the same contract without an
install or build step.

The actor classifier owns classification only; its `humanFacing` flag does not
authorize work. The same module also provides the permission verifier below. It does not trigger workflows, update
Linear, post PR reviews, or decide Cadence review behavior.

An actor classification or review request does not prove acceptance. Normal
handoff also needs required CI and a fresh review of the current head, matching
workpad evidence, mandatory-feedback closure, a clean branch and a ready PR.
See the [acceptance contract](./cadence-ai-review.md#acceptance-contract) for the
reviewer's output and freshness requirements.

## Inputs

The pure classifier accepts a GitHub actor login and optional local context:

- `humanAllowlist`: explicit human login overrides.
- `aiActorAllowlist`: explicit AI actor login overrides.
- `dependencyBotAllowlist`: explicit dependency bot login overrides.
- `teamMembership.humans`: pre-resolved membership in the GitHub `humans` team.
- `teamMembership.ai`: pre-resolved membership in the GitHub `ai` team.

Set `SYMPHONY_BOT_USER` and `CADENCE_REVIEWER` before loading the helper;
workflows read the matching repository variables. Login comparisons normalize
case. The known actor roles and synthetic fallback identities are:

- `example-symphony-bot`: AI actor with `actorKind: "coding"`.
- `example-cadence-bot`: AI actor with `actorKind: "review"`.
- `claude[bot]`: AI coding actor, not a review authority.
- `dependabot[bot]`: dependency bot.

## Rule Precedence

The classifier applies the most explicit local signals before team and suffix
fallbacks: human allowlist, AI allowlist, dependency-bot allowlist, known
dependency bots, known AI actors, `ai` team membership, `humans` team
membership, `[bot]` suffix, then unknown non-bot fallback. If both `ai` and
`humans` team membership are true for the same login, `ai` wins.

`classifyGitHubActorWithTeams` still attempts the GitHub team lookup before
classification so callers can see whether authoritative team membership was
read. After lookup, the same precedence applies, so a known AI actor is not
promoted to human even if team membership data also says `humans: true`.

## Output

The helper returns JSON with:

- `login`: normalized lowercase login.
- `classification`: one of `human`, `ai_actor`, `dependency_bot`,
  `non_human_bot`, or `unknown`.
- `humanFacing`: `true` when downstream safety behavior should treat the actor
  as human-facing.
- `source`: the rule that classified the actor.
- `actorKind`: present for known project actors as `coding`, `review`, or
  `dependency`.

Unknown non-bot actors return `classification: "unknown"` with
`humanFacing: true`. This keeps unknown outside contributors human-facing until
the GitHub teams or explicit allowlists say otherwise.

Unknown actors ending in `[bot]` return `classification: "non_human_bot"` with
`humanFacing: false`. Bot suffixes are never treated as humans by default.

## GitHub Team Lookup

The CLI resolves membership in the `humans` and `ai` teams of the organization
selected by `SYMPHONY_REPOSITORY_OWNER` before classification. Set this to your
GitHub organization; the `example-org` fallback is a synthetic placeholder.

```sh
node scripts/github-actor-classification.mjs <github-actor>
```

Environment:

- `GH_TOKEN`: GitHub token with organization/team read access.

The API path first checks that each team is readable, then checks actor
membership. A readable team plus 404 membership means "not a member." A 401,
403, or unreadable team is reported as:

```json
{
  "teamLookup": {
    "status": "missing_permission",
    "code": "missing_team_permission"
  }
}
```

When `classifyGitHubActorWithTeams` returns `status: "missing_permission"`, the
local fallback classification is included only so callers can record safe
blocker context. It is not authoritative for workflows that require GitHub team
truth. Those workflows should record the credential blocker instead of treating
bots as humans or proceeding as if team membership was read.

The CLI has no local-only mode. If team lookup is missing permission, it exits
non-zero and does not print a classification JSON payload.

The helper does not print tokens, request headers, or secret values. CLI output
is JSON; the CLI exits with code `2` when team lookup is missing permission.

## Examples

Pure ESM use:

```js
import { classifyGitHubActor } from "./scripts/github-actor-classification.mjs";

const actor = classifyGitHubActor("new-contributor");
```

`new-contributor` returns `unknown` and `humanFacing: true` until a team lookup
or explicit allowlist provides a more authoritative classification.

## Human Feedback Permission Gate

`verifyReviewEventAuthority` guards the existing review event router and Linear
review handoff before a human comment can request Cadence or wake Symphony.
It uses the runner's `GITHUB_REPOSITORY`, checks the event repository, reads the
current review/comment from that repository, and verifies its numeric author ID,
login, parent PR, body, review state, and supplied edit timestamp. The content
author is checked even when another user sends the edit event. Missing authors
never fall back to the sender. Bot-originated edits and superseded content are
skipped.

`verifyGitHubHumanWriteAccess` authenticates the credential through
`GET /installation/repositories?per_page=1`, which accepts installation access
tokens, then reads
`GET /repos/{owner}/{repo}/collaborators/{author}/permission` using the existing
App installation token. Token prefixes and character sets are not authority;
GitHub's stateless installation tokens contain underscores and dots. The
repository-scoped permission response must identify the same human `User` and
report effective `write`, `maintain`, or `admin` access. GitHub maps maintain and
custom roles to base permissions; a custom role qualifies when its effective
base permission grants write. A role name, association, team classification,
allowlist, sender permission, or comment text cannot grant authority. Known
service accounts and GitHub bots cannot qualify as human writers.

Every actionable creation, submission, edit, and replay performs fresh reads.
There is no stored allow decision. Missing credentials, redirects, mismatched
responses, malformed data, timeouts, and API failures leave the event untrusted
and cause no wake or review request. Credential/API failures and malformed
installation or permission responses set `verificationFailed`; both routing
CLIs exit nonzero, and the handoff reports `operation: failed`. A verified
read-only author remains a normal skipped event. The workflow summary records a
fixed reason without API error bodies or credentials. No read-only agent is dispatched.
Verified writers can request design changes directly without another owner
approval. Existing Cadence review handoffs and bot-loop suppression remain.

Review summaries and conversation comments use the Linear bridge; inline
comments use the Cadence request route. All three surfaces support edits.
`fetch-pr-review-state.mjs` rechecks authors when acquiring GitHub feedback and
attaches `authority.contentTrust` to each record. Unverified content remains
`untrusted`; it does not count as human activity that resets the review loop.
Raw comments acquired through other tools are untrusted until their authors'
current write access is verified; an authorized wake does not authorize all
other text in the PR.

### App Installation And Rollout

The secret-free ingress forwards event selectors; the event consumers and
single-PR reviewer execute trusted `main` and mint a repository-scoped token for the existing Cadence App using
`cadence-controller` Environment values `CADENCE_APP_ID` and
`CADENCE_APP_PRIVATE_KEY`. Feedback permission reads do not use the legacy
bot-token secret or a PAT fallback. Tokens request `Metadata: read` and
`Pull requests: write` in the event routes, and `Pull requests: read` in the
review trigger;
no organization Members or repository Administration permission is needed.
The [GitHub endpoint documentation](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user)
specifies App installation token support and `Metadata: read` for permission
lookups. [Conversation comment reads](https://docs.github.com/en/rest/issues/comments#get-an-issue-comment)
also accept Pull requests permission. The event router additionally requests
`Issues: write` for [accepted-feedback reactions](./cadence-ai-review.md#accepted-feedback-acknowledgement)
as the configured Cadence App; authority checks still precede acknowledgement.
The existing workflow token still handles review-request deletion to
preserve the current event-loop behavior.

The review trigger admits App-originated review requests to a guard that checks
the requesting bot against the slug returned by token minting. An unrelated App
stops before feedback acquisition or review mutations. Duplicate-request receipts
and timeline recovery use this requesting App identity separately from the
requested review account. Existing human and
configured service-account requests retain their routing. The legacy review
publisher still uses its own bot credential; that credential never supplies
human feedback authority.

The protected Environment must contain the existing App identity and signing
key, and its installation must grant the requested permissions. A missing
Environment, key, or installation grant stops routing. Do not move the key into
an unprotected repository secret or introduce a PAT to bypass a setup gap.
Fixture/CI success is not live Cadence credential evidence. Workflow changes
take effect when merged to the trusted default branch.

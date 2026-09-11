import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { classifyPrReviewState } from "./fetch-pr-review-state.mjs";

const codingActor = process.env.SYMPHONY_BOT_USER || "example-symphony-bot";
const reviewer = "example-cadence-bot";

const stateFor = (nodes, { pagedOut = false } = {}) =>
  classifyPrReviewState(
    {
      headRefOid: "head",
      isDraft: false,
      timelineItems: {
        pageInfo: { hasPreviousPage: pagedOut },
        nodes,
      },
    },
    reviewer
  );

const cadenceReview = (
  submittedAt = "2026-06-27T10:00:00Z",
  { state = "COMMENTED", oid = "base" } = {}
) => ({
  __typename: "PullRequestReview",
  author: { login: reviewer },
  submittedAt,
  state,
  commit: { oid },
});

const review = (actor, submittedAt = "2026-06-27T10:05:00Z") => ({
  __typename: "PullRequestReview",
  author: { login: actor },
  authority: { allowed: ["example-human", "example-reviewer"].includes(actor), contentTrust: ["example-human", "example-reviewer"].includes(actor) ? "verified-human-writer" : "untrusted" },
  submittedAt,
  state: "COMMENTED",
  commit: { oid: "head" },
});

const comment = (actor, createdAt = "2026-06-27T10:06:00Z") => ({
  __typename: "IssueComment",
  author: { login: actor },
  authority: { allowed: ["example-human", "example-reviewer"].includes(actor), contentTrust: ["example-human", "example-reviewer"].includes(actor) ? "verified-human-writer" : "untrusted" },
  createdAt,
});

const forcePush = (actor, createdAt = "2026-06-27T10:07:00Z") => ({
  __typename: "HeadRefForcePushedEvent",
  actor: { login: actor },
  createdAt,
  afterCommit: { oid: "rebased-head" },
});

const commit = (actor, committedDate = "2026-06-27T10:08:00Z") => ({
  __typename: "PullRequestCommit",
  commit: {
    oid: "commit-head",
    committedDate,
    author: { user: { login: actor } },
    committer: { user: { login: actor } },
  },
});

const ready = (actor, createdAt = "2026-06-27T10:09:00Z") => ({
  __typename: "ReadyForReviewEvent",
  actor: { login: actor },
  createdAt,
});

const draft = (actor, createdAt = "2026-06-27T10:10:00Z") => ({
  __typename: "ConvertToDraftEvent",
  actor: { login: actor },
  createdAt,
});

test("returns first-review when Cadence has not reviewed the PR", () => {
  const state = stateFor([comment("example-human")]);

  assert.equal(state.decision, "first-review");
  assert.equal(state.reviewStatus, "unreviewed");
  assert.equal(state.staleApproval, false);
  assert.equal(state.lastReview, null);
  assert.deepEqual(state.since, []);
  assert.deepEqual(state.workpadSince, []);
  assert.deepEqual(state.ignoredSince, []);
});

test("returns skip when nothing changed after Cadence's review", () => {
  const state = stateFor([
    comment("example-human"),
    cadenceReview("2026-06-27T10:00:00Z", { oid: "head" }),
  ]);

  assert.equal(state.decision, "skip");
  assert.equal(state.reviewStatus, "skipped-review");
  assert.equal(state.staleApproval, false);
  assert.equal(state.lastReview.oid, "head");
  assert.deepEqual(state.since, []);
});

test("distinguishes a fresh Cadence approval at the current head", () => {
  const state = stateFor([
    cadenceReview("2026-06-27T10:00:00Z", {
      state: "APPROVED",
      oid: "head",
    }),
  ]);

  assert.equal(state.decision, "skip");
  assert.equal(state.reviewStatus, "fresh-approval");
  assert.equal(state.staleApproval, false);
  assert.deepEqual(state.staleApprovalReasons, []);
});

test("human comments and review summaries after Cadence trigger incremental re-review", () => {
  const state = stateFor([cadenceReview(), comment("example-human"), review("example-reviewer")]);

  assert.equal(state.decision, "incremental");
  assert.equal(state.reviewStatus, "incremental-re-review");
  assert.deepEqual(
    state.since.map((activity) => activity.type),
    ["IssueComment", "PullRequestReview"]
  );
  assert.equal(state.humanGroundedSince.length, 2);
  assert.ok(state.since.every((activity) => activity.reviewRelevant));
  assert.ok(state.since.every((activity) => activity.humanGrounded));
});

test("example-cadence-bot self activity after its review does not trigger itself", () => {
  const state = stateFor([cadenceReview(), comment("example-cadence-bot")]);

  assert.equal(state.decision, "skip");
  assert.deepEqual(state.since, []);
  assert.equal(state.ignoredSince.length, 1);
  assert.equal(state.ignoredSince[0].isSelf, true);
  assert.equal(state.ignoredSince[0].routing, "ignore");
});

test("known AI actor and dependency-bot comments are workpad-only by default", () => {
  const state = stateFor([
    cadenceReview(),
    comment("claude[bot]"),
    comment("dependabot[bot]"),
  ]);

  assert.equal(state.decision, "skip");
  assert.deepEqual(state.since, []);
  assert.deepEqual(
    state.workpadSince.map(
      (activity) => activity.actorClassification.classification
    ),
    ["ai_actor", "dependency_bot"]
  );
  assert.ok(state.workpadSince.every((activity) => !activity.humanGrounded));
  assert.ok(
    state.workpadSince.every((activity) => activity.routing === "workpad")
  );
});

test("unverified outside feedback stays untrusted and cannot reset the review loop", () => {
  const state = stateFor([cadenceReview(), comment("new-contributor")]);

  assert.equal(state.decision, "skip");
  assert.equal(state.since.length, 0);
  assert.equal(state.humanGroundedSince.length, 0);
  assert.equal(state.workpadSince[0].authority.contentTrust, "untrusted");
});

test("force-push after Cadence's review still forces a full re-review", () => {
  const state = stateFor([cadenceReview(), forcePush(codingActor)]);

  assert.equal(state.decision, "full-review-rebased");
  assert.equal(state.reviewStatus, "full-re-review");
  assert.equal(state.since.length, 1);
  assert.equal(state.since[0].type, "HeadRefForcePushedEvent");
  assert.equal(state.since[0].reviewRelevant, true);
  assert.equal(state.since[0].humanGrounded, false);
});

test("PR commits after Cadence's review are review-relevant even from non-human actors", () => {
  const state = stateFor([cadenceReview(), commit(codingActor)]);

  assert.equal(state.decision, "incremental");
  assert.equal(state.reviewStatus, "incremental-re-review");
  assert.equal(state.since.length, 1);
  assert.equal(state.since[0].type, "PullRequestCommit");
  assert.equal(state.since[0].actorClassification.classification, "ai_actor");
  assert.equal(state.since[0].actorClassification.actorKind, "coding");
  assert.equal(state.since[0].reviewRelevant, true);
  assert.equal(state.since[0].humanGrounded, false);
});

test("stale Cadence approval is visible after a new commit", () => {
  const state = stateFor([
    cadenceReview("2026-06-27T10:00:00Z", {
      state: "APPROVED",
      oid: "base",
    }),
    commit(codingActor),
  ]);

  assert.equal(state.decision, "incremental");
  assert.equal(state.reviewStatus, "stale-approval");
  assert.equal(state.staleApproval, true);
  assert.deepEqual(state.staleApprovalReasons, [
    "head-sha-changed",
    "review-relevant-activity",
  ]);
});

test("stale Cadence approval is visible after human feedback at the same head", () => {
  const state = stateFor([
    cadenceReview("2026-06-27T10:00:00Z", {
      state: "APPROVED",
      oid: "head",
    }),
    comment("example-human"),
  ]);

  assert.equal(state.decision, "incremental");
  assert.equal(state.reviewStatus, "stale-approval");
  assert.equal(state.staleApproval, true);
  assert.deepEqual(state.staleApprovalReasons, ["review-relevant-activity"]);
});

test("human draft and ready transitions are review-relevant", () => {
  const state = stateFor([cadenceReview(), ready("example-human"), draft("example-human")]);

  assert.equal(state.decision, "incremental");
  assert.deepEqual(
    state.since.map((activity) => activity.type),
    ["ReadyForReviewEvent", "ConvertToDraftEvent"]
  );
  assert.ok(state.since.every((activity) => activity.humanGrounded));
});

test("paged-out prior Cadence review remains a full review", () => {
  const state = stateFor([comment("example-human")], { pagedOut: true });

  assert.equal(state.decision, "full-review-paged-out");
  assert.equal(state.reviewStatus, "full-re-review");
  assert.equal(state.pagedOut, true);
  assert.deepEqual(state.since, []);
});

// These exercise the new check-mode API independently of the temporary legacy
// timeline path above, which remains selected until the authorized cutover.
import { fetchReviewFeedback, classifyCheckReviewState } from "./fetch-pr-review-state.mjs";
import { createReviewGeneration, feedbackWatermark, queueReviewGeneration,
  completeReviewGeneration, reviewExternalId } from "./symphony/review-contract.mjs";

const page = (nodes, more = false, cursor = null) => ({ nodes, pageInfo: { hasNextPage: more, endCursor: cursor } });
const record = (id, body = "Human feedback") => ({ id, body, updatedAt: "2026-09-10T00:00:00Z", author: { login: "human" } });
const emptySources = () => Object.fromEntries(["reviews", "comments", "threads", "linearComments", "commits"]
  .map(key => [key, { nodes: [], complete: true }]));

test("acquires all review/comment/thread/reply and Linear pages, including feedback past 100", async () => {
  const calls = [];
  const sources = await fetchReviewFeedback({ owner: "fixture", repo: "repository", number: 1, issueIdentifier: "TEST-1",
    githubQuery: async (query, vars) => {
      calls.push({ query, vars });
      if (query.includes("commits(first")) return { data: { repository: { pullRequest: { commits: page([]) } } } };
      if (query.includes("ThreadReplies")) {
        assert.equal(vars.id, "thread1"); assert.equal(vars.after, "reply100");
        return { data: { node: { comments: page([record("late-inline-reply")]) } } };
      }
      const connection = ["reviews", "reviewThreads", "comments"].find(name => query.includes(`${name}(first:100,after:`));
      let result;
      if (connection === "reviewThreads") result = vars.after
        ? page([{ id: "thread2", isResolved: true, isOutdated: true, comments: page([record("old-inline")]) }])
        : page([{ id: "thread1", isResolved: false, isOutdated: false,
          comments: page(Array.from({ length: 100 }, (_, i) => record(`reply${i}`)), true, "reply100") }], true, "thread1");
      else result = vars.after ? page([record(`${connection}-late`)])
        : page(Array.from({ length: 100 }, (_, i) => record(`${connection}-${i}`)), true, "100");
      return { data: { repository: { pullRequest: { [connection]: result } } } };
    },
    linearQuery: async (_, vars) => ({ data: { issue: { comments: vars.after
      ? page([record("linear-late")]) : page(Array.from({ length: 100 }, (_, i) => record(`linear-${i}`)), true, "100") } } }),
  });
  assert.ok(Object.values(sources).every(source => source.complete));
  assert.equal(sources.reviews.nodes.length, 101);
  assert.equal(sources.comments.nodes.length, 101);
  assert.equal(sources.threads.nodes.length, 102);
  assert.equal(sources.linearComments.nodes.length, 101);
  assert.equal(sources.threads.nodes[100].id, "late-inline-reply");
  assert.equal(sources.threads.nodes[101].isResolved, true);
  assert.equal(feedbackWatermark(sources).records.length, 405);
  assert.equal(calls.length, 8);
});

test("missing, denied and cyclic feedback connections remain explicitly incomplete", async () => {
  for (const mode of ["missing-cursor", "cycle", "graphql-denied", "http-denied", "missing-source"]) {
    const sources = await fetchReviewFeedback({ owner: "fixture", repo: "repo", number: 1, issueIdentifier: "TEST-1",
      githubQuery: async query => {
        if (mode === "http-denied") throw new Error("HTTP 403");
        if (mode === "graphql-denied") return { errors: [{ message: "forbidden" }] };
        const connection = ["reviews", "reviewThreads", "comments"].find(name => query.includes(`${name}(first:100,after:`));
        return { data: { repository: { pullRequest: { [connection]: mode === "missing-source" ? null
          : page([], true, mode === "cycle" ? "same" : null) } } } };
      }, linearQuery: async () => { throw new Error("HTTP 403"); },
    });
    assert.ok(Object.values(sources).every(source => source.complete === false), mode);
    assert.equal(feedbackWatermark(sources).complete, false);
  }
});

function checkStateFixture() {
  const headSha = "a".repeat(40), baseSha = "b".repeat(40), configRevision = "c".repeat(40);
  const feedback = emptySources();
  const gen = createReviewGeneration({ repositoryId: 1, prNumber: 1, headSha, baseSha, configRevision,
    feedback: feedbackWatermark(feedback) });
  const output = { schema: "cadence-review/v1", repositoryId: 1, prNumber: 1, headSha,
    generationId: gen.id, summary: "Reviewed", sourcesComplete: true,
    requirements: [{ id: "R05", summary: "gate", status: "satisfied", evidence: [] }], findings: [], humanFeedback: [] };
  const state = completeReviewGeneration(queueReviewGeneration(null, gen, { checkId: 10 }),
    { generationId: gen.id, attempt: 1, checkId: 10, phase: "completed", output }, gen);
  return { target: { repository_id: 1, prNumber: 1, headSha, configRevision, issueId: "issue",
    apps: { cadence: { app_id: 4866513 } }, labels: ["pink", "symphony"] },
    pullRequest: { number: 1, state: "open", head: { sha: headSha }, base: { sha: baseSha, repo: { id: 1 } },
      labels: [{ name: "pink" }, { name: "symphony" }], draft: true }, feedback,
    checks: [{ id: 10, name: "Cadence Review", app: { id: 4866513 }, head_sha: headSha,
      status: "completed", conclusion: "success", external_id: reviewExternalId(state) }],
    workpad: { commentId: "comment", issueId: "issue", reviewContract: state }, complete: true };
}

test("check-mode entry point rejects bot approval and stale same-head human feedback", () => {
  const context = checkStateFixture();
  const fresh = classifyPrReviewState(context.pullRequest, reviewer, { acceptance: context });
  assert.equal(fresh.decision, "skip"); assert.equal(fresh.reviewStatus, "fresh-check");
  context.feedback.linearComments.nodes = [record("progress", "## Codex Workpad\nNew timestamp")];
  assert.equal(classifyCheckReviewState(context).generation.id, fresh.generation.id);
  context.feedback.threads.nodes = [record("human-reply")];
  assert.equal(classifyCheckReviewState(context).decision, "incremental");
  assert.equal(classifyCheckReviewState(context).acceptance.passes, false);
  context.feedback.threads.complete = false;
  assert.equal(classifyCheckReviewState(context).decision, "full-review-paged-out");
  const approvalOnly = checkStateFixture(); approvalOnly.checks = [];
  approvalOnly.pullRequest.timelineItems = { nodes: [cadenceReview(undefined, { state: "APPROVED" })] };
  assert.equal(classifyCheckReviewState(approvalOnly).acceptance.passes, false);
});

test("check-mode preserves incremental and force-push full review decisions", () => {
  const context = checkStateFixture();
  context.pullRequest.head.sha = "d".repeat(40); context.target.headSha = context.pullRequest.head.sha;
  assert.equal(classifyCheckReviewState({ ...context, ancestry: "ahead" }).decision, "incremental");
  assert.equal(classifyCheckReviewState({ ...context, ancestry: "diverged" }).decision, "full-review-rebased");
  assert.equal(classifyCheckReviewState(context).decision, "full-review-rebased");
});

test("same-head base and controller configuration changes require fresh assessment", () => {
  for (const field of ["configRevision", "controllerRevision"]) {
    const context = checkStateFixture();
    const previous = classifyCheckReviewState(context);
    context.target[field] = "d".repeat(40);
    const result = classifyCheckReviewState(context);
    assert.equal(result.decision, "full-review-context-changed");
    assert.equal(result.acceptance.passes, false);
    assert.notEqual(result.generation.id, previous.generation.id);
    assert.equal(result.generation.resetKey, previous.generation.resetKey);
  }
});

test("bootstrap CLI uses host review mode without a repository registry", () => {
  const cli = new URL("./fetch-pr-review-state.mjs", import.meta.url);
  const pr = { headRefOid: "a".repeat(40), isDraft: true,
    timelineItems: { nodes: [], pageInfo: { hasPreviousPage: false } } };
  const script = `process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(cli))}, "6"];
    globalThis.fetch = async () => ({ ok: true, json: async () => (${JSON.stringify({ data: { repository: { pullRequest: pr } } })}) });
    await import(${JSON.stringify(cli.href)});`;
  for (const mode of ["", "HACKATHON_LEGACY_REVIEW", "checks", "unknown"]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", env: { ...process.env, GH_TOKEN: "fixture", REPO_SLUG: "unseen-owner/repo", CADENCE_REVIEW_MODE: mode },
    });
    if (!mode || mode === "HACKATHON_LEGACY_REVIEW") {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).decision, "first-review");
    } else {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Legacy review disabled/);
    }
  }
});

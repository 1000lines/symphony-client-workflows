import assert from "node:assert/strict";
import test from "node:test";
import { checkRequest } from "./cadence-review-check.mjs";
import {
  COMMENT_MARKER,
  publishComment,
  publishRequestComment,
  renderComment,
  reviewFooter,
  reviewMeasurements,
} from "./cadence-review-comment.mjs";

const app = { id: 42, slug: "cadence" };
const context = {
  repo: { owner: "owner", repo: "repo" },
  serverUrl: "https://github.com",
  runId: 10,
  runAttempt: 1,
};
const head = "a".repeat(40);
const request = checkRequest(context, 3, head);
function fixture() {
  const comments = [],
    checks = [],
    writes = [];
  const pr = { state: "open", head: { sha: head } };
  const check = {
    id: 1,
    app: { id: app.id },
    head_sha: head,
    external_id: request.externalId,
    status: "queued",
    output: { summary: "Review failed.\n\nDetailed bookkeeping." },
  };
  checks.push(check);
  const write = async (input) => {
    writes.push(input);
    let comment = comments.find((item) => item.id === input.comment_id);
    if (comment) comment.body = input.body;
    else {
      comment = {
        id: comments.length + 1,
        body: input.body,
        user: { login: "cadence[bot]", type: "Bot" },
        performed_via_github_app: { id: app.id },
        html_url: "https://github.com/owner/repo/pull/3#issuecomment-1",
      };
      comments.push(comment);
    }
    return { data: comment };
  };
  const github = {
    rest: {
      issues: {
        listComments: "comments",
        createComment: write,
        updateComment: write,
      },
      checks: { listForRef: "checks" },
      pulls: { get: async () => ({ data: pr }) },
    },
    paginate: async (endpoint) => (endpoint === "comments" ? comments : checks),
  };
  const publish = (details, req = request, current = check) =>
    publishComment(github, req, app, current, details);
  return { comments, checks, writes, pr, check, github, publish };
}

test("initial creation, duplicate delivery, progress, result and subsequent failure edit one App comment", async () => {
  const f = fixture();
  await f.publish();
  await f.publish();
  assert.equal(f.comments.length, 1);
  assert.equal(f.writes.length, 1);
  assert.match(f.comments[0].body, /Cadence · Queued/);
  f.check.status = "in_progress";
  await f.publish();
  assert.match(f.comments[0].body, /Cadence · Reviewing/);
  assert.ok(
    (await f.publish({}, request, { ...f.check, status: "queued" })).skipped
  );
  assert.match(f.comments[0].body, /Cadence · Reviewing/);
  f.check.status = "completed";
  f.check.conclusion = "success";
  await f.publish({
    review: {
      body: "Looks good.",
      html_url: "https://github.com/owner/repo/pull/3#pullrequestreview-4",
    },
  });
  assert.match(f.comments[0].body, /Cadence · Approved/);
  const next = checkRequest({ ...context, runAttempt: 2 }, 3, head);
  const nextCheck = {
    ...f.check,
    id: 2,
    external_id: next.externalId,
    status: "queued",
  };
  f.checks.push(nextCheck);
  await f.publish({}, next, nextCheck);
  nextCheck.status = "completed";
  nextCheck.conclusion = "failure";
  await f.publish({}, next, nextCheck);
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0].body, /Cadence · Failed/);
  assert.match(f.comments[0].body, /attempts\/2/);
  assert.ok(f.writes.slice(1).every((write) => write.comment_id === 1));
});

test("marker copies by humans and other Apps are preserved", async () => {
  const f = fixture();
  for (const user of [
    { login: "human", type: "User" },
    { login: "other[bot]", type: "Bot" },
  ])
    f.comments.push({ id: f.comments.length + 1, body: COMMENT_MARKER, user });
  f.comments.push({
    id: 3,
    body: COMMENT_MARKER,
    user: { login: "cadence[bot]", type: "Bot" },
    performed_via_github_app: { id: 99 },
  });
  await f.publish();
  assert.equal(f.comments.length, 4);
  assert.ok(
    f.comments.slice(0, 3).every((item) => item.body === COMMENT_MARKER)
  );
  assert.equal(f.writes[0].issue_number, 3);
});

test("late results, old heads, closed PRs and duplicate starts cannot replace current status", async () => {
  for (const scenario of [
    "newer-check",
    "newer-comment",
    "head",
    "closed",
    "completed",
  ]) {
    const f = fixture();
    await f.publish();
    if (scenario === "newer-check")
      f.checks.push({ ...f.check, id: 2, external_id: "cadence:11:1:3" });
    if (scenario === "newer-comment")
      f.comments[0].body = f.comments[0].body.replace("check:1", "check:2");
    if (scenario === "head") f.pr.head.sha = "b".repeat(40);
    if (scenario === "closed") f.pr.state = "closed";
    if (scenario === "completed")
      f.comments[0].body = f.comments[0].body.replace(
        "state:queued",
        "state:completed"
      );
    f.check.status = "in_progress";
    const prior = f.comments[0].body;
    const outcome = await f.publish();
    assert.ok(outcome.skipped || outcome.unchanged, scenario);
    assert.equal(f.comments[0].body, prior);
    assert.equal(f.writes.length, 1);
  }
});

test("invalid identity/correlation and multiple owned comments fail visibly", async () => {
  const f = fixture();
  await assert.rejects(
    publishComment(f.github, request, { id: 42 }, f.check),
    /minted slug/
  );
  for (const change of [
    { app: { id: 99 } },
    { external_id: "cadence:9:1:3" },
    { head_sha: "b".repeat(40) },
  ])
    await assert.rejects(
      f.publish({}, request, { ...f.check, ...change }),
      /does not match/
    );
  await f.publish();
  f.comments.push({ ...f.comments[0], id: 2 });
  await assert.rejects(f.publish(), /Multiple Cadence/);
});

test("ambiguous successful creation converges on retry; API failures stay retryable", async () => {
  const f = fixture();
  const create = f.github.rest.issues.createComment;
  f.github.rest.issues.createComment = async (input) => {
    await create(input);
    throw new Error("response lost");
  };
  await assert.rejects(f.publish(), /response lost/);
  await f.publish();
  assert.equal(f.comments.length, 1);
  f.check.status = "completed";
  f.github.rest.issues.updateComment = async () => {
    throw new Error("403 denied");
  };
  await assert.rejects(f.publish(), /403 denied/);
  assert.match(f.comments[0].body, /Queued/);
});

test("complete assessment links evidence, retains every finding, and keeps the footer last", () => {
  const f = fixture();
  f.check.status = "completed";
  f.check.conclusion = "action_required";
  const body = renderComment(request, f.check, {
    review: {
      body: "Fix the retry.\n\n- first\n- second\n- third\n- fourth",
      html_url: "https://github.com/owner/repo/pull/3#pullrequestreview-4",
    },
    measurements: {
      model: "observed",
      requestedModel: "requested",
      durationMs: 1234,
      usage: { input: 12, output: 0 },
    },
  });
  assert.match(body, /Needs attention/);
  assert.match(body, /Fix the retry/);
  assert.match(body, /fourth/);
  assert.doesNotMatch(body, /Detailed bookkeeping/);
  assert.match(body, /Review and evidence/);
  assert.ok(
    body.endsWith(
      "Model: observed · Requested model: requested · Review: 1.2s · Tokens (input: 12, output: 0)"
    )
  );
  assert.ok(
    renderComment(request, f.check, {
      review: { body: "x".repeat(10000) },
    }).includes("x".repeat(10000))
  );
});

test("only measured telemetry is shown, including zero usage and observed/requested differences", () => {
  const measurements = reviewMeasurements({
    requestedModel: "requested",
    execution: [
      {
        type: "result",
        duration_ms: 1200,
        modelUsage: { observed: {} },
        usage: {
          input_tokens: 4,
          output_tokens: 0,
          cache_read_input_tokens: 7,
          cache_creation_input_tokens: 2,
        },
        result: "secret",
      },
    ],
  });
  assert.match(
    reviewFooter(measurements),
    /Model: observed · Requested model: requested · Review: 1.2s/
  );
  assert.doesNotMatch(JSON.stringify(measurements), /secret/);
  assert.match(
    reviewFooter(reviewMeasurements({ requestedModel: "codex-requested" })),
    /^Requested model: codex-requested$/
  );
  assert.equal(reviewFooter(reviewMeasurements()), "");
  assert.equal(
    reviewFooter({ durationMs: -1, usage: { input: "123", output: NaN } }),
    ""
  );
  assert.equal(
    reviewFooter(
      reviewMeasurements({
        startedAt: "2026-09-12T00:00:00Z",
        finishedAt: "2026-09-12T00:00:02Z",
      })
    ),
    "Review: 2.0s"
  );
});

function hideFixture() {
  const f = fixture();
  const review = {
    id: 7,
    node_id: "PRR_7",
    body: "Assessment: Blocked\n\n- Fix retry handling.",
    commit_id: head,
    user: { login: "cadence[bot]", type: "Bot" },
    html_url: "https://github.com/owner/repo/pull/3#pullrequestreview-7",
  };
  Object.assign(f.check, {
    status: "completed",
    conclusion: "action_required",
    details_url: review.html_url,
  });
  const node = {
    id: review.node_id,
    body: review.body,
    author: { login: "cadence[bot]" },
    commit: { oid: head },
    isMinimized: false,
    minimizedReason: null,
  };
  const mutations = [];
  f.github.rest.pulls.getReview = async () => ({ data: review });
  f.github.rest.issues.getComment = async ({ comment_id }) => ({
    data: f.comments.find((c) => c.id === comment_id),
  });
  f.github.graphql = async (query, variables) => {
    assert.equal(variables.id, review.node_id);
    if (query.includes("minimizeComment")) {
      mutations.push(variables.id);
      assert.match(query, /classifier: DUPLICATE/);
      assert.equal(f.comments.length, 1);
      assert.ok(f.comments[0].body.includes(review.body));
      node.isMinimized = true;
      node.minimizedReason = "duplicate";
      return { minimizeComment: { minimizedComment: node } };
    }
    return { node: structuredClone(node) };
  };
  return {
    ...f,
    review,
    node,
    mutations,
    run: () => publishRequestComment(f.github, request, app),
  };
}

for (const state of ["APPROVED", "COMMENTED"]) {
  test(`${state}: verify the full App comment before hiding, read back Duplicate, and converge on repeat`, async () => {
    const f = hideFixture();
    f.review.state = state;
    const original = structuredClone(f.review);
    const result = await f.run();
    assert.equal(result.hiddenReview, f.review.id);
    assert.equal(result.isMinimized, true);
    assert.equal(result.minimizedReason, "duplicate");
    await f.run();
    assert.deepEqual(f.review, original, "body, verdict and ID remain intact");
    assert.equal(f.comments.length, 1);
    assert.equal(f.writes.length, 1);
    assert.equal(f.mutations.length, 1);
  });
}

test("copy failure or failed copy readback never hides the source review", async () => {
  for (const failure of ["write", "readback"]) {
    const f = hideFixture();
    if (failure === "write")
      f.github.rest.issues.createComment = async () => {
        throw new Error("copy denied");
      };
    else
      f.github.rest.issues.getComment = async () => ({
        data: { ...f.comments[0], body: "incomplete copy" },
      });
    await assert.rejects(f.run(), /copy/);
    assert.equal(f.mutations.length, 0);
    assert.equal(f.node.isMinimized, false);
  }
});

test("hide denial and unconfirmed hide remain retryable without changing the completed comment", async () => {
  for (const failure of ["denied", "readback", "lost-response"]) {
    const f = hideFixture();
    const graphql = f.github.graphql;
    f.github.graphql = async (query, variables) => {
      if (!query.includes("minimizeComment")) return graphql(query, variables);
      if (failure === "denied") throw new Error("403 hide denied");
      if (failure === "lost-response") {
        await graphql(query, variables);
        throw new Error("response lost");
      }
      return {};
    };
    await assert.rejects(f.run(), /hide denied|not confirmed|response lost/);
    const copied = f.comments[0].body;
    f.github.graphql = graphql;
    await f.run();
    assert.equal(f.node.isMinimized, true);
    assert.equal(f.comments.length, 1);
    assert.equal(f.comments[0].body, copied);
  }
});

test("human/other reviews, changed review bodies, and stale/newer work are never hidden", async () => {
  for (const scenario of [
    "human",
    "other-app",
    "review-changed",
    "head",
    "newer",
  ]) {
    const f = hideFixture();
    if (scenario === "human") f.review.user.login = "human";
    if (scenario === "other-app") f.review.user.login = "other[bot]";
    if (scenario === "review-changed") f.node.body = "Edited assessment";
    if (scenario === "head") f.pr.head.sha = "b".repeat(40);
    if (scenario === "newer") f.checks.push({ ...f.check, id: 9 });
    if (scenario === "review-changed")
      await assert.rejects(f.run(), /review changed/);
    else await f.run();
    assert.equal(f.mutations.length, 0, scenario);
  }
});

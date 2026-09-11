import assert from "node:assert/strict";
import test from "node:test";

import { routeCadenceReviewEvent } from "./cadence-ai-review-route-event.mjs";
import { requestReviewers } from "./request-pr-reviewer.mjs";
import { authorityFetch, repository, token } from "../../../scripts/test-fixtures/review-authority.mjs";

const bot = "example-cadence-bot";
const root = "/repos/example-org/example-repo";
const pullPath = `${root}/pulls/11`;
const issuePath = `${root}/issues/11`;
const json = (payload, headers = {}) => ({
  ok: true,
  status: 200,
  headers: { get: (name) => headers[name] },
  text: async () => JSON.stringify(payload),
});

// Model GitHub state across separate, serialized workflow deliveries. Every
// delivery rereads durable API state and uses the real routing/request helpers.
const fixture = (requestActor = bot) => {
  const state = {
    pr: {
      number: 11,
      state: "open",
      title: "[100-29]: Coalesce review triggers",
      head: { sha: "head-1" },
      labels: [{ name: "symphony" }],
      user: { login: "example-symphony-bot" },
    },
    review: {
      body: "Review summary",
      updatedAt: "2026-09-11T00:59:06Z",
      submittedAt: "2026-09-11T00:59:06Z",
      state: "COMMENTED",
    },
    inline: [
      {
        databaseId: 3984970944,
        body: "Fix this",
        updatedAt: "2026-09-11T00:59:06Z",
      },
    ],
    comment: {
      id: 92,
      body: "More feedback",
      updated_at: "2026-09-11T01:00:00Z",
    },
    comments: [],
    timeline: [],
    calls: [],
    reviewers: new Set([bot, "human-reviewer"]),
    approvals: [
      { id: 10, state: "APPROVED", user: { login: bot } },
      { id: 20, state: "APPROVED", user: { login: "human-reviewer" } },
    ],
    failReceipt: false,
    failCompletion: false,
    losePostResponse: false,
    failPost: false,
    paginate: false,
    hideTimeline: false,
  };
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname + new URL(url).search;
    const method = options.method;
    const body = options.body && JSON.parse(options.body);
    state.calls.push({ path, method, body });
    if (path === pullPath) return json(state.pr);
    if (/\/reviews\/\d+$/.test(path)) return json({ node_id: "review-node" });
    if (path === "/graphql") {
      const page = state.paginate && !body.variables.after;
      return json({
        data: {
          node: {
            ...state.review,
            comments: {
              nodes: page ? [] : state.inline,
              pageInfo: { hasNextPage: page, endCursor: page ? "next" : null },
            },
          },
        },
      });
    }
    if (path === `${root}/issues/comments/92` && method === "GET")
      return json(state.comment);
    if (
      path.startsWith(`${issuePath}/comments?`) ||
      path.startsWith(`${issuePath}/timeline?`)
    ) {
      const values = path.includes("/timeline?")
        ? state.hideTimeline
          ? []
          : state.timeline
        : state.comments;
      if (state.paginate && !path.includes("page=2"))
        return json([], {
          link: `<https://api.github.com${path}&page=2>; rel="next"`,
        });
      return json(values);
    }
    if (
      path === `${issuePath}/comments` ||
      path === `${root}/issues/comments/200`
    ) {
      if (
        state.failReceipt ||
        (state.failCompletion && body.body.includes('"completed":true'))
      )
        throw new Error("Receipt write failed");
      const saved = { id: 200, body: body.body, user: { login: requestActor } };
      const index = state.comments.findIndex((comment) => comment.id === 200);
      if (index >= 0) state.comments[index] = saved;
      else state.comments.push(saved);
      return json(saved);
    }
    if (path === `${pullPath}/reviews?per_page=100`)
      return json(state.approvals);
    if (method === "PUT" && path.includes("/dismissals")) {
      const id = Number(path.split("/").at(-2));
      state.approvals.find((review) => review.id === id).state = "DISMISSED";
      return json({});
    }
    if (path === `${pullPath}/requested_reviewers?per_page=100`)
      return json({ users: [...state.reviewers].map((login) => ({ login })) });
    if (path === `${pullPath}/requested_reviewers`) {
      if (method === "DELETE")
        for (const reviewer of body.reviewers) state.reviewers.delete(reviewer);
      else if (method === "POST") {
        if (state.failPost)
          return {
            ...json({ message: "Request failed before POST was accepted" }),
            ok: false,
            status: 429,
          };
        for (const reviewer of body.reviewers) state.reviewers.add(reviewer);
        state.timeline.push({
          id: state.timeline.length + 1,
          event: "review_requested",
          actor: { login: requestActor },
          requested_reviewer: { login: bot },
        });
        if (state.losePostResponse) throw new Error("Request response lost");
      }
      return json({});
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  const options = {
    token: "bot-token",
    deleteToken: "workflow-token",
    owner: "example-org",
    repo: "example-repo",
    prNumber: 11,
    reviewers: [bot],
    dismissApprovals: true,
    fetchImpl,
    log: () => undefined,
  };
  state.deliver = async (
    eventName = "pull_request_review",
    action = eventName === "pull_request_review" ? "submitted" : "created",
    extra = {}
  ) => {
    const payload = {
      action,
      pull_request: structuredClone(state.pr),
      sender: { login: "human-reviewer" },
      review: { id: 5173909707 },
      comment: { id: 92, pull_request_review_id: 5173909707 },
      ...extra,
    };
    payload.repository = { full_name: repository };
    const user = { login: "human-reviewer", type: "User", id: 42 };
    payload.review = { user, body: state.review.body, state: state.review.state, ...payload.review };
    payload.comment = { user, body: state.comment.body, ...payload.comment };
    const route = await routeCadenceReviewEvent({
      payload,
      eventName,
      repository,
      token,
      fetchImpl: authorityFetch(payload, eventName),
      classifyActor: async () => ({
        classification: "human",
        humanFacing: true,
      }),
    });
    assert.equal(route.shouldRequestReview, true);
    return requestReviewers({
      ...options,
      eventContext: { payload, eventName, requestActor },
    });
  };
  state.manual = () => requestReviewers(options);
  state.mutations = () =>
    state.calls.filter(
      (call) =>
        call.path.endsWith("/requested_reviewers") || call.method === "PUT"
    );
  return state;
};

for (const failure of [null, "failCompletion", "losePostResponse"]) {
  test(`App-authored receipts suppress retries with a separate review account (${failure || "completed"})`, async () => {
    const state = fixture("existing-cadence[bot]");
    if (failure) {
      state[failure] = true;
      await assert.rejects(state.deliver(), /failed|lost/);
      state[failure] = false;
    } else {
      assert.equal((await state.deliver()).requested, true);
    }
    assert.equal((await state.deliver("pull_request_review_comment")).skipReason, "duplicate-review-context");
    assert.equal(state.comments[0].user.login, "existing-cadence[bot]");
    assert.equal(state.timeline[0].actor.login, "existing-cadence[bot]");
    assert.equal(state.timeline[0].requested_reviewer.login, bot);
    assert.equal(state.timeline.length, 1);
  });
}

for (const first of ["pull_request_review", "pull_request_review_comment"]) {
  test(`overlapping review/inline deliveries and retries cause one mutation cycle (${first} first)`, async () => {
    const state = fixture();
    state.paginate = true;
    assert.equal(
      (
        await state.deliver(
          first,
          first === "pull_request_review" ? "submitted" : "created"
        )
      ).requested,
      true
    );
    for (const event of [
      "pull_request_review",
      "pull_request_review_comment",
      first,
    ]) {
      assert.equal(
        (await state.deliver(event)).skipReason,
        "duplicate-review-context"
      );
    }
    assert.deepEqual(
      state.mutations().map(({ method }) => method),
      ["PUT", "DELETE", "POST"]
    );
    assert.deepEqual([...state.reviewers], ["human-reviewer", bot]);
    assert.equal(state.approvals[1].state, "APPROVED");
    assert.equal(state.comments.length, 1);
    const saveIndex = state.calls.findIndex(
      (call) => call.path === `${issuePath}/comments` && call.method === "POST"
    );
    assert.ok(
      saveIndex < state.calls.findIndex((call) => call.method === "PUT")
    );
  });
}

test("new feedback, edits (including reverted text), and new heads get fresh requests", async () => {
  const state = fixture();
  await state.deliver();
  state.inline.push({
    databaseId: 99,
    body: "New reply",
    updatedAt: "2026-09-11T01:01:00Z",
  });
  await state.deliver("pull_request_review_comment", "created");
  state.inline[0].updatedAt = "2026-09-11T01:02:00Z";
  await state.deliver("pull_request_review_comment", "edited");
  state.review.body = "Edited summary";
  state.review.updatedAt = "2026-09-11T01:03:00Z";
  await state.deliver("pull_request_review", "edited");
  state.review.body = "Review summary";
  state.review.updatedAt = "2026-09-11T01:04:00Z";
  await state.deliver("pull_request_review", "edited");
  const oldPR = structuredClone(state.pr);
  state.pr.head.sha = "head-2";
  await state.deliver();
  assert.equal(
    (await state.deliver("pull_request_review_comment")).skipReason,
    "duplicate-review-context"
  );
  assert.equal(
    (
      await state.deliver("pull_request_review", "submitted", {
        pull_request: oldPR,
      })
    ).skipReason,
    "stale-event-head"
  );
  assert.equal(state.timeline.length, 6);
});

test("interleaved contexts retain receipts and issue-comment edits are not suppressed", async () => {
  const state = fixture();
  await state.deliver();
  const issue = { ...state.pr, pull_request: { url: pullPath } };
  await state.deliver("issue_comment", "created", {
    pull_request: undefined,
    issue,
  });
  assert.equal((await state.deliver()).skipReason, "duplicate-review-context");
  await state.deliver("issue_comment", "created", {
    pull_request: undefined,
    issue,
  });
  state.comment.updated_at = "2026-09-11T01:05:00Z";
  await state.deliver("issue_comment", "edited", {
    pull_request: undefined,
    issue,
  });
  await state.deliver("pull_request_review", "submitted", {
    review: { id: 5173909708 },
  });
  assert.equal(state.timeline.length, 4);
});

test("late duplicate delivery preserves a completed Cadence approval", async () => {
  const state = fixture();
  await state.deliver();
  state.reviewers.delete(bot);
  state.approvals.push({ id: 30, state: "APPROVED", user: { login: bot } });
  assert.equal(
    (await state.deliver("pull_request_review_comment")).skipReason,
    "duplicate-review-context"
  );
  assert.equal(state.approvals.at(-1).state, "APPROVED");
  assert.deepEqual([...state.reviewers], ["human-reviewer"]);
  assert.equal(state.timeline.length, 1);
});

test("head-event retries coalesce, ready-for-review and explicit manual requests still run", async () => {
  const state = fixture();
  await state.deliver("pull_request_target", "opened");
  await state.deliver("pull_request_target", "opened");
  await state.deliver("pull_request_target", "ready_for_review");
  state.pr.head.sha = "head-2";
  await state.deliver("pull_request_target", "synchronize");
  await state.deliver("pull_request_target", "synchronize");
  await state.manual();
  assert.equal(state.timeline.length, 4);
});

for (const failure of ["failCompletion", "losePostResponse"]) {
  test(`retry recovers a successful request after ${failure}`, async () => {
    const state = fixture();
    state.paginate = true;
    state[failure] = true;
    await assert.rejects(state.deliver(), /failed|lost/);
    state[failure] = false;
    assert.equal(
      (await state.deliver("pull_request_review_comment")).skipReason,
      "duplicate-review-context"
    );
    assert.deepEqual(
      state.mutations().map(({ method }) => method),
      ["PUT", "DELETE", "POST"]
    );
  });
}

test("a failed receipt write prevents reviewer mutations, and a failed POST can retry", async () => {
  const state = fixture();
  state.failReceipt = true;
  await assert.rejects(state.deliver(), /Receipt write failed/);
  assert.equal(state.mutations().length, 0);
  state.failReceipt = false;
  state.failPost = true;
  await assert.rejects(state.deliver(), /Request failed/);
  state.failPost = false;
  assert.equal((await state.deliver()).requested, true);
  assert.equal(state.timeline.length, 1);
  assert.equal(
    state.mutations().filter((call) => call.method === "DELETE").length,
    1
  );
});

test("an ambiguous POST without timeline confirmation fails closed until evidence arrives", async () => {
  const state = fixture();
  state.losePostResponse = true;
  await assert.rejects(state.deliver(), /Request response lost/);
  state.losePostResponse = false;
  state.hideTimeline = true;
  await assert.rejects(state.deliver(), /outcome is unconfirmed/);
  assert.deepEqual(
    state.mutations().map(({ method }) => method),
    ["PUT", "DELETE", "POST"]
  );
  state.hideTimeline = false;
  assert.equal((await state.deliver()).skipReason, "duplicate-review-context");
});

test("untrusted markers are ignored and unreadable submitted review data fails closed", async () => {
  const state = fixture();
  state.comments.push({
    id: 55,
    user: { login: "human-reviewer" },
    body: "<!-- cadence-review-request-receipts:v1\nmalformed",
  });
  state.review.submittedAt = null;
  await assert.rejects(state.deliver(), /Cannot read submitted review context/);
  assert.equal(state.mutations().length, 0);
  state.review.submittedAt = "2026-09-11T00:59:06Z";
  assert.equal((await state.deliver()).requested, true);
  assert.equal(state.comments.length, 2);
});

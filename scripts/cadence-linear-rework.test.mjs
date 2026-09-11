import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { authorityFetch, repository, token as appToken } from "./test-fixtures/review-authority.mjs";
import { resolveCadenceEvent } from "../.github/workflows/scripts/cadence-forwarded-event.mjs";
import { routeCadenceReviewEvent } from "../.github/workflows/scripts/cadence-ai-review-route-event.mjs";
import {
  parseCadenceWorkpad,
  renderCadenceWorkpad,
} from "./cadence-linear-workpad.mjs";

import {
  classifyCadenceLinearReworkEvent,
  humanReviewRequestFromAssignees,
  renderReviewHandoffEvidence,
  requestHumanReview,
  routeReviewHandoff,
} from "./cadence-linear-rework.mjs";

const payload = ({ review = {}, pullRequest = {} } = {}) => ({
  action: "submitted",
  sender: review.user || { login: "example-cadence-bot" },
  review: {
    id: 92,
    state: "commented",
    body: "Assessment: Blocked\n\nRequired follow-up:\n- Fix the issue.",
    user: { login: "example-cadence-bot" },
    ...review,
  },
  repository: { full_name: "example-org/example-repo" },
  pull_request: {
    number: 3604,
    title: "[DEMO-118]: plan email fast follow fan-out",
    body: "Implements DEMO-118.",
    state: "open",
    user: { login: "example-symphony-bot" },
    labels: [{ name: "symphony" }],
    assignees: [{ login: "example-lead" }],
    head: {
      ref: "symphony/sample-review/DEMO-118/plan-project",
      sha: "head-sha",
    },
    ...pullRequest,
  },
});

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body,
});

const commentPayload = ({
  comment = {},
  issue = {},
  action = "created",
} = {}) => {
  const { repository, pull_request } = payload();
  return {
    repository,
    action,
    sender: { login: "example-lead", type: "User" },
    issue: {
      number: pull_request.number,
      title: pull_request.title,
      state: pull_request.state,
      user: pull_request.user,
      labels: pull_request.labels,
      pull_request: {
        url: "https://api.github.com/repos/example-org/example-repo/pulls/3604",
      },
      ...issue,
    },
    comment: {
      id: 93,
      body: "Please fix the retry limit.",
      user: { id: 42, type: "User", login: "example-lead" },
      ...comment,
    },
  };
};

test("Cadence commented reviews with content on Symphony PRs require Linear Active", () => {
  const decision = classifyCadenceLinearReworkEvent({ payload: payload() });

  assert.equal(decision.shouldMove, true);
  assert.equal(decision.shouldRequestHumanReview, false);
  assert.equal(decision.reason, "cadence-review-actionable-content");
  assert.equal(decision.issueIdentifier, "DEMO-118");
  assert.equal(decision.prNumber, "3604");
});

test("Cadence human-input comments request human review without Linear Active", () => {
  const decision = classifyCadenceLinearReworkEvent({
    payload: payload({
      review: {
        state: "commented",
        body: "Assessment: Human input needed\n\nDecision needed:\n- Please confirm the design direction.",
      },
    }),
  });

  assert.equal(decision.shouldMove, false);
  assert.equal(decision.shouldRequestHumanReview, true);
  assert.equal(decision.reason, "cadence-review-human-input-needed");
});

test("Cadence commented reviews without content do not require Linear Active", () => {
  const decision = classifyCadenceLinearReworkEvent({
    payload: payload({
      review: {
        state: "commented",
        body: "",
      },
    }),
  });

  assert.equal(decision.shouldMove, false);
  assert.equal(decision.shouldRequestHumanReview, false);
  assert.equal(decision.reason, "cadence-review-no-new-content");
});

test("normal Cadence approvals request human review without Linear Active", () => {
  const decision = classifyCadenceLinearReworkEvent({
    payload: payload({
      review: {
        state: "approved",
        body: "Assessment: Approve\n\nWhy this is acceptable:\nLooks good.",
      },
    }),
  });

  assert.equal(decision.shouldMove, false);
  assert.equal(decision.shouldRequestHumanReview, true);
  assert.equal(decision.reason, "cadence-review-approved");
});

test("Cadence approvals with suggestions stay advisory and request human review", () => {
  const decision = classifyCadenceLinearReworkEvent({
    payload: payload({
      review: {
        state: "approved",
        body: "Assessment: Approve\n\nSuggestions:\n- Consider updating docs.",
      },
    }),
  });

  assert.equal(decision.shouldMove, false);
  assert.equal(decision.shouldRequestHumanReview, true);
  assert.equal(decision.reason, "cadence-review-approved");
});

test("Cadence approvals with non-blocking notes stay advisory and request human review", () => {
  const decision = classifyCadenceLinearReworkEvent({
    payload: payload({
      review: {
        state: "approved",
        body: "Assessment: Approve\n\nNon-blocking notes:\n- Align predicates if this file is revisited.",
      },
    }),
  });

  assert.equal(decision.shouldMove, false);
  assert.equal(decision.shouldRequestHumanReview, true);
  assert.equal(decision.reason, "cadence-review-approved");
});

test("Cadence approvals with human-needed findings request human review", () => {
  const decision = classifyCadenceLinearReworkEvent({
    payload: payload({
      review: {
        state: "approved",
        body: "Assessment: Approve\n\nDecision needed:\n- Confirm whether to keep the existing shape.",
      },
    }),
  });

  assert.equal(decision.shouldMove, false);
  assert.equal(decision.shouldRequestHumanReview, true);
  assert.equal(decision.reason, "cadence-review-human-input-needed");
});

test("human review requests target eligible PR assignees only", () => {
  const request = humanReviewRequestFromAssignees([
    "example-lead",
    "example-symphony-bot",
    "example-cadence-bot",
    "dependabot[bot]",
    "EXAMPLE-LEAD",
  ]);

  assert.equal(request.shouldRequest, true);
  assert.deepEqual(request.reviewers, ["example-lead"]);
  assert.equal(request.target, "PR assignee(s) example-lead");
  assert.equal(request.warning, "");
});

test("human review requests do not fall back to broad human teams", () => {
  const request = humanReviewRequestFromAssignees([
    "example-symphony-bot",
    "example-cadence-bot",
    "some-app[bot]",
  ]);

  assert.equal(request.shouldRequest, false);
  assert.deepEqual(request.reviewers, []);
  assert.equal(request.target, "no eligible PR assignee");
  assert.match(request.warning, /PR assignee/);
  assert.doesNotMatch(request.warning, /team/i);
});

test("Cadence approvals with required follow-up still require Linear Active", () => {
  const decision = classifyCadenceLinearReworkEvent({
    payload: payload({
      review: {
        state: "approved",
        body: "Assessment: Approve\n\nRequired follow-up:\n- Update docs.",
      },
    }),
  });

  assert.equal(decision.shouldMove, true);
  assert.equal(decision.shouldRequestHumanReview, false);
  assert.equal(decision.reason, "cadence-review-actionable-content");
});

test("human commented reviews with content require Linear Active", () => {
  const decision = classifyCadenceLinearReworkEvent({
    payload: payload({
      review: {
        state: "commented",
        body: "LGTM - let's have @example-symphony-bot consider the Cadence suggestions.",
        user: { id: 42, type: "User", login: "example-lead" },
      },
      pullRequest: {
        labels: [{ name: "symphony" }, { name: "orange" }],
      },
    }),
  });

  assert.equal(decision.shouldMove, true);
  assert.equal(decision.shouldRequestHumanReview, false);
  assert.equal(decision.reason, "human-review-actionable-content");
});

test("human changes-requested reviews require Linear Active even without a body", () => {
  const decision = classifyCadenceLinearReworkEvent({
    payload: payload({
      review: {
        state: "changes_requested",
        body: "",
        user: { id: 42, type: "User", login: "example-lead" },
      },
    }),
  });

  assert.equal(decision.shouldMove, true);
  assert.equal(decision.reason, "human-review-actionable-content");
});

test("human approvals do not require Linear Active", () => {
  const decision = classifyCadenceLinearReworkEvent({
    payload: payload({
      review: {
        state: "approved",
        body: "LGTM",
        user: { id: 42, type: "User", login: "example-lead" },
      },
    }),
  });

  assert.equal(decision.shouldMove, false);
  assert.equal(decision.reason, "human-review-approved-with-notes");
  assert.equal(decision.cadenceReviewWorkflow, "cadence-ai-review-events.yml");
});

test("generic bot reviews do not require Linear Active", () => {
  const decision = classifyCadenceLinearReworkEvent({
    payload: payload({
      review: {
        state: "commented",
        body: "Automated note.",
        user: { login: "some-app[bot]" },
      },
    }),
  });

  assert.equal(decision.shouldMove, false);
  assert.equal(decision.reason, "non-human-review");
});

test("non-Symphony PRs are ignored", () => {
  const decision = classifyCadenceLinearReworkEvent({
    payload: payload({ pullRequest: { labels: [{ name: "cyan" }] } }),
  });

  assert.equal(decision.shouldMove, false);
  assert.equal(decision.reason, "missing-symphony-label");
});

test("Cadence human-review workflows do not request broad teams", () => {
  const workflowPaths = [
    new URL("../.github/workflows/cadence-linear-rework.yml", import.meta.url),
    new URL(
      "../.github/workflows/cadence-ai-review-trigger.yml",
      import.meta.url
    ),
  ];

  for (const workflowPath of workflowPaths) {
    const workflow = readFileSync(workflowPath, "utf8");
    assert.doesNotMatch(workflow, /team_reviewers/);
    assert.doesNotMatch(workflow, /CADENCE_HUMAN_REVIEW_TEAM/);
    assert.match(
      workflow,
      /ASSIGNEES_JSON|assignees|node scripts\/cadence-linear-rework.mjs/
    );
  }
});

test("Cadence review-request trigger stays wired for Cadence self requests", () => {
  const workflow = readFileSync(
    new URL(
      "../.github/workflows/cadence-ai-review-trigger.yml",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(workflow, /types:\s*\[[^\]]*\breview_requested\b[^\]]*\]/);
  assert.match(
    workflow,
    /github\.event\.requested_reviewer\.login == \(vars\.CADENCE_REVIEWER \|\| 'example-cadence-bot'\)/
  );
  assert.match(workflow, /github\.actor == \(vars\.CADENCE_REVIEWER \|\| 'example-cadence-bot'\)/);
});

const runUrl = "https://github.com/example-org/example-repo/actions/runs/123";
const harness = ({
  state = "Inactive",
  noWorkpad = false,
  failWrite = false,
  failMutation = false,
} = {}) => {
  const requests = [];
  const comments = [
    { id: "engine-pad", body: "## Symphony Workpad\nEngine-owned" },
  ];
  if (!noWorkpad)
    comments.push({
      id: "cadence-pad",
      body: renderCadenceWorkpad({
        lastReviewedSha: "existing-reviewed-head",
        summary: "Existing reviewer assessment",
        coordination: { existingSignal: "keep" },
      }),
    });
  const issue = {
    id: "issue-id",
    identifier: "DEMO-118",
    state: { id: "previous-id", name: state },
    team: { states: { nodes: [{ id: "active-id", name: "Active" }] } },
  };
  const fetchImpl = async (url, options) => {
    if (url.startsWith("https://api.github.com") && !options.body) {
      requests.push({ url, method: "GET" });
      return jsonResponse(payload().pull_request);
    }
    const request = JSON.parse(options.body);
    requests.push({ url, ...request });
    if (url.startsWith("https://api.github.com"))
      return jsonResponse({
        requested_reviewers: [{ login: "example-lead" }],
      });
    if (request.query.includes("query LinearWakeupIssue"))
      return jsonResponse({ data: { issue } });
    if (request.query.includes("query CadenceWorkpadIssue"))
      return jsonResponse({
        data: { issue: { ...issue, comments: { nodes: comments } } },
      });
    if (request.query.includes("commentCreate")) {
      comments.push({ id: "cadence-pad", body: request.variables.body });
      return jsonResponse({
        data: {
          commentCreate: { success: true, comment: { id: "cadence-pad" } },
        },
      });
    }
    if (request.query.includes("commentUpdate")) {
      assert.equal(request.variables.id, "cadence-pad");
      if (failWrite)
        return jsonResponse({ data: { commentUpdate: { success: false } } });
      comments.find((comment) => comment.id === "cadence-pad").body =
        request.variables.body;
      return jsonResponse({
        data: {
          commentUpdate: { success: true, comment: { id: "cadence-pad" } },
        },
      });
    }
    if (request.query.includes("issueUpdate")) {
      return jsonResponse({
        data: {
          issueUpdate: {
            success: !failMutation,
            issue: { ...issue, state: { id: "active-id", name: "Active" } },
          },
        },
      });
    }
    throw new Error(`Unexpected request: ${request.query}`);
  };
  return { requests, comments, fetchImpl };
};

const route = (fixture, event = payload()) =>
  routeReviewHandoff({
    payload: event,
    eventName: event.issue ? "issue_comment" : "pull_request_review",
    token: "linear-token",
    githubToken: appToken,
    repository,
    runUrl,
    fetchImpl: authorityFetch(event, event.issue ? "issue_comment" : "pull_request_review", fixture.fetchImpl),
  });

test("actionable review wakes Active and records mutation evidence in the pinned workpad and summary", async () => {
  const fixture = harness({ noWorkpad: true });
  const result = await route(fixture);
  assert.equal(result.operation, "updated");
  assert.deepEqual(result.mutation, {
    issueId: "issue-id",
    stateId: "active-id",
    success: true,
  });
  const workpad = fixture.comments.find(
    (comment) => comment.id === "cadence-pad"
  ).body;
  const summary = renderReviewHandoffEvidence(result);
  for (const evidence of [workpad, summary]) {
    for (const value of [
      "example-cadence-bot",
      "DEMO-118",
      "3604",
      "head-sha",
      "92",
      "Inactive",
      "Active",
      runUrl,
    ]) {
      assert.ok(evidence.includes(value), `Missing evidence: ${value}`);
    }
  }
  assert.equal(fixture.comments[0].body, "## Symphony Workpad\nEngine-owned");
  const mutationIndex = fixture.requests.findIndex((request) =>
    request.query?.includes("issueUpdate")
  );
  assert.ok(
    fixture.requests
      .slice(0, mutationIndex)
      .some((request) => request.query?.includes("commentUpdate"))
  );
});

for (const review of [
  {
    state: "commented",
    body: "Assessment: Human input needed\nDecision needed: confirm scope",
  },
  {
    state: "commented",
    body: "Delta addendum — `dfb2faa` → `fd583e9b`. Assessment unchanged: Human input needed.\n\nStill the only thing blocking an approve is the scope question, not a defect in this PR.",
  },
  { state: "approved", body: "Assessment: Approve" },
]) {
  test(`Cadence ${review.state} human handoff requests assignees and preserves Linear state`, async () => {
    const fixture = harness();
    const result = await route(fixture, payload({ review }));
    assert.equal(result.state, "Inactive");
    assert.equal(result.humanReview.operation, "requested");
    assert.deepEqual(
      fixture.requests.find((request) => request.url.includes("api.github.com"))
        .reviewers,
      ["example-lead"]
    );
    assert.equal(
      fixture.requests.some((request) =>
        request.query?.includes("issueUpdate")
      ),
      false
    );
  });
}

for (const action of ["created", "edited"]) {
  test(`human PR comment ${action} wakes directly with current PR metadata and durable evidence`, async () => {
    const fixture = harness();
    const event = commentPayload({ action });
    if (action === "edited") event.sender.login = "human-editor";
    // The webhook issue title may be stale; routing must use the fetched PR.
    event.issue.title = "[DEMO-999]: stale title";
    const result = await route(fixture, event);
    assert.equal(result.operation, "updated");
    assert.equal(result.issueIdentifier, "DEMO-118");
    assert.equal(result.reason, "human-pr-comment-actionable-content");
    assert.equal(result.reviewId, "");
    assert.equal(result.commentId, "93");
    assert.equal(result.triggerSource, `issue_comment.${action}`);
    assert.equal(result.state, "Active");
    assert.equal(fixture.requests[0].method, "GET");
    assert.equal(
      fixture.requests[0].url,
      "https://api.github.com/repos/example-org/example-repo/pulls/3604"
    );
    assert.equal(
      fixture.requests.filter((request) =>
        request.url.includes("api.github.com")
      ).length,
      1
    );
    const recorded = parseCadenceWorkpad(fixture.comments[1].body).coordination
      .reviewHandoff;
    assert.deepEqual(recorded, result);
    for (const value of [
      event.comment.user.login,
      "DEMO-118",
      "3604",
      "head-sha",
      "93",
      "Inactive",
      "Active",
      runUrl,
    ]) {
      assert.ok(renderReviewHandoffEvidence(result).includes(value));
    }
  });
}

for (const login of [
  "example-cadence-bot",
  "example-symphony-bot",
  "dependabot[bot]",
  "claude[bot]",
  "some-app[bot]",
]) {
  test(`PR comments from ${login} never wake or request a review`, async () => {
    const fixture = harness();
    const event = commentPayload({
      comment: { user: { login }, body: "Assessment: Human input needed" },
    });
    const result = await route(fixture, event);
    assert.equal(result.skippedReason, "non-human-comment");
    assert.equal(fixture.requests.length, 0);
  });
}

for (const sender of [
  { login: "example-symphony-bot", type: "User" },
  { login: "example-cadence-bot", type: "User" },
  { login: "generic-app", type: "Bot" },
]) {
  test(`${sender.login} edits to human PR comments do not wake the issue`, async () => {
    const fixture = harness();
    const event = commentPayload({ action: "edited" });
    event.sender = sender;
    const result = await route(fixture, event);
    assert.equal(result.skippedReason, "non-human-comment");
    assert.equal(fixture.requests.length, 0);
  });
}

for (const [name, options, reason] of [
  [
    "ordinary GitHub issue",
    { issue: { pull_request: undefined } },
    "event-is-not-a-pr",
  ],
  [
    "empty comment",
    { comment: { body: "  " } },
    "human-pr-comment-no-new-content",
  ],
  ["deleted comment", { action: "deleted" }, "unsupported-comment-action"],
  [
    "human-authored PR",
    { issue: { user: { id: 42, type: "User", login: "example-lead" } } },
    "pr-not-symphony-authored",
  ],
  ["unlabeled PR", { issue: { labels: [] } }, "missing-symphony-label"],
]) {
  test(`${name} skips before fetching or mutating`, async () => {
    const fixture = harness();
    const result = await route(fixture, commentPayload(options));
    assert.equal(result.skippedReason, reason);
    assert.equal(fixture.requests.length, 0);
  });
}

for (const [change, reason] of [
  [{ state: "closed" }, "pr-not-open"],
  [{ labels: [] }, "missing-symphony-label"],
  [{ user: { id: 42, type: "User", login: "example-lead" } }, "pr-not-symphony-authored"],
]) {
  test(`fetched PR metadata reapplies ${reason} before Linear access`, async () => {
    let calls = 0;
    const result = await routeReviewHandoff({
      payload: commentPayload(),
      eventName: "issue_comment",
      githubToken: appToken,
    repository,
      token: "linear-token",
      runUrl,
      fetchImpl: authorityFetch(commentPayload(), "issue_comment", async (url) => {
        assert.match(
          url,
          /api.github.com\/repos\/example-org\/example-repo\/pulls\/3604$/
        );
        calls++;
        return jsonResponse({ ...payload().pull_request, ...change });
      }),
    });
    assert.equal(result.skippedReason, reason);
    assert.equal(calls, 1);
  });
}

test("PR comment fetch failures retain event context and fail before Linear mutations", async () => {
  for (const response of [
    jsonResponse({}, { ok: false, status: 403 }),
    jsonResponse({ ...payload().pull_request, number: 1234 }),
    jsonResponse({ ...payload().pull_request, head: {} }),
    jsonResponse({
      ...payload().pull_request,
      title: "unlinked",
      head: { ref: "unlinked", sha: "head-sha" },
    }),
  ]) {
    let calls = 0;
    const result = await routeReviewHandoff({
      payload: commentPayload(),
      eventName: "issue_comment",
      githubToken: appToken,
    repository,
      token: "linear-token",
      runUrl,
      fetchImpl: authorityFetch(commentPayload(), "issue_comment", async (url) => {
        assert.match(url, /api.github.com/);
        calls++;
        return response;
      }),
    });
    assert.equal(result.operation, "failed");
    assert.equal(result.actor, "example-lead");
    assert.equal(result.prNumber, "3604");
    assert.equal(result.commentId, "93");
    assert.equal(result.runUrl, runUrl);
    assert.equal(calls, 1);
  }
});

test("PR comments preserve Canceled and record the skip", async () => {
  const fixture = harness({ state: "Canceled" });
  const result = await route(fixture, commentPayload());
  assert.equal(result.state, "Canceled");
  assert.equal(result.skippedReason, "terminal-state:Canceled");
  assert.equal(
    fixture.requests.some((request) => request.query?.includes("issueUpdate")),
    false
  );
  assert.match(fixture.comments[1].body, /terminal-state:Canceled/);
});

test("human-needed output with no assignee records an explicit gap", async () => {
  const fixture = harness();
  const result = await route(
    fixture,
    payload({
      review: { body: "Assessment: Human input needed" },
      pullRequest: { assignees: [] },
    })
  );
  assert.equal(result.humanReview.reason, "no-eligible-pr-assignee");
  assert.equal(
    fixture.requests.some((request) => request.url.includes("api.github.com")),
    false
  );
  assert.match(fixture.comments[1].body, /no-eligible-pr-assignee/);
});

for (const body of [
  "Required follow-up: fix bug",
  "Assessment: Human input needed",
]) {
  test(`Canceled skips review mutations for ${body}`, async () => {
    const fixture = harness({ state: "Canceled" });
    const result = await route(fixture, payload({ review: { body } }));
    assert.equal(result.operation, "skipped");
    assert.equal(result.skippedReason, "terminal-state:Canceled");
    assert.equal(
      fixture.requests.some(
        (request) =>
          request.query?.includes("issueUpdate") ||
          request.url.includes("api.github.com")
      ),
      false
    );
    assert.match(fixture.comments[1].body, /terminal-state:Canceled/);
  });
}

test("missing workpad write access fails closed before a state or review mutation", async () => {
  const fixture = harness({ failWrite: true });
  const result = await route(fixture);
  assert.equal(result.operation, "failed");
  assert.match(result.error, /pinned Cadence workpad/);
  assert.equal(
    fixture.requests.some(
      (request) =>
        request.query?.includes("issueUpdate") ||
        request.url.includes("api.github.com")
    ),
    false
  );
});

test("failed Linear mutation is recorded without claiming Active", async () => {
  const fixture = harness({ failMutation: true });
  const result = await route(fixture);
  assert.equal(result.operation, "failed");
  assert.equal(result.state, "Inactive");
  assert.match(fixture.comments[1].body, /did not confirm/);
});

test("missing linked issue ignores incidental title and body mentions and fails without mutation", async () => {
  const fixture = harness();
  const result = await route(
    fixture,
    payload({
      pullRequest: {
        title: "Follow up on DEMO-999",
        body: "DEMO-999",
        head: { ref: "unlinked", sha: "head-sha" },
      },
    })
  );
  assert.equal(result.operation, "failed");
  assert.match(result.error, /no linked Linear issue/);
  assert.equal(fixture.requests.length, 0);
});

test("issue lookup uses title prefix, then branch, matching the Cadence event router", () => {
  const fromBranch = classifyCadenceLinearReworkEvent({
    payload: payload({
      pullRequest: { title: "Fix referenced DEMO-999", body: "DEMO-999" },
    }),
  });
  assert.equal(fromBranch.issueIdentifier, "DEMO-118");
  const fromTitle = classifyCadenceLinearReworkEvent({
    payload: payload({ pullRequest: { title: "[DEMO-222]: title wins" } }),
  });
  assert.equal(fromTitle.issueIdentifier, "DEMO-222");
});

test("human approval with notes is re-requested by the event workflow without a duplicate handoff request or Linear wakeup", async () => {
  const event = payload({
    review: {
      state: "approved",
      body: "Please check the retry edge case",
      user: { id: 42, type: "User", login: "example-lead" },
    },
  });
  event.sender = { login: "example-lead" };
  const fixture = harness();
  const handoff = await route(fixture, event);
  assert.equal(handoff.shouldMove, false);
  assert.equal(handoff.cadenceReviewWorkflow, "cadence-ai-review-events.yml");
  assert.equal(fixture.requests.length, 0);
  const cadence = await routeCadenceReviewEvent({
    payload: event,
    eventName: "pull_request_review",
    token: appToken,
    repository,
    fetchImpl: authorityFetch(event, "pull_request_review"),
    classifyActor: async () => ({ classification: "human", humanFacing: true }),
  });
  assert.equal(cadence.shouldRequestReview, true);
  assert.equal(cadence.currentHeadSha, "head-sha");
  assert.equal(cadence.coalescingContextId, "92");
});

test("missing head SHA fails before writes", async () => {
  const fixture = harness();
  const result = await route(
    fixture,
    payload({ pullRequest: { head: { ref: "DEMO-118" } } })
  );
  assert.equal(result.operation, "failed");
  assert.match(result.error, /head SHA/);
  assert.equal(fixture.requests.length, 0);
});

test("human request API failure records the gap and redacts credentials", async () => {
  const fixture = harness();
  const linearFetch = fixture.fetchImpl;
  fixture.fetchImpl = (url, options) =>
    url.includes("api.github.com")
      ? Promise.resolve(
          jsonResponse(
            { message: `${appToken} denied` },
            { ok: false, status: 403 }
          )
        )
      : linearFetch(url, options);
  const result = await route(
    fixture,
    payload({ review: { body: "Assessment: Human input needed" } })
  );
  assert.equal(result.operation, "failed");
  assert.match(result.error, /HTTP 403/);
  assert.equal(JSON.stringify(result).includes(appToken), false);
  assert.match(fixture.comments[1].body, /REDACTED/);
});

test("already-requested human reviewer remains a valid human handoff", async () => {
  const result = await requestHumanReview({
    repo: "example-org/example-repo",
    prNumber: "3604",
    reviewers: ["example-lead"],
    token: "token",
    fetchImpl: async () =>
      jsonResponse(
        { message: "Review already requested" },
        { ok: false, status: 422 }
      ),
  });
  assert.equal(result.operation, "already-requested");
});

test("a cancellation during workpad writes is re-read before the wakeup", async () => {
  const fixture = harness();
  const originalFetch = fixture.fetchImpl;
  let reads = 0;
  fixture.fetchImpl = async (url, options) => {
    const response = await originalFetch(url, options);
    if (
      JSON.parse(options.body).query?.includes("query LinearWakeupIssue") &&
      ++reads > 1
    ) {
      const body = await response.json();
      body.data.issue.state = { id: "canceled-id", name: "Canceled" };
      return jsonResponse(body);
    }
    return response;
  };
  const result = await route(fixture);
  assert.equal(result.skippedReason, "terminal-state:Canceled");
  assert.equal(
    fixture.requests.some((request) => request.query?.includes("issueUpdate")),
    false
  );
});

test("verified human submitted/edited summaries wake the linked issue directly", async () => {
  for (const action of ["submitted", "edited"]) for (const review of [
    { state: "commented", body: "Fix the retry limit" },
    {
      // PR #12-style design feedback must wake work without verdict syntax.
      state: "commented",
      body: "Way too complicated. Use the server's wake:15m. Unhappy while CI is pending, Inactive on success, Active on failure.",
    },
    { state: "changes_requested", body: "" },
  ]) {
    const fixture = harness();
    const result = await route(
      fixture,
      { ...payload({ review: { ...review, user: { id: 42, type: "User", login: "example-lead" } } }), action }
    );
    assert.equal(result.operation, "updated");
    assert.equal(result.actor, "example-lead");
    assert.equal(result.state, "Active");
  }
});

test("handoff evidence preserves Cadence's current review and Symphony-owned workpads", async () => {
  const fixture = harness();
  fixture.comments.push({
    id: "codex-pad",
    body: "## Codex Workpad\nSymphony agent notes",
  });
  const before = parseCadenceWorkpad(fixture.comments[1].body);
  const result = await route(fixture);
  const after = parseCadenceWorkpad(fixture.comments[1].body);
  assert.equal(after.lastReviewedSha, before.lastReviewedSha);
  assert.equal(after.summary, before.summary);
  assert.deepEqual(after.history, before.history);
  assert.equal(after.coordination.existingSignal, "keep");
  assert.deepEqual(after.coordination.reviewHandoff, result);
  assert.equal(
    fixture.comments[2].body,
    "## Codex Workpad\nSymphony agent notes"
  );
});

for (const eventName of ["pull_request_review", "issue_comment"]) {
  test(`forwarded ${eventName} completes the existing review route and Linear handoff`, async () => {
    const event = eventName === "issue_comment" ? commentPayload() : payload({ review: {
      user: { id: 42, type: "User", login: "example-lead" }, body: "Please fix routing" } });
    const pr = { ...payload().pull_request, base: { repo: { full_name: repository } },
      head: { ...payload().pull_request.head, sha: "a".repeat(40) } };
    const feedback = { ...(event.review || event.comment), commit_id: pr.head.sha,
      submitted_at: "2026-09-11T01:00:00Z", pull_request_url: `https://api.github.com/repos/${repository}/pulls/${pr.number}`,
      issue_url: `https://api.github.com/repos/${repository}/issues/${pr.number}` };
    const source = { id: 10, event: eventName, repository: { full_name: repository },
      path: ".github/workflows/cadence-review-ingress.yml", name: "Cadence Review Ingress",
      status: "completed", conclusion: "success", actor: feedback.user,
      display_title: JSON.stringify({ event: eventName, action: event.action, number: pr.number, id: feedback.id, head: pr.head.sha }) };
    const [owner, repo] = repository.split("/");
    const resolved = await resolveCadenceEvent({
      context: { ref: "refs/heads/main", repo: { owner, repo }, payload: { workflow_run: source } },
      github: { request: async path => ({ data: path.endsWith(`/pulls/${pr.number}`) ? pr : feedback }) } });
    const fixture = harness();
    const fetchImpl = authorityFetch(resolved.payload, eventName, fixture.fetchImpl);
    const review = await routeCadenceReviewEvent({ ...resolved, repository, token: appToken, fetchImpl });
    assert.equal(review.shouldRequestReview, true);
    assert.equal(review.triggerActor, feedback.user.login);
    const handoff = await routeReviewHandoff({ ...resolved, repository, token: "linear-token", githubToken: appToken, runUrl, fetchImpl });
    assert.equal(handoff.operation, "updated");
    assert.equal(handoff.state, "Active");
    assert.equal(handoff.authority.authorId, feedback.user.id);
    assert.equal(fixture.requests.filter(r => r.query?.includes("issueUpdate")).length, 1);
    const workpad = parseCadenceWorkpad(fixture.comments.find(c => c.id === "cadence-pad").body);
    assert.equal(workpad.coordination.reviewHandoff.operation, "updated");
  });
}

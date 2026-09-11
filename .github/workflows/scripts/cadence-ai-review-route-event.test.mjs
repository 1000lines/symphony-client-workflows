import assert from "node:assert/strict";
import test from "node:test";

import { classifyGitHubActor } from "../../../scripts/github-actor-classification.mjs";
import {
  issueIdentifierForPullRequest,
  planCadenceReviewRun,
  planStaleApprovalVisibility,
  routeCadenceReviewEvent as routeEvent,
  triggerContextFromPayload,
} from "./cadence-ai-review-route-event.mjs";

import { authorityFetch, repository, token } from "../../../scripts/test-fixtures/review-authority.mjs";
const routeCadenceReviewEvent = options => routeEvent({
  ...options, repository, token,
  payload: { repository: { full_name: repository }, ...options.payload },
  fetchImpl: authorityFetch(options.payload, options.eventName),
});

const pr = (overrides = {}) => ({
  number: 3592,
  title: "[DEMO-115]: lock Cadence review triggers per PR",
  body: "Implements DEMO-115.",
  state: "open",
  merged: false,
  user: { login: "example-symphony-bot" },
  labels: [{ name: "symphony" }, { name: "blue" }],
  head: {
    ref: "symphony/sample-trigger/DEMO-115/cadence-review-triggers",
    sha: "abc123",
  },
  ...overrides,
});

const issue = (overrides = {}) => ({
  number: 3592,
  title: "[DEMO-115]: lock Cadence review triggers per PR",
  body: "Implements DEMO-115.",
  state: "open",
  user: { login: "example-symphony-bot" },
  labels: [{ name: "symphony" }, { name: "blue" }],
  pull_request: {},
  ...overrides,
});

const classifyActor = async (login) => classifyGitHubActor(login);
const classifyHumanActor = async (login) => ({
  login,
  classification: "human",
  humanFacing: true,
  source: "humans-team",
});

test("requests Cadence review for Symphony synchronize pushes on bot-authored symphony PRs", async () => {
  const routed = await routeCadenceReviewEvent({
    eventName: "pull_request_target",
    actor: "example-symphony-bot",
    token: "token",
    classifyActor,
    payload: {
      action: "synchronize",
      sender: { login: "example-symphony-bot" },
      pull_request: pr(),
    },
  });

  assert.equal(routed.shouldReview, false);
  assert.equal(routed.shouldRequestReview, true);
  assert.equal(routed.prNumber, "3592");
  assert.equal(routed.skipReason, "");
  assert.equal(routed.symphonyPush, "true");
  assert.equal(routed.currentHeadSha, "abc123");
  assert.equal(routed.coalescingKey, "pr:3592:head:abc123:context:head:head");
});

test("requests Cadence review for Symphony synchronize pushes before the symphony label is applied", async () => {
  const routed = await routeCadenceReviewEvent({
    eventName: "pull_request_target",
    actor: "example-symphony-bot",
    token: "token",
    classifyActor,
    payload: {
      action: "synchronize",
      sender: { login: "example-symphony-bot" },
      pull_request: pr({ labels: [{ name: "blue" }] }),
    },
  });

  assert.equal(routed.shouldReview, false);
  assert.equal(routed.shouldRequestReview, true);
  assert.equal(routed.skipReason, "");
  assert.equal(routed.symphonyPush, "true");
});

test("requests Cadence review for Symphony PR opens before the symphony label is applied", async () => {
  const routed = await routeCadenceReviewEvent({
    eventName: "pull_request_target",
    actor: "example-symphony-bot",
    token: "token",
    classifyActor,
    payload: {
      action: "opened",
      sender: { login: "example-symphony-bot" },
      pull_request: pr({ labels: [{ name: "blue" }] }),
    },
  });

  assert.equal(routed.shouldReview, false);
  assert.equal(routed.shouldRequestReview, true);
  assert.equal(routed.skipReason, "");
  assert.equal(routed.symphonyPush, "true");
  assert.equal(routed.triggerSource, "pull_request_target.opened");
});

test("requests Cadence review for human-facing event surfaces", async (t) => {
  const cases = [
    {
      name: "issue comment",
      eventName: "issue_comment",
      action: "created",
      payload: {
        issue: issue(),
        comment: { id: 22, body: "Change the design", user: { id: 42, type: "User", login: "example-lead" } },
      },
    },
    {
      name: "PR review summary",
      eventName: "pull_request_review",
      action: "submitted",
      payload: {
        pull_request: pr(),
        review: { id: 22, body: "Change the design", user: { id: 42, type: "User", login: "example-lead" } },
      },
    },
    {
      name: "created inline review comment",
      eventName: "pull_request_review_comment",
      action: "created",
      payload: {
        pull_request: pr(),
        comment: { id: 22, body: "Change the design", user: { id: 42, type: "User", login: "example-lead" } },
      },
    },
    {
      name: "edited inline review comment",
      eventName: "pull_request_review_comment",
      action: "edited",
      payload: {
        pull_request: pr(),
        comment: { id: 22, body: "Change the design", user: { id: 42, type: "User", login: "example-lead" } },
      },
    },
    {
      name: "ready for review",
      eventName: "pull_request_target",
      action: "ready_for_review",
      payload: { pull_request: pr() },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const routed = await routeCadenceReviewEvent({
        eventName: item.eventName,
        actor: "example-lead",
        token: "token",
        classifyActor: classifyHumanActor,
        payload: {
          action: item.action,
          sender: { login: "example-lead" },
          ...item.payload,
        },
      });

      assert.equal(routed.shouldReview, false);
      assert.equal(routed.shouldRequestReview, true);
      assert.equal(routed.skipReason, "");
      assert.equal(routed.issueIdentifier, "DEMO-115");
      assert.equal(routed.actorHumanFacing, "true");
    });
  }
});

test("issue lookup prefers explicit ticket, then PR title prefix, then branch", () => {
  assert.equal(
    issueIdentifierForPullRequest({
      explicitIdentifier: "DEMO-500",
      title: "[DEMO-115]: route Cadence",
      headRef: "symphony/sample-workpad/DEMO-441/cadence-reviewer-retry",
    }),
    "DEMO-500"
  );
  assert.equal(
    issueIdentifierForPullRequest({
      title: "[DEMO-115]: route Cadence",
      headRef: "symphony/sample-workpad/DEMO-441/cadence-reviewer-retry",
    }),
    "DEMO-115"
  );
  assert.equal(
    issueIdentifierForPullRequest({
      title: "Route Cadence",
      headRef: "symphony/sample-workpad/DEMO-441/cadence-reviewer-retry",
    }),
    "DEMO-441"
  );
  assert.equal(
    issueIdentifierForPullRequest({
      title: "Route Cadence",
      headRef: "symphony/sample-workpad/cadence-reviewer-retry",
    }),
    ""
  );
});

test("pull request body issue mentions do not override branch fallback", async () => {
  const routed = await routeCadenceReviewEvent({
    eventName: "pull_request_target",
    actor: "example-symphony-bot",
    token: "token",
    classifyActor,
    payload: {
      action: "synchronize",
      sender: { login: "example-symphony-bot" },
      pull_request: pr({
        title: "Route Cadence",
        body: "Source evidence mentions DEMO-340 and DEMO-441.",
        head: {
          ref: "symphony/sample-workpad/DEMO-500/cadence-trigger-coalescing",
          sha: "abc500head",
        },
      }),
    },
  });

  assert.equal(routed.issueIdentifier, "DEMO-500");
  assert.equal(routed.currentHeadSha, "abc500head");
});

test("leaves Cadence review requests to the trigger workflow", async () => {
  const routed = await routeCadenceReviewEvent({
    eventName: "pull_request_target",
    actor: "example-lead",
    token: "token",
    classifyActor: classifyHumanActor,
    payload: {
      action: "review_requested",
      sender: { login: "example-lead" },
      requested_reviewer: { login: "example-cadence-bot" },
      pull_request: pr(),
    },
  });

  assert.equal(routed.shouldReview, false);
  assert.equal(routed.shouldRequestReview, false);
  assert.equal(routed.skipReason, "review-request-owned-by-trigger-workflow");
  assert.equal(routed.cadenceReviewer, "example-cadence-bot");
});

test("leaves Cadence synthetic review requests to the trigger workflow before labels settle", async () => {
  const routed = await routeCadenceReviewEvent({
    eventName: "pull_request_target",
    actor: "example-cadence-bot",
    token: "token",
    classifyActor,
    payload: {
      action: "review_requested",
      sender: { login: "example-cadence-bot" },
      requested_reviewer: { login: "example-cadence-bot" },
      pull_request: pr({ labels: [{ name: "blue" }] }),
    },
  });

  assert.equal(routed.shouldReview, false);
  assert.equal(routed.shouldRequestReview, false);
  assert.equal(routed.skipReason, "review-request-owned-by-trigger-workflow");
  assert.equal(routed.actorClassification, "ai_actor");
});

test("skips review requests that target someone other than Cadence", async () => {
  const routed = await routeCadenceReviewEvent({
    eventName: "pull_request_target",
    actor: "example-lead",
    token: "token",
    classifyActor: classifyHumanActor,
    payload: {
      action: "review_requested",
      sender: { login: "example-lead" },
      requested_reviewer: { login: "another-reviewer" },
      pull_request: pr(),
    },
  });

  assert.equal(routed.shouldReview, false);
  assert.equal(routed.shouldRequestReview, false);
  assert.equal(routed.skipReason, "non-cadence-review-request");
});

test("does not queue non-push Symphony bot activity", async () => {
  const routed = await routeCadenceReviewEvent({
    eventName: "issue_comment",
    actor: "example-symphony-bot",
    token: "token",
    classifyActor,
    payload: {
      action: "created",
      sender: { login: "example-symphony-bot" },
      issue: issue(),
      comment: { id: 22, body: "Automated update", user: { id: 42, type: "User", login: "example-symphony-bot" } },
    },
  });

  assert.equal(routed.shouldReview, false);
  assert.equal(routed.shouldRequestReview, false);
  assert.equal(routed.skipReason, "unverified-feedback-author");
  assert.equal(routed.actorClassification, "unknown");
});

test("known bots, dependency bots, and generic bot actors do not queue review", async (t) => {
  for (const actor of [
    "example-cadence-bot",
    "claude[bot]",
    "dependabot[bot]",
    "some-app[bot]",
  ]) {
    await t.test(actor, async () => {
      const routed = await routeCadenceReviewEvent({
        eventName: "issue_comment",
        actor,
        token: "token",
        classifyActor,
        payload: {
          action: "created",
          sender: { login: actor },
          issue: issue(),
          comment: { id: 22, body: "Automated update", user: { id: 42, type: "User", login: actor } },
        },
      });

      assert.equal(routed.shouldReview, false);
      assert.equal(routed.shouldRequestReview, false);
      assert.equal(routed.skipReason, "unverified-feedback-author");
    });
  }
});

test("closed, unlabeled, and non-Symphony PRs are explicit skips", async (t) => {
  const cases = [
    {
      name: "closed PR",
      payload: { pull_request: pr({ state: "closed" }) },
      reason: "closed-pr",
    },
    {
      name: "missing symphony label",
      payload: { pull_request: pr({ labels: [{ name: "blue" }] }) },
      reason: "missing-symphony-label",
    },
    {
      name: "non-Symphony author",
      payload: { pull_request: pr({ user: { login: "feature-author" } }) },
      reason: "non-symphony-pr",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const routed = await routeCadenceReviewEvent({
        eventName: "pull_request_target",
        actor: "example-lead",
        token: "token",
        classifyActor: classifyHumanActor,
        payload: {
          action: "review_requested",
          sender: { login: "example-lead" },
          ...item.payload,
        },
      });

      assert.equal(routed.shouldReview, false);
      assert.equal(routed.shouldRequestReview, false);
      assert.equal(routed.skipReason, item.reason);
      assert.equal(routed.issueIdentifier, "DEMO-115");
    });
  }
});

test("missing linked Linear issue is an explicit no-review route", async () => {
  const routed = await routeCadenceReviewEvent({
    eventName: "pull_request_target",
    actor: "example-lead",
    token: "token",
    classifyActor: classifyHumanActor,
    payload: {
      action: "review_requested",
      sender: { login: "example-lead" },
      pull_request: pr({
        title: "Unlinked Symphony change",
        body: "No issue identifier here.",
        head: { ref: "symphony/sample-factory/no-issue", sha: "abc123" },
      }),
    },
  });

  assert.equal(routed.shouldReview, false);
  assert.equal(routed.shouldRequestReview, false);
  assert.equal(routed.skipReason, "missing-linked-linear-issue");
});

test("review summaries and inline comments from the same submitted review share a coalescing key", () => {
  const summaryContext = triggerContextFromPayload({
    eventName: "pull_request_review",
    prNumber: 3592,
    currentHeadSha: "abc123",
    payload: {
      action: "submitted",
      review: { id: 9001 },
    },
  });
  const inlineContext = triggerContextFromPayload({
    eventName: "pull_request_review_comment",
    prNumber: 3592,
    currentHeadSha: "abc123",
    payload: {
      action: "created",
      comment: { id: 7001, pull_request_review_id: 9001 },
    },
  });

  assert.equal(summaryContext.key, inlineContext.key);
  assert.equal(summaryContext.contextKind, "review");
  assert.equal(summaryContext.contextId, "9001");
});

test("single inline comments keep their own trigger context", () => {
  const context = triggerContextFromPayload({
    eventName: "pull_request_review_comment",
    prNumber: 3592,
    currentHeadSha: "abc123",
    payload: {
      action: "created",
      comment: { id: 7001 },
    },
  });

  assert.equal(context.key, "pr:3592:head:abc123:context:review:7001");
});

test("single PR comments keep their own trigger context", () => {
  const context = triggerContextFromPayload({
    eventName: "issue_comment",
    prNumber: 3592,
    currentHeadSha: "abc123",
    payload: {
      action: "created",
      comment: { id: 7100 },
    },
  });

  assert.equal(context.key, "pr:3592:head:abc123:context:pr-comment:7100");
  assert.equal(context.contextKind, "pr-comment");
  assert.equal(context.contextId, "7100");
});

test("loop cap escalates agent continuation to human review", () => {
  const plan = planCadenceReviewRun({
    hasSymphonyLabel: true,
    reviewDecision: "incremental",
    currentCadenceRun: 3,
    triggerActor: "example-symphony-bot",
    triggerSource: "pull_request_target.synchronize",
  });

  assert.equal(plan.run_claude, "false");
  assert.equal(plan.request_human_review, "true");
  assert.equal(plan.review_state, "cadence-loop-cap-3");
  assert.equal(plan.pending_trigger_state, "human-review-requested");
  assert.equal(plan.skipped_reason, "cadence-review-loop-cap");
  assert.match(plan.human_review_reason, /loop cap 3/);
});

test("human feedback resets the cadence loop at the cap", () => {
  const plan = planCadenceReviewRun({
    hasSymphonyLabel: true,
    reviewDecision: "incremental",
    humanGroundedCount: 1,
    currentCadenceRun: 3,
    triggerActor: "example-lead",
    triggerSource: "issue_comment.created",
  });

  assert.equal(plan.run_claude, "true");
  assert.equal(plan.request_human_review, "false");
  assert.equal(plan.next_cadence_label, "cadence-loop-1");
  assert.equal(plan.cadence_loop_reset, "true");
});

test("no-change quiescence requests a human next actor instead of retrying Symphony", () => {
  const plan = planCadenceReviewRun({
    hasSymphonyLabel: true,
    reviewDecision: "skip",
    currentCadenceRun: 1,
    triggerActor: "example-symphony-bot",
    triggerSource: "workflow_call",
    lastReviewSubmittedAt: "2026-07-03T16:47:03Z",
  });

  assert.equal(plan.run_claude, "false");
  assert.equal(plan.request_human_review, "true");
  assert.equal(plan.review_state, "symphony-cadence-quiescence");
  assert.equal(plan.pending_trigger_state, "human-review-requested");
  assert.equal(plan.previous_run, "2026-07-03T16:47:03Z");
});

test("review requests force a review even when the timeline state is skipped", () => {
  const plan = planCadenceReviewRun({
    hasSymphonyLabel: true,
    reviewDecision: "skip",
    currentCadenceRun: 1,
    triggerActor: "example-lead",
    triggerSource: "pull_request_target.review_requested",
  });

  assert.equal(plan.run_claude, "true");
  assert.equal(plan.force_review, "true");
  assert.equal(plan.next_cadence_label, "cadence-loop-1");
});

test("Cadence synthetic review requests can run before the symphony label is applied", () => {
  const plan = planCadenceReviewRun({
    hasSymphonyLabel: false,
    reviewDecision: "skip",
    currentCadenceRun: 0,
    triggerActor: "example-cadence-bot",
    triggerSource: "pull_request_target.review_requested",
  });

  assert.equal(plan.run_claude, "true");
  assert.equal(plan.force_review, "true");
  assert.equal(plan.next_cadence_label, "cadence-loop-1");
});

test("Symphony synchronize events force review even when timeline state lags", () => {
  const plan = planCadenceReviewRun({
    hasSymphonyLabel: true,
    reviewDecision: "skip",
    currentCadenceRun: 1,
    triggerActor: "example-symphony-bot",
    triggerSource: "pull_request_target.synchronize",
  });

  assert.equal(plan.run_claude, "true");
  assert.equal(plan.force_review, "true");
  assert.equal(plan.next_cadence_label, "cadence-loop-2");
});

test("Symphony synchronize events can run before the symphony label is applied", () => {
  const plan = planCadenceReviewRun({
    hasSymphonyLabel: false,
    reviewDecision: "skip",
    currentCadenceRun: 1,
    triggerActor: "example-symphony-bot",
    triggerSource: "pull_request_target.synchronize",
  });

  assert.equal(plan.run_claude, "true");
  assert.equal(plan.force_review, "true");
  assert.equal(plan.next_cadence_label, "cadence-loop-2");
});

test("Symphony PR open events can run before the symphony label is applied", () => {
  const plan = planCadenceReviewRun({
    hasSymphonyLabel: false,
    reviewDecision: "skip",
    currentCadenceRun: 0,
    triggerActor: "example-symphony-bot",
    triggerSource: "pull_request_target.opened",
  });

  assert.equal(plan.run_claude, "true");
  assert.equal(plan.force_review, "true");
  assert.equal(plan.next_cadence_label, "cadence-loop-1");
});

test("visible Cadence review requests satisfy stale approval visibility", () => {
  const plan = planStaleApprovalVisibility({
    dismissFailedCount: 3,
    visibleReviewRequest: true,
    rerequested: false,
  });

  assert.equal(plan.failed_count, "0");
  assert.equal(plan.visible_by, "review-request");
});

test("Cadence re-request fallback satisfies stale approval visibility", () => {
  const plan = planStaleApprovalVisibility({
    dismissFailedCount: 3,
    visibleReviewRequest: false,
    rerequested: true,
  });

  assert.equal(plan.failed_count, "0");
  assert.equal(plan.visible_by, "rerequest");
});

test("stale approval visibility fails when dismissal and re-request both fail", () => {
  const plan = planStaleApprovalVisibility({
    dismissFailedCount: 3,
    visibleReviewRequest: false,
    rerequested: false,
  });

  assert.equal(plan.failed_count, "3");
  assert.equal(plan.visible_by, "none");
});


test("recognizes numeric team identifiers in PR titles and branches", () => {
  assert.equal(issueIdentifierForPullRequest({ title: "[100-12]: first ticket" }), "100-12");
  assert.equal(issueIdentifierForPullRequest({ headRef: "symphony/hackathon/100-12/first-ticket" }), "100-12");
});

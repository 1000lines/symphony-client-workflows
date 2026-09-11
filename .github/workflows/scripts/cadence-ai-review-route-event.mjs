#!/usr/bin/env node
// Classify deterministic Cadence review-causing GitHub events. The events
// workflow intentionally sends configured PR surfaces here so linked-ticket
// outcomes are queued or recorded instead of silently dropped in YAML gates.

import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  classifyGitHubActorWithTeams,
  normalize,
  verifyReviewEventAuthority,
} from "../../../scripts/github-actor-classification.mjs";

const CADENCE_LOOP_CAP = 3;
const CADENCE_REVIEWER_LOGIN = (process.env.CADENCE_REVIEWER || "example-cadence-bot").trim().toLowerCase();
const REVIEW_FORCING_TRIGGER_SOURCES = new Set([
  "workflow_dispatch",
  "workflow_dispatch.group",
  "pull_request_target.opened",
  "pull_request_target.synchronize",
  "pull_request_target.review_requested",
  "pull_request_target.ready_for_review",
  "issue_comment.created",
  "issue_comment.edited",
  "pull_request_review.submitted",
  "pull_request_review.edited",
  "pull_request_review_comment.created",
  "pull_request_review_comment.edited",
]);

const SYMPHONY_BOT_PR_EVENT_ACTIONS = new Set(["opened", "synchronize"]);
const SYMPHONY_BOT_LABEL_RACE_TRIGGER_SOURCES = new Set([
  "pull_request_target.opened",
  "pull_request_target.synchronize",
]);
const CADENCE_REVIEW_REQUEST_TRIGGER_SOURCE =
  "pull_request_target.review_requested";

export const issueIdentifierFrom = (...values) => {
  for (const value of values) {
    const match = String(value || "").match(/\b[A-Z0-9]+-\d+\b/);
    if (match) return match[0];
  }
  return "";
};

const issueIdentifierFromTitlePrefix = (title = "") => {
  const match = String(title || "").match(/^\s*\[?([A-Z0-9]+-\d+)\]?(?::|\s|$)/);
  return match?.[1] || "";
};

const explicitIssueIdentifierFromPayload = (payload = {}) =>
  issueIdentifierFrom(
    payload.inputs?.issue_identifier,
    payload.inputs?.ticket_id,
    payload.client_payload?.issue_identifier,
    payload.client_payload?.ticket_id
  );

export const issueIdentifierForPullRequest = ({
  explicitIdentifier = "",
  title = "",
  headRef = "",
} = {}) =>
  issueIdentifierFrom(explicitIdentifier) ||
  issueIdentifierFromTitlePrefix(title) ||
  issueIdentifierFrom(headRef);

const labelNamesFrom = (labels = []) =>
  labels
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter(Boolean);

const hasLabel = (labels, required) =>
  labelNamesFrom(labels).some(
    (label) => normalize(label) === normalize(required)
  );

export const prNumberFromPayload = (payload = {}) =>
  payload.pull_request?.number ||
  (payload.issue?.pull_request ? payload.issue.number : undefined);

export const triggerContextFromPayload = ({
  payload = {},
  eventName = "",
  prNumber = prNumberFromPayload(payload),
  currentHeadSha = payload.pull_request?.head?.sha || "",
  triggerSource = `${eventName}.${payload.action || "unknown"}`,
} = {}) => {
  let contextKind = "event";
  let contextId = payload.action || "unknown";

  if (eventName === "pull_request_target") {
    if (payload.action === "review_requested") {
      contextKind = "review-request";
      contextId = payload.requested_reviewer?.login || "unknown-reviewer";
    } else {
      contextKind = "head";
      contextId = "head";
    }
  } else if (eventName === "pull_request_review") {
    contextKind = "review";
    contextId = payload.review?.id || payload.review?.node_id || "unknown";
  } else if (eventName === "pull_request_review_comment") {
    contextKind = "review";
    contextId =
      payload.comment?.pull_request_review_id ||
      payload.comment?.pull_request_review_node_id ||
      payload.comment?.id ||
      "unknown";
  } else if (eventName === "issue_comment") {
    contextKind = "pr-comment";
    contextId = payload.comment?.id || payload.comment?.node_id || "unknown";
  }

  const normalizedContextId = String(contextId || "unknown").replace(
    /\s+/g,
    "-"
  );
  const key = [
    "pr",
    prNumber || "unknown",
    "head",
    currentHeadSha || "unknown",
    "context",
    contextKind,
    normalizedContextId,
  ].join(":");

  return {
    key,
    prNumber: prNumber ? String(prNumber) : "",
    currentHeadSha,
    triggerSource,
    contextKind,
    contextId: normalizedContextId,
  };
};

export const planCadenceReviewRun = ({
  hasSymphonyLabel,
  reviewDecision,
  humanGroundedCount = 0,
  currentCadenceRun = 0,
  triggerActor = "",
  triggerSource = "",
  cadenceLoopCap = CADENCE_LOOP_CAP,
  lastReviewSubmittedAt = "",
} = {}) => {
  const triggerActorLogin = normalize(triggerActor);
  const agentActor =
    triggerActorLogin === (process.env.SYMPHONY_BOT_USER || "example-symphony-bot").trim().toLowerCase() ||
    triggerActorLogin === (process.env.CADENCE_REVIEWER || "example-cadence-bot").trim().toLowerCase();
  const humanTriggerActor = Boolean(
    triggerActorLogin && !agentActor && !triggerActorLogin.endsWith("[bot]")
  );
  const resetCadenceLoop = humanGroundedCount > 0 || humanTriggerActor;
  const forceReview = REVIEW_FORCING_TRIGGER_SOURCES.has(triggerSource);

  let runClaude = true;
  let requestHumanReview = false;
  let status = "queued";
  let reviewState = "single-pr-review";
  let pendingTriggerState = "queued by single-PR Cadence workflow";
  let previousRun = "";
  let pendingRerun = "";
  let nextCadenceLabel = "";
  let skippedReason = "";
  let humanReviewReason = "";

  const allowMissingSymphonyLabel =
    !hasSymphonyLabel &&
    ((triggerActorLogin === (process.env.SYMPHONY_BOT_USER || "example-symphony-bot").trim().toLowerCase() &&
      SYMPHONY_BOT_LABEL_RACE_TRIGGER_SOURCES.has(triggerSource)) ||
      (triggerActorLogin === (process.env.CADENCE_REVIEWER || "example-cadence-bot").trim().toLowerCase() &&
        triggerSource === CADENCE_REVIEW_REQUEST_TRIGGER_SOURCE));

  if (!hasSymphonyLabel && !allowMissingSymphonyLabel) {
    runClaude = false;
    status = "skipped";
    reviewState = "missing-required-label";
    pendingTriggerState = "ignored";
    skippedReason = "missing-required-label";
  } else if (reviewDecision === "skip" && !forceReview) {
    runClaude = false;
    requestHumanReview = true;
    status = "waiting-for-human-review";
    reviewState = "symphony-cadence-quiescence";
    pendingTriggerState = "human-review-requested";
    previousRun = lastReviewSubmittedAt || "none";
    pendingRerun = "none";
    skippedReason = "symphony-cadence-quiescence";
    humanReviewReason =
      "Symphony and Cadence reached quiescence with no review-relevant changes.";
  } else if (
    !resetCadenceLoop &&
    agentActor &&
    currentCadenceRun >= cadenceLoopCap
  ) {
    runClaude = false;
    requestHumanReview = true;
    status = "waiting-for-human-review";
    reviewState = `cadence-loop-cap-${cadenceLoopCap}`;
    pendingTriggerState = "human-review-requested";
    skippedReason = "cadence-review-loop-cap";
    humanReviewReason = `Cadence reached review-loop cap ${cadenceLoopCap}.`;
  } else {
    const nextCadenceRun = resetCadenceLoop ? 1 : currentCadenceRun + 1;
    nextCadenceLabel = `cadence-loop-${nextCadenceRun}`;
    reviewState = nextCadenceLabel;
    pendingTriggerState = resetCadenceLoop
      ? "cadence-review-running-after-human-reset"
      : "cadence-review-running";

    if (agentActor && nextCadenceRun >= cadenceLoopCap) {
      requestHumanReview = true;
      pendingTriggerState = "cadence-review-running-at-loop-cap";
      humanReviewReason = `Cadence is running at review-loop cap ${cadenceLoopCap}; human review is requested for the next decision.`;
    }

    previousRun =
      currentCadenceRun > 0 ? `cadence-loop-${currentCadenceRun}` : "none";
    pendingRerun = nextCadenceLabel;
  }

  return {
    run_claude: String(runClaude),
    request_human_review: String(requestHumanReview),
    next_cadence_label: nextCadenceLabel,
    cadence_loop_cap: String(cadenceLoopCap),
    status,
    review_state: reviewState,
    pending_trigger_state: pendingTriggerState,
    previous_run: previousRun,
    pending_rerun: pendingRerun,
    skipped_reason: skippedReason,
    cadence_loop_reset: String(resetCadenceLoop),
    agent_actor: String(agentActor),
    force_review: String(forceReview),
    human_review_reason: humanReviewReason,
  };
};

export const planStaleApprovalVisibility = ({
  dismissFailedCount = 0,
  visibleReviewRequest = false,
  rerequested = false,
} = {}) => {
  const failedCount = Number(dismissFailedCount) || 0;
  if (failedCount === 0) {
    return { failed_count: "0", visible_by: "dismissed-or-not-stale" };
  }
  if (visibleReviewRequest) {
    return { failed_count: "0", visible_by: "review-request" };
  }
  if (rerequested) {
    return { failed_count: "0", visible_by: "rerequest" };
  }
  return { failed_count: String(failedCount), visible_by: "none" };
};

export const routeCadenceReviewEvent = async ({
  payload,
  eventName,
  actor,
  token,
  repository = process.env.GITHUB_REPOSITORY,
  fetchImpl = fetch,
  classifyActor = (login) => classifyGitHubActorWithTeams(login, { token }),
} = {}) => {
  if (!token) {
    throw new Error(
      "CADENCE_BOT_GITHUB_TOKEN is required for deterministic actor classification."
    );
  }

  const isFeedback = ["issue_comment", "pull_request_review", "pull_request_review_comment"].includes(eventName);
  const triggerActor = isFeedback
    ? (eventName === "pull_request_review" ? payload.review : payload.comment)?.user?.login || ""
    : payload.sender?.login || actor;
  const triggerSource = `${eventName}.${payload.action || "unknown"}`;
  const prNumber = prNumberFromPayload(payload);
  const prPayload = payload.pull_request || payload.issue || {};
  const prAuthor = prPayload.user?.login;
  const currentHeadSha = prPayload.head?.sha || "";

  let shouldReview = false;
  let shouldRequestReview = false;
  let issueIdentifier = "";
  let skipReason = "";
  let actorClassification = null;
  let symphonyPush = false;
  let authority = null;

  if (!prNumber) {
    skipReason = "event-is-not-a-pr";
  } else {
    if (isFeedback) {
      authority = await verifyReviewEventAuthority({ payload, eventName, repository, token, fetchImpl });
      actorClassification = { classification: authority.allowed ? "human" : "unknown", humanFacing: authority.allowed };
    } else {
      actorClassification = await classifyActor(triggerActor);
    }
    symphonyPush =
      eventName === "pull_request_target" &&
      SYMPHONY_BOT_PR_EVENT_ACTIONS.has(payload.action) &&
      normalize(triggerActor) === (process.env.SYMPHONY_BOT_USER || "example-symphony-bot").trim().toLowerCase() &&
      normalize(prPayload.user?.login) === (process.env.SYMPHONY_BOT_USER || "example-symphony-bot").trim().toLowerCase();
    const isReviewRequestEvent =
      eventName === "pull_request_target" &&
      payload.action === "review_requested";
    const isCadenceReviewRequest =
      isReviewRequestEvent &&
      normalize(payload.requested_reviewer?.login) ===
        normalize(CADENCE_REVIEWER_LOGIN);
    issueIdentifier = issueIdentifierForPullRequest({
      explicitIdentifier: explicitIssueIdentifierFromPayload(payload),
      title: prPayload.title,
      headRef: prPayload.head?.ref,
    });

    if (!issueIdentifier) {
      skipReason = "missing-linked-linear-issue";
    } else if (prPayload.state && normalize(prPayload.state) !== "open") {
      skipReason = "closed-pr";
    } else if (
      !hasLabel(prPayload.labels, "symphony") &&
      !symphonyPush &&
      !(
        isCadenceReviewRequest &&
        normalize(triggerActor) === normalize(CADENCE_REVIEWER_LOGIN)
      )
    ) {
      skipReason = "missing-symphony-label";
    } else if (prAuthor && normalize(prAuthor) !== (process.env.SYMPHONY_BOT_USER || "example-symphony-bot").trim().toLowerCase()) {
      skipReason = "non-symphony-pr";
    } else if (isReviewRequestEvent) {
      skipReason = isCadenceReviewRequest
        ? "review-request-owned-by-trigger-workflow"
        : "non-cadence-review-request";
    } else if (isFeedback && !authority.allowed) {
      skipReason = authority.reason;
    } else if (!actorClassification.humanFacing && !symphonyPush) {
      skipReason = "non-human-actor";
    } else {
      shouldRequestReview = true;
    }
  }

  const triggerContext = triggerContextFromPayload({
    payload,
    eventName,
    prNumber,
    currentHeadSha,
    triggerSource,
  });

  return {
    shouldReview,
    shouldRequestReview,
    prNumber: prNumber ? String(prNumber) : "",
    triggerSource,
    triggerActor,
    issueIdentifier,
    currentHeadSha,
    lastReviewedSha: "",
    skipReason,
    ...(authority ? { authority } : {}),
    actorClassification: actorClassification?.classification || "",
    actorHumanFacing: String(Boolean(actorClassification?.humanFacing)),
    symphonyPush: String(symphonyPush),
    cadenceReviewer: CADENCE_REVIEWER_LOGIN,
    coalescingKey: triggerContext.key,
    coalescingContextKind: triggerContext.contextKind,
    coalescingContextId: triggerContext.contextId,
  };
};

const setOutput = (name, value, outputFile = process.env.GITHUB_OUTPUT) => {
  if (!outputFile) return;
  appendFileSync(outputFile, `${name}=${value}\n`);
};

export const writeRouteResult = (result, env = process.env) => {
  setOutput("should_review", String(result.shouldReview), env.GITHUB_OUTPUT);
  setOutput(
    "should_request_review",
    String(result.shouldRequestReview),
    env.GITHUB_OUTPUT
  );
  setOutput("pr_number", result.prNumber, env.GITHUB_OUTPUT);
  setOutput("trigger_source", result.triggerSource, env.GITHUB_OUTPUT);
  setOutput("trigger_actor", result.triggerActor || "", env.GITHUB_OUTPUT);
  setOutput("issue_identifier", result.issueIdentifier, env.GITHUB_OUTPUT);
  setOutput("current_head_sha", result.currentHeadSha, env.GITHUB_OUTPUT);
  setOutput("last_reviewed_sha", result.lastReviewedSha, env.GITHUB_OUTPUT);
  setOutput("skip_reason", result.skipReason, env.GITHUB_OUTPUT);
  setOutput(
    "actor_classification",
    result.actorClassification,
    env.GITHUB_OUTPUT
  );
  setOutput("actor_human_facing", result.actorHumanFacing, env.GITHUB_OUTPUT);
  setOutput("symphony_push", result.symphonyPush, env.GITHUB_OUTPUT);
  setOutput("cadence_reviewer", result.cadenceReviewer, env.GITHUB_OUTPUT);
  setOutput("coalescing_key", result.coalescingKey, env.GITHUB_OUTPUT);
  setOutput(
    "coalescing_context_kind",
    result.coalescingContextKind,
    env.GITHUB_OUTPUT
  );
  setOutput(
    "coalescing_context_id",
    result.coalescingContextId,
    env.GITHUB_OUTPUT
  );
};

const main = async () => {
  const payload = JSON.parse(
    readFileSync(process.env.CADENCE_EVENT_PATH || process.env.GITHUB_EVENT_PATH, "utf8")
  );
  const result = await routeCadenceReviewEvent({
    payload,
    eventName: process.env.CADENCE_EVENT_NAME || process.env.GITHUB_EVENT_NAME,
    actor: process.env.GITHUB_ACTOR,
    token: process.env.GH_TOKEN,
  });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### Review event authority\n\n${JSON.stringify(result.authority || { reason: result.skipReason || "not-feedback" })}\n`);
  writeRouteResult(result);
  if (result.authority?.verificationFailed) process.exitCode = 1;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

#!/usr/bin/env node
// Route Cadence and human PR review handoffs: actionable output wakes Symphony
// through Linear Active, while Cadence human-needed output asks humans next.

import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { issueIdentifierForPullRequest } from "../.github/workflows/scripts/cadence-ai-review-route-event.mjs";
import {
  fetchIssueComments,
  findCadenceWorkpadComment,
  parseCadenceWorkpad,
  renderCadenceWorkpadForLinear,
} from "./cadence-linear-workpad.mjs";
import { normalize, verifyReviewEventAuthority } from "./github-actor-classification.mjs";
import {
  linearRequest,
  readLinearIssue,
  redactToken,
  terminalStateReason,
  wakeLinearIssue,
} from "./linear-issue-wakeup.mjs";

const DEFAULT_CADENCE_REVIEWER_LOGIN = (process.env.CADENCE_REVIEWER || "example-cadence-bot").trim().toLowerCase();
const DEFAULT_SYMPHONY_AUTHOR_LOGIN = (process.env.SYMPHONY_BOT_USER || "example-symphony-bot").trim().toLowerCase();
const REQUIRED_LABEL = "symphony";
const NON_HUMAN_REVIEWERS = new Set([
  (process.env.SYMPHONY_BOT_USER || "example-symphony-bot").trim().toLowerCase(),
  "claude[bot]",
  "dependabot[bot]",
]);

const hasLabel = (pullRequest, labelName) =>
  (pullRequest.labels || []).some(
    (label) => normalize(label?.name) === normalize(labelName)
  );

const hasReviewBodyContent = (body) => String(body || "").trim().length > 0;

const hasHumanInputNeededContent = (body) =>
  /\bAssessment(?: unchanged)?:\s*Human input needed\b|(^|\n)\s*(Decision needed|class:\s*human-needed)\b/i.test(
    body || ""
  );

const hasActionableContent = (body) =>
  /(^|\n)\s*(Assessment:\s*(Blocked|Rework|Needs follow-up)|Required follow-up|Learn From Human|learn-from-human)\b/i.test(
    body || ""
  );

const isKnownNonHumanReviewer = (login) => {
  const normalized = normalize(login);
  return NON_HUMAN_REVIEWERS.has(normalized) || normalized.endsWith("[bot]");
};

export const humanReviewRequestFromAssignees = (assignees = []) => {
  const reviewers = [];
  const seen = new Set();

  for (const assignee of assignees || []) {
    const login = String(assignee || "").trim();
    const normalized = normalize(login);
    if (
      !normalized ||
      seen.has(normalized) ||
      normalized === normalize(DEFAULT_CADENCE_REVIEWER_LOGIN) ||
      isKnownNonHumanReviewer(normalized)
    ) {
      continue;
    }
    seen.add(normalized);
    reviewers.push(login);
  }

  if (reviewers.length === 0) {
    return {
      shouldRequest: false,
      reviewers,
      target: "no eligible PR assignee",
      warning:
        "Cadence human review handoff requires a PR assignee; broad fallback review requests are intentionally disabled.",
    };
  }

  return {
    shouldRequest: true,
    reviewers,
    target: `PR assignee(s) ${reviewers.join(", ")}`,
    warning: "",
  };
};

export const classifyCadenceLinearReworkEvent = ({
  payload = {},
  eventName = "pull_request_review",
  cadenceReviewerLogin = DEFAULT_CADENCE_REVIEWER_LOGIN,
  symphonyAuthorLogin = DEFAULT_SYMPHONY_AUTHOR_LOGIN,
} = {}) => {
  const isPrComment = eventName === "issue_comment";
  const pullRequest =
    payload.pull_request || (isPrComment ? payload.issue : null) || {};
  const review = (isPrComment ? payload.comment : payload.review) || {};
  const reviewer = review.user?.login || "";
  const reviewState = normalize(review.state);
  const reviewBody = String(review.body || "");
  const prNumber = pullRequest.number ? String(pullRequest.number) : "";
  const issueIdentifier = issueIdentifierForPullRequest({
    title: pullRequest.title,
    headRef: pullRequest.head?.ref,
  });

  const base = {
    prNumber,
    issueIdentifier,
    reviewState,
    reviewer,
    shouldMove: false,
    shouldRequestHumanReview: false,
  };

  if (!["pull_request_review", "issue_comment"].includes(eventName)) {
    return { ...base, reason: "unsupported-event" };
  }
  if (!isPrComment && !["submitted", "edited"].includes(payload.action)) {
    return { ...base, reason: "unsupported-review-action" };
  }
  if (isPrComment && !["created", "edited"].includes(payload.action)) {
    return { ...base, reason: "unsupported-comment-action" };
  }
  if (isPrComment ? !payload.issue?.pull_request : !payload.pull_request) {
    return { ...base, reason: "event-is-not-a-pr" };
  }
  if (normalize(pullRequest.state) !== "open") {
    return { ...base, reason: "pr-not-open" };
  }
  if (normalize(pullRequest.user?.login) !== normalize(symphonyAuthorLogin)) {
    return { ...base, reason: "pr-not-symphony-authored" };
  }
  if (!hasLabel(pullRequest, REQUIRED_LABEL)) {
    return { ...base, reason: "missing-symphony-label" };
  }

  if (isPrComment) {
    if (
      !reviewer ||
      normalize(reviewer) === normalize(cadenceReviewerLogin) ||
      normalize(reviewer) === normalize(symphonyAuthorLogin) ||
      isKnownNonHumanReviewer(reviewer) ||
      normalize(review.user?.type) === "bot" ||
      normalize(payload.sender?.login) === normalize(cadenceReviewerLogin) ||
      normalize(payload.sender?.login) === normalize(symphonyAuthorLogin) ||
      isKnownNonHumanReviewer(payload.sender?.login) ||
      normalize(payload.sender?.type) === "bot"
    ) {
      return { ...base, reason: "non-human-comment" };
    }
    return {
      ...base,
      shouldMove: hasReviewBodyContent(reviewBody),
      reason: hasReviewBodyContent(reviewBody)
        ? "human-pr-comment-actionable-content"
        : "human-pr-comment-no-new-content",
    };
  }

  if (normalize(reviewer) === normalize(cadenceReviewerLogin)) {
    if (hasHumanInputNeededContent(reviewBody)) {
      return {
        ...base,
        shouldRequestHumanReview: true,
        reason: "cadence-review-human-input-needed",
      };
    }

    if (reviewState !== "approved" && hasReviewBodyContent(reviewBody)) {
      return {
        ...base,
        shouldMove: true,
        reason: "cadence-review-actionable-content",
      };
    }

    if (reviewState !== "approved") {
      return { ...base, reason: "cadence-review-no-new-content" };
    }

    if (hasActionableContent(reviewBody)) {
      return {
        ...base,
        shouldMove: true,
        reason: "cadence-review-actionable-content",
      };
    }

    return {
      ...base,
      shouldRequestHumanReview: true,
      reason: "cadence-review-approved",
    };
  }

  if (
    !reviewer ||
    normalize(reviewer) === normalize(DEFAULT_CADENCE_REVIEWER_LOGIN) ||
    isKnownNonHumanReviewer(reviewer) ||
    normalize(review.user?.type) === "bot"
  ) {
    return { ...base, reason: "non-human-review" };
  }

  if (reviewState === "approved") {
    return {
      ...base,
      reason: hasReviewBodyContent(reviewBody)
        ? "human-review-approved-with-notes"
        : "human-review-approved",
      // The event workflow owns this Cadence request and burst coalescing.
      cadenceReviewWorkflow: hasReviewBodyContent(reviewBody)
        ? "cadence-ai-review-events.yml"
        : "",
    };
  }

  if (reviewState === "changes_requested" || hasReviewBodyContent(reviewBody)) {
    return {
      ...base,
      shouldMove: true,
      reason: "human-review-actionable-content",
    };
  }

  return { ...base, reason: "human-review-no-new-content" };
};

const pinWorkpad = async (issueIdentifier, options) => {
  const issue = await fetchIssueComments(
    issueIdentifier,
    options.token,
    options
  );
  const existing = findCadenceWorkpadComment(issue.comments);
  if (existing) return existing.id;
  const data = await linearRequest({
    ...options,
    query: `mutation ReviewHandoffWorkpadCreate($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success comment { id }
      }
    }`,
    variables: { issueId: issue.id, body: "## Cadence Workpad\n" },
    operation: "pin Cadence workpad",
  });
  if (!data.commentCreate?.success || !data.commentCreate.comment?.id) {
    throw new Error("Linear API did not create the Cadence workpad.");
  }
  return data.commentCreate.comment.id;
};

export const renderReviewHandoffEvidence = (result) =>
  `### Review handoff\n\n<pre>${JSON.stringify(result, null, 2)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")}</pre>\n`;

const recordWorkpadEvidence = async (result, commentId, options) => {
  // Cadence owns this workflow token and workpad. Preserve the current review
  // object and write handoff evidence without inventing another review pass.
  // Never edit Symphony's Codex or engine-owned Symphony workpad.
  const issue = await fetchIssueComments(
    result.issueIdentifier,
    options.token,
    options
  );
  const comment = issue.comments.find((item) => item.id === commentId);
  if (!comment || findCadenceWorkpadComment([comment])?.id !== commentId) {
    throw new Error("Pinned Cadence workpad is no longer available.");
  }
  const current = parseCadenceWorkpad(comment.body);
  const { body } = renderCadenceWorkpadForLinear({
    ...current,
    coordination: {
      ...(typeof current.coordination === "object" ? current.coordination : {}),
      reviewHandoff: result,
    },
  });
  const data = await linearRequest({
    ...options,
    query: `mutation ReviewHandoffWorkpadUpdate($id: String!, $body: String!) {
      commentUpdate(id: $id, input: { body: $body }) { success comment { id } }
    }`,
    variables: {
      id: commentId,
      body,
    },
    operation: "record review handoff evidence",
  });
  if (
    !data.commentUpdate?.success ||
    data.commentUpdate.comment?.id !== commentId
  ) {
    throw new Error("Linear API did not update the pinned Cadence workpad.");
  }
};

export const requestHumanReview = async ({
  repo,
  prNumber,
  reviewers,
  token,
  fetchImpl = fetch,
}) => {
  if (!token)
    throw new Error(
      "A GitHub token with pull-request write access is required to request human review."
    );
  if (!/^[^/]+\/[^/]+$/.test(repo || ""))
    throw new Error("GitHub repository is missing.");
  const response = await fetchImpl(
    `https://api.github.com/repos/${repo}/pulls/${prNumber}/requested_reviewers`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/vnd.github+json",
      },
      body: JSON.stringify({ reviewers }),
    }
  );
  const body = await response.json();
  if (!response.ok) {
    if (
      response.status === 422 &&
      /already.*request|review.*already|already.*review/i.test(
        body?.message || ""
      )
    ) {
      return { operation: "already-requested", reviewers };
    }
    throw new Error(
      redactToken(
        `Human review request failed (HTTP ${
          response.status
        }): ${JSON.stringify(body)}`,
        token
      )
    );
  }
  return { operation: "requested", reviewers };
};

export const routeReviewHandoff = async ({
  payload,
  eventName = "pull_request_review",
  token,
  githubToken,
  repository = process.env.GITHUB_REPOSITORY,
  runUrl = "",
  cadenceReviewerLogin = DEFAULT_CADENCE_REVIEWER_LOGIN,
  symphonyAuthorLogin = DEFAULT_SYMPHONY_AUTHOR_LOGIN,
  fetchImpl = fetch,
}) => {
  let decision = classifyCadenceLinearReworkEvent({
    payload,
    eventName,
    cadenceReviewerLogin,
    symphonyAuthorLogin,
  });
  let result = {
    ...decision,
    actor: decision.reviewer,
    issueId: "",
    headSha: payload.pull_request?.head?.sha || "",
    reviewId: String(payload.review?.id || ""),
    commentId: String(payload.comment?.id || ""),
    triggerSource: `${eventName}.${payload.action || ""}`,
    runUrl,
    previousState: "unknown",
    state: "unknown",
    operation: "skipped",
    skippedReason: decision.reason,
  };
  if (!decision.shouldMove && !decision.shouldRequestHumanReview) return result;
  if (normalize(decision.reviewer) !== normalize(cadenceReviewerLogin)) {
    const authority = await verifyReviewEventAuthority({
      payload, eventName, repository, token: githubToken, fetchImpl,
    });
    result.authority = authority;
    if (!authority.allowed) return {
      ...result, shouldMove: false, shouldRequestHumanReview: false,
      operation: authority.verificationFailed ? "failed" : "skipped",
      skippedReason: authority.reason,
    };
  }
  const options = { token, fetchImpl };
  let commentId;
  try {
    if (eventName === "issue_comment") {
      // issue_comment has no PR head/branch. Read current PR metadata from the
      // repository API and reapply the author/state/label gates before Linear.
      const repo = payload.repository?.full_name;
      if (!githubToken || !/^[^/]+\/[^/]+$/.test(repo || "")) {
        throw new Error(
          "GitHub token and repository are required to read the commented PR."
        );
      }
      const response = await fetchImpl(
        `https://api.github.com/repos/${repo}/pulls/${decision.prNumber}`,
        {
          headers: {
            authorization: `Bearer ${githubToken}`,
            accept: "application/vnd.github+json",
          },
        }
      );
      if (!response.ok) {
        throw new Error(
          `Could not read commented PR (HTTP ${response.status}).`
        );
      }
      const pullRequest = await response.json();
      if (String(pullRequest.number) !== decision.prNumber) {
        throw new Error(
          "GitHub returned a different PR for the comment handoff."
        );
      }
      payload = { ...payload, pull_request: pullRequest };
      decision = classifyCadenceLinearReworkEvent({
        payload,
        eventName,
        cadenceReviewerLogin,
        symphonyAuthorLogin,
      });
      result = {
        ...result,
        ...decision,
        headSha: pullRequest.head?.sha || "",
        skippedReason: decision.reason,
      };
      if (!decision.shouldMove) return result;
    }
    if (
      !result.headSha ||
      !(result.reviewId || result.commentId) ||
      !result.actor ||
      !runUrl
    ) {
      throw new Error(
        "Review handoff requires head SHA, review or comment id, actor, and workflow run URL."
      );
    }
    const issue = await readLinearIssue({
      issueIdentifier: decision.issueIdentifier,
      ...options,
    });
    result = {
      ...result,
      issueId: issue.id,
      previousState: issue.state.name,
      state: issue.state.name,
    };
    commentId = await pinWorkpad(issue.identifier, options);
    result.skippedReason = terminalStateReason(issue.state);
    if (!result.skippedReason) {
      // Prove the pinned workpad is writable before changing issue/review state.
      await recordWorkpadEvidence(
        { ...result, operation: "pending" },
        commentId,
        options
      );
      if (decision.shouldMove) {
        result = {
          ...result,
          ...(await wakeLinearIssue({
            // Workpad requests can take time. Re-check terminal state just
            // before waking so a cancellation during evidence writes wins.
            issue: await readLinearIssue({
              issueIdentifier: issue.identifier,
              ...options,
            }),
            ...options,
          })),
        };
      } else {
        const plan = humanReviewRequestFromAssignees(
          (payload.pull_request.assignees || []).map(
            (assignee) => assignee.login
          )
        );
        result.operation = "unchanged";
        result.humanReview = plan.shouldRequest
          ? await requestHumanReview({
              repo: payload.repository?.full_name,
              prNumber: decision.prNumber,
              reviewers: plan.reviewers,
              token: githubToken,
              fetchImpl,
            })
          : {
              operation: "skipped",
              reason: "no-eligible-pr-assignee",
              warning: plan.warning,
            };
        result.skippedReason = "human-review-handoff";
      }
    }
  } catch (error) {
    result = {
      ...result,
      ...error.evidence,
      operation: "failed",
      error: redactToken(redactToken(error.message, token), githubToken),
    };
  }
  if (commentId) {
    try {
      await recordWorkpadEvidence(result, commentId, options);
    } catch (error) {
      result.evidenceError = redactToken(error.message, token);
    }
  }
  return result;
};

const main = async () => {
  const payload = JSON.parse(
    readFileSync(process.env.CADENCE_EVENT_PATH || process.env.GITHUB_EVENT_PATH, "utf8")
  );
  const result = await routeReviewHandoff({
    payload,
    eventName: process.env.CADENCE_EVENT_NAME || process.env.GITHUB_EVENT_NAME,
    token: process.env.LINEAR_API_TOKEN || process.env.LINEAR_API_KEY,
    githubToken: process.env.GH_TOKEN,
    cadenceReviewerLogin: process.env.CADENCE_REVIEWER_LOGIN,
    symphonyAuthorLogin: process.env.SYMPHONY_AUTHOR_LOGIN,
    runUrl: process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${
          process.env.GITHUB_REPOSITORY
        }/actions/runs/${process.env.GITHUB_RUN_ID}`
      : "",
  });
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      renderReviewHandoffEvidence(result)
    );
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.operation === "failed" || result.evidenceError)
    process.exitCode = 1;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

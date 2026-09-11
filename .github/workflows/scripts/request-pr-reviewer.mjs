#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { prepareReviewRequestReceipt } from "./cadence-review-request-receipt.mjs";

const API_BASE = "https://api.github.com";

export const isAlreadyRequestedReviewError = (message = "") =>
  /already.*request|review.*already|already.*review/i.test(String(message));

const normalizeLogin = (login = "") => String(login).trim().toLowerCase();

const noFreshReviewRequestError = (reviewers) =>
  new Error(
    `Review request for ${reviewers.join(
      ", "
    )} was already present; no fresh review_requested event was created.`
  );

const parseResponsePayload = (text) => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const formatResponseBodyForLog = (payload) => {
  if (payload == null) return "null";
  if (typeof payload === "string") return payload;
  return JSON.stringify(payload);
};

const logDeleteOutcome = ({ status, payload }, log) => {
  log(
    `DELETE requested_reviewers outcome: status=${
      status ?? "unknown"
    } body=${formatResponseBodyForLog(payload)}`
  );
};

const parseRepo = (repo) => {
  const [owner, name] = String(repo || "").split("/");
  if (!owner || !name) {
    throw new Error("GH_REPO must be in owner/name form.");
  }
  return { owner, repo: name };
};

const parseReviewers = (env = process.env) => {
  if (env.REVIEWERS_JSON) {
    const parsed = JSON.parse(env.REVIEWERS_JSON);
    if (!Array.isArray(parsed)) {
      throw new Error("REVIEWERS_JSON must be a JSON array.");
    }
    return parsed.map(String).filter(Boolean);
  }
  return String(env.REVIEWER_LOGIN || "")
    .split(",")
    .map((reviewer) => reviewer.trim())
    .filter(Boolean);
};

const apiRequest = async ({
  token,
  method = "GET",
  path,
  body,
  fetchImpl = fetch,
}) => {
  const response = await fetchImpl(`${API_BASE}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = parseResponsePayload(text);

  if (!response.ok) {
    const message = payload?.message || text || response.statusText;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return {
    payload,
    status: response.status,
    next: response.headers
      ?.get?.("link")
      ?.match(/<([^>]+)>;\s*rel="next"/)?.[1],
  };
};

const apiPathFromUrl = (url) => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

const listAll = async ({ token, path, fetchImpl }) => {
  const items = [];
  let nextPath = path;
  while (nextPath) {
    const { payload, next } = await apiRequest({
      token,
      path: nextPath,
      fetchImpl,
    });
    items.push(...payload);
    nextPath = next ? apiPathFromUrl(next) : "";
  }
  return items;
};

const requestedReviewerLoginsFrom = (payload = {}) =>
  [...(payload.users || []), ...(payload.requested_reviewers || [])]
    .map((reviewer) => normalizeLogin(reviewer?.login))
    .filter(Boolean);

const getRequestedReviewerLogins = async ({ token, pullPath, fetchImpl }) => {
  const { payload } = await apiRequest({
    token,
    path: `${pullPath}/requested_reviewers?per_page=100`,
    fetchImpl,
  });
  return new Set(requestedReviewerLoginsFrom(payload));
};

export const requestReviewers = async ({
  token,
  deleteToken = token,
  owner,
  repo,
  prNumber,
  reviewers,
  dismissApprovals = false,
  dismissMessage = "Review is stale because a new review-causing event is queued; re-review is requested.",
  eventContext,
  fetchImpl = fetch,
  log = console.log,
}) => {
  if (!token) {
    throw new Error("GH_TOKEN is required to request PR review.");
  }
  if (!Number.isInteger(Number(prNumber)) || Number(prNumber) <= 0) {
    throw new Error("PR_NUMBER must be a positive integer.");
  }
  if (!reviewers.length) {
    return {
      requested: false,
      removedExistingRequest: false,
      dismissedApprovalCount: 0,
      dismissFailedCount: 0,
      alreadyRequested: false,
      skipReason: "no-reviewers",
    };
  }

  const pullPath = `/repos/${owner}/${repo}/pulls/${prNumber}`;
  const reviewersBody = { reviewers };
  const reviewerLogins = reviewers.map(normalizeLogin);
  const reviewerSet = new Set(reviewerLogins);
  const dismissed = [];
  const dismissFailed = [];

  if (eventContext && reviewers.length !== 1) {
    throw new Error("Event coalescing requires exactly one Cadence reviewer.");
  }
  const receipt = eventContext
    ? await prepareReviewRequestReceipt({
        ...eventContext,
        reviewer: reviewers[0],
        pullPath,
        request: (options) => apiRequest({ ...options, token, fetchImpl }),
        list: (path) => listAll({ token, path, fetchImpl }),
      })
    : null;
  if (receipt?.skipReason) {
    return {
      requested: false,
      removedExistingRequest: false,
      dismissedApprovalCount: 0,
      dismissFailedCount: 0,
      alreadyRequested: false,
      skipReason: receipt.skipReason,
    };
  }

  if (dismissApprovals) {
    const reviews = await listAll({
      token,
      path: `${pullPath}/reviews?per_page=100`,
      fetchImpl,
    });
    const approvals = reviews.filter(
      (review) =>
        reviewerSet.has(normalizeLogin(review.user?.login)) &&
        review.state === "APPROVED"
    );

    for (const review of approvals) {
      try {
        await apiRequest({
          token,
          method: "PUT",
          path: `${pullPath}/reviews/${review.id}/dismissals`,
          body: { message: dismissMessage },
          fetchImpl,
        });
        dismissed.push(review.id);
      } catch (error) {
        dismissFailed.push(`${review.id}: ${error.message}`);
      }
    }
  }

  const requestedBefore = await getRequestedReviewerLogins({
    token,
    pullPath,
    fetchImpl,
  });
  const presentBefore = reviewers.filter((reviewer) =>
    requestedBefore.has(normalizeLogin(reviewer))
  );
  let removedExistingRequest = false;
  let existingRequestStillPresent = false;

  if (presentBefore.length) {
    try {
      const deleteResult = await apiRequest({
        token: deleteToken,
        method: "DELETE",
        path: `${pullPath}/requested_reviewers`,
        body: reviewersBody,
        fetchImpl,
      });
      logDeleteOutcome(deleteResult, log);
      removedExistingRequest = true;
    } catch (error) {
      logDeleteOutcome(error, log);
      if (![404, 422].includes(error.status)) {
        throw error;
      }
      existingRequestStillPresent = true;
    }

    if (removedExistingRequest) {
      const requestedAfterDelete = await getRequestedReviewerLogins({
        token,
        pullPath,
        fetchImpl,
      });
      existingRequestStillPresent = presentBefore.some((reviewer) =>
        requestedAfterDelete.has(normalizeLogin(reviewer))
      );
      removedExistingRequest = !existingRequestStillPresent;
    }
  }

  let alreadyRequested = false;
  await receipt?.start();
  try {
    await apiRequest({
      token,
      method: "POST",
      path: `${pullPath}/requested_reviewers`,
      body: reviewersBody,
      fetchImpl,
    });
  } catch (error) {
    // A rejected request can retry. Transport failures or 5xx responses may
    // have accepted the POST; leave that receipt pending for timeline recovery.
    if (error.status >= 400 && error.status < 500) await receipt?.retry();
    if (!isAlreadyRequestedReviewError(error.message)) {
      throw error;
    }
    alreadyRequested = true;
  }

  if (alreadyRequested || existingRequestStillPresent) {
    throw noFreshReviewRequestError(reviewers);
  }

  await receipt?.complete();

  return {
    requested: !alreadyRequested,
    removedExistingRequest,
    dismissedApprovalCount: dismissed.length,
    dismissFailedCount: dismissFailed.length,
    alreadyRequested,
    skipReason: "",
  };
};

const setOutput = (name, value, outputFile = process.env.GITHUB_OUTPUT) => {
  if (!outputFile) return;
  appendFileSync(outputFile, `${name}=${value}\n`);
};

const main = async () => {
  const { owner, repo } = parseRepo(process.env.GH_REPO);
  const reviewers = parseReviewers();
  const result = await requestReviewers({
    token: process.env.GH_TOKEN,
    deleteToken: process.env.DELETE_GH_TOKEN || process.env.GITHUB_TOKEN,
    owner,
    repo,
    prNumber: process.env.PR_NUMBER,
    reviewers,
    dismissApprovals:
      String(process.env.DISMISS_APPROVALS).toLowerCase() === "true",
    dismissMessage: process.env.DISMISS_MESSAGE,
    eventContext:
      process.env.COALESCE_REVIEW_EVENT === "true"
        ? {
            payload: JSON.parse(
              readFileSync(process.env.CADENCE_EVENT_PATH || process.env.GITHUB_EVENT_PATH, "utf8")
            ),
            eventName: process.env.CADENCE_EVENT_NAME || process.env.GITHUB_EVENT_NAME,
            requestActor: process.env.REVIEW_REQUEST_ACTOR,
          }
        : undefined,
  });

  setOutput("requested", String(result.requested));
  setOutput("removed_existing_request", String(result.removedExistingRequest));
  setOutput("dismissed_approval_count", String(result.dismissedApprovalCount));
  setOutput("dismiss_failed_count", String(result.dismissFailedCount));
  setOutput("already_requested", String(result.alreadyRequested));
  setOutput("skip_reason", result.skipReason);

  if (result.skipReason) {
    console.log(`Skipped review request: ${result.skipReason}`);
  } else {
    console.log(
      `Requested review from ${reviewers.join(
        ", "
      )}; removed_existing_request=${
        result.removedExistingRequest
      }; dismissed_approval_count=${
        result.dismissedApprovalCount
      }; already_requested=${result.alreadyRequested}`
    );
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

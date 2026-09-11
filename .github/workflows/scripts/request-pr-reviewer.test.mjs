import assert from "node:assert/strict";
import test from "node:test";

import {
  isAlreadyRequestedReviewError,
  requestReviewers,
} from "./request-pr-reviewer.mjs";

const jsonResponse = (payload, { status = 200, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status >= 200 && status < 300 ? "OK" : "Error",
  headers: {
    get: (name) => headers[name.toLowerCase()] || null,
  },
  text: async () => JSON.stringify(payload),
});

const emptyResponse = ({ status = 204 } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status >= 200 && status < 300 ? "OK" : "Error",
  headers: { get: () => null },
  text: async () => "",
});

const makeFetch =
  (responses, calls = []) =>
  async (url, options = {}) => {
    calls.push({
      url,
      method: options.method || "GET",
      authorization: options.headers?.authorization,
      body: options.body ? JSON.parse(options.body) : null,
    });
    const response = responses.shift();
    if (!response) {
      throw new Error(`Unexpected request: ${options.method || "GET"} ${url}`);
    }
    return response;
  };

test("recognizes GitHub already-requested review errors", () => {
  assert.equal(
    isAlreadyRequestedReviewError("Review has already been requested"),
    true
  );
  assert.equal(isAlreadyRequestedReviewError("review already exists"), true);
  assert.equal(isAlreadyRequestedReviewError("permission denied"), false);
});

test("clears an existing pending reviewer with workflow token before requesting review with bot token", async () => {
  const calls = [];
  const logs = [];
  const fetchImpl = makeFetch(
    [
      jsonResponse({
        users: [{ login: "example-cadence-bot" }],
        teams: [],
      }),
      emptyResponse(),
      jsonResponse({ users: [], teams: [] }),
      jsonResponse({ requested_reviewers: [] }, { status: 201 }),
    ],
    calls
  );

  const result = await requestReviewers({
    token: "bot-token",
    deleteToken: "workflow-token",
    owner: "example-org",
    repo: "example-repo",
    prNumber: 3792,
    reviewers: ["example-cadence-bot"],
    fetchImpl,
    log: (message) => logs.push(message),
  });

  assert.equal(result.removedExistingRequest, true);
  assert.equal(result.requested, true);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "DELETE", "GET", "POST"]
  );
  assert.deepEqual(calls[1].body, { reviewers: ["example-cadence-bot"] });
  assert.deepEqual(
    calls.map((call) => call.authorization),
    [
      "Bearer bot-token",
      "Bearer workflow-token",
      "Bearer bot-token",
      "Bearer bot-token",
    ]
  );
  assert.equal(
    logs[0],
    "DELETE requested_reviewers outcome: status=204 body=null"
  );
});

test("dismisses stale approvals before requesting Cadence review", async () => {
  const calls = [];
  const fetchImpl = makeFetch(
    [
      jsonResponse([
        {
          id: 101,
          state: "APPROVED",
          user: { login: "example-cadence-bot" },
        },
        {
          id: 102,
          state: "COMMENTED",
          user: { login: "example-cadence-bot" },
        },
      ]),
      emptyResponse(),
      jsonResponse({ users: [], teams: [] }),
      jsonResponse({ requested_reviewers: [] }, { status: 201 }),
    ],
    calls
  );

  const result = await requestReviewers({
    token: "token",
    owner: "example-org",
    repo: "example-repo",
    prNumber: 3960,
    reviewers: ["example-cadence-bot"],
    dismissApprovals: true,
    fetchImpl,
  });

  assert.equal(result.dismissedApprovalCount, 1);
  assert.equal(result.dismissFailedCount, 0);
  assert.equal(result.removedExistingRequest, false);
  assert.equal(result.requested, true);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "PUT", "GET", "POST"]
  );
  assert.match(calls[1].url, /\/reviews\/101\/dismissals$/);
});

test("fails when an already-requested response would create no fresh event", async () => {
  const fetchImpl = makeFetch([
    jsonResponse({ users: [], teams: [] }),
    jsonResponse(
      { message: "Review has already been requested" },
      { status: 422 }
    ),
  ]);

  await assert.rejects(
    requestReviewers({
      token: "token",
      owner: "example-org",
      repo: "example-repo",
      prNumber: 3792,
      reviewers: ["example-cadence-bot"],
      fetchImpl,
    }),
    /no fresh review_requested event/
  );
});

test("fails when a pending reviewer survives delete and POST is idempotent", async () => {
  const logs = [];
  const fetchImpl = makeFetch([
    jsonResponse({
      users: [{ login: "example-cadence-bot" }],
      teams: [],
    }),
    jsonResponse(
      { message: "Review request is not in pending state" },
      { status: 422 }
    ),
    jsonResponse(
      { requested_reviewers: [{ login: "example-cadence-bot" }] },
      { status: 201 }
    ),
  ]);

  await assert.rejects(
    requestReviewers({
      token: "token",
      owner: "example-org",
      repo: "example-repo",
      prNumber: 3792,
      reviewers: ["example-cadence-bot"],
      fetchImpl,
      log: (message) => logs.push(message),
    }),
    /no fresh review_requested event/
  );
  assert.equal(
    logs[0],
    'DELETE requested_reviewers outcome: status=422 body={"message":"Review request is not in pending state"}'
  );
});

test("fails when stale approval dismissal is not paired with a fresh request event", async () => {
  const fetchImpl = makeFetch([
    jsonResponse([
      {
        id: 201,
        state: "APPROVED",
        user: { login: "example-cadence-bot" },
      },
    ]),
    emptyResponse(),
    jsonResponse({ users: [], teams: [] }),
    jsonResponse(
      { message: "Review has already been requested" },
      { status: 422 }
    ),
  ]);

  await assert.rejects(
    requestReviewers({
      token: "token",
      owner: "example-org",
      repo: "example-repo",
      prNumber: 3960,
      reviewers: ["example-cadence-bot"],
      dismissApprovals: true,
      fetchImpl,
    }),
    /no fresh review_requested event/
  );
});

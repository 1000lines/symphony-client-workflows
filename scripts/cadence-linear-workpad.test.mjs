import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyReviewUpdate,
  CADENCE_WORKPAD_HEADING,
  formatReviewTimestamp,
  isCadenceWorkpadBody,
  loadToken,
  parseCadenceWorkpad,
  readWorkpadInput,
  renderCadenceWorkpad,
  renderCadenceWorkpadForLinear,
  resolveWorkpadInput,
  upsertCadenceWorkpad,
} from "./cadence-linear-workpad.mjs";

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "cadence-linear-workpad-fixtures"
);
const fixtureNames = readdirSync(fixtureDir)
  .filter((name) => name.endsWith(".md"))
  .sort();
const readFixture = (name) => readFileSync(join(fixtureDir, name), "utf8");

const sampleWorkpad = {
  status: "completed",
  triggerSource: "pull_request_review",
  reviewState: "reviewed",
  lastReviewedSha: "abc1234",
  lastReviewedAt: "2026-06-27T22:14:00Z",
  pendingTriggerState: "none",
  pendingCommentState: "none",
  githubAssessmentSummary: "No GitHub-visible findings.",
  detailedFindings: ["No blockers found."],
  skippedEvents: ["dependabot[bot] comment ignored"],
  previousRun: "2026-06-27T21:10:00Z",
  pendingRerun: "none",
  coordination: "Ready for Symphony handoff.",
};

const structuredWorkpad = {
  ...sampleWorkpad,
  disposition: "COMMENT",
  remainingHumanReviewEffort: "low",
  summary: "Schema review is open.",
  history: [
    {
      id: "α",
      reviewedAt: "06-28 02:26Z",
      range: "main...c4274ae",
      sha: "c4274ae",
      humanComments: 0,
      summary: "Initial Cadence review approved the write mechanics.",
    },
  ],
  humanFeedback: [
    {
      review: "α",
      actor: "@example-lead",
      id: "DEMO-112-schema-F1",
      status: "open",
      summary: "Add an explicit incremental schema.",
    },
  ],
  requirements: [
    {
      review: "α",
      id: "REQ-WORKPAD-4",
      status: "partial",
      source: "Linear",
      summary: "Cadence Linear workpad writer.",
    },
  ],
  findings: [
    {
      review: "α",
      id: "AR-DEMO-112-schema-F1",
      lifecycle: "new",
      class: "human-needed",
      locality: "local",
      severity: "medium",
      status: "open",
      summary: "Richer schema scope needs to be represented.",
    },
  ],
  learnFromHuman: [
    {
      review: "α",
      id: "AR-DEMO-112-learn-H1",
      status: "open",
      summary: "Record Cadence reviews as incremental history.",
    },
  ],
};

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

const makeLinearFetch = ({ comments = [], failCreate, failUpdate } = {}) => {
  const issue = {
    id: "issue-1",
    identifier: "DEMO-112",
    comments: comments.map((comment, index) => ({
      createdAt: `2026-06-27T22:${String(index).padStart(2, "0")}:00Z`,
      updatedAt: `2026-06-27T22:${String(index).padStart(2, "0")}:00Z`,
      ...comment,
    })),
  };
  const created = [];
  const updated = [];

  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.query.includes("query CadenceWorkpadIssue")) {
      return jsonResponse({
        data: {
          issue: {
            id: issue.id,
            identifier: issue.identifier,
            comments: {
              nodes: issue.comments,
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    }

    if (request.query.includes("mutation CreateCadenceWorkpad")) {
      if (failCreate) {
        return jsonResponse({ errors: [{ message: failCreate }] });
      }
      const comment = {
        id: `created-${created.length + 1}`,
        body: request.variables.body,
        createdAt: "2026-06-27T23:00:00Z",
        updatedAt: "2026-06-27T23:00:00Z",
      };
      issue.comments.push(comment);
      created.push({ issueId: request.variables.issueId, body: comment.body });
      return jsonResponse({
        data: { commentCreate: { success: true, comment: { id: comment.id } } },
      });
    }

    if (request.query.includes("mutation UpdateCadenceWorkpad")) {
      if (failUpdate) {
        return jsonResponse({ errors: [{ message: failUpdate }] });
      }
      const comment = issue.comments.find(
        (candidate) => candidate.id === request.variables.commentId
      );
      comment.body = request.variables.body;
      updated.push({ commentId: comment.id, body: comment.body });
      return jsonResponse({
        data: { commentUpdate: { success: true, comment: { id: comment.id } } },
      });
    }

    throw new Error("Unexpected Linear request");
  };

  return { comments: issue.comments, created, updated, fetchImpl };
};

test("renderCadenceWorkpad includes deterministic review and pending state fields", () => {
  const rendered = renderCadenceWorkpad(sampleWorkpad);

  assert.match(rendered, new RegExp(`^${CADENCE_WORKPAD_HEADING}`));
  assert.match(rendered, /Status: completed/);
  assert.match(rendered, /Trigger source: pull_request_review/);
  assert.match(rendered, /Review state: reviewed/);
  assert.match(rendered, /Last reviewed PR SHA: abc1234/);
  assert.match(rendered, /Last reviewed timestamp: 2026-06-27T22:14:00Z/);
  assert.match(rendered, /Pending trigger state: none/);
  assert.match(rendered, /Pending comment state: none/);
});

test("renderCadenceWorkpad includes the explicit incremental review schema", () => {
  const rendered = renderCadenceWorkpad(structuredWorkpad);

  assert.match(rendered, /Schema: cadence-workpad\/v1alpha1/);
  assert.match(rendered, /Disposition: COMMENT/);
  assert.match(rendered, /Remaining human review effort: low/);
  assert.match(rendered, /### History/);
  assert.match(rendered, /- \*\*α 06-28 02:26Z\*\* `main\.\.\.c4274ae`/);
  assert.match(rendered, /### Human Feedback/);
  assert.match(rendered, /DEMO-112-schema-F1/);
  assert.match(rendered, /### Requirements/);
  assert.match(rendered, /status: partial/);
  assert.match(rendered, /### Findings/);
  assert.match(rendered, /class: human-needed/);
  assert.match(rendered, /### Learn From Human/);
  assert.match(rendered, /### Review Object/);
});

test("Cadence workpad markdown round-trips through the internal review object", () => {
  const rendered = renderCadenceWorkpad(structuredWorkpad);
  const parsed = parseCadenceWorkpad(rendered);

  assert.equal(renderCadenceWorkpad(parsed), rendered);
});

test("renderCadenceWorkpadForLinear compacts older detail when the comment would exceed the limit", () => {
  const oversizedWorkpad = {
    ...structuredWorkpad,
    history: Array.from({ length: 30 }, (_, index) => ({
      id: `review-${index}`,
      reviewedAt: `06-28 ${String(index).padStart(2, "0")}:00Z`,
      range: `sha-${index}...sha-${index + 1}`,
      sha: `sha-${index + 1}`,
      humanComments: index % 2,
      summary: `History detail ${index}. ${"Extra context. ".repeat(80)}`,
    })),
    findings: Array.from({ length: 30 }, (_, index) => ({
      id: `AR-large-${index}`,
      lifecycle: "carried",
      class: "human-needed",
      locality: "local",
      severity: "medium",
      status: "open",
      summary: `Finding detail ${index}. ${"Repeated finding detail. ".repeat(
        90
      )}`,
    })),
  };

  const fullBody = renderCadenceWorkpad(oversizedWorkpad);
  const { body, compacted } = renderCadenceWorkpadForLinear(oversizedWorkpad, {
    maxCommentChars: 40000,
  });
  const parsed = parseCadenceWorkpad(body);

  assert.equal(compacted, true);
  assert.ok(fullBody.length > body.length);
  assert.ok(body.length <= 40000);
  assert.match(body, /Compacted to stay under Linear's comment-size limit/);
  assert.equal(parsed.findings.at(-1).id, "AR-large-29");
  assert.equal(
    parsed.findings.some((finding) => finding.id === "AR-large-0"),
    false
  );
});

test("Markdown fixture files round-trip through the internal review object", () => {
  assert.ok(
    fixtureNames.length >= 5,
    "expected at least five Cadence Workpad Markdown fixtures"
  );

  const fixtures = fixtureNames.map((name) => ({
    name,
    body: readFixture(name),
  }));
  const roundTripped = fixtures.map(({ name, body }) => ({
    name,
    body: renderCadenceWorkpad(parseCadenceWorkpad(body)),
  }));

  assert.deepEqual(roundTripped, fixtures);
});

test("fixture-backed compaction preserves current status, head SHA, pending trigger state, and latest findings", () => {
  const current = parseCadenceWorkpad(readFixture("sequence-three-gamma.md"));
  const oversizedWorkpad = {
    ...current,
    status: "completed",
    lastReviewedSha: "current-head-sha",
    pendingTriggerState: "none",
    history: [
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `old-${index}`,
        reviewedAt: `06-27 ${String(index).padStart(2, "0")}:00Z`,
        range: `old-${index}...old-${index + 1}`,
        sha: `old-${index + 1}`,
        humanComments: 0,
        summary: `Older history ${index}. ${"Archived history. ".repeat(80)}`,
      })),
      ...current.history,
    ],
    findings: [
      ...Array.from({ length: 20 }, (_, index) => ({
        review: `old-${index}`,
        id: `AR-old-${index}`,
        lifecycle: "carried",
        class: "suggestion",
        locality: "local",
        severity: "low",
        status: "closed",
        summary: `Older finding ${index}. ${"Archived detail. ".repeat(80)}`,
      })),
      ...current.findings,
      {
        review: "γ",
        id: "AR-current-head-F1",
        lifecycle: "new",
        class: "human-needed",
        locality: "local",
        severity: "medium",
        status: "open",
        summary: "Current head finding must survive compaction.",
      },
    ],
  };

  const { body, compacted } = renderCadenceWorkpadForLinear(oversizedWorkpad, {
    maxCommentChars: 35000,
  });
  const parsed = parseCadenceWorkpad(body);

  assert.equal(compacted, true);
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.lastReviewedSha, "current-head-sha");
  assert.equal(parsed.pendingTriggerState, "none");
  assert.equal(parsed.findings.at(-1).id, "AR-current-head-F1");
  assert.equal(
    parsed.findings.some((finding) => finding.id === "AR-old-0"),
    false
  );
  assert.match(body, /Compacted to stay under Linear's comment-size limit/);
});

const fixtureIncrementCases = [
  {
    name: "three-step sequence alpha to beta",
    start: "sequence-three-alpha.md",
    expected: "sequence-three-beta.md",
    now: "2026-06-28T16:25:00Z",
    reviewUpdate: {
      status: "completed",
      reviewState: "reviewed",
      disposition: "COMMENT",
      remainingHumanReviewEffort: "low",
      range: "abc1111...abc2222",
      lastReviewedSha: "abc2222",
      humanComments: 1,
      summary: "Human review requested fixture-based round trips.",
      humanFeedback: [
        {
          actor: "@example-lead",
          id: "DEMO-112-fixtures-F2",
          status: "accepted",
          summary:
            "Add Markdown fixture files and compare exact increment output.",
        },
      ],
      requirements: [
        {
          id: "REQ-WORKPAD-4",
          status: "partial",
          source: "PR comment",
          summary: "Fixture-driven round-trip tests are now explicit scope.",
        },
      ],
      findings: [
        {
          id: "AR-DEMO-112-fixtures-F2",
          lifecycle: "new",
          class: "human-needed",
          locality: "local",
          severity: "medium",
          status: "open",
          summary:
            "Add complete Markdown fixtures and exact increment expectations.",
        },
      ],
      githubAssessmentSummary:
        "Cadence would comment that fixture rework is in progress.",
      detailedFindings: [
        "Round-trip fixture coverage must compare whole Markdown documents.",
      ],
      skippedEvents: [
        "Ignored stale bot approval because human feedback superseded it.",
      ],
      pendingRerun: "after fixture commit",
      coordination:
        "Symphony should add fixture files before returning to review.",
      learnFromHuman: [
        {
          id: "DEMO-112-reviewability-H2",
          status: "open",
          summary:
            "Prefer full-document fixtures when reviewers need to inspect Markdown contracts.",
        },
      ],
    },
  },
  {
    name: "three-step sequence beta to gamma",
    start: "sequence-three-beta.md",
    expected: "sequence-three-gamma.md",
    now: "2026-06-28T18:00:00Z",
    reviewUpdate: {
      status: "completed",
      reviewState: "reviewed",
      disposition: "APPROVE",
      remainingHumanReviewEffort: "none",
      range: "abc2222...abc3333",
      lastReviewedSha: "abc3333",
      humanComments: 0,
      summary: "Fixture tests cover the three-step sequence.",
      requirements: [
        {
          id: "REQ-WORKPAD-4",
          status: "satisfied",
          source: "test fixtures",
          summary:
            "Round-trip and increment fixtures cover the workpad contract.",
        },
      ],
      findings: [
        {
          id: "AR-DEMO-112-fixtures-F2",
          lifecycle: "resolved",
          class: "human-needed",
          locality: "local",
          severity: "medium",
          status: "closed",
          summary:
            "The fixture folder now contains exact expected Markdown states.",
        },
      ],
      githubAssessmentSummary: "No GitHub-visible blockers remain.",
      detailedFindings: ["Fixture tests round-trip every sample scratchpad."],
      pendingRerun: "none",
      coordination: "Ready for human review.",
    },
  },
  {
    name: "two-step sequence alpha to beta",
    start: "sequence-two-alpha.md",
    expected: "sequence-two-beta.md",
    now: "2026-06-28T14:05:00Z",
    reviewUpdate: {
      status: "completed",
      reviewState: "reviewed",
      disposition: "APPROVE",
      remainingHumanReviewEffort: "none",
      range: "def1111...def2222",
      lastReviewedSha: "def2222",
      humanComments: 0,
      summary: "Docs now clarify the linked-issue boundary.",
      requirements: [
        {
          id: "REQ-WORKPAD-4",
          status: "satisfied",
          source: "docs",
          summary: "The helper scope and failure behavior are documented.",
        },
      ],
      findings: [
        {
          id: "AR-DEMO-112-scope-F2",
          lifecycle: "resolved",
          class: "suggestion",
          locality: "local",
          severity: "low",
          status: "closed",
          summary:
            "The docs now direct unrelated Linear comments to their own issue.",
        },
      ],
      githubAssessmentSummary: "No docs blockers remain.",
      detailedFindings: ["Linked-issue scope is explicit."],
      skippedEvents: ["No unrelated issue comments were written."],
      pendingTriggerState: "none",
      pendingCommentState: "none",
      pendingRerun: "none",
      coordination: "Ready for review.",
    },
  },
];

for (const fixtureCase of fixtureIncrementCases) {
  test(`fixture increment ${fixtureCase.name}`, () => {
    const actual = renderCadenceWorkpad(
      resolveWorkpadInput({
        existingBody: readFixture(fixtureCase.start),
        incomingWorkpad: { reviewUpdate: fixtureCase.reviewUpdate },
        now: new Date(fixtureCase.now),
      })
    );

    assert.equal(actual, readFixture(fixtureCase.expected));
  });
}

test("applyReviewUpdate appends a stamped follow-up review", () => {
  const updated = applyReviewUpdate(
    structuredWorkpad,
    {
      status: "completed",
      reviewState: "reviewed",
      disposition: "APPROVE",
      remainingHumanReviewEffort: "none",
      range: "c4274ae...def5678",
      lastReviewedSha: "def5678",
      humanComments: 1,
      summary: "Follow-up resolved the schema gap.",
      requirements: [
        {
          id: "REQ-WORKPAD-4",
          status: "satisfied",
          source: "Linear",
          summary: "Incremental schema is represented.",
        },
      ],
      findings: [
        {
          id: "AR-DEMO-112-schema-F1",
          lifecycle: "resolved",
          class: "human-needed",
          locality: "local",
          severity: "medium",
          status: "closed",
          summary: "Schema history and dimensions are explicit.",
        },
      ],
    },
    { now: new Date("2026-06-28T16:03:00Z") }
  );

  assert.equal(updated.history.at(-1).id, "β");
  assert.equal(updated.history.at(-1).reviewedAt, "06-28 16:03Z");
  assert.equal(updated.lastReviewedSha, "def5678");
  assert.equal(updated.lastReviewedAt, "2026-06-28T16:03:00Z");
  assert.equal(updated.requirements.at(-1).review, "β");
  assert.equal(updated.findings.at(-1).review, "β");
  assert.equal(updated.disposition, "APPROVE");
});

test("resolveWorkpadInput merges an incremental update from existing markdown", () => {
  const existingBody = renderCadenceWorkpad(structuredWorkpad);
  const resolved = resolveWorkpadInput({
    existingBody,
    incomingWorkpad: {
      pendingTriggerState: "none",
      reviewUpdate: {
        range: "c4274ae...def5678",
        sha: "def5678",
        summary: "No unreviewed comments remain.",
      },
    },
    now: new Date("2026-06-28T17:04:00Z"),
  });

  assert.equal(resolved.history.length, 2);
  assert.equal(resolved.history[1].id, "β");
  assert.equal(resolved.pendingTriggerState, "none");
  assert.equal(resolved.lastReviewedSha, "def5678");
});

test("review and event-gate writes preserve the latest bridge-owned ledger", () => {
  const bridgeState = {
    nonReviewWakeups: [{ key: "check:42:head:99", operation: "updated" }],
    lastNonReviewWakeup: {
      key: "check:42:head:99",
      mutation: { success: true },
    },
  };
  const existingBody = renderCadenceWorkpad({
    ...structuredWorkpad,
    coordination: { ...bridgeState, oldReviewField: "discard" },
  });
  for (const incomingWorkpad of [
    {
      status: "review-requested",
      coordination: { trigger: "review", nonReviewWakeups: [] },
    },
    { reviewUpdate: { sha: "new-head", coordination: { trigger: "review" } } },
    { coordination: "Review complete" },
  ]) {
    const resolved = resolveWorkpadInput({ existingBody, incomingWorkpad });
    assert.deepEqual(
      resolved.coordination.nonReviewWakeups,
      bridgeState.nonReviewWakeups
    );
    assert.deepEqual(
      resolved.coordination.lastNonReviewWakeup,
      bridgeState.lastNonReviewWakeup
    );
    assert.equal(resolved.coordination.oldReviewField, undefined);
    if (typeof incomingWorkpad.coordination === "string")
      assert.equal(resolved.coordination.reviewCoordination, "Review complete");
    else assert.equal(resolved.coordination.trigger, "review");
  }
});

test("lossless layout keeps all review state when the duplicate display exceeds the budget", () => {
  const workpad = { ...structuredWorkpad, summary: "s".repeat(24000) };
  const expected = parseCadenceWorkpad(renderCadenceWorkpad(workpad));
  const { body, compacted } = renderCadenceWorkpadForLinear(workpad);
  assert.equal(compacted, false);
  assert.ok(body.length < 50000);
  assert.match(body, /Display detail omitted/);
  assert.deepEqual(parseCadenceWorkpad(body), expected);
});

test("full snapshots recover malformed canonical JSON without losing readable bridge state", () => {
  const bridgeState = {
    nonReviewWakeups: [{ key: "key", operation: "updated" }],
  };
  const body = renderCadenceWorkpad({ coordination: bridgeState }).replace(
    /("schemaVersion": "cadence-workpad\/v1alpha1")/,
    "$1, BROKEN JSON"
  );
  assert.throws(() => parseCadenceWorkpad(body), /not valid JSON/);
  const resolved = resolveWorkpadInput({
    existingBody: body,
    incomingWorkpad: { status: "completed" },
  });
  assert.equal(resolved.status, "completed");
  assert.deepEqual(
    resolved.coordination.nonReviewWakeups,
    bridgeState.nonReviewWakeups
  );
  assert.match(resolved.other[0], /Replaced malformed review JSON/);
  assert.throws(
    () =>
      resolveWorkpadInput({
        existingBody: body,
        incomingWorkpad: { reviewUpdate: { sha: "head" } },
      }),
    /not valid JSON/
  );
  assert.throws(() =>
    resolveWorkpadInput({
      existingBody: body.replace(
        '"operation": "updated"',
        '"operation": BROKEN'
      ),
      incomingWorkpad: { status: "completed" },
    })
  );
});

test("minimal review compaction bounds old oversized bridge errors and retains dedup", () => {
  const { body, compacted } = renderCadenceWorkpadForLinear({
    ...structuredWorkpad,
    coordination: {
      largeReviewState: Array(100).fill("r".repeat(500)),
      nonReviewWakeups: [{ key: "workflow:123:1", operation: "updated" }],
      lastNonReviewWakeup: { key: "workflow:123:1", error: "e".repeat(60000) },
    },
  });
  assert.equal(compacted, true);
  assert.ok(body.length < 50000);
  const saved = parseCadenceWorkpad(body);
  assert.equal(saved.coordination.nonReviewWakeups[0].key, "workflow:123:1");
  assert.ok(saved.coordination.lastNonReviewWakeup.error.length <= 600);
});

test("minimal review compaction retains bridge dedup and last evidence", () => {
  const bridgeState = {
    nonReviewWakeups: [{ key: "workflow:123:1", operation: "updated" }],
    lastNonReviewWakeup: { key: "workflow:123:1", mutation: { success: true } },
  };
  const { body, compacted } = renderCadenceWorkpadForLinear({
    ...structuredWorkpad,
    coordination: {
      ...bridgeState,
      largeReviewState: Array(100).fill("r".repeat(500)),
    },
  });
  assert.equal(compacted, true);
  assert.ok(body.length < 50000);
  const saved = parseCadenceWorkpad(body);
  assert.deepEqual(
    saved.coordination.nonReviewWakeups,
    bridgeState.nonReviewWakeups
  );
  assert.deepEqual(
    saved.coordination.lastNonReviewWakeup,
    bridgeState.lastNonReviewWakeup
  );
});

test("upsertCadenceWorkpad creates a Cadence workpad when unrelated comments exist", async () => {
  const linear = makeLinearFetch({
    comments: [
      { id: "c1", body: "Unrelated implementation note" },
      { id: "c2", body: "## Codex Workpad\n\nStatus: In Progress" },
    ],
  });

  const result = await upsertCadenceWorkpad({
    issueIdentifier: "DEMO-112",
    workpad: sampleWorkpad,
    token: "linear-token",
    fetchImpl: linear.fetchImpl,
  });

  assert.equal(result.operation, "created");
  assert.equal(linear.created.length, 1);
  assert.equal(linear.updated.length, 0);
  assert.equal(
    linear.comments.filter((comment) => isCadenceWorkpadBody(comment.body))
      .length,
    1
  );
});

test("upsertCadenceWorkpad updates the existing Cadence workpad instead of appending duplicates", async () => {
  const linear = makeLinearFetch({
    comments: [
      { id: "c1", body: "Unrelated implementation note" },
      { id: "cadence", body: "## Cadence Workpad\n\nStatus: running" },
      { id: "c2", body: "Another unrelated comment" },
    ],
  });

  const result = await upsertCadenceWorkpad({
    issueIdentifier: "DEMO-112",
    workpad: sampleWorkpad,
    token: "linear-token",
    fetchImpl: linear.fetchImpl,
  });

  assert.equal(result.operation, "updated");
  assert.deepEqual(
    linear.updated.map((call) => call.commentId),
    ["cadence"]
  );
  assert.equal(linear.created.length, 0);
  assert.equal(
    linear.comments.filter((comment) => isCadenceWorkpadBody(comment.body))
      .length,
    1
  );
});

test("upsertCadenceWorkpad applies incremental updates to the existing Cadence workpad", async () => {
  const linear = makeLinearFetch({
    comments: [
      {
        id: "cadence",
        body: renderCadenceWorkpad(structuredWorkpad),
      },
    ],
  });

  const result = await upsertCadenceWorkpad({
    issueIdentifier: "DEMO-112",
    workpad: {
      reviewUpdate: {
        range: "c4274ae...def5678",
        sha: "def5678",
        summary: "Follow-up review added.",
      },
    },
    token: "linear-token",
    fetchImpl: linear.fetchImpl,
    now: new Date("2026-06-28T18:05:00Z"),
  });

  const parsed = parseCadenceWorkpad(result.body);

  assert.equal(result.operation, "updated");
  assert.equal(linear.updated.length, 1);
  assert.equal(parsed.history.length, 2);
  assert.equal(parsed.history[1].id, "β");
  assert.equal(parsed.history[1].reviewedAt, "06-28 18:05Z");
});

test("upsertCadenceWorkpad compacts an oversized existing workpad before updating it", async () => {
  const oversizedWorkpad = {
    ...structuredWorkpad,
    findings: Array.from({ length: 30 }, (_, index) => ({
      id: `AR-existing-${index}`,
      lifecycle: "carried",
      class: "human-needed",
      locality: "local",
      severity: "medium",
      status: "open",
      summary: `Existing finding ${index}. ${"Large prior detail. ".repeat(
        90
      )}`,
    })),
  };
  const warnings = [];
  const linear = makeLinearFetch({
    comments: [
      {
        id: "cadence",
        body: renderCadenceWorkpad(oversizedWorkpad),
      },
    ],
  });

  const result = await upsertCadenceWorkpad({
    issueIdentifier: "DEMO-112",
    workpad: {
      reviewUpdate: {
        range: "def5678...fed9876",
        sha: "fed9876",
        summary: "Latest compacted review added.",
        findings: [
          {
            id: "AR-latest",
            lifecycle: "new",
            class: "suggestion",
            locality: "local",
            severity: "low",
            status: "open",
            summary: "Newest finding survives compaction.",
          },
        ],
      },
    },
    token: "linear-token",
    fetchImpl: linear.fetchImpl,
    logger: { warn: (message) => warnings.push(message) },
    maxCommentChars: 40000,
    now: new Date("2026-06-28T19:05:00Z"),
  });
  const parsed = parseCadenceWorkpad(result.body);

  assert.equal(result.operation, "updated");
  assert.equal(linear.updated.length, 1);
  assert.equal(linear.created.length, 0);
  assert.ok(result.body.length <= 40000);
  assert.match(warnings[0], /compacting older detail/);
  assert.equal(parsed.findings.at(-1).id, "AR-latest");
  assert.equal(
    linear.comments.filter((comment) => isCadenceWorkpadBody(comment.body))
      .length,
    1
  );
});

test("upsertCadenceWorkpad warns when multiple Cadence workpads already exist", async () => {
  const warnings = [];
  const linear = makeLinearFetch({
    comments: [
      { id: "cadence-old", body: "## Cadence Workpad\n\nStatus: old" },
      { id: "cadence-new", body: "## Cadence Workpad\n\nStatus: duplicate" },
    ],
  });

  const result = await upsertCadenceWorkpad({
    issueIdentifier: "DEMO-112",
    workpad: sampleWorkpad,
    token: "linear-token",
    fetchImpl: linear.fetchImpl,
    logger: { warn: (message) => warnings.push(message) },
  });

  assert.equal(result.operation, "updated");
  assert.deepEqual(
    linear.updated.map((call) => call.commentId),
    ["cadence-old"]
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Found 2 Cadence Workpad comments/);
});

test("contract detection ignores quoted field names in valid workpad prose", async () => {
  const { queued } = contractFixture();
  for (const mode of ["prose", "contract", "malformed-contract", "missing-fence", "wrong-fence", "missing-heading"]) {
    let body = renderCadenceWorkpad(mode === "prose"
      ? { summary: 'This review discusses the "reviewContract" field.' }
      : { reviewContract: queued });
    if (mode === "malformed-contract") body = body.replace('"generation": {', '"generation": INVALID {');
    if (mode === "missing-fence") body = body.replace(/\n```\s*$/, "");
    if (mode === "wrong-fence") body = body.replace("### Review Object\n```json", "### Review Object\n```text");
    if (mode === "missing-heading") body = body.replace("### Review Object", "### Lost Object");
    const linear = makeLinearFetch({ comments: [
      { id: "cadence-old", body }, { id: "cadence-new", body },
    ] });
    const warnings = [];
    const result = upsertCadenceWorkpad({ issueIdentifier: "DEMO-112", workpad: sampleWorkpad,
      token: "linear-token", fetchImpl: linear.fetchImpl, logger: { warn: message => warnings.push(message) } });
    if (mode === "prose") {
      assert.equal((await result).operation, "updated");
      assert.equal(linear.updated.length, 1);
      assert.match(warnings[0], /Found 2 Cadence Workpad comments/);
    } else {
      await assert.rejects(result, /Duplicate Cadence workpads/);
      assert.equal(linear.updated.length, 0);
    }
  }
});

test("upsertCadenceWorkpad does not touch Codex Workpad comments", async () => {
  const codexBody = "## Codex Workpad\n\nStatus: In Review";
  const linear = makeLinearFetch({
    comments: [
      { id: "codex", body: codexBody },
      { id: "cadence", body: "## Cadence Workpad\n\nStatus: old" },
    ],
  });

  await upsertCadenceWorkpad({
    issueIdentifier: "DEMO-112",
    workpad: sampleWorkpad,
    token: "linear-token",
    fetchImpl: linear.fetchImpl,
  });

  assert.equal(
    linear.comments.find((comment) => comment.id === "codex").body,
    codexBody
  );
  assert.deepEqual(
    linear.updated.map((call) => call.commentId),
    ["cadence"]
  );
  assert.equal(isCadenceWorkpadBody(codexBody), false);
});

test("Cadence workpad heading detection ignores similar or indented headings", () => {
  assert.equal(
    isCadenceWorkpadBody("\n\n## Cadence Workpad\n\nStatus: old"),
    true
  );
  assert.equal(
    isCadenceWorkpadBody("## Cadence Workpad Archive\n\nStatus: old"),
    false
  );
  assert.equal(
    isCadenceWorkpadBody(" ## Cadence Workpad\n\nStatus: indented"),
    false
  );
});

test("loadToken accepts either Linear token environment variable", () => {
  assert.equal(loadToken({ LINEAR_API_TOKEN: "token-a" }), "token-a");
  assert.equal(loadToken({ LINEAR_API_KEY: "token-b" }), "token-b");
});

test("loadToken fails clearly when no Linear token is configured", () => {
  assert.throws(() => loadToken({}), /Set LINEAR_API_TOKEN or LINEAR_API_KEY/);
});

test("readWorkpadInput reads JSON from stdin when path is -", () => {
  const input = readWorkpadInput("-", {
    readFile: (path, encoding) => {
      assert.equal(path, 0);
      assert.equal(encoding, "utf8");
      return '{"status":"completed"}';
    },
  });

  assert.deepEqual(input, { status: "completed" });
});

test("readWorkpadInput reports invalid JSON", () => {
  assert.throws(
    () =>
      readWorkpadInput("workpad.json", {
        readFile: () => "{not-json",
      }),
    /Workpad input is not valid JSON/
  );
});

test("formatReviewTimestamp uses a deterministic UTC month-day-hour-minute stamp", () => {
  assert.equal(
    formatReviewTimestamp(new Date("2026-06-28T03:04:05Z")),
    "06-28 03:04Z"
  );
});

test("Linear API write errors mention missing write access without exposing the token", async () => {
  const linear = makeLinearFetch({
    comments: [{ id: "cadence", body: "## Cadence Workpad\n\nStatus: old" }],
    failUpdate: "secret-token cannot update this comment",
  });

  await assert.rejects(
    () =>
      upsertCadenceWorkpad({
        issueIdentifier: "DEMO-112",
        workpad: sampleWorkpad,
        token: "secret-token",
        fetchImpl: linear.fetchImpl,
      }),
    (error) => {
      assert.match(
        error.message,
        /permission to create and update Linear comments/
      );
      assert.doesNotMatch(error.message, /secret-token/);
      assert.match(error.message, /\[redacted\] cannot update this comment/);
      return true;
    }
  );
});

test("Linear API create errors mention missing write access without exposing the token", async () => {
  const linear = makeLinearFetch({
    comments: [],
    failCreate: "secret-token cannot create comments",
  });

  await assert.rejects(
    () =>
      upsertCadenceWorkpad({
        issueIdentifier: "DEMO-112",
        workpad: sampleWorkpad,
        token: "secret-token",
        fetchImpl: linear.fetchImpl,
      }),
    (error) => {
      assert.match(
        error.message,
        /permission to create and update Linear comments/
      );
      assert.doesNotMatch(error.message, /secret-token/);
      assert.match(error.message, /\[redacted\] cannot create comments/);
      return true;
    }
  );
});

import { createReviewGeneration, feedbackWatermark, queueReviewGeneration,
  completeReviewGeneration, startReviewGeneration } from "./symphony/review-contract.mjs";

function contractFixture() {
  const generation = createReviewGeneration({ repositoryId: 1, prNumber: 2,
    headSha: "a".repeat(40), baseSha: "b".repeat(40), configRevision: "c".repeat(40),
    feedback: feedbackWatermark(Object.fromEntries(["reviews", "comments", "threads", "linearComments", "commits"]
      .map(key => [key, { nodes: [], complete: true }]))) });
  const queued = queueReviewGeneration(null, generation, { checkId: 3 });
  const output = { schema: "cadence-review/v1", repositoryId: 1, prNumber: 2,
    headSha: generation.headSha, generationId: generation.id, sourcesComplete: true, summary: "Gate verified",
    requirements: [{ id: "R05", status: "satisfied", summary: "Gate enforced", evidence: ["fixture"] }],
    findings: [{ id: "F1", class: "suggestion", mandatory: false, status: "open", summary: "Optional", evidence: ["fixture"] }],
    humanFeedback: [] };
  const completed = completeReviewGeneration(queued, { generationId: generation.id,
    attempt: 1, checkId: 3, phase: "completed", output }, generation);
  return { generation, queued, completed };
}

test("contract queue/completion round-trips full generations, history, finding IDs and classifications", () => {
  const { generation, queued, completed } = contractFixture();
  const legacy = renderCadenceWorkpad(structuredWorkpad);
  const first = resolveWorkpadInput({ incomingWorkpad: { reviewContract: queued }, existingBody: legacy });
  const next = resolveWorkpadInput({ incomingWorkpad: { reviewContract: completed,
    reviewUpdate: { requirements: completed.output.requirements, findings: completed.output.findings } },
    existingBody: renderCadenceWorkpad(first), liveGeneration: generation });
  const parsed = parseCadenceWorkpad(renderCadenceWorkpad(next));
  assert.deepEqual(parsed.reviewContract, completed);
  assert.deepEqual(parsed.reviewContractHistory, [queued]);
  assert.equal(parsed.requirements[0].id, structuredWorkpad.requirements[0].id);
  assert.equal(parsed.findings.at(-1).id, "F1");
  assert.equal(parsed.findings.at(-1).class, "suggestion");
  assert.equal(parsed.findings.at(-1).mandatory, false);
  assert.deepEqual(parsed.findings.at(-1).evidence, ["fixture"]);
  const bookkeeping = resolveWorkpadInput({ incomingWorkpad: { status: "event-gate", findings: [] },
    existingBody: renderCadenceWorkpad(parsed) });
  assert.deepEqual(bookkeeping.reviewContract, completed);
  assert.deepEqual(bookkeeping.reviewContractHistory, [queued]);
  assert.deepEqual(bookkeeping.findings, parsed.findings);
});

test("stale completions, changing heads, missing live evidence and malformed contract history reject", () => {
  const { generation, queued, completed } = contractFixture();
  const newer = createReviewGeneration({ ...generation, headSha: "d".repeat(40) });
  const newerQueue = queueReviewGeneration(queued, newer, { checkId: 4 });
  for (const [stored, live] of [[queued, newer], [newerQueue, newer], [queued, undefined]]) {
    assert.throws(() => resolveWorkpadInput({ incomingWorkpad: { reviewContract: completed },
      existingBody: renderCadenceWorkpad({ reviewContract: stored }), liveGeneration: live }), /Superseded/);
  }
  assert.throws(() => resolveWorkpadInput({ incomingWorkpad: { reviewContract: queued },
    existingBody: renderCadenceWorkpad({ reviewContract: newerQueue }) }), /invalid/);
  const broken = renderCadenceWorkpad({ reviewContract: queued }).replace('"generation": {', '"generation": INVALID {');
  assert.throws(() => resolveWorkpadInput({ incomingWorkpad: { reviewContract: queued }, existingBody: broken }));
});

test("contract watermark/history can never be compacted into false clean evidence", () => {
  const { completed } = contractFixture();
  assert.throws(() => renderCadenceWorkpadForLinear({ reviewContract: completed,
    findings: Array.from({ length: 100 }, (_, n) => ({ id: `F${n}`, class: "blocker", summary: "must retain".repeat(100) })) },
  { maxCommentChars: 5000 }), /cannot be truncated/);
});

test("public workpad writer rejects denied writes, duplicate anchors and changed readback", async () => {
  const { queued } = contractFixture();
  for (const mode of ["success", "denied", "readback-mismatch", "duplicate", "missing-cursor"]) {
    let body = renderCadenceWorkpad(structuredWorkpad), writes = 0;
    const result = upsertCadenceWorkpad({ issueIdentifier: "TEST-1", token: "fixture-token",
      workpad: { reviewContract: queued }, fetchImpl: async (_, options) => {
        const { query, variables } = JSON.parse(options.body);
        let data;
        if (query.includes("query CadenceWorkpadIssue")) {
          const comment = { id: "anchor", body: mode === "readback-mismatch" && writes ? "changed" : body, createdAt: "2026-09-10" };
          data = { issue: { id: "issue", identifier: "TEST-1", comments: {
            nodes: mode === "duplicate" ? [comment, { ...comment, id: "other" }] : [comment],
            pageInfo: { hasNextPage: mode === "missing-cursor", endCursor: null } } } };
        } else {
          writes++;
          assert.equal(variables.commentId, "anchor");
          body = variables.body;
          data = { commentUpdate: { success: mode !== "denied", comment: mode === "denied" ? null : { id: "anchor" } } };
        }
        return { ok: true, json: async () => ({ data }) };
      } });
    if (mode === "success") {
      const written = await result;
      assert.equal(written.commentId, "anchor");
      assert.deepEqual(parseCadenceWorkpad(written.body).reviewContract, queued);
    } else await assert.rejects(result);
    assert.equal(writes, ["duplicate", "missing-cursor"].includes(mode) ? 0 : 1);
  }
});


test("running review persistence requires the live generation and preserves its pass budget", () => {
  const { generation, queued } = contractFixture();
  const running = startReviewGeneration(queued, generation);
  const stored = resolveWorkpadInput({ incomingWorkpad: { reviewContract: running },
    existingBody: renderCadenceWorkpad({ reviewContract: queued }), liveGeneration: generation });
  assert.equal(stored.reviewContract.phase, "in_progress");
  assert.equal(stored.reviewContract.passes, queued.passes);
  assert.throws(() => startReviewGeneration(queued, { id: "stale" }), /Superseded/);
});

test("unreadable canonical contract cannot degrade to a legacy snapshot", () => {
  const { queued } = contractFixture();
  const original = renderCadenceWorkpad({ reviewContract: queued });
  for (const body of [original.replace(/\n```\s*$/, ""),
    original.replace("### Review Object\n```json", "### Review Object\n```text"),
    original.replace("### Review Object", "### Lost Object")]) {
    assert.throws(() => parseCadenceWorkpad(body), /review object|contract/);
    assert.throws(() => resolveWorkpadInput({ existingBody: body, incomingWorkpad: sampleWorkpad }), /review object|contract/);
  }
});

test("the final canonical block is authoritative and must be readable", () => {
  const first = renderCadenceWorkpad({ summary: "old" });
  assert.equal(parseCadenceWorkpad(first.replaceAll("\n", "\r\n")).summary, "old");
  const second = renderCadenceWorkpad({ summary: "new" }).split("### Review Object")[1];
  assert.equal(parseCadenceWorkpad(`${first}\n### Review Object${second}`).summary, "new");
  assert.throws(() => parseCadenceWorkpad(`${first}\n### Review Object\ntruncated`), /review object/);
});

test("incomplete comment history cannot erase a stored contract during bookkeeping", async () => {
  const { queued } = contractFixture();
  let writes = 0;
  await assert.rejects(upsertCadenceWorkpad({ issueIdentifier: "TEST-1", token: "fixture-token",
    workpad: sampleWorkpad, fetchImpl: async (_, options) => {
      const { query } = JSON.parse(options.body);
      if (!query.includes("query CadenceWorkpadIssue")) writes++;
      return { ok: true, json: async () => ({ data: { issue: { id: "issue", identifier: "TEST-1", comments: {
        nodes: [{ id: "anchor", body: renderCadenceWorkpad({ reviewContract: queued }) }],
        pageInfo: undefined } } } }) };
    } }), /Incomplete Linear comment history/);
  assert.equal(writes, 0);
});

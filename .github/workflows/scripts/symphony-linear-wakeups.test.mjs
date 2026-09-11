import yaml from "js-yaml";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseCadenceWorkpad,
  renderCadenceWorkpad,
  renderCadenceWorkpadForLinear,
  resolveWorkpadInput,
} from "../../../scripts/cadence-linear-workpad.mjs";
import {
  applyWakeup as applyWakeupImpl,
  createGitHubClient,
  planWakeups as planWakeupsImpl,
  requiredCi,
  resolveIssue as resolveIssueImpl,
  runBridge as runBridgeImpl,
  workflowTicket as workflowTicketImpl,
} from "./symphony-linear-wakeups.mjs";

// Fixture team is explicit; exported tests do not depend on publication-root config.
const applyWakeup = (options) =>
  applyWakeupImpl({ teamKey: "100", ...options });
const planWakeups = (options) =>
  planWakeupsImpl({ teamKey: "100", ...options });
const resolveIssue = (options) =>
  resolveIssueImpl({ teamKey: "100", ...options });
const runBridge = (options) => runBridgeImpl({ teamKey: "100", ...options });
const workflowTicket = (run) => workflowTicketImpl(run, "100");

const repo = "example-org/example-repo";
const head = "a".repeat(40);
const base = "b".repeat(40);
const branch = "symphony/sample-workpad/100-502/github-linear-wakeups";
const runUrl = `https://github.com/${repo}/actions/runs/123`;
const pr = (overrides = {}) => ({
  number: 42,
  title: "[100-502]: wake Linear",
  state: "open",
  html_url: `https://github.com/${repo}/pull/42`,
  labels: [{ name: "symphony" }, { name: "yellow" }],
  head: { sha: head, ref: branch, repo: { full_name: repo } },
  base: { sha: base, ref: "main", repo: { full_name: repo } },
  mergeable: false,
  mergeable_state: "dirty",
  ...overrides,
});
const check = (overrides = {}) => ({
  databaseId: 99,
  name: "tooling-check",
  conclusion: "FAILURE",
  detailsUrl: `${runUrl}/job/99`,
  checkSuite: {
    app: { databaseId: 15368 },
    workflowRun: { workflow: { id: "workflow-1" } },
  },
  isRequired: true,
  ...overrides,
});
const workflow = (overrides = {}) => ({
  id: 123,
  run_attempt: 1,
  name: "PR Checks",
  path: ".github/workflows/checks.yml",
  event: "pull_request",
  status: "completed",
  conclusion: "failure",
  head_sha: head,
  head_branch: branch,
  head_repository: { full_name: repo },
  pull_requests: [{ number: 42 }],
  html_url: runUrl,
  actor: { login: "example-symphony-bot" },
  ...overrides,
  // Model the rendered run-name in both fields when a display title is supplied.
  ...(overrides.display_title ? { name: overrides.display_title } : {}),
});
const event = (overrides = {}) => ({
  action: "completed",
  workflow_run: workflow(),
  ...overrides,
});
const github = (overrides = {}) => ({
  getPr: async () => pr(),
  listPrs: async () => [pr()],
  commitPrs: async () => [pr()],
  checks: async () => [check()],
  getRun: async () => workflow(),
  ...overrides,
});
const plan = (overrides = {}) =>
  planWakeups({
    repo,
    eventName: "workflow_run",
    payload: event(),
    github: github(),
    bridgeRunUrl: `${runUrl}4`,
    ...overrides,
  });

const ciRule = {
  name: "tooling-check",
  workflow: ".github/workflows/checks.yml",
  appId: 15368,
};
const passedCheck = (overrides = {}) =>
  check({
    status: "COMPLETED",
    conclusion: "SUCCESS",
    checkSuite: {
      app: { databaseId: 15368 },
      workflowRun: {
        databaseId: 123,
        file: { path: ciRule.workflow },
        workflow: { id: "workflow-1" },
      },
    },
    ...overrides,
  });

for (const [name, checks, run, rules, expected] of [
  ["passed", [passedCheck()], {}, [ciRule], "Inactive"],
  ["missing", [], {}, [ciRule], "Unhappy"],
  ["no contract", [passedCheck()], {}, [], "Unhappy"],
  [
    "multiple requirements",
    [passedCheck()],
    {},
    [ciRule, { ...ciRule, name: "second" }],
    "Unhappy",
  ],
  [
    "all requirements",
    [passedCheck(), passedCheck({ name: "second", databaseId: 100 })],
    {},
    [ciRule, { ...ciRule, name: "second" }],
    "Inactive",
  ],
  [
    "pending check",
    [passedCheck({ status: "IN_PROGRESS", conclusion: null })],
    {},
    [ciRule],
    "Unhappy",
  ],
  [
    "pending rerun supersedes old failed check",
    [passedCheck({ conclusion: "FAILURE" })],
    { status: "in_progress", conclusion: null, run_attempt: 2 },
    [ciRule],
    "Unhappy",
  ],
  [
    "stale run",
    [passedCheck()],
    { head_sha: "c".repeat(40) },
    [ciRule],
    "Unhappy",
  ],
  [
    "skipped",
    [passedCheck({ conclusion: "SKIPPED" })],
    {},
    [ciRule],
    "Unhappy",
  ],
  [
    "canceled",
    [passedCheck()],
    { conclusion: "cancelled" },
    [ciRule],
    "Active",
  ],
  [
    "failed check",
    [passedCheck({ conclusion: "FAILURE" })],
    {},
    [ciRule],
    "Active",
  ],
  [
    "unrelated advisory failure",
    [
      passedCheck(),
      passedCheck({
        name: "Cadence Review",
        conclusion: "FAILURE",
        databaseId: 101,
      }),
    ],
    {},
    [ciRule],
    "Inactive",
  ],
  [
    "advisory alone",
    [passedCheck({ name: "Cadence Review" })],
    {},
    [{ ...ciRule, name: "Cadence Review" }],
    "Unhappy",
  ],
  ["push completion", [passedCheck()], { event: "push" }, [ciRule], "Inactive"],
  [
    "generic dispatch completion",
    [passedCheck()],
    { event: "workflow_dispatch" },
    [ciRule],
    "Inactive",
  ],
]) {
  test(`required CI: ${name}`, async () => {
    const result = await requiredCi({
      number: 42,
      headSha: head,
      requiredChecks: rules,
      github: github({
        checks: async () => checks,
        getRun: async () => workflow({ conclusion: "success", ...run }),
      }),
    });
    assert.equal(result.state, expected);
  });
}

test("same-name checks require their actual workflow and emitting App", async () => {
  for (const suite of [
    {
      app: { databaseId: 42 },
      workflowRun: { databaseId: 123, file: { path: ciRule.workflow } },
    },
    {
      app: { databaseId: 15368 },
      workflowRun: {
        databaseId: 123,
        file: { path: ".github/workflows/other.yml" },
      },
    },
    { app: { databaseId: 15368 } },
  ]) {
    const result = await requiredCi({
      number: 42,
      headSha: head,
      requiredChecks: [ciRule],
      github: github({
        checks: async () => [passedCheck({ checkSuite: suite })],
      }),
    });
    assert.equal(result.state, "Unhappy");
  }
});

test("incomplete check pagination cannot establish success", async () => {
  const result = await requiredCi({
    number: 42,
    headSha: head,
    requiredChecks: [ciRule],
    github: github({
      checks: async () => Object.assign([passedCheck()], { complete: false }),
      getRun: async () => workflow({ conclusion: "success" }),
    }),
  });
  assert.equal(result.state, "Unhappy");
});

const active = { id: "active", name: "Active", type: "started" };
const inactive = { id: "inactive", name: "Inactive", type: "unstarted" };
const fixtureIssue = () => ({
  id: "issue-502",
  identifier: "100-502",
  state: inactive,
  team: { states: { nodes: [active] } },
  labels: { nodes: [{ name: "yellow" }] },
  project: {
    id: "project",
    content:
      "project-code: sample-workpad\nproject-color: yellow\nhuman-lead: Example Lead",
  },
});
const response = (data, status = 200) => ({
  ok: status === 200,
  status,
  json: async () => ({ data }),
});

function linearFixture(options = {}) {
  let issue = { ...fixtureIssue(), ...options.issue };
  let comment = options.noWorkpad
    ? null
    : {
        id: "cadence-pad",
        createdAt: "2026-09-07T00:00:00Z",
        body:
          options.body ||
          renderCadenceWorkpadForLinear({
            lastReviewedSha: "reviewed-sha",
            summary: "Keep review",
            coordination: { reviewHandoff: { keep: true } },
          }).body,
      };
  const calls = [];
  let reads = 0;
  return {
    calls,
    get issue() {
      return issue;
    },
    get comment() {
      return comment;
    },
    async fetchImpl(url, request) {
      assert.equal(url, "https://api.linear.app/graphql");
      const { query, variables } = JSON.parse(request.body);
      calls.push({ query, variables });
      if (query.includes("WakeupViewer"))
        return response({
          viewer: options.viewer || {
            id: "cadence-bot",
            name: "Example Review Bot",
          },
        });
      if (query.includes("CadenceWorkpadIssue"))
        return response({
          issue: {
            id: issue.id,
            identifier: issue.identifier,
            comments: {
              nodes: [
                ...(comment ? [comment] : []),
                { id: "codex", body: "## Codex Workpad\nDo not overwrite" },
                { id: "engine", body: "## Symphony Workpad\nLast run" },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        });
      if (query.includes("WakeupWorkpadCreate")) {
        if (options.createFailure)
          return response({ commentCreate: { success: false } });
        comment = { id: "cadence-pad", body: variables.body };
        return response({
          commentCreate: { success: true, comment: { id: comment.id } },
        });
      }
      if (query.includes("WakeupWorkpadUpdate")) {
        assert.equal(variables.id, "cadence-pad");
        if (options.writeFailure)
          return response({ commentUpdate: { success: false } });
        comment.body = variables.body;
        return response({
          commentUpdate: { success: true, comment: { id: comment.id } },
        });
      }
      if (query.includes("LinearWakeupIssueUpdate")) {
        if (options.mutationFailure)
          return response({ issueUpdate: { success: false } });
        issue = {
          ...issue,
          state: issue.team.states.nodes.find(
            (state) => state.id === variables.stateId
          ),
        };
        return response({
          issueUpdate: {
            success: true,
            issue: {
              ...issue,
              ...(options.wrongMutation ? { id: "wrong-issue" } : {}),
            },
          },
        });
      }
      if (query.includes("LinearWakeupIssue")) {
        reads++;
        if (options.cancelDuringWrite && reads === 2)
          issue.state = { id: "canceled", name: "Canceled", type: "canceled" };
        return response({ issue });
      }
      if (query.includes("WakeupProject")) return response({ issue });
      throw new Error(`Unexpected query: ${query}`);
    },
  };
}
const mutations = (fixture) =>
  fixture.calls.filter((call) =>
    call.query.includes("LinearWakeupIssueUpdate")
  );

test("required failure from Actions workflow completion uses the current required check", async () => {
  const [result] = await plan();
  assert.equal(result.shouldWake, true);
  assert.equal(result.issueIdentifier, "100-502");
  assert.equal(result.reason, "required-check-failed");
  assert.equal(result.checkName, "tooling-check");
  assert.equal(result.headSha, head);
});

test("external check and status failures match current required evidence", async () => {
  const [external] = await plan({
    eventName: "check_run",
    payload: {
      action: "completed",
      check_run: {
        id: 99,
        status: "completed",
        conclusion: "failure",
        head_sha: head,
      },
    },
  });
  assert.equal(external.shouldWake, true);
  const [status] = await plan({
    eventName: "status",
    payload: { state: "error", sha: head, context: "CI" },
    github: github({
      checks: async () => [
        { context: "CI", state: "ERROR", isRequired: true, targetUrl: runUrl },
      ],
    }),
  });
  assert.equal(status.shouldWake, true);
});

test("successful checks are no-ops without API reads", async () => {
  const [result] = await plan({
    payload: event({ workflow_run: workflow({ conclusion: "success" }) }),
    github: {},
  });
  assert.equal(result.shouldWake, false);
  assert.equal(result.skippedReason, "successful-or-nonfailure-check");
});

for (const [name, checks] of [
  ["optional check", [check({ isRequired: false })]],
  ["recovered check", [check({ conclusion: "SUCCESS" })]],
  ["different workflow", [check({ detailsUrl: `${runUrl}9/job/99` })]],
])
  test(`${name} does not wake from a failed workflow`, async () => {
    const [result] = await plan({
      github: github({ checks: async () => checks }),
    });
    assert.equal(result.shouldWake, false);
  });

test("current merge conflict wakes and schedule reads the current base", async () => {
  for (const eventName of ["pull_request_target", "schedule"]) {
    const [result] = await plan({
      eventName,
      payload: eventName === "schedule" ? {} : { pull_request: pr() },
    });
    assert.equal(result.shouldWake, true);
    assert.equal(result.reason, "merge-conflict");
    assert.equal(result.baseSha, base);
  }
});

test("persisting conflicts are not re-woken just because the base advances", async () => {
  const fixture = linearFixture();
  for (const sha of [base, "c".repeat(40)]) {
    const [result] = await runBridge({
      eventName: "schedule",
      payload: {},
      repo,
      linearToken: "fixture",
      fetchImpl: fixture.fetchImpl,
      github: github({
        getPr: async () => pr({ base: { ...pr().base, sha } }),
      }),
    });
    assert.equal(result.operation, sha === base ? "updated" : "skipped");
    fixture.issue.state = inactive;
  }
  assert.equal(mutations(fixture).length, 1);
});

test("stale conflict and stale check events never wake the new head", async () => {
  const newer = github({
    getPr: async () => pr({ head: { ...pr().head, sha: "c".repeat(40) } }),
  });
  const [conflict] = await plan({
    eventName: "pull_request_target",
    payload: { pull_request: pr() },
    github: newer,
  });
  const [ci] = await plan({ github: newer });
  assert.equal(conflict.skippedReason, "stale-pr-head");
  assert.equal(ci.skippedReason, "stale-pr-head");
});

test("unknown or clean mergeability is not a conflict", async () => {
  for (const overrides of [
    { mergeable: null, mergeable_state: "unknown" },
    { mergeable: true, mergeable_state: "clean" },
  ]) {
    const [result] = await plan({
      eventName: "schedule",
      payload: {},
      github: github({ getPr: async () => pr(overrides) }),
    });
    assert.equal(result.shouldWake, false);
  }
});

test("workflow marker resolves an explicit issue without inputs or PRs", async () => {
  const [result] = await plan({
    payload: event({
      workflow_run: workflow({
        event: "workflow_dispatch",
        display_title: "[linear:100-600] Validate",
        pull_requests: [],
        conclusion: "success",
      }),
    }),
    github: github({ listPrs: async () => [] }),
  });
  assert.equal(result.shouldWake, true);
  assert.equal(result.issueIdentifier, "100-600");
  assert.equal(result.identitySource, "ticket_number");
  assert.equal(result.reason, "workflow-completed");
});

test("workflow completion resolves a PR title before branch with empty payload PR list", async () => {
  const [result] = await plan({
    payload: event({
      workflow_run: workflow({
        event: "workflow_dispatch",
        pull_requests: [],
        conclusion: "success",
      }),
    }),
    github: github({
      getPr: async () => pr({ title: "[100-600]: validation" }),
    }),
  });
  assert.equal(result.issueIdentifier, "100-600");
  assert.equal(result.identitySource, "pr-title");
});

test("workflow branch fallback supports issue-scoped validation without a PR", async () => {
  const [result] = await plan({
    payload: event({
      workflow_run: workflow({
        name: "Validate",
        event: "workflow_dispatch",
        pull_requests: [],
        conclusion: "success",
      }),
    }),
    github: github({ listPrs: async () => [] }),
  });
  assert.equal(result.issueIdentifier, "100-502");
  assert.equal(result.identitySource, "branch");
});

test("unticketed manual runs and bridge completions are no-ops", async () => {
  const [manual] = await plan({
    payload: event({
      workflow_run: workflow({
        event: "workflow_dispatch",
        pull_requests: [],
        head_branch: "main",
      }),
    }),
    github: github({ listPrs: async () => [] }),
  });
  const [recursive] = await plan({
    payload: event({ workflow_run: workflow({ event: "workflow_run" }) }),
    github: {},
  });
  assert.equal(manual.skippedReason, "workflow-not-issue-scoped");
  assert.equal(recursive.skippedReason, "bridge-recursion");
});

test("missing, malformed and ambiguous issue candidates fail closed", async () => {
  for (const ticketNumber of [
    "502",
    "100-1 100-2",
    "demo-502",
    "100-502] [linear:100-2",
  ])
    assert.throws(() => resolveIssue({ ticketNumber }), /Invalid explicit/);
  assert.throws(
    () => workflowTicket({ display_title: "[linear:] Validate" }),
    /Invalid explicit/
  );
  assert.throws(() => resolveIssue({ branch: "main" }), /Missing or ambiguous/);
  assert.throws(() => resolveIssue({ branch: "100-1-and-100-2" }), /ambiguous/);
  assert.equal(
    resolveIssue({
      ticketNumber: "100-3",
      pullRequests: [pr()],
      branch: "100-1-100-2",
    }).issueIdentifier,
    "100-3"
  );
  await assert.rejects(
    plan({
      github: github({
        getPr: async (number) =>
          pr({ number, title: `[100-${number}]: change` }),
      }),
      payload: event({
        workflow_run: workflow({
          pull_requests: [{ number: 42 }, { number: 43 }],
        }),
      }),
    }),
    /Ambiguous/
  );
});

test("fork, missing SHA, and stale workflow PR evidence fail closed", async () => {
  await assert.rejects(
    plan({
      payload: event({
        workflow_run: workflow({ head_repository: { full_name: "fork/repo" } }),
      }),
    }),
    /repository mismatch/
  );
  await assert.rejects(
    plan({ payload: event({ workflow_run: workflow({ head_sha: "" }) }) }),
    /Missing event head/
  );
  const [stale] = await plan({
    payload: event({ workflow_run: workflow({ event: "workflow_dispatch" }) }),
    github: github({
      getPr: async () => pr({ head: { ...pr().head, sha: "old" } }),
    }),
  });
  assert.equal(stale.skippedReason, "stale-workflow-head");
});

test("fixture proof: failed check, conflict and Symphony workflow completion wake Active", async (t) => {
  const cases = [
    { name: "required-check", eventName: "workflow_run", payload: event() },
    {
      name: "merge-conflict",
      eventName: "pull_request_target",
      payload: {
        pull_request: pr(),
        sender: { login: "example-symphony-bot" },
      },
    },
    {
      name: "validation-completion",
      eventName: "workflow_run",
      payload: event({
        workflow_run: workflow({
          path: ".github/workflows/validate.yml",
          event: "workflow_dispatch",
          pull_requests: [],
          conclusion: "success",
        }),
      }),
    },
  ];
  for (const item of cases) {
    const fixture = linearFixture();
    const [result] = await runBridge({
      ...item,
      repo,
      github: github({ getRun: async () => item.payload.workflow_run }),
      linearToken: "fixture-token",
      fetchImpl: fixture.fetchImpl,
      bridgeRunUrl: `${runUrl}4`,
    });
    assert.equal(result.operation, "updated", JSON.stringify(result));
    assert.equal(result.issueIdentifier, "100-502");
    assert.equal(result.previousState, "Inactive");
    assert.equal(result.state, "Active");
    assert.deepEqual(mutations(fixture)[0].variables, {
      id: "issue-502",
      stateId: "active",
    });
    const saved = parseCadenceWorkpad(fixture.comment.body);
    assert.equal(saved.lastReviewedSha, "reviewed-sha");
    assert.deepEqual(saved.coordination.reviewHandoff, { keep: true });
    assert.equal(saved.coordination.lastNonReviewWakeup.mutation.success, true);
    t.diagnostic(`MOCK API FIXTURE ${item.name}: ${JSON.stringify(result)}`);
  }
});

for (const name of ["Canceled", "Done", "Duplicate"])
  test(`terminal ${name} is recorded without reopening`, async () => {
    const fixture = linearFixture({ issue: { state: { id: name, name } } });
    const [eventPlan] = await plan();
    const result = await applyWakeup({
      plan: eventPlan,
      github: github(),
      repo,
      token: "fixture",
      fetchImpl: fixture.fetchImpl,
    });
    assert.equal(result.skippedReason, `terminal-state:${name}`);
    assert.equal(mutations(fixture).length, 0);
    const writes = () =>
      fixture.calls.filter((call) => call.query.includes("WakeupWorkpadUpdate"))
        .length;
    const before = writes();
    const body = fixture.comment.body;
    const duplicate = await applyWakeup({
      plan: eventPlan,
      github: github(),
      repo,
      token: "fixture",
      fetchImpl: fixture.fetchImpl,
    });
    assert.equal(duplicate.skippedReason, "duplicate-event");
    assert.equal(writes(), before);
    assert.equal(fixture.comment.body, body);
  });

test("post-mutation evidence failures retain the confirmed outcome and retry only evidence", async () => {
  for (const permanent of [false, true]) {
    const fixture = linearFixture();
    let attempts = 0;
    const fetchImpl = async (url, request) => {
      const { query } = JSON.parse(request.body);
      if (mutations(fixture).length && query.includes("WakeupWorkpadUpdate")) {
        attempts++;
        if (permanent || attempts === 1)
          return response({ commentUpdate: { success: false } });
      }
      return fixture.fetchImpl(url, request);
    };
    const [eventPlan] = await plan();
    const result = await applyWakeup({
      plan: eventPlan,
      github: github(),
      repo,
      token: "fixture",
      fetchImpl,
    });
    assert.equal(result.operation, "updated");
    assert.equal(result.mutation.success, true);
    assert.match(
      result.evidenceError,
      /Could not update pinned bridge workpad/
    );
    assert.equal(mutations(fixture).length, 1);
    assert.equal(attempts, 2);
    if (!permanent) {
      fixture.issue.state = inactive;
      const duplicate = await applyWakeup({
        plan: eventPlan,
        github: github(),
        repo,
        token: "fixture",
        fetchImpl,
      });
      assert.equal(duplicate.skippedReason, "duplicate-event");
      assert.equal(mutations(fixture).length, 1);
    }
  }
});

test("large API errors cannot fill the bridge ledger", async () => {
  const fixture = linearFixture();
  const [eventPlan] = await plan();
  const result = await applyWakeup({
    plan: eventPlan,
    repo,
    token: "fixture",
    fetchImpl: fixture.fetchImpl,
    github: github({
      getPr: async () => {
        throw new Error("large API error ".repeat(10000));
      },
    }),
  });
  assert.equal(result.operation, "failed");
  assert.match(result.error, /truncated for Linear limit/);
  assert.ok(result.error.length <= 1200);
  assert.ok(fixture.comment.body.length < 15000);
  assert.equal(
    parseCadenceWorkpad(fixture.comment.body).coordination.lastNonReviewWakeup
      .error,
    result.error
  );
});

test("missing Active uses explicit legacy Rework fallback", async () => {
  const fixture = linearFixture({
    issue: { team: { states: { nodes: [{ id: "rework", name: "Rework" }] } } },
  });
  const [eventPlan] = await plan();
  const result = await applyWakeup({
    plan: eventPlan,
    github: github(),
    repo,
    token: "fixture",
    fetchImpl: fixture.fetchImpl,
  });
  assert.equal(result.state, "Rework");
  assert.equal(result.fallback, "Active missing; using legacy Rework");
});

test("missing safe state, project metadata, or required labels prevents a mutation", async () => {
  for (const issue of [
    { team: { states: { nodes: [] } } },
    { project: null },
    { labels: { nodes: [] } },
    {
      project: {
        ...fixtureIssue().project,
        content:
          "project-code: wrong\nproject-color: yellow\nhuman-lead: Example",
      },
    },
  ]) {
    const fixture = linearFixture({ issue });
    const [eventPlan] = await plan();
    const result = await applyWakeup({
      plan: eventPlan,
      github: github(),
      repo,
      token: "fixture",
      fetchImpl: fixture.fetchImpl,
    });
    assert.equal(result.operation, "failed");
    assert.equal(mutations(fixture).length, 0);
    assert.match(fixture.comment.body, /failed/);
  }
});

test("cancellation during evidence write is rechecked before mutation", async () => {
  const fixture = linearFixture({ cancelDuringWrite: true });
  const [eventPlan] = await plan();
  const result = await applyWakeup({
    plan: eventPlan,
    github: github(),
    repo,
    token: "fixture",
    fetchImpl: fixture.fetchImpl,
  });
  assert.equal(result.skippedReason, "terminal-state:Canceled");
  assert.equal(mutations(fixture).length, 0);
});

test("a changed head or recovered check before mutation is skipped", async () => {
  const [eventPlan] = await plan();
  for (const client of [
    github({ getPr: async () => pr({ head: { ...pr().head, sha: "new" } }) }),
    github({ checks: async () => [check({ conclusion: "SUCCESS" })] }),
  ]) {
    const fixture = linearFixture();
    const result = await applyWakeup({
      plan: eventPlan,
      github: client,
      repo,
      token: "fixture",
      fetchImpl: fixture.fetchImpl,
    });
    assert.equal(result.operation, "skipped");
    assert.match(result.skippedReason, /changed-before-wakeup/);
    assert.equal(mutations(fixture).length, 0);
  }
});

test("workpad creation and update failures block state changes", async () => {
  for (const options of [
    { noWorkpad: true },
    { noWorkpad: true, createFailure: true },
    { writeFailure: true },
  ]) {
    const fixture = linearFixture(options);
    const [eventPlan] = await plan();
    const result = await applyWakeup({
      plan: eventPlan,
      github: github(),
      repo,
      token: "fixture",
      fetchImpl: fixture.fetchImpl,
    });
    assert.equal(
      result.operation,
      options.createFailure || options.writeFailure ? "failed" : "updated"
    );
    if (result.operation === "failed")
      assert.equal(mutations(fixture).length, 0);
  }
});

test("bot identity and missing token fail closed", async () => {
  const [eventPlan] = await plan();
  for (const token of [undefined, "fixture"]) {
    const fixture = linearFixture({
      viewer: { id: "human", name: "Example Lead" },
    });
    const result = await applyWakeup({
      plan: eventPlan,
      github: github(),
      repo,
      token,
      fetchImpl: fixture.fetchImpl,
    });
    assert.equal(result.operation, "failed");
    assert.equal(mutations(fixture).length, 0);
  }
});

test("mutation rejection and wrong returned issue preserve attempted mutation evidence", async () => {
  for (const options of [{ mutationFailure: true }, { wrongMutation: true }]) {
    const fixture = linearFixture(options);
    const [eventPlan] = await plan();
    const result = await applyWakeup({
      plan: eventPlan,
      github: github(),
      repo,
      token: "fixture",
      fetchImpl: fixture.fetchImpl,
    });
    assert.equal(result.operation, "failed");
    assert.equal(result.mutation.success, false);
    assert.equal(result.state, "Inactive");
  }
});

test("repeat delivery is deduplicated without replacing existing evidence", async () => {
  const fixture = linearFixture();
  const [eventPlan] = await plan();
  const options = {
    plan: eventPlan,
    github: github(),
    repo,
    token: "fixture",
    fetchImpl: fixture.fetchImpl,
  };
  await applyWakeup(options);
  const result = await applyWakeup(options);
  assert.equal(result.skippedReason, "duplicate-event");
  assert.equal(mutations(fixture).length, 1);
});

test("bounded ledger preserves review state, migrates full records, and survives review updates", async () => {
  const [eventPlan] = await plan();
  const fixture = linearFixture({
    body: renderCadenceWorkpad({
      lastReviewedSha: "reviewed-sha",
      summary: "Keep review",
      findings: [{ id: "F1", summary: "Keep this finding" }],
      coordination: {
        reviewHandoff: { keep: true },
        nonReviewWakeups: Array.from({ length: 15 }, (_, i) => ({
          ...eventPlan,
          key: `legacy-${i}`,
          operation: "updated",
        })),
      },
    }),
  });
  const before = parseCadenceWorkpad(fixture.comment.body);
  for (let i = 0; i < 40; i++) {
    fixture.issue.state = inactive;
    const result = await applyWakeup({
      plan: { ...eventPlan, key: `event-${i}` },
      github: github(),
      repo,
      token: "fixture",
      fetchImpl: fixture.fetchImpl,
    });
    assert.equal(result.operation, "updated");
    assert.ok(fixture.comment.body.length < 15000);
    const saved = parseCadenceWorkpad(fixture.comment.body);
    assert.equal(saved.summary, before.summary);
    assert.equal(saved.lastReviewedSha, before.lastReviewedSha);
    assert.deepEqual(saved.findings, before.findings);
    assert.deepEqual(saved.coordination.reviewHandoff, { keep: true });
    assert.equal(saved.coordination.nonReviewWakeups.length, 10);
    for (const item of saved.coordination.nonReviewWakeups)
      assert.ok(
        Object.keys(item).every((key) =>
          [
            "key",
            "operation",
            "reason",
            "skippedReason",
            "issueIdentifier",
            "at",
          ].includes(key)
        )
      );
    assert.equal(saved.coordination.lastNonReviewWakeup.key, `event-${i}`);
    assert.equal(saved.coordination.lastNonReviewWakeup.mutation.success, true);
  }
  // A review-gate write and a human parking the issue must not undo dedup.
  fixture.comment.body = renderCadenceWorkpad(
    resolveWorkpadInput({
      existingBody: fixture.comment.body,
      incomingWorkpad: {
        status: "review-requested",
        coordination: { trigger: "review" },
      },
    })
  );
  fixture.issue.state = inactive;
  const result = await applyWakeup({
    plan: { ...eventPlan, key: "event-38" },
    github: github(),
    repo,
    token: "fixture",
    fetchImpl: fixture.fetchImpl,
  });
  assert.equal(result.skippedReason, "duplicate-event");
  assert.equal(mutations(fixture).length, 40);
  assert.equal(fixture.issue.state.name, "Inactive");
});

test("near-limit review display never prevents evidence writes or loses canonical state", async () => {
  const template = {
    summary: "",
    lastReviewedSha: "reviewed-head",
    findings: [{ id: "F1", summary: "Preserve the full finding" }],
  };
  const empty = renderCadenceWorkpad(template);
  for (const size of [42000, 45000, 47615, 49800]) {
    const original = {
      ...template,
      summary: "r".repeat(Math.floor((size - empty.length) / 2)),
    };
    const fixture = linearFixture({ body: renderCadenceWorkpad(original) });
    assert.ok(fixture.comment.body.length <= size);
    const before = parseCadenceWorkpad(fixture.comment.body);
    const [eventPlan] = await plan();
    // Fill the complete ledger, then update it again on the lossless layout.
    for (let index = 0; index < 12; index++) {
      fixture.issue.state = inactive;
      const result = await applyWakeup({
        plan: { ...eventPlan, key: `size-${size}-${index}` },
        github: github(),
        repo,
        token: "fixture",
        fetchImpl: fixture.fetchImpl,
      });
      assert.equal(result.operation, "updated", JSON.stringify(result));
      assert.ok(fixture.comment.body.length <= 50000);
      const saved = parseCadenceWorkpad(fixture.comment.body);
      assert.deepEqual({ ...saved, coordination: before.coordination }, before);
      assert.equal(
        saved.coordination.lastNonReviewWakeup.mutation.success,
        true
      );
    }
    assert.equal(mutations(fixture).length, 12);
    assert.equal(
      parseCadenceWorkpad(fixture.comment.body).coordination.nonReviewWakeups
        .length,
      10
    );
  }
});

test("bridge evidence retains a textual Cadence coordination summary", async () => {
  const fixture = linearFixture({
    body: renderCadenceWorkpad({ coordination: "Review awaiting evidence" }),
  });
  const [eventPlan] = await plan();
  const result = await applyWakeup({
    plan: eventPlan,
    github: github(),
    repo,
    token: "fixture",
    fetchImpl: fixture.fetchImpl,
  });
  assert.equal(result.operation, "updated");
  assert.equal(
    parseCadenceWorkpad(fixture.comment.body).coordination.reviewCoordination,
    "Review awaiting evidence"
  );
});

test("canonical state that cannot fit still fails before data loss or issue mutation", async () => {
  const body = renderCadenceWorkpad({
    summary: "r".repeat(51000),
  });
  const fixture = linearFixture({ body });
  const [eventPlan] = await plan();
  const result = await applyWakeup({
    plan: eventPlan,
    github: github(),
    repo,
    token: "fixture",
    fetchImpl: fixture.fetchImpl,
  });
  assert.equal(result.operation, "failed");
  assert.match(result.error, /would compact Cadence review state/);
  assert.equal(fixture.comment.body, body);
  assert.equal(mutations(fixture).length, 0);
  assert.equal(
    fixture.calls.filter((call) => call.query.includes("WakeupWorkpadUpdate"))
      .length,
    0
  );
});

test("schedule skips unmanaged and unresolvable PRs and still wakes a later valid conflict", async () => {
  const prs = [
    pr({ number: 1, labels: [] }),
    pr({ number: 2, head: { ...pr().head, repo: { full_name: "fork/repo" } } }),
    pr({
      number: 3,
      title: "Missing identifier",
      head: { ...pr().head, ref: "symphony/missing" },
    }),
    pr(),
  ];
  const results = await plan({
    eventName: "schedule",
    payload: {},
    github: github({
      listPrs: async () => prs,
      getPr: async (n) => prs.find((p) => p.number === n),
    }),
  });
  assert.equal(results.length, 3);
  assert.deepEqual(
    results.filter((p) => p.shouldWake).map((p) => p.prNumber),
    [42]
  );
  assert.ok(
    results
      .slice(0, 2)
      .every((p) => p.skippedReason === "unresolvable-scheduled-pr")
  );
  assert.match(results[0].error, /repository mismatch/);
  assert.match(results[1].error, /Missing or ambiguous/);
});

test("a fork PR cannot pass the mutation-time repository guard", async () => {
  const fixture = linearFixture();
  const [eventPlan] = await plan();
  const result = await applyWakeup({
    plan: eventPlan,
    repo,
    token: "fixture",
    fetchImpl: fixture.fetchImpl,
    github: github({
      getPr: async () =>
        pr({ head: { ...pr().head, repo: { full_name: "fork/repo" } } }),
    }),
  });
  assert.match(result.error, /repository mismatch/);
  assert.equal(mutations(fixture).length, 0);
});

test("errors redact both credentials before evidence persistence and output", async () => {
  const fixture = linearFixture();
  let reads = 0;
  const [result] = await runBridge({
    repo,
    token: "github-secret",
    linearToken: "linear-secret",
    eventName: "workflow_run",
    payload: event(),
    fetchImpl: fixture.fetchImpl,
    github: github({
      getPr: async () => {
        if (++reads > 1)
          throw new Error("API failure github-secret linear-secret");
        return pr();
      },
    }),
  });
  assert.equal(result.operation, "failed");
  assert.match(result.error, /API failure \[REDACTED\] \[REDACTED\]/);
  assert.doesNotMatch(
    JSON.stringify(result) + fixture.comment.body,
    /github-secret|linear-secret/
  );
  assert.equal(mutations(fixture).length, 0);
});

test("workflow rerun invalidates completion before any Linear write", async () => {
  const run = workflow({
    event: "workflow_dispatch",
    display_title: "[linear:100-502] Validate",
  });
  const [eventPlan] = await plan({ payload: event({ workflow_run: run }) });
  const fixture = linearFixture();
  const result = await applyWakeup({
    plan: eventPlan,
    repo,
    token: "fixture",
    fetchImpl: fixture.fetchImpl,
    github: github({
      getRun: async () => ({ ...run, run_attempt: 2, status: "in_progress" }),
    }),
  });
  assert.equal(result.skippedReason, "workflow-changed-before-wakeup");
  assert.equal(fixture.calls.length, 0);
});

test("changed PR ticket prefix cannot wake the previously resolved issue", async () => {
  const [eventPlan] = await plan();
  const fixture = linearFixture();
  const result = await applyWakeup({
    plan: eventPlan,
    repo,
    token: "fixture",
    fetchImpl: fixture.fetchImpl,
    github: github({
      getPr: async () => pr({ title: "[100-700]: changed owner" }),
    }),
  });
  assert.match(result.error, /identity changed/);
  assert.equal(mutations(fixture).length, 0);
});

test("production GitHub and Linear adapters route a failed workflow fixture end to end", async () => {
  const fixture = linearFixture();
  const paths = [];
  const fetchImpl = async (url, request) => {
    if (url === "https://api.linear.app/graphql")
      return fixture.fetchImpl(url, request);
    paths.push(url);
    if (url === `https://api.github.com/repos/${repo}/pulls/42`)
      return { ok: true, json: async () => pr() };
    assert.equal(url, "https://api.github.com/graphql");
    return response({
      repository: {
        pullRequest: {
          headRefOid: head,
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [check()],
                      pageInfo: { hasNextPage: false },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    });
  };
  const [result] = await runBridge({
    repo,
    token: "github-fixture",
    linearToken: "linear-fixture",
    fetchImpl,
    eventName: "workflow_run",
    payload: event(),
    bridgeRunUrl: `${runUrl}4`,
  });
  assert.equal(result.operation, "updated", JSON.stringify(result));
  assert.equal(result.state, "Active");
  assert.equal(paths.filter((url) => url.endsWith("/graphql")).length, 2);
  assert.equal(mutations(fixture).length, 1);
});

test("GitHub permission failure produces durable run evidence with no Linear mutation", async () => {
  const [result] = await runBridge({
    repo,
    token: "github-fixture",
    linearToken: "linear-fixture",
    eventName: "workflow_run",
    payload: event(),
    bridgeRunUrl: `${runUrl}4`,
    fetchImpl: async (url) => {
      assert.ok(url.startsWith("https://api.github.com/"));
      return {
        ok: false,
        status: 403,
        json: async () => ({ message: "Forbidden" }),
      };
    },
  });
  assert.equal(result.operation, "failed");
  assert.match(result.error, /HTTP 403/);
  assert.equal(result.headSha, head);
  assert.equal(result.runUrl, runUrl);
});

test("GitHub adapter paginates current-head checks and newer reruns supersede failures", async () => {
  const calls = [];
  const client = createGitHubClient({
    repo,
    token: "fixture",
    fetchImpl: async (url, request) => {
      assert.equal(url, "https://api.github.com/graphql");
      const body = JSON.parse(request.body);
      calls.push(body.variables);
      const second = body.variables.after === "next";
      return response({
        repository: {
          pullRequest: {
            headRefOid: head,
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      contexts: {
                        nodes: [
                          second
                            ? check({ databaseId: 100, conclusion: null })
                            : check(),
                          // Same Actions app and job name, different workflow.
                          ...(!second
                            ? [
                                check({
                                  databaseId: 101,
                                  checkSuite: {
                                    app: { databaseId: 15368 },
                                    workflowRun: {
                                      workflow: { id: "workflow-2" },
                                    },
                                  },
                                }),
                              ]
                            : []),
                        ],
                        pageInfo: {
                          hasNextPage: !second,
                          endCursor: second ? null : "next",
                        },
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      });
    },
  });
  const checks = await client.checks(42, head);
  assert.equal(calls.length, 2);
  assert.equal(checks.length, 2);
  assert.equal(checks[0].conclusion, null);
  assert.equal(checks[1].conclusion, "FAILURE");
});

const wakeWorkflow = yaml.load(
  readFileSync(
    new URL("../symphony-linear-wakeups.yml", import.meta.url),
    "utf8"
  )
);
const AsyncFunction = Object.getPrototypeOf(async function () {
  return;
}).constructor;

async function runWorkflowFixture(
  t,
  {
    eventName = "pull_request_target",
    currentState = "Inactive",
    conflict = false,
    ci = null,
    changedState = "",
    changedHead = false,
    required = true,
    prTitle = "[100-502]: fix CI",
    prBranch = branch,
    releaseAfter = 0,
    labelIds = currentState === "Unhappy" ? ["yellow", "wake"] : ["yellow"],
    beforeMutation = () => undefined,
    afterMutation = () => undefined,
    audit = {},
    duplicate = false,
    incompleteLabels = false,
    forwarded = false,
    checksOverride,
    runOverride = {},
    defaultBranch = "trunk",
    requirements = [
      {
        name: "tooling-check",
        workflow: ".github/workflows/checks.yml",
        appId: 15368,
      },
    ],
  } = {}
) {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const outputs = {};
  const writes = [];
  const infos = [];
  const snapshots = [];
  Object.assign(audit, { writes, infos, snapshots });
  let reads = 0;
  const currentPr = pr({
    title: prTitle,
    head: { ...pr().head, ref: prBranch },
    mergeable: conflict,
  });
  currentPr.mergeable = !conflict;
  const states = ["Active", "Inactive", "Unhappy", "Done", "Backlog"].map(
    (name) => ({ id: name, name })
  );
  const live = {
    state: currentState,
    labels: new Set(labelIds),
    pr: currentPr,
  };
  const issue = () => ({
    id: "issue-502",
    identifier: "100-502",
    state: states.find((s) => s.name === live.state),
    team: { states: { nodes: states } },
    labels: {
      nodes: [...live.labels].map((id) => ({ id })),
      pageInfo: { hasNextPage: incompleteLabels },
    },
  });
  process.env.HELPER_ROOT = new URL(
    "../../../",
    import.meta.url
  ).pathname.replace(/\/$/, "");
  process.env.LINEAR_API_TOKEN = "fixture-token";
  process.env.GH_TOKEN = "fixture-github-token";
  globalThis.fetch = async (url, options) => {
    if (url.startsWith("https://api.github.com/repos/")) {
      const config = {
        schemaVersion: "symphony-repository/v1",
        linear: { teamKey: "100" },
        workingDirectory: ".",
        instructions: [],
        commands: {},
        ci: { requiredChecks: requirements },
      };
      const root = `https://api.github.com/repos/${repo}`;
      let data;
      if (url === root)
        data = {
          id: 1,
          full_name: repo,
          owner: { login: "example-org" },
          default_branch: defaultBranch,
        };
      else if (url === `${root}/branches/${defaultBranch}`)
        data = { name: defaultBranch, commit: { sha: base } };
      else if (url === `${root}/git/trees/${base}`)
        data = {
          truncated: false,
          tree: [
            {
              path: ".symphony.cfg.json",
              type: "blob",
              mode: "100644",
              sha: head,
            },
          ],
        };
      else if (url === `${root}/git/blobs/${head}`)
        data = {
          sha: head,
          encoding: "base64",
          content: Buffer.from(JSON.stringify(config)).toString("base64"),
        };
      else if (url === `${root}/actions/runs/123`)
        data = workflow({ conclusion: ci || "failure", ...runOverride });
      else throw new Error(`Unexpected GitHub request: ${url}`);
      return { ok: true, status: 200, json: async () => data };
    }
    const { query, variables } = JSON.parse(options.body);
    let data;
    if (url === "https://api.github.com/graphql") {
      data = {
        repository: {
          pullRequest: {
            headRefOid: head,
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      contexts: {
                        nodes:
                          checksOverride ||
                          (ci || ["check_run", "status"].includes(eventName)
                            ? [
                                check({
                                  isRequired: required,
                                  status: "COMPLETED",
                                  conclusion:
                                    ci === "success" ? "SUCCESS" : "FAILURE",
                                  name: ["check_run", "status"].includes(
                                    eventName
                                  )
                                    ? "external"
                                    : "tooling-check",
                                  checkSuite: {
                                    app: { databaseId: 15368 },
                                    workflowRun: {
                                      databaseId: 123,
                                      runAttempt: 1,
                                      file: {
                                        path: ["check_run", "status"].includes(
                                          eventName
                                        )
                                          ? ".github/workflows/external.yml"
                                          : ".github/workflows/checks.yml",
                                      },
                                      workflow: { id: "workflow-1" },
                                    },
                                  },
                                }),
                              ]
                            : []),
                        pageInfo: { hasNextPage: false },
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      };
    } else if (query.includes("query LinearWakeupIssue")) {
      reads++;
      if (releaseAfter && reads === releaseAfter + 1) live.state = "Inactive";
      snapshots.push(issue());
      data = { issue: issue() };
      if (!query.includes("labels(")) delete data.issue.labels;
    } else if (query.includes("CadenceWorkpadIssue")) {
      data = {
        issue: {
          ...issue(),
          comments: {
            nodes: [
              {
                id: "workpad",
                body: renderCadenceWorkpad({ status: "reviewing" }),
              },
            ],
            pageInfo: { hasNextPage: false },
          },
        },
      };
    } else if (query.includes("commentUpdate")) {
      writes.push({ kind: "workpad", body: variables.body });
      data = { commentUpdate: { success: true } };
    } else if (query.includes("team{labels")) {
      data = {
        issue: {
          team: {
            labels: {
              nodes: [{ id: "wake", name: "wake:15m" }],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      };
    } else if (query.includes("issueUpdate")) {
      const input = variables.input;
      const attempt =
        writes.filter((write) => write.kind === "state").length + 1;
      const failure = beforeMutation(live, input, attempt);
      writes.push({ kind: "state", input, previousState: live.state });
      if (failure) return { ok: true, status: 200, json: async () => failure };
      const rejection = input.removedLabelIds?.some(
        (id) => !live.labels.has(id)
      )
        ? "Label not on issue"
        : input.addedLabelIds?.some((id) => live.labels.has(id))
        ? "Label already on issue"
        : "";
      if (rejection)
        return {
          ok: true,
          status: 200,
          json: async () => ({
            errors: [
              {
                message: rejection,
                path: ["issueUpdate"],
                extensions: { code: "INPUT_ERROR" },
              },
            ],
          }),
        };
      for (const id of input.removedLabelIds || []) live.labels.delete(id);
      for (const id of input.addedLabelIds || []) live.labels.add(id);
      live.state = input.stateId;
      data = { issueUpdate: { success: true, issue: issue() } };
      afterMutation(live);
    } else throw new Error(`Unexpected request: ${query}`);
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env))
      if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });
  const context = {
    eventName,
    repo: { owner: "example-org", repo: "example-repo" },
    payload: {
      ...(eventName === "pull_request_target"
        ? { pull_request: currentPr }
        : {}),
      ...(eventName === "workflow_run"
        ? { action: "completed", workflow_run: workflow(runOverride) }
        : {}),
      ...(eventName === "check_run"
        ? {
            action: "completed",
            check_run: { id: 99, head_sha: head, status: "completed" },
          }
        : {}),
      ...(eventName === "status"
        ? { sha: head, context: "tooling-check" }
        : {}),
    },
  };
  Object.assign(process.env, {
    TARGET_REPOSITORY: repo,
    TARGET_DEFAULT_BRANCH: defaultBranch,
    EVENT_NAME: eventName,
    EVENT_PAYLOAD: JSON.stringify(context.payload),
  });
  // Reusable calls forward the original payload; the wrapper event itself is unrelated.
  if (forwarded) {
    context.eventName = "workflow_call";
    context.payload = { repository: { full_name: "workflow-source/helpers" } };
  }
  const github = {
    rest: {
      pulls: { get: async () => ({ data: currentPr }) },
      repos: { listPullRequestsAssociatedWithCommit: "prs" },
      actions: { listWorkflowRuns: "runs" },
    },
    paginate: async (method) =>
      method === "prs"
        ? [currentPr]
        : ci
        ? [
            {
              status: "completed",
              conclusion: ci,
              run_number: 1,
              html_url: runUrl,
            },
          ]
        : [],
  };
  let waits = 0;
  const run = async (name, env = {}) => {
    Object.assign(process.env, env);
    const step = wakeWorkflow.jobs.wake.steps.find(
      (step) => step.id === name || step.name === name
    );
    const result = {};
    const core = {
      summary: { addRaw: () => ({ write: async () => undefined }) },
      info: (message) => infos.push(message),
      setOutput: (key, value) => {
        result[key] = String(value);
      },
    };
    await new AsyncFunction(
      "github",
      "context",
      "core",
      "setTimeout",
      step.with.script
    )(github, context, core, (resolve, ms) => {
      assert.equal(ms, 10000);
      waits++;
      resolve();
    });
    outputs[name] = result;
    return result;
  };
  const ticket = await run("ticket");
  if (!ticket.issue) return { writes, waits, outputs };
  const state = await run("ticket_state", { ISSUE: ticket.issue });
  if (!state.state) return { writes, waits, outputs };
  const outcome = await run("outcome", {
    PR_NUMBER: ticket.pr,
    HEAD_SHA: ticket.sha,
    ISSUE_STATE: state.state,
    TARGET_CONFIG: ticket.config,
  });
  if (outcome.conflict)
    await run("Record conflict resolution in the Cadence workpad", {
      REASON: outcome.reason,
    });
  if (changedState) live.state = changedState;
  if (changedHead) currentPr.head.sha = "new-head";
  for (
    let attempt = 0;
    outcome.state && attempt < (duplicate ? 2 : 1);
    attempt++
  ) {
    await run("Set the ticket state and wake label", {
      PREVIOUS_STATE: state.state,
      TARGET_STATE: outcome.state,
      REASON: outcome.reason,
    });
  }
  return { writes, waits, outputs, infos, snapshots, issue: issue() };
}

for (const [name, options, expected] of [
  ["pending CI sleeps", {}, "Unhappy"],
  [
    "successful CI parks for review",
    { eventName: "workflow_run", ci: "success", currentState: "Unhappy" },
    "Inactive",
  ],
  [
    "failed CI activates",
    { eventName: "workflow_run", ci: "failure", currentState: "Unhappy" },
    "Active",
  ],
  ["late PR event preserves completed CI", { ci: "success" }, "Inactive"],
  [
    "required external check failure activates",
    { eventName: "check_run" },
    "Active",
  ],
  [
    "optional external check failure cannot pass missing required CI",
    { eventName: "check_run", required: false },
    "Unhappy",
  ],
  ["active worker keeps control", { currentState: "Active" }, undefined],
  [
    "worker releases during wait",
    { currentState: "Active", releaseAfter: 2 },
    "Unhappy",
  ],
  ["terminal ticket is left alone", { currentState: "Done" }, undefined],
  ["backlog ticket is left alone", { currentState: "Backlog" }, undefined],
  ["concurrent activation is preserved", { changedState: "Active" }, undefined],
  ["new head prevents transition", { changedHead: true }, undefined],
  [
    "another team is ignored",
    { prTitle: "[ENG-502]: fix CI", prBranch: "symphony/eng-502/fix" },
    undefined,
  ],
  [
    "lowercase branch identifies configured team",
    { prTitle: "Fix CI", prBranch: "symphony/100-502/fix" },
    "Unhappy",
  ],
]) {
  test(`YAML workflow: ${name}`, async (t) => {
    const { writes, waits } = await runWorkflowFixture(t, options);
    const update = writes.find((write) => write.kind === "state");
    assert.equal(update?.input.stateId, expected);
    if (update) {
      const input = { stateId: expected };
      if (expected === "Unhappy") input.addedLabelIds = ["wake"];
      else if (options.currentState === "Unhappy")
        input.removedLabelIds = ["wake"];
      assert.deepEqual(update.input, input);
    }
    if (options.currentState === "Active")
      assert.equal(waits, options.releaseAfter || 6);
  });
}

test("YAML workflow: conflict instruction preserves the Cadence workpad before activation", async (t) => {
  const { writes } = await runWorkflowFixture(t, { conflict: true });
  assert.deepEqual(
    writes.map((write) => write.kind),
    ["workpad", "state"]
  );
  const workpad = parseCadenceWorkpad(writes[0].body);
  assert.equal(workpad.status, "reviewing");
  assert.match(
    workpad.coordination.lastNonReviewWakeup.reason,
    /Resolve the merge conflict/
  );
  assert.equal(writes[1].input.stateId, "Active");
});

test("workflow boundary supports native and reusable CI without reviewer secrets", () => {
  assert.deepEqual(wakeWorkflow.on.workflow_run, {
    workflows: ["*"],
    types: ["completed"],
  });
  assert.equal(wakeWorkflow.on.schedule, undefined);
  assert.deepEqual(Object.keys(wakeWorkflow.on.workflow_call.secrets), [
    "CADENCE_LINEAR_API_TOKEN",
  ]);
  assert.match(wakeWorkflow.jobs.wake.steps[0].with.ref, /inputs.helpers-ref/);
  assert.match(
    wakeWorkflow.jobs.wake.steps[0].with.repository,
    /inputs.helpers-repository/
  );
  for (const step of wakeWorkflow.jobs.wake.steps.filter(
    (step) => step.with?.script
  )) {
    assert.doesNotThrow(
      () => new AsyncFunction("github", "context", "core", step.with.script)
    );
    assert.ok(
      !step.with.script.includes("${{"),
      "event values must be passed as data"
    );
    assert.match(step.uses, /@[a-f0-9]{40}/);
  }
});

for (const eventName of [
  "pull_request_target",
  "workflow_run",
  "check_run",
  "status",
]) {
  for (const ci of ["success", "failure"]) {
    test(`reusable/native parity: ${eventName} ${ci}`, async (t) => {
      for (const forwarded of [false, true]) {
        const { writes } = await runWorkflowFixture(t, {
          eventName,
          ci,
          forwarded,
        });
        assert.equal(
          writes.find((write) => write.kind === "state")?.input.stateId,
          ci === "success" && !["check_run", "status"].includes(eventName)
            ? "Inactive"
            : ci === "failure"
            ? "Active"
            : "Unhappy"
        );
      }
    });
  }
}

for (const currentState of ["Inactive", "Unhappy"]) {
  for (const ci of ["failure", "success", null]) {
    for (const present of [false, true]) {
      test(`YAML label update: ${currentState}, CI ${ci}, wake present ${present}`, async (t) => {
        const target =
          ci === "failure"
            ? "Active"
            : ci === "success"
            ? "Inactive"
            : "Unhappy";
        const desired = target === "Unhappy";
        const { writes, issue, snapshots, infos } = await runWorkflowFixture(
          t,
          {
            eventName: "workflow_run",
            currentState,
            ci,
            labelIds: present ? ["yellow", "wake"] : ["yellow"],
          }
        );
        const input = { stateId: target };
        if (present !== desired)
          input[desired ? "addedLabelIds" : "removedLabelIds"] = ["wake"];
        assert.deepEqual(
          writes.map((write) => write.input),
          [input]
        );
        assert.equal(issue.state.name, target);
        assert.deepEqual(
          issue.labels.nodes.map((label) => label.id).sort(),
          desired ? ["wake", "yellow"] : ["yellow"]
        );
        assert.deepEqual(
          snapshots.at(-1),
          issue,
          "success requires a persisted state/label readback"
        );
        assert.ok(infos.some((message) => message.includes(`-> ${target}.`)));
      });
    }
  }
}

for (const adding of [false, true]) {
  test(`YAML label race: concurrent ${
    adding ? "add" : "remove"
  } retries the state transition`, async (t) => {
    const { writes, issue } = await runWorkflowFixture(t, {
      ci: adding ? null : "failure",
      labelIds: adding ? ["yellow"] : ["yellow", "wake"],
      beforeMutation(live, _input, attempt) {
        if (attempt !== 1) return;
        live.labels[adding ? "add" : "delete"]("wake");
        live.labels.add("concurrent-label");
      },
    });
    const target = adding ? "Unhappy" : "Active";
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1], {
      kind: "state",
      input: { stateId: target },
      previousState: "Inactive",
    });
    assert.equal(issue.state.name, target);
    assert.deepEqual(
      issue.labels.nodes.map((label) => label.id).sort(),
      adding
        ? ["concurrent-label", "wake", "yellow"]
        : ["concurrent-label", "yellow"]
    );
  });
}

for (const change of ["Active", "Done", "head", "closed"]) {
  test(`YAML label race: retry preserves newer ${change} decision`, async (t) => {
    const { writes, issue, infos } = await runWorkflowFixture(t, {
      ci: "failure",
      labelIds: ["yellow", "wake"],
      beforeMutation(live) {
        live.labels.delete("wake");
        if (change === "head") live.pr.head.sha = "new-head";
        else if (change === "closed") live.pr.state = "closed";
        else live.state = change;
      },
    });
    assert.equal(writes.length, 1);
    assert.equal(
      issue.state.name,
      ["head", "closed"].includes(change) ? "Inactive" : change
    );
    assert.ok(
      infos.some((message) => message.includes("Ticket or PR changed"))
    );
    assert.ok(infos.every((message) => !message.includes("->")));
  });
}

test("YAML label update: duplicate failure does not mutate an activated ticket again", async (t) => {
  const { writes, issue } = await runWorkflowFixture(t, {
    ci: "failure",
    duplicate: true,
  });
  assert.equal(writes.length, 1);
  assert.equal(issue.state.name, "Active");
});

for (const failure of [
  { errors: [{ message: "Permission denied" }] },
  { errors: [{ message: "Label not on issue" }] },
  { data: { issueUpdate: { success: false } } },
  {
    data: { issueUpdate: { success: true, issue: { state: { id: "wrong" } } } },
  },
]) {
  test(`YAML label update: genuine failure stays visible ${JSON.stringify(
    failure
  )}`, async (t) => {
    const audit = {};
    await assert.rejects(
      runWorkflowFixture(t, {
        ci: "failure",
        labelIds: ["yellow", "wake"],
        audit,
        beforeMutation: () => failure,
      }),
      /Permission denied|Label not on issue|Ticket state update failed/
    );
    assert.equal(
      audit.writes.length,
      1,
      "no retry without an observed membership change"
    );
    assert.ok(audit.infos.every((message) => !message.includes("->")));
  });
}

test("YAML label race: a second mutation failure is not retried or swallowed", async (t) => {
  const audit = {};
  await assert.rejects(
    runWorkflowFixture(t, {
      ci: "failure",
      labelIds: ["yellow", "wake"],
      audit,
      beforeMutation(live, _input, attempt) {
        live.labels.delete("wake");
        if (attempt === 2)
          return { errors: [{ message: "Permission denied" }] };
      },
    }),
    /Permission denied/
  );
  assert.equal(audit.writes.length, 2);
  assert.ok(audit.infos.every((message) => !message.includes("->")));
});

for (const change of ["state", "label"]) {
  test(`YAML label update: mismatched ${change} readback cannot report success`, async (t) => {
    const audit = {};
    await assert.rejects(
      runWorkflowFixture(t, {
        ci: "failure",
        audit,
        afterMutation(live) {
          if (change === "state") live.state = "Done";
          else live.labels.add("wake");
        },
      }),
      /readback/
    );
    assert.equal(audit.writes.length, 1);
    assert.ok(audit.infos.every((message) => !message.includes("->")));
  });
}

test("YAML label update: incomplete membership fails before mutation", async (t) => {
  const audit = {};
  await assert.rejects(
    runWorkflowFixture(t, { ci: "failure", incompleteLabels: true, audit }),
    /incomplete/
  );
  assert.equal(audit.writes.length, 0);
});

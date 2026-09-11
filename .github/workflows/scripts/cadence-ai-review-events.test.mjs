import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import yaml from "js-yaml";

const require = createRequire(import.meta.url);
const verifyCadenceAiReview = require("./verify-cadence-ai-review.cjs");

const workflow = readFileSync(
  new URL("../cadence-ai-review-events.yml", import.meta.url),
  "utf8"
);
const trigger = readFileSync(new URL("../cadence-ai-review-trigger.yml", import.meta.url), "utf8");
const triggerWorkflow = yaml.load(trigger);

test("native review publication and recognition share the minted App identity", () => {
  const token = "${{ steps.app-token.outputs.token }}";
  const login = "${{ steps.app-token.outputs.app-slug }}[bot]";
  const steps = triggerWorkflow.jobs.review.steps;
  const mint = steps.find((step) => step.id === "app-token");
  assert.equal(mint.with.repositories, "${{ github.event.repository.name }}");
  for (const permission of ["pull-requests", "issues", "checks"]) {
    assert.equal(mint.with[`permission-${permission}`], "write");
  }
  for (const permission of ["contents", "actions", "metadata"]) {
    assert.equal(mint.with[`permission-${permission}`], "read");
  }
  for (const step of steps) {
    if (step.env?.GH_TOKEN && step.name !== "Update cadence loop label")
      assert.equal(step.env.GH_TOKEN, token);
    if (step.with?.["github-token"])
      assert.equal(step.with["github-token"], token);
  }
  assert.equal(
    steps.find((step) => step.id === "cadence_review").with.github_token,
    token
  );
  assert.doesNotMatch(trigger, /CADENCE_BOT_GITHUB_TOKEN|getAuthenticated/);
  const finish = triggerWorkflow.jobs.finish.steps.at(-1);
  assert.equal(finish.env.CADENCE_REVIEWER_LOGIN, login);
  assert.match(
    finish.with.script,
    /reviewer: process.env.CADENCE_REVIEWER_LOGIN/
  );
  assert.equal(finish.env.HANDOFF_TOKEN, "${{ github.token }}");
  const handoff = yaml.load(
    readFileSync(
      new URL("../cadence-linear-rework.yml", import.meta.url),
      "utf8"
    )
  );
  assert.equal(
    handoff.jobs["review-handoff"].steps.at(-1).env.CADENCE_REVIEWER_LOGIN,
    login
  );
  const manual = yaml.load(
    readFileSync(new URL("../cadence-ai-review.yml", import.meta.url), "utf8")
  );
  assert.equal(
    manual.jobs.resolve.steps[0].env.GH_TOKEN,
    "${{ github.token }}"
  );
  assert.doesNotMatch(JSON.stringify(manual), /CADENCE_BOT_GITHUB_TOKEN/);
});

test("publishing preflight rejects missing App identity, user tokens and wrong repository scope", async () => {
  const steps = triggerWorkflow.jobs.review.steps;
  const step = steps.find(
    (step) => step.name === "Verify Cadence publishing identity"
  );
  assert.ok(
    steps.indexOf(step) < steps.findIndex((step) => step.id === "review_state")
  );
  assert.equal(
    step.env.CADENCE_APP_SLUG,
    "${{ steps.app-token.outputs.app-slug }}"
  );
  const AsyncFunction = Object.getPrototypeOf(async function () {
    return undefined;
  }).constructor;
  const run = new AsyncFunction(
    "github",
    "context",
    "core",
    "process",
    step.with.script
  );
  for (const [slug, repositories, count, denied, succeeds] of [
    ["cadence", ["owner/repo"], 1, false, true],
    ["", ["owner/repo"], 1, false, false],
    ["cadence[bot]", ["owner/repo"], 1, false, false],
    ["cadence", ["other/repo"], 1, false, false],
    ["cadence", ["owner/repo"], 2, false, false],
    ["cadence", [], 0, false, false],
    ["cadence", ["owner/repo"], 1, true, false],
  ]) {
    const env = {};
    const execute = () =>
      run(
        {
          request: async (endpoint) => {
            assert.equal(endpoint, "GET /installation/repositories");
            if (denied)
              throw new Error("Resource not accessible by integration");
            return {
              data: {
                total_count: count,
                repositories: repositories.map((full_name) => ({ full_name })),
              },
            };
          },
        },
        { repo: { owner: "owner", repo: "repo" } },
        {
          exportVariable: (key, value) => {
            env[key] = value;
          },
        },
        { env: { CADENCE_APP_SLUG: slug } }
      );
    if (succeeds) {
      await execute();
      assert.equal(env.CADENCE_REVIEWER_LOGIN, "cadence[bot]");
    } else {
      await assert.rejects(execute);
      assert.equal(env.CADENCE_REVIEWER_LOGIN, undefined);
    }
  }
});

test("legacy users and unrelated Apps cannot satisfy App review verification", async (t) => {
  const previousPr = process.env.PR_NUMBER;
  process.env.PR_NUMBER = "33";
  t.after(() => {
    if (previousPr === undefined) delete process.env.PR_NUMBER;
    else process.env.PR_NUMBER = previousPr;
  });
  for (const [reviewer, author] of [
    ["cadence[bot]", "legacy-cadence-user"],
    ["cadence[bot]", "unrelated[bot]"],
    ["", "cadence[bot]"],
    ["legacy-cadence-user", "legacy-cadence-user"],
  ]) {
    const errors = [];
    await verifyCadenceAiReview({
      reviewer,
      reviewOutcome: "success",
      context: { repo: { owner: "owner", repo: "repo" } },
      core: { setFailed: (message) => errors.push(message) },
      github: {
        rest: {
          pulls: {
            get: async () => ({ data: { head: { sha: "head" } } }),
            listReviews: "reviews",
          },
        },
        paginate: async () => [
          { user: { login: author }, state: "APPROVED", commit_id: "head" },
        ],
      },
    });
    assert.equal(errors.length, 1);
    assert.match(
      errors[0],
      reviewer.endsWith("[bot]")
        ? /No Cadence review at current head/
        : /trusted Cadence App reviewer login/
    );
  }
});

test("App verdicts reach handoff while legacy and unrelated bots remain non-human", async () => {
  const { classifyCadenceLinearReworkEvent } = await import(
    "../../../scripts/cadence-linear-rework.mjs"
  );
  for (const [author, state, body, reason] of [
    [
      "cadence[bot]",
      "APPROVED",
      "Assessment: Approve",
      "cadence-review-approved",
    ],
    [
      "cadence[bot]",
      "COMMENTED",
      "Assessment: Blocked",
      "cadence-review-actionable-content",
    ],
    [
      "cadence[bot]",
      "COMMENTED",
      "Assessment: Human input needed",
      "cadence-review-human-input-needed",
    ],
    [
      "example-cadence-bot",
      "APPROVED",
      "Assessment: Approve",
      "non-human-review",
    ],
    ["unrelated[bot]", "APPROVED", "Assessment: Approve", "non-human-review"],
  ]) {
    const result = classifyCadenceLinearReworkEvent({
      cadenceReviewerLogin: "cadence[bot]",
      payload: {
        action: "submitted",
        pull_request: {
          number: 33,
          state: "open",
          title: "[100-49]: example",
          user: { login: "example-symphony-bot" },
          labels: [{ name: "symphony" }],
        },
        review: { user: { login: author }, state, body },
      },
    });
    assert.equal(result.reason, reason);
  }
});


test("trusted event calls allow their verified trigger actor without changing publishing identity", () => {
  assert.deepEqual(Object.keys(triggerWorkflow.on), [
    "pull_request_target", "workflow_dispatch", "workflow_call",
  ]);
  const steps = triggerWorkflow.jobs.review.steps;
  const review = steps.find((step) => step.id === "cadence_review");
  assert.equal(review.uses, "anthropics/claude-code-action@30544b674398ee15c84819bd87caf8a87e8c7b55");

  assert.match(triggerWorkflow.jobs.review.if, /github.ref == 'refs\/heads\/main'/);
  assert.equal(review.with.github_token, '${{ steps.app-token.outputs.token }}');
  assert.equal(review.with.allowed_non_write_users, undefined);
  assert.equal(review["continue-on-error"], undefined);
  assert.equal(triggerWorkflow.jobs.review.environment, "cadence-controller");
  assert.equal(steps.find((step) => step.id === "plan").env.TRIGGER_ACTOR, "${{ github.actor }}");
});

test("outcome verification preserves startup failure, current-head checks and review cleanup", async (t) => {
  const step = triggerWorkflow.jobs.review.steps.find((entry) => entry.name.startsWith("Verify review outcomes"));
  assert.equal(step.if, "always() && steps.plan.outputs.run_claude == 'true'");
  assert.equal(step.env.CADENCE_REVIEW_OUTCOME, "${{ steps.cadence_review.outcome }}");
  const AsyncFunction = Object.getPrototypeOf(async function () { return undefined; }).constructor;
  const run = new AsyncFunction("require", "github", "context", "core", "process", step.with.script);
  const previousPr = process.env.PR_NUMBER;
  process.env.PR_NUMBER = "33";
  t.after(() => {
    if (previousPr === undefined) delete process.env.PR_NUMBER;
    else process.env.PR_NUMBER = previousPr;
  });

  for (const [outcome, state, sha, fails, dismisses] of [
    ["success", "APPROVED", "head", false, false],
    ["success", "COMMENTED", "head", false, false],
    ["success", "PENDING", "head", true, false],
    ["success", "DISMISSED", "head", true, false],
    ["success", "APPROVED", "stale", true, false],
    ["failure", "APPROVED", "head", true, false],
    ["failure", null, null, true, false],
    ["skipped", null, null, true, false],
    ["cancelled", null, null, true, false],
    ["", null, null, true, false],
    ["success", "CHANGES_REQUESTED", "head", true, true],
    ["failure", "CHANGES_REQUESTED", "head", true, true],
  ]) {
    const errors = [];
    const dismissed = [];
    const github = {
      rest: {
        users: { getAuthenticated: async () => assert.fail("Installation tokens cannot read /user") },
        pulls: {
          get: async () => ({ data: { head: { sha: "head" } } }),
          listReviews: "reviews",
          dismissReview: async (input) => dismissed.push(input.review_id),
        },
      },
      paginate: async () => state ? [{ id: 1, user: { login: "cadence[bot]" }, state, commit_id: sha }] : [],
    };
    await run(
      () => verifyCadenceAiReview, github, { repo: { owner: "owner", repo: "repo" } },
      { setFailed: (message) => errors.push(message) },
      { env: { CADENCE_REVIEWER_LOGIN: "cadence[bot]", CADENCE_REVIEW_OUTCOME: outcome } },
    );
    assert.equal(errors.length > 0, fails, `${outcome}: ${state} at ${sha}`);
    assert.equal(dismissed.length > 0, dismisses);
    if (outcome !== "success") {
      assert.match(errors.join(" "), /Review execution did not succeed/);
      assert.doesNotMatch(errors.join(" "), /reported success/);
    }
    if (state === null || sha === "stale") {
      assert.match(errors.join(" "), /No Cadence review at current head/);
    }
  }
});

test("the review trigger uses the existing App for feedback permission reads", () => {
  const stateStep = trigger.match(/- name: Fetch PR review state\n[\s\S]*?(?=\n      - name:)/)?.[0];
  assert.match(stateStep, /GH_TOKEN: \$\{\{ steps.app-token.outputs.token \}\}/);
  assert.match(trigger, /environment: cadence-controller/);
  assert.match(trigger, /app-id: \$\{\{ vars.CADENCE_APP_ID \}\}/);
  assert.match(trigger, /permission-pull-requests: read/);
});

test("App review requests reach the trigger and only the minted App identity passes its bot guard", () => {
  assert.match(trigger, /github.event.sender.type == 'Bot'/);
  const guard = trigger.match(/- name: Verify App review requester\n[\s\S]*?(?=\n      - name:)/)?.[0];
  assert.ok(guard, "review-request bot guard must precede review work");
  assert.ok(trigger.indexOf(guard) < trigger.indexOf("- name: Fetch PR review state"));
  assert.match(guard, /if: github.event_name == 'pull_request_target'/);
  assert.match(guard, /APP_SLUG: \$\{\{ steps.app-token.outputs.app-slug \}\}/);
  const script = guard.split("run: |\n")[1].replace(/^          /gm, "");
  for (const [actor, type, slug, passes] of [
    ["existing-cadence[bot]", "Bot", "existing-cadence", true],
    ["unrelated[bot]", "Bot", "existing-cadence", false],
    ["existing-cadence[bot]", "Bot", "", false],
    ["writer", "User", "existing-cadence", true],
    ["example-cadence-bot", "User", "existing-cadence", true],
  ]) {
    const result = spawnSync("bash", ["-e", "-c", script], {
      env: { REQUEST_ACTOR: actor, REQUEST_ACTOR_TYPE: type, APP_SLUG: slug }, encoding: "utf8",
    });
    assert.equal(result.status === 0, passes, `${actor}: ${result.stdout} ${result.stderr}`);
  }
});

test("events call review only after the existing author-permission router succeeds", () => {
  const { route, review } = yaml.load(workflow).jobs;
  assert.equal(review.needs, 'route');
  assert.equal(review.if, "needs.route.outputs.should_request_review == 'true'");
  assert.equal(review.uses, './.github/workflows/cadence-ai-review-trigger.yml');
  assert.equal(review.secrets, 'inherit');
  assert.equal(review.with.pr_number, '${{ needs.route.outputs.pr_number }}');
  assert.equal(route.outputs.should_request_review, '${{ steps.route.outputs.should_request_review }}');
  assert.equal(route.steps.find(step => step.id === 'route').run,
    'node .github/workflows/scripts/cadence-ai-review-route-event.mjs');
  assert.equal(route.permissions['pull-requests'], 'read');
  assert.doesNotMatch(workflow, /request-pr-reviewer|cadence-linear-workpad|fetch-pr-review-state/);
});

const eventsWorkflow = yaml.load(workflow);
const acknowledgement = eventsWorkflow.jobs.route.steps.find(step => step.name === 'Acknowledge accepted feedback');

test("acknowledgement uses the Cadence App after routing, outside the review queue", () => {
  const { route, review } = eventsWorkflow.jobs;
  const token = route.steps.find(step => step.id === 'app-token');
  assert.equal(token.with['permission-issues'], 'write');
  assert.equal(token.with['permission-pull-requests'], 'write');
  assert.equal(acknowledgement.with['github-token'], '${{ steps.app-token.outputs.token }}');
  assert.equal(acknowledgement['continue-on-error'], true);
  assert.ok(route.steps.indexOf(acknowledgement) > route.steps.findIndex(step => step.id === 'route'));
  assert.equal(eventsWorkflow.concurrency, undefined);
  assert.equal(route.concurrency, undefined);
  assert.equal(review.needs, 'route');
  assert.equal(triggerWorkflow.jobs.review.concurrency.queue, 'single');

  const eligible = new Function('steps', 'env', `return ${acknowledgement.if}`);
  for (const event of ['issue_comment', 'pull_request_review', 'pull_request_review_comment', 'pull_request_target']) {
    for (const accepted of ['true', 'false', '']) {
      assert.equal(eligible({ route: { outputs: { should_request_review: accepted } } }, { CADENCE_EVENT_NAME: event }),
        accepted === 'true' && event !== 'pull_request_target');
    }
  }
});

test("acknowledgement targets the actual feedback node and repeats the additive mutation", async () => {
  const AsyncFunction = Object.getPrototypeOf(async function () { return undefined; }).constructor;
  const run = new AsyncFunction('require', 'github', 'core', 'process', acknowledgement.with.script);
  for (const event of ['issue_comment', 'pull_request_review', 'pull_request_review_comment']) {
    const calls = [], summaries = [];
    const payload = {
      review: { id: 1, node_id: 'PRR_review' },
      comment: { id: 2, node_id: event === 'issue_comment' ? 'IC_conversation' : 'PRRC_inline' },
    };
    const subject = event === 'pull_request_review' ? payload.review : payload.comment;
    const github = { graphql: async (query, variables) => {
      calls.push({ query, variables });
      return { addReaction: { reaction: { id: 'existing-or-new-reaction' } } };
    } };
    const core = {
      warning: message => assert.fail(message),
      summary: { addRaw: text => ({ write: async () => summaries.push(text) }) },
    };
    const read = module => {
      assert.equal(module, 'node:fs');
      return { readFileSync: path => {
        assert.equal(path, '/verified-event.json');
        return JSON.stringify(payload);
      } };
    };
    const env = { CADENCE_EVENT_PATH: '/verified-event.json', CADENCE_EVENT_NAME: event };
    await run(read, github, core, { env });
    await run(read, github, core, { env });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
    assert.deepEqual(calls[0].variables, { subject: subject.node_id });
    assert.match(calls[0].query, /addReaction\(input: \{subjectId: \$subject, content: EYES\}\)/);
    assert.match(summaries[0], new RegExp(`Accepted ${event} #${subject.id}; reaction existing-or-new-reaction`));
  }
});

test("acknowledgement failures warn and summarize without rejecting review routing", async () => {
  const AsyncFunction = Object.getPrototypeOf(async function () { return undefined; }).constructor;
  const run = new AsyncFunction('require', 'github', 'core', 'process', acknowledgement.with.script);
  for (const failure of ['403', 'GraphQL error', 'no reaction', 'missing node']) {
    const warnings = [], summaries = [];
    await run(() => ({ readFileSync: () => JSON.stringify({ review: { node_id: failure === 'missing node' ? null : 'PRR_review' } }) }),
      { graphql: async () => {
        if (failure === 'no reaction') return { addReaction: null };
        throw new Error(failure);
      } },
      { warning: message => warnings.push(message), summary: { addRaw: text => ({ write: async () => summaries.push(text) }) } },
      { env: { CADENCE_EVENT_NAME: 'pull_request_review' } });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /acknowledgement failed; review will continue/);
    assert.match(summaries[0], /acknowledgement failed; review will continue/);
  }
});

test("manual matrix and events reuse the same reviewer with sufficient inherited permissions", () => {
  const manual = yaml.load(readFileSync(new URL('../cadence-ai-review.yml', import.meta.url), 'utf8'));
  const events = yaml.load(workflow);
  assert.equal(manual.jobs.review.uses, events.jobs.review.uses);
  assert.equal(manual.jobs.review.with.pr_number, '${{ matrix.pr_number }}');
  assert.deepEqual(manual.jobs.review.secrets, events.jobs.review.secrets);
  // Named/empty mappings lose environment secrets in reusable jobs (runner#4453).
  assert.equal(manual.jobs.review.secrets, 'inherit');
  assert.equal(triggerWorkflow.jobs.review.environment, "cadence-controller");
  assert.equal(triggerWorkflow.jobs.review.steps.find(step => step.id === "app-token").with["private-key"],
    "${{ secrets.CADENCE_APP_PRIVATE_KEY }}");
  assert.equal(triggerWorkflow.jobs.review.concurrency.queue, 'single');
  assert.equal(triggerWorkflow.jobs.review.concurrency['cancel-in-progress'], false);
  assert.equal(manual.jobs.resolve.if, "github.ref == 'refs/heads/main'");
  for (const caller of [manual, events]) assert.deepEqual(caller.permissions, triggerWorkflow.permissions);
  assert.equal(triggerWorkflow.jobs.review.concurrency.group,
    'cadence-ai-review-${{ github.repository }}-pr-${{ inputs.pr_number || github.event.pull_request.number }}');
});

test("closing a PR cancels only its review group; late arrivals skip review planning", () => {
  const { review, 'cancel-closed': cancel } = triggerWorkflow.jobs;
  assert.ok(triggerWorkflow.on.pull_request_target.types.includes('closed'));
  assert.equal(cancel.if, "github.event_name == 'pull_request_target' && github.event.action == 'closed'");
  assert.equal(cancel.concurrency['cancel-in-progress'], true);
  assert.equal(cancel.concurrency.queue, 'single');
  assert.deepEqual(cancel.permissions, {});
  assert.equal(cancel.environment, undefined);
  const group = (job, number, inputs = {}) => job.concurrency.group.replace(/\$\{\{(.*?)\}\}/g,
    (_, expression) => new Function('github', 'inputs', `return ${expression}`)(
      { repository: 'owner/repo', event: { pull_request: { number } } }, inputs));
  assert.equal(group(cancel, 18), group(review, 18));
  assert.equal(group(cancel, 18), group(review, undefined, { pr_number: '18' }));
  assert.notEqual(group(cancel, 18), group(review, 20));
  const metadata = review.steps.find(step => step.id === 'pr');
  assert.match(metadata.run, /--json state,/);
  assert.match(metadata.run, /printf 'state=%s/);
  assert.equal(review.steps.find(step => step.id === 'plan').if, "steps.started.outputs.active == 'true' && steps.pr.outputs.state == 'OPEN' && steps.pr.outputs.head_sha == fromJSON(needs.accept.outputs.request).head");
  assert.equal(review.steps.find(step => step.id === 'cadence_review').if, "steps.plan.outputs.run_claude == 'true'");
});

test("bot allowance never substitutes a human initiator for the Action's write check", () => {
  const expression = triggerWorkflow.jobs.review.steps.find(step => step.id === 'cadence_review')
    .with.allowed_bots.slice(3, -2).replace('steps.app-token.outputs.app-slug', "steps['app-token'].outputs['app-slug']");
  const evaluate = new Function('github', 'steps', `return ${expression}`);
  const steps = { 'app-token': { outputs: { 'app-slug': 'configured-app' } } };
  // Both low-permission and writer accounts follow the provider's normal user check.
  for (const login of ['stranger', 'writer', 'custom-developer']) {
    assert.equal(evaluate({ event_name: 'workflow_run', actor: login,
      event: { workflow_run: { actor: { type: 'User', login } } } }, steps), 'configured-app');
  }
  assert.equal(evaluate({ event_name: 'workflow_run', actor: 'different-human',
    event: { workflow_run: { actor: { type: 'Bot', login: 'installation[bot]' } } } }, steps), 'installation[bot]');
  assert.equal(evaluate({ event_name: 'workflow_dispatch', actor: 'manual-caller', event: {} }, steps), 'configured-app');
});

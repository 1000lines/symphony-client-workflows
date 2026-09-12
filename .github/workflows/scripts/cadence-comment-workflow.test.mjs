import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import { checkRequest } from "./cadence-review-check.mjs";

const load = (name) =>
  yaml.load(readFileSync(new URL(`../${name}.yml`, import.meta.url), "utf8"));
const trigger = load("cadence-ai-review-trigger");
const session = load("cadence-ai-review-run");
const recovery = load("cadence-review-check-cleanup");
const queued = trigger.jobs.accept.steps.find((s) => s.id === "queued");
const started = session.jobs.start.steps.find((s) => s.id === "started");
const finished = trigger.jobs.finish.steps.at(-1);
const recovered = recovery.jobs.cleanup.steps.at(-1);
const context = {
  repo: { owner: "owner", repo: "repo" },
  serverUrl: "https://github.com",
  runId: 10,
  runAttempt: 1,
};
const head = "a".repeat(40);
const request = checkRequest(context, 3, head);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function fixture(t) {
  const checks = [],
    comments = [],
    reviews = [],
    writes = [];
  const pr = { state: "open", draft: false, head: { sha: head } };
  const github = {
    rest: {
      checks: {
        listForRef: "checks",
        create: async (input) => {
          const c = { ...input, app: { id: 42 }, id: checks.length + 1 };
          checks.push(c);
          return { data: c };
        },
        update: async (input) => {
          const c = checks.find((c) => c.id === input.check_run_id);
          Object.assign(c, input);
          return { data: c };
        },
      },
      pulls: {
        get: async () => ({ data: structuredClone(pr) }),
        listReviews: "reviews",
        getReview: async ({ review_id }) => ({
          data: reviews.find((r) => r.id === review_id),
        }),
      },
      issues: {
        listComments: "comments",
        createComment: async (input) => {
          writes.push(input);
          const c = {
            id: comments.length + 1,
            body: input.body,
            user: { type: "Bot", login: "cadence[bot]" },
            performed_via_github_app: { id: 42 },
          };
          comments.push(c);
          return { data: c };
        },
        updateComment: async (input) => {
          writes.push(input);
          const c = comments.find((c) => c.id === input.comment_id);
          c.body = input.body;
          return { data: c };
        },
      },
    },
    paginate: async (endpoint, input) =>
      endpoint === "comments"
        ? comments
        : endpoint === "reviews"
        ? reviews
        : checks.filter((c) => c.head_sha === input.ref),
    constructor: class {
      graphql() {
        assert.fail("Already-ready fixture must not change readiness");
      }
    },
  };
  const directory = mkdtempSync(join(tmpdir(), "cadence-comment-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "cadence-check-pointers"));
  const run = async (step, env = {}, req = request) => {
    writeFileSync(
      join(directory, "cadence-check-pointers", "pointer.json"),
      JSON.stringify(req)
    );
    const outputs = {};
    const source = step.with.script
      .replaceAll("${{ vars.CADENCE_APP_ID }}", "42")
      .replaceAll("${{ steps.app-token.outputs.app-slug }}", "cadence")
      .replaceAll("${{ matrix.number }}", "3");
    const core = {
      setOutput: (k, v) => {
        outputs[k] = v;
      },
      setFailed: assert.fail,
      warning() {},
      summary: {
        addRaw() {
          return this;
        },
        async write() {},
      },
    };
    await new AsyncFunction(
      "github",
      "context",
      "core",
      "process",
      "require",
      source
    )(
      github,
      {
        ...context,
        payload: {
          workflow_run: {
            id: Number(req.externalId.split(":")[1]),
            run_attempt: 1,
            conclusion: "failure",
          },
        },
      },
      core,
      {
        env: {
          GITHUB_WORKSPACE: fileURLToPath(
            new URL("../../../", import.meta.url)
          ),
          RUNNER_TEMP: directory,
          CHECK_REQUEST: JSON.stringify(req),
          REVIEW_RESULT: "success",
          RAN_REVIEW: "true",
          REVIEW_BASELINE: "0",
          CADENCE_REVIEWER_LOGIN: "cadence[bot]",
          ...env,
        },
      },
      createRequire(import.meta.url)
    );
    return outputs;
  };
  return { run, checks, comments, reviews, pr, writes, directory, github };
}

test("real YAML publishes one comment through queued, reviewing, completion, duplicate and recovery delivery", async (t) => {
  const f = fixture(t);
  await f.run(queued);
  await f.run(queued);
  assert.equal(f.comments.length, 1);
  assert.equal(f.writes.length, 1);
  assert.match(f.comments[0].body, /Queued/);
  assert.equal((await f.run(started)).active, true);
  assert.match(f.comments[0].body, /Reviewing/);
  await f.run(finished, {
    REVIEW_ASSESSMENT: JSON.stringify({ requestId: request.externalId, headSha: head, disposition: "COMMENT", humanNeeded: false, githubAssessmentSummary: "- Fix retry handling." }),
    REVIEW_MEASUREMENTS: JSON.stringify({
      model: "observed",
      durationMs: 1200,
      usage: { input: 3 },
    }),
  });
  assert.equal(f.checks[0].conclusion, "action_required");
  assert.match(
    f.comments[0].body,
    /Needs attention[\s\S]*Fix retry handling[\s\S]*Model: observed/
  );
  assert.equal(f.reviews.length, 0, "non-approval submits no formal review");
  const body = f.comments[0].body;
  await f.run(finished);
  await f.run(recovered);
  assert.equal(f.comments[0].body, body);
  assert.equal(f.comments.length, 1);
});

test("failed execution and interrupted publication recover without losing a completed check or creating duplicates", async (t) => {
  const f = fixture(t);
  await f.run(queued);
  await f.run(started);
  const update = f.github.rest.issues.updateComment;
  f.github.rest.issues.updateComment = async () => {
    throw new Error("publication denied");
  };
  await assert.rejects(
    f.run(finished, { REVIEW_RESULT: "failure" }),
    /publication denied/
  );
  assert.equal(f.checks[0].conclusion, "failure");
  f.github.rest.issues.updateComment = update;
  await f.run(recovered);
  assert.match(f.comments[0].body, /Failed/);
  const next = checkRequest({ ...context, runId: 11 }, 3, head);
  await f.run(queued, {}, next);
  await f.run(recovered, {}, next);
  assert.equal(f.checks[1].conclusion, "failure");
  assert.equal(f.comments.length, 1);
});

test("older start, finish and recovery cannot replace newer queued work or a changed head", async (t) => {
  const f = fixture(t);
  await f.run(queued);
  const next = checkRequest({ ...context, runId: 11 }, 3, head);
  await f.run(queued, {}, next);
  const newer = f.comments[0].body;
  for (const step of [started, finished, recovered]) await f.run(step);
  assert.equal(f.comments[0].body, newer);
  f.pr.head.sha = "b".repeat(40);
  await f.run(finished, {}, next);
  assert.equal(f.comments[0].body, newer);
});

test("all comment writers share one short native lock, and the long review keeps its separate queue", () => {
  const group = (job) =>
    job.concurrency.group.replace(/\$\{\{(.*?)\}\}/g, (_, expression) =>
      new Function("github", "inputs", "matrix", `return ${expression}`)(
        { repository: "owner/repo", event: {} },
        { pr_number: "3" },
        { number: "3" }
      )
    );
  for (const job of [
    session.jobs.start,
    trigger.jobs.finish,
    recovery.jobs.cleanup,
  ]) {
    assert.equal(group(job), group(trigger.jobs.accept));
    assert.equal(job.concurrency.queue, "max");
    assert.equal(job.concurrency["cancel-in-progress"], false);
  }
  assert.notEqual(group(trigger.jobs.review), group(trigger.jobs.accept));
  assert.equal(
    trigger.jobs.review.uses,
    "./.github/workflows/cadence-ai-review-run.yml"
  );
  assert.equal(trigger.jobs.review.concurrency.queue, "single");
  assert.equal(session.jobs.review.concurrency, undefined);
  assert.equal(session.jobs.review.needs, "start");
  assert.equal(recovery.jobs.cleanup.strategy["fail-fast"], false);
});

test("footer step uses provider execution measurements and omits prose and missing model/token values", async (t) => {
  const f = fixture(t);
  const step = session.jobs.review.steps.find((s) => s.id === "measured");
  const path = join(f.directory, "execution.json");
  writeFileSync(
    path,
    JSON.stringify([
      {
        type: "result",
        duration_ms: 1234,
        modelUsage: { observed: {} },
        usage: { input_tokens: 2, output_tokens: 0 },
        result: "private prose",
      },
    ])
  );
  const measured = JSON.parse(
    (await f.run(step, { EXECUTION_FILE: path, REQUESTED_MODEL: "requested" }))
      .measurements
  );
  assert.equal(measured.model, "observed");
  assert.equal(measured.durationMs, 1234);
  assert.equal(measured.usage.output, 0);
  assert.doesNotMatch(JSON.stringify(measured), /private prose/);
  const unavailable = JSON.parse(
    (
      await f.run(step, {
        STARTED_AT: new Date(Date.now() - 1000).toISOString(),
      })
    ).measurements
  );
  assert.equal(unavailable.model, undefined);
  assert.equal(unavailable.usage, undefined);
  assert.ok(unavailable.durationMs >= 1000);
});


test("assessment and measured footer recover when the check completes but the comment write fails", async t => {
  const f = fixture(t);
  await f.run(queued);
  await f.run(started);
  const write = f.github.rest.issues.updateComment;
  f.github.rest.issues.updateComment = async () => { throw new Error("write failed"); };
  await assert.rejects(f.run(finished, {
    REVIEW_ASSESSMENT: JSON.stringify({ requestId: request.externalId, headSha: head, disposition: "COMMENT", humanNeeded: false, githubAssessmentSummary: "Retain this finding" }),
    REVIEW_MEASUREMENTS: JSON.stringify({ durationMs: 1234 }),
  }), /write failed/);
  f.github.rest.issues.updateComment = write;
  await f.run(recovered);
  assert.match(f.comments[0].body, /Retain this finding[\s\S]*Review: 1.2s/);
  assert.equal(f.comments.length, 1);
  assert.equal(f.reviews.length, 0);
});

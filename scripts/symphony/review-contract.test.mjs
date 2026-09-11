import assert from "node:assert/strict";
import test from "node:test";
import { CADENCE_APP_ID, REVIEW_SCHEMA, createReviewGeneration, feedbackWatermark,
  loadRepositoryConfig, loadRepositoryMapping, resolveTarget, evaluateCi, evaluateAi, queueReviewGeneration,
  completeReviewGeneration, reviewExternalId, reviewDigest, validateReviewOutput } from "./review-contract.mjs";

const head = "a".repeat(40), base = "b".repeat(40), revision = base, controllerRevision = "c".repeat(40);
const config = () => ({ schemaVersion: "symphony-repository/v1", workingDirectory: ".",
  linear: { teamKey: "ENG" },
  instructions: ["SYMPHONY.md"], commands: { test: [["cargo", "test"]] },
  ci: { requiredChecks: [{ name: "CI Required", workflow: ".github/workflows/ci.yml", appId: 15368 }] } });
const sources = () => Object.fromEntries(["reviews", "comments", "threads", "linearComments", "commits"]
  .map(key => [key, { complete: true, nodes: [] }]));
const human = (id = "feedback-1") => ({ id, body: "Fix this", updatedAt: "2026-09-10T01:00:00Z", author: { login: "human" } });
const generation = (extra = {}) => createReviewGeneration({ repositoryId: 100, prNumber: 4,
  headSha: head, baseSha: base, configRevision: revision, controllerRevision, feedback: feedbackWatermark(sources()), ...extra });
const output = gen => ({ schema: REVIEW_SCHEMA, repositoryId: 100, prNumber: 4, headSha: gen.headSha,
  generationId: gen.id, sourcesComplete: true, summary: "All requirements met",
  requirements: [{ id: "R05", status: "satisfied", summary: "Gate enforced", evidence: ["fixture"] }],
  findings: [], humanFeedback: [] });
function fixture() {
  const repository = { id: 100, full_name: "unseen-owner/new-repo", owner: { login: "unseen-owner" }, default_branch: "trunk" };
  const controllerRepository = { id: 200, full_name: "controller/reviewer", owner: { login: "controller" } };
  const pullRequest = { number: 4, state: "open", head: { sha: head, ref: "task" },
    base: { sha: base, ref: "trunk", repo: { id: 100 } }, labels: [{ name: "pink" }, { name: "symphony" }] };
  const context = {
    selection: { source: "project", repository: repository.full_name,
      linear: { team_id: "team", project_id: "project", issue_id: "issue" },
      human: { github: "human", linear_id: "human-id" }, labels: ["pink", "symphony"] },
    configuration: { status: "configured", repository: structuredClone(repository), baseBranch: "trunk", revision, config: config() },
    host: { revision: controllerRevision, controller: { full_name: "controller/reviewer", base_branch: "main",
      workflow: ".github/workflows/cadence-ai-review.yml" }, apps: { symphony: { app_id: 4866508 }, cadence: { app_id: CADENCE_APP_ID } },
      ci: { missing_after_minutes: 20, queued_after_minutes: 60, completion_grace_minutes: 2, run_budget_minutes: 120 },
      review: { timeout_minutes: 60, max_passes: 3, operational_retries: 1 } },
    hostRevision: controllerRevision, controllerRevision, repository, controllerRepository, pullRequest,
    request: { repositoryId: 100, prNumber: 4, headSha: head },
    issue: { id: "issue", team: { id: "team" }, project: { id: "project" } }, associations: ["issue"],
    installations: { complete: true, nodes: [11, 12, 21, 22].map((id, i) => ({ id,
      app_id: i % 2 ? CADENCE_APP_ID : 4866508, account: { login: i < 2 ? "unseen-owner" : "controller" },
      suspended_at: null, repository_ids: [i < 2 ? 100 : 200] })) },
    ciDiscovery: { complete: true, revision, repositoryId: 100, required_checks: [{ name: "CI Required", app_id: 15368,
      workflow_path: ".github/workflows/ci.yml", events: ["push", "pull_request"], ref_policy: "pr-head", tested_ref: "head",
      running_timeout_minutes: 5, children: ["build", "lint", "test", "Changed Markdown"].map(name => ({ name, running_timeout_minutes: 20 })) }] },
  };
  const target = resolveTarget(context);
  const run = { id: 20, run_number: 1, run_attempt: 1, path: ".github/workflows/ci.yml", event: "pull_request",
    repository: { id: 100 }, head_sha: head, head_branch: "task", status: "completed", conclusion: "success", check_suite_id: 30 };
  const names = ["CI Required", ...target.ci.required_checks[0].children.map(c => c.name)];
  const jobs = names.map((name, i) => ({ id: 40 + i, name, run_id: 20, run_attempt: 1, head_sha: head,
    tested_sha: head, status: "completed", conclusion: "success", check_run_url: `https://api.github.com/checks/${50 + i}` }));
  const checks = jobs.map((job, i) => ({ id: 50 + i, url: job.check_run_url, name: job.name,
    app: { id: 15368 }, head_sha: head, check_suite: { id: 30 }, status: "completed", conclusion: "success" }));
  const gen = generation();
  const queued = queueReviewGeneration(null, gen, { checkId: 90 });
  const state = completeReviewGeneration(queued, { generationId: gen.id, attempt: 1, checkId: 90,
    phase: "completed", output: output(gen) }, gen);
  const check = { id: 90, name: "Cadence Review", app: { id: CADENCE_APP_ID }, head_sha: head,
    external_id: reviewExternalId(state), status: "completed", conclusion: "success" };
  return { context, target, gen, queued, state,
    ci: { target, runs: [run], jobs, checks, complete: true },
    ai: { target, pullRequest, generation: gen, checks: [check], complete: true,
      workpad: { commentId: "workpad", issueId: "issue", reviewContract: state } } };
}

test("an unseen repository resolves from task context, base config and discovered installations", () => {
  const { context, target } = fixture();
  assert.equal(target.full_name, "unseen-owner/new-repo");
  assert.equal(target.apps.cadence.installation_id, 12);
  assert.equal(target.controller.apps.cadence.installation_id, 22);
  assert.equal(target.configRevision, base);
  assert.equal(target.controllerRevision, controllerRevision);
  assert.deepEqual(target.repositoryConfig, config());
  assert.equal(target.issueId, "issue");
  assert.equal(target.baseBranch, "trunk");
  context.selection.source = "human-task";
  context.selection.baseBranch = "release/stable";
  context.configuration.baseBranch = context.pullRequest.base.ref = "release/stable";
  assert.equal(resolveTarget(context).baseBranch, "release/stable");
  // No controller target list or per-repository enabled flag exists.
  assert.equal(loadRepositoryMapping, loadRepositoryConfig);
});

test("target authorization rejects identity, configuration, installation and association substitutions", () => {
  for (const change of [
    c => { c.request.repositoryId = "100"; }, c => { c.request.repositoryId = 101; },
    c => { c.request.installationId = 12; }, c => { c.request.projectId = "other"; },
    c => { c.request.repository = "other/repo"; }, c => { c.request.baseBranch = "task"; },
    c => { c.request.permissions = { contents: "write" }; }, c => { c.request.workflow = "untrusted"; },
    c => { c.hostRevision = base; }, c => { c.controllerRevision = base; },
    c => { c.configuration.status = "missing"; }, c => { c.configuration.revision = head; },
    c => { c.configuration.repository.id = 101; }, c => { c.configuration.repository.full_name = "other/repo"; },
    c => { c.configuration.baseBranch = "task"; }, c => { c.selection.baseBranch = "task"; },
    c => { c.selection.source = "incidental-url"; }, c => { c.selection.repository = "other/repo"; },
    c => { c.repository.full_name = "other/repo"; }, c => { c.repository.owner.login = "other"; },
    c => { c.pullRequest.state = "closed"; }, c => { c.pullRequest.head.sha = base; },
    c => { c.pullRequest.base.repo.id = 101; }, c => { c.pullRequest.base.ref = "task"; }, c => { c.pullRequest.labels = []; },
    c => { c.issue.project.id = "another-project"; }, c => { c.issue.team.id = "other"; },
    c => { c.issue.id = "another-issue"; c.associations = [c.issue.id]; },
    c => { c.associations.push("another-issue"); }, c => { c.associations = []; },
    c => { c.selection.human.github = ""; }, c => { c.selection.labels = []; },
    c => { c.installations.complete = false; }, c => { c.installations.nodes[0].repository_ids = []; },
    c => { c.installations.nodes[1].app_id = 1; }, c => { c.installations.nodes[1].account.login = "other"; },
    c => { c.installations.nodes[1].suspended_at = "2026-09-10"; },
    c => { c.installations.nodes.push({ ...c.installations.nodes[1], id: 99 }); },
    c => { c.configuration.config.ci.requiredChecks = []; },
    c => { c.configuration.config.ci.requiredChecks[0].workflow = ".github/workflows/other.yml"; },
    c => { c.configuration.config.ci.requiredChecks[0].appId = 999; },
    c => { c.ciDiscovery.complete = false; }, c => { c.ciDiscovery.revision = head; },
    c => { c.ciDiscovery.repositoryId = 999; }, c => { c.ciDiscovery.required_checks = []; },
    c => { c.ciDiscovery.required_checks[0].events = []; }, c => { c.host.review.max_passes = 99; },
    c => { c.host.apps.cadence.app_id = 1; }, c => { c.host.ci.run_budget_minutes = 0; },
    c => { c.controllerRepository.full_name = "other/controller"; },
  ]) {
    const { context } = fixture(); change(context);
    assert.throws(() => resolveTarget(context), change.toString());
  }
  for (const field of ["repository", "repository_id", "enabled", "apps", "installationId", "linear", "dispatch", "privateKey", "review"]) {
    const { context } = fixture(); context.configuration.config[field] = "untrusted";
    assert.throws(() => resolveTarget(context), field);
  }
});

function configApi(mode = "success") {
  const { context } = fixture(), urls = [], blobSha = "d".repeat(40);
  return { urls, options: { repository: context.repository.full_name, expectedRevision: base, token: "fixture-only",
    fetchImpl: async url => {
      urls.push(url);
      const entry = { path: ".symphony.cfg.json", type: "blob", mode: mode === "symlink" ? "120000" : "100644", sha: blobSha };
      let data;
      if (url.endsWith("/new-repo")) data = { ...context.repository, ...(mode === "wrong-repo" ? { id: null } : {}) };
      else if (url.includes("/branches/")) data = { name: decodeURIComponent(url.split("/branches/")[1]),
        protected: false, commit: { sha: mode === "stale" ? head : base } };
      else if (url.includes("/git/trees/")) data = { truncated: mode === "truncated",
        tree: mode === "missing" ? [] : mode === "duplicate" ? [entry, entry] : [entry] };
      else if (url.endsWith(`/git/blobs/${blobSha}`)) data = { sha: blobSha, encoding: "base64",
        content: Buffer.from(mode === "malformed" ? "?" : JSON.stringify(mode === "invalid" ? { ...config(), dispatch: {} } : config())).toString("base64") };
      else assert.fail(`unexpected config request: ${url}`);
      const denied = ["denied", "hidden"].includes(mode) && url.includes("/git/trees/");
      return { ok: !denied, status: mode === "hidden" ? 404 : 403, json: async () => data };
    } } };
}

test("loader discovers the selected target and pins regular config to its fetched base", async () => {
  const { urls, options } = configApi();
  const result = await loadRepositoryConfig(options);
  assert.equal(result.status, "configured");
  assert.equal(result.repository.id, 100);
  assert.equal(result.baseBranch, "trunk");
  assert.equal(result.revision, base);
  assert.deepEqual(result.config, config());
  assert.ok(urls.every(url => url.startsWith("https://api.github.com/repos/unseen-owner/new-repo")));
  assert.ok(urls.some(url => url.endsWith(`/git/trees/${base}`)));
  assert.ok(!urls.some(url => url.includes(head)));
  const explicit = configApi();
  assert.equal((await loadRepositoryConfig({ ...explicit.options, baseBranch: "release/stable" })).baseBranch, "release/stable");
  assert.ok(explicit.urls.some(url => url.endsWith("/branches/release%2Fstable")));
  const { context } = fixture(); context.configuration = result;
  assert.equal(resolveTarget(context).full_name, "unseen-owner/new-repo");
});

test("missing config is an onboarding handoff; inaccessible or invalid sources cannot masquerade as missing", async () => {
  for (const repository of ["../other", "owner/..", "https://github.com/owner/repo"]) {
    await assert.rejects(loadRepositoryConfig({ repository, expectedRevision: base,
      fetchImpl: () => assert.fail("invalid selection must not make an API request") }), /Invalid selected repository/);
  }
  const { options } = configApi("missing");
  const result = await loadRepositoryConfig(options);
  assert.equal(result.status, "missing");
  const { context } = fixture(); context.configuration = result;
  assert.throws(() => resolveTarget(context), /symphony-repository must propose/);
  for (const mode of ["stale", "denied", "hidden", "malformed", "invalid", "wrong-repo", "symlink", "duplicate", "truncated"]) {
    await assert.rejects(loadRepositoryConfig(configApi(mode).options), undefined, mode);
  }
});

test("CI requires exact workflow, event, run attempt, App, checkout and every child", () => {
  assert.equal(evaluateCi(fixture().ci).passes, true);
  for (const change of [
    c => { c.complete = false; }, c => { c.runs = []; }, c => { c.checks = []; },
    c => { c.target.ci.required_checks = []; }, c => { c.target.ci.required_checks[0].events = []; },
    c => { c.runs[0].path = ".github/workflows/review.yml"; }, c => { c.runs[0].event = "pull_request_target"; },
    c => { c.runs[0].head_branch = "other"; }, c => { c.runs[0].head_sha = base; },
    c => { c.runs[0].repository.id = 101; }, c => { c.runs[0].run_attempt = 2; },
    c => { c.runs.push({ ...c.runs[0], id: 21, run_number: 2, status: "queued", conclusion: null }); },
    c => { c.runs.push({ ...c.runs[0] }); }, c => { c.jobs.push({ ...c.jobs[0] }); },
    c => { c.jobs.pop(); }, c => { c.jobs[0].tested_sha = base; },
    c => { c.jobs[0].check_run_url = "other"; }, c => { c.checks[0].app.id = 999; },
    c => { c.checks[0].head_sha = base; }, c => { c.checks[0].check_suite.id = 31; },
    c => { c.checks.push({ ...c.checks[0], id: 300 }); },
  ]) {
    const { ci } = fixture(); change(ci);
    assert.equal(evaluateCi(ci).passes, false, change.toString());
  }
  for (const conclusion of ["failure", "cancelled", "timed_out", "skipped", "neutral", "action_required", "unknown", null]) {
    for (const surface of ["runs", "jobs", "checks"]) {
      const { ci } = fixture(); ci[surface][0].conclusion = conclusion;
      assert.equal(evaluateCi(ci).passes, false, `${surface}: ${conclusion}`);
    }
    const { ci } = fixture(); ci.jobs[1].conclusion = conclusion;
    assert.equal(evaluateCi(ci).passes, false, `child: ${conclusion}`);
  }
});

function addCiAttempt(ci, { id = 21, run_number = 2, run_attempt = 1, event = "push" } = {}) {
  const template = fixture().ci;
  const run = { ...template.runs[0], id, run_number, run_attempt, event, check_suite_id: id + 1000 };
  const jobs = template.jobs.map((job, i) => ({ ...job, id: id * 100 + run_attempt * 10 + i,
    run_id: id, run_attempt, check_run_url: `https://api.github.com/checks/${id}-${run_attempt}-${i}` }));
  const checks = template.checks.map((check, i) => ({ ...check, id: jobs[i].id,
    url: jobs[i].check_run_url, check_suite: { id: run.check_suite_id } }));
  ci.runs.push(run); ci.jobs.push(...jobs); ci.checks.push(...checks);
  return { run, jobs, checks };
}

test("CI retains evidence for every peer run at the current head", () => {
  const { ci } = fixture();
  addCiAttempt(ci);
  const result = evaluateCi(ci);
  assert.equal(result.passes, true);
  assert.deepEqual(result.evidence.map(e => e.runId).sort(), [20, 21]);
  assert.ok(result.evidence.every(e => e.jobs.length === 5));
});

test("a successful peer cannot hide nonpassing push or PR runs in either order", () => {
  for (const event of ["push", "pull_request"]) {
    for (const status of ["completed", "queued", "in_progress"]) {
      const conclusions = status === "completed"
        ? ["failure", "cancelled", "timed_out", "skipped", "neutral", "action_required", "unknown", null] : [null];
      for (const conclusion of conclusions) {
        for (const failingNumber of [1, 2]) {
          const { ci } = fixture();
          const peer = addCiAttempt(ci);
          const bad = failingNumber === 1 ? ci.runs[0] : peer.run;
          const good = failingNumber === 1 ? peer.run : ci.runs[0];
          Object.assign(bad, { event, status, conclusion });
          good.event = event === "push" ? "pull_request" : "push";
          for (const runs of [ci.runs, [...ci.runs].reverse()]) {
            assert.equal(evaluateCi({ ...ci, runs }).passes, false,
              `${event} run ${failingNumber}: ${status}/${conclusion}`);
          }
        }
      }
    }
  }
});

test("each peer needs its own verified successful checks and children", () => {
  for (const change of [
    p => { p.jobs[1].conclusion = "failure"; },
    p => { p.checks[1].conclusion = "failure"; },
    p => { p.checks[1].app.id = 999; },
    p => { p.jobs[1].tested_sha = base; },
    p => { p.checks[1].check_suite.id = 999; },
  ]) {
    const { ci } = fixture(); const peer = addCiAttempt(ci);
    assert.equal(evaluateCi(ci).passes, true);
    change(peer);
    assert.equal(evaluateCi(ci).passes, false, change.toString());
  }
});

test("distinct successful run IDs cannot share a run number", () => {
  const { ci } = fixture();
  const peer = addCiAttempt(ci);
  assert.equal(evaluateCi(ci).passes, true);
  peer.run.run_number = ci.runs[0].run_number;
  assert.equal(evaluateCi(ci).reason, "ambiguous-run:CI Required");
});

test("only genuine later attempts supersede a run, never a distinct peer", () => {
  const { ci } = fixture();
  ci.runs[0].conclusion = "failure";
  const retry = addCiAttempt(ci, { id: 20, run_number: 1, run_attempt: 2, event: "pull_request" });
  addCiAttempt(ci);
  assert.equal(evaluateCi(ci).passes, true);
  assert.equal(evaluateCi(ci).evidence.find(e => e.runId === 20).attempt, 2);
  for (const conclusion of ["failure", null]) {
    retry.run.conclusion = conclusion;
    retry.run.status = conclusion ? "completed" : "queued";
    assert.equal(evaluateCi(ci).passes, false);
  }
  for (const change of [
    c => { c.runs[1].id = 99; },
    c => { c.runs[1].run_number = 3; },
    c => { c.runs[1].event = "push"; },
    c => { c.runs.push({ ...c.runs[1] }); },
  ]) {
    const invalid = structuredClone(ci);
    Object.assign(invalid.runs[1], { status: "completed", conclusion: "success" });
    change(invalid);
    assert.equal(evaluateCi(invalid).passes, false, change.toString());
  }
});

test("AI cannot accept a completed review acquired with incomplete feedback sources", () => {
  for (const source of Object.keys(sources())) {
    const { ai, gen } = fixture();
    const incomplete = sources(); incomplete[source].complete = false;
    const next = generation({ feedback: feedbackWatermark(incomplete) });
    const queued = queueReviewGeneration(null, next, { checkId: 90 });
    const completed = completeReviewGeneration(queued, { generationId: next.id, attempt: 1,
      checkId: 90, phase: "completed", output: output(next) }, next);
    ai.generation = next; ai.workpad.reviewContract = completed;
    ai.checks[0].external_id = reviewExternalId(completed);
    assert.notEqual(next.id, gen.id);
    assert.equal(evaluateAi(ai).passes, false, source);
  }
});

test("legacy bot accounts cannot create feedback generations or reset the pass cap", () => {
  for (const login of [process.env.SYMPHONY_BOT_USER || "example-symphony-bot",
    process.env.CADENCE_REVIEWER || "example-cadence-bot", "another-app[bot]"]) {
    const feedback = sources();
    feedback.comments.nodes = [{ ...human(), author: { login, __typename: "User" } }];
    assert.deepEqual(feedbackWatermark(feedback).records, [], login);
    assert.equal(generation({ feedback: feedbackWatermark(feedback) }).resetKey, generation().resetKey, login);
  }
});

test("AI success requires exact check/generation, closed ledger and durable workpad", () => {
  assert.equal(evaluateAi(fixture().ai).passes, true);
  for (const change of [
    a => { a.complete = false; }, a => { a.generation = {}; },
    a => { a.target.apps.cadence.app_id = 5; }, a => { a.pullRequest.state = "closed"; },
    a => { a.pullRequest.labels = []; }, a => { a.pullRequest.head.sha = base; },
    a => { a.checks[0].app.id = 1; }, a => { a.checks[0].name = "Review"; },
    a => { a.checks[0].head_sha = base; }, a => { a.checks[0].external_id = "old-generation"; },
    a => { a.checks.push({ ...a.checks[0], id: 91, status: "queued", conclusion: null }); },
    a => { a.workpad = null; }, a => { a.workpad.commentId = null; }, a => { a.workpad.issueId = "other"; },
    a => { a.workpad.reviewContract.phase = "queued"; }, a => { a.workpad.reviewContract.output = null; },
    a => { a.workpad.reviewContract.outputDigest = "wrong"; },
    a => { const f = sources(); f.comments.nodes.push(human()); a.generation = generation({ feedback: feedbackWatermark(f) }); },
    a => { a.generation = generation({ baseSha: head }); },
    a => { a.generation = generation({ configRevision: head }); },
    a => { a.target.controllerRevision = head; },
    a => { a.generation = generation({ manualRetry: 1 }); },
  ]) {
    const { ai } = fixture(); change(ai);
    assert.equal(evaluateAi(ai).passes, false, change.toString());
  }
  for (const conclusion of ["neutral", "skipped", "unknown", "failure", "cancelled", "timed_out", "action_required", null]) {
    const { ai } = fixture(); ai.checks[0].conclusion = conclusion;
    assert.equal(evaluateAi(ai).passes, false);
  }
});

test("malformed output, omitted feedback, mandatory findings and retained blockers reject", () => {
  const gen = generation();
  for (const bad of [null, {}, { ...output(gen), findings: [null] }, { ...output(gen), requirements: [] },
    { ...output(gen), sourcesComplete: false }, { ...output(gen), findings: [{ id: "F", summary: "bad", status: "open", class: "unknown" }] }]) {
    assert.equal(validateReviewOutput(bad, gen), false);
  }
  const f = sources(); f.threads.nodes = [human()];
  const feedbackGen = generation({ feedback: feedbackWatermark(f) });
  assert.equal(validateReviewOutput(output(feedbackGen), feedbackGen), false);
  for (const [kind, mandatory, passes] of [["blocker", false, false], ["human-needed", false, false],
    ["should-fix", false, true], ["suggestion", false, true], ["suggestion", true, false]]) {
    const { ai, queued } = fixture();
    const assessed = { ...output(gen), findings: [{ id: "F1", class: kind, mandatory, status: "open", summary: "finding", evidence: [] }] };
    ai.workpad.reviewContract = completeReviewGeneration(queued, { generationId: gen.id, attempt: 1,
      checkId: 90, phase: "completed", output: assessed }, gen);
    assert.equal(evaluateAi(ai).passes, passes, kind);
    if (kind !== "blocker") continue;
    const nextGen = generation({ manualRetry: 1 });
    const next = queueReviewGeneration(ai.workpad.reviewContract, nextGen, { checkId: 91 });
    const completed = completeReviewGeneration(next, { generationId: nextGen.id, attempt: 1,
      checkId: 91, phase: "completed", output: output(nextGen) }, nextGen);
    ai.workpad.reviewContract = completed;
    ai.generation = nextGen;
    ai.checks = [{ ...ai.checks[0], id: 91, external_id: reviewExternalId(completed) }];
    assert.equal(evaluateAi(ai).passes, false, "omission does not close old blocker");
    assert.throws(() => completeReviewGeneration(next, { generationId: nextGen.id, attempt: 1, checkId: 91,
      phase: "completed", output: { ...assessed, generationId: nextGen.id, findings: [{ ...assessed.findings[0], class: "suggestion" }] } }, nextGen), /weakened/);
  }
});

test("all feedback changes invalidate generations; generated bookkeeping cannot reset the cap", () => {
  const f = sources(); f.comments.nodes = [human()];
  const before = generation({ feedback: feedbackWatermark(f) });
  f.linearComments.nodes = [{ ...human("workpad"), body: "\n## Codex Workpad\nNew progress" }];
  assert.equal(generation({ feedback: feedbackWatermark(f) }).id, before.id);
  f.comments.nodes[0].body = "edited at same timestamp";
  assert.notEqual(generation({ feedback: feedbackWatermark(f) }).id, before.id);
  for (const source of Object.keys(f)) {
    const next = sources(); next[source].nodes = [human()];
    assert.notEqual(generation({ feedback: feedbackWatermark(next) }).id, generation().id);
    next[source].complete = false;
    assert.equal(feedbackWatermark(next).complete, false);
  }
  const bot = sources(); bot.comments.nodes = [{ ...human(), author: { login: "app", __typename: "Bot" } }];
  assert.deepEqual(feedbackWatermark(bot).records, []);
  const invalid = sources(); invalid.reviews.nodes = [{ ...human(), updatedAt: null }];
  assert.equal(feedbackWatermark(invalid).complete, false);
  const g = generation(); let current;
  for (let pass = 1; pass <= 3; pass++) {
    const nextGen = generation({ headSha: String(pass).repeat(40) });
    current = queueReviewGeneration(current, nextGen, { checkId: 100 + pass });
    assert.equal(current.passes, pass);
    assert.equal(queueReviewGeneration(current, nextGen, { checkId: 100 + pass }), current);
    current = completeReviewGeneration(current, { generationId: nextGen.id, attempt: 1,
      checkId: 100 + pass, phase: "completed", output: output(nextGen) }, nextGen);
  }
  assert.throws(() => queueReviewGeneration(current, g, { checkId: 104 }), /Three-pass/);
  assert.equal(queueReviewGeneration(current, before, { checkId: 105 }).passes, 1);
});

test("late publication and extra operational retries cannot overwrite current review", () => {
  const { queued, gen } = fixture();
  const completion = { generationId: gen.id, attempt: 1, checkId: 90, phase: "completed", output: output(gen) };
  assert.throws(() => completeReviewGeneration(queued, completion, generation({ headSha: base })), /Superseded/);
  assert.throws(() => completeReviewGeneration(queued, { ...completion, attempt: 2 }, gen), /Superseded/);
  const error = completeReviewGeneration(queued, { ...completion, phase: "operational-error" }, gen);
  const retry = queueReviewGeneration(error, gen, { checkId: 91, operationalRetry: true });
  assert.equal(retry.passes, 1);
  const again = completeReviewGeneration(retry, { ...completion, attempt: 2, checkId: 91, phase: "operational-error" }, gen);
  assert.throws(() => queueReviewGeneration(again, gen, { checkId: 92, operationalRetry: true }), /unavailable/);
  assert.throws(() => completeReviewGeneration(retry, completion, gen), /Superseded/);
  assert.equal(reviewDigest(gen), reviewDigest(structuredClone(gen)));
});

test("cross-owner discovery rejects controller/target installation reuse and incomplete grants", () => {
  for (const change of [
    c => { c.controllerRepository.id = 999; },
    c => { c.installations.nodes = c.installations.nodes.filter(i => i.id !== 21); },
    c => { c.installations.nodes[3].id = 12; },
    c => { c.installations.nodes[3].suspended_at = "now"; },
    c => { c.installations.nodes[3].repository_ids = []; },
  ]) {
    const { context } = fixture(); change(context); assert.throws(() => resolveTarget(context));
  }
  const { context } = fixture();
  context.controllerRepository = structuredClone(context.repository);
  context.host.controller.full_name = context.repository.full_name;
  context.installations.nodes = context.installations.nodes.slice(0, 2);
  assert.equal(resolveTarget(context).controller.apps.cadence.installation_id, 12);
});

test("identical completed generation coalesces; retries require explicit operational intent", () => {
  const { state, gen } = fixture();
  assert.equal(queueReviewGeneration(state, gen, { checkId: 999 }), state);
  assert.throws(() => queueReviewGeneration(state, gen, { checkId: 999, operationalRetry: true }), /unavailable/);
});

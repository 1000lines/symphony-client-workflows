import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { resolveCadenceEvent } from "./cadence-forwarded-event.mjs";
import { routeCadenceReviewEvent } from "./cadence-ai-review-route-event.mjs";
import { routeReviewHandoff } from "../../../scripts/cadence-linear-rework.mjs";

const yaml = createRequire(import.meta.url)("js-yaml");
const repository = "example-org/example-repo";
const root = `/repos/${repository}`;
const head = "a".repeat(40);
const author = { id: 42, login: "writer", type: "User" };
const fixture = (eventName = "pull_request_review", action = "submitted", fork = false) => {
  const run = { id: 10, event: eventName, name: "Cadence Review Ingress", status: "completed", conclusion: "success",
    path: ".github/workflows/cadence-review-ingress.yml", repository: { full_name: repository }, actor: author,
    // GitHub can omit this list for fork runs; it is never the routing authority.
    pull_requests: fork ? [] : [{ number: 7 }],
    display_title: JSON.stringify({ event: eventName, action, number: 7, id: 9, head }) };
  const pr = { number: 7, state: "open", title: "[DEMO-7]: routing", labels: [{ name: "symphony" }],
    url: `https://api.github.com${root}/pulls/7`, user: { login: "example-symphony-bot" },
    head: { sha: head, repo: { full_name: fork ? "writer/fork" : repository } }, base: { repo: { full_name: repository } } };
  const feedback = { id: 9, user: author, body: "Please fix the routing", state: "commented", commit_id: head,
    submitted_at: "2026-09-11T01:00:00Z", updated_at: "2026-09-11T01:00:00Z",
    pull_request_url: pr.url, issue_url: `https://api.github.com${root}/issues/7` };
  const read = async path => {
    if (path === `${root}/actions/runs/10`) return run;
    if (path === `${root}/pulls/7`) return pr;
    assert.ok([`${root}/pulls/7/reviews/9`, `${root}/pulls/comments/9`, `${root}/issues/comments/9`].includes(path), path);
    return feedback;
  };
  const github = { request: async path => ({ data: await read(path.replace(/^GET /, "")) }) };
  const context = { ref: "refs/heads/main", repo: { owner: "example-org", repo: "example-repo" },
    payload: { workflow_run: run }, actor: "github-actions[bot]" };
  return { run, pr, feedback, github, context };
};
const resolve = f => resolveCadenceEvent(f);

for (const fork of [false, true]) {
  for (const [eventName, action] of [
    ["pull_request_target", "opened"], ["pull_request_target", "synchronize"], ["pull_request_target", "ready_for_review"],
    ["pull_request_review", "submitted"], ["pull_request_review", "edited"],
    ["issue_comment", "created"], ["issue_comment", "edited"],
    ["pull_request_review_comment", "created"], ["pull_request_review_comment", "edited"],
  ]) {
    test(`${fork ? "fork" : "same-repository"} ${eventName}.${action} resolves current evidence on main`, async () => {
      const f = fixture(eventName, action, fork);
      const resolved = await resolve(f);
      assert.equal(resolved.eventName, eventName);
      assert.equal(resolved.payload.pull_request, f.pr);
      assert.equal(resolved.payload.sender, author);
      if (eventName !== "pull_request_target") {
        assert.equal((resolved.payload.review || resolved.payload.comment).body, f.feedback.body);
      }
    });
  }
}

for (const [name, change] of [
  ["wrong repository", f => { f.run.repository.full_name = "elsewhere/repo"; }],
  ["wrong workflow", f => { f.run.path = ".github/workflows/untrusted.yml"; }],
  ["wrong event", f => { f.run.event = "push"; }],
  ["failed ingress", f => { f.run.conclusion = "failure"; }],
  ["pending ingress", f => { f.run.status = "in_progress"; }],
  ["missing actor", f => { delete f.run.actor; }],
  ["missing selector", f => { f.run.display_title = "arbitrary title"; }],
  ["title injection", f => { f.run.display_title += "\nSOURCE_RUN_ID=1"; }],
]) {
  test(`${name} cannot reach consumers`, async () => {
    const f = fixture(); change(f);
    await assert.rejects(resolve(f));
  });
}

for (const [name, change] of [
  ["stale head", f => { f.pr.head.sha = "b".repeat(40); }],
  ["wrong PR", f => { f.pr.number = 8; }],
  ["wrong base repository", f => { f.pr.base.repo.full_name = "writer/fork"; }],
  ["closed PR", f => { f.pr.state = "closed"; }],
  ["missing author", f => { delete f.feedback.user; }],
  ["wrong feedback ID", f => { f.feedback.id = 11; }],
  ["wrong feedback parent", f => { f.feedback.pull_request_url += "0"; }],
  ["unsubmitted review", f => { delete f.feedback.submitted_at; }],
  ["review on an old commit", f => { f.feedback.commit_id = "b".repeat(40); }],
]) {
  test(`${name} cannot reach either consumer`, async () => {
    const f = fixture(); change(f);
    await assert.rejects(resolve(f));
  });
}

for (const permission of ["write", "maintain", "admin", "read", "none", "unknown"]) {
  test(`main rechecks original feedback author ${permission} permission, never the forwarding bot`, async () => {
    const f = fixture();
    // A caller claiming writer/admin authority cannot change API author identity.
    f.context.payload.actor = { ...author, login: "admin" };
    const resolved = await resolve(f);
    const reads = [];
    const fetchImpl = async url => {
      reads.push(url);
      if (url === "https://api.github.com/installation/repositories?per_page=1") {
        return Response.json({ total_count: 1, repositories: [{ id: 1, full_name: repository }] });
      }
      if (url.endsWith("/reviews/9")) return Response.json(f.feedback);
      assert.equal(url, `https://api.github.com${root}/collaborators/writer/permission`);
      return Response.json({ permission, user: author });
    };
    const result = await routeCadenceReviewEvent({ ...resolved, repository, token: "ghs_fixture", fetchImpl });
    assert.equal(result.shouldRequestReview, ["write", "maintain", "admin"].includes(permission));
    assert.equal(result.triggerActor, "writer");
    assert.equal(reads.filter(url => url.endsWith("/permission")).length, 1);
    if (!result.shouldRequestReview) {
      const handoff = await routeReviewHandoff({ ...resolved, repository, githubToken: "ghs_fixture", fetchImpl });
      assert.equal(handoff.operation, permission === "unknown" ? "failed" : "skipped");
      assert.equal(handoff.shouldMove, false);
    }
  });
}

test("bot editing a human's feedback cannot supply that human's authority", async () => {
  const f = fixture();
  f.run.actor = { id: 100, login: "forwarder[bot]", type: "Bot" };
  const resolved = await resolve(f);
  const result = await routeCadenceReviewEvent({ ...resolved, repository, token: "ghs_fixture",
    fetchImpl: async () => assert.fail("No permission or mutation request is allowed") });
  assert.equal(result.shouldRequestReview, false);
  assert.equal(result.skipReason, "non-human-feedback-editor");
});

test("workflow boundaries keep PR ingress secret-free and every privileged job on main", () => {
  const read = name => yaml.load(readFileSync(new URL(`../${name}.yml`, import.meta.url), "utf8"));
  const ingress = read("cadence-review-ingress");
  assert.deepEqual(ingress.permissions, {});
  assert.match(ingress.jobs.ingress.if, /contains\(github.event.pull_request.labels/);
  assert.match(ingress.jobs.ingress.if, /vars.SYMPHONY_BOT_USER/);
  // The same free gate marks skipped ingress runs, whose conclusion may be success.
  assert.ok(ingress["run-name"].replace(/\s+/g, " ").includes(ingress.jobs.ingress.if.trim().replace(/\s+/g, " ")));

  assert.doesNotMatch(JSON.stringify(ingress.jobs), /secrets|environment|checkout|github.token|GITHUB_TOKEN/);
  const events = read("cadence-ai-review-events"), handoff = read("cadence-linear-rework");
  assert.deepEqual(events.on.workflow_run.workflows, ["Cadence Review Ingress"]);
  assert.equal(events.on.workflow_dispatch, undefined);
  assert.equal(events.jobs.forward, undefined);
  assert.deepEqual(handoff.on.workflow_run.workflows, ["Cadence Review Ingress"]);
  for (const job of [events.jobs.route, handoff.jobs["review-handoff"]]) {
    assert.match(job.if, /refs\/heads\/main.*workflow_run.conclusion/);
    assert.match(job.if, /fromJSON\(github.event.workflow_run.display_title\).eligible/);
    assert.equal(job.environment, "cadence-controller");
    assert.equal(job.steps[0].with.ref, "main");
    assert.equal(job.steps[0].with["persist-credentials"], false);
    assert.match(job.steps[1].uses, /^actions\/github-script@/);
    assert.match(job.steps[1].with.script, /cadence-forwarded-event.mjs/);
  }
  assert.equal(events.jobs.route.permissions['pull-requests'], 'read');
  assert.match(handoff.jobs['review-handoff'].concurrency.group, /fromJSON\(github.event.workflow_run.display_title\).number/);
  assert.equal(handoff.jobs['review-handoff'].concurrency.queue, "max");
});

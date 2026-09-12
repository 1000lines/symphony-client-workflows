import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import yaml from "js-yaml";
import { prReference, reconcilePrClose } from "./symphony-pr-close.mjs";

const repo = "owner/client", url = `https://github.com/${repo}/pull/1`;
const states = [
  { id: "team-active", name: "Active", type: "started" },
  { id: "team-done", name: "Done", type: "completed" },
  { id: "team-canceled", name: "Canceled", type: "canceled" },
];
const connection = (nodes, hasNextPage = false, endCursor = null) => ({ nodes, pageInfo: { hasNextPage, endCursor } });
const pr = (number = 1, overrides = {}) => ({
  number, html_url: `https://github.com/${repo}/pull/${number}`, state: "closed", merged: false,
  title: "[100-109]: reconcile status", head: { ref: "symphony/misc/100-109/close" },
  base: { repo: { full_name: repo } }, ...overrides,
});
function fixture(prs = [pr()]) {
  const f = {
    prs, reads: [], writes: [], calls: [],
    issue: { id: "issue-id", identifier: "100-109", updatedAt: "v1", state: states[0], team: { id: "team-id", key: "100" } },
    attachments: prs.map(p => ({ url: p.html_url })),
    links: [{ issue: { id: "issue-id", identifier: "100-109" } }], states,
  };
  f.github = { rest: { pulls: { get: async (input) => {
    f.reads.push(input);
    await f.beforePr?.(input);
    const found = f.prs.find(p => p.number === input.pull_number && p.base.repo.full_name.toLowerCase() === `${input.owner}/${input.repo}`);
    if (!found) throw new Error("GitHub PR unavailable: HTTP 404");
    return { data: structuredClone(found) };
  } } } };
  f.fetch = async (endpoint, options) => {
    assert.equal(endpoint, "https://api.linear.app/graphql");
    const { query, variables } = JSON.parse(options.body);
    const op = query.match(/(?:query|mutation) (\w+)/)[1];
    f.calls.push({ op, ...variables });
    await f.beforeLinear?.(op, variables);
    let data;
    if (op === "CloseIssue") data = { issue: f.issue };
    else if (op === "CloseLinks") data = { attachmentsForURL: f.linkPage?.(variables.after) || connection(f.links) };
    else if (op === "CloseAttachments") data = { issue: { attachments: f.attachmentPage?.(variables.after) || connection(f.attachments) } };
    else if (op === "CloseStates") data = { team: { states: f.statePage?.(variables.after) || connection(f.states) } };
    else if (op === "CloseIssueUpdate") {
      f.writes.push(variables);
      f.issue.state = f.states.find(s => s.id === variables.stateId);
      f.issue.updatedAt = "written";
      data = { issueUpdate: { success: true, issue: structuredClone(f.issue) } };
      await f.afterMutation?.();
    } else assert.fail(op);
    return { ok: true, json: async () => structuredClone({ data }) };
  };
  f.run = () => reconcilePrClose({ github: f.github, repo, number: 1, teamKey: "100", linearToken: "fixture-token", fetchImpl: f.fetch });
  return f;
}

for (const [name, prs, expected] of [
  ["single merged", [pr(1, { merged: true })], "team-done"],
  ["single closed unmerged", [pr()], "team-canceled"],
  ["multiple with any open", [pr(1, { merged: true }), pr(2, { state: "open" })], null],
  ["all closed with any merged", [pr(), pr(2, { merged: true })], "team-done"],
  ["all closed without merges", [pr(), pr(2)], "team-canceled"],
]) test(name, async () => {
  const f = fixture(prs), result = await f.run();
  assert.equal(result.operation, expected ? "updated" : "skipped");
  assert.deepEqual(f.writes, expected ? [{ id: "issue-id", stateId: expected }] : []);
});

test("duplicate delivery and already-correct state perform no extra write", async () => {
  const f = fixture([pr(1, { merged: true })]);
  assert.equal((await f.run()).operation, "updated");
  assert.equal((await f.run()).reason, "already-correct");
  assert.equal(f.writes.length, 1);
});

test("paginates all associations and workflow states; deduplicates cross-repository URLs", async () => {
  const other = pr(2, { html_url: "https://github.com/elsewhere/service/pull/2", base: { repo: { full_name: "elsewhere/service" } }, merged: true });
  const f = fixture([pr(), other]);
  f.linkPage = after => after ? connection(f.links) : connection(f.links, true, "links-next");
  f.attachmentPage = after => after ? connection([{ url: other.html_url }, { url: `${other.html_url}/files#diff` }])
    : connection([{ url: "https://github.com/OWNER/CLIENT/pull/1/" }], true, "attachments-next");
  f.statePage = after => after ? connection(states.slice(1)) : connection(states.slice(0, 1), true, "states-next");
  const result = await f.run();
  assert.equal(result.state, "Done");
  assert.equal(result.prs.length, 2);
  assert.equal(f.reads.filter(p => p.owner === "elsewhere").length, 3); // two snapshots + readback
  for (const op of ["CloseLinks", "CloseAttachments", "CloseStates"]) assert.ok(f.calls.some(c => c.op === op && c.after));
});

test("includes a triggering PR not yet attached and resolves title/branch fallback", async () => {
  const f = fixture([pr()]);
  f.links = [];
  f.attachments = [{ url: "https://example.org/design" }];
  const result = await f.run();
  assert.equal(result.state, "Canceled");
  assert.deepEqual(result.prs.map(p => p.url), [url]);
});

test("a manual attachment can resolve an issue without title or branch hints", async () => {
  const f = fixture([pr(1, { title: "Maintenance", head: { ref: "maintenance" } })]);
  assert.equal((await f.run()).state, "Canceled");
});

for (const [name, change, reason] of [
  ["missing association", f => { f.links = []; f.prs[0].title = "none"; f.prs[0].head.ref = "none"; }, /Missing Linear issue/],
  ["ambiguous association", f => { f.links.push({ issue: { id: "other", identifier: "100-110" } }); }, /Ambiguous/],
  ["conflicting branch", f => { f.prs[0].head.ref = "100-110"; }, /Ambiguous/],
  ["conflicting attachment", f => { f.issue.identifier = "100-110"; }, /disagrees/],
  ["wrong team", f => { f.issue.team.key = "OTHER"; }, /team mismatch/],
  ["missing merged field", f => { delete f.prs[0].merged; }, /Incomplete current PR/],
  ["unavailable cross-repository PR", f => { f.attachments.push({ url: "https://github.com/private/api/pull/2" }); }, /404/],
  ["missing attachment page", f => { f.attachmentPage = () => ({ nodes: [] }); }, /Incomplete/],
  ["repeated cursor", f => { f.linkPage = () => connection(f.links, true, "same"); }, /pagination/],
  ["unsupported PR host", f => { f.attachments.push({ url: "https://enterprise.example/a/b/pull/5" }); }, /Unsupported/],
  ["malformed PR URL", f => { f.attachments.push({ url: "https://github.com/a/b/pull/missing" }); }, /malformed/],
  ["missing state", f => { f.states = []; }, /workflow state/],
  ["ambiguous state", f => { f.states = [...states, { ...states[2], id: "other-canceled" }]; }, /workflow state/],
]) test(`${name} cannot infer a terminal transition`, async () => {
  const f = fixture(); change(f);
  const result = await f.run();
  assert.equal(result.operation, "failed");
  assert.match(result.reason, reason);
  assert.equal(f.writes.length, 0);
});

test("stale close event for a reopened PR leaves Linear alone", async () => {
  const f = fixture([pr(1, { state: "open" })]);
  assert.equal((await f.run()).reason, "associated-pr-open");
  assert.equal(f.writes.length, 0);
});

test("a PR reopening during the final snapshot stops the transition", async () => {
  const f = fixture();
  f.beforePr = () => { if (f.reads.length === 2) f.prs[0].state = "open"; };
  const result = await f.run();
  assert.equal(result.reason, "associated-pr-open");
  assert.equal(result.attempts, 2);
  assert.equal(f.writes.length, 0);
});

test("concurrent issue update retries associations and finds a newly attached open PR", async () => {
  const f = fixture();
  f.beforeLinear = op => {
    if (op === "CloseStates") {
      f.issue.updatedAt = "human-edit";
      const open = pr(2, { state: "open" });
      f.prs.push(open); f.attachments.push({ url: open.html_url });
    }
  };
  assert.equal((await f.run()).reason, "associated-pr-open");
  assert.ok(f.reads.some(p => p.pull_number === 2));
  assert.equal(f.writes.length, 0);
});

test("concurrent native merge integration already set Done; no duplicate mutation", async () => {
  const f = fixture([pr(1, { merged: true })]);
  f.beforeLinear = op => {
    if (op === "CloseStates") { f.issue.state = states[1]; f.issue.updatedAt = "native-merge"; }
  };
  assert.equal((await f.run()).reason, "already-correct");
  assert.equal(f.writes.length, 0);
});

test("sustained contention has a bounded retry limit", async () => {
  const f = fixture();
  f.beforeLinear = op => { if (op === "CloseStates") f.issue.updatedAt += "changed"; };
  const result = await f.run();
  assert.equal(result.reason, "concurrent-change-retry-limit");
  assert.equal(result.attempts, 3);
  assert.equal(f.writes.length, 0);
});

test("ambiguous mutation transport result is confirmed by fresh reads without rewriting", async () => {
  const f = fixture();
  f.afterMutation = () => { throw new Error("connection lost"); };
  assert.equal((await f.run()).reason, "confirmed-by-readback");
  assert.equal(f.writes.length, 1);
});

test("another writer after mutation is reported, not fought in a write loop", async () => {
  const f = fixture();
  f.afterMutation = () => { f.issue.state = states[0]; };
  const result = await f.run();
  assert.equal(result.operation, "failed");
  assert.match(result.reason, /Concurrent change after mutation/);
  assert.equal(f.writes.length, 1);
});

test("the existing close workflow runs the deterministic helper with only read GitHub permissions", async (t) => {
  const workflow = yaml.load(readFileSync(new URL("../cadence-ai-review-trigger.yml", import.meta.url), "utf8"));
  assert.ok(workflow.on.pull_request_target.types.includes("closed"));
  const job = workflow.jobs["reconcile-closed"];
  assert.equal(job.if, "github.event_name == 'pull_request_target' && github.event.action == 'closed'");
  assert.equal(job.needs, undefined);
  assert.equal(job.environment, undefined);
  assert.deepEqual(job.permissions, { contents: "read", "pull-requests": "read" });
  assert.deepEqual(job.concurrency, { group: "symphony-linear-wakeups-${{ github.repository }}", "cancel-in-progress": false, queue: "max" });
  const [checkout, step] = job.steps;
  assert.equal(checkout.with.repository, "1000lines/symphony-client-workflows");
  assert.equal(checkout.with.ref, "${{ inputs.helpers-ref || 'main' }}");
  assert.equal(checkout.with["persist-credentials"], false);
  assert.deepEqual(step.env, { LINEAR_API_TOKEN: "${{ secrets.CADENCE_LINEAR_API_TOKEN }}", GH_TOKEN: "${{ github.token }}" });
  const f = fixture([pr(1, { merged: true })]), revision = "a".repeat(40), blob = "b".repeat(40);
  const responses = {
    [`https://api.github.com/repos/${repo}`]: { id: 1, full_name: repo, owner: { login: "owner" }, default_branch: "main" },
    [`https://api.github.com/repos/${repo}/branches/main`]: { name: "main", commit: { sha: revision } },
    [`https://api.github.com/repos/${repo}/git/trees/${revision}`]: { truncated: false, tree: [{ path: ".symphony.cfg.json", type: "blob", mode: "100644", sha: blob }] },
    [`https://api.github.com/repos/${repo}/git/blobs/${blob}`]: { sha: blob, encoding: "base64", content: Buffer.from(JSON.stringify({ schemaVersion: "symphony-repository/v1", linear: { teamKey: "100" }, workingDirectory: ".", instructions: [], commands: {}, ci: { requiredChecks: [] } })).toString("base64") },
  };
  t.mock.method(globalThis, "fetch", async (endpoint, options) => responses[endpoint]
    ? { ok: true, json: async () => responses[endpoint] } : f.fetch(endpoint, options));
  let summary = "";
  const core = { info() {}, setFailed: assert.fail, summary: { addRaw(value) { summary += value; return this; }, async write() {} } };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction("github", "context", "core", "process", step.with.script)(f.github, {
    repo: { owner: "owner", repo: "client" }, payload: { pull_request: { number: 1, merged: false } },
    actor: "human", serverUrl: "https://github.com", runId: 123,
  }, core, { env: { GITHUB_WORKSPACE: fileURLToPath(new URL("../../../", import.meta.url)), GH_TOKEN: "github-fixture", LINEAR_API_TOKEN: "fixture-token", GITHUB_RUN_ATTEMPT: "1" } });
  assert.equal(f.issue.state.name, "Done"); // current API merged=true overrides stale payload
  assert.match(summary, /all-associated-prs-closed/);
  assert.match(summary, /actions\/runs\/123/);
  assert.equal(prReference(`${url}?tab=files#diff`).url, url);
});

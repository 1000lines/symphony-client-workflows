import assert from "node:assert/strict";
import test from "node:test";
import { acquireCandidates, createReaders, renderReport } from "./acquire.mjs";

const now = "2026-09-12T00:00:00Z", old = "2026-06-01T00:00:00Z";
const hash = "a".repeat(40), dates = { createdAt: old, updatedAt: old };
const clone = (value) => structuredClone(value);
function fixture() {
  const project = (id, code) => ({ id, name: code, description: "", content: `project-code: ${code}`, status: { name: "Completed", type: "completed" }, ...dates });
  const ticket = (id, identifier) => ({ id, identifier, description: "", archivedAt: null, project: { id: "p" }, state: { name: "Done", type: "completed" }, ...dates });
  const pr = (number, repo, issue) => ({ id: `${repo}#${number}`, number, url: `https://github.com/owner/${repo}/pull/${number}`, title: `[${issue}]: notes`, headRefName: `symphony/demo/${issue}/notes`, headRefOid: hash, baseRefName: "main", state: "MERGED", closedAt: old, mergedAt: old, ...dates });
  const mapping = (id, code, repository) => ({ projectId: id, code, source: { repository, path: "docs/plan.md", sha: hash }, pullRequests: [], repositories: [{ repository, baseBranch: "main", baseSha: hash, folder: `docs/symphony-plans/${code}/`, files: [{ path: `docs/symphony-plans/${code}/notes.md`, projectId: id, disposable: true }] }] });
  const ownership = [mapping("p", "demo", "owner/a")];
  ownership[0].repositories.push({ repository: "owner/b", baseBranch: "main", baseSha: hash, folder: null, files: [] });
  ownership[0].pullRequests.push("https://github.com/owner/a/pull/1");
  const data = {
    projects: [project("p", "demo"), project("q", "other")],
    tickets: { p: [ticket("t1", "TEAM-1"), { ...ticket("t2", "TEAM-2"), archivedAt: old }], q: [] },
    comments: { p: [], q: [], t1: [{ id: "c1", body: "https://github.com/OWNER/a/pull/1", ...dates }, { id: "c2", body: "bot activity", ...dates }], t2: [] },
    children: { c1: [{ id: "reply", body: "reply", ...dates }] },
    attachments: { t1: [{ id: "a1", url: "https://github.com/owner/a/pull/1" }, { id: "a2", url: "https://github.com/owner/b/pull/2" }], t2: [] },
    prs: { a: [pr(1, "a", "TEAM-1"), { ...pr(3, "a", "ELSE-3"), headRefName: "feature/unrelated" }], b: [pr(2, "b", "TEAM-2")], c: [] },
    prComments: [{ id: "pc1", ...dates }, { id: "pc2", ...dates }],
    reviews: [{ id: "r1", submittedAt: old, ...dates }, { id: "r2", submittedAt: old, ...dates }],
    inline: [{ id: "i1", ...dates }, { id: "i2", ...dates }],
    commits: [{ oid: hash, committedDate: old }, { oid: "b".repeat(40), committedDate: old }],
    tree: [
      ...["docs", "docs/symphony-plans", "docs/symphony-plans/demo", "docs/symphony-plans/other"].map((path) => ({ path, mode: "040000", type: "tree", sha: hash })),
      ...["demo", "other"].map((code) => ({ path: `docs/symphony-plans/${code}/notes.md`, mode: "100644", type: "blob", sha: hash })),
      { path: "docs/symphony-plans/accepted-plan.md", mode: "100644", type: "blob", sha: hash },
    ],
  };
  const calls = [], faults = {};
  const page = (key, values, after) => {
    calls.push({ key, after });
    if (faults.fail === key && after) throw new Error("private response must not leak");
    const index = after ? Number(after) : 0;
    const end = index + 1;
    return clone({ nodes: values.slice(index, end), totalCount: values.length,
      pageInfo: faults.noPageInfo === key ? undefined : { hasNextPage: end < values.length, endCursor: faults.loop === key ? "1" : String(end) } });
  };
  const readers = {
    async linear(query, { id, after }) {
      assert.match(query, /^query /);
      if (query.includes("first:100")) assert.match(query, /includeArchived:true/);
      if (query.includes("query CleanupProjects")) return { projects: page("projects", data.projects, after) };
      if (query.includes("query CleanupTicket")) return { issue: clone(Object.values(data.tickets).flat().find((item) => item.id === id)) };
      if (query.includes("query CleanupProject(")) return { project: clone(data.projects.find((item) => item.id === id)) };
      const parent = /\{ (project|issue|comment)\(id:/.exec(query)?.[1];
      const field = /\{ (issues|comments|children|attachments)\(first:/.exec(query)?.[1];
      assert.ok(parent && field, query);
      const values = field === "issues" ? data.tickets[id] : data[field][id] || [];
      return { [parent]: { [field]: page(`${id}:${field}`, values, after) } };
    },
    async github(query, { name, after, number, id }) {
      assert.match(query, /^query /);
      if (query.includes("node(id:")) return { node: { comments: page(`${id}:inline`, data.inline, after) } };
      const result = { nameWithOwner: `owner/${name}` };
      if (query.includes("on Blob")) result.object = { oid: hash };
      else if (query.includes("ref(qualifiedName:")) result.ref = { target: { oid: faults.base || hash, tree: { oid: hash } } };
      else if (query.includes("history(first:")) result.object = { history: page(`${name}:history`, data.commits, after) };
      else if (query.includes("pullRequests(first:")) {
        assert.match(query, /states:\[OPEN,CLOSED,MERGED\]/);
        result.pullRequests = page(`${name}:prs`, data.prs[name], after);
      } else if (query.includes("pullRequest(number:")) {
        const field = /\{(comments|reviews|commits)\(first:/.exec(query)?.[1];
        if (field) {
          const values = field === "comments" ? data.prComments : field === "reviews" ? data.reviews : data.commits.map((commit) => ({ commit }));
          result.pullRequest = { [field]: page(`${name}:${number}:${field}`, values, after) };
        } else {
          result.pullRequest = clone(data.prs[name].find((item) => item.number === number));
          if (faults.prChanged) result.pullRequest.updatedAt = now;
        }
      } else assert.fail(query);
      return { repository: result };
    },
    async tree() { return { tree: clone(data.tree), truncated: faults.truncated || false }; },
  };
  return { data, ownership, readers, calls, faults, mapping, run: () => acquireCandidates({ ownership, readers, now }) };
}

test("paginates archived projects/tickets, replies, attachments, PRs/reviews/comments and both commit histories", async () => {
  const f = fixture(), result = await f.run();
  const candidate = result.candidates[0];
  assert.deepEqual(candidate.eligibility.reasons, []);
  assert.equal(candidate.eligibility.kind, "clean");
  assert.equal(candidate.snapshot.tickets[1].archivedAt, old);
  assert.equal(candidate.snapshot.tickets[0].comments.length, 3);
  assert.equal(candidate.snapshot.pullRequests.length, 2);
  assert.deepEqual(candidate.snapshot.pullRequests[0].associations, ["TEAM-1", "accepted-plan", "branch-project", "branch-ticket", "title-ticket"]);
  assert.equal(candidate.snapshot.pullRequests[0].commits.length, 2);
  assert.equal(candidate.snapshot.pullRequests[0].reviews[1].comments.length, 2);
  assert.equal(candidate.snapshot.repositories[0].commits.length, 2);
  assert.equal(candidate.snapshot.repositories[1].folder, null);
  assert.ok(candidate.snapshot.evidence.every((item) => item.complete));
  assert.ok(f.calls.some((call) => call.key === "projects" && call.after));
  assert.ok(f.calls.some((call) => call.key === "p:issues" && call.after));
  assert.match(candidate.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.data.tickets.p[0].comments, undefined, "fixture source is not mutated");
});

test("an archived open ticket prevents clean end, and a recent bot reply prevents stale", async () => {
  const f = fixture();
  f.data.tickets.p[1].state = { type: "started", name: "Active" };
  assert.equal((await f.run()).candidates[0].eligibility.kind, "stale");
  f.data.children.c1[0].updatedAt = now;
  const result = await f.run();
  assert.equal(result.candidates[0].eligibility.kind, "excluded");
  assert.deepEqual(result.candidates[0].eligibility.reasons, ["recent-activity"]);
});

test("bare title and ordinary branch ticket identities find unlinked PRs without prefix collisions", async () => {
  const f = fixture();
  f.ownership[0].pullRequests = [];
  f.data.attachments.t1 = [];
  f.data.comments.t1 = [];
  f.data.prs.a[0].title = "Fix TEAM-1 documentation";
  f.data.prs.a[0].headRefName = "feature/notes";
  f.data.prs.b[0].title = "Update notes";
  f.data.prs.b[0].headRefName = "jeremy/team-2-update-notes";
  f.data.prs.a[1].title = "TEAM-10 is unrelated";
  assert.equal((await f.run()).candidates[0].snapshot.pullRequests.length, 2);
});

for (const resource of ["projects", "p:issues", "t1:comments", "t1:attachments", "a:prs", "a:1:comments", "a:1:reviews", "r1:inline", "a:1:commits", "a:history"]) {
  test(`failure on later ${resource} page cannot classify a partial result`, async () => {
    const f = fixture(); f.faults.fail = resource;
    f.ownership.push(f.mapping("q", "other", "owner/c"));
    const { candidates } = await f.run();
    assert.equal(candidates[0].eligibility.kind, "excluded");
    assert.equal(candidates[0].snapshot.complete, false);
    assert.ok(candidates[0].snapshot.evidence.some((item) => !item.complete));
    assert.equal(candidates[1].eligibility.kind, resource === "projects" ? "excluded" : "clean");
    assert.ok(!JSON.stringify(candidates).includes("private response"));
  });
}

test("missing pagination metadata, repeated cursors, duplicate identities and truncated trees fail closed", async () => {
  for (const kind of ["noPageInfo", "loop", "duplicate", "truncated"]) {
    const f = fixture();
    if (kind === "duplicate") f.data.tickets.p.push(clone(f.data.tickets.p[0]));
    else if (kind === "truncated") f.faults.truncated = true;
    else { f.faults[kind] = "p:issues"; f.data.tickets.p.push({ ...f.data.tickets.p[0], id: "t3" }); }
    assert.equal((await f.run()).candidates[0].eligibility.kind, "excluded", kind);
  }
});

for (const kind of ["duplicate-code", "foreign-link", "missing-PR", "ambiguous-branch", "changed-base", "changed-PR", "symlink", "unrelated-file", "nested-repo"]) {
  test(`${kind} excludes the project without affecting unrelated projects`, async () => {
    const f = fixture();
    f.ownership.push(f.mapping("q", "other", "owner/c"));
    if (kind === "duplicate-code") f.data.projects.push({ ...f.data.projects[0], id: "duplicate" });
    if (kind === "foreign-link") f.data.attachments.t1[0].url = "https://github.com/foreign/repo/pull/1";
    if (kind === "missing-PR") f.ownership[0].pullRequests.push("https://github.com/owner/a/pull/999");
    if (kind === "ambiguous-branch") f.data.prs.a[0].headRefName = "symphony/somebody-else/TEAM-1/notes";
    if (kind === "changed-base") f.ownership[0].repositories[0].baseSha = "b".repeat(40);
    if (kind === "changed-PR") f.faults.prChanged = true;
    if (kind === "symlink") f.data.tree[4].mode = "120000";
    if (kind === "nested-repo") { f.data.tree[4].mode = "160000"; f.data.tree[4].type = "commit"; }
    if (kind === "unrelated-file") f.data.tree.push({ path: "docs/symphony-plans/demo/app.js", mode: "100644", type: "blob", sha: hash });
    const { candidates } = await f.run();
    assert.equal(candidates[0].eligibility.kind, "excluded");
    assert.equal(candidates[1].eligibility.kind, "clean");
  });
}

test("invalid exact ownership stops repository acquisition", async () => {
  const f = fixture();
  f.ownership[0].repositories[0].folder = "docs/symphony-plans/demo/../other/";
  f.readers.github = () => assert.fail("unsafe paths must not reach GitHub");
  assert.equal((await f.run()).candidates[0].eligibility.kind, "excluded");
});

test("conflicting metadata on another project cannot hide a duplicate project code", async () => {
  const f = fixture();
  f.data.projects[1].content = "project-code: other\nproject-code: demo";
  assert.equal((await f.run()).candidates[0].eligibility.kind, "excluded");
});

test("report produces inert artifact and escaped Actions summary; fingerprint changes with activity", async () => {
  const f = fixture(), result = await f.run();
  const { artifact, summary } = renderReport(result);
  assert.deepEqual(JSON.parse(artifact), result);
  assert.match(summary, /Report only/);
  assert.ok(!Object.keys(result.candidates[0]).includes("actions"));
  f.data.prComments[0].updatedAt = now;
  assert.notEqual((await f.run()).candidates[0].fingerprint, result.candidates[0].fingerprint);
  result.candidates[0].identity.code = "<script>|bad\n";
  assert.ok(!renderReport(result).summary.includes("<script>"));
});

test("live transport issues query POSTs and tree GETs only, rejects mutations and missing credentials", async () => {
  const calls = [];
  const readers = createReaders({ linearToken: "fixture-linear", githubToken: "fixture-github", fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    return { ok: true, json: async () => options.method === "GET" ? { tree: [], truncated: false } : { data: { ok: true } } };
  } });
  await readers.linear("query Fixture { viewer { id } }", {});
  await readers.github("query Fixture { viewer { login } }", {});
  await readers.tree("owner/repo", hash);
  assert.deepEqual(calls.map((call) => call.method), ["POST", "POST", "GET"]);
  assert.ok(calls.every((call) => call.redirect === "error"));
  assert.throws(() => readers.linear("mutation { issueDelete(id:1) }", {}));
  await assert.rejects(createReaders({}).linear("query { viewer { id } }", {}), /credential/);
});

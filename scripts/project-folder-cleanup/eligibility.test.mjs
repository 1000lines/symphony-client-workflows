import assert from "node:assert/strict";
import test from "node:test";
import { classifyCandidate, DAY_MS, staleDays, timestamp } from "./eligibility.mjs";

const now = "2026-09-12T00:00:00Z";
const old = new Date(Date.parse(now) - 60 * DAY_MS).toISOString();
const recent = "2026-09-11T23:59:59Z";
const hash = "a".repeat(40);
const folder = "docs/symphony-plans/demo/";
const dates = { createdAt: old, updatedAt: old };
function fixture() {
  const repository = { repository: "owner/repo", baseBranch: "main", baseSha: hash, folder,
    files: [{ path: `${folder}notes.md`, projectId: "p", disposable: true }] };
  return {
    complete: true, uniqueCode: true, errors: [],
    ownership: { projectId: "p", code: "demo", source: { repository: "owner/repo", path: "docs/plan.md", sha: hash }, repositories: [repository] },
    project: { id: "p", content: "project-code: demo", status: { type: "completed" }, ...dates, comments: [] },
    tickets: [{ id: "t", identifier: "TEAM-1", project: { id: "p" }, state: { type: "completed" }, ...dates, comments: [{ id: "tc", ...dates }] }],
    pullRequests: [{ id: "pr", url: "https://github.com/owner/repo/pull/1", state: "MERGED", ...dates, closedAt: old, mergedAt: old,
      comments: [{ id: "pc", ...dates }], reviews: [{ id: "r", ...dates, submittedAt: old, comments: [{ id: "rc", ...dates }] }], commits: [{ oid: hash, committedDate: old }] }],
    repositories: [{ ...repository, truncated: false, entries: [
      ...["docs", "docs/symphony-plans", folder.slice(0, -1)].map((path) => ({ path, type: "tree", mode: "040000", sha: hash })),
      { path: `${folder}notes.md`, type: "blob", mode: "100644", sha: hash },
    ], commits: [{ oid: hash, committedDate: old }] }],
  };
}
const classify = (value, options = {}) => classifyCandidate(value, { now, ...options });

test("clean requires terminal project, every ticket and every PR; never mutates input", () => {
  const value = fixture(), before = structuredClone(value);
  assert.equal(classify(value).kind, "clean");
  assert.deepEqual(value, before);
  value.tickets[0].state.type = "started";
  value.tickets[0].updatedAt = recent;
  assert.deepEqual(classify(value).cleanEnd, { projectClosed: true, ticketsClosed: false, prsClosed: true });
  assert.equal(classify(value).kind, "excluded");
  value.tickets[0].updatedAt = old;
  assert.equal(classify(value).kind, "stale");
});

test("60-day inclusive boundary uses UTC elapsed time, with no clean-end age restriction", () => {
  const value = fixture();
  value.project.status.type = "started";
  assert.equal(classify(value).kind, "stale");
  assert.equal(classify(value, { now: "2026-09-11T19:00:00-05:00" }).kind, "stale");
  value.project.updatedAt = new Date(Date.parse(old) + 1).toISOString();
  assert.equal(classify(value).kind, "excluded");
  assert.equal(classify(value, { stale_days: 59 }).kind, "stale");
  value.project.status.type = "completed";
  value.project.updatedAt = recent;
  assert.equal(classify(value).kind, "clean");
});

for (const state of ["Done", "Completed", "Canceled", "Cancelled", "Duplicate"]) {
  test(`legacy terminal ticket name ${state} counts as closed`, () => {
    const value = fixture();
    value.tickets[0].state = { name: state };
    assert.equal(classify(value).kind, "clean");
  });
}

test("archiving never closes a ticket, official state type wins over its name", () => {
  const value = fixture();
  value.tickets[0].archivedAt = old;
  value.tickets[0].state = { name: "Done", type: "started" };
  assert.equal(classify(value).kind, "stale");
  value.project.status = { name: "Cancelled" };
  value.tickets[0].state = { name: "Duplicate" };
  assert.equal(classify(value).kind, "clean");
  value.project.status = { name: "Duplicate" };
  assert.equal(classify(value).kind, "excluded");
});

const activities = {
  "project creation": (v) => [v.project, "createdAt"],
  "project update": (v) => [v.project, "updatedAt"],
  "ticket creation": (v) => [v.tickets[0], "createdAt"],
  "ticket update": (v) => [v.tickets[0], "updatedAt"],
  "ticket comment creation": (v) => [v.tickets[0].comments[0], "createdAt"],
  "ticket comment edit": (v) => [v.tickets[0].comments[0], "updatedAt"],
  "PR creation": (v) => [v.pullRequests[0], "createdAt"],
  "PR update": (v) => [v.pullRequests[0], "updatedAt"],
  "PR closure": (v) => [v.pullRequests[0], "closedAt"],
  "PR merge": (v) => [v.pullRequests[0], "mergedAt"],
  "PR comment creation": (v) => [v.pullRequests[0].comments[0], "createdAt"],
  "PR comment edit": (v) => [v.pullRequests[0].comments[0], "updatedAt"],
  "review creation": (v) => [v.pullRequests[0].reviews[0], "createdAt"],
  "review edit": (v) => [v.pullRequests[0].reviews[0], "updatedAt"],
  "review submission": (v) => [v.pullRequests[0].reviews[0], "submittedAt"],
  "inline comment creation": (v) => [v.pullRequests[0].reviews[0].comments[0], "createdAt"],
  "inline comment edit": (v) => [v.pullRequests[0].reviews[0].comments[0], "updatedAt"],
  "PR commit": (v) => [v.pullRequests[0].commits[0], "committedDate"],
  "folder commit": (v) => [v.repositories[0].commits[0], "committedDate"],
};
for (const [name, select] of Object.entries(activities)) {
  test(`${name} contributes to max activity; missing or future evidence excludes even clean projects`, () => {
    const value = fixture();
    const [object, key] = select(value);
    value.project.status.type = "started";
    object[key] = recent;
    assert.equal(classify(value).kind, "excluded");
    assert.equal(classify(value).lastActivity, "2026-09-11T23:59:59.000Z");
    value.project.status.type = "completed";
    delete object[key];
    assert.equal(classify(value).kind, "excluded");
    object[key] = "2026-09-13T00:00:00Z";
    assert.equal(classify(value).kind, "excluded");
  });
}

test("open PR dates may be null, empty project falls back to creation and folder history", () => {
  const value = fixture();
  Object.assign(value.pullRequests[0], { state: "OPEN", closedAt: null, mergedAt: null });
  assert.equal(classify(value).kind, "stale");
  value.tickets = [];
  value.pullRequests = [];
  value.project.updatedAt = value.project.createdAt;
  assert.equal(classify(value).kind, "clean");
});

const unsafe = {
  "incomplete pages": (v) => { v.complete = false; },
  "duplicate code": (v) => { v.uniqueCode = false; },
  "unrecognized state": (v) => { v.project.status.type = "unknown"; },
  "inconsistent PR state": (v) => { v.pullRequests[0].state = "OPEN"; },
  "foreign ticket": (v) => { v.tickets[0].project.id = "other"; },
  "missing PR history": (v) => { v.pullRequests[0].commits = []; },
  "missing folder history": (v) => { v.repositories[0].commits = []; },
  "truncated tree": (v) => { v.repositories[0].truncated = true; },
  "changed base": (v) => { v.repositories[0].baseSha = "b".repeat(40); },
  "symlink": (v) => { v.repositories[0].entries[3].mode = "120000"; },
  "symlink ancestor": (v) => { Object.assign(v.repositories[0].entries[0], { mode: "120000", type: "blob" }); },
  "submodule": (v) => { Object.assign(v.repositories[0].entries[3], { mode: "160000", type: "commit" }); },
  "untracked folder": (v) => { v.repositories[0].entries = []; },
  "mixed ownership": (v) => { v.ownership.repositories[0].files[0].projectId = "other"; },
  "nondisposable file": (v) => { v.ownership.repositories[0].files[0].disposable = false; },
  "new unrelated file": (v) => { v.repositories[0].entries.push({ path: `${folder}application.js`, type: "blob", mode: "100644", sha: hash }); },
};
for (const [name, change] of Object.entries(unsafe)) {
  test(`${name} excludes only the candidate`, () => {
    const value = fixture(); change(value);
    assert.equal(classify(value).kind, "excluded");
    assert.equal(classify(fixture()).kind, "clean");
  });
}
for (const path of ["../demo/", "docs/symphony-plans/demo/../other/", ".github/", "src/", "docs/shared/", "docs/symphony-plans/design.md", "docs/symphony-plans/plan.mmd", "docs/symphony-plans/*/", "docs/symphony-plans/demo\\other/"]) {
  test(`ineligible path ${path}`, () => {
    const value = fixture(); value.ownership.repositories[0].folder = path;
    assert.equal(classify(value).kind, "excluded");
  });
}
for (const path of [`${folder}../outside.md`, `${folder}.git/config`, `${folder}%2e%2e/secret`, `${folder}nested/.GIT/config`]) {
  test(`unsafe member ${path}`, () => {
    const value = fixture(); value.ownership.repositories[0].files[0].path = path;
    assert.equal(classify(value).kind, "excluded");
  });
}

test("positive integer stale_days is the only option; timestamps need explicit valid timezones", () => {
  assert.equal(staleDays(), 60);
  assert.equal(staleDays("60"), 60);
  for (const invalid of [0, -1, 0.5, "0", "01", "1.5", "Infinity", NaN, true, null, Number.MAX_SAFE_INTEGER]) assert.throws(() => staleDays(invalid));
  for (const invalid of [null, undefined, "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-09-12", "2026-09-12T00:00:00", "2026-09-12T24:00:00Z"]) assert.ok(Number.isNaN(timestamp(invalid)));
});

test("absent snapshot fields exclude without throwing or treating absence as empty membership", () => {
  for (const value of [undefined, null, {}, { ownership: { repositories: [null, { repository: 42 }] } }]) assert.equal(classify(value).kind, "excluded");
});

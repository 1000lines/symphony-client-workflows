import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLinearIssue, readLinearTeamKey, wakeLinearIssue } from "./linear-issue-wakeup.mjs";

const state = (name) => ({ id: `state-${name}`, name });
const issue = ({
  current = "Inactive",
  states = ["Rework", "Active"],
} = {}) => ({
  id: "issue-id",
  identifier: "DEMO-118",
  state: state(current),
  team: { states: { nodes: states.map(state) } },
});
const jsonResponse = (data) => ({
  ok: true,
  status: 200,
  json: async () => ({ data }),
});
const options = { token: "linear-token" };

test("Active wins over legacy Rework and the mutation response supplies evidence", async () => {
  const requests = [];
  const result = await wakeLinearIssue({
    issue: issue(),
    ...options,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return jsonResponse({
        issueUpdate: {
          success: true,
          issue: { ...issue(), state: state("Active") },
        },
      });
    },
  });
  assert.deepEqual(requests[0].variables, {
    id: "issue-id",
    stateId: "state-Active",
  });
  assert.equal(result.previousState, "Inactive");
  assert.equal(result.state, "Active");
  assert.equal(result.fallback, "");
  assert.equal(result.mutation.success, true);
});

test("missing Active explicitly falls back to Rework", async () => {
  const result = await wakeLinearIssue({
    issue: issue({ states: ["Rework"] }),
    ...options,
    fetchImpl: async (_url, init) => {
      assert.equal(JSON.parse(init.body).variables.stateId, "state-Rework");
      return jsonResponse({
        issueUpdate: {
          success: true,
          issue: { ...issue(), state: state("Rework") },
        },
      });
    },
  });
  assert.equal(result.state, "Rework");
  assert.equal(result.fallback, "Active missing; using legacy Rework");
});

for (const current of ["Active", "Rework"]) {
  test(`already ${current} does not mutate`, async () => {
    const result = await wakeLinearIssue({
      issue: issue({ current, states: [current] }),
      ...options,
      fetchImpl: () => assert.fail("unexpected mutation"),
    });
    assert.equal(result.operation, "unchanged");
    assert.equal(result.state, current);
  });
}

for (const current of ["Canceled", "Cancelled", "Done", "Duplicate"]) {
  test(`terminal ${current} is preserved even if Active is absent`, async () => {
    const result = await wakeLinearIssue({
      issue: issue({ current, states: [] }),
      ...options,
      fetchImpl: () => assert.fail("unexpected mutation"),
    });
    assert.equal(result.operation, "skipped");
    assert.equal(result.skippedReason, `terminal-state:${current}`);
  });
}

test("renamed terminal state is protected by category", async () => {
  const source = issue({ current: "Stopped" });
  source.state.type = "canceled";
  const result = await wakeLinearIssue({
    issue: source,
    ...options,
    fetchImpl: () => assert.fail("unexpected mutation"),
  });
  assert.equal(result.skippedReason, "terminal-state:Stopped");
});

test("unknown target states fail closed instead of selecting any started state", async () => {
  await assert.rejects(
    wakeLinearIssue({
      issue: issue({ states: ["Happy", "In Review"] }),
      ...options,
      fetchImpl: () => assert.fail("unexpected mutation"),
    }),
    /no safe Active or legacy Rework/
  );
});

for (const update of [
  { success: false },
  { success: true, issue: { ...issue(), state: state("Inactive") } },
  {
    success: true,
    issue: { ...issue(), id: "other-issue", state: state("Active") },
  },
  { success: true, issue: { ...issue(), state: { id: "state-Active" } } },
]) {
  test(`rejects unconfirmed mutation: ${JSON.stringify(update)}`, async () => {
    await assert.rejects(
      wakeLinearIssue({
        issue: issue(),
        ...options,
        fetchImpl: async () => jsonResponse({ issueUpdate: update }),
      }),
      /did not confirm/
    );
  });
}

test("missing issue identifier fails without network access", async () => {
  await assert.rejects(
    readLinearIssue({
      ...options,
      fetchImpl: () => assert.fail("unexpected read"),
    }),
    /no linked Linear issue/
  );
});

test("missing credentials fail without network access", async () => {
  await assert.rejects(
    readLinearIssue({
      issueIdentifier: "DEMO-118",
      fetchImpl: () => assert.fail("unexpected read"),
    }),
    /Set LINEAR_API_TOKEN or LINEAR_API_KEY/
  );
});

for (const source of [
  null,
  { ...issue(), identifier: "DEMO-999" },
  { ...issue(), state: null },
]) {
  test(`missing or unresolved linked issue fails closed: ${JSON.stringify(
    source
  )}`, async () => {
    await assert.rejects(
      readLinearIssue({
        issueIdentifier: "DEMO-118",
        ...options,
        fetchImpl: async () => jsonResponse({ issue: source }),
      }),
      /not found or did not match|no current state/
    );
  });
}

test("API failures keep the HTTP error and redact credentials", async () => {
  await assert.rejects(
    readLinearIssue({
      issueIdentifier: "DEMO-118",
      ...options,
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        json: async () => ({ errors: [{ message: "linear-token denied" }] }),
      }),
    }),
    (error) => {
      assert.match(error.message, /HTTP 403/);
      assert.doesNotMatch(error.message, /linear-token/);
      return true;
    }
  );
});

test('team lookup reads the target repository root, not the helper or workflow file', t => {
  const root = mkdtempSync(join(tmpdir(), 'linear-team-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', root]);
  const child = join(root, 'src');
  mkdirSync(child);
  writeFileSync(join(root, 'WORKFLOW.md'), '---\ntracker:\n  team_key: WRONG\n---\n');
  assert.throws(() => readLinearTeamKey(child), /ENOENT/);
  const config = JSON.parse(readFileSync(new URL('../.symphony.cfg.json', import.meta.url), 'utf8'));
  const file = join(root, '.symphony.cfg.json');
  for (const teamKey of ['ENG', '100']) {
    config.linear = { teamKey };
    writeFileSync(file, JSON.stringify(config));
    assert.equal(readLinearTeamKey(child), teamKey);
  }
  for (const linear of [undefined, {}, { teamKey: 'eng' }, { teamKey: 100 }, { teamKey: 'ENG-15' }]) {
    config.linear = linear;
    writeFileSync(file, JSON.stringify(config));
    assert.throws(() => readLinearTeamKey(child), /configuration|linear.teamKey/);
  }
  writeFileSync(file, 'not json');
  assert.throws(() => readLinearTeamKey(child), SyntaxError);
});

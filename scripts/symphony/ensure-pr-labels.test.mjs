import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ensurePrLabels } from "./ensure-pr-labels.mjs";
import * as broker from "../test-fixtures/publication-app.mjs";

const repository = "Example/app";
const issueIdentifier = "TASK-42";
const pr = (number = 42, overrides = {}) => ({
  number,
  title: "[TASK-42]: repair labels",
  head: { ref: "symphony/demo/TASK-42/labels" },
  base: { ref: "main", repo: { full_name: repository } },
  ...overrides,
});
const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

function fixture({
  labels = [],
  pulls = [pr()],
  project = { content: "project-code: demo\nproject-color: blue" },
  attachments = { nodes: [], pageInfo: { hasNextPage: false } },
  readback,
  intercept = () => undefined,
} = {}) {
  let current = [...labels];
  let labelReads = 0;
  const requests = [];
  const env = {
    LINEAR_API_TOKEN: "linear-test-secret",
    GITHUB_TOKEN: "github-test-secret",
  };
  const fetchImpl = async (url, options) => {
    const request = {
      url: new URL(url),
      method: options.method,
      body: options.body && JSON.parse(options.body),
    };
    requests.push(request);
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, "error");
    const overridden = intercept(request, requests);
    if (overridden) return overridden;
    if (request.url.hostname === "api.linear.app") {
      assert.equal(options.headers.authorization, "linear-test-secret");
      assert.equal(request.method, "POST");
      assert.deepEqual(request.body.variables, { id: issueIdentifier });
      assert.doesNotMatch(request.body.query, /mutation/);
      return response({
        data: { issue: { identifier: issueIdentifier, project, attachments } },
      });
    }
    assert.equal(options.headers.authorization, "Bearer github-test-secret");
    assert.equal(request.url.hostname, "api.github.com");
    assert.ok(request.url.pathname.startsWith(`/repos/${repository}/`));
    const path = request.url.pathname.slice(`/repos/${repository}/`.length);
    if (path === "pulls") {
      assert.equal(request.method, "GET");
      assert.equal(request.url.searchParams.get("state"), "open");
      const page = Number(request.url.searchParams.get("page"));
      return response(pulls.slice((page - 1) * 100, page * 100));
    }
    if (path.startsWith("labels/")) {
      assert.equal(request.method, "GET");
      return response({
        name: decodeURIComponent(path.slice("labels/".length)),
      });
    }
    if (path === "issues/42/labels") {
      if (request.method === "POST") {
        current = [...new Set([...current, ...request.body.labels])];
      } else {
        assert.equal(request.method, "GET");
        labelReads++;
      }
      const page = Number(request.url.searchParams.get("page") || 1);
      return response(
        (labelReads > 1 && readback ? readback : current)
          .slice((page - 1) * 100, page * 100)
          .map((name) => ({
            name,
          }))
      );
    }
    assert.fail(`Unexpected request: ${request.method} ${url}`);
  };
  return {
    requests,
    env,
    fetchImpl,
    run: (overrides = {}) =>
      ensurePrLabels({
        issueIdentifier,
        repository,
        env,
        fetchImpl,
        ...overrides,
      }),
    writes: () =>
      requests.filter(
        ({ url, method }) =>
          url.hostname === "api.github.com" && method !== "GET"
      ),
    labels: () => current,
  };
}

for (const [name, labels, added] of [
  ["both absent", [], ["symphony", "blue"]],
  ["symphony absent", ["blue"], ["symphony"]],
  ["project color absent", ["symphony"], ["blue"]],
  ["both present", ["symphony", "blue"], []],
  [
    "unrelated labels present",
    ["bug", "project-required", "green"],
    ["symphony", "blue"],
  ],
  ["case insensitive existing labels", ["Symphony", "Blue"], []],
]) {
  test(`repairs only missing labels: ${name}`, async () => {
    const f = fixture({ labels });
    const result = await f.run();
    assert.deepEqual(result.added, added);
    assert.deepEqual(result.verified, ["symphony", "blue"]);
    assert.equal(result.result, added.length ? "repaired" : "already-correct");
    assert.deepEqual(f.labels(), [...labels, ...added]);
    assert.equal(f.writes().length, added.length ? 1 : 0);
    if (added.length) {
      assert.equal(
        f.writes()[0].url.pathname,
        "/repos/Example/app/issues/42/labels"
      );
      assert.deepEqual(f.writes()[0].body, { labels: added });
    }
    const beforeRerun = f.writes().length;
    assert.equal((await f.run()).result, "already-correct");
    assert.equal(f.writes().length, beforeRerun, "rerun must not mutate");
    assert.equal(
      f.requests.at(-1).method,
      "GET",
      "verify via separate readback"
    );
  });
}

test("no open PR succeeds before requiring project metadata", async () => {
  const f = fixture({ pulls: [], project: null });
  assert.equal((await f.run()).result, "no-open-pr");
  assert.equal(f.writes().length, 0);
});

test("required labels on a later label page are a no-op and unrelated labels survive", async () => {
  const labels = [
    ...Array.from({ length: 100 }, (_, i) => `label-${i}`),
    "symphony",
    "blue",
  ];
  const f = fixture({ labels });
  assert.equal((await f.run()).result, "already-correct");
  assert.equal(f.writes().length, 0);
  assert.deepEqual(f.labels(), labels);
});

test("mismatched Linear issue identity cannot edit a PR", async () => {
  const f = fixture({
    intercept: ({ url }) =>
      url.hostname === "api.linear.app"
        ? response({ data: { issue: { identifier: "TASK-43" } } })
        : undefined,
  });
  await assert.rejects(f.run, /does not match the requested issue/);
  assert.equal(f.writes().length, 0);
});

test("supports the existing token environment aliases", async () => {
  const f = fixture();
  assert.equal(
    (
      await f.run({
        env: {
          LINEAR_API_KEY: "linear-test-secret",
          GH_TOKEN: "github-test-secret",
        },
      })
    ).result,
    "repaired"
  );
});

test("exact issue matching ignores other tickets, body mentions and other repositories' attachments", async () => {
  const f = fixture({
    pulls: [
      pr(7, {
        title: "[TASK-420]: unrelated",
        head: { ref: "symphony/demo/TASK-420/work" },
        body: "Follow-up for TASK-42",
      }),
    ],
    attachments: {
      nodes: [{ url: "https://github.com/Other/app/pull/7" }],
      pageInfo: { hasNextPage: false },
    },
  });
  assert.equal((await f.run()).result, "no-open-pr");
  assert.equal(f.writes().length, 0);
});

test("Linear attachment verifies a PR on a nonstandard branch", async () => {
  const f = fixture({
    pulls: [pr(42, { title: "Repair labels", head: { ref: "label-fix" } })],
    attachments: {
      nodes: [{ url: "https://github.com/example/APP/pull/42#discussion" }],
      pageInfo: { hasNextPage: false },
    },
  });
  assert.equal((await f.run()).result, "repaired");
});

for (const [name, options, pattern] of [
  [
    "multiple PRs",
    { pulls: [pr(), pr(43)] },
    /Ambiguous issue\/PR association/,
  ],
  [
    "conflicting title",
    { pulls: [pr(42, { title: "[TASK-43]: other issue" })] },
    /conflicting issue\/PR association/,
  ],
  [
    "conflicting branch",
    { pulls: [pr(42, { head: { ref: "symphony/demo/TASK-43/work" } })] },
    /conflicting issue\/PR association/,
  ],
  [
    "title-only association",
    { pulls: [pr(42, { head: { ref: "unverified" } })] },
    /Unverified/,
  ],
  [
    "wrong target repository",
    { pulls: [pr(42, { base: { repo: { full_name: "Other/app" } } })] },
    /Unverified/,
  ],
  [
    "truncated attachments",
    { attachments: { nodes: [], pageInfo: { hasNextPage: true } } },
    /attachments are incomplete/,
  ],
  ["no project", { project: null }, /missing project-color/],
  [
    "missing color",
    { project: { content: "project-code: blue" } },
    /missing project-color/,
  ],
  [
    "conflicting content/description",
    {
      project: {
        content: "project-color: blue",
        description: "project-color: green",
      },
    },
    /ambiguous project-color/,
  ],
  [
    "conflicting declarations",
    { project: { content: "project-color: blue\nproject_color: green" } },
    /ambiguous project-color/,
  ],
  [
    "empty color",
    { project: { content: "project-color:" } },
    /invalid project-color/,
  ],
  [
    "invalid color",
    { project: { content: "project-color: ../../labels" } },
    /invalid project-color/,
  ],
]) {
  test(`rejects ${name} before writing`, async () => {
    const f = fixture(options);
    await assert.rejects(f.run, pattern);
    assert.equal(f.writes().length, 0);
  });
}

test("uses authoritative project metadata without restricting colors to a project-specific enum", async () => {
  const f = fixture({
    project: {
      description: "- project_color: `Amber`",
      content: "project-color: amber",
    },
  });
  assert.deepEqual((await f.run()).verified, ["symphony", "amber"]);
});

test("a linked PR with conflicting issue identity is not edited", async () => {
  const f = fixture({
    pulls: [pr(42, { title: "[TASK-43]: other", head: { ref: "unverified" } })],
    attachments: {
      nodes: [{ url: "https://github.com/Example/app/pull/42" }],
      pageInfo: { hasNextPage: false },
    },
  });
  await assert.rejects(f.run, /conflicting issue\/PR association/);
  assert.equal(f.writes().length, 0);
});

test("discovery checks subsequent pages before mutating", async () => {
  const unrelated = Array.from({ length: 99 }, (_, i) =>
    pr(i + 100, { title: "Unrelated", head: { ref: "other" } })
  );
  const f = fixture({ pulls: [pr(), ...unrelated, pr(43)] });
  await assert.rejects(f.run, /Ambiguous/);
  assert.equal(f.writes().length, 0);
  assert.equal(f.requests.at(-1).url.searchParams.get("page"), "2");
});

test("PR discovery has a bounded page limit and fails before mutation", async () => {
  const f = fixture({
    pulls: Array.from({ length: 1000 }, (_, i) => pr(i + 1)),
  });
  await assert.rejects(f.run, /List open PRs: pagination limit exceeded/);
  assert.equal(f.writes().length, 0);
  assert.equal(f.requests.length, 11);
});

test("nonexistent required label fails preflight without creating or partially applying labels", async () => {
  const f = fixture({
    intercept: ({ url }) =>
      url.pathname.endsWith("/labels/blue")
        ? response({ message: "github-test-secret" }, 404)
        : undefined,
  });
  await assert.rejects(f.run, /Verify required label blue exists: HTTP 404/);
  assert.equal(f.writes().length, 0);
});

for (const [phase, matches] of [
  ["Linear lookup", ({ url }) => url.hostname === "api.linear.app"],
  ["PR discovery", ({ url }) => url.pathname.endsWith("/pulls")],
  ["label read", ({ url }) => url.pathname.endsWith("/issues/42/labels")],
  ["label preflight", ({ url }) => url.pathname.endsWith("/labels/symphony")],
  [
    "label write",
    ({ url, method }) => url.hostname === "api.github.com" && method === "POST",
  ],
]) {
  test(`reports ${phase} API failure without secrets or retries`, async () => {
    let failures = 0;
    const f = fixture({
      intercept: (request) => {
        if (!matches(request)) return undefined;
        failures++;
        return response(
          { message: "linear-test-secret github-test-secret" },
          403
        );
      },
    });
    await assert.rejects(f.run, (error) => {
      assert.match(error.message, /HTTP 403/);
      assert.doesNotMatch(error.message, /test-secret/);
      return true;
    });
    assert.equal(failures, 1);
    assert.equal(f.writes().length, phase === "label write" ? 1 : 0);
  });
}

test("GraphQL errors and network failures omit response details", async () => {
  for (const intercept of [
    () => response({ errors: [{ message: "linear-test-secret" }] }),
    () => {
      throw new Error("github-test-secret");
    },
    () => ({
      ok: true,
      json: async () => {
        throw new Error("linear-test-secret");
      },
    }),
  ]) {
    const f = fixture({ intercept });
    await assert.rejects(f.run, (error) => {
      assert.match(
        error.message,
        /GraphQL API errors|request failed|invalid API JSON/
      );
      assert.doesNotMatch(error.message, /test-secret/);
      return true;
    });
    assert.equal(f.writes().length, 0);
  }
});

test("unsuccessful readback fails even after a successful POST", async () => {
  const f = fixture({ readback: ["symphony"] });
  await assert.rejects(f.run, /PR label readback failed/);
  assert.equal(f.writes().length, 1);
});

test("readback API failure is reported after the write", async () => {
  let reads = 0;
  const f = fixture({
    intercept: ({ url, method }) => {
      if (
        url.pathname.endsWith("/issues/42/labels") &&
        method === "GET" &&
        ++reads === 2
      )
        return response({}, 503);
    },
  });
  await assert.rejects(f.run, /Read PR labels: HTTP 503/);
  assert.equal(f.writes().length, 1);
});

test("invalid inputs and missing credentials fail without requests", async () => {
  for (const overrides of [
    { issueIdentifier: "bad/42" },
    { repository: "https://github.com/Example/app" },
    { env: {} },
  ]) {
    const f = fixture();
    await assert.rejects(() => f.run(overrides), /required/);
    assert.equal(f.requests.length, 0);
  }
});

const publish = {
  base: "main",
  head: "symphony/demo/TASK-42/labels",
  title: "[TASK-42]: labels",
  bodyFile: fileURLToPath(import.meta.url),
  assignee: "project-lead",
};
function appEnv(f, overrides = {}) {
  return {
    ...f.env,
    GH_TOKEN: "stale-legacy-token",
    SYMPHONY_GITHUB_AUTH_MODE: "app",
    SYMPHONY_GITHUB_APP_CONFIG: "bound-config",
    SYMPHONY_GITHUB_APP_AUTH: fileURLToPath(
      new URL("../test-fixtures/publication-app.mjs", import.meta.url)
    ),
    PUBLICATION_TEST_CONFIG: JSON.stringify({
      repository,
      appSlug: "symphony-app",
      appId: 7,
      installationId: 8,
      repositoryId: 9,
      permissions: { issues: "write", pull_requests: "write" },
      ...overrides,
    }),
  };
}

test("first App publication creates a draft with labels, repairs a lost label write, then repeats safely", async () => {
  const pulls = [];
  const f = fixture({ pulls, labels: ["bug"] });
  let creations = 0;
  const before = broker.preflights;
  const runGh = async (args, env) => {
    creations++;
    assert.deepEqual(args, [
      "pr",
      "create",
      "--repo",
      repository,
      "--draft",
      "--base",
      "main",
      "--head",
      publish.head,
      "--title",
      publish.title,
      "--body-file",
      publish.bodyFile,
      "--label",
      "symphony",
      "--label",
      "blue",
      "--assignee",
      "project-lead",
    ]);
    assert.equal(
      env.GH_TOKEN,
      "github-test-secret",
      "replace a stale legacy token"
    );
    assert.equal(
      f.requests.at(-1).url.pathname,
      `/repos/${repository}/labels/blue`
    );
    pulls.push(pr(42, { user: { login: "symphony-app[bot]" }, draft: true }));
    // Simulate gh returning successfully but labels not sticking.
  };
  const result = await f.run({ publish, env: appEnv(f), runGh });
  assert.equal(result.publication, "created");
  assert.equal(result.identity.login, "symphony-app[bot]");
  assert.deepEqual(result.verified, ["symphony", "blue"]);
  assert.deepEqual(f.labels(), ["bug", "symphony", "blue"]);
  const writes = f.writes().length;
  assert.equal(
    (await f.run({ publish, env: appEnv(f), runGh })).publication,
    "existing"
  );
  assert.equal(creations, 1);
  assert.equal(f.writes().length, writes);
  assert.equal(
    broker.preflights - before,
    2,
    "preflight even on a resumed workspace"
  );
});

test("closed legacy PR attachment permits a replacement; a project move during creation uses the new color", async () => {
  const pulls = [];
  const project = { content: "project-color: blue" };
  const f = fixture({
    pulls,
    project,
    labels: ["symphony", "blue", "bug"],
    attachments: {
      nodes: [{ url: `https://github.com/${repository}/pull/10` }],
      pageInfo: { hasNextPage: false },
    },
  });
  const result = await f.run({
    publish,
    env: appEnv(f),
    runGh: async (args) => {
      assert.ok(args.includes("blue"));
      project.content = "project-color: pink";
      pulls.push(pr(42, { user: { login: "symphony-app[bot]" } }));
    },
  });
  assert.deepEqual(result.verified, ["symphony", "pink"]);
  assert.deepEqual(f.labels(), ["symphony", "blue", "bug", "pink"]);
  project.content = "project-color: green";
  assert.deepEqual((await f.run()).verified, ["symphony", "green"]);
});

test("App publication fails before creating when the effective bound label grant is absent", async () => {
  const f = fixture({ pulls: [] });
  await assert.rejects(
    f.run({
      publish,
      env: appEnv(f, {
        permissions: { issues: "read", pull_requests: "write" },
      }),
      runGh: () => assert.fail("must not create"),
    }),
    /issues:write.*approve.*rebind/
  );
  assert.equal(f.requests.length, 0);
});

test("missing repository label blocks creation with the authorized setup handoff", async () => {
  const f = fixture({
    pulls: [],
    intercept: ({ url }) =>
      url.pathname.endsWith("/labels/blue") ? response({}, 404) : undefined,
  });
  await assert.rejects(
    f.run({ publish, runGh: () => assert.fail("must not create") }),
    /HTTP 404.*existing authorized.*setup/
  );
  assert.equal(f.writes().length, 0);
});

test("a successful creator without an associated PR is incomplete", async () => {
  const f = fixture({ pulls: [] });
  await assert.rejects(
    f.run({ publish, runGh: () => {} }),
    /publication incomplete.*no-open-pr/
  );
});

test("partial gh failure repairs labels and reports incomplete metadata without creating a duplicate", async () => {
  const pulls = [];
  const f = fixture({ pulls });
  await assert.rejects(
    f.run({
      publish,
      runGh: () => {
        pulls.push(pr());
        throw new Error("label failed");
      },
    }),
    /labels were repaired and verified.*metadata/
  );
  assert.deepEqual(f.labels(), ["symphony", "blue"]);
  await f.run({ publish, runGh: () => assert.fail("must not recreate") });
});

test("wrong App author and an open predecessor head block publication completion", async () => {
  const pulls = [];
  const f = fixture({ pulls });
  await assert.rejects(
    f.run({
      publish,
      env: appEnv(f),
      runGh: () => pulls.push(pr(42, { user: { login: "legacy-bot" } })),
    }),
    /App author readback/
  );
  pulls[0].head.ref = "symphony/demo/TASK-42/previous";
  await assert.rejects(
    f.run({ publish, runGh: () => assert.fail("must not create") }),
    /resolve or close the old PR/
  );
});

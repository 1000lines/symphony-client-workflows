import yaml from "js-yaml";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = yaml.load(
  readFileSync(
    new URL("../symphony-client-commands.yml", import.meta.url),
    "utf8"
  )
);
const step = workflow.jobs.commands.steps.find((step) => step.with?.script);
const AsyncFunction = Object.getPrototypeOf(async function () {
  return;
}).constructor;
const runScript = new AsyncFunction(
  "require",
  "core",
  "process",
  step.with.script
);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "client-commands-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "--initial-branch=trunk");
  writeFileSync(
    join(root, "input.txt"),
    "literal $value 'quoted'\nsecond line\n"
  );
  writeFileSync(
    join(root, "build.sh"),
    "set -eu\nmkdir -p output\ncat input.txt > output/built.txt\n"
  );
  writeFileSync(
    join(root, "test.sh"),
    "set -eu\ncmp input.txt output/built.txt\n"
  );
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "client fixture"
  );
  return { root, head: git("rev-parse", "HEAD") };
}

function run({ root, head }, commands, overrides = {}) {
  const summaries = [];
  return runScript(
    createRequire(import.meta.url),
    {
      summary: {
        addRaw: (text) => ({ write: async () => summaries.push(text) }),
      },
    },
    {
      env: {
        ...process.env,
        GITHUB_WORKSPACE: root,
        TESTED_REF: head,
        WORKING_DIRECTORY: ".",
        COMMANDS: JSON.stringify(commands),
        ...overrides,
      },
    }
  ).then(() => summaries);
}

test("native runner builds and tests a non-Node client with literal shell arguments", async (t) => {
  const target = fixture(t);
  const commands = [
    ["bash", "-lc", "bash build.sh"],
    ["bash", "-lc", "bash test.sh"],
    [
      "bash",
      "-lc",
      "printf '%s\\n' \"a 'quote' and \\\"double\\\"\" > output/quotes.txt",
    ],
  ];
  const summary = await run(target, commands);
  assert.equal(
    readFileSync(join(target.root, "output/quotes.txt"), "utf8"),
    "a 'quote' and \"double\"\n"
  );
  assert.match(
    summary.join("\n"),
    new RegExp(`Passed 3 commands at ${target.head}`)
  );
  assert.equal(
    readFileSync(join(target.root, "output/built.txt"), "utf8"),
    readFileSync(join(target.root, "input.txt"), "utf8")
  );
});

test("failed assertions and missing CI tools fail before subsequent commands", async (t) => {
  for (const command of [
    ["bash", "-lc", "exit 7"],
    ["missing-client-tool-10048"],
  ]) {
    const target = fixture(t);
    await assert.rejects(
      run(target, [command, ["bash", "-lc", "touch incorrectly-passed"]])
    );
    assert.throws(() => readFileSync(join(target.root, "incorrectly-passed")));
  }
});

test("runner rejects stale checkout, shell strings and paths outside the client", async (t) => {
  const target = fixture(t);
  await assert.rejects(
    run(target, [["true"]], { TESTED_REF: "a".repeat(40) }),
    /exact tested-ref/
  );
  await assert.rejects(
    run(target, ["echo accidentally split"]),
    /argument arrays/
  );
  symlinkSync(tmpdir(), join(target.root, "outside"));
  await assert.rejects(
    run(target, [["true"]], { WORKING_DIRECTORY: "outside" }),
    /inside the checkout/
  );
});

test("runner declares no supplied secrets, installs no package and checks the exact head", () => {
  assert.equal(workflow.on.workflow_call.secrets, undefined);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.match(workflow.jobs.commands.steps[0].with.ref, /inputs.tested-ref/);
  assert.equal(
    workflow.jobs.commands.steps[0].with["persist-credentials"],
    false
  );
  assert.ok(
    workflow.jobs.commands.steps.every((step) =>
      /@[a-f0-9]{40}/.test(step.uses)
    )
  );
  assert.doesNotMatch(
    JSON.stringify(workflow),
    /secrets\.|npm ci|package\.json|setup-node|continue-on-error/
  );
});

test("native workflow smoke commands execute with GitHub expression quoting", async (t) => {
  const target = fixture(t);
  const literal = step.env.COMMANDS.match(/\|\| '(.*)' }}/s)?.[1];
  assert.ok(literal);
  const commands = JSON.parse(literal.replaceAll("''", "'"));
  await run(target, commands);
  assert.equal(
    readFileSync(join(target.root, ".client-command-result"), "utf8"),
    "portable command fixture\n"
  );
});

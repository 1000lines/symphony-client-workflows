import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const axis = readFileSync(
  join(currentDir, "standing-docs-current-state.md"),
  "utf8"
);
const fixture = readFileSync(
  join(currentDir, "standing-docs-current-state.fixture.md"),
  "utf8"
);

const CLASSES = new Set(["blocker", "should-fix", "suggestion", "none"]);

function parseFixtureCases(markdown) {
  return markdown
    .split(/^## Case: /m)
    .slice(1)
    .map((caseBlock) => {
      const [id, ...lines] = caseBlock.split("\n");
      const block = lines.join("\n");
      const fields = Object.fromEntries(
        [...block.matchAll(/^- (?<key>[a-z-]+): (?<value>.+)$/gm)].map(
          ({ groups }) => [groups.key, groups.value]
        )
      );
      const body = block.match(/```md\n(?<body>[\s\S]*?)\n```/)?.groups?.body;

      assert.ok(fields.surface, `${id} has a surface`);
      assert.ok(CLASSES.has(fields.expected), `${id} has a known result`);
      assert.ok(body, `${id} has a Markdown body`);

      return { ...fields, body, id };
    });
}

// Fixture-locking heuristic only; Cadence validates the real prompt when wired.
function classifyCase({ body, surface }) {
  if (surface !== "standing-doc") return "none";

  const text = body.toLowerCase().replace(/\s+/g, " ");

  if (
    /\b(until then|will load|will wire|will install)\b/.test(text) ||
    /\b(after|once) (demo-\d+|ph-\d+|this pr) (lands|merges|is wired)\b/.test(
      text
    )
  ) {
    return "blocker";
  }

  if (
    /\btemporary\b|\btransitional\b/.test(text) ||
    /\b(during|after) [^.]*\b(migration|cleanup)\b/.test(text)
  ) {
    return "should-fix";
  }

  if (/\b(new|newly|recent|recently|now)\b/.test(text)) {
    return "suggestion";
  }

  return "none";
}

test("axis names the prompt, severities, examples, non-goals, and loading boundary", () => {
  for (const fragment of [
    "## Prompt",
    "## Severity",
    "## Examples",
    "## Non-Goals",
    "blocker",
    "should-fix",
    "suggestion",
    "human-needed",
    "PH-003",
    "source only",
    "runtime manifest wiring",
  ]) {
    assert.match(axis, new RegExp(fragment));
  }
});

test("fixture dry run classifies transition narrative by surface and severity", (t) => {
  const cases = parseFixtureCases(fixture);

  assert.deepEqual(new Set(cases.map(({ expected }) => expected)), CLASSES);
  assert.deepEqual(
    new Set(
      cases
        .filter(({ surface }) => surface !== "standing-doc")
        .map(({ surface }) => surface)
    ),
    new Set(["pr-body", "workpad"])
  );

  for (const fixtureCase of cases) {
    const actual = classifyCase(fixtureCase);
    t.diagnostic(`${fixtureCase.id} -> ${actual}`);
    assert.equal(actual, fixtureCase.expected, fixtureCase.id);
  }
});

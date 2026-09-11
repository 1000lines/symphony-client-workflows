#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const text = (value) =>
  typeof value === "string" && value.trim() !== "" && !value.includes("\0");
const relative = (value) =>
  text(value) &&
  !/^[\\/]|^[A-Za-z]:|\\/.test(value) &&
  !value.split("/").includes("..");
function requireThat(ok, message) {
  if (!ok) throw new Error(message);
}
function keys(value, allowed) {
  requireThat(
    object(value) && Object.keys(value).every((key) => allowed.includes(key)),
    "Unknown or invalid configuration fields"
  );
}

export function validateConfig(config) {
  keys(config, [
    "schemaVersion",
    "linear",
    "workingDirectory",
    "instructions",
    "commands",
    "ci",
  ]);
  requireThat(
    config.schemaVersion === "symphony-repository/v1",
    "Unsupported repository config schema"
  );
  requireThat(
    object(config.linear) &&
      typeof config.linear.teamKey === "string" &&
      /^[A-Z0-9]+$/.test(config.linear.teamKey),
    ".symphony.cfg.json requires linear.teamKey, e.g. 100 or ENG"
  );
  keys(config.linear, ["teamKey"]);
  requireThat(
    relative(config.workingDirectory),
    "workingDirectory must stay within the repository"
  );
  requireThat(
    Array.isArray(config.instructions) && config.instructions.every(relative),
    "Invalid instruction paths"
  );
  keys(config.commands, ["setup", "build", "test", "lint"]);
  requireThat(
    Object.values(config.commands).every(
      (commands) =>
        Array.isArray(commands) &&
        commands.every(
          (argv) => Array.isArray(argv) && argv.length > 0 && argv.every(text)
        )
    ),
    "Commands must be arrays of executable/argument arrays"
  );
  keys(config.ci, ["mode", "requiredChecks"]);
  requireThat(
    config.ci.mode === undefined ||
      ["native", "docker", "remote"].includes(config.ci.mode),
    "ci.mode must be native, docker, or remote"
  );
  requireThat(
    Array.isArray(config.ci.requiredChecks),
    "ci.requiredChecks must be an array"
  );
  const names = new Set();
  for (const check of config.ci.requiredChecks) {
    keys(check, ["name", "workflow", "appId"]);
    requireThat(
      text(check.name) && !names.has(check.name),
      "Missing or duplicate CI check name"
    );
    names.add(check.name);
    requireThat(
      relative(check.workflow) &&
        /^\.github\/workflows\/[^/]+\.ya?ml$/.test(check.workflow),
      "Invalid CI workflow path"
    );
    requireThat(
      Number.isSafeInteger(check.appId) && check.appId > 0,
      "CI check requires a verified App ID"
    );
  }
  return config;
}

export function inspectConfig(checkout, base) {
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
    }).trim();
  requireThat(text(base), "A selected base branch is required");
  git("check-ref-format", `refs/heads/${base}`);
  const revision = git(
    "rev-parse",
    "--verify",
    `refs/remotes/origin/${base}^{commit}`
  );
  requireThat(/^[a-f0-9]{40,64}$/.test(revision), "Invalid base commit");
  const entry = git("ls-tree", revision, "--", ".symphony.cfg.json");
  if (!entry) return { status: "missing", revision };
  requireThat(
    /^100644 blob |^100755 blob /.test(entry),
    "Repository config must be a regular file"
  );
  const config = validateConfig(
    JSON.parse(git("show", `${revision}:.symphony.cfg.json`))
  );
  return { status: "configured", revision, config };
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const [command, ...args] = process.argv.slice(2);
    let result;
    if (command === "inspect" && args.length === 2)
      result = inspectConfig(...args);
    else if (command === "validate" && args.length === 1) {
      validateConfig(JSON.parse(readFileSync(args[0], "utf8")));
      result = { status: "valid" };
    } else
      throw new Error(
        "Usage: config.mjs inspect CHECKOUT BASE_BRANCH | validate FILE"
      );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(
      error.status !== undefined || error instanceof SyntaxError
        ? "Cannot read valid repository config from the selected source"
        : error.message
    );
    process.exitCode = 1;
  }
}

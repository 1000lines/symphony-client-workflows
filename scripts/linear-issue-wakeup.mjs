// Shared Linear wakeup semantics for GitHub event bridges.
import { normalize } from "./github-actor-classification.mjs";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { validateConfig } from "./symphony/runtime-bundle/skills/symphony-repository/scripts/config.mjs";

export const readLinearTeamKey = (checkout = process.cwd()) => {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: checkout,
    encoding: "utf8",
  }).trim();
  const config = validateConfig(JSON.parse(readFileSync(join(root, ".symphony.cfg.json"), "utf8")));
  return config.linear.teamKey;
};

const ISSUE_QUERY = `query LinearWakeupIssue($id: String!) {
  issue(id: $id) {
    id
    identifier
    state { id name type }
    labels(first: 100) { nodes { id } pageInfo { hasNextPage } }
    team { states(first: 100) { nodes { id name type } } }
  }
}`;

export const redactToken = (message, token) =>
  token ? String(message).split(token).join("[REDACTED]") : String(message);

export const linearRequest = async ({
  query,
  variables,
  token,
  operation,
  fetchImpl = fetch,
}) => {
  if (!token) {
    throw new Error(
      "Set LINEAR_API_TOKEN or LINEAR_API_KEY for Linear wakeups."
    );
  }
  try {
    const response = await fetchImpl("https://api.linear.app/graphql", {
      method: "POST",
      headers: { authorization: token, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const payload = await response.json();
    if (!response.ok || payload?.errors?.length || !payload?.data) {
      throw new Error(
        `Linear API rejected ${operation} (HTTP ${
          response.status
        }): ${JSON.stringify(payload?.errors || payload)}`
      );
    }
    return payload.data;
  } catch (error) {
    throw new Error(redactToken(error.message, token));
  }
};

export const readLinearIssue = async ({ issueIdentifier, ...options }) => {
  if (!issueIdentifier) {
    throw new Error("PR has no linked Linear issue identifier.");
  }
  const data = await linearRequest({
    ...options,
    query: ISSUE_QUERY,
    variables: { id: issueIdentifier },
    operation: "read linked issue state",
  });
  if (!data.issue?.id || data.issue.identifier !== issueIdentifier) {
    throw new Error(
      `Linear issue "${issueIdentifier}" was not found or did not match.`
    );
  }
  if (!data.issue.state?.id || !data.issue.state?.name) {
    throw new Error(`Linear issue "${issueIdentifier}" has no current state.`);
  }
  return data.issue;
};

export const terminalStateReason = (state = {}) =>
  ["canceled", "cancelled", "done", "duplicate"].includes(
    normalize(state.name)
  ) || ["canceled", "completed", "duplicate"].includes(normalize(state.type))
    ? `terminal-state:${state.name}`
    : "";

export const wakeLinearIssue = async ({ issue, ...options }) => {
  const result = {
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    previousState: issue.state.name,
    state: issue.state.name,
    operation: "skipped",
    skippedReason: terminalStateReason(issue.state),
    fallback: "",
  };
  if (result.skippedReason) return result;

  // Review/CI wakeups on legacy teams historically use Rework. Never choose an
  // arbitrary started state (it could be a daemon or human-controlled state).
  const states = issue.team?.states?.nodes || [];
  const target = ["active", "rework"]
    .map((name) => states.find((state) => normalize(state.name) === name))
    .find(Boolean);
  if (!target?.id || terminalStateReason(target)) {
    throw new Error(
      `Linear team for ${issue.identifier} has no safe Active or legacy Rework workflow state.`
    );
  }
  if (normalize(target.name) !== "active") {
    result.fallback = `Active missing; using legacy ${target.name}`;
  }
  if (issue.state.id === target.id) {
    return {
      ...result,
      operation: "unchanged",
      skippedReason: "already-target-state",
    };
  }

  result.mutation = { issueId: issue.id, stateId: target.id, success: false };
  try {
    const data = await linearRequest({
      ...options,
      query: `mutation LinearWakeupIssueUpdate($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) {
        success
        issue { id identifier state { id name } }
      }
    }`,
      variables: { id: issue.id, stateId: target.id },
      operation: `move ${issue.identifier} to ${target.name}`,
    });
    const update = data.issueUpdate;
    if (
      !update?.success ||
      update.issue?.id !== issue.id ||
      update.issue?.identifier !== issue.identifier ||
      update.issue?.state?.id !== target.id ||
      normalize(update.issue?.state?.name) !== normalize(target.name)
    ) {
      throw new Error(
        `Linear API did not confirm ${issue.identifier} moved to ${target.name}.`
      );
    }
    return {
      ...result,
      operation: "updated",
      state: update.issue.state.name,
      mutation: { issueId: issue.id, stateId: target.id, success: true },
    };
  } catch (error) {
    // Keep the attempted mutation and fallback even when the API cannot
    // confirm the outcome. Callers must not report the requested state as fact.
    error.evidence = result;
    throw error;
  }
};

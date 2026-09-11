#!/usr/bin/env node
// Fetch a Linear issue's review context (description / acceptance criteria,
// comments, project) by identifier, with no external dependencies.
//
// Read-only: it only queries. It never comments on or transitions the issue —
// Linear write-back is a separate workflow. Like fetch-google-doc.mjs it runs
// with bare node both locally and on the GitHub runner, so the review reads
// Linear the same way in both places.
//
// Auth:   LINEAR_API_TOKEN (a Linear API token with read access).
// Usage:  node scripts/fetch-linear-issue.mjs <issue-identifier>   # e.g. DEMO-85
// Output: the issue's review context as Markdown on stdout.

const API_URL = "https://api.linear.app/graphql";

const QUERY = `query IssueContext($id: String!) {
  issue(id: $id) {
    identifier
    title
    url
    description
    state { name }
    project { name description content }
    comments { nodes { body createdAt user { name } } }
  }
}`;

const loadToken = () => {
  const token = process.env.LINEAR_API_TOKEN;
  if (!token) {
    throw new Error("Set LINEAR_API_TOKEN (a Linear API token with read access).");
  }
  return token;
};

const fetchIssue = async (identifier, token) => {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { authorization: token, "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { id: identifier } }),
  });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    throw new Error(`Linear API error: ${JSON.stringify(payload.errors || payload)}`);
  }
  if (!payload.data.issue) {
    throw new Error(`Linear issue "${identifier}" was not found.`);
  }
  return payload.data.issue;
};

const renderComments = (comments) =>
  (comments?.nodes || [])
    .map((c) => `- ${c.user?.name || "unknown"} (${c.createdAt}):\n\n${c.body}`)
    .join("\n\n");

const renderIssue = (issue) => {
  const project = issue.project;
  const projectText = project
    ? `${project.name}\n\n${project.content || project.description || ""}`
    : "(none)";
  return [
    `# ${issue.identifier}: ${issue.title}`,
    `State: ${issue.state?.name || "unknown"}`,
    `URL: ${issue.url}`,
    "",
    "## Description / Acceptance Criteria",
    issue.description || "(none)",
    "",
    "## Project",
    projectText,
    "",
    "## Comments",
    renderComments(issue.comments) || "(none)",
  ].join("\n");
};

const main = async () => {
  const identifier = process.argv[2];
  if (!identifier) {
    throw new Error("Usage: node scripts/fetch-linear-issue.mjs <issue-identifier>");
  }
  const issue = await fetchIssue(identifier, loadToken());
  process.stdout.write(`${renderIssue(issue)}\n`);
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

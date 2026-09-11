#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const ISSUE_PATTERN = /^[A-Z0-9]+-\d+$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ISSUE_QUERY = `query SymphonyPrLabels($id: String!) {
  issue(id: $id) {
    identifier
    project { content description }
    attachments(first: 100) {
      nodes { url }
      pageInfo { hasNextPage }
    }
  }
}`;

function projectColor(project) {
  // The general metadata helpers select the first value. Repair must reject
  // conflicting declarations, including conflicts between content/description.
  const colors = [project?.content, project?.description]
    .filter(Boolean)
    .join("\n")
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = /^\s*(?:[-*]\s+)?project[-_]color:\s*(.*?)\s*$/i.exec(line);
      if (!match) return [];
      return [match[1].replace(/^([`"'])(.*)\1$/, "$2").toLowerCase()];
    });
  if (!colors.length) {
    throw new Error("Owning Linear project is missing project-color metadata.");
  }
  if (new Set(colors).size !== 1) {
    throw new Error(
      "Owning Linear project has ambiguous project-color metadata."
    );
  }
  if (!/^[a-z][a-z0-9-]*$/.test(colors[0])) {
    throw new Error(
      "Owning Linear project has invalid project-color metadata."
    );
  }
  return colors[0];
}

function associatedPr(issue, repository, pulls) {
  const attached = new Set();
  for (const { url } of issue.attachments.nodes) {
    const match =
      /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(
        url
      );
    if (match?.[1].toLowerCase() === repository.toLowerCase()) {
      attached.add(Number(match[2]));
    }
  }
  const candidates = pulls
    .map((pr) => ({
      pr,
      branchIssue: /^symphony\/[^/]+\/([A-Z0-9]+-\d+)\/.+$/i
        .exec(pr.head?.ref)?.[1]
        ?.toUpperCase(),
      titleIssue: /^\[([A-Z0-9]+-\d+)\]:/i.exec(pr.title)?.[1]?.toUpperCase(),
    }))
    .filter(
      ({ pr, branchIssue, titleIssue }) =>
        attached.has(pr.number) ||
        branchIssue === issue.identifier ||
        titleIssue === issue.identifier
    );
  if (!candidates.length) return undefined;
  if (candidates.length !== 1) {
    throw new Error(
      "Ambiguous issue/PR association: multiple open PRs match the Linear issue."
    );
  }
  const { pr, branchIssue, titleIssue } = candidates[0];
  if (
    pr.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
    (branchIssue && branchIssue !== issue.identifier) ||
    (titleIssue && titleIssue !== issue.identifier) ||
    (!attached.has(pr.number) && branchIssue !== issue.identifier)
  ) {
    throw new Error(
      "Unverified or conflicting issue/PR association; refusing to edit labels."
    );
  }
  return pr;
}

export async function ensurePrLabels({
  issueIdentifier,
  repository,
  env = process.env,
  fetchImpl = fetch,
  appClient,
  publish,
  runGh = (args, childEnv) =>
    execFileSync("gh", args, {
      env: childEnv,
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    }),
}) {
  if (!ISSUE_PATTERN.test(issueIdentifier || "")) {
    throw new Error(
      "A valid Linear issue identifier is required (--issue TEAM-123)."
    );
  }
  if (!REPOSITORY_PATTERN.test(repository || "")) {
    throw new Error(
      "An explicit GitHub repository is required (--repo OWNER/REPO)."
    );
  }
  if (
    publish &&
    (!publish.base ||
      !publish.bodyFile ||
      !publish.title?.startsWith(`[${issueIdentifier}]:`) ||
      !publish.head?.match(/^symphony\/[^/]+\/([A-Z0-9]+-\d+)\/.+$/i) ||
      publish.head.split("/")[2].toUpperCase() !== issueIdentifier)
  ) {
    throw new Error(
      "Publication requires --base, --body-file, an issue-prefixed --title and this issue's Symphony --head."
    );
  }
  if (publish) await access(publish.bodyFile);
  const linearToken = env.LINEAR_API_TOKEN || env.LINEAR_API_KEY;
  const githubToken = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!["legacy", "app"].includes(env.SYMPHONY_GITHUB_AUTH_MODE || "legacy"))
    throw new Error("Invalid GitHub authentication mode.");
  const appMode =
    env.SYMPHONY_GITHUB_AUTH_MODE === "app" ||
    Boolean(appClient || env.SYMPHONY_GITHUB_APP_CONFIG);
  if (appMode && env.SYMPHONY_GITHUB_AUTH_MODE === "legacy")
    throw new Error(
      "App credentials conflict with legacy authentication mode."
    );
  if (!linearToken || (!appMode && !githubToken)) {
    throw new Error(
      "Linear and GitHub API tokens are required for PR label repair."
    );
  }
  let identity;
  let publicationEnv = env;
  if (appMode && !appClient) {
    if (!env.SYMPHONY_GITHUB_APP_AUTH)
      throw new Error(
        "Set SYMPHONY_GITHUB_APP_AUTH to the installed Symphony App broker; bind this repository before publishing."
      );
    const { createGitHubAppClient, loadAppConfig, getInstallationToken } =
      await import(pathToFileURL(env.SYMPHONY_GITHUB_APP_AUTH).href);
    const config = await loadAppConfig(env);
    if (config.repository.toLowerCase() !== repository.toLowerCase())
      throw new Error("App configuration repository mismatch.");
    if (publish) {
      if (
        config.permissions.issues !== "write" ||
        config.permissions.pull_requests !== "write"
      ) {
        throw new Error(
          `Symphony App ${config.appSlug} needs issues:write and pull_requests:write on ${repository}; ask the repository owner to approve the existing App installation and rebind this workspace.`
        );
      }
      // Force an identity/scope/grant readback on every publication, including
      // a fresh worker and a legacy workspace resumed with a cached token.
      const credential = await getInstallationToken({
        config,
        cacheDir: env.SYMPHONY_GITHUB_APP_CACHE,
        fetchImpl,
        forceRefresh: true,
      });
      identity = {
        login: `${config.appSlug}[bot]`,
        appId: config.appId,
        installationId: config.installationId,
        repositoryId: config.repositoryId,
        permissions: config.permissions,
      };
      publicationEnv = {
        ...env,
        GH_TOKEN: credential.token,
        GITHUB_TOKEN: credential.token,
      };
    }
    // Labels need PR read and Issues write only, not the worker's push grants.
    appClient = createGitHubAppClient({
      config: {
        ...config,
        permissions: { pull_requests: "read", issues: "write" },
      },
      cacheDir: env.SYMPHONY_GITHUB_APP_CACHE,
      fetchImpl,
    });
  }

  // Linear/legacy requests share this deadline. The App broker bounds its own
  // refresh/readback retry; the hosted hook also enforces its overall timeout.
  const signal = AbortSignal.timeout(publish ? 120_000 : 45_000);
  async function request(url, token, operation, body) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: body ? "POST" : "GET",
        headers: { authorization: token, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal,
        redirect: "error",
      });
    } catch {
      throw new Error(`${operation}: API request failed or timed out.`);
    }
    if (!response.ok) {
      throw new Error(`${operation}: HTTP ${response.status}.`);
    }
    try {
      return await response.json();
    } catch {
      throw new Error(`${operation}: invalid API JSON response.`);
    }
  }
  const github = async (path, operation, body) => {
    if (appMode) {
      const response = await appClient(`/${path}`, {
        method: body ? "POST" : "GET",
        body,
        ...(body
          ? {
              readback: async (read) => {
                const observed = await read(`/${path}?per_page=100`);
                const labels = await observed.clone().json();
                if (!Array.isArray(labels))
                  throw new Error("Invalid label write readback.");
                return body.labels.every((label) =>
                  labels.some((entry) => entry.name?.toLowerCase() === label)
                )
                  ? { applied: true, response: observed }
                  : { applied: false };
              },
            }
          : {}),
      });
      if (!response.ok)
        throw new Error(`${operation}: HTTP ${response.status}.`);
      try {
        return await response.json();
      } catch {
        throw new Error(`${operation}: invalid API JSON response.`);
      }
    }
    return request(
      `https://api.github.com/repos/${repository}/${path}`,
      `Bearer ${githubToken}`,
      operation,
      body
    );
  };
  async function githubList(path, operation) {
    const items = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await github(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
        operation
      );
      if (!Array.isArray(batch))
        throw new Error(`${operation}: invalid API response.`);
      items.push(...batch);
      if (batch.length < 100) return items;
    }
    throw new Error(
      `${operation}: pagination limit exceeded; results are incomplete.`
    );
  }
  const payload = await request(
    "https://api.linear.app/graphql",
    linearToken,
    "Read Linear issue/project",
    { query: ISSUE_QUERY, variables: { id: issueIdentifier } }
  );
  if (payload?.errors?.length) {
    throw new Error(
      "Read Linear issue/project: GraphQL API errors (response details omitted)."
    );
  }
  const issue = payload?.data?.issue;
  if (
    issue?.identifier !== issueIdentifier ||
    !Array.isArray(issue.attachments?.nodes)
  ) {
    throw new Error(
      "Linear issue lookup is missing or does not match the requested issue."
    );
  }
  if (issue.attachments.pageInfo?.hasNextPage !== false) {
    throw new Error(
      "Linear attachments are incomplete; issue/PR association may be ambiguous."
    );
  }

  const pr = associatedPr(
    issue,
    repository,
    await githubList("pulls?state=open", "List open PRs")
  );
  if (!pr && !publish)
    return { issue: issueIdentifier, repository, result: "no-open-pr" };
  const required = [...new Set(["symphony", projectColor(issue.project)])];
  async function verifyRepositoryLabels(labels) {
    for (const label of labels) {
      let existing;
      try {
        existing = await github(
          `labels/${encodeURIComponent(label)}`,
          `Verify required label ${label} exists`
        );
      } catch (error) {
        throw new Error(
          `${error.message} Repository ${repository} needs label '${label}'. Have the project lead use the existing authorized project/repository label setup, then rerun; do not expand worker grants or silently create labels.`
        );
      }
      if (existing?.name?.toLowerCase() !== label)
        throw new Error(
          `Verify required label ${label} exists: invalid API response.`
        );
    }
  }
  if (
    publish &&
    pr &&
    (pr.head.ref !== publish.head || pr.base.ref !== publish.base)
  ) {
    throw new Error(
      `Existing PR #${pr.number} uses a different head/base; resolve or close the old PR before publishing its replacement.`
    );
  }
  if (!pr) {
    await verifyRepositoryLabels(required);
    const args = [
      "pr",
      "create",
      "--repo",
      repository,
      "--draft",
      "--base",
      publish.base,
      "--head",
      publish.head,
      "--title",
      publish.title,
      "--body-file",
      publish.bodyFile,
      ...required.flatMap((label) => ["--label", label]),
      ...(publish.assignee ? ["--assignee", publish.assignee] : []),
    ];
    let creationFailed = false;
    try {
      await runGh(args, publicationEnv);
    } catch {
      creationFailed = true;
    }
    // gh can create a PR and fail while adding metadata. Resolve again before
    // any retry, and read current Linear metadata again after publication.
    const verified = await ensurePrLabels({
      issueIdentifier,
      repository,
      env,
      fetchImpl,
      appClient,
    });
    if (verified.result === "no-open-pr")
      throw new Error(
        `PR publication incomplete in ${repository}: no-open-pr after gh pr create; inspect App pull-request access and the pushed head before retrying.`
      );
    const created = associatedPr(
      issue,
      repository,
      await githubList("pulls?state=open", "Read published PR")
    );
    if (
      created?.head.ref !== publish.head ||
      created?.base.ref !== publish.base ||
      (identity && created.user?.login !== identity.login)
    ) {
      throw new Error(
        "Published PR head/base or App author readback did not match; publication is incomplete."
      );
    }
    if (creationFailed)
      throw new Error(
        `gh pr create failed after creating PR #${verified.pr}; labels were repaired and verified. Inspect remaining PR metadata/assignee before handoff; rerun safely on the same head.`
      );
    return {
      ...verified,
      publication: "created",
      ...(identity ? { identity } : {}),
    };
  }

  const labelsPath = `issues/${pr.number}/labels`;
  async function readLabels() {
    const labels = await githubList(labelsPath, "Read PR labels");
    if (labels.some((label) => typeof label.name !== "string")) {
      throw new Error("Read PR labels: invalid API response.");
    }
    return labels.map((label) => label.name.toLowerCase());
  }
  const before = await readLabels();
  const missing = required.filter((label) => !before.includes(label));
  // Check all missing labels before the additive write.
  await verifyRepositoryLabels(missing);
  if (missing.length) {
    try {
      await github(labelsPath, "Add missing PR labels", { labels: missing });
    } catch (error) {
      throw new Error(
        `${error.message} Could not label ${repository}#${pr.number}; verify the existing App installation's issues:write grant with the repository owner, then rerun and read back labels.`
      );
    }
  }
  const after = await readLabels();
  if (required.some((label) => !after.includes(label))) {
    throw new Error(
      "PR label readback failed: required symphony/project-color labels are missing."
    );
  }
  return {
    issue: issueIdentifier,
    repository,
    pr: pr.number,
    result: missing.length ? "repaired" : "already-correct",
    added: missing,
    verified: required,
    ...(publish
      ? { publication: "existing", ...(identity ? { identity } : {}) }
      : {}),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === "--publish" && !options.publish) options.publish = true;
    else if (
      [
        "--issue",
        "--repo",
        "--base",
        "--head",
        "--title",
        "--body-file",
        "--assignee",
      ].includes(name) &&
      !options[name] &&
      args[i + 1]
    )
      options[name] = args[++i];
    else
      throw new Error(
        "Usage: ensure-pr-labels.mjs --issue TEAM-123 --repo OWNER/REPO [--publish --base BRANCH --head BRANCH --title TITLE --body-file FILE --assignee LOGIN]"
      );
  }
  if (
    !options.publish &&
    Object.keys(options).some((name) => !["--issue", "--repo"].includes(name))
  )
    throw new Error(
      "Creation arguments require --publish; no PR was published."
    );
  console.info(
    JSON.stringify(
      await ensurePrLabels({
        issueIdentifier: options["--issue"],
        repository: options["--repo"],
        ...(options.publish
          ? {
              publish: {
                base: options["--base"],
                head: options["--head"],
                title: options["--title"],
                bodyFile: options["--body-file"],
                assignee: options["--assignee"],
              },
            }
          : {}),
      })
    )
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Symphony PR label repair: ${error.message}`);
    process.exitCode = 1;
  });
}

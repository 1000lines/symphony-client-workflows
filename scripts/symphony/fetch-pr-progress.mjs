#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { prUrl } from "./render-pr-progress.mjs";

export async function loadPlan(file, toolingRoot = process.env.SYMPHONY_TOOLING_ROOT) {
  if (!toolingRoot) throw new Error("Set SYMPHONY_TOOLING_ROOT to the reviewed tooling checkout");
  const module = await import(pathToFileURL(resolve(toolingRoot, "tools/symphony-dag/dist/projectManifest.js")));
  return module.parseProjectPlan(readFileSync(file, "utf8"));
}

export function issueRefs(plan, issueMap = {}) {
  return plan.manifest.nodes.map((node) => ({
    node,
    ref: issueMap[node.id] ?? node.issueId ?? node.existingIssue ??
      (/^[A-Z0-9]+-[0-9]+$/.test(node.payloadKey ?? "") ? node.payloadKey : null),
  }));
}

// Emit a read-only request for the injected tool (or the existing human-session transport).
// Aliases are positional, independent of plan IDs and hostile input strings.
export function progressQuery(plan, issueMap = {}) {
  const fields = issueRefs(plan, issueMap).flatMap(({ ref }, index) => ref ? [
    `  n${index}: issue(id: ${JSON.stringify(ref)}) { identifier state { name } attachments(first: 100) { nodes { url } pageInfo { hasNextPage } } }`,
  ] : []);
  return fields.length ? `query PrProgress {\n${fields.join("\n")}\n}\n` : "query PrProgress { viewer { id } }\n";
}

function githubPr(url) {
  return JSON.parse(execFileSync("gh", ["pr", "view", url, "--json", "url,title,headRefName,headRefOid,baseRefName,state,isDraft,mergedAt"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 }));
}

export async function fetchProgress(plan, response, { currentNode, currentPr, issueMap = {}, snapshotTime = new Date().toISOString(), readPr = githubPr } = {}) {
  if (!plan.graph.nodes.some((node) => node.id === currentNode)) throw new Error("Current node must be a plan graph ID");
  if (currentPr && !prUrl(currentPr)) throw new Error("Current PR must be a canonical GitHub PR URL");
  const snapshot = { graph: plan.graph, currentNode, snapshotTime, states: {}, prs: {}, warnings: [] };
  for (const [index, { node, ref }] of issueRefs(plan, issueMap).entries()) {
    const issue = response.data?.[`n${index}`];
    const errors = response.errors ?? [];
    const stateError = errors.some((error) => !error.path ||
      (error.path[0] === `n${index}` && (error.path.length === 1 || error.path[1] === "state")));
    snapshot.states[node.id] = !stateError && issue?.state?.name || "Unknown";
    if (!ref || snapshot.states[node.id] === "Unknown") snapshot.warnings.push(`${node.id}: state unavailable${!ref ? "; supply the commissioned issue mapping" : ""}.`);
    if (issue?.attachments?.pageInfo?.hasNextPage || errors.some((error) => error.path?.[0] === `n${index}` && error.path[1] === "attachments")) {
      snapshot.warnings.push(`${node.id}: PR attachments incomplete; verify remaining associations separately.`);
    }
    const candidates = [...new Set([
      ...(node.id === currentNode && currentPr ? [currentPr] : []),
      node.pr.url, ...(issue?.attachments?.nodes ?? []).map((attachment) => attachment.url),
    ].filter(Boolean))];
    const verified = [];
    for (const candidate of candidates) {
      const url = prUrl(candidate);
      if (!url) {
        // Non-PR attachments are normal; a declared PR URL must be usable.
        if (candidate === node.pr.url) snapshot.warnings.push(`${node.id}: invalid plan PR URL omitted.`);
        continue;
      }
      try {
        const pr = await readPr(url);
        const identifier = issue?.identifier ?? node.existingIssue;
        const associated = identifier && (pr.title.startsWith(`[${identifier}]:`) || pr.headRefName.split("/").includes(identifier.toLowerCase()) || pr.headRefName.split("/").includes(identifier));
        if (prUrl(pr.url) !== url || pr.baseRefName !== node.pr.base || !pr.headRefOid || !associated) throw new Error("Unverified association");
        verified.push({ url, rank: url === prUrl(currentPr) ? 0 : pr.state === "OPEN" ? 1 : pr.mergedAt ? 2 : 3 });
      } catch {
        snapshot.warnings.push(`${node.id}: PR lookup or association verification failed for ${url}.`);
      }
    }
    snapshot.prs[node.id] = verified.sort((a, b) => a.rank - b.rank || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0)).map((pr) => pr.url);
  }
  return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: {
      plan: { type: "string" }, "issue-map": { type: "string" }, query: { type: "boolean" },
      "linear-response": { type: "string" }, current: { type: "string" }, "current-pr": { type: "string" },
    } });
    if (!values.plan || (!values.query && (!values["linear-response"] || !values.current))) {
      throw new Error("Usage: fetch-pr-progress.mjs --plan PLAN.md [--issue-map MAP.json] --query | --linear-response RESPONSE.json --current NODE [--current-pr URL]");
    }
    const plan = await loadPlan(values.plan);
    const issueMap = values["issue-map"] ? JSON.parse(readFileSync(values["issue-map"], "utf8")) : {};
    if (values.query) process.stdout.write(progressQuery(plan, issueMap));
    else process.stdout.write(JSON.stringify(await fetchProgress(plan, JSON.parse(readFileSync(values["linear-response"], "utf8")), {
      issueMap, currentNode: values.current, currentPr: values["current-pr"],
    }), null, 2) + "\n");
  } catch (error) {
    console.error(error.code === "ERR_MODULE_NOT_FOUND" ? "Build the reviewed SYMPHONY_TOOLING_ROOT with npm ci and npm run symphony-dag:build" : error.message);
    process.exitCode = 1;
  }
}

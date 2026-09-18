import { createHash } from "node:crypto";
import { classifyCandidate, folderErrors, metadataCode, metadataCodes, ownershipErrors, staleDays, timestamp } from "./eligibility.mjs";

const pageInfo = "pageInfo { hasNextPage endCursor }";
const activity = "id createdAt updatedAt";
const projectFields = `${activity} name description content status { name type }`;
const ticketFields = `${activity} identifier description archivedAt project { id } state { name type }`;
const prFields = `${activity} number url title headRefName headRefOid baseRefName state closedAt mergedAt`;

// No credentials are read implicitly. Fixture readers and these live readers share
// the same query-only interface. Error responses never enter reports verbatim.
export function createReaders({ linearToken, githubToken, fetchImpl = fetch }) {
  const request = async (url, token, body) => {
    if (!token) throw new Error("Missing read credential");
    const response = await fetchImpl(url, {
      method: body ? "POST" : "GET", redirect: "error",
      headers: { authorization: token, "content-type": "application/json", accept: "application/vnd.github+json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`Read HTTP ${response.status}`);
    const result = await response.json();
    if (result.errors?.length) throw new Error("GraphQL read failed");
    return body ? result.data : result;
  };
  const query = (url, token) => (document, variables) => {
    if (!/^query\b/.test(document) || /\bmutation\b/.test(document)) throw new Error("Only queries are allowed");
    return request(url, token, { query: document, variables });
  };
  return {
    linear: query("https://api.linear.app/graphql", linearToken),
    github: query("https://api.github.com/graphql", githubToken ? `Bearer ${githubToken}` : null),
    tree: (repository, treeSha) => request(`https://api.github.com/repos/${repository}/git/trees/${treeSha}?recursive=1`, githubToken ? `Bearer ${githubToken}` : null),
  };
}

async function read(evidence, resource, fetchValue) {
  const receipt = { resource, complete: false };
  evidence.push(receipt);
  try {
    const value = await fetchValue();
    if (value === null || value === undefined) throw new Error();
    receipt.complete = true;
    return value;
  } catch {
    throw new Error(`unavailable:${resource}`);
  }
}

async function pages(evidence, resource, fetchPage) {
  const receipt = { resource, complete: false, pages: [] };
  evidence.push(receipt);
  const nodes = [], cursors = new Set(), ids = new Set();
  let after = null, expected;
  do {
    let connection;
    try { connection = await fetchPage(after); } catch { throw new Error(`unavailable:${resource}`); }
    const info = connection?.pageInfo;
    if (!Array.isArray(connection?.nodes) || typeof info?.hasNextPage !== "boolean") throw new Error(`incomplete:${resource}`);
    if (connection.totalCount !== undefined) {
      if (!Number.isSafeInteger(connection.totalCount) || (expected !== undefined && expected !== connection.totalCount)) throw new Error(`changed:${resource}`);
      expected = connection.totalCount;
    }
    for (const node of connection.nodes) {
      const id = node?.id || node?.oid || node?.commit?.oid;
      if (!id || ids.has(id)) throw new Error(`ambiguous-page:${resource}`);
      ids.add(id);
      nodes.push(node);
    }
    receipt.pages.push({ after, count: connection.nodes.length, ...info });
    if (!info.hasNextPage) break;
    if (!info.endCursor || cursors.has(info.endCursor) || connection.nodes.length === 0) throw new Error(`incomplete:${resource}`);
    cursors.add(info.endCursor);
    after = info.endCursor;
  } while (true);
  if (expected !== undefined && expected !== nodes.length) throw new Error(`incomplete:${resource}`);
  receipt.complete = true;
  receipt.count = nodes.length;
  return nodes;
}

function linearConnection(readers, evidence, parent, id, field, fields) {
  const query = `query CleanupLinearPage($id:String!,$after:String){ ${parent}(id:$id){ ${field}(first:100,after:$after,includeArchived:true){nodes {${fields}} ${pageInfo}}}}`;
  return pages(evidence, `linear:${parent}:${id}:${field}`, async (after) => (await readers.linear(query, { id, after }))?.[parent]?.[field]);
}

async function linearComments(readers, evidence, parent, id) {
  const all = new Map();
  const roots = await linearConnection(readers, evidence, parent, id, "comments", `${activity} body`);
  const pending = [...roots];
  for (let index = 0; index < pending.length; index++) {
    const comment = pending[index];
    if (all.has(comment.id)) {
      if (JSON.stringify(all.get(comment.id)) !== JSON.stringify(comment)) throw new Error("changed:linear-comment");
      continue;
    }
    all.set(comment.id, comment);
    pending.push(...await linearConnection(readers, evidence, "comment", comment.id, "children", `${activity} body`));
  }
  return [...all.values()];
}

// Declare only used GraphQL variables: GitHub rejects unused declarations.
function githubQuery(fields) {
  const types = { owner: "String!", name: "String!", after: "String", number: "Int!", expression: "String!", ref: "String!", path: "String!", id: "ID!" };
  const variables = [...new Set([...fields.matchAll(/\$(\w+)/g)].map((match) => match[1]))];
  return `query CleanupGitHub(${variables.map((key) => `$${key}:${types[key]}`).join(",")}) { ${fields} }`;
}

async function repoRead(readers, evidence, repo, label, fields, variables = {}) {
  const [owner, name] = repo.repository.split("/");
  const query = githubQuery(`repository(owner:$owner,name:$name){nameWithOwner ${fields}}`);
  return read(evidence, `github:${repo.repository}:${label}`, async () => {
    const result = (await readers.github(query, { owner, name, ...variables }))?.repository;
    if (result?.nameWithOwner?.toLowerCase() !== repo.repository.toLowerCase()) throw new Error();
    return result;
  });
}

async function githubConnection(readers, evidence, repo, number, field, fields) {
  const [owner, name] = repo.repository.split("/");
  const connection = `${field}(first:100,after:$after${field === "pullRequests" ? ",states:[OPEN,CLOSED,MERGED]" : ""}){totalCount nodes {${fields}} ${pageInfo}}`;
  const body = number ? `pullRequest(number:$number){${connection}}` : connection;
  const query = githubQuery(`repository(owner:$owner,name:$name){${body}}`);
  return pages(evidence, `github:${repo.repository}:${number || "all"}:${field}`, async (after) => {
    const result = (await readers.github(query, { owner, name, number, after }))?.repository;
    return number ? result?.pullRequest?.[field] : result?.[field];
  });
}

function prIdentity(value) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)(?:[/?#].*)?$/.exec(value);
  return match ? `${match[1].toLowerCase()}#${Number(match[2])}` : null;
}

function linkedPrs(tickets, ownership) {
  const links = new Map();
  const add = (url, source) => {
    const id = prIdentity(url);
    if (!id) throw new Error("ambiguous-pr-link");
    if (!ownership.repositories.some((repo) => repo.repository.toLowerCase() === id.split("#")[0])) throw new Error("unowned-associated-pr");
    if (!links.has(id)) links.set(id, new Set());
    links.get(id).add(source);
  };
  for (const url of ownership.pullRequests || []) add(url, "accepted-plan");
  for (const ticket of tickets) {
    const text = [ticket.description, ...ticket.comments.map((comment) => comment.body), ...ticket.attachments.map((attachment) => attachment.url)].join("\n");
    for (const match of text.matchAll(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+(?:[/?#][^\s<>)]*)?/g)) add(match[0], ticket.identifier);
  }
  return links;
}

async function acquireProject(readers, snapshot, projects) {
  const { ownership, evidence } = snapshot;
  const project = projects.find((item) => item.id === ownership.projectId);
  snapshot.uniqueCode = projects.filter((item) => metadataCodes(item).includes(ownership.code)).length === 1;
  if (!project || metadataCode(project) !== ownership.code || !snapshot.uniqueCode) throw new Error("ambiguous-project-identity");
  snapshot.project = { ...project, comments: await linearComments(readers, evidence, "project", project.id) };
  snapshot.tickets = await linearConnection(readers, evidence, "project", project.id, "issues", ticketFields);
  for (const ticket of snapshot.tickets) {
    ticket.comments = await linearComments(readers, evidence, "issue", ticket.id);
    ticket.attachments = await linearConnection(readers, evidence, "issue", ticket.id, "attachments", "id url");
  }
  const plan = await repoRead(readers, evidence, ownership.source, "accepted-plan", "object(expression:$expression){... on Blob {oid}}", { expression: `${ownership.source.sha}:${ownership.source.path}` });
  if (!plan.object?.oid) throw new Error("unavailable-accepted-plan");
  snapshot.planBlobSha = plan.object.oid;
  const links = linkedPrs(snapshot.tickets, ownership), found = new Set();
  const identifiers = new Set(snapshot.tickets.map((ticket) => ticket.identifier.toUpperCase()));
  for (const repo of ownership.repositories) {
    const base = await repoRead(readers, evidence, repo, "base", "ref(qualifiedName:$ref){target {... on Commit {oid tree {oid}}}}", { ref: `refs/heads/${repo.baseBranch}` });
    if (base.ref?.target?.oid !== repo.baseSha) throw new Error("reviewed-base-changed");
    const acquired = { repository: repo.repository, baseBranch: repo.baseBranch, baseSha: repo.baseSha, folder: repo.folder, entries: [], commits: [] };
    snapshot.repositories.push(acquired);
    if (repo.folder !== null) {
      const tree = await read(evidence, `github:${repo.repository}:tree:${repo.baseSha}`, () => readers.tree(repo.repository, base.ref.target.tree.oid));
      const ancestors = ["docs", "docs/symphony-plans", repo.folder.slice(0, -1)];
      acquired.truncated = tree.truncated;
      acquired.entries = tree.tree?.filter((entry) => ancestors.includes(entry.path) || entry.path.startsWith(repo.folder));
      const errors = folderErrors(repo, acquired);
      if (errors.length) throw new Error(errors.join(","));
      const [owner, name] = repo.repository.split("/");
      const query = githubQuery(`repository(owner:$owner,name:$name){object(expression:$expression){... on Commit {history(first:100,after:$after,path:$path){totalCount nodes {oid committedDate} ${pageInfo}}}}}`);
      acquired.commits = await pages(evidence, `github:${repo.repository}:folder-history`, async (after) => (await readers.github(query, { owner, name, expression: repo.baseSha, path: repo.folder, after }))?.repository?.object?.history);
    }
    const prs = await githubConnection(readers, evidence, repo, null, "pullRequests", prFields);
    for (const pr of prs) {
      const identity = prIdentity(pr.url);
      if (!identity || identity !== `${repo.repository.toLowerCase()}#${pr.number}`) throw new Error("ambiguous-pr-identity");
      const tokens = (value) => [...value.matchAll(/\b[A-Z0-9]+-\d+\b/gi)].map((match) => match[0].toUpperCase()).filter((id) => id !== ownership.code.toUpperCase());
      const titleTickets = tokens(pr.title), branchTickets = tokens(pr.headRefName);
      const branch = /^symphony\/([^/]+)\/([^/]+)(?:\/|$)/.exec(pr.headRefName);
      const sources = new Set(links.get(identity) || []);
      if (titleTickets.some((id) => identifiers.has(id))) sources.add("title-ticket");
      if (pr.title.includes(`[${ownership.code}]`)) sources.add("title-project");
      if (branch?.[1] === ownership.code) sources.add("branch-project");
      if (branchTickets.some((id) => identifiers.has(id))) sources.add("branch-ticket");
      if (!sources.size) continue;
      if ([...titleTickets, ...branchTickets].some((id) => !identifiers.has(id)) || (branch && branch[1] !== ownership.code)) throw new Error("ambiguous-pr-association");
      found.add(identity);
      pr.repository = repo.repository;
      pr.associations = [...sources].sort();
      pr.comments = await githubConnection(readers, evidence, repo, pr.number, "comments", activity);
      pr.reviews = await githubConnection(readers, evidence, repo, pr.number, "reviews", `${activity} submittedAt`);
      for (const review of pr.reviews) {
        const query = githubQuery(`node(id:$id){... on PullRequestReview {comments(first:100,after:$after){totalCount nodes {${activity}} ${pageInfo}}}}`);
        review.comments = await pages(evidence, `github:review:${review.id}:comments`, async (after) => (await readers.github(query, { id: review.id, after }))?.node?.comments);
      }
      pr.commits = (await githubConnection(readers, evidence, repo, pr.number, "commits", "commit {oid committedDate}")).map((item) => item.commit);
      const current = await repoRead(readers, evidence, repo, `pr:${pr.number}:readback`, `pullRequest(number:$number){${prFields}}`, { number: pr.number });
      if (Object.keys(current.pullRequest || {}).some((key) => current.pullRequest[key] !== pr[key]) || !current.pullRequest) throw new Error("changed:pull-request");
      snapshot.pullRequests.push(pr);
    }
    const currentBase = await repoRead(readers, evidence, repo, "base-readback", "ref(qualifiedName:$ref){target {oid}}", { ref: `refs/heads/${repo.baseBranch}` });
    if (currentBase.ref?.target?.oid !== repo.baseSha) throw new Error("changed:base");
  }
  if ([...links.keys()].some((key) => !found.has(key))) throw new Error("missing-associated-pr");
  for (const ticket of snapshot.tickets) {
    const query = `query CleanupTicket($id:String!){issue(id:$id){${ticketFields}}}`;
    const current = await read(evidence, `linear:issue:${ticket.id}:readback`, async () => (await readers.linear(query, { id: ticket.id }))?.issue);
    if (current.updatedAt !== ticket.updatedAt || current.project?.id !== project.id || JSON.stringify(current.state) !== JSON.stringify(ticket.state)) throw new Error("changed:ticket");
  }
  const current = await read(evidence, `linear:project:${project.id}:readback`, async () => (await readers.linear(`query CleanupProject($id:String!){project(id:$id){${projectFields}}}`, { id: project.id }))?.project);
  if (JSON.stringify(current) !== JSON.stringify(project)) throw new Error("changed:project");
  snapshot.complete = true;
}

export async function acquireCandidates({ ownership, readers, now, stale_days = 60 }) {
  const days = staleDays(stale_days);
  if (!Number.isFinite(timestamp(now))) throw new Error("now must be an ISO timestamp with timezone");
  if (!Array.isArray(ownership)) throw new Error("Reviewed ownership records are required");
  const evidence = [];
  let projects = [], inventoryError;
  try {
    const query = `query CleanupProjects($after:String){projects(first:100,after:$after,includeArchived:true){nodes {${projectFields}} ${pageInfo}}}`;
    projects = await pages(evidence, "linear:projects:including-archived", async (after) => (await readers.linear(query, { after }))?.projects);
  } catch (error) { inventoryError = error.message; }
  const candidates = [];
  for (const record of ownership) {
    const mapping = record && typeof record === "object" ? record : {};
    const snapshot = { ownership: structuredClone(mapping), complete: false, uniqueCode: false, tickets: [], pullRequests: [], repositories: [], evidence: structuredClone(evidence), errors: ownershipErrors(mapping) };
    if (ownership.filter((other) => other?.projectId === mapping.projectId || other?.code === mapping.code).length !== 1) snapshot.errors.push("ambiguous-ownership-records");
    if (inventoryError) snapshot.errors.push(inventoryError);
    if (!snapshot.errors.length) {
      try { await acquireProject(readers, snapshot, projects); } catch (error) { snapshot.errors.push(error.message); }
    }
    const eligibility = classifyCandidate(snapshot, { now, stale_days: days });
    const identity = { projectId: mapping.projectId, code: mapping.code };
    // Receipt covers membership and activity; observation time stays outside it.
    const fingerprint = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    candidates.push({ identity, eligibility, fingerprint, snapshot });
  }
  return { schema: "project-folder-cleanup/v1", observedAt: now, stale_days: days, candidates };
}

export function renderReport(report) {
  const escape = (text) => String(text ?? "unknown").replace(/[&<>|`\r\n]/g, (char) => `&#${char.charCodeAt(0)};`);
  return {
    artifact: `${JSON.stringify(report, null, 2)}\n`,
    summary: ["## Project folder cleanup dry run", "", `Observed: ${escape(report.observedAt)}; stale threshold: ${report.stale_days} days.`, "", "| Project | Classification | Last activity | Reasons |", "| --- | --- | --- | --- |", ...report.candidates.map(({ identity, eligibility }) => `| ${escape(identity.code)} | ${eligibility.kind} | ${escape(eligibility.lastActivity)} | ${escape(eligibility.reasons.join(", "))} |`), "", "Report only. Execution requires protected human approval and fresh acquisition.", ""].join("\n"),
  };
}

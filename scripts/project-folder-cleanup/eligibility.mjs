// Pure classification of an acquired snapshot. Results are evidence, not commands.
export const DAY_MS = 86_400_000;
const list = (value) => Array.isArray(value) ? value : [];
export const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
export const repositoryName = (value) => typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
export const projectCode = (value) => typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
export const safePath = (value) => typeof value === "string" && value.length > 0 &&
  !/[\\\x00-\x1f\x7f:%*?\[\]]/.test(value) &&
  value.split("/").every((part) => part && ![".", "..", ".git"].includes(part.toLowerCase()));

export function staleDays(value = 60) {
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value <= 0 || !Number.isSafeInteger(value * DAY_MS))
    throw new Error("stale_days must be a positive integer number of days");
  return value;
}

// Require an explicit timezone and reject dates that Date.parse silently normalizes.
export function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return NaN;
  const date = value.slice(0, 10);
  const calendar = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== date || /T24:/.test(value)) return NaN;
  return Date.parse(value);
}

export const metadataCodes = (project) => [...`${project.description || ""}\n${project.content || ""}`.matchAll(/^project-code:[ \t]*([^\s]+)[ \t]*$/gm)].map((match) => match[1]);
export function metadataCode(project) {
  const codes = metadataCodes(project);
  return codes.length === 1 && projectCode(codes[0]) ? codes[0] : null;
}

export function terminal(state, kind) {
  const raw = state?.type || state?.name || "";
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const closed = ["completed", "complete", "done", "canceled", "cancelled"];
  if (kind === "ticket") closed.push("duplicate");
  if (closed.includes(value)) return true;
  if (["backlog", "planned", "unstarted", "started", "paused", "active", "inactive", "unhappy", "evaluating", "todo", "in progress", "rework", "in review", "waiting for ci", "human input needed"].includes(value)) return false;
  return null;
}

export function ownershipErrors(ownership) {
  const errors = [];
  const { projectId, code, source, repositories } = ownership || {};
  if (!projectId || !projectCode(code)) errors.push("invalid-project-identity");
  if (!repositoryName(source?.repository) || !safePath(source?.path) || !sha(source?.sha)) errors.push("missing-accepted-plan-source");
  if (!Array.isArray(repositories) || repositories.length === 0) return [...errors, "missing-owned-repositories"];
  if (!repositories.some((repo) => repo?.folder)) errors.push("missing-disposable-folder");
  const names = new Set();
  for (const repo of repositories) {
    if (!repo || typeof repo !== "object") { errors.push("invalid-owned-repository"); continue; }
    const name = typeof repo.repository === "string" ? repo.repository.toLowerCase() : null;
    if (!repositoryName(repo.repository) || names.has(name)) errors.push("ambiguous-repository-ownership");
    names.add(name);
    if (!repo.baseBranch || !sha(repo.baseSha)) errors.push("missing-reviewed-base");
    if (repo.folder === null && Array.isArray(repo.files) && repo.files.length === 0) continue;
    if (repo.folder !== `docs/symphony-plans/${code}/`) errors.push("unsafe-folder");
    if (!Array.isArray(repo.files) || repo.files.length === 0) { errors.push("missing-disposable-membership"); continue; }
    const paths = new Set();
    for (const file of repo.files) {
      if (!file || typeof file !== "object") { errors.push("unsafe-or-mixed-membership"); continue; }
      if (!safePath(file.path) || !file.path.startsWith(repo.folder) || paths.has(file.path) || file.projectId !== projectId || file.disposable !== true)
        errors.push("unsafe-or-mixed-membership");
      paths.add(file.path);
    }
  }
  return [...new Set(errors)];
}

export function folderErrors(expected, actual) {
  if (!expected || typeof expected !== "object") return ["invalid-owned-repository"];
  if (!actual || actual.repository !== expected.repository || actual.baseBranch !== expected.baseBranch || actual.baseSha !== expected.baseSha || actual.folder !== expected.folder)
    return ["base-or-folder-mismatch"];
  if (expected.folder === null) return [];
  if (typeof expected.folder !== "string") return ["unsafe-folder"];
  if (actual.truncated !== false || !Array.isArray(actual.entries)) return ["incomplete-tree"];
  const folder = expected.folder.slice(0, -1);
  const parts = folder.split("/");
  const ancestors = parts.map((_, index) => parts.slice(0, index + 1).join("/"));
  const entries = actual.entries;
  const paths = new Set();
  for (const entry of entries) {
    if (!entry || !safePath(entry.path) || !sha(entry.sha) || paths.has(entry.path)) return ["unsafe-tree"];
    paths.add(entry.path);
    if (entry.type === "tree" && entry.mode === "040000") continue;
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) return ["symlink-or-nested-repository"];
    if (ancestors.includes(entry.path)) return ["unsafe-ancestor"];
  }
  if (ancestors.some((path) => !entries.some((entry) => entry.path === path && entry.type === "tree"))) return ["untracked-folder"];
  const files = entries.filter((entry) => entry.type === "blob").map((entry) => entry.path).sort();
  const owned = list(expected.files).map((file) => file?.path).sort();
  if (JSON.stringify(files) !== JSON.stringify(owned)) return ["folder-membership-changed"];
  if (entries.some((entry) => !ancestors.includes(entry.path) && !entry.path.startsWith(expected.folder))) return ["unrelated-tree-entry"];
  return [];
}

export function classifyCandidate(snapshot = {}, { now, stale_days = 60 } = {}) {
  snapshot ||= {};
  const days = staleDays(stale_days);
  const nowMs = timestamp(now);
  if (!Number.isFinite(nowMs)) throw new Error("now must be an ISO timestamp with timezone");
  const reasons = [...list(snapshot.errors), ...ownershipErrors(snapshot.ownership)];
  if (snapshot.complete !== true) reasons.push("incomplete-acquisition");
  const { project, tickets, pullRequests, repositories, ownership } = snapshot;
  if (!project || project.id !== ownership?.projectId || metadataCode(project) !== ownership?.code || snapshot.uniqueCode !== true) reasons.push("ambiguous-project-identity");
  if (![tickets, pullRequests, repositories].every(Array.isArray)) reasons.push("missing-membership");
  for (const repo of list(ownership?.repositories)) reasons.push(...folderErrors(repo, list(repositories).find((item) => item?.repository === repo?.repository)));
  if (repositories?.length !== ownership?.repositories?.length) reasons.push("repository-membership-mismatch");
  let last = -Infinity;
  const record = (value, source) => {
    const ms = timestamp(value);
    if (!Number.isFinite(ms)) reasons.push(`missing-or-invalid-timestamp:${source}`);
    else if (ms > nowMs) reasons.push(`future-timestamp:${source}`);
    else last = Math.max(last, ms);
  };
  const activity = (object, source) => {
    record(object?.createdAt, `${source}:createdAt`);
    record(object?.updatedAt, `${source}:updatedAt`);
  };
  const comments = (items, source) => {
    if (!Array.isArray(items)) reasons.push(`missing-comments:${source}`);
    else items.forEach((item) => activity(item, `${source}:${item?.id}`));
  };
  activity(project, "project");
  comments(project?.comments, "project");
  const projectClosed = terminal(project?.status, "project");
  if (projectClosed === null) reasons.push("unknown-project-state");
  let ticketsClosed = true;
  for (const ticket of list(tickets)) {
    if (!ticket) { reasons.push("missing-ticket"); continue; }
    if (!ticket.id || !ticket.identifier || ticket.project?.id !== project?.id) reasons.push("ambiguous-ticket-membership");
    activity(ticket, ticket.identifier);
    comments(ticket.comments, ticket.identifier);
    const closed = terminal(ticket.state, "ticket");
    if (closed === null) reasons.push("unknown-ticket-state");
    ticketsClosed &&= closed === true;
  }
  let prsClosed = true;
  for (const pr of list(pullRequests)) {
    if (!pr) { reasons.push("missing-pr"); continue; }
    activity(pr, pr.url);
    if (!["OPEN", "CLOSED", "MERGED"].includes(pr.state)) reasons.push("unknown-pr-state");
    if ((pr.state === "OPEN" && (pr.closedAt !== null || pr.mergedAt !== null)) || (pr.state === "CLOSED" && pr.mergedAt !== null)) reasons.push("inconsistent-pr-state");
    if (pr.state !== "OPEN" || pr.closedAt !== null) record(pr.closedAt, `${pr.url}:closedAt`);
    if (pr.state === "MERGED" || pr.mergedAt !== null) record(pr.mergedAt, `${pr.url}:mergedAt`);
    comments(pr.comments, pr.url);
    comments(pr.reviews, `${pr.url}:reviews`);
    for (const review of list(pr.reviews)) {
      if (!review) { reasons.push("missing-review"); continue; }
      if (review.submittedAt !== null) record(review.submittedAt, `${review.id}:submittedAt`);
      comments(review.comments, review.id);
    }
    if (!Array.isArray(pr.commits) || !pr.commits.length) reasons.push("missing-pr-commits");
    else pr.commits.forEach((commit) => record(commit?.committedDate, `${commit?.oid}:committedDate`));
    prsClosed &&= ["CLOSED", "MERGED"].includes(pr.state);
  }
  for (const repo of list(repositories)) {
    if (!repo) { reasons.push("missing-repository"); continue; }
    if (repo.folder === null) continue;
    if (!Array.isArray(repo.commits) || !repo.commits.length) reasons.push("missing-folder-history");
    else repo.commits.forEach((commit) => record(commit?.committedDate, `${repo.repository}:${commit?.oid}`));
  }
  if (reasons.length) return { kind: "excluded", reasons: [...new Set(reasons)].sort(), lastActivity: null };
  const clean = projectClosed && ticketsClosed && prsClosed;
  return {
    kind: clean ? "clean" : nowMs - last >= days * DAY_MS ? "stale" : "excluded",
    reasons: clean || nowMs - last >= days * DAY_MS ? [] : ["recent-activity"],
    lastActivity: new Date(last).toISOString(),
    cleanEnd: { projectClosed, ticketsClosed, prsClosed },
  };
}

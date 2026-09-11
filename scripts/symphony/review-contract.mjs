// Shared, side-effect-free acceptance policy. API records must be acquired by
// trusted base code, never supplied by the PR or an assessment process.
import { createHash } from "node:crypto";
import { validateConfig } from "./runtime-bundle/skills/symphony-repository/scripts/config.mjs";
import { classifyGitHubActor } from "../github-actor-classification.mjs";

export const CADENCE_APP_ID = 4866513;
export const CADENCE_CHECK_NAME = "Cadence Review";
export const REVIEW_SCHEMA = "cadence-review/v1";
export const FEEDBACK_SOURCES = ["reviews", "comments", "threads", "linearComments", "commits"];
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const assert = (condition, reason) => { if (!condition) throw new Error(reason); };
const canonical = (value) => JSON.stringify(value, (_, entry) =>
  entry && !Array.isArray(entry) && typeof entry === "object"
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
export const reviewDigest = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const same = (a, b) => canonical(a) === canonical(b);
const fail = (reason) => ({ passes: false, reason });

const repositoryName = value => typeof value === "string" && /^[a-z\d][a-z\d-]*\/[\w.-]+$/i.test(value) &&
  ![".", ".."].includes(value.split("/")[1]);
const matchesRepository = (repository, fullName) => repositoryName(fullName) && positive(repository?.id) &&
  repository.full_name === fullName && repository.owner?.login === fullName.split("/")[0];

// The trusted task/project selects the repository and base. Only the fetched
// selected base revision supplies active configuration; task-head proposals do not.
// A missing file is an onboarding handoff to symphony-repository (PR, issue,
// then pinned Linear workpad), never permission to infer passing requirements.
export async function loadRepositoryConfig({ repository: fullName, baseBranch, expectedRevision, token, fetchImpl = fetch }) {
  assert(repositoryName(fullName), "Invalid selected repository");
  assert(sha(expectedRevision), "Missing expected target base revision");
  const read = async path => {
    const response = await fetchImpl(`https://api.github.com/repos/${fullName}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    });
    assert(response.ok, `Repository configuration read failed: HTTP ${response.status}`);
    return response.json();
  };
  const repository = await read("");
  assert(matchesRepository(repository, fullName), "Discovered repository owner/name mismatch");
  const selectedBase = baseBranch ?? repository.default_branch;
  assert(nonempty(selectedBase), "Missing selected base branch");
  const branch = await read(`/branches/${encodeURIComponent(selectedBase)}`);
  assert(branch.name === selectedBase && branch.commit?.sha === expectedRevision,
    "Configuration must match fetched selected base");
  const tree = await read(`/git/trees/${expectedRevision}`);
  assert(tree.truncated === false && Array.isArray(tree.tree), "Incomplete target base tree");
  const entries = tree.tree.filter(entry => entry.path === ".symphony.cfg.json");
  const context = { repository, baseBranch: selectedBase, revision: expectedRevision };
  if (!entries.length) return { status: "missing", ...context };
  assert(entries.length === 1 && entries[0].type === "blob" &&
    ["100644", "100755"].includes(entries[0].mode) && sha(entries[0].sha), "Repository config must be a regular file");
  const file = await read(`/git/blobs/${entries[0].sha}`);
  assert(file.sha === entries[0].sha && file.encoding === "base64" && nonempty(file.content), "Missing configuration content");
  const config = validateConfig(JSON.parse(Buffer.from(file.content, "base64").toString("utf8")));
  return { status: "configured", ...context, config };
}

// Existing import name retained for downstream callers; there is no mapping or
// central target list. The arguments/result are the target-base config contract.
export { loadRepositoryConfig as loadRepositoryMapping };

const validCi = (ci) => Array.isArray(ci?.required_checks) && ci.required_checks.length > 0 &&
  new Set(ci.required_checks.map(c => c?.name)).size === ci.required_checks.length &&
  ci.required_checks.every(c => c && nonempty(c.name) && positive(c.app_id) &&
    /^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(c.workflow_path) && c.tested_ref === "head" &&
    positive(c.running_timeout_minutes) && Array.isArray(c.events) && c.events.length > 0 &&
    c.events.every(e => ["push", "pull_request", "workflow_dispatch"].includes(e)) &&
    ["pr-head", "default-branch"].includes(c.ref_policy) &&
    Array.isArray(c.children) && c.children.every(child => child && nonempty(child.name) && positive(child.running_timeout_minutes))) &&
  ["missing_after_minutes", "queued_after_minutes", "completion_grace_minutes", "run_budget_minutes"]
    .every(key => positive(ci[key]));

// selection is resolved from explicit Linear project metadata or human task
// direction by trusted code, not an incidental URL or dispatch input. host is
// deployment configuration: App identities, review controller and waiting limits.
// ciDiscovery is complete workflow/branch-rule evidence from configuration.revision;
// it supplies exact event/ref/checkout/child provenance absent from the config schema.
export function resolveTarget({ selection, configuration, host, hostRevision, controllerRevision, request,
  repository, controllerRepository, pullRequest, issue, associations, installations, ciDiscovery }) {
  assert(sha(host?.revision) && host.revision === hostRevision && host.revision === controllerRevision,
    "Controller configuration revision mismatch");
  assert(selection && ["project", "human-task"].includes(selection.source) &&
    matchesRepository(repository, selection.repository), "Repository owner/name mismatch");
  assert(request && Object.keys(request).every(k => ["repositoryId", "prNumber", "headSha"].includes(k)),
    "Caller authority override");
  assert(positive(request.repositoryId) && request.repositoryId === repository.id &&
    positive(request.prNumber) && sha(request.headSha), "Invalid target identity");
  assert(configuration?.status === "configured",
    "Missing repository config: symphony-repository must propose .symphony.cfg.json for the selected base");
  const config = validateConfig(configuration.config);
  const baseBranch = selection.baseBranch ?? repository.default_branch;
  assert(nonempty(baseBranch) && sha(configuration.revision) &&
    matchesRepository(configuration.repository, selection.repository) && configuration.repository.id === repository.id &&
    configuration.baseBranch === baseBranch, "Target configuration source mismatch");
  assert(pullRequest?.number === request.prNumber && pullRequest.state === "open" &&
    pullRequest.head?.sha === request.headSha && pullRequest.base?.repo?.id === repository.id &&
    pullRequest.base.ref === baseBranch && pullRequest.base.sha === configuration.revision,
    "PR closed or target/head/base mismatch");
  assert(nonempty(selection.linear?.team_id) && nonempty(selection.linear?.project_id) &&
    nonempty(selection.linear?.issue_id) && issue?.id === selection.linear.issue_id &&
    issue.team?.id === selection.linear.team_id && issue.project?.id === selection.linear.project_id &&
    Array.isArray(associations) && associations.length === 1 && associations[0] === issue.id,
    "Ambiguous or wrong Linear association");
  assert(nonempty(selection.human?.github) && nonempty(selection.human?.linear_id) &&
    Array.isArray(selection.labels) && selection.labels.includes("symphony") &&
    selection.labels.every(label => nonempty(label) && pullRequest.labels?.some(l => l.name === label)), "Missing identity/labels");
  assert(matchesRepository(controllerRepository, host.controller?.full_name) &&
    nonempty(host.controller.base_branch) &&
    /^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(host.controller.workflow), "Invalid controller identity/dispatch");
  assert(host.apps?.cadence?.app_id === CADENCE_APP_ID && positive(host.apps?.symphony?.app_id) &&
    host.apps.symphony.app_id !== CADENCE_APP_ID, "Invalid App identity");
  assert(installations?.complete === true && Array.isArray(installations.nodes), "Incomplete installation discovery");
  const discoverApps = repo => Object.fromEntries(["symphony", "cadence"].map(role => {
    const matches = installations.nodes.filter(i => i.app_id === host.apps[role].app_id &&
      i.account?.login === repo.owner.login);
    const installation = matches.length === 1 ? matches[0] : null;
    assert(positive(installation?.id) && installation.suspended_at === null &&
      installation.repository_ids?.includes(repo.id), `Invalid ${role} installation selection`);
    assert(!installations.nodes.some(i => i.id === installation.id &&
      (i.account?.login !== installation.account.login || i.app_id !== installation.app_id)), "Installation reused across owners/Apps");
    return [role, { app_id: installation.app_id, installation_id: installation.id }];
  }));
  const apps = discoverApps(repository), controllerApps = discoverApps(controllerRepository);
  assert(ciDiscovery?.complete === true && ciDiscovery.repositoryId === repository.id &&
    ciDiscovery.revision === configuration.revision && Array.isArray(ciDiscovery.required_checks) &&
    config.ci.requiredChecks.length > 0 && config.ci.requiredChecks.every(check =>
      ciDiscovery.required_checks.filter(rule => rule.name === check.name && rule.app_id === check.appId &&
        rule.workflow_path === check.workflow).length === 1), "Missing or mismatched base CI provenance");
  // Additional discovered branch-rule requirements cannot weaken the config list.
  const ci = { ...structuredClone(host.ci), required_checks: structuredClone(ciDiscovery.required_checks) };
  assert(validCi(ci) && positive(host.review?.timeout_minutes) &&
    host.review.max_passes === 3 && host.review.operational_retries === 1, "Incomplete gate configuration");
  assert(nonempty(pullRequest.head.ref) && nonempty(repository.default_branch), "Missing target refs");
  return { repository_id: repository.id, full_name: repository.full_name, apps,
    linear: structuredClone(selection.linear), human: structuredClone(selection.human), labels: [...selection.labels],
    repositoryConfig: structuredClone(config), ci, review: structuredClone(host.review),
    controller: { ...structuredClone(host.controller), repository_id: controllerRepository.id, apps: controllerApps },
    dispatch: { repository: host.controller.full_name, workflow: host.controller.workflow, ref: `refs/heads/${host.controller.base_branch}` },
    configRevision: configuration.revision, controllerRevision, issueId: issue.id,
    prNumber: request.prNumber, headSha: request.headSha, headRef: pullRequest.head.ref,
    defaultBranch: repository.default_branch, baseBranch, baseSha: pullRequest.base.sha };
}

// runs: fully paginated REST Actions runs at the head, including every peer
// and latest run_attempt; complete is true only after all runs/jobs/checks are
// acquired. Omitted peers cannot be detected here. jobs: attempt-specific REST jobs,
// checks: REST check runs. tested_sha/ref are acquisition evidence from the
// explicit checkout, not the workflow's synthetic merge/default SHA. Evidence
// contains one row per required name AND run ID; name alone is not unique.
export function evaluateCi({ target, runs = [], jobs = [], checks = [], complete = false } = {}) {
  if (!positive(target?.repository_id) || !sha(target.headSha) || !validCi(target.ci) || !complete)
    return fail("missing-ci-configuration-or-history");
  const evidence = [];
  for (const rule of target.ci.required_checks) {
    const candidates = runs.filter(run => run.repository?.id === target.repository_id &&
      run.head_sha === target.headSha && run.path === rule.workflow_path && rule.events.includes(run.event) &&
      run.head_branch === (rule.ref_policy === "pr-head" ? target.headRef : target.defaultBranch));
    if (!candidates.length) return fail(`missing-run:${rule.name}`);
    if (candidates.some(r => !positive(r.id) || !positive(r.run_number) || !positive(r.run_attempt)))
      return fail(`invalid-run:${rule.name}`);
    // Separate push/PR/dispatch runs are peers, not replacements. Only a later
    // attempt of the same run can supersede its earlier evidence.
    const groups = new Map();
    for (const run of candidates) {
      if (!groups.has(run.id)) groups.set(run.id, []);
      groups.get(run.id).push(run);
    }
    if (new Set([...groups.values()].map(attempts => attempts[0].run_number)).size !== groups.size)
      return fail(`ambiguous-run:${rule.name}`);
    for (const attempts of groups.values()) {
      const run = attempts.sort((a, b) => b.run_attempt - a.run_attempt)[0];
      if (attempts.some(r => r.run_number !== run.run_number || r.event !== run.event) ||
        new Set(attempts.map(r => r.run_attempt)).size !== attempts.length)
        return fail(`ambiguous-run:${rule.name}`);
      if (run.status !== "completed" || run.conclusion !== "success") return fail(`run-${run.conclusion || run.status}:${rule.name}`);
      const selected = [];
      for (const name of [rule.name, ...rule.children.map(c => c.name)]) {
        const matches = jobs.filter(job => job.run_id === run.id && job.run_attempt === run.run_attempt && job.name === name);
        if (matches.length !== 1) return fail(`missing-or-ambiguous-job:${name}`);
        const job = matches[0];
        const ownedChecks = checks.filter(check => check.name === name && check.app?.id === rule.app_id &&
          check.check_suite?.id === run.check_suite_id && check.head_sha === target.headSha &&
          check.url === job.check_run_url);
        if (!positive(job.id) || !positive(run.check_suite_id) || !positive(ownedChecks[0]?.id) ||
          job.head_sha !== target.headSha || job.tested_sha !== target.headSha ||
          ownedChecks.length !== 1 || job.status !== "completed" || job.conclusion !== "success" ||
          ownedChecks[0].status !== "completed" || ownedChecks[0].conclusion !== "success")
          return fail(`invalid-job-provenance-or-result:${name}`);
        selected.push({ jobId: job.id, checkId: ownedChecks[0].id, name });
      }
      evidence.push({ name: rule.name, runId: run.id, attempt: run.run_attempt, jobs: selected });
    }
  }
  return { passes: true, reason: "current-ci-success", evidence };
}

export const isGeneratedBookkeeping = (body) =>
  ["## Codex Workpad", "## Cadence Workpad", "## Symphony Workpad"].includes(
    String(body || "").split(/\r?\n/).find(line => line.trim() !== "") || "");

// Every human record is retained, not just the newest timestamp. Edits, removed
// comments and thread resolution changes all change this deterministic watermark.
export function feedbackWatermark(sources, { isHuman = actor => actor?.type !== "Bot" && actor?.__typename !== "Bot" &&
  nonempty(actor?.login || actor?.name) && (!actor?.login || classifyGitHubActor(actor.login).humanFacing) } = {}) {
  let complete = true;
  const records = [];
  for (const source of FEEDBACK_SOURCES) {
    const collection = sources?.[source];
    if (collection?.complete !== true || !Array.isArray(collection?.nodes)) { complete = false; continue; }
    for (const node of collection.nodes) {
      if ((source !== "commits" && isGeneratedBookkeeping(node.body)) || node.state === "PENDING") continue;
      const actor = node.author || node.user;
      if (!actor) { complete = false; continue; }
      if (!isHuman(actor)) continue;
      const updatedAt = node.updatedAt || node.updated_at || node.submittedAt;
      if (!node.id || !updatedAt || !Number.isFinite(Date.parse(updatedAt))) { complete = false; continue; }
      records.push({ source, id: String(node.id), updatedAt, digest: reviewDigest({
        body: node.body || "", state: node.state || "", threadId: node.threadId || "",
        isResolved: node.isResolved ?? null, isOutdated: node.isOutdated ?? null,
      }) });
    }
  }
  records.sort((a, b) => `${a.source}:${a.id}`.localeCompare(`${b.source}:${b.id}`));
  if (new Set(records.map(r => `${r.source}:${r.id}`)).size !== records.length) complete = false;
  return { complete, records, digest: reviewDigest(records) };
}

export function createReviewGeneration({ repositoryId, prNumber, headSha, baseSha, configRevision,
  feedback, manualRetry = 0, controllerRevision }) {
  assert(positive(repositoryId) && positive(prNumber) && sha(headSha) && sha(baseSha) && sha(configRevision) &&
    (controllerRevision === undefined || sha(controllerRevision)) &&
    feedback && typeof feedback.complete === "boolean" && Array.isArray(feedback.records) && feedback.digest === reviewDigest(feedback.records) &&
    Number.isSafeInteger(manualRetry) && manualRetry >= 0, "Invalid review generation");
  const context = { repositoryId, prNumber, headSha, baseSha, configRevision, feedback, manualRetry,
    ...(controllerRevision === undefined ? {} : { controllerRevision }) };
  return { ...context, id: reviewDigest(context), resetKey: reviewDigest({ feedback: feedback.digest, manualRetry }) };
}

export function queueReviewGeneration(current, generation, { checkId, operationalRetry = false } = {}) {
  assert(positive(checkId) && generation?.id === createReviewGeneration(generation).id, "Invalid queued review");
  if (current?.generation.id === generation.id && !operationalRetry) return current;
  const reset = !current || (generation.feedback.complete && current.generation.resetKey !== generation.resetKey);
  const passes = reset ? 0 : current.passes;
  const sameGeneration = current?.generation.id === generation.id;
  const retries = sameGeneration ? current.operationalRetries : 0;
  assert(!operationalRetry || (sameGeneration && ["operational-error", "cancelled", "timed_out"].includes(current.phase) && retries < 1),
    "Operational retry unavailable");
  assert(operationalRetry || passes < 3, "Three-pass review cap requires human input");
  return { generation, sequence: (current?.sequence || 0) + 1, attempt: sameGeneration ? current.attempt + 1 : 1,
    checkId, phase: "queued", passes: passes + (operationalRetry ? 0 : 1),
    ledger: structuredClone(current?.ledger || { requirements: [], findings: [], humanFeedback: [] }),
    operationalRetries: retries + (operationalRetry ? 1 : 0) };
}

export function startReviewGeneration(current, liveGeneration) {
  assert(current?.phase === "queued" && current.generation.id === liveGeneration?.id, "Superseded review start");
  return { ...current, phase: "in_progress" };
}

export function validateReviewOutput(output, generation) {
  if (!output || output.schema !== REVIEW_SCHEMA || output.repositoryId !== generation.repositoryId ||
    output.prNumber !== generation.prNumber || output.headSha !== generation.headSha ||
    output.generationId !== generation.id || output.sourcesComplete !== true || !nonempty(output.summary)) return false;
  return ["requirements", "findings", "humanFeedback"].every(key => Array.isArray(output[key]) &&
    output[key].every(x => x && nonempty(x.id) && nonempty(x.summary) && nonempty(x.status)) &&
    new Set(output[key].map(x => `${x.source || ""}:${x.id}`)).size === output[key].length) && output.requirements.length > 0 &&
    output.requirements.every(r => ["satisfied", "unsatisfied", "human-needed"].includes(r.status) && Array.isArray(r.evidence)) &&
    output.humanFeedback.every(f => ["addressed", "deferred", "blocked"].includes(f.status) && typeof f.mandatory === "boolean") &&
    generation.feedback.records.every(record => output.humanFeedback.some(f =>
      f.id === record.id && f.source === record.source && f.updatedAt === record.updatedAt)) &&
    output.findings.every(f => ["blocker", "human-needed", "should-fix", "suggestion"].includes(f.class) &&
      ["open", "resolved", "dismissed"].includes(f.status) && typeof f.mandatory === "boolean" && Array.isArray(f.evidence));
}
const mandatoryOpen = output => output.requirements.some(r => r.status !== "satisfied") ||
  output.findings.some(f => f.status === "open" && (f.mandatory || ["blocker", "human-needed"].includes(f.class))) ||
  output.humanFeedback.some(f => f.status === "blocked" || (f.mandatory && f.status !== "addressed"));

export function completeReviewGeneration(current, { generationId, attempt, checkId, phase, output }, liveGeneration) {
  assert(current && current.generation.id === liveGeneration?.id && generationId === liveGeneration.id &&
    current.attempt === attempt && current.checkId === checkId && ["queued", "in_progress"].includes(current.phase),
    "Superseded review publication");
  assert(["completed", "operational-error", "cancelled", "timed_out"].includes(phase), "Invalid review phase");
  assert(phase !== "completed" || validateReviewOutput(output, liveGeneration), "Invalid review output");
  const ledger = structuredClone(current.ledger);
  if (phase === "completed") {
    for (const field of ["requirements", "findings", "humanFeedback"]) {
      const key = item => `${item.source || ""}:${item.id}`;
      const entries = new Map(ledger[field].map(item => [key(item), item]));
      for (const item of output[field]) {
        const prior = entries.get(key(item));
        assert(!prior || ((!prior.class || prior.class === item.class) && (!prior.mandatory || item.mandatory)),
          "Finding classification/mandatory history cannot be weakened");
        entries.set(key(item), item);
      }
      ledger[field] = [...entries.values()];
    }
  }
  return { ...current, phase, ledger, ...(phase === "completed" ? { output, outputDigest: reviewDigest(output) } : {}) };
}

export const reviewExternalId = (state) =>
  `${state.generation.repositoryId}:${state.generation.prNumber}:${state.generation.headSha}:${state.generation.id}:${state.attempt}`;

export function evaluateAi({ target, pullRequest, generation, checks = [], workpad, complete = false } = {}) {
  if (!positive(target?.repository_id) || target.apps?.cadence?.app_id !== CADENCE_APP_ID ||
    pullRequest?.state !== "open" || pullRequest.number !== target.prNumber ||
    pullRequest.base?.repo?.id !== target.repository_id || pullRequest.head?.sha !== target.headSha ||
    !target.labels?.length || !target.labels.every(label => pullRequest.labels?.some(l => l.name === label))) return fail("invalid-ai-target");
  let validGeneration = false;
  try { validGeneration = generation?.id === createReviewGeneration(generation).id; } catch { /* reject malformed data */ }
  if (!complete || !generation?.feedback?.complete || !validGeneration ||
    generation.headSha !== target.headSha || generation.configRevision !== target.configRevision ||
    generation.controllerRevision !== target.controllerRevision ||
    generation.repositoryId !== target.repository_id || generation.prNumber !== target.prNumber ||
    generation.baseSha !== pullRequest.base.sha) return fail("stale-or-incomplete-generation");
  const state = workpad?.reviewContract;
  if (!workpad?.commentId || workpad.issueId !== target.issueId || !state ||
    !same(state.generation, generation) || state.phase !== "completed" ||
    !validateReviewOutput(state.output, generation) || state.outputDigest !== reviewDigest(state.output) ||
    !state.ledger || !["requirements", "findings", "humanFeedback"].every(key => Array.isArray(state.ledger[key])) ||
    mandatoryOpen(state.output) || mandatoryOpen(state.ledger))
    return fail("missing-or-rejected-workpad");
  const candidates = checks.filter(c => c.name === CADENCE_CHECK_NAME && c.app?.id === CADENCE_APP_ID && c.head_sha === target.headSha);
  candidates.sort((a, b) => b.id - a.id);
  const check = candidates[0];
  if (!positive(state.checkId) || !positive(state.attempt) || !positive(state.passes) || state.passes > 3 || !check ||
    check.id !== state.checkId || check.external_id !== reviewExternalId(state) ||
    check.status !== "completed" || check.conclusion !== "success" ||
    candidates.filter(c => c.id === check.id).length !== 1) return fail("missing-or-stale-cadence-check");
  return { passes: true, reason: "current-ai-success", checkId: check.id, generationId: generation.id };
}

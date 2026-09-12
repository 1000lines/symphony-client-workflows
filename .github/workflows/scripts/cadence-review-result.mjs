// Pure R1 boundary. Only trusted acquisition supplies context; this module does
// not acquire credentials, invoke providers, persist records or publish reviews.
import {
  REVIEW_SCHEMA, FEEDBACK_SOURCES, createReviewGeneration,
  completeReviewGeneration, reviewDigest, validateReviewOutput,
} from "../../../scripts/symphony/review-contract.mjs";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
const positive = value => Number.isSafeInteger(value) && value > 0;
const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const requireThat = (ok, reason) => { if (!ok) throw new Error(`Invalid reviewer result: ${reason}`); };
const oneOf = (value, choices) => choices.includes(value);
const feedbackKey = item => `${item.source}:${item.id}`;
const closed = item => ["resolved", "dismissed", "closed"].includes(item.status);
const blocks = item => !closed(item) && (item.mandatory === true || ["blocker", "human-needed"].includes(item.class));
const hasBlockers = output => output.requirements.some(item => item.status !== "satisfied") ||
  output.findings.some(blocks) || output.humanFeedback.some(item =>
    item.status === "blocked" || (item.mandatory && item.status !== "addressed"));
function link(value) {
  if (!text(value)) return false;
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}
function keys(value, allowed, label) {
  requireThat(object(value) && Object.keys(value).every(key => allowed.includes(key)), `${label} fields`);
}
function indexed(items, key, label) {
  requireThat(Array.isArray(items) && items.every(item => object(item) && text(item.id)), `${label} IDs`);
  const result = new Map(items.map(item => [key(item), item]));
  requireThat(result.size === items.length, `duplicate ${label} IDs`);
  return result;
}
function latest(workpad, field, key) {
  // Workpad arrays are chronological history; the existing contract is its
  // current ledger. Do not create another persisted finding history.
  const items = [...(workpad[field] || []), ...(workpad.reviewContract.ledger?.[field] || [])];
  requireThat(items.every(item => object(item) && text(item.id) && item.id !== "(none)"), `legacy ${field} IDs`);
  return new Map(items.map(item => [key(item), item]));
}
function evidence(value) {
  requireThat(Array.isArray(value) && value.length > 0 && value.every(link), "evidence links");
}

function checkContext(trusted) {
  requireThat(object(trusted), "missing trusted context");
  const { generation, workpad, provenance } = trusted;
  requireThat(text(trusted.repository) && /^[a-z\d][a-z\d-]*\/[\w.-]+$/i.test(trusted.repository) &&
    ![".", ".."].includes(trusted.repository.split("/")[1]) && text(trusted.requestId), "trusted correlation");
  requireThat(generation?.id === createReviewGeneration(generation).id && generation.feedback.complete,
    "incomplete generation/feedback");
  requireThat(trusted.inputsComplete === true && trusted.providerSucceeded === true, "missing inputs or provider failure");
  requireThat(text(trusted.issueId) && text(workpad?.commentId) && workpad.issueId === trusted.issueId &&
    workpad.schemaVersion === "cadence-workpad/v1alpha1" && positive(workpad.reviewContract?.attempt) &&
    positive(workpad.reviewContract?.checkId) && reviewDigest(workpad.reviewContract.generation) === reviewDigest(generation),
    "missing durable workpad or stale generation");
  requireThat(["requirements", "findings", "humanFeedback"].every(field =>
    Array.isArray(workpad[field]) && Array.isArray(workpad.reviewContract.ledger?.[field])), "missing prior ledger");
  keys(provenance, ["runId", "runAttempt", "provider", "model", "effectiveEffort", "appId", "installationId",
    "workflowRef", "helperRef", "timings"], "trusted provenance");
  requireThat(["runId", "runAttempt", "appId", "installationId"].every(key => positive(provenance[key])) &&
    ["provider", "model", "effectiveEffort", "workflowRef", "helperRef"].every(key => text(provenance[key])), "trusted provenance");
  if (provenance.timings !== undefined) {
    const names = ["requestAcceptedAt", "providerStartedAt", "providerFinishedAt"];
    keys(provenance.timings, names, "trusted timings");
    let previous = -Infinity;
    for (const name of names) {
      const value = provenance.timings[name];
      requireThat(value === null || (text(value) && Number.isFinite(Date.parse(value))), "trusted timestamp or explicit null required");
      if (value !== null) {
        const time = Date.parse(value);
        requireThat(time >= previous, "reversed trusted timings");
        previous = time;
      }
    }
  }
}

// Returns the one cadence-review/v1 output consumed by P/N. Throws on any
// invalid/missing/stale input; never turns an error or prose into a verdict.
export function validateReviewerResult(raw, trusted) {
  checkContext(trusted);
  let result;
  try { result = typeof raw === "string" ? JSON.parse(raw) : structuredClone(raw); }
  catch { throw new Error("Invalid reviewer result: malformed JSON"); }
  keys(result, ["repository", "prNumber", "headSha", "requestId", "verdict", "summary",
    "requirements", "findings", "humanFeedback", "replan"], "result");
  const { generation, workpad } = trusted;
  requireThat(result.repository === trusted.repository && positive(result.prNumber) && result.prNumber === generation.prNumber &&
    sha(result.headSha) && result.headSha === generation.headSha && result.requestId === trusted.requestId, "target/request correlation");
  requireThat(oneOf(result.verdict, ["approve", "request_changes", "escalate_to_replan"]) &&
    text(result.summary) && result.summary.length <= 2000, "verdict/summary");

  const requirements = indexed(result.requirements, item => item.id, "requirement");
  const expectedRequirements = indexed(trusted.requirements, item => item.id, "trusted requirement");
  const priorRequirements = latest(workpad, "requirements", item => item.id);
  requireThat(requirements.size > 0 && requirements.size === expectedRequirements.size &&
    [...priorRequirements.keys()].every(id => requirements.has(id)), "requirement coverage");
  for (const item of requirements.values()) {
    keys(item, ["id", "status", "summary", "source", "evidence"], "requirement");
    requireThat(expectedRequirements.has(item.id) && link(item.source) && item.source === expectedRequirements.get(item.id).source &&
      text(item.summary) && oneOf(item.status, ["satisfied", "unsatisfied", "human-needed"]), "requirement source/status");
    evidence(item.evidence);
  }

  const feedback = indexed(result.humanFeedback, feedbackKey, "human feedback");
  const expectedFeedback = indexed(trusted.humanFeedback, feedbackKey, "trusted human feedback");
  const priorFeedback = latest(workpad, "humanFeedback", feedbackKey);
  requireThat(feedback.size === expectedFeedback.size && generation.feedback.records.every(record => {
    const item = expectedFeedback.get(feedbackKey(record));
    return item && item.updatedAt === record.updatedAt;
  }), "human feedback coverage including commits");
  for (const prior of priorFeedback.values()) {
    // Older workpads lack source namespaces. Trusted acquisition must map their
    // existing IDs to a surface, never invent replacement IDs for them.
    const matches = [...expectedFeedback.values()].filter(item => item.id === prior.id &&
      (!FEEDBACK_SOURCES.includes(prior.source) || item.source === prior.source));
    requireThat(matches.length === 1, "prior human feedback coverage");
    requireThat(prior.mandatory !== true || matches[0].mandatory === true, "human feedback mandatory history");
  }
  for (const item of feedback.values()) {
    keys(item, ["id", "source", "status", "reason", "sourceUrl"], "human feedback");
    const expected = expectedFeedback.get(feedbackKey(item));
    requireThat(expected && FEEDBACK_SOURCES.includes(item.source) && link(item.sourceUrl) && item.sourceUrl === expected.sourceUrl &&
      typeof expected.mandatory === "boolean" && text(expected.updatedAt) && Number.isFinite(Date.parse(expected.updatedAt)) &&
      text(item.reason) && oneOf(item.status, ["addressed", "deferred", "blocked"]), "human feedback source/disposition");
  }

  const findings = indexed(result.findings, item => item.id, "finding");
  const priorFindings = latest(workpad, "findings", item => item.id);
  for (const prior of priorFindings.values()) {
    requireThat(closed(prior) || findings.has(prior.id), "unresolved finding omitted");
  }
  for (const item of findings.values()) {
    keys(item, ["id", "class", "status", "mandatory", "summary", "evidence", "path", "line",
      "nextAction", "owner", "recommendedResolution", "kind", "requirementId"], "finding");
    requireThat(oneOf(item.class, ["blocker", "human-needed", "should-fix", "suggestion"]) &&
      oneOf(item.status, ["open", "resolved", "dismissed"]) && typeof item.mandatory === "boolean" && text(item.summary), "finding classification/status");
    evidence(item.evidence);
    const prior = priorFindings.get(item.id);
    requireThat(!prior || (prior.class === item.class && (prior.mandatory !== true || item.mandatory) &&
      (!blocks(prior) || item.mandatory || ["blocker", "human-needed"].includes(item.class))), "finding history weakened");
    requireThat(item.path === undefined || (text(item.path) && !/^[\\/]|^[A-Za-z]:|\\/.test(item.path) &&
      !item.path.split("/").includes("..")), "finding path");
    requireThat(item.line === undefined || (item.path !== undefined && positive(item.line)), "finding line");
    requireThat(item.kind === undefined || oneOf(item.kind, ["implementation", "execution-input", "requirement-change"]), "finding kind");
    requireThat(item.requirementId === undefined || requirements.has(item.requirementId), "finding requirement");
    for (const field of ["nextAction", "owner", "recommendedResolution"]) {
      requireThat(item[field] === undefined || text(item[field]), `finding ${field}`);
      if (item.status === "open" && (item.mandatory || ["blocker", "human-needed"].includes(item.class))) {
        requireThat(text(item[field]), `mandatory finding ${field}`);
      }
    }
    if (item.kind === "execution-input") requireThat(item.class === "human-needed" && item.mandatory, "execution input must need a human");
  }
  if (result.verdict === "escalate_to_replan") {
    keys(result.replan, ["requirementId", "changedRequirement", "affectedScope", "recommendedDecision"], "replan");
    requireThat(["requirementId", "changedRequirement", "affectedScope", "recommendedDecision"].every(key => text(result.replan[key])) &&
      requirements.has(result.replan.requirementId) && requirements.get(result.replan.requirementId).status !== "satisfied" &&
      [...findings.values()].some(item => item.kind === "requirement-change" && item.requirementId === result.replan.requirementId &&
        item.status === "open" && item.mandatory), "replan requires a changed requirement, scope and decision");
  } else requireThat(result.replan === undefined && !result.findings.some(item => item.kind === "requirement-change" && item.status === "open"),
    "requirement change requires replan verdict");

  const output = {
    ...result, schema: REVIEW_SCHEMA, repositoryId: generation.repositoryId, generationId: generation.id, sourcesComplete: true,
    requirements: result.requirements.map(item => ({ ...item, sourceUrl: item.source,
      source: priorRequirements.get(item.id)?.source ?? item.source })),
    findings: result.findings.map(item => ({ ...item,
      ...(priorFindings.get(item.id)?.source === undefined ? {} : { source: priorFindings.get(item.id).source }) })),
    humanFeedback: result.humanFeedback.map(item => ({ ...item, summary: item.reason,
      mandatory: expectedFeedback.get(feedbackKey(item)).mandatory, updatedAt: expectedFeedback.get(feedbackKey(item)).updatedAt })),
    provenance: structuredClone(trusted.provenance),
  };
  requireThat(validateReviewOutput(output, generation), "existing acceptance contract");
  requireThat((output.verdict === "approve") === !hasBlockers(output), "inconsistent verdict");
  return output;
}

// Persist this incremental payload with resolveWorkpadInput/upsertCadenceWorkpad
// and liveGeneration BEFORE publishing. Returned data is not a persistence receipt.
export function adaptReviewerResult(raw, trusted) {
  const output = validateReviewerResult(raw, trusted);
  const current = trusted.workpad.reviewContract;
  const reviewContract = completeReviewGeneration(current, {
    generationId: trusted.generation.id, attempt: current.attempt, checkId: current.checkId, phase: "completed", output,
  }, trusted.generation);
  requireThat(output.verdict !== "approve" || !hasBlockers(reviewContract.ledger), "unresolved acceptance ledger");
  return {
    reviewContract,
    reviewUpdate: {
      status: "completed", reviewState: "reviewed", lastReviewedSha: output.headSha,
      disposition: output.verdict === "approve" ? "APPROVE" : "COMMENT",
      summary: output.summary, githubAssessmentSummary: output.summary,
      requirements: output.requirements, findings: output.findings, humanFeedback: output.humanFeedback,
    },
  };
}

// N consumes the same output from the durable record, never a review marker or
// review prose. App/review-ID authorization and publication readback belong to P/N.
export function readReviewerResult(trusted) {
  checkContext(trusted);
  const state = trusted.workpad.reviewContract;
  requireThat(state.phase === "completed" && object(state.output) &&
    state.outputDigest === reviewDigest(state.output), "missing or changed structured record");
  const output = state.output;
  const raw = Object.fromEntries(["repository", "prNumber", "headSha", "requestId", "verdict", "summary", "replan"]
    .filter(key => output[key] !== undefined).map(key => [key, output[key]]));
  raw.requirements = output.requirements.map(({ id, status, summary, sourceUrl, evidence }) =>
    ({ id, status, summary, source: sourceUrl, evidence }));
  raw.findings = output.findings.map(({ source, ...item }) => item);
  raw.humanFeedback = output.humanFeedback.map(({ id, source, status, reason, sourceUrl }) =>
    ({ id, source, status, reason, sourceUrl }));
  const validated = validateReviewerResult(raw, trusted);
  requireThat(reviewDigest(validated) === state.outputDigest &&
    (validated.verdict !== "approve" || !hasBlockers(state.ledger)), "changed record context or unresolved ledger");
  return validated;
}

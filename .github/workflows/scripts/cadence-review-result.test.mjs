import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { adaptReviewerResult, readReviewerResult, validateReviewerResult } from "./cadence-review-result.mjs";
import { createReviewGeneration, feedbackWatermark, queueReviewGeneration, reviewDigest, validateReviewOutput,
  evaluateAi, reviewExternalId, CADENCE_APP_ID } from "../../../scripts/symphony/review-contract.mjs";
import { parseCadenceWorkpad, renderCadenceWorkpad, resolveWorkpadInput } from "../../../scripts/cadence-linear-workpad.mjs";

const url = "https://github.com/owner/repo/pull/1";
const head = "a".repeat(40), base = "b".repeat(40);
const date = "2026-09-12T01:00:00Z";
function fixture(legacy = { requirements: [], findings: [], humanFeedback: [] }) {
  const sources = Object.fromEntries(["reviews", "comments", "threads", "linearComments", "commits"].map(source =>
    [source, { complete: true, nodes: [{ id: source === "commits" ? head : "1", updatedAt: date,
      body: "Preserve this human input", author: { login: "maintainer" } }] }]));
  const generation = createReviewGeneration({ repositoryId: 12, prNumber: 1, headSha: head, baseSha: base,
    configRevision: base, controllerRevision: base,
    feedback: feedbackWatermark(sources, { isHuman: actor => actor.login === "maintainer" }) });
  const queued = queueReviewGeneration(null, generation, { checkId: 40 });
  const workpad = resolveWorkpadInput({ incomingWorkpad: { ...legacy, reviewContract: queued },
    existingBody: renderCadenceWorkpad(legacy) });
  const trusted = { repository: "owner/repo", requestId: "request-123", issueId: "issue-1", generation,
    inputsComplete: true, providerSucceeded: true,
    workpad: { ...parseCadenceWorkpad(renderCadenceWorkpad(workpad)), commentId: "comment-1", issueId: "issue-1" },
    requirements: [{ id: "R1", source: `${url}#requirement` }],
    humanFeedback: generation.feedback.records.map(record => ({ ...record, sourceUrl: `${url}#${record.source}`, mandatory: true })),
    provenance: { runId: 100, runAttempt: 1, provider: "fixture", model: "fixture-model", effectiveEffort: "low",
      appId: CADENCE_APP_ID, installationId: 22, workflowRef: `owner/repo/.github/workflows/review.yml@${base}`,
      helperRef: base, timings: { requestAcceptedAt: date, providerStartedAt: date, providerFinishedAt: null } },
  };
  const result = { repository: trusted.repository, prNumber: 1, headSha: head, requestId: trusted.requestId,
    verdict: "approve", summary: "Required coverage is satisfied.",
    requirements: trusted.requirements.map(item => ({ ...item, status: "satisfied", summary: "Covered", evidence: [url] })),
    findings: [], humanFeedback: trusted.humanFeedback.map(({ id, source, sourceUrl }) =>
      ({ id, source, sourceUrl, status: "addressed", reason: "Covered by the implementation and tests." })) };
  return { result, trusted };
}
const finding = (extra = {}) => ({ id: "F1", class: "blocker", status: "open", mandatory: true,
  summary: "A required check is missing", evidence: [url], nextAction: "Add the check", owner: "Symphony",
  recommendedResolution: "Test the missing case", ...extra });
function persist(result, trusted) {
  const incomingWorkpad = adaptReviewerResult(result, trusted);
  const workpad = resolveWorkpadInput({ incomingWorkpad, existingBody: renderCadenceWorkpad(trusted.workpad),
    liveGeneration: trusted.generation, now: new Date(date) });
  return { ...trusted, workpad: { ...parseCadenceWorkpad(renderCadenceWorkpad(workpad)),
    commentId: trusted.workpad.commentId, issueId: trusted.issueId } };
}

test("valid JSON adapts to the existing acceptance and durable workpad, with all human surfaces", () => {
  const { result, trusted } = fixture();
  const before = structuredClone({ result, trusted });
  const saved = persist(JSON.stringify(result), trusted);
  const output = readReviewerResult(saved);
  assert.equal(validateReviewOutput(output, trusted.generation), true);
  assert.equal(saved.workpad.schemaVersion, "cadence-workpad/v1alpha1");
  assert.equal(saved.workpad.disposition, "APPROVE");
  assert.equal(saved.workpad.reviewContractHistory.length, 1);
  assert.equal(output.humanFeedback.find(item => item.source === "commits").id, head);
  assert.deepEqual(output.provenance, trusted.provenance);
  assert.deepEqual({ result, trusted }, before, "pure adapter must not mutate inputs");
  const state = saved.workpad.reviewContract;
  const acceptance = evaluateAi({ complete: true, generation: trusted.generation,
    target: { repository_id: 12, prNumber: 1, headSha: head, issueId: trusted.issueId,
      configRevision: base, controllerRevision: base, apps: { cadence: { app_id: CADENCE_APP_ID } }, labels: ["symphony"] },
    pullRequest: { state: "open", number: 1, head: { sha: head }, base: { sha: base, repo: { id: 12 } }, labels: [{ name: "symphony" }] },
    checks: [{ id: 40, name: "Cadence Review", app: { id: CADENCE_APP_ID }, head_sha: head,
      external_id: reviewExternalId(state), status: "completed", conclusion: "success" }], workpad: saved.workpad });
  assert.equal(acceptance.passes, true);
});

test("malformed, partial and prose output cannot become a review", () => {
  for (const raw of [undefined, null, [], 1, "", "{", "Approved!", '```json\n{}\n```', "{}", "null"]) {
    assert.throws(() => adaptReviewerResult(raw, fixture().trusted));
  }
  const { result } = fixture();
  for (const field of Object.keys(result)) {
    const partial = structuredClone(result); delete partial[field];
    assert.throws(() => adaptReviewerResult(partial, fixture().trusted), field);
  }
});

test("adversarial correlation, model authority and invalid field values reject", () => {
  for (const change of [
    r => { r.repository = "other/repo"; }, r => { r.repository = "OWNER/repo"; }, r => { r.prNumber = "1"; },
    r => { r.prNumber = 2; }, r => { r.prNumber = 0; }, r => { r.headSha = head.slice(0, 7); },
    r => { r.headSha = base; }, r => { r.requestId = "stale-request"; }, r => { r.verdict = "APPROVE"; },
    r => { r.summary = " "; }, r => { r.summary = "x".repeat(2001); }, r => { r.requirements = []; },
    r => { r.requirements[0].id = "invented"; }, r => { r.requirements[0].status = "partial"; },
    r => { r.requirements[0].source = "https://attacker.invalid"; }, r => { r.requirements[0].evidence = []; },
    r => { r.requirements[0].evidence = ["javascript:alert(1)"]; }, r => { r.requirements.push(r.requirements[0]); },
    r => { r.humanFeedback.pop(); }, r => { r.humanFeedback.push(r.humanFeedback[0]); },
    r => { r.humanFeedback[0].reason = ""; }, r => { r.humanFeedback[0].source = "unknown"; },
    r => { r.humanFeedback[0].status = "accepted"; }, r => { r.humanFeedback[0].sourceUrl = "file:///etc/passwd"; },
    r => { r.humanFeedback[0].mandatory = false; }, r => { r.provenance = {}; }, r => { r.reviewId = 1; },
    r => { r.runId = 2; }, r => { r.sourcesComplete = true; }, r => { r.timings = {}; },
    r => { r.provider = "another"; }, r => { r.baseSha = base; }, r => { r.feedbackWatermark = {}; },
  ]) {
    const { result, trusted } = fixture(); change(result);
    assert.throws(() => adaptReviewerResult(result, trusted), change.toString());
  }
});

test("missing inputs, provider failure, missing workpad and same-head new feedback reject", () => {
  for (const change of [
    t => { t.inputsComplete = false; }, t => { t.providerSucceeded = false; }, t => { delete t.workpad.commentId; },
    t => { t.workpad.issueId = "other"; }, t => { delete t.workpad.reviewContract; }, t => { delete t.workpad.findings; },
    t => { delete t.workpad.reviewContract.attempt; }, t => { t.workpad.reviewContract.checkId = 0; },
    t => { t.generation.feedback.complete = false; }, t => { t.humanFeedback.pop(); },
    t => { t.humanFeedback[0].updatedAt = "2026-09-13T00:00:00Z"; }, t => { delete t.provenance.appId; },
    t => { t.provenance.timings.providerStartedAt = "2026-09-11T00:00:00Z"; },
    t => { t.generation = createReviewGeneration({ ...t.generation, headSha: base }); },
    t => { const feedback = structuredClone(t.generation.feedback); feedback.records[0].digest = "edited";
      feedback.digest = reviewDigest(feedback.records); t.generation = createReviewGeneration({ ...t.generation, feedback }); },
  ]) {
    const { result, trusted } = fixture(); change(trusted);
    assert.throws(() => adaptReviewerResult(result, trusted), change.toString());
  }
});

test("approval cannot hide any mandatory, blocker, human-needed or unsatisfied input", () => {
  for (const change of [
    r => { r.findings = [finding()]; }, r => { r.findings = [finding({ class: "should-fix" })]; },
    r => { r.findings = [finding({ mandatory: false })]; }, r => { r.findings = [finding({ class: "human-needed", mandatory: false })]; },
    r => { r.requirements[0].status = "unsatisfied"; }, r => { r.requirements[0].status = "human-needed"; },
    r => { r.humanFeedback[0].status = "deferred"; }, r => { r.humanFeedback[0].status = "blocked"; },
    r => { r.verdict = "request_changes"; },
  ]) {
    const { result, trusted } = fixture(); change(result);
    assert.throws(() => adaptReviewerResult(result, trusted), /inconsistent verdict/);
  }
  const { result, trusted } = fixture();
  result.findings = [finding({ class: "suggestion", mandatory: false })];
  assert.equal(adaptReviewerResult(result, trusted).reviewUpdate.disposition, "APPROVE");
});

test("finding enums, locations and concrete actions are enforced", () => {
  for (const change of [
    f => { f.class = "nice-to-have"; }, f => { f.status = "closed"; }, f => { f.mandatory = "yes"; },
    f => { delete f.owner; }, f => { delete f.nextAction; }, f => { delete f.recommendedResolution; },
    f => { f.evidence = ["test passed"]; }, f => { f.path = "../escape"; }, f => { f.path = "/absolute"; },
    f => { f.line = 1; }, f => { f.path = "file.mjs"; f.line = -1; }, f => { f.kind = "other"; },
    f => { f.requirementId = "R-unknown"; },
  ]) {
    const { result, trusted } = fixture(); result.verdict = "request_changes"; result.findings = [finding()];
    change(result.findings[0]); assert.throws(() => adaptReviewerResult(result, trusted), change.toString());
  }
});

test("unresolved IDs and mandatory classifications survive subsequent review and legacy workpads", () => {
  const { result, trusted } = fixture({ requirements: [], findings: [finding()], humanFeedback: [] });
  assert.throws(() => adaptReviewerResult(result, trusted), /unresolved finding omitted/);
  result.findings = [finding({ status: "resolved", mandatory: false })];
  assert.throws(() => adaptReviewerResult(result, trusted), /history weakened/);
  result.findings = [finding({ status: "resolved", class: "suggestion" })];
  assert.throws(() => adaptReviewerResult(result, trusted), /history weakened/);
  result.findings = [finding({ status: "resolved", path: "file.mjs", line: 12 })];
  const saved = persist(result, trusted);
  assert.equal(saved.workpad.findings[0].status, "open");
  assert.equal(saved.workpad.findings.at(-1).id, "F1");
  assert.equal(readReviewerResult(saved).findings[0].line, 12);
  result.findings = [finding()]; result.verdict = "request_changes";
  const nonApproval = persist(result, trusted);
  assert.equal(nonApproval.workpad.disposition, "COMMENT");
  assert.equal(readReviewerResult(nonApproval).verdict, "request_changes");
  assert.throws(() => adaptReviewerResult(result, nonApproval), /Superseded/);
});

test("repository legacy Markdown retains history, stable IDs, feedback and coordination", () => {
  const legacy = parseCadenceWorkpad(readFileSync(new URL(
    "../../../scripts/cadence-linear-workpad-fixtures/sequence-three-beta.md", import.meta.url), "utf8"));
  legacy.coordination = { nonReviewWakeups: [{ id: "event-1" }] };
  const { result, trusted } = fixture(legacy);
  trusted.requirements = [{ id: legacy.requirements[0].id, source: `${url}#requirement` }];
  result.requirements[0] = { ...result.requirements[0], ...trusted.requirements[0] };
  for (const old of legacy.humanFeedback) {
    trusted.humanFeedback.push({ id: old.id, source: "comments", sourceUrl: url, updatedAt: date, mandatory: true });
    result.humanFeedback.push({ id: old.id, source: "comments", sourceUrl: url, status: "addressed", reason: "Fixtures supplied" });
  }
  result.findings = legacy.findings.map(old => finding({ id: old.id, class: old.class, status: "resolved",
    mandatory: ["blocker", "human-needed"].includes(old.class) }));
  const saved = persist(result, trusted);
  assert.deepEqual(saved.workpad.history.slice(0, legacy.history.length), legacy.history);
  assert.deepEqual(saved.workpad.learnFromHuman, legacy.learnFromHuman);
  assert.deepEqual(saved.workpad.coordination, legacy.coordination);
  assert.equal(saved.workpad.requirements.at(-1).id, legacy.requirements[0].id);
  assert.equal(saved.workpad.humanFeedback.some(item => item.id === legacy.humanFeedback[0].id), true);
  assert.equal(readReviewerResult(saved).verdict, "approve");
});

test("credential execution inputs request changes; replanning requires a changed requirement", () => {
  const { result, trusted } = fixture();
  result.verdict = "request_changes";
  result.findings = [finding({ class: "human-needed", kind: "execution-input", summary: "Credential unavailable" })];
  assert.equal(adaptReviewerResult(result, trusted).reviewUpdate.disposition, "COMMENT");
  result.verdict = "escalate_to_replan";
  assert.throws(() => adaptReviewerResult(result, trusted), /replan/);
  result.replan = { requirementId: "R1", changedRequirement: "New requirement from human feedback",
    affectedScope: "Result adapter", recommendedDecision: "Amend the accepted requirement" };
  result.requirements[0].status = "human-needed";
  assert.throws(() => adaptReviewerResult(result, trusted), /changed requirement/);
  result.findings.push(finding({ id: "F2", kind: "requirement-change", requirementId: "R1" }));
  assert.equal(readReviewerResult(persist(result, trusted)).verdict, "escalate_to_replan");
});

test("consumer rejects absent, corrupted, stale and differently attributed records without prose fallback", () => {
  for (const change of [
    t => { delete t.workpad.reviewContract.output; }, t => { t.workpad.reviewContract.phase = "operational-error"; },
    t => { t.workpad.reviewContract.output.summary = "Approved"; }, t => { t.requestId = "new-request"; },
    t => { t.provenance.runAttempt = 2; }, t => { t.workpad.reviewContract.ledger.findings.push(finding()); },
  ]) {
    const { result, trusted } = fixture(); const saved = persist(result, trusted); change(saved);
    assert.throws(() => readReviewerResult(saved), change.toString());
  }
});

test("older contract ledger entries cannot be weakened or hidden behind a new source namespace", () => {
  const { result, trusted } = fixture();
  trusted.workpad.reviewContract.ledger.humanFeedback = [{ ...trusted.humanFeedback[0], status: "blocked", summary: "Still needed" }];
  trusted.humanFeedback[0].mandatory = false;
  assert.throws(() => adaptReviewerResult(result, trusted), /mandatory history/);
  trusted.humanFeedback[0].mandatory = true;
  trusted.workpad.reviewContract.ledger.requirements = [
    { ...result.requirements[0], source: "old-source", status: "unsatisfied" },
    { ...result.requirements[0], source: "new-source" },
  ];
  assert.throws(() => adaptReviewerResult(result, trusted), /unresolved acceptance ledger/);
  trusted.workpad.reviewContract.ledger.requirements = [];
  trusted.workpad.reviewContract.ledger.findings = [finding({ mandatory: false, class: "suggestion" })];
  assert.throws(() => adaptReviewerResult(result, trusted), /unresolved finding omitted/);
});

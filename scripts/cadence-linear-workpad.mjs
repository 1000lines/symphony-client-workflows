#!/usr/bin/env node
// Create or update Cadence's single Linear issue workpad comment.
//
// Auth:   LINEAR_API_TOKEN or LINEAR_API_KEY with comment create/update access.
// Usage:  node scripts/cadence-linear-workpad.mjs <issue-identifier> <workpad-json-file>
//         node scripts/cadence-linear-workpad.mjs DEMO-112 -

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { completeReviewGeneration, queueReviewGeneration, startReviewGeneration, reviewDigest } from "./symphony/review-contract.mjs";

const API_URL = "https://api.linear.app/graphql";

export const CADENCE_WORKPAD_HEADING = "## Cadence Workpad";
export const CADENCE_WORKPAD_SCHEMA_VERSION = "cadence-workpad/v1alpha1";
export const CADENCE_WORKPAD_MAX_COMMENT_CHARS = 50000;

const REVIEW_OBJECT_HEADING = "### Review Object";
const REVIEW_IDS = "α β γ δ ε ζ η θ ι κ λ μ ν ξ ο π ρ σ τ υ φ χ ψ ω".split(" ");
const COMPACT_ARRAY_ITEMS = 12;
const COMPACT_TEXT_CHARS = 1200;
const MINIMAL_TEXT_CHARS = 600;

const ISSUE_COMMENTS_QUERY = `query CadenceWorkpadIssue($id: String!, $after: String) {
  issue(id: $id) {
    id
    identifier
    comments(first: 100, after: $after) {
      nodes { id body createdAt updatedAt }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const CREATE_COMMENT_MUTATION = `mutation CreateCadenceWorkpad($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment { id }
  }
}`;

const UPDATE_COMMENT_MUTATION = `mutation UpdateCadenceWorkpad($commentId: String!, $body: String!) {
  commentUpdate(id: $commentId, input: { body: $body }) {
    success
    comment { id }
  }
}`;

const missing = "(none)";

const firstPresent = (workpad, keys) => {
  for (const key of keys) {
    const value = workpad[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
};

const field = (workpad, keys, fallback = missing) => {
  const value = firstPresent(workpad, keys);
  return value === undefined ? fallback : inline(value);
};

const inline = (value) => {
  if (value === undefined || value === null || value === "") return missing;
  return String(value).replace(/\s+/g, " ").trim() || missing;
};

const firstNonBlankLine = (body) =>
  typeof body === "string"
    ? body.split(/\r?\n/).find((line) => line.trim() !== "") || ""
    : "";

const sortValue = (value) => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortValue(value[key])])
  );
};

const blockItem = (value) => {
  if (!value || typeof value !== "object") return inline(value);
  return JSON.stringify(sortValue(value));
};

const block = (value) => {
  if (value === undefined || value === null || value === "") return missing;
  if (Array.isArray(value)) {
    if (!value.length) return missing;
    return value.map((item) => `- ${blockItem(item)}`).join("\n");
  }
  if (typeof value === "object") {
    return `\`\`\`json\n${JSON.stringify(sortValue(value), null, 2)}\n\`\`\``;
  }
  return String(value).trim() || missing;
};

const asArray = (value) => {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value : [value];
};

const normalizeHistoryItem = (item) => {
  if (!item || typeof item !== "object") {
    return {
      id: missing,
      reviewedAt: missing,
      range: missing,
      sha: missing,
      humanComments: missing,
      summary: inline(item),
    };
  }
  return {
    id: field(item, ["id", "review", "reviewId"]),
    reviewedAt: field(item, ["reviewedAt", "timestamp"]),
    range: field(item, ["range", "reviewedRange"]),
    sha: field(item, ["sha", "reviewedSha", "lastReviewedSha"]),
    humanComments: field(item, ["humanComments", "newHumanComments"], "0"),
    summary: field(item, ["summary", "notes", "description"]),
  };
};

const normalizeHumanFeedbackItem = (item) => {
  if (!item || typeof item !== "object") {
    return {
      review: missing,
      actor: missing,
      id: missing,
      status: "other",
      summary: inline(item),
    };
  }
  return {
    ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {}),
    ...(item.source !== undefined ? { source: item.source } : {}),
    ...(item.mandatory !== undefined ? { mandatory: item.mandatory } : {}),
    review: field(item, ["review", "reviewId", "update"]),
    actor: field(item, ["actor", "author", "user"]),
    id: field(item, ["id", "feedbackId"]),
    status: field(item, ["status", "disposition"], "other"),
    summary: field(item, ["summary", "body", "notes", "description"]),
  };
};

const normalizeRequirementItem = (item) => {
  if (!item || typeof item !== "object") {
    return {
      review: missing,
      id: missing,
      status: "other",
      source: missing,
      summary: inline(item),
    };
  }
  return {
    ...(item.evidence !== undefined ? { evidence: item.evidence } : {}),
    review: field(item, ["review", "reviewId", "update"]),
    id: field(item, ["id", "requirementId"]),
    status: field(item, ["status", "state"], "other"),
    source: field(item, ["source", "locality"], missing),
    summary: field(item, ["summary", "description", "notes"]),
  };
};

const normalizeFindingItem = (item) => {
  if (!item || typeof item !== "object") {
    return {
      review: missing,
      id: missing,
      lifecycle: "other",
      class: "other",
      locality: "other",
      severity: missing,
      status: "open",
      summary: inline(item),
    };
  }
  return {
    ...(item.mandatory !== undefined ? { mandatory: item.mandatory } : {}),
    ...(item.evidence !== undefined ? { evidence: item.evidence } : {}),
    review: field(item, ["review", "reviewId", "update"]),
    id: field(item, ["id", "findingId"]),
    lifecycle: field(item, ["lifecycle", "state"], "other"),
    class: field(item, ["class", "kind", "type"], "other"),
    locality: field(item, ["locality", "scope"], "other"),
    severity: field(item, ["severity"], missing),
    status: field(item, ["status"], "open"),
    summary: field(item, ["summary", "description", "body", "notes"]),
  };
};

const normalizeLearnFromHumanItem = (item) => {
  if (!item || typeof item !== "object") {
    return {
      review: missing,
      id: missing,
      status: "open",
      summary: inline(item),
    };
  }
  return {
    review: field(item, ["review", "reviewId", "update"]),
    id: field(item, ["id", "learningId"]),
    status: field(item, ["status"], "open"),
    summary: field(item, ["summary", "description", "notes"]),
  };
};

export const normalizeCadenceWorkpad = (workpad = {}) => ({
  ...(workpad.reviewContract ? { reviewContract: workpad.reviewContract,
    reviewContractHistory: workpad.reviewContractHistory || [] } : {}),
  schemaVersion: field(
    workpad,
    ["schemaVersion", "schema"],
    CADENCE_WORKPAD_SCHEMA_VERSION
  ),
  status: field(workpad, ["status", "runState"]),
  triggerSource: field(workpad, ["triggerSource", "trigger"]),
  reviewState: field(workpad, ["reviewState"]),
  disposition: field(workpad, ["disposition", "reviewDisposition"]),
  remainingHumanReviewEffort: field(workpad, ["remainingHumanReviewEffort"]),
  lastReviewedSha: field(workpad, ["lastReviewedSha", "reviewedSha"]),
  lastReviewedAt: field(workpad, ["lastReviewedAt", "lastReviewedTimestamp"]),
  pendingTriggerState: field(workpad, ["pendingTriggerState"]),
  pendingCommentState: field(workpad, ["pendingCommentState"]),
  summary: firstPresent(workpad, ["summary", "reviewSummary"]) ?? missing,
  history: asArray(firstPresent(workpad, ["history", "reviewHistory"])).map(
    normalizeHistoryItem
  ),
  humanFeedback: asArray(
    firstPresent(workpad, ["humanFeedback", "humanReviewFeedback"])
  ).map(normalizeHumanFeedbackItem),
  requirements: asArray(workpad.requirements).map(normalizeRequirementItem),
  findings: asArray(workpad.findings).map(normalizeFindingItem),
  githubAssessmentSummary:
    firstPresent(workpad, ["githubAssessmentSummary", "assessmentSummary"]) ??
    missing,
  detailedFindings:
    firstPresent(workpad, ["detailedFindings", "legacyFindings"]) ?? missing,
  skippedEvents:
    firstPresent(workpad, ["skippedEvents", "ignoredEvents"]) ?? [],
  previousRun: field(workpad, ["previousRun"]),
  pendingRerun: field(workpad, ["pendingRerun"]),
  coordination:
    firstPresent(workpad, ["coordination", "aiCoordination"]) ?? missing,
  learnFromHuman: asArray(workpad.learnFromHuman).map(
    normalizeLearnFromHumanItem
  ),
  seeAlso: firstPresent(workpad, ["seeAlso"]) ?? [],
  other: firstPresent(workpad, ["other"]) ?? [],
});

const renderHistory = (items) =>
  items.length
    ? items
        .map(
          (item) =>
            `- **${item.id} ${item.reviewedAt}** \`${item.range}\` - human comments: ${item.humanComments}; ${item.summary}`
        )
        .join("\n")
    : missing;

const renderHumanFeedback = (items) =>
  items.length
    ? items
        .map(
          (item) =>
            `- **${item.review}** ${item.actor} ${item.id} - status: ${item.status}; ${item.summary}`
        )
        .join("\n")
    : missing;

const renderRequirements = (items) =>
  items.length
    ? items
        .map(
          (item) =>
            `- **${item.id}** - review: ${item.review}; status: ${item.status}; source: ${item.source}; ${item.summary}`
        )
        .join("\n")
    : missing;

const renderFindings = (items) =>
  items.length
    ? items
        .map(
          (item) =>
            `- **${item.id}** - review: ${item.review}; lifecycle: ${item.lifecycle}; class: ${item.class}; locality: ${item.locality}; severity: ${item.severity}; status: ${item.status}; ${item.summary}`
        )
        .join("\n")
    : missing;

const renderLearnFromHuman = (items) =>
  items.length
    ? items
        .map(
          (item) =>
            `- **${item.id}** - review: ${item.review}; status: ${item.status}; ${item.summary}`
        )
        .join("\n")
    : missing;

export const renderCadenceWorkpad = (workpad = {}) => {
  const normalized = normalizeCadenceWorkpad(workpad);

  return [
    CADENCE_WORKPAD_HEADING,
    "",
    `Schema: ${normalized.schemaVersion}`,
    `Status: ${normalized.status}`,
    `Trigger source: ${normalized.triggerSource}`,
    `Review state: ${normalized.reviewState}`,
    `Disposition: ${normalized.disposition}`,
    `Remaining human review effort: ${normalized.remainingHumanReviewEffort}`,
    `Last reviewed PR SHA: ${normalized.lastReviewedSha}`,
    `Last reviewed timestamp: ${normalized.lastReviewedAt}`,
    `Pending trigger state: ${normalized.pendingTriggerState}`,
    `Pending comment state: ${normalized.pendingCommentState}`,
    "",
    "### Summary",
    block(normalized.summary),
    "",
    "### History",
    renderHistory(normalized.history),
    "",
    "### Human Feedback",
    renderHumanFeedback(normalized.humanFeedback),
    "",
    "### Requirements",
    renderRequirements(normalized.requirements),
    "",
    "### Findings",
    renderFindings(normalized.findings),
    "",
    "### GitHub-visible Assessment Summary",
    block(normalized.githubAssessmentSummary),
    "",
    "### Detailed Findings",
    block(normalized.detailedFindings),
    "",
    "### Skipped / Ignored Events",
    block(normalized.skippedEvents),
    "",
    "### Previous / Pending Rerun Information",
    `Previous run: ${normalized.previousRun}`,
    `Pending rerun: ${normalized.pendingRerun}`,
    "",
    "### AI-to-AI Coordination",
    block(normalized.coordination),
    "",
    "### Learn From Human",
    renderLearnFromHuman(normalized.learnFromHuman),
    "",
    "### See Also",
    block(normalized.seeAlso),
    "",
    "### Other",
    block(normalized.other),
    "",
    REVIEW_OBJECT_HEADING,
    "```json",
    JSON.stringify(sortValue(normalized), null, 2),
    "```",
    "",
  ].join("\n");
};

const truncateText = (value, maxChars) => {
  if (typeof value !== "string" || value.length <= maxChars) return value;
  if (maxChars <= 40) return value.slice(0, maxChars);
  return `${value
    .slice(0, maxChars - 35)
    .trimEnd()}... [truncated for Linear limit]`;
};

const compactValue = (value, maxChars = COMPACT_TEXT_CHARS) => {
  if (Array.isArray(value))
    return value.map((item) => compactValue(item, maxChars));
  if (!value || typeof value !== "object") return truncateText(value, maxChars);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      compactValue(entry, maxChars),
    ])
  );
};

const compactArray = (items, label, omitted) => {
  const values = asArray(items);
  if (values.length <= COMPACT_ARRAY_ITEMS) {
    return values.map((item) => compactValue(item));
  }

  omitted.push(
    `${label}: ${values.length - COMPACT_ARRAY_ITEMS} older entries`
  );
  return values.slice(-COMPACT_ARRAY_ITEMS).map((item) => compactValue(item));
};

export const compactCadenceWorkpadForCommentLimit = (workpad = {}) => {
  const normalized = normalizeCadenceWorkpad(workpad);
  const omitted = [];
  const compacted = {
    ...normalized,
    summary: compactValue(normalized.summary),
    githubAssessmentSummary: compactValue(normalized.githubAssessmentSummary),
    detailedFindings: compactValue(normalized.detailedFindings),
    skippedEvents: compactArray(
      normalized.skippedEvents,
      "skipped events",
      omitted
    ),
    coordination: compactValue(normalized.coordination),
    history: compactArray(normalized.history, "history", omitted),
    humanFeedback: compactArray(
      normalized.humanFeedback,
      "human feedback",
      omitted
    ),
    requirements: compactArray(
      normalized.requirements,
      "requirements",
      omitted
    ),
    findings: compactArray(normalized.findings, "findings", omitted),
    learnFromHuman: compactArray(
      normalized.learnFromHuman,
      "learn-from-human entries",
      omitted
    ),
    seeAlso: compactArray(normalized.seeAlso, "see-also entries", omitted),
    other: compactArray(normalized.other, "other entries", omitted),
  };

  compacted.other = [
    ...asArray(compacted.other),
    `Compacted to stay under Linear's comment-size limit; ${
      omitted.length ? omitted.join("; ") : "long text fields were shortened"
    }. Current state and recent entries remain in this comment.`,
  ];

  return normalizeCadenceWorkpad(compacted);
};

const nonReviewCoordination = (coordination) =>
  Object.fromEntries(
    ["nonReviewWakeups", "lastNonReviewWakeup"]
      .filter((key) => coordination?.[key] !== undefined)
      .map((key) => [key, coordination[key]])
  );

const minimalCadenceWorkpadForCommentLimit = (workpad = {}) => {
  const normalized = normalizeCadenceWorkpad(workpad);
  const bridgeState = compactValue(
    nonReviewCoordination(normalized.coordination),
    MINIMAL_TEXT_CHARS
  );
  const note =
    "Cadence Workpad was reduced to the latest state and newest entries to keep the single Linear comment writable.";
  return normalizeCadenceWorkpad({
    schemaVersion: normalized.schemaVersion,
    status: normalized.status,
    triggerSource: normalized.triggerSource,
    reviewState: normalized.reviewState,
    disposition: normalized.disposition,
    remainingHumanReviewEffort: normalized.remainingHumanReviewEffort,
    lastReviewedSha: normalized.lastReviewedSha,
    lastReviewedAt: normalized.lastReviewedAt,
    pendingTriggerState: normalized.pendingTriggerState,
    pendingCommentState: normalized.pendingCommentState,
    summary: compactValue(normalized.summary, MINIMAL_TEXT_CHARS),
    history: normalized.history
      .slice(-3)
      .map((item) => compactValue(item, MINIMAL_TEXT_CHARS)),
    humanFeedback: normalized.humanFeedback
      .slice(-3)
      .map((item) => compactValue(item, MINIMAL_TEXT_CHARS)),
    requirements: normalized.requirements
      .slice(-3)
      .map((item) => compactValue(item, MINIMAL_TEXT_CHARS)),
    findings: normalized.findings
      .slice(-3)
      .map((item) => compactValue(item, MINIMAL_TEXT_CHARS)),
    githubAssessmentSummary: compactValue(
      normalized.githubAssessmentSummary,
      MINIMAL_TEXT_CHARS
    ),
    detailedFindings:
      "Older detailed findings were compacted because the Cadence Workpad reached Linear's comment-size limit.",
    skippedEvents: [],
    previousRun: normalized.previousRun,
    pendingRerun: normalized.pendingRerun,
    // Review compaction must not erase the bridge's duplicate-event guard.
    coordination: Object.keys(bridgeState).length
      ? { ...bridgeState, reviewCoordination: note }
      : note,
    learnFromHuman: normalized.learnFromHuman
      .slice(-3)
      .map((item) => compactValue(item, MINIMAL_TEXT_CHARS)),
    seeAlso: [],
    other: [
      "Compacted to stay under Linear's comment-size limit; retained latest state and newest review entries only.",
    ],
  });
};

export const renderCadenceWorkpadForLinear = (
  workpad = {},
  { maxCommentChars = CADENCE_WORKPAD_MAX_COMMENT_CHARS } = {}
) => {
  const body = renderCadenceWorkpad(workpad);
  if (body.length <= maxCommentChars) {
    return {
      body,
      compacted: false,
      workpad: normalizeCadenceWorkpad(workpad),
    };
  }

  // The ordinary layout repeats every field in Markdown and in canonical JSON.
  // Keep one complete copy before discarding any review history or evidence.
  const normalized = normalizeCadenceWorkpad(workpad);
  const canonicalBody = [
    body.slice(0, body.indexOf("### Summary")),
    "Display detail omitted to fit Linear's comment-size limit. The complete review state and wakeup evidence remain in the Review Object below.",
    "",
    REVIEW_OBJECT_HEADING,
    "```json",
    JSON.stringify(sortValue(normalized), null, 2),
    "```",
    "",
  ].join("\n");
  if (canonicalBody.length <= maxCommentChars) {
    return { body: canonicalBody, compacted: false, workpad: normalized };
  }

  if (normalized.reviewContract) {
    throw new Error("Review contract/history exceeds Linear comment-size budget; durable evidence cannot be truncated.");
  }

  const compacted = compactCadenceWorkpadForCommentLimit(workpad);
  const compactedBody = renderCadenceWorkpad(compacted);
  if (compactedBody.length <= maxCommentChars) {
    return { body: compactedBody, compacted: true, workpad: compacted };
  }

  const minimal = minimalCadenceWorkpadForCommentLimit(workpad);
  const minimalBody = renderCadenceWorkpad(minimal);
  if (minimalBody.length <= maxCommentChars) {
    return { body: minimalBody, compacted: true, workpad: minimal };
  }

  throw new Error(
    `Cadence Workpad cannot fit within the configured Linear comment-size budget (${maxCommentChars} characters).`
  );
};

export const isCadenceWorkpadBody = (body) =>
  firstNonBlankLine(body) === CADENCE_WORKPAD_HEADING;

export const findCadenceWorkpadComments = (comments = []) =>
  comments
    .filter((comment) => isCadenceWorkpadBody(comment.body))
    .sort(
      (a, b) =>
        inline(a.createdAt).localeCompare(inline(b.createdAt)) ||
        inline(a.id).localeCompare(inline(b.id))
    );

export const findCadenceWorkpadComment = (comments = []) =>
  findCadenceWorkpadComments(comments)[0];

const escapeRegExp = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseLine = (body, label) => {
  const match = body.match(
    new RegExp(`^${escapeRegExp(label)}:\\s*(.*)$`, "m")
  );
  return match?.[1];
};

const parseSection = (body, heading) => {
  const match = body.match(
    new RegExp(
      `^### ${escapeRegExp(heading)}\\s*\\n([\\s\\S]*?)(?=\\n### |\\n$)`,
      "m"
    )
  );
  return match?.[1]?.trim();
};

const parseLegacyWorkpad = (body) =>
  normalizeCadenceWorkpad({
    status: parseLine(body, "Status"),
    triggerSource: parseLine(body, "Trigger source"),
    reviewState: parseLine(body, "Review state"),
    lastReviewedSha: parseLine(body, "Last reviewed PR SHA"),
    lastReviewedAt: parseLine(body, "Last reviewed timestamp"),
    pendingTriggerState: parseLine(body, "Pending trigger state"),
    pendingCommentState: parseLine(body, "Pending comment state"),
    githubAssessmentSummary: parseSection(
      body,
      "GitHub-visible Assessment Summary"
    ),
    detailedFindings: parseSection(body, "Detailed Findings"),
    skippedEvents: parseSection(body, "Skipped / Ignored Events"),
    previousRun: parseLine(body, "Previous run"),
    pendingRerun: parseLine(body, "Pending rerun"),
    coordination: parseSection(body, "AI-to-AI Coordination"),
  });

export const parseCadenceWorkpad = (body) => {
  if (!isCadenceWorkpadBody(body)) {
    throw new Error("Markdown does not start with a Cadence Workpad heading.");
  }

  const headings = [...body.matchAll(new RegExp(`^${escapeRegExp(REVIEW_OBJECT_HEADING)}[ \t]*\r?$`, "gm"))];
  if (!headings.length) {
    if (body.includes('"reviewContract"')) throw new Error("Unreadable Cadence review contract");
    return parseLegacyWorkpad(body);
  }
  const last = headings[headings.length - 1];
  const match = body.slice(last.index + last[0].length).match(/^\s*\n```json\s*\n([\s\S]*?)\n```/);
  if (!match) throw new Error("Cadence Workpad review object is unreadable");

  try {
    return normalizeCadenceWorkpad(JSON.parse(match[1]));
  } catch (error) {
    throw new Error(
      `Cadence Workpad review object is not valid JSON: ${error.message}`
    );
  }
};

export const formatReviewTimestamp = (date = new Date()) => {
  const parsed = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(parsed.valueOf())) return inline(date);

  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(parsed.getUTCMonth() + 1)}-${pad(parsed.getUTCDate())} ${pad(
    parsed.getUTCHours()
  )}:${pad(parsed.getUTCMinutes())}Z`;
};

const isoTimestamp = (date) => {
  const parsed = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(parsed.valueOf())) return inline(date);
  return parsed.toISOString().replace(".000Z", "Z");
};

const nextReviewId = (history) => {
  const used = new Set(history.map((entry) => entry.id));
  return (
    REVIEW_IDS.find((id) => !used.has(id)) || `review-${history.length + 1}`
  );
};

const appendReviewItems = (items, reviewId, normalizer) =>
  asArray(items).map((item) =>
    normalizer(
      item && typeof item === "object" && !item.review && !item.reviewId
        ? { review: reviewId, ...item }
        : item
    )
  );

export const applyReviewUpdate = (
  currentWorkpad = {},
  reviewUpdate = {},
  { now = new Date() } = {}
) => {
  const current = normalizeCadenceWorkpad(currentWorkpad);
  const reviewId =
    firstPresent(reviewUpdate, ["id", "review", "reviewId"]) ||
    nextReviewId(current.history);
  const reviewedAt =
    firstPresent(reviewUpdate, ["reviewedAt", "timestamp"]) ||
    formatReviewTimestamp(now);
  const lastReviewedSha =
    firstPresent(reviewUpdate, ["lastReviewedSha", "reviewedSha", "sha"]) ||
    current.lastReviewedSha;
  const lastReviewedAt =
    firstPresent(reviewUpdate, ["lastReviewedAt", "lastReviewedTimestamp"]) ||
    isoTimestamp(now);

  const historyEntry = normalizeHistoryItem({
    id: reviewId,
    reviewedAt,
    range: firstPresent(reviewUpdate, ["range", "reviewedRange"]),
    sha: lastReviewedSha,
    humanComments: firstPresent(reviewUpdate, [
      "humanComments",
      "newHumanComments",
    ]),
    summary: firstPresent(reviewUpdate, ["summary", "notes", "description"]),
  });

  return normalizeCadenceWorkpad({
    ...current,
    status:
      firstPresent(reviewUpdate, ["status", "runState"]) || current.status,
    triggerSource:
      firstPresent(reviewUpdate, ["triggerSource", "trigger"]) ||
      current.triggerSource,
    reviewState: reviewUpdate.reviewState || current.reviewState,
    disposition:
      firstPresent(reviewUpdate, ["disposition", "reviewDisposition"]) ||
      current.disposition,
    remainingHumanReviewEffort:
      reviewUpdate.remainingHumanReviewEffort ||
      current.remainingHumanReviewEffort,
    lastReviewedSha,
    lastReviewedAt,
    pendingTriggerState:
      reviewUpdate.pendingTriggerState || current.pendingTriggerState,
    pendingCommentState:
      reviewUpdate.pendingCommentState || current.pendingCommentState,
    summary:
      firstPresent(reviewUpdate, ["summary", "reviewSummary"]) ||
      current.summary,
    history: [...current.history, historyEntry],
    humanFeedback: [
      ...current.humanFeedback,
      ...appendReviewItems(
        firstPresent(reviewUpdate, ["humanFeedback", "humanReviewFeedback"]),
        reviewId,
        normalizeHumanFeedbackItem
      ),
    ],
    requirements: [
      ...current.requirements,
      ...appendReviewItems(
        reviewUpdate.requirements,
        reviewId,
        normalizeRequirementItem
      ),
    ],
    findings: [
      ...current.findings,
      ...appendReviewItems(
        reviewUpdate.findings,
        reviewId,
        normalizeFindingItem
      ),
    ],
    githubAssessmentSummary:
      firstPresent(reviewUpdate, [
        "githubAssessmentSummary",
        "assessmentSummary",
      ]) || current.githubAssessmentSummary,
    detailedFindings: reviewUpdate.detailedFindings || current.detailedFindings,
    skippedEvents:
      firstPresent(reviewUpdate, ["skippedEvents", "ignoredEvents"]) ||
      current.skippedEvents,
    previousRun:
      firstPresent(reviewUpdate, ["previousRun"]) ||
      (current.lastReviewedAt === missing
        ? current.previousRun
        : current.lastReviewedAt),
    pendingRerun: reviewUpdate.pendingRerun || current.pendingRerun,
    coordination:
      firstPresent(reviewUpdate, ["coordination", "aiCoordination"]) ||
      current.coordination,
    learnFromHuman: [
      ...current.learnFromHuman,
      ...appendReviewItems(
        reviewUpdate.learnFromHuman,
        reviewId,
        normalizeLearnFromHumanItem
      ),
    ],
    seeAlso: [...asArray(current.seeAlso), ...asArray(reviewUpdate.seeAlso)],
    other: [...asArray(current.other), ...asArray(reviewUpdate.other)],
  });
};

export const resolveWorkpadInput = ({
  incomingWorkpad = {},
  existingBody,
  now = new Date(),
  liveGeneration,
} = {}) => {
  const { reviewUpdate, ...currentFields } = incomingWorkpad;
  let existingWorkpad = {};
  let recoveryNote;
  if (existingBody) {
    try {
      existingWorkpad = parseCadenceWorkpad(existingBody);
    } catch (error) {
      if (existingBody.includes('"reviewContract"')) throw error;
      // A complete snapshot can repair malformed canonical JSON. Recover the
      // bridge ledger from its duplicate display section first; incremental
      // updates still require readable canonical review history.
      if (reviewUpdate || !isCadenceWorkpadBody(existingBody)) throw error;
      const section = parseSection(existingBody, "AI-to-AI Coordination");
      const json = section?.match(/^```json\s*\n([\s\S]*?)\n```$/)?.[1];
      if (!json && /nonReviewWakeups|lastNonReviewWakeup/.test(existingBody))
        throw error;
      existingWorkpad = { coordination: json ? JSON.parse(json) : {} };
      recoveryNote =
        "Replaced malformed review JSON from a full snapshot; recovered bridge coordination from the display section when present.";
    }
  }
  let resolved = reviewUpdate
    ? applyReviewUpdate(
        { ...existingWorkpad, ...currentFields },
        reviewUpdate,
        { now }
      )
    : recoveryNote
    ? {
        ...incomingWorkpad,
        other: [...asArray(incomingWorkpad.other), recoveryNote],
      }
    : incomingWorkpad;
  if (existingWorkpad.reviewContract || resolved.reviewContract) {
    resolved = preserveReviewContract(existingWorkpad, resolved, liveGeneration);
  }
  // Event-gate payloads replace review fields wholesale. The non-review bridge
  // owns these two fields; preserve the latest stored values even when a
  // reviewer supplies an older snapshot or a string coordination summary.
  const bridgeState = nonReviewCoordination(existingWorkpad.coordination);
  if (!Object.keys(bridgeState).length) return resolved;
  return {
    ...resolved,
    coordination: {
      ...(typeof resolved.coordination === "object" && resolved.coordination
        ? resolved.coordination
        : { reviewCoordination: resolved.coordination }),
      ...bridgeState,
    },
  };
};

// Serialized publishers re-read the pinned record before writing. This rejects
// stale snapshots; Linear has no CAS, so callers must still serialize per PR and
// recheck live head/feedback immediately before invoking a completion write.
function preserveReviewContract(existing, incoming, liveGeneration) {
  const current = existing.reviewContract;
  const next = incoming.reviewContract || current;
  if (reviewDigest(next) !== reviewDigest(current || null)) {
    let expected;
    if (next.phase === "queued") {
      expected = queueReviewGeneration(current, next.generation, { checkId: next.checkId,
        operationalRetry: Boolean(current && next.operationalRetries > current.operationalRetries) });
    } else if (next.phase === "in_progress") {
      expected = startReviewGeneration(current, liveGeneration);
    } else {
      expected = completeReviewGeneration(current, { ...next, generationId: next.generation.id }, liveGeneration);
    }
    if (reviewDigest(expected) !== reviewDigest(next)) throw new Error("Stale or invalid review contract transition");
  }
  const result = { ...incoming, reviewContract: next,
    reviewContractHistory: [...(existing.reviewContractHistory || []),
      ...(current && reviewDigest(current) !== reviewDigest(next) ? [current] : [])] };
  // Legacy event snapshots are bookkeeping, never authority to drop review data.
  for (const field of ["history", "requirements", "findings", "humanFeedback"]) {
    const entries = [...(existing[field] || []), ...(incoming[field] || [])];
    result[field] = [...new Map(entries.map(entry => [reviewDigest(entry), entry])).values()];
  }
  return result;
}

export const loadToken = (env = process.env) => {
  const token = env.LINEAR_API_TOKEN || env.LINEAR_API_KEY;
  if (!token) {
    throw new Error(
      "Set LINEAR_API_TOKEN or LINEAR_API_KEY to a Linear API token with permission to create and update Linear comments."
    );
  }
  return token;
};

const redact = (text, token) =>
  token ? String(text).split(token).join("[redacted]") : String(text);

const linearError = ({ operation, response, payload, token }) => {
  const detail = payload
    ? JSON.stringify(payload.errors || payload)
    : `HTTP ${response.status}`;
  const writeHint = /create|update/.test(operation)
    ? " Confirm LINEAR_API_TOKEN or LINEAR_API_KEY has permission to create and update Linear comments."
    : "";
  return new Error(
    `Linear API rejected ${operation}.${writeHint} Details: ${redact(
      detail,
      token
    )}`
  );
};

const linearRequest = async ({
  query,
  variables,
  token,
  operation,
  fetchImpl = fetch,
}) => {
  const response = await fetchImpl(API_URL, {
    method: "POST",
    headers: { authorization: token, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  if (!response.ok || payload?.errors?.length) {
    throw linearError({ operation, response, payload, token });
  }
  if (!payload) {
    throw linearError({
      operation,
      response,
      payload: { error: "Response body was not valid JSON." },
      token,
    });
  }
  return payload.data;
};

export const fetchIssueComments = async (
  issueIdentifier,
  token,
  { fetchImpl = fetch } = {}
) => {
  const comments = [];
  let issue;
  let after;
  const cursors = new Set();
  let complete = true;

  do {
    const data = await linearRequest({
      query: ISSUE_COMMENTS_QUERY,
      variables: { id: issueIdentifier, after },
      token,
      operation: "read issue comments",
      fetchImpl,
    });
    if (!data.issue) {
      throw new Error(`Linear issue "${issueIdentifier}" was not found.`);
    }
    issue = data.issue;
    if (!Array.isArray(issue.comments?.nodes) || typeof issue.comments.pageInfo?.hasNextPage !== "boolean") {
      // Legacy bridge adapters did not supply pageInfo. Preserve their read
      // interface, but never treat that response as complete review evidence.
      complete = false;
    }
    comments.push(...(issue.comments?.nodes || []));
    after = issue.comments?.pageInfo?.hasNextPage
      ? issue.comments.pageInfo.endCursor
      : undefined;
    if (issue.comments?.pageInfo?.hasNextPage && (!after || cursors.has(after))) {
      throw new Error("Incomplete Linear comment pagination");
    }
    cursors.add(after);
  } while (after);

  return { id: issue.id, identifier: issue.identifier, comments, complete };
};

const createComment = async (
  issueId,
  body,
  token,
  { fetchImpl = fetch } = {}
) => {
  const data = await linearRequest({
    query: CREATE_COMMENT_MUTATION,
    variables: { issueId, body },
    token,
    operation: "create Cadence workpad comment",
    fetchImpl,
  });
  const result = data.commentCreate;
  if (!result?.success || !result.comment?.id) {
    throw new Error(
      "Linear API did not create the Cadence workpad comment. Confirm LINEAR_API_TOKEN or LINEAR_API_KEY has permission to create Linear comments."
    );
  }
  return result.comment;
};

const updateComment = async (
  commentId,
  body,
  token,
  { fetchImpl = fetch } = {}
) => {
  const data = await linearRequest({
    query: UPDATE_COMMENT_MUTATION,
    variables: { commentId, body },
    token,
    operation: "update Cadence workpad comment",
    fetchImpl,
  });
  const result = data.commentUpdate;
  if (!result?.success || !result.comment?.id) {
    throw new Error(
      "Linear API did not update the Cadence workpad comment. Confirm LINEAR_API_TOKEN or LINEAR_API_KEY has permission to update Linear comments."
    );
  }
  return result.comment;
};

export const upsertCadenceWorkpad = async ({
  issueIdentifier,
  workpad,
  token,
  fetchImpl = fetch,
  now = new Date(),
  logger = console,
  maxCommentChars = CADENCE_WORKPAD_MAX_COMMENT_CHARS,
  liveGeneration,
}) => {
  if (!issueIdentifier) {
    throw new Error("A Linear issue identifier is required.");
  }

  const issue = await fetchIssueComments(issueIdentifier, token, { fetchImpl });
  const cadenceWorkpads = findCadenceWorkpadComments(issue.comments);
  const existing = cadenceWorkpads[0];
  const hasContract = workpad.reviewContract || cadenceWorkpads.some(comment => {
    try { return Boolean(parseCadenceWorkpad(comment.body).reviewContract); }
    catch { return comment.body.includes('"reviewContract"'); }
  });
  if (!issue.complete && hasContract) {
    throw new Error("Incomplete Linear comment history cannot establish acceptance");
  }
  if (cadenceWorkpads.length > 1) {
    if (hasContract) {
      throw new Error("Duplicate Cadence workpads cannot establish acceptance");
    }
    logger?.warn?.(
      `Found ${cadenceWorkpads.length} Cadence Workpad comments on ${issue.identifier}; updating the oldest (${existing.id}) and leaving duplicates for human cleanup.`
    );
  }

  const resolvedWorkpad = resolveWorkpadInput({
    incomingWorkpad: workpad,
    existingBody: existing?.body,
    now,
    liveGeneration,
  });
  const { body, compacted } = renderCadenceWorkpadForLinear(resolvedWorkpad, {
    maxCommentChars,
  });
  if (compacted) {
    logger?.warn?.(
      `Cadence Workpad on ${issue.identifier} exceeded ${maxCommentChars} characters; compacting older detail before writing the single workpad comment.`
    );
  }

  if (existing) {
    const comment = await updateComment(existing.id, body, token, {
      fetchImpl,
    });
    if (resolvedWorkpad.reviewContract) await verifyContractWrite(comment.id);
    return {
      operation: "updated",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      commentId: comment.id,
      body,
    };
  }

  const comment = await createComment(issue.id, body, token, { fetchImpl });
  if (resolvedWorkpad.reviewContract) await verifyContractWrite(comment.id);
  return {
    operation: "created",
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    commentId: comment.id,
    body,
  };

  async function verifyContractWrite(commentId) {
    const readback = await fetchIssueComments(issueIdentifier, token, { fetchImpl });
    const anchors = findCadenceWorkpadComments(readback.comments);
    if (!readback.complete || anchors.length !== 1 || anchors[0].id !== commentId || anchors[0].body !== body) {
      throw new Error("Cadence review persistence readback mismatch");
    }
  }
};

export const readWorkpadInput = (path, { readFile = readFileSync } = {}) => {
  const raw = path === "-" ? readFile(0, "utf8") : readFile(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Workpad input is not valid JSON: ${error.message}`);
  }
};

const main = async () => {
  const [issueIdentifier, inputPath] = process.argv.slice(2);
  if (!issueIdentifier || !inputPath) {
    throw new Error(
      "Usage: node scripts/cadence-linear-workpad.mjs <issue-identifier> <workpad-json-file|->"
    );
  }

  const result = await upsertCadenceWorkpad({
    issueIdentifier,
    workpad: readWorkpadInput(inputPath),
    token: loadToken(),
  });
  process.stdout.write(
    `${result.operation} Cadence Workpad comment ${result.commentId} on ${result.issueIdentifier}\n`
  );
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

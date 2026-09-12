#!/usr/bin/env node
// Compute the re-review state of a pull request, with no external dependencies.
//
// Reads the PR's GitHub timeline (one GraphQL call), finds our last review
// (the latest PullRequestReview by the reviewer login), and reports what has
// changed since — so a re-review can skip untouched PRs and otherwise review
// only the delta. The PR itself is the ledger; no external state is stored.
//
// Auth:  GH_TOKEN (existing App installation token with Metadata/PR read).
// Repo:  defaults to example-org/example-repo; override with REPO_SLUG=owner/name.
// Who:   the reviewer identity defaults to example-cadence-bot; override with
//        CADENCE_REVIEWER_LOGIN.
//
// Usage:   node scripts/fetch-pr-review-state.mjs <pr-number>
// Output:  JSON { decision, reviewStatus, staleApproval, headRefOid, isDraft,
//          lastReview, pagedOut, since, humanGroundedSince, workpadSince,
//          ignoredSince }
//
// decision is one of:
//   first-review        no prior review by us; review the whole PR
//   skip                we reviewed and nothing changed since
//   incremental         changed since our review; review since.baseOid..headRefOid
//   full-review-rebased head was force-pushed since our review; re-review fully
//   full-review-paged-out  legacy review is older than the 100-item window
//
// Legacy-only limit: timelineItems(last:100) is not paginated. If our review is >100
// events back it won't be found and we fall back to a full review (always safe,
// just redundant) — flagged as full-review-paged-out rather than failing silently.

import { fileURLToPath } from "node:url";
import { createReviewGeneration, evaluateAi, feedbackWatermark } from "./symphony/review-contract.mjs";
import {
  classifyGitHubActor,
  normalize,
  verifyGitHubHumanWriteAccess,
} from "./github-actor-classification.mjs";

const QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      headRefOid
      isDraft
      timelineItems(last:100, itemTypes:[PULL_REQUEST_COMMIT, ISSUE_COMMENT, PULL_REQUEST_REVIEW, HEAD_REF_FORCE_PUSHED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT]){
        pageInfo{ hasPreviousPage }
        nodes{
          __typename
          ... on PullRequestCommit{ commit{ oid committedDate author{ user{ login } } committer{ user{ login } } } }
          ... on IssueComment{ author{login __typename ... on User{databaseId}} createdAt }
          ... on PullRequestReview{ author{login __typename ... on User{databaseId}} submittedAt state commit{oid} }
          ... on HeadRefForcePushedEvent{ actor{login} createdAt afterCommit{oid} }
          ... on ReadyForReviewEvent{ actor{login} createdAt }
          ... on ConvertToDraftEvent{ actor{login} createdAt }
        }
      }
    }
  }
}`;

const actorOf = (node) =>
  node.author?.login ||
  node.actor?.login ||
  node.commit?.author?.user?.login ||
  node.commit?.committer?.user?.login ||
  null;

const timestampOf = (node) =>
  node.submittedAt || node.createdAt || node.commit?.committedDate || null;

const oidOf = (node) => node.commit?.oid || node.afterCommit?.oid || null;

const codeChangeTypes = new Set([
  "PullRequestCommit",
  "HeadRefForcePushedEvent",
]);

const classifyActivity = ({ node, reviewer, classifyActor }) => {
  const actor = actorOf(node);
  const actorClassification = classifyActor(actor);
  const isSelf = Boolean(actor) && normalize(actor) === normalize(reviewer);
  const isCodeChange = codeChangeTypes.has(node.__typename);
  const isFeedback = ["IssueComment", "PullRequestReview"].includes(node.__typename);
  const trustedHuman = isFeedback ? node.authority?.allowed === true : actorClassification.humanFacing;
  const reviewRelevant =
    !isSelf && (isCodeChange || trustedHuman);
  const humanGrounded = reviewRelevant && trustedHuman;

  return {
    type: node.__typename,
    actor,
    at: timestampOf(node),
    oid: oidOf(node),
    ...(node.state ? { state: node.state } : {}),
    actorClassification,
    ...(isFeedback ? { authority: node.authority || { allowed: false, contentTrust: "untrusted", reason: "permission-not-verified" } } : {}),
    isSelf,
    humanGrounded,
    reviewRelevant,
    routing: isSelf ? "ignore" : reviewRelevant ? "review" : "workpad",
  };
};

const runQuery = async (variables) => {
  const token = process.env.GH_TOKEN;
  if (!token) {
    throw new Error(
      "Set GH_TOKEN (a GitHub token with pull-request read access)."
    );
  }
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: QUERY, variables }),
  });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    throw new Error(
      `GitHub GraphQL error: ${JSON.stringify(payload.errors || payload)}`
    );
  }
  const pr = payload.data?.repository?.pullRequest;
  if (!pr) {
    throw new Error(
      `PR #${variables.number} not found in ${variables.owner}/${variables.repo}.`
    );
  }
  pr.timelineItems.nodes = await markFeedbackAuthority(pr.timelineItems.nodes, {
    repository: `${variables.owner}/${variables.repo}`, token,
  });
  return pr;
};

const reviewStatusFor = ({ decision, headRefOid, lastReview, since }) => {
  if (!lastReview) {
    return {
      reviewStatus:
        decision === "first-review" ? "unreviewed" : "full-re-review",
      staleApproval: false,
      staleApprovalReasons: [],
    };
  }

  if (lastReview.state === "APPROVED") {
    const staleApprovalReasons = [];
    if (!lastReview.oid) {
      staleApprovalReasons.push("missing-review-commit");
    } else if (lastReview.oid !== headRefOid) {
      staleApprovalReasons.push("head-sha-changed");
    }
    if (since.length > 0) {
      staleApprovalReasons.push("review-relevant-activity");
    }

    return {
      reviewStatus:
        staleApprovalReasons.length > 0 ? "stale-approval" : "fresh-approval",
      staleApproval: staleApprovalReasons.length > 0,
      staleApprovalReasons,
    };
  }

  if (decision === "skip") {
    return {
      reviewStatus: "skipped-review",
      staleApproval: false,
      staleApprovalReasons: [],
    };
  }

  return {
    reviewStatus:
      decision === "incremental" ? "incremental-re-review" : "full-re-review",
    staleApproval: false,
    staleApprovalReasons: [],
  };
};

export const classifyPrReviewState = (
  pr,
  reviewer,
  { classifyActor = classifyGitHubActor, acceptance } = {}
) => {
  if (acceptance) return classifyCheckReviewState({ ...acceptance, pullRequest: pr });
  const nodes = pr.timelineItems.nodes;
  const pagedOut = pr.timelineItems.pageInfo.hasPreviousPage;

  let anchorIndex = -1;
  let lastReview = null;
  nodes.forEach((node, i) => {
    if (
      node.__typename === "PullRequestReview" &&
      normalize(actorOf(node)) === normalize(reviewer)
    ) {
      anchorIndex = i;
      lastReview = {
        oid: node.commit?.oid || null,
        submittedAt: node.submittedAt,
        state: node.state,
      };
    }
  });

  if (anchorIndex === -1) {
    const decision = pagedOut ? "full-review-paged-out" : "first-review";
    return {
      decision,
      ...reviewStatusFor({
        decision,
        headRefOid: pr.headRefOid,
        lastReview: null,
        since: [],
      }),
      headRefOid: pr.headRefOid,
      isDraft: pr.isDraft,
      lastReview: null,
      pagedOut,
      since: [],
      humanGroundedSince: [],
      workpadSince: [],
      ignoredSince: [],
    };
  }

  const after = nodes
    .slice(anchorIndex + 1)
    .map((node) => classifyActivity({ node, reviewer, classifyActor }));
  const since = after.filter((activity) => activity.reviewRelevant);
  const humanGroundedSince = since.filter((activity) => activity.humanGrounded);
  const workpadSince = after.filter(
    (activity) => activity.routing === "workpad"
  );
  const ignoredSince = after.filter(
    (activity) => activity.routing === "ignore"
  );
  const rebased = since.some(
    (activity) => activity.type === "HeadRefForcePushedEvent"
  );

  let decision = "skip";
  if (rebased) decision = "full-review-rebased";
  else if (since.length > 0) decision = "incremental";

  const reviewStatus = reviewStatusFor({
    decision,
    headRefOid: pr.headRefOid,
    lastReview,
    since,
  });

  return {
    decision,
    ...reviewStatus,
    headRefOid: pr.headRefOid,
    isDraft: pr.isDraft,
    lastReview,
    pagedOut,
    since,
    humanGroundedSince,
    workpadSince,
    ignoredSince,
  };
};

// Complete feedback acquisition for CODEX/WAIT. Query callbacks are trusted API
// clients; callers must not pass PR-provided records as proof of completeness.
const feedbackFields = "id body updatedAt author { login __typename ... on User { databaseId } }";
const pageFields = "pageInfo { hasNextPage endCursor }";
const prConnectionQuery = (connection, fields) => `query Feedback($owner:String!,$repo:String!,$number:Int!,$after:String) {
  repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
    ${connection}(first:100,after:$after) { nodes { ${fields} } ${pageFields} }
  } }
}`;

async function collectPages(read, firstPage) {
  const nodes = [];
  const cursors = new Set();
  let after;
  do {
    const page = firstPage || await read(after);
    firstPage = undefined;
    if (!Array.isArray(page?.nodes) || typeof page.pageInfo?.hasNextPage !== "boolean")
      throw new Error("Incomplete feedback connection");
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return nodes;
    after = page.pageInfo.endCursor;
    if (!after || cursors.has(after)) throw new Error("Incomplete feedback cursor");
    cursors.add(after);
  } while (after);
  return nodes;
}

export async function markFeedbackAuthority(nodes, { repository, token, fetchImpl } = {}) {
  // Share duplicate author reads within this acquisition only. The next event
  // or acquisition gets a new map and observes revoked access.
  const authors = new Map();
  return Promise.all(nodes.map(async node => {
    const author = { login: node.author?.login, type: node.author?.__typename, id: node.author?.databaseId };
    const key = JSON.stringify([normalize(author.login), author.type, author.id]);
    if (!authors.has(key)) authors.set(key, verifyGitHubHumanWriteAccess({ author, repository, token, fetchImpl }));
    return { ...node, authority: await authors.get(key) };
  }));
}

export async function fetchReviewFeedback({ owner, repo, number, issueIdentifier, githubQuery, linearQuery,
  token = process.env.GH_TOKEN, fetchImpl = fetch }) {
  const variables = { owner, repo, number };
  const readPr = async (connection, fields, after) => {
    const result = await githubQuery(prConnectionQuery(connection, fields), { ...variables, after });
    if (result.errors?.length) throw new Error("GitHub feedback query failed");
    return result.data?.repository?.pullRequest?.[connection];
  };
  const sources = {};
  for (const [source, connection, fields] of [
    ["reviews", "reviews", `${feedbackFields} state submittedAt commit { oid }`],
    ["comments", "comments", feedbackFields],
    ["commits", "commits", `commit { oid message committedDate url author { user { login __typename } }
      committer { user { login __typename } } parents(first:1) { nodes { oid } } }`],
    ["threads", "reviewThreads", `id isResolved isOutdated comments(first:100) { nodes { ${feedbackFields} } ${pageFields} }`],
  ]) {
    try {
      let nodes = await collectPages(after => readPr(connection, fields, after));
      if (source === "commits") nodes = nodes.map(({ commit }) => ({
        id: commit.oid, body: commit.message, updatedAt: commit.committedDate, url: commit.url,
        author: commit.author?.user || commit.committer?.user,
        parentSha: commit.parents?.nodes?.[0]?.oid,
      }));
      if (source === "threads") {
        const comments = [];
        for (const thread of nodes) {
          const replies = await collectPages(async after => {
            const result = await githubQuery(`query ThreadReplies($id:ID!,$after:String) {
              node(id:$id) { ... on PullRequestReviewThread {
                comments(first:100,after:$after) { nodes { ${feedbackFields} } ${pageFields} }
              } }
            }`, { id: thread.id, after });
            if (result.errors?.length) throw new Error("Thread replies query failed");
            return result.data?.node?.comments;
          }, thread.comments);
          comments.push(...replies.map(reply => ({ ...reply, threadId: thread.id,
            isResolved: thread.isResolved, isOutdated: thread.isOutdated })));
        }
        nodes = comments;
      }
      sources[source] = { complete: true, nodes: await markFeedbackAuthority(nodes, {
        repository: `${owner}/${repo}`, token, fetchImpl,
      }) };
    } catch {
      sources[source] = { complete: false, nodes: [], error: `Unavailable ${source} history` };
    }
  }
  try {
    if (!issueIdentifier) throw new Error("Missing Linear association");
    const nodes = await collectPages(async after => {
      const result = await linearQuery(`query ReviewFeedback($id:String!,$after:String) {
        issue(id:$id) { comments(first:100,after:$after) {
          nodes { id body updatedAt user { id name } } ${pageFields}
        } }
      }`, { id: issueIdentifier, after });
      if (result.errors?.length) throw new Error("Linear feedback query failed");
      return result.data?.issue?.comments;
    });
    sources.linearComments = { complete: true, nodes };
  } catch {
    sources.linearComments = { complete: false, nodes: [], error: "Unavailable Linear comment history" };
  }
  return sources;
}

export function classifyCheckReviewState({ target, pullRequest, feedback, checks, workpad,
  complete = false, manualRetry = 0, ancestry, isHuman }) {
  const watermark = feedbackWatermark(feedback, { isHuman });
  const generation = createReviewGeneration({ repositoryId: target.repository_id,
    prNumber: target.prNumber, headSha: pullRequest.head.sha, baseSha: pullRequest.base.sha,
    configRevision: target.configRevision, controllerRevision: target.controllerRevision, feedback: watermark, manualRetry });
  const acceptance = evaluateAi({ target, pullRequest, generation, checks, workpad, complete });
  const previous = workpad?.reviewContract?.generation;
  const sameHead = previous?.headSha === generation.headSha;
  let decision = "first-review";
  if (!watermark.complete || !complete || (previous && !previous.feedback?.complete)) decision = "full-review-paged-out";
  else if (previous && (previous.baseSha !== generation.baseSha || previous.configRevision !== generation.configRevision ||
    previous.controllerRevision !== generation.controllerRevision)) decision = "full-review-context-changed";
  else if (previous && !sameHead && ancestry !== "ahead") decision = "full-review-rebased";
  else if (acceptance.passes) decision = "skip";
  else if (previous) decision = "incremental";
  return { decision, reviewStatus: acceptance.passes ? "fresh-check" : "review-required",
    staleApproval: false, headRefOid: pullRequest.head.sha, isDraft: pullRequest.draft,
    generation, acceptance, pagedOut: !watermark.complete || !complete,
    lastReview: previous ? { oid: previous.headSha } : null };
}

const main = async () => {
  const number = Number(process.argv[2]);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(
      "Usage: node scripts/fetch-pr-review-state.mjs <pr-number>"
    );
  }
  const [owner, repo] = (
    process.env.REPO_SLUG || "example-org/example-repo"
  ).split("/");
  const reviewer = process.env.CADENCE_REVIEWER_LOGIN || (process.env.CADENCE_REVIEWER || "example-cadence-bot").trim().toLowerCase();
  // This CLI remains the bootstrap consumer until ROUTE wires trusted check
  // acquisition. The shared check-mode API below never falls back to approval.
  const reviewMode = process.env.CADENCE_REVIEW_MODE || "HACKATHON_LEGACY_REVIEW";
  if (reviewMode !== "HACKATHON_LEGACY_REVIEW") {
    throw new Error("Legacy review disabled; use trusted classifyCheckReviewState acquisition.");
  }
  const pr = await runQuery({ owner, repo, number });
  process.stdout.write(
    `${JSON.stringify(classifyPrReviewState(pr, reviewer), null, 2)}\n`
  );
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

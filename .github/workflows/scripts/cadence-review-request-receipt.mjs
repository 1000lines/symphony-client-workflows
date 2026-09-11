import { createHash } from "node:crypto";

import { triggerContextFromPayload } from "./cadence-ai-review-route-event.mjs";

const MARKER = "<!-- cadence-review-request-receipts:v1\n";
const normalize = (value) => String(value || "").toLowerCase();

// Called only by the events workflow, under its per-PR concurrency group.
// GitHub stores the receipt; Linear remains optional trigger evidence.
export const prepareReviewRequestReceipt = async ({
  payload,
  eventName,
  reviewer,
  requestActor = reviewer,
  pullPath,
  request,
  list,
}) => {
  const { payload: pr } = await request({ path: pullPath });
  if (pr.state !== "open") return { skipReason: "closed-pr" };
  if (!pr.head?.sha) throw new Error("Current PR head is missing.");
  if (
    payload.pull_request?.head?.sha &&
    payload.pull_request.head.sha !== pr.head.sha
  ) {
    return { skipReason: "stale-event-head" };
  }

  const context = triggerContextFromPayload({
    payload,
    eventName,
    prNumber: pr.number,
    currentHeadSha: pr.head.sha,
  });
  let version;
  if (context.contextKind === "review") {
    const { payload: review } = await request({
      path: `${pullPath}/reviews/${context.contextId}`,
    });
    const comments = [];
    let after = null;
    do {
      const { payload: result } = await request({
        method: "POST",
        path: "/graphql",
        body: {
          query: `query($id: ID!, $after: String) {
            node(id: $id) { ... on PullRequestReview {
              body updatedAt submittedAt state
              comments(first: 100, after: $after) {
                nodes { databaseId body updatedAt }
                pageInfo { hasNextPage endCursor }
              }
            } }
          }`,
          variables: { id: review.node_id, after },
        },
      });
      const live = result.data?.node;
      if (result.errors?.length || !live?.submittedAt || !live?.comments) {
        throw new Error("Cannot read submitted review context for coalescing.");
      }
      comments.push(...live.comments.nodes);
      version = [live.body, live.updatedAt, live.submittedAt, live.state];
      after = live.comments.pageInfo.hasNextPage
        ? live.comments.pageInfo.endCursor
        : null;
    } while (after);
    version.push(comments.sort((a, b) => a.databaseId - b.databaseId));
  } else if (context.contextKind === "pr-comment") {
    const { payload: comment } = await request({
      path: `${pullPath.split("/pulls/")[0]}/issues/comments/${
        context.contextId
      }`,
    });
    version = [comment.body, comment.updated_at];
  } else if (context.contextKind === "head") {
    // Becoming ready for review remains distinct from opening a draft PR.
    context.key += `:${payload.action}`;
    version = pr.head.sha;
  } else {
    throw new Error("Unsupported review-request coalescing context.");
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(version))
    .digest("hex");
  const issuePath = pullPath.replace("/pulls/", "/issues/");
  const comments = await list(`${issuePath}/comments?per_page=100`);
  const receipts = comments.filter(
    (comment) =>
      normalize(comment.user?.login) === normalize(requestActor) &&
      comment.body?.startsWith(MARKER)
  );
  if (receipts.length > 1)
    throw new Error("Multiple Cadence review-request receipts found.");
  let receipt = receipts[0];
  const state = receipt
    ? JSON.parse(receipt.body.slice(MARKER.length).split("\n-->")[0])
    : {};
  const key = `${normalize(reviewer)}:${context.key}`;
  const previous = state[key];
  const save = async (entry) => {
    state[key] = entry;
    const { payload: saved } = await request({
      method: receipt ? "PATCH" : "POST",
      path: receipt
        ? `${issuePath.split("/issues/")[0]}/issues/comments/${receipt.id}`
        : `${issuePath}/comments`,
      body: {
        body: `${MARKER}${JSON.stringify(
          state
        )}\n-->\nCadence review trigger receipts.`,
      },
    });
    receipt = saved;
  };
  if (previous?.fingerprint === fingerprint && previous.completed) {
    return { skipReason: "duplicate-review-context" };
  }
  const timeline = await list(`${issuePath}/timeline?per_page=100`);
  const latestRequestId = timeline.reduce(
    (latest, event) =>
      event.event === "review_requested" &&
      normalize(event.actor?.login) === normalize(requestActor) &&
      normalize(event.requested_reviewer?.login) === normalize(reviewer)
        ? Math.max(latest, event.id)
        : latest,
    0
  );
  // Recover a successful POST even if its response or the completion write was lost.
  if (
    previous?.fingerprint === fingerprint &&
    latestRequestId > previous.afterRequestId
  ) {
    await save({ ...previous, completed: true });
    return { skipReason: "duplicate-review-context" };
  }
  if (previous?.fingerprint === fingerprint && previous.requestStarted) {
    throw new Error(
      "Previous Cadence request outcome is unconfirmed; retry after the GitHub timeline updates, or manually re-request review."
    );
  }
  const pending = {
    fingerprint,
    afterRequestId: latestRequestId,
    completed: false,
    requestStarted: false,
  };
  await save(pending);
  return {
    start: () => save({ ...pending, requestStarted: true }),
    retry: () => save(pending),
    complete: () => save({ ...pending, completed: true }),
  };
};

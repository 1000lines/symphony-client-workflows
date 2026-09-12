// Presentation only: the existing check and submitted review own the verdict.
export const COMMENT_MARKER = "<!-- cadence-status -->";

const compact = (text, limit) => {
  const value = String(text || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
};

// Claude's Action exposes its execution JSON. Codex's pinned Action exposes
// only final prose, so it supplies no observed model/usage here. Never ask the
// reviewer to estimate telemetry or scrape its prose/logs for measurements.
export function reviewMeasurements({
  execution = [],
  requestedModel,
  startedAt,
  finishedAt,
} = {}) {
  const result = Array.isArray(execution)
    ? execution.findLast((item) => item.type === "result")
    : undefined;
  const models = Object.keys(result?.modelUsage || {});
  const durationMs =
    Number.isFinite(result?.duration_ms) && result.duration_ms >= 0
      ? result.duration_ms
      : startedAt && finishedAt
      ? Date.parse(finishedAt) - Date.parse(startedAt)
      : undefined;
  return {
    model: models.length ? models.join(", ") : undefined,
    requestedModel,
    durationMs,
    usage: result?.usage
      ? {
          input: result.usage.input_tokens,
          output: result.usage.output_tokens,
          cached: result.usage.cache_read_input_tokens,
          cacheWrite: result.usage.cache_creation_input_tokens,
        }
      : undefined,
  };
}

export function reviewFooter({
  model,
  requestedModel,
  durationMs,
  usage,
} = {}) {
  const parts = [];
  if (model) parts.push(`Model: ${compact(model, 100)}`);
  if (requestedModel && requestedModel !== model)
    parts.push(`Requested model: ${compact(requestedModel, 100)}`);
  if (Number.isFinite(durationMs) && durationMs >= 0)
    parts.push(`Review: ${(durationMs / 1000).toFixed(1)}s`);
  const tokens = Object.entries(usage || {})
    .filter(
      ([key, value]) =>
        ["input", "output", "cached", "cacheWrite"].includes(key) &&
        Number.isSafeInteger(value) &&
        value >= 0
    )
    .map(([key, value]) => `${key}: ${value}`);
  if (tokens.length) parts.push(`Tokens (${tokens.join(", ")})`);
  return parts.join(" · ");
}

export function renderComment(request, check, { review, measurements } = {}) {
  const status =
    check.status === "queued"
      ? "Queued"
      : check.status === "in_progress"
      ? "Reviewing"
      : {
          success: "Approved",
          action_required: "Needs attention",
          cancelled: "Cancelled",
          timed_out: "Failed",
        }[check.conclusion] || "Failed";
  // Copy the complete assessment before hiding its original review. Dropping
  // findings for presentation would make the original unsafe to minimize.
  const assessment = String(review?.body || "").trim();
  const summary =
    check.status === "queued"
      ? "Waiting for the review to start."
      : check.status === "in_progress"
      ? "Review in progress."
      : compact(check.output?.summary?.split("\n\n")[0], 350);
  const footer = reviewFooter(measurements);
  return [
    COMMENT_MARKER,
    `<!-- ${request.externalId} check:${check.id} state:${check.status} -->`,
    `### Cadence · ${status}`,
    summary,
    assessment,
    `[Head ${request.head.slice(0, 7)}](https://github.com/${request.owner}/${
      request.repo
    }/commit/${request.head}) · [Run](${request.runUrl})${
      review?.html_url ? ` · [Review and evidence](${review.html_url})` : ""
    }`,
    footer ? `---\n${footer}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Read the persisted check, including on retry/recovery after its write succeeded
// but comment publication failed. Its linked review is the existing verdict record.
export async function publishRequestComment(
  github,
  request,
  app,
  details = {}
) {
  const checks = await github.paginate(github.rest.checks.listForRef, {
    owner: request.owner,
    repo: request.repo,
    ref: request.head,
    check_name: "Cadence review",
    app_id: Number(app.id),
    filter: "all",
    per_page: 100,
  });
  const check = checks.find((item) => item.external_id === request.externalId);
  if (!check) return { skipped: "missing-check" };
  const reviewId = check.details_url?.match(/#pullrequestreview-(\d+)$/)?.[1];
  let review;
  if (check.status === "completed" && reviewId) {
    const { data } = await github.rest.pulls.getReview({
      owner: request.owner,
      repo: request.repo,
      pull_number: request.number,
      review_id: Number(reviewId),
    });
    if (
      data.commit_id === request.head &&
      data.user?.login === `${app.slug}[bot]` &&
      data.user?.type === "Bot" &&
      (!data.performed_via_github_app ||
        data.performed_via_github_app.id === Number(app.id))
    )
      review = data;
  }
  const published = await publishComment(github, request, app, check, {
    ...details,
    review,
  });
  if (!published.id || !review?.body?.trim()) return published;
  // A completed-comment retry still reaches this step: a failed hide must not
  // create another comment or lose the original measured footer.
  const { data: copied } = await github.rest.issues.getComment({
    owner: request.owner,
    repo: request.repo,
    comment_id: published.id,
  });
  if (
    copied.user?.login !== `${app.slug}[bot]` ||
    copied.user?.type !== "Bot" ||
    (copied.performed_via_github_app &&
      copied.performed_via_github_app.id !== Number(app.id)) ||
    !copied.body?.startsWith(COMMENT_MARKER) ||
    !copied.body.includes(
      `<!-- ${request.externalId} check:${check.id} state:completed -->`
    ) ||
    !copied.body.includes(review.body.trim()) ||
    !copied.body.includes(review.html_url)
  )
    throw new Error(
      "Cadence review copy could not be verified; leaving the original review visible"
    );
  const { data: pr } = await github.rest.pulls.get({
    owner: request.owner,
    repo: request.repo,
    pull_number: request.number,
  });
  const currentChecks = await github.paginate(github.rest.checks.listForRef, {
    owner: request.owner,
    repo: request.repo,
    ref: request.head,
    check_name: "Cadence review",
    app_id: Number(app.id),
    filter: "all",
    per_page: 100,
  });
  if (
    pr.state !== "open" ||
    pr.head.sha !== request.head ||
    currentChecks.some(
      (item) =>
        item.id > check.id && item.external_id?.endsWith(`:${request.number}`)
    )
  )
    return { ...published, hideSkipped: "closed-stale-or-newer-request" };
  const query = `query($id: ID!) { node(id: $id) { ... on PullRequestReview {
    id body author { login } commit { oid } isMinimized minimizedReason
  } } }`;
  const read = async () =>
    (await github.graphql(query, { id: review.node_id })).node;
  const original = await read();
  if (
    original?.id !== review.node_id ||
    original.author?.login !== `${app.slug}[bot]` ||
    original.commit?.oid !== request.head ||
    original.body !== review.body
  )
    throw new Error(
      "Cadence review changed before hiding; leaving the original review visible"
    );
  if (!original.isMinimized || original.minimizedReason !== "duplicate") {
    await github.graphql(
      `mutation($id: ID!) {
      minimizeComment(input: { subjectId: $id, classifier: DUPLICATE }) {
        minimizedComment { isMinimized minimizedReason }
      }
    }`,
      { id: review.node_id }
    );
  }
  const hidden = await read();
  if (!hidden?.isMinimized || hidden.minimizedReason !== "duplicate")
    throw new Error("Cadence review hide was not confirmed; retry publication");
  return {
    ...published,
    hiddenReview: review.id,
    isMinimized: true,
    minimizedReason: hidden.minimizedReason,
  };
}

// Call under the existing per-PR publication lock with the minted App identity.
// IDs from GitHub's checks order accepted requests, including same-head reruns.
export async function publishComment(
  github,
  request,
  app,
  check,
  details = {}
) {
  if (
    !Number.isSafeInteger(Number(app.id)) ||
    Number(app.id) <= 0 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(app.slug || "")
  )
    throw new Error("Verified Cadence App id and minted slug are required");
  if (
    check.app?.id !== Number(app.id) ||
    check.external_id !== request.externalId ||
    check.head_sha !== request.head
  )
    throw new Error("Comment check does not match the accepted App request");
  const { owner, repo, number } = request;
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: number,
    per_page: 100,
  });
  const owned = comments.filter(
    (item) =>
      item.body?.startsWith(COMMENT_MARKER) &&
      item.user?.type === "Bot" &&
      item.user?.login === `${app.slug}[bot]` &&
      (!item.performed_via_github_app ||
        item.performed_via_github_app.id === Number(app.id))
  );
  if (owned.length > 1)
    throw new Error(
      "Multiple Cadence status comments; operator reconciliation required"
    );
  const existing = owned[0];
  const previous = existing?.body.match(
    /check:(\d+) state:(queued|in_progress|completed)/
  );
  const phase = { queued: 0, in_progress: 1, completed: 2 };
  // Completion is terminal for an accepted check. Cleanup/retry must preserve
  // its existing findings and measured footer even when job outputs are absent.
  if (
    previous &&
    Number(previous[1]) === check.id &&
    previous[2] === "completed"
  )
    return { id: existing.id, unchanged: true };
  if (
    previous &&
    (Number(previous[1]) > check.id ||
      (Number(previous[1]) === check.id &&
        phase[previous[2]] > phase[check.status]))
  )
    return { skipped: "newer-or-completed-comment" };
  const checks = await github.paginate(github.rest.checks.listForRef, {
    owner,
    repo,
    ref: request.head,
    check_name: "Cadence review",
    app_id: Number(app.id),
    filter: "all",
    per_page: 100,
  });
  if (
    checks.some(
      (item) => item.id > check.id && item.external_id?.endsWith(`:${number}`)
    )
  )
    return { skipped: "newer-request" };
  const { data: pr } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: number,
  });
  if (pr.state !== "open" || pr.head.sha !== request.head)
    return { skipped: "closed-or-stale-head" };
  const body = renderComment(request, check, details);
  if (existing?.body === body) return { id: existing.id, unchanged: true };
  const { data } = existing
    ? await github.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body,
      })
    : await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: number,
        body,
      });
  return { id: data.id, url: data.html_url };
}

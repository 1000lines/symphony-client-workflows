// Small Checks API adapter. GitHub jobs own admission, queueing and recovery.
export const CHECK_NAME = "Cadence review";

export function checkRequest(context, number, head) {
  if (
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    !/^[a-f0-9]{40}$/.test(head)
  ) {
    throw new Error("Expected a PR number and its actual head SHA");
  }
  return {
    ...context.repo,
    number,
    head,
    externalId: `cadence:${context.runId}:${context.runAttempt}:${number}`,
    runUrl: `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}/attempts/${context.runAttempt}`,
  };
}

async function checksForRequest(github, request, appId) {
  const { owner, repo, head } = request;
  return github.paginate(github.rest.checks.listForRef, {
    owner,
    repo,
    ref: head,
    check_name: CHECK_NAME,
    app_id: Number(appId),
    filter: "all",
    per_page: 100,
  });
}

async function update(
  github,
  request,
  check,
  status,
  conclusion,
  summary,
  reviewUrl,
  assessment,
  measurements
) {
  return github.rest.checks.update({
    owner: request.owner,
    repo: request.repo,
    check_run_id: check.id,
    status,
    ...(conclusion
      ? { conclusion, completed_at: new Date().toISOString() }
      : {}),
    ...(status === "in_progress"
      ? { started_at: new Date().toISOString() }
      : {}),
    details_url: reviewUrl || request.runUrl,
    output: {
      title: conclusion
        ? `Cadence review: ${conclusion}`
        : "Cadence is reviewing",
      ...(assessment || measurements ? { text: JSON.stringify({ assessment, measurements }) } : {}),
      summary: `${summary}\n\n[Workflow run](${request.runUrl})${
        reviewUrl ? ` · [Review](${reviewUrl})` : ""
      }\n\nAdvisory only; humans decide whether to merge.`,
    },
  });
}

export async function queueCheck(github, request, appId) {
  const checks = await checksForRequest(github, request, appId);
  const existing = checks.find(
    (check) => check.external_id === request.externalId
  );
  if (existing) return existing; // Retried delivery never resets a completed check.
  const { data } = await github.rest.checks.create({
    owner: request.owner,
    repo: request.repo,
    name: CHECK_NAME,
    head_sha: request.head,
    external_id: request.externalId,
    status: "queued",
    details_url: request.runUrl,
    output: {
      title: "Cadence accepted this review",
      summary: `Waiting in the review queue.\n\n[Workflow run](${request.runUrl})\n\nAdvisory only; humans decide whether to merge.`,
    },
  });
  return data;
}

export async function startCheck(github, request, appId) {
  const checks = await checksForRequest(github, request, appId);
  const check = checks.find((item) => item.external_id === request.externalId);
  if (!check || check.status === "completed") return { active: false };
  const { data: pr } = await github.rest.pulls.get({
    owner: request.owner,
    repo: request.repo,
    pull_number: request.number,
  });
  if (pr.state !== "open" || pr.head.sha !== request.head) {
    await update(
      github,
      request,
      check,
      "completed",
      "cancelled",
      "PR closed or the accepted head was superseded."
    );
    return { active: false };
  }
  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    owner: request.owner,
    repo: request.repo,
    pull_number: request.number,
    per_page: 100,
  });
  await update(
    github,
    request,
    check,
    "in_progress",
    null,
    "Cadence is reviewing this accepted request."
  );
  return {
    active: true,
    baseline: Math.max(0, ...reviews.map((review) => review.id)),
  };
}

// Admission and finish jobs share a short per-PR concurrency group. Neither
// holds that group while waiting for/running the long review job.
export async function finishCheck(
  github,
  request,
  appId,
  { result, ranReview, baseline, reviewer, readyGraphql, assessment, measurements } = {}
) {
  const checks = await checksForRequest(github, request, appId);
  const check = checks.find((item) => item.external_id === request.externalId);
  if (!check || check.status === "completed") return;
  const { owner, repo, number } = request;
  const { data: pr } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: number,
  });
  // Never let an older request present success or ready a draft over newer work.
  const newer = checks.some(
    (item) => item.id > check.id && item.external_id?.endsWith(`:${number}`)
  );
  let conclusion = result === "cancelled" ? "cancelled" : "failure";
  let summary =
    "Review execution did not complete successfully. Inspect the workflow run.";
  let review;
  if (pr.state !== "open" || pr.head.sha !== request.head || newer) {
    conclusion = "cancelled";
    summary =
      "PR closed, head changed, or a newer accepted review superseded this request.";
  } else if (
    result === "success" &&
    ranReview === "true" &&
    Number.isSafeInteger(baseline)
  ) {
    const reviews = await github.paginate(github.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: number,
      per_page: 100,
    });
    if (validAssessment(assessment, request)) {
      conclusion = assessment.disposition === "APPROVE" ? "success" : "action_required";
      summary = conclusion === "success"
        ? "Cadence found no outstanding findings. Ready for human review."
        : "Cadence found items needing attention. Read the editable Cadence comment.";
      // The timeline still needs an APPROVE record. Narrative belongs only in
      // the editable comment; non-approval never submits a formal review.
      if (conclusion === "success") {
        review = reviews.find(item => item.id > baseline && item.commit_id === request.head &&
          item.user?.login === reviewer && item.state === "APPROVED" && !item.body);
        if (!review) {
          const { data } = await github.rest.pulls.createReview({ owner, repo, pull_number: number,
            commit_id: request.head, event: "APPROVE" });
          if (data.commit_id !== request.head || data.user?.login !== reviewer || data.state !== "APPROVED" || data.body)
            throw new Error("Minimal approval readback did not match the Cadence App/head");
          review = data;
        }
      }
    } else summary = "No verified assessment for this accepted request/head was produced.";
  } else if (result === "success" && ranReview !== "true") {
    conclusion = "action_required";
    summary =
      "Cadence stopped without another review (for example, the review-loop cap). Inspect the workflow handoff.";
  }
  let handoffError;
  if (conclusion === "success" && pr.draft) {
    // Recheck immediately before publication; a changed head is never readied.
    const { data: current } = await github.rest.pulls.get({
      owner,
      repo,
      pull_number: number,
    });
    if (current.state !== "open" || current.head.sha !== request.head) {
      conclusion = "cancelled";
      summary = "PR closed or head changed before the human handoff.";
    } else if (current.draft) {
      try {
        // Only the repository workflow identity may ready a draft. Never fall
        // back to the shared Cadence App used for reads and check publication.
        if (!readyGraphql) throw new Error("Missing readiness client");
        const response = await readyGraphql(
          `mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }`,
          { id: current.node_id }
        );
        if (
          response?.markPullRequestReadyForReview?.pullRequest?.isDraft !==
          false
        )
          throw new Error("GitHub did not confirm readiness");
        summary =
          "Cadence found no outstanding findings. GitHub confirmed the draft is ready for human review.";
      } catch (error) {
        const denied =
          [401, 403].includes(error?.status) ||
          error?.errors?.some((item) =>
            ["FORBIDDEN", "UNAUTHORIZED"].includes(item.type)
          );
        handoffError =
          `Cadence approved ${
            request.head
          }, but markPullRequestReadyForReview ${
            denied ? "was denied" : "was not confirmed"
          } for ${owner}/${repo}#${number} using repository GITHUB_TOKEN. ` +
          "Repository operator: verify contents:write and pull-requests:write on the finish job and reusable-workflow callers, and the effective token permissions in the job log. " +
          "Keep the shared Cadence App grants unchanged. After fixing access, rerun all jobs for a fresh guarded verdict; do not merge automatically.";
        conclusion = "failure";
        summary = `Review approved; marking ready failed.\n\n[Failed operation: markPullRequestReadyForReview](${
          request.runUrl
        })\n\n${error?.message || String(error)}\n\n${handoffError}`;
      }
    }
  }
  await update(
    github,
    request,
    check,
    "completed",
    conclusion,
    summary,
    assessment?.workpadUrl,
    validAssessment(assessment, request) ? assessment : undefined,
    measurements
  );
  return { conclusion, summary, handoffError };
}

// workflow_run completion also runs when cancellation prevented any final job.
// The pointer was uploaded BEFORE creating the check, including force-pushed heads.
export async function recoverCheck(github, context, request, appId, run) {
  if (
    request.owner !== context.repo.owner ||
    request.repo !== context.repo.repo ||
    request.externalId !==
      `cadence:${run.id}:${run.run_attempt}:${request.number}`
  ) {
    throw new Error("Recovery pointer does not belong to the completed run");
  }
  const checks = await checksForRequest(github, request, appId);
  for (const check of checks) {
    if (
      check.external_id !== request.externalId ||
      check.status === "completed"
    )
      continue;
    const conclusion = ["cancelled", "timed_out"].includes(run.conclusion)
      ? run.conclusion
      : "failure";
    await update(
      github,
      request,
      check,
      "completed",
      conclusion,
      `Workflow ended (${run.conclusion}) before final review publication. No clean verdict is claimed.`
    );
  }
}

// The existing incremental workpad payload is the provider handoff. Bind it to
// this native run only after successful execution and a current-head read.
export function assessmentFromUpdate(update, request) {
  const open = item => !["resolved", "closed", "dismissed"].includes(item.status);
  if (!update || update.lastReviewedSha !== request.head ||
      !["APPROVE", "COMMENT"].includes(update.disposition) ||
      typeof update.githubAssessmentSummary !== "string" || !update.githubAssessmentSummary.trim() ||
      update.githubAssessmentSummary.length > 1400 || !Array.isArray(update.findings) ||
      update.findings.some(item => !item || !item.id || !item.class || !item.status || !item.summary))
    throw new Error("Missing or invalid current-head reviewUpdate assessment/findings");
  const blocking = update.findings.filter(item => open(item) &&
    (item.mandatory === true || ["blocker", "human-needed"].includes(item.class)));
  if (update.disposition === "APPROVE" && blocking.length)
    throw new Error("Approval has unresolved mandatory findings");
  return { requestId: request.externalId, headSha: request.head, disposition: update.disposition,
    githubAssessmentSummary: update.githubAssessmentSummary,
    humanNeeded: blocking.some(item => item.class === "human-needed") };
}

export function validAssessment(assessment, request) {
  return assessment?.requestId === request.externalId && assessment.headSha === request.head &&
    ["APPROVE", "COMMENT"].includes(assessment.disposition) &&
    typeof assessment.githubAssessmentSummary === "string" && Boolean(assessment.githubAssessmentSummary.trim()) &&
    typeof assessment.humanNeeded === "boolean";
}

// Recovery and handoff read the App's persisted result, never review prose or
// an event marker. Newer accepted work, including same-head retries, wins.
export async function readCheckAssessment(github, request, appId) {
  const checks = await checksForRequest(github, request, appId);
  const check = checks.find(item => item.external_id === request.externalId);
  if (!check || check.app?.id !== Number(appId) || check.head_sha !== request.head ||
      check.status !== "completed" || !["success", "action_required"].includes(check.conclusion) ||
      checks.some(item => item.id > check.id && item.external_id?.endsWith(`:${request.number}`))) return;
  const { assessment, measurements } = JSON.parse(check.output?.text || "{}");
  if (!validAssessment(assessment, request) ||
      (check.conclusion === "success") !== (assessment.disposition === "APPROVE")) return;
  const { data: pr } = await github.rest.pulls.get({ owner: request.owner, repo: request.repo, pull_number: request.number });
  if (pr.state !== "open" || pr.head.sha !== request.head) return;
  return { check, assessment, measurements, pr };
}

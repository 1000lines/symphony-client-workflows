import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  fetchIssueComments,
  findCadenceWorkpadComment,
  parseCadenceWorkpad,
  renderCadenceWorkpadForLinear,
} from "../../../scripts/cadence-linear-workpad.mjs";
import {
  linearRequest,
  readLinearIssue,
  readLinearTeamKey,
  redactToken,
  terminalStateReason,
  wakeLinearIssue,
} from "../../../scripts/linear-issue-wakeup.mjs";
import { loadRepositoryConfig } from "../../../scripts/symphony/review-contract.mjs";

const failed = (value) =>
  [
    "failure",
    "error",
    "timed_out",
    "cancelled",
    "action_required",
    "startup_failure",
  ].includes(String(value).toLowerCase());
const hasLabel = (item, name) =>
  item.labels?.some(
    (label) => label.name?.toLowerCase() === name.toLowerCase()
  );
const managed = (pr) => pr.state === "open" && hasLabel(pr, "symphony");
const unique = (values) => [...new Set(values.filter(Boolean))];

export const resolveIssue = ({
  ticketNumber,
  pullRequests = [],
  branch = "",
  teamKey = readLinearTeamKey(),
}) => {
  if (!/^[A-Z0-9]+$/.test(teamKey)) throw new Error("Invalid Linear team key.");
  const identifier = `${teamKey}-[1-9]\\d*`;
  if (ticketNumber !== undefined && ticketNumber !== "") {
    if (!new RegExp(`^${identifier}$`).test(ticketNumber)) {
      throw new Error(
        `Invalid explicit ticket_number; expected one ${teamKey}-N identifier.`
      );
    }
    return { issueIdentifier: ticketNumber, identitySource: "ticket_number" };
  }
  const titles = unique(
    pullRequests.map(
      (pr) => pr.title?.match(new RegExp(`^\\[(${identifier})\\]`))?.[1]
    )
  );
  const candidates = titles.length
    ? titles
    : unique(
        [branch, ...pullRequests.map((pr) => pr.head?.ref)].flatMap((ref) =>
          [
            ...String(ref || "").matchAll(
              new RegExp(`\\b${identifier}\\b`, "gi")
            ),
          ].map((match) => match[0].toUpperCase())
        )
      );
  if (candidates.length !== 1) {
    throw new Error(
      `Missing or ambiguous Linear issue candidates: ${
        candidates.join(", ") || "none"
      }.`
    );
  }
  return {
    issueIdentifier: candidates[0],
    identitySource: titles.length ? "pr-title" : "branch",
  };
};

// Dispatch inputs are not included in workflow_run. Only our anchored marker
// is an explicit input; arbitrary issue-like text in a run title is not one.
export const workflowTicket = (run, teamKey = readLinearTeamKey()) => {
  const title = String(run.display_title || "");
  if (!title.startsWith("[linear:")) return undefined;
  const match = title.match(/^\[linear:([^\]]*)\] /);
  if (!match) throw new Error("Malformed workflow ticket_number marker.");
  resolveIssue({ ticketNumber: match[1] || "invalid", teamKey });
  return match[1];
};

export const createGitHubClient = ({ repo, token, fetchImpl = fetch }) => {
  const request = async (path, body) => {
    if (!token) throw new Error("Missing GH_TOKEN for GitHub evidence reads.");
    const response = await fetchImpl(`https://api.github.com/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    if (!response.ok || data.errors?.length) {
      throw new Error(`GitHub ${path} failed (HTTP ${response.status}).`);
    }
    return data;
  };
  const list = async (path) => {
    const items = [];
    for (let page = 1; ; page++) {
      const batch = await request(
        `repos/${repo}/${path}${
          path.includes("?") ? "&" : "?"
        }per_page=100&page=${page}`
      );
      if (!Array.isArray(batch))
        throw new Error("Invalid GitHub list response.");
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  };
  return {
    async configuration(baseBranch) {
      const repository = await request(`repos/${repo}`);
      const selected = baseBranch || repository.default_branch;
      if (selected !== repository.default_branch)
        throw new Error("Target default branch mismatch.");
      const branch = await request(
        `repos/${repo}/branches/${encodeURIComponent(selected)}`
      );
      const result = await loadRepositoryConfig({
        repository: repo,
        baseBranch: selected,
        expectedRevision: branch.commit.sha,
        token,
        fetchImpl,
      });
      if (result.status !== "configured")
        throw new Error("Missing target repository configuration.");
      return result;
    },
    getPr: (number) => request(`repos/${repo}/pulls/${number}`),
    listPrs: (branch) =>
      list(
        `pulls?state=open${
          branch
            ? `&head=${encodeURIComponent(`${repo.split("/")[0]}:${branch}`)}`
            : ""
        }`
      ),
    commitPrs: (sha) => list(`commits/${encodeURIComponent(sha)}/pulls`),
    getRun: (id) => request(`repos/${repo}/actions/runs/${id}`),
    // isRequired includes the effective PR rules, including legacy protection.
    // Query the live head's rollup rather than trusting a webhook conclusion.
    async checks(number, expectedHead) {
      const [owner, name] = repo.split("/");
      const checks = [];
      let after = null;
      do {
        const data = await request("graphql", {
          query: `query RequiredChecks($owner:String!,$name:String!,$number:Int!,$after:String) {
            repository(owner:$owner,name:$name) { pullRequest(number:$number) {
              headRefOid commits(last:1) { nodes { commit { statusCheckRollup {
                contexts(first:100,after:$after) { nodes {
                  ... on CheckRun { databaseId name status conclusion detailsUrl checkSuite { app { databaseId } workflowRun { databaseId runAttempt event file { path } workflow { id } } } isRequired(pullRequestNumber:$number) }
                  ... on StatusContext { context state targetUrl isRequired(pullRequestNumber:$number) }
                } pageInfo { hasNextPage endCursor } }
              } } } }
            } }
          }`,
          variables: { owner, name, number, after },
        });
        const pr = data.data?.repository?.pullRequest;
        if (pr?.headRefOid !== expectedHead)
          throw new Error("PR head changed during required-check lookup.");
        const contexts =
          pr.commits?.nodes[0]?.commit?.statusCheckRollup?.contexts;
        if (!contexts) return Object.assign(checks, { complete: false });
        checks.push(...contexts.nodes);
        after = contexts.pageInfo.hasNextPage
          ? contexts.pageInfo.endCursor
          : null;
        if (contexts.pageInfo.hasNextPage && !after)
          return Object.assign(checks, { complete: false });
      } while (after);
      // A rerun supersedes an earlier failed attempt even before it completes.
      const latest = new Map();
      for (const check of checks) {
        const checkOwner = `${check.checkSuite?.app?.databaseId}:${check.checkSuite?.workflowRun?.workflow?.id}:${check.checkSuite?.workflowRun?.databaseId}`;
        const key = check.name
          ? `check:${checkOwner}:${check.name}`
          : `status:${check.context}`;
        if (
          !latest.has(key) ||
          (check.databaseId || 0) > (latest.get(key).databaseId || 0)
        )
          latest.set(key, check);
      }
      return Object.assign([...latest.values()], { complete: true });
    },
  };
};

// Keep the advisory review outside CI, including when a target accidentally
// includes it in its CI contract. An empty contract cannot establish success.
export async function requiredCi({ github, number, headSha, requiredChecks }) {
  const checks = await github.checks(number, headSha);
  const rules = requiredChecks.filter(
    (rule) => rule.name.toLowerCase() !== "cadence review"
  );
  const required = checks.filter(
    (check) =>
      check.isRequired &&
      check.name?.toLowerCase() !== "cadence review" &&
      !rules.some((rule) => rule.name === check.name)
  );
  let waiting = checks.complete === false || rules.length === 0;
  const runs = new Map();
  const finish = (state, reason) => ({
    state,
    reason,
    evidence: {
      headSha,
      requiredChecks,
      complete: checks.complete !== false,
      checks: checks.map((check) => ({
        name: check.name || check.context,
        checkId: check.databaseId,
        appId: check.checkSuite?.app?.databaseId,
        workflow: check.checkSuite?.workflowRun?.file?.path,
        runId: check.checkSuite?.workflowRun?.databaseId,
        status: check.status,
        conclusion: check.conclusion || check.state,
        url: check.detailsUrl || check.targetUrl,
      })),
      runs: [...runs.values()].map((run) => ({
        id: run.id,
        attempt: run.run_attempt,
        headSha: run.head_sha,
        workflow: run.path,
        event: run.event,
        status: run.status,
        conclusion: run.conclusion,
        url: run.html_url,
      })),
    },
  });
  for (const rule of rules) {
    const matches = checks.filter(
      (check) =>
        check.name === rule.name &&
        check.checkSuite?.app?.databaseId === rule.appId &&
        check.checkSuite?.workflowRun?.file?.path === rule.workflow
    );
    if (!matches.length) waiting = true;
    for (const check of matches) {
      const id = check.checkSuite.workflowRun.databaseId;
      if (!id) {
        waiting = true;
        continue;
      }
      if (!runs.has(id)) runs.set(id, await github.getRun(id));
      const run = runs.get(id);
      if (
        run.head_sha !== headSha ||
        run.path !== rule.workflow ||
        !["pull_request", "push", "workflow_dispatch"].includes(run.event)
      ) {
        waiting = true;
        continue;
      }
      if (run.status !== "completed") {
        waiting = true;
        continue;
      } else if (failed(run.conclusion))
        return finish(
          "Active",
          `Required CI ${run.conclusion}: ${run.html_url}`
        );
      else if (run.conclusion !== "success") waiting = true;
      required.push(check);
    }
  }
  for (const check of required) {
    const id = check.checkSuite?.workflowRun?.databaseId;
    if (id) {
      if (!runs.has(id)) runs.set(id, await github.getRun(id));
      const run = runs.get(id);
      if (run.head_sha !== headSha || run.status !== "completed") {
        waiting = true;
        continue;
      }
    }
    if (failed(check.conclusion || check.state))
      return finish(
        "Active",
        `Required check failed: ${check.detailsUrl || check.targetUrl}`
      );
    if (
      (check.name && check.status !== "COMPLETED") ||
      (check.conclusion || check.state) !== "SUCCESS"
    )
      waiting = true;
  }
  return waiting
    ? finish(
        "Unhappy",
        "Required CI is missing, incomplete, or pending; check again after wake:15m."
      )
    : finish(
        "Inactive",
        "All configured and observed required checks passed on the current head."
      );
}

const prEvidence = (pr) => ({
  prNumber: pr.number,
  prUrl: pr.html_url,
  branch: pr.head?.ref,
  headSha: pr.head?.sha,
  baseSha: pr.base?.sha,
});

const requirePr = (pr, repo) => {
  if (!pr.number || !pr.head?.sha || !pr.head.ref || !pr.base?.sha)
    throw new Error("Missing current PR number, branch or SHA.");
  if (pr.head.repo?.full_name !== repo || pr.base.repo?.full_name !== repo)
    throw new Error(
      "PR repository mismatch; refusing cross-repository wakeup."
    );
};

const checkMatches = (check, eventName, payload) => {
  if (eventName === "check_run")
    return check.databaseId === payload.check_run.id;
  if (eventName === "status") return check.context === payload.context;
  return check.detailsUrl?.startsWith(`${payload.workflow_run.html_url}/`);
};

export const planWakeups = async ({
  eventName,
  payload,
  github,
  repo,
  bridgeRunUrl = "",
  triggerActor = "",
  teamKey = readLinearTeamKey(),
}) => {
  const run = payload.workflow_run;
  const base = {
    eventName,
    actor:
      run?.triggering_actor?.login ||
      run?.actor?.login ||
      payload.sender?.login ||
      triggerActor,
    bridgeRunUrl,
    runUrl: run?.html_url || bridgeRunUrl,
    workflowName: run?.name || "",
    workflowPath: run?.path || "",
    conclusion: run?.conclusion || "",
    branch: run?.head_branch || "",
    headSha: run?.head_sha || "",
    runId: run?.id,
    runAttempt: run?.run_attempt,
  };
  const skip = (reason) => [
    { ...base, shouldWake: false, skippedReason: reason },
  ];
  if (
    eventName === "workflow_run" &&
    (payload.action !== "completed" || run?.status !== "completed")
  )
    return skip("workflow-not-completed");
  if (
    eventName === "workflow_run" &&
    (run.path === ".github/workflows/symphony-linear-wakeups.yml" ||
      run.event === "workflow_run")
  )
    return skip("bridge-recursion");
  const completion =
    eventName === "workflow_run" && run.event === "workflow_dispatch";
  const conflict = ["schedule", "pull_request_target"].includes(eventName);
  if (
    ![
      "workflow_run",
      "check_run",
      "status",
      "schedule",
      "pull_request_target",
    ].includes(eventName)
  )
    return skip("unsupported-event");
  if (
    !completion &&
    !conflict &&
    !failed(payload.check_run?.conclusion || payload.state || run?.conclusion)
  )
    return skip("successful-or-nonfailure-check");
  if (
    eventName === "check_run" &&
    (payload.action !== "completed" || payload.check_run.status !== "completed")
  )
    return skip("check-not-completed");
  if (run && run.head_repository?.full_name !== repo)
    throw new Error("Workflow repository mismatch.");

  const ticketNumber = completion ? workflowTicket(run, teamKey) : undefined;
  // Mirror the runner gate: only Symphony-branch workflow completions qualify.
  // Explicit inputs retain routing precedence within that scope.
  if (run && !run.head_branch?.startsWith("symphony/"))
    return skip("workflow-not-issue-scoped");
  const eventSha =
    payload.pull_request?.head?.sha ||
    payload.check_run?.head_sha ||
    payload.sha ||
    run?.head_sha;
  if (eventName !== "schedule" && !eventSha)
    throw new Error("Missing event head SHA.");
  let candidates;
  if (payload.pull_request) candidates = [payload.pull_request];
  else if (eventName === "schedule") candidates = await github.listPrs();
  else if (ticketNumber)
    candidates = []; // Explicit workflow owner can differ from a code PR.
  else if (
    run?.pull_requests?.length ||
    payload.check_run?.pull_requests?.length
  )
    candidates = run?.pull_requests || payload.check_run.pull_requests;
  else if (completion) candidates = await github.listPrs(run.head_branch);
  else candidates = await github.commitPrs(eventSha);
  const prs = [];
  const plans = [];
  for (const number of unique(candidates.map((pr) => pr.number))) {
    try {
      const pr = await github.getPr(number);
      if (managed(pr)) {
        requirePr(pr, repo);
        // One malformed PR must not abort the remaining scheduled sweep.
        if (eventName === "schedule")
          resolveIssue({ pullRequests: [pr], teamKey });
        prs.push(pr);
      }
    } catch (error) {
      if (eventName !== "schedule") throw error;
      plans.push({
        ...base,
        prNumber: number,
        shouldWake: false,
        skippedReason: "unresolvable-scheduled-pr",
        error: error.message,
      });
    }
  }

  if (completion) {
    const identity = resolveIssue({
      ticketNumber,
      teamKey,
      pullRequests: prs,
      branch: run.head_branch,
    });
    if (prs.length > 1) throw new Error("Ambiguous workflow PR candidates.");
    if (prs[0] && prs[0].head.sha !== eventSha)
      return skip("stale-workflow-head");
    if (
      !run.conclusion ||
      !run.html_url ||
      !run.head_branch ||
      !run.id ||
      !run.run_attempt
    )
      throw new Error("Missing workflow completion evidence.");
    return [
      {
        ...base,
        ...identity,
        ...(prs[0] ? prEvidence(prs[0]) : {}),
        workflowHeadSha: run.head_sha,
        displayTitle: run.display_title,
        shouldWake: true,
        reason: "workflow-completed",
        key: `workflow:${run.id}:${run.run_attempt}`,
      },
    ];
  }
  if (!conflict && prs.length > 1)
    throw new Error("Ambiguous check PR candidates.");
  for (const pr of prs) {
    const evidence = {
      ...base,
      ...prEvidence(pr),
      ...resolveIssue({ pullRequests: [pr], teamKey }),
    };
    if (eventSha && pr.head.sha !== eventSha) {
      plans.push({
        ...evidence,
        shouldWake: false,
        skippedReason: "stale-pr-head",
      });
      continue;
    }
    if (conflict) {
      plans.push({
        ...evidence,
        shouldWake: pr.mergeable === false && pr.mergeable_state === "dirty",
        reason: "merge-conflict",
        conclusion: pr.mergeable_state,
        skippedReason:
          pr.mergeable_state === "dirty" && pr.mergeable === false
            ? ""
            : "no-current-conflict",
        // A newer base alone must not re-wake an already handled conflict.
        key: `conflict:${pr.number}:${pr.head.sha}`,
      });
    } else {
      const checks = await github.checks(pr.number, pr.head.sha);
      const failures = checks.filter(
        (check) =>
          check.isRequired === true &&
          failed(check.conclusion || check.state) &&
          checkMatches(check, eventName, payload)
      );
      for (const check of failures)
        plans.push({
          ...evidence,
          shouldWake: true,
          reason: "required-check-failed",
          checkName: check.name || check.context,
          checkId: check.databaseId,
          conclusion: check.conclusion || check.state,
          checkUrl: check.detailsUrl || check.targetUrl,
          runUrl:
            run?.html_url || check.detailsUrl || check.targetUrl || base.runUrl,
          key: `check:${pr.number}:${pr.head.sha}:${
            check.databaseId || payload.id || check.context
          }:${check.conclusion || check.state}`,
        });
      if (!failures.length)
        plans.push({
          ...evidence,
          shouldWake: false,
          skippedReason: "no-current-required-failure",
        });
    }
  }
  return plans.length ? plans : skip("no-managed-pr");
};

const metadataField = (project, key) =>
  `${project?.description || ""}\n${project?.content || ""}`
    .match(new RegExp(`^${key}:[ \\t]*([^\\n]+)`, "m"))?.[1]
    ?.trim();

const validateMetadata = (issue, plan, pr) => {
  const code = metadataField(issue.project, "project-code");
  const color = metadataField(issue.project, "project-color");
  if (
    !issue.project?.id ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(code || "") ||
    !/^[a-z]+$/.test(color || "") ||
    !metadataField(issue.project, "human-lead")
  )
    throw new Error("Missing Linear project metadata.");
  if (!hasLabel({ labels: issue.labels?.nodes }, color))
    throw new Error("Missing project-color label on Linear issue.");
  if (pr && (!hasLabel(pr, "symphony") || !hasLabel(pr, color)))
    throw new Error("Missing Symphony/project-color PR label.");
  const branchProject = plan.branch?.match(/^symphony\/([^/]+)\//)?.[1];
  if (branchProject && branchProject !== code)
    throw new Error(
      "Workflow/PR branch project does not match the Linear project."
    );
};

const pinWorkpad = async (issueIdentifier, options) => {
  const issue = await fetchIssueComments(
    issueIdentifier,
    options.token,
    options
  );
  if (!issue.id || issue.identifier !== issueIdentifier)
    throw new Error("Workpad issue lookup mismatch.");
  const existing = findCadenceWorkpadComment(issue.comments);
  if (existing) return existing.id;
  const data = await linearRequest({
    ...options,
    operation: "pin bridge workpad",
    query: `mutation WakeupWorkpadCreate($id:String!,$body:String!) { commentCreate(input:{issueId:$id,body:$body}) { success comment { id } } }`,
    variables: { id: issue.id, body: "## Cadence Workpad\n" },
  });
  if (!data.commentCreate?.success || !data.commentCreate.comment?.id)
    throw new Error("Could not pin bridge workpad.");
  return data.commentCreate.comment.id;
};

const workpadState = async (result, commentId, options) => {
  const issue = await fetchIssueComments(
    result.issueIdentifier,
    options.token,
    options
  );
  const comment = issue.comments.find((item) => item.id === commentId);
  if (!comment || findCadenceWorkpadComment([comment])?.id !== commentId)
    throw new Error("Pinned bridge workpad is unavailable.");
  return parseCadenceWorkpad(comment.body);
};

const recordEvidence = async (result, commentId, options) => {
  // CADENCE_LINEAR_API_TOKEN owns this workflow. Preserve existing review state
  // and never attempt to edit the Codex or engine-owned Symphony workpad.
  const current = await workpadState(result, commentId, options);
  const coordination =
    typeof current.coordination === "object" && current.coordination
      ? current.coordination
      : { reviewCoordination: current.coordination };
  const history = Array.isArray(coordination.nonReviewWakeups)
    ? coordination.nonReviewWakeups
    : [];
  const slim = ({
    key,
    operation,
    reason,
    skippedReason,
    issueIdentifier,
    at,
  }) => ({
    key,
    operation,
    reason,
    skippedReason,
    issueIdentifier,
    at,
  });
  const { body, compacted } = renderCadenceWorkpadForLinear({
    ...current,
    coordination: {
      ...coordination,
      nonReviewWakeups: [
        ...history.filter((item) => item.key !== result.key),
        result,
      ]
        .slice(-10)
        .map(slim),
      lastNonReviewWakeup: result,
    },
  });
  if (compacted)
    throw new Error(
      "Refusing bridge evidence write that would compact Cadence review state."
    );
  const data = await linearRequest({
    ...options,
    operation: "record bridge evidence",
    query: `mutation WakeupWorkpadUpdate($id:String!,$body:String!) { commentUpdate(id:$id,input:{body:$body}) { success comment { id } } }`,
    variables: { id: commentId, body },
  });
  if (
    !data.commentUpdate?.success ||
    data.commentUpdate.comment?.id !== commentId
  )
    throw new Error("Could not update pinned bridge workpad.");
};

export const applyWakeup = async ({
  plan,
  github,
  repo,
  token,
  githubToken,
  teamKey = readLinearTeamKey(),
  fetchImpl = fetch,
}) => {
  const redact = (message) => {
    const safe = redactToken(redactToken(message, token), githubToken);
    return safe.length > 1200
      ? `${safe.slice(0, 1160)}... [truncated for Linear limit]`
      : safe;
  };
  const result = {
    ...plan,
    operation: "skipped",
    at: new Date().toISOString(),
  };
  if (result.error) result.error = redact(result.error);
  if (!plan.shouldWake) return result;
  const options = { token, fetchImpl };
  let commentId;
  try {
    if (plan.reason === "workflow-completed") {
      const run = await github.getRun(plan.runId);
      if (run.id !== plan.runId || run.head_repository?.full_name !== repo)
        throw new Error("Workflow evidence lookup mismatch.");
      if (
        run.run_attempt !== plan.runAttempt ||
        run.status !== "completed" ||
        run.conclusion !== plan.conclusion ||
        run.head_sha !== plan.workflowHeadSha
      ) {
        return { ...result, skippedReason: "workflow-changed-before-wakeup" };
      }
    }
    const { viewer } = await linearRequest({
      ...options,
      query: "query WakeupViewer { viewer { id name } }",
      operation: "verify bridge bot",
    });
    if (!viewer?.id || viewer.name !== "Example Review Bot")
      throw new Error("Expected Example Review Bot Linear credential owner.");
    result.linearActor = { id: viewer.id, name: viewer.name };
    commentId = await pinWorkpad(plan.issueIdentifier, options);
    const current = await workpadState(result, commentId, options);
    const previous = current.coordination?.nonReviewWakeups?.find(
      (item) => item.key === plan.key
    );
    if (
      previous &&
      (["updated", "unchanged"].includes(previous.operation) ||
        (previous.operation === "skipped" &&
          previous.skippedReason?.startsWith("terminal-")))
    )
      return {
        ...result,
        skippedReason: "duplicate-event",
        previousEvidence: previous,
      };
    let issue = await readLinearIssue({
      ...options,
      issueIdentifier: plan.issueIdentifier,
    });
    Object.assign(result, {
      issueId: issue.id,
      previousState: issue.state.name,
      state: issue.state.name,
      operation: "planned",
    });
    // Check durable evidence access before attempting an issue mutation.
    await recordEvidence(result, commentId, options);
    let pr;
    if (plan.prNumber) {
      pr = await github.getPr(plan.prNumber);
      requirePr(pr, repo);
      if (
        !managed(pr) ||
        pr.head.sha !== plan.headSha ||
        pr.base.sha !== plan.baseSha ||
        (plan.reason === "merge-conflict" &&
          (pr.mergeable !== false || pr.mergeable_state !== "dirty"))
      ) {
        Object.assign(result, {
          operation: "skipped",
          skippedReason: "pr-changed-before-wakeup",
        });
        await recordEvidence(result, commentId, options);
        return result;
      }
      if (plan.reason === "required-check-failed") {
        const checks = await github.checks(pr.number, pr.head.sha);
        if (
          !checks.some(
            (check) =>
              check.isRequired &&
              failed(check.conclusion || check.state) &&
              (plan.checkId
                ? check.databaseId === plan.checkId
                : check.context === plan.checkName)
          )
        ) {
          Object.assign(result, {
            operation: "skipped",
            skippedReason: "check-changed-before-wakeup",
          });
          await recordEvidence(result, commentId, options);
          return result;
        }
      }
    }
    const data = await linearRequest({
      ...options,
      operation: "read issue project metadata",
      query: `query WakeupProject($id:String!) { issue(id:$id) { id labels { nodes { name } } project { id description content } } }`,
      variables: { id: issue.id },
    });
    if (data.issue?.id !== issue.id)
      throw new Error("Issue metadata lookup mismatch.");
    // Linear has no CAS. Re-read immediately before the mutation to protect a
    // cancellation that happened while the evidence/metadata were being written.
    issue = await readLinearIssue({
      ...options,
      issueIdentifier: plan.issueIdentifier,
    });
    if (!terminalStateReason(issue.state)) {
      validateMetadata(data.issue, plan, pr);
      if (
        pr &&
        resolveIssue({ pullRequests: [pr], teamKey }).issueIdentifier !==
          plan.issueIdentifier
      )
        throw new Error("PR issue identity changed before wakeup.");
    }
    Object.assign(result, await wakeLinearIssue({ ...options, issue }));
    // A confirmed issue mutation stays confirmed even if its final evidence
    // write fails. Retry only the evidence; never reclassify or repeat the wake.
    try {
      await recordEvidence(result, commentId, options);
    } catch (error) {
      result.evidenceError = redact(error.message);
      try {
        await recordEvidence(result, commentId, options);
      } catch (writeError) {
        result.evidenceError = redact(writeError.message);
      }
    }
  } catch (error) {
    Object.assign(result, error.evidence || {}, {
      operation: "failed",
      error: redact(error.message),
    });
    if (commentId) {
      try {
        await recordEvidence(result, commentId, options);
      } catch (writeError) {
        result.evidenceError = redact(writeError.message);
      }
    }
  }
  return result;
};

export const runBridge = async (options) => {
  const github = options.github || createGitHubClient(options);
  try {
    const plans = await planWakeups({ ...options, github });
    const results = [];
    for (const plan of plans)
      results.push(
        await applyWakeup({
          ...options,
          github,
          plan,
          token: options.linearToken,
          githubToken: options.token,
        })
      );
    return results;
  } catch (error) {
    return [
      {
        operation: "failed",
        eventName: options.eventName,
        bridgeRunUrl: options.bridgeRunUrl,
        runUrl: options.payload.workflow_run?.html_url,
        actor:
          options.payload.workflow_run?.triggering_actor?.login ||
          options.payload.workflow_run?.actor?.login ||
          options.payload.sender?.login ||
          options.triggerActor,
        workflowName: options.payload.workflow_run?.name,
        workflowPath: options.payload.workflow_run?.path,
        checkName: options.payload.check_run?.name || options.payload.context,
        conclusion:
          options.payload.workflow_run?.conclusion ||
          options.payload.check_run?.conclusion ||
          options.payload.state,
        branch:
          options.payload.workflow_run?.head_branch ||
          options.payload.pull_request?.head?.ref,
        prNumber: options.payload.pull_request?.number,
        headSha:
          options.payload.workflow_run?.head_sha ||
          options.payload.check_run?.head_sha ||
          options.payload.pull_request?.head?.sha ||
          options.payload.sha,
        error: redactToken(
          redactToken(error.message, options.token),
          options.linearToken
        ),
      },
    ];
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repo = process.env.GITHUB_REPOSITORY;
  const result = await runBridge({
    repo,
    token: process.env.GH_TOKEN,
    linearToken: process.env.LINEAR_API_TOKEN || process.env.LINEAR_API_KEY,
    eventName: process.env.GITHUB_EVENT_NAME,
    triggerActor: process.env.GITHUB_ACTOR,
    payload: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")),
    bridgeRunUrl: `${
      process.env.GITHUB_SERVER_URL || "https://github.com"
    }/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  });
  const output = JSON.stringify(result, null, 2);
  console.log(output);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Linear wakeup evidence\n\n<pre>${output
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")}</pre>\n`
    );
  if (result.some((item) => item.operation === "failed")) process.exitCode = 1;
}

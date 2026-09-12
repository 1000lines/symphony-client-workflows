import { linearRequest, redactToken } from "../../../scripts/linear-issue-wakeup.mjs";

// Linear's attachment collection is the association authority. Never use its
// cached PR status: every associated GitHub PR is read through pulls.get.
export function prReference(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("Invalid attachment URL."); }
  const match = parsed.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?:\/(?:files|commits|checks))?\/?$/);
  if (parsed.protocol === "https:" && parsed.hostname === "github.com" && !parsed.port &&
      !parsed.username && !parsed.password && match && Number.isSafeInteger(Number(match[3]))) {
    const repo = `${match[1]}/${match[2]}`.toLowerCase();
    return { repo, number: Number(match[3]), url: `https://github.com/${repo}/pull/${Number(match[3])}` };
  }
  if (/\/(pulls?|pull-requests|merge_requests)(\/|$)/i.test(parsed.pathname)) {
    throw new Error(`Unsupported or malformed PR attachment: ${url}`);
  }
  return null;
}

async function pages(read, description) {
  const nodes = [], seen = new Set();
  let after = null;
  for (let page = 0; page < 100; page++) {
    const connection = await read(after);
    if (!Array.isArray(connection?.nodes) || typeof connection.pageInfo?.hasNextPage !== "boolean") {
      throw new Error(`Incomplete ${description} lookup.`);
    }
    nodes.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) return nodes;
    after = connection.pageInfo.endCursor;
    if (!after || seen.has(after)) throw new Error(`Incomplete ${description} pagination.`);
    seen.add(after);
  }
  throw new Error(`${description} pagination limit exceeded.`);
}

const issueFields = `id identifier updatedAt state { id name type } team { id key }`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function reconcilePrClose({ github, repo, number, teamKey, linearToken, fetchImpl = fetch }) {
  const result = { operation: "skipped", repository: repo, number, attempts: 0 };
  const linear = (query, variables) => linearRequest({ query, variables, token: linearToken,
    fetchImpl, operation: "reconcile closed PR" });
  const readIssue = async (id) => {
    const { issue } = await linear(`query CloseIssue($id:String!) { issue(id:$id) { ${issueFields} } }`, { id });
    if (!issue?.id || !issue.identifier || !issue.updatedAt || !issue.state?.id || !issue.state.name ||
        !issue.team?.id || issue.team.key !== teamKey) throw new Error("Missing issue data or configured team mismatch.");
    return issue;
  };
  const readPr = async (ref) => {
    const [owner, repository] = ref.repo.split("/");
    const { data: pr } = await github.rest.pulls.get({ owner, repo: repository, pull_number: ref.number });
    if (pr?.number !== ref.number || prReference(pr.html_url)?.url !== ref.url ||
        pr.base?.repo?.full_name?.toLowerCase() !== ref.repo ||
        !["open", "closed"].includes(pr.state) || typeof pr.merged !== "boolean" ||
        (pr.state === "open" && pr.merged)) throw new Error(`Incomplete current PR data: ${ref.url}`);
    return pr;
  };
  const snapshot = async () => {
    const trigger = prReference(`https://github.com/${repo}/pull/${number}`);
    if (!trigger || !/^[A-Z0-9]+$/.test(teamKey)) throw new Error("Invalid close event identity/configuration.");
    const pr = await readPr(trigger);
    const links = await pages(async (after) => (await linear(`query CloseLinks($url:String!,$after:String) {
      attachmentsForURL(url:$url,first:100,after:$after) {
        nodes { issue { id identifier } } pageInfo { hasNextPage endCursor }
      }
    }`, { url: trigger.url, after })).attachmentsForURL, "trigger association");
    if (links.some(link => !link?.issue?.id || !link.issue.identifier)) throw new Error("Incomplete trigger association.");
    const linkedIds = [...new Set(links.map(link => link.issue.id))];
    const title = pr.title?.match(/^\[([A-Z0-9]+-[1-9]\d*)\]/i)?.[1]?.toUpperCase();
    const branchIds = [...String(pr.head?.ref || "").matchAll(/\b[A-Z0-9]+-[1-9]\d*\b/gi)].map(m => m[0].toUpperCase());
    const hints = [...new Set([title, ...branchIds].filter(Boolean))];
    if (linkedIds.length > 1 || hints.length > 1) throw new Error("Ambiguous Linear issue association.");
    if (!linkedIds.length && !hints.length) throw new Error("Missing Linear issue association.");
    const issue = await readIssue(linkedIds[0] || hints[0]);
    if (hints.length && hints[0] !== issue.identifier) throw new Error("PR title/branch disagrees with Linear association.");
    const attachments = await pages(async (after) => (await linear(`query CloseAttachments($id:String!,$after:String) {
      issue(id:$id) { attachments(first:100,after:$after) {
        nodes { url } pageInfo { hasNextPage endCursor }
      } }
    }`, { id: issue.id, after })).issue?.attachments, "issue attachment");
    const refs = new Map([[trigger.url, trigger]]);
    for (const attachment of attachments) {
      const ref = prReference(attachment?.url);
      if (ref) refs.set(ref.url, ref);
    }
    const prs = [];
    for (const ref of [...refs.values()].sort((a, b) => a.url.localeCompare(b.url))) {
      const current = ref.url === trigger.url ? pr : await readPr(ref);
      prs.push({ ...ref, state: current.state, merged: current.merged });
    }
    return { issue, prs };
  };
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      result.attempts = attempt;
      const before = await snapshot();
      Object.assign(result, { issue: before.issue.identifier, previousState: before.issue.state.name, prs: before.prs });
      if (before.prs.some(pr => pr.state === "open")) return { ...result, reason: "associated-pr-open" };
      // Retry with new associations AND new PR reads, not the stale event or a
      // previous desired state. This also catches a reopened triggering PR.
      const current = await snapshot();
      if (!same(before, current)) continue;
      const merged = current.prs.some(pr => pr.merged);
      const states = await pages(async (after) => (await linear(`query CloseStates($id:String!,$after:String) {
        team(id:$id) { states(first:100,after:$after) { nodes { id name type } pageInfo { hasNextPage endCursor } } }
      }`, { id: current.issue.team.id, after })).team?.states, "team state");
      const targets = states.filter(state => merged
        ? state?.name?.toLowerCase() === "done" && state.type === "completed"
        : ["canceled", "cancelled"].includes(state?.name?.toLowerCase()) && state.type === "canceled");
      if (targets.length !== 1 || !targets[0].id) throw new Error("Missing or ambiguous team terminal workflow state.");
      const target = targets[0];
      // Linear has no compare-and-set issue mutation. Check updatedAt as well
      // as state immediately before writing, and yield to sustained contention.
      const latest = await readIssue(current.issue.id);
      if (!same(latest, current.issue)) continue;
      if (latest.state.id === target.id) return { ...result, operation: "unchanged", reason: "already-correct", state: target.name };
      result.mutation = { issueId: latest.id, stateId: target.id, confirmed: false };
      let mutationError;
      try {
        const data = await linear(`mutation CloseIssueUpdate($id:String!,$stateId:String!) {
          issueUpdate(id:$id,input:{stateId:$stateId}) { success issue { id state { id } } }
        }`, { id: latest.id, stateId: target.id });
        if (!data.issueUpdate?.success || data.issueUpdate.issue?.id !== latest.id ||
            data.issueUpdate.issue.state?.id !== target.id) throw new Error("Unconfirmed Linear state mutation.");
        result.mutation.confirmed = true;
      } catch (error) { mutationError = error; }
      // An ambiguous transport failure may have committed. Read it back instead
      // of writing twice. Never fight a writer or undo a newly observed change.
      const observed = await snapshot();
      if (observed.issue.id !== latest.id || observed.issue.state.id !== target.id || !same(observed.prs, current.prs)) {
        throw new Error(mutationError ? `Mutation unconfirmed: ${mutationError.message}` : "Concurrent change after mutation; no further writes attempted.");
      }
      result.mutation.confirmed = true;
      return { ...result, operation: "updated", state: observed.issue.state.name, reason: mutationError ? "confirmed-by-readback" : "all-associated-prs-closed" };
    }
    return { ...result, reason: "concurrent-change-retry-limit" };
  } catch (error) {
    return { ...result, operation: "failed", reason: redactToken(error.message, linearToken) };
  }
}

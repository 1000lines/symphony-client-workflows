import assert from "node:assert/strict";

// Run metadata selects API records; only those records identify the current
// PR and feedback author. Consumers still check that author's write permission.
export async function resolveCadenceEvent({ github, context }) {
  const run = context.payload.workflow_run;
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  assert.equal(context.ref, "refs/heads/main");
  assert.equal(run.repository.full_name, repository);
  assert.equal(run.path, ".github/workflows/cadence-review-ingress.yml");
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success");
  const { event: eventName, action, number, id, head } = JSON.parse(run.display_title);
  const actions = {
    pull_request_target: ["opened", "ready_for_review", "synchronize"],
    issue_comment: ["created", "edited"],
    pull_request_review: ["submitted", "edited"],
    pull_request_review_comment: ["created", "edited"],
  };
  assert.equal(eventName, run.event);
  assert.ok(actions[eventName]?.includes(action) && Number.isSafeInteger(number) && number > 0);
  assert.ok(run.actor?.id && run.actor?.login && run.actor?.type);
  const read = async path => (await github.request(`GET /repos/${repository}${path}`)).data;
  const pr = await read(`/pulls/${number}`);
  assert.ok(pr.number === number && pr.base?.repo?.full_name === repository && pr.state === "open" && pr.head?.sha);
  assert.ok(eventName === "issue_comment" || head === pr.head.sha, "Stale event head");
  const payload = { action, repository: run.repository, pull_request: pr, sender: run.actor };
  if (eventName !== "pull_request_target") {
    assert.ok(Number.isSafeInteger(id) && id > 0);
    const review = eventName === "pull_request_review", comment = eventName === "issue_comment";
    const feedback = await read(review ? `/pulls/${number}/reviews/${id}` : `/${comment ? "issues" : "pulls"}/comments/${id}`);
    assert.ok(feedback.id === id && feedback.user?.id && feedback.user?.login, "Missing feedback author");
    assert.equal(comment ? feedback.issue_url : feedback.pull_request_url,
      `https://api.github.com/repos/${repository}/${comment ? "issues" : "pulls"}/${number}`);
    assert.ok(!review || feedback.submitted_at, "Unsubmitted review");
    assert.ok(comment || feedback.commit_id === pr.head.sha, "Stale feedback head");
    payload[review ? "review" : "comment"] = feedback;
    if (comment) payload.issue = { ...pr, pull_request: { url: pr.url } };
  }
  return { payload, eventName };
}

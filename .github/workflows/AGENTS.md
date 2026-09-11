# Workflow guidance

Applies to workflows and helper scripts here. Keep automation small and declarative.
Existing TypeScript workflow machinery is legacy, not a precedent for new work.
Reduce custom orchestration using native GitHub features and maintained Actions;
translating the same machinery to JavaScript is not simplification.

Implement the smallest complete behavior requested. Treat existing code and
plans as context, not a reason to preserve or expand machinery. Revise obsolete
assumptions when human direction changes. Judge size across YAML, helpers, and
tests; moving complexity behind a short wrapper does not reduce it.

## Build on GitHub

- Prefer native events, filters, job-level `if`, `needs`, and concurrency. Reject irrelevant
  work before allocating runners; step-level guards still consume a runner.
- Prefer reusable workflows and maintained Actions, especially official GitHub/vendor
  Actions. Check permissions and maintenance; pin external Actions to full commit SHAs.
- Fill remaining API gaps with short `gh` or `actions/github-script` steps. Add JS/TS
  helpers only for logic these cannot express clearly; explain the gap in the PR.
- Custom code must still use standard features for filtering, scheduling, concurrency,
  authentication, checkout, and artifacts. Feed their outputs into the smallest possible
  helper; needing custom logic does not justify rebuilding its supporting machinery.

## Keep work bounded

- Prefer events to polling or runner sleeps. Schedule bounded recovery only where needed.
- Use native concurrency before custom queues or controllers. Scope locks per resource;
  keep long assessments outside mutation locks.
- Cancel obsolete work safely; recheck current head and authority before publication.
  Tolerate duplicate events and late results.
- Reuse checks and outputs. Avoid duplicate triggers, builds, and installations.
  Filters must not strand required checks. Set timeouts and clear job names.

## Keep authority explicit

- Minimize job permissions and secrets. Prefer `GITHUB_TOKEN`, short-lived App tokens,
  or OIDC over additional long-lived credentials.
- Never execute PR-controlled code in privileged jobs or interpolate PR text into shell.
- Run privileged work on trusted refs. Checkout does not change environment eligibility;
  fix routing rather than widening secret access.
- Mechanically verify the original human author's write permission before obeying feedback.

Validate changed event/ref/permission paths and meaningful edge cases; keep tests proportional.
Explain exceptions in the PR without adding approval gates.
Consult [GitHub's syntax reference](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
before inventing workarounds.

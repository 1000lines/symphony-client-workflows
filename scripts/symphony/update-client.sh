#!/usr/bin/env bash
# Preserve this repository's provider implementations and native event routing.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
"${COPIER:-copier}" update --defaults --vcs-ref="${1:-main}" \
  --exclude=.symphony.cfg.json \
  --exclude=.github/workflows/cadence-ai-review-events.yml \
  --exclude=.github/workflows/cadence-ai-review-trigger.yml \
  --exclude=.github/workflows/cadence-ai-review.yml \
  --exclude=.github/workflows/cadence-linear-rework.yml \
  --exclude=.github/workflows/cadence-review-check-cleanup.yml \
  --exclude=.github/workflows/cadence-review-ingress.yml \
  --exclude=.github/workflows/symphony-client-wakeups.yml \
  --exclude=.github/workflows/symphony-client-ci.yml

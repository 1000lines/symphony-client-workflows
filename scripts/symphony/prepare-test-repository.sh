#!/usr/bin/env bash
# Prepare files only. Repository creation and credentials use normal onboarding.
set -euo pipefail

if [[ $# != 4 ]]; then
  echo 'Usage: prepare-test-repository.sh OWNER/test-repo-N DEST TEMPLATE_SOURCE TEMPLATE_SHA' >&2
  exit 2
fi
fixture_repo=$1
fixture_dest=$2
template_source=$3
template_sha=$4
if [[ ! $fixture_repo =~ ^[A-Za-z0-9][A-Za-z0-9-]*/test-repo-[1-9][0-9]*$ ]]; then
  echo 'Select an explicit owner and repository matching test-repo-<positive integer>.' >&2
  exit 2
fi
if [[ ! $template_sha =~ ^[a-f0-9]{40}$ ]]; then
  echo 'Resolve the reviewed template main to its full commit SHA first.' >&2
  exit 2
fi
if [[ -e $fixture_dest ]]; then
  echo 'Destination must not exist; review updates separately through Copier.' >&2
  exit 2
fi
fixture_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
"${COPIER:-copier}" copy --defaults --vcs-ref="$template_sha" \
  --data "repo_slug=$fixture_repo" --data default_branch=main \
  --data linear_team_key=100 --data symphony_app_slug=1000lines-symphony \
  --data cadence_app_slug=1000lines-cadence --data cadence_reviewer=codex \
  --data 'build_command=node --check src/greeting.mjs' \
  --data 'test_command=node --test test/*.test.mjs' \
  "$template_source" "$fixture_dest"
cp -R "$fixture_root/fixtures/workflow-tests/client/." "$fixture_dest/"
cp "$fixture_root/docs/engineering/symphony/workflow-test-repository.md" "$fixture_dest/README.md"
printf '%s\n' "Prepared $fixture_repo in $fixture_dest from template $template_sha."
printf '%s\n' 'Review the files, then follow README.md for owner provisioning and CI readback.'

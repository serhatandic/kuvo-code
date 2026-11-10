#!/usr/bin/env bash
# Push a work branch to CI and optionally wait for its result.
set -euo pipefail

wait_for_run=false
branch=""
for arg in "$@"; do
  case "$arg" in
    --wait) wait_for_run=true ;;
    -*) echo "Usage: $0 [--wait] [branch]" >&2; exit 2 ;;
    *)
      if [[ -n "$branch" ]]; then echo "Usage: $0 [--wait] [branch]" >&2; exit 2; fi
      branch="$arg" ;;
  esac
done
branch="${branch:-$(git symbolic-ref --quiet --short HEAD || true)}"
if [[ -z "$branch" || "$branch" == main ]]; then
  echo "Choose a local work branch; main and detached HEAD cannot be pushed." >&2
  exit 1
fi
git show-ref --verify --quiet "refs/heads/$branch" || { echo "Not a local branch: $branch" >&2; exit 1; }
remote_branch="ci/${branch#kuvo/}"
git check-ref-format "refs/heads/$remote_branch"
remote_url=$(git remote get-url --push origin)
case "$remote_url" in
  git@*:*|ssh://*) ;;
  *) echo "origin's push URL must use SSH." >&2; exit 1 ;;
esac
sha=$(git rev-parse "refs/heads/$branch^{commit}")
repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
git push --force-with-lease origin "$sha:refs/heads/$remote_branch"

# GitHub may take a little while to create the run after accepting the push.
run_id=""
for ((attempt=0; attempt<60; attempt++)); do
  run_id=$(gh run list --repo "$repo" --workflow ci.yml --branch "$remote_branch" --event push --limit 100 \
    --json databaseId,headSha --jq ".[] | select(.headSha == \"$sha\") | .databaseId" | head -n 1)
  [[ -n "$run_id" ]] && break
  sleep 5
done
if [[ -z "$run_id" ]]; then echo "CI run did not appear for $sha on $remote_branch." >&2; exit 1; fi
gh run view "$run_id" --repo "$repo" --json url --jq .url
if $wait_for_run; then
  status=0
  gh run watch "$run_id" --repo "$repo" --exit-status || status=$?
  gh run view "$run_id" --repo "$repo" --json jobs --jq '.jobs[] | "\(.name): \(.conclusion // .status)"'
  if [[ $status -ne 0 ]]; then
    gh run view "$run_id" --repo "$repo" --log-failed || true
  fi
  exit "$status"
fi

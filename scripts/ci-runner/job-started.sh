#!/bin/bash
# Runs before every job the Mac mini's runner takes (ACTIONS_RUNNER_HOOK_JOB_STARTED, set up by
# scripts/ci-runner/setup.sh). A job it refuses fails before any of its steps run.
#
# The workflows send only pushes to main, release tags, and runs started by hand from main or a
# tag here (the `runs-on` of ci.yml's and release.yml's macOS jobs); every pull request runs on
# GitHub's runners. This holds that line on the Mini itself: a pull request's workflow comes from
# its branch, and one from a fork could name the Mini's labels. So it refuses anything that isn't
# that, whatever the workflow says. The default variables it reads are the runner's own, which a
# workflow can't set.
#
# Then it tidies what an earlier job may have left when it was stopped part way (common.sh).
set -uo pipefail

REPOSITORY="serhatandic/kuvo-code"

refuse() {
    echo "::error title=Refused by the Mac mini::$1 Only pushes to main, release tags and runs started by hand from main or a tag run on the Mac mini's runner (scripts/ci-runner/job-started.sh)."
    exit 1
}

[[ "${GITHUB_REPOSITORY:-}" == "$REPOSITORY" ]] \
    || refuse "This job is for ${GITHUB_REPOSITORY:-an unknown repository}, not $REPOSITORY."
case "${GITHUB_EVENT_NAME:-}" in
    push | workflow_dispatch) ;;
    *) refuse "A ${GITHUB_EVENT_NAME:-unknown} event's job." ;;
esac
case "${GITHUB_REF:-}" in
    refs/heads/main | refs/tags/v*) ;;
    *) refuse "A job for ${GITHUB_REF:-an unknown ref}." ;;
esac
# The event itself, as GitHub sent it: none for a pull request reaches here.
[[ -f "${GITHUB_EVENT_PATH:-}" ]] || refuse "The job has no event payload."
if plutil -type pull_request "$GITHUB_EVENT_PATH" >/dev/null 2>&1; then
    refuse "The event is a pull request's."
fi
[[ "$(plutil -extract repository.full_name raw -o - "$GITHUB_EVENT_PATH" 2>/dev/null)" == "$REPOSITORY" ]] \
    || refuse "The event isn't from $REPOSITORY."

echo "Taking $GITHUB_EVENT_NAME on $GITHUB_REF (${GITHUB_WORKFLOW_REF:-}) by ${GITHUB_ACTOR:-unknown}."

# shellcheck source=scripts/ci-runner/common.sh
. "$(dirname "$0")/common.sh"
clean_signing
detach_images
report_disk
exit 0

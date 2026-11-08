#!/bin/bash
# Runs before every job the Mac mini's runner takes (ACTIONS_RUNNER_HOOK_JOB_STARTED, set up by
# scripts/ci-runner/setup.sh).
#
# The workflows send only pushes to main, release tags, and runs started by hand from main or a
# tag here (the `runs-on` of ci.yml's and release.yml's macOS jobs); every pull request runs on
# GitHub's runners. This holds that line on the Mini itself: a pull request's workflow comes from
# its branch, and one from a fork could name the Mini's labels. So it refuses anything that isn't
# that, whatever the workflow says. The variables it reads are the runner's own: a hook starts
# with none of the workflow's `env`, and the runner sets the GITHUB_* ones itself.
#
# Refusing means stopping the job's worker. A hook that only fails is the job's first step
# failing: steps marked `if: always()`, and actions' `pre:` steps, would still run. So it stops
# its own job's Runner.Worker (found by walking up from this script, checked by its path, killed
# by its PID, never by name); the runner reports the job failed and waits for the next one.
#
# It refuses every job, too, when an earlier one left something in ci's account to run later
# (common.sh, account_tampered): that needs a person to look. Read what it names and what's in
# ci's account; if it was nothing bad, take out the login agent or crontab it names, and run
# scripts/ci-runner/setup.sh again, which writes the runner's .env and .path afresh. If it was,
# treat the release secrets as exposed: rotate them, and set up ci again from scratch.
#
# Then it tidies what an earlier job may have left when it was stopped part way.
set -uo pipefail

# shellcheck source=scripts/ci-runner/common.sh
. "$(dirname "$0")/common.sh"

refuse() {
    echo "::error title=Refused by the Mac mini::$1"
    local pid=$$ command
    while [[ "${pid:-1}" -gt 1 ]]; do
        pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
        [[ -n "$pid" ]] || break
        command="$(ps -o comm= -p "$pid" 2>/dev/null)"
        # bin, or bin.<version> while the runner updates itself.
        if [[ "$command" == "$RUNNER_DIR"/bin/Runner.Worker || "$command" == "$RUNNER_DIR"/bin.*/Runner.Worker ]]; then
            echo "Stopping this job's worker ($pid) so none of its steps run."
            kill -KILL "$pid"
            exit 1
        fi
    done
    echo "::error::Couldn't find this job's Runner.Worker to stop it."
    exit 1
}

not_allowed() {
    refuse "$1 Only pushes to main, release tags and runs started by hand from main or a tag run on the Mac mini's runner (scripts/ci-runner/job-started.sh)."
}

[[ "${GITHUB_REPOSITORY:-}" == "$REPOSITORY" ]] \
    || not_allowed "This job is for ${GITHUB_REPOSITORY:-an unknown repository}, not $REPOSITORY."
case "${GITHUB_EVENT_NAME:-}" in
    push | workflow_dispatch) ;;
    *) not_allowed "A ${GITHUB_EVENT_NAME:-unknown} event's job." ;;
esac
case "${GITHUB_REF:-}" in
    refs/heads/main | refs/tags/v*) ;;
    *) not_allowed "A job for ${GITHUB_REF:-an unknown ref}." ;;
esac
# The event itself, as GitHub sent it: none for a pull request reaches here.
[[ -f "${GITHUB_EVENT_PATH:-}" ]] || not_allowed "The job has no event payload."
if plutil -type pull_request "$GITHUB_EVENT_PATH" >/dev/null 2>&1; then
    not_allowed "The event is a pull request's."
fi
[[ "$(plutil -extract repository.full_name raw -o - "$GITHUB_EVENT_PATH" 2>/dev/null)" == "$REPOSITORY" ]] \
    || not_allowed "The event isn't from $REPOSITORY."

if ! tampered="$(account_tampered)"; then
    refuse "An earlier job changed ci's account, so no job runs until someone looks (scripts/ci-runner/job-started.sh says how): $(tr '\n' ' ' <<< "$tampered")"
fi

echo "Taking $GITHUB_EVENT_NAME on $GITHUB_REF (${GITHUB_WORKFLOW_REF:-}) by ${GITHUB_ACTOR:-unknown}."

# A release hands its steps the signing secrets: it starts with tools downloaded afresh, not ones
# an earlier job could have changed (setup-node's and setup-bun's cache).
if [[ "${GITHUB_WORKFLOW_REF:-}" == "$REPOSITORY/.github/workflows/release.yml@"* ]]; then
    echo "A release: deleting the tool cache, so it downloads its tools again."
    chmod -R u+w "$WORK_DIR/_tool" 2>/dev/null || true
    rm -rf "$WORK_DIR/_tool"
fi

clean_signing
detach_images
report_disk
exit 0

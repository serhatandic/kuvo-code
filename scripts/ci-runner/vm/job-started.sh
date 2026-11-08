#!/bin/bash
# Runs inside each CI VM on the Mac mini, before the job (the runner's pre-job hook,
# ACTIONS_RUNNER_HOOK_JOB_STARTED; build-image.sh installs it in the golden image).
#
# The workflows send only pushes to main, release tags, and runs started by hand from main or a
# tag to the Mini (the `runs-on` of ci.yml's and release.yml's macOS jobs); pull requests run on
# GitHub's runners. A pull request's workflow comes from its branch, though, and one from a fork
# could name the Mini's labels. This refuses it before any of its steps run. The VM is fresh, so
# nothing a job does can change this hook before it runs; the variables it reads are the
# runner's own (a hook starts with none of the workflow's `env`, and the runner sets GITHUB_*).
# The orchestrator checks the same on the host too, from GitHub's side, and stops the VM.
#
# Refusing means stopping the job's worker: a hook that only fails is the job's first step
# failing, and steps marked `if: always()`, and actions' `pre:` steps, would still run. If the
# worker can't be found among this script's parents, the VM shuts down instead. Everything it
# runs is named by its full path, so a PATH from the job (if one ever reached a hook) can't stop it.
set -uo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

REPOSITORY="serhatandic/kuvo-code"

refuse() {
    echo "::error title=Refused by the Mac mini::$1 Only pushes to main, release tags and runs started by hand from main or a tag run on the Mac mini (scripts/ci-runner/vm/job-started.sh)."
    local pid=$$ command
    while [[ "${pid:-1}" -gt 1 ]]; do
        pid="$(/bin/ps -o ppid= -p "$pid" 2>/dev/null | /usr/bin/tr -d ' ')"
        [[ -n "$pid" ]] || break
        command="$(/bin/ps -o comm= -p "$pid" 2>/dev/null)"
        if [[ "${command##*/}" == Runner.Worker ]]; then
            echo "Stopping this job's worker ($pid) so none of its steps run."
            /bin/kill -KILL "$pid" && exit 1
            break
        fi
    done
    echo "::error::Couldn't stop this job's worker: shutting the VM down instead."
    /usr/bin/sudo -n /sbin/shutdown -h now
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
if /usr/bin/plutil -type pull_request "$GITHUB_EVENT_PATH" >/dev/null 2>&1; then
    refuse "The event is a pull request's."
fi
[[ "$(/usr/bin/plutil -extract repository.full_name raw -o - "$GITHUB_EVENT_PATH" 2>/dev/null)" == "$REPOSITORY" ]] \
    || refuse "The event isn't from $REPOSITORY."

echo "Taking $GITHUB_EVENT_NAME on $GITHUB_REF (${GITHUB_WORKFLOW_REF:-}) by ${GITHUB_ACTOR:-unknown}, in a fresh VM."
exit 0

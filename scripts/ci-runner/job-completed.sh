#!/bin/bash
# Runs after every job on the Mac mini's runner, whether it passed, failed or was cancelled
# (ACTIONS_RUNNER_HOOK_JOB_COMPLETED, set up by scripts/ci-runner/setup.sh). GitHub's runners
# start each job on a fresh machine; this one keeps everything, so this puts it back: no signing
# keychain or mounted disk image left, and the checkout and its builds deleted, so the next job
# starts from a clean clone. (The runner itself empties its temporary folder and stops what the
# job left running.) Never fails the job.
set -uo pipefail

# shellcheck source=scripts/ci-runner/common.sh
. "$(dirname "$0")/common.sh"
clean_signing
detach_images

# The job's checkout (_work/<repo>/<repo>), only ever inside the runner's work folder.
workspace="${GITHUB_WORKSPACE:-}"
if [[ -n "$workspace" && "$workspace" == "$WORK_DIR/"* && "$workspace" != *..* && -d "$workspace" ]]; then
    echo "Deleting the job's checkout: $workspace"
    chmod -R u+w "$workspace" 2>/dev/null || true
    rm -rf "$workspace" 2>/dev/null || true
    mkdir -p "$workspace" 2>/dev/null || true
fi

report_disk
exit 0

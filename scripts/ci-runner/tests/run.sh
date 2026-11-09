#!/bin/bash
# shellcheck disable=SC2016 # what's in single quotes runs in the stand-ins, later
# Tests for the Mac mini's CI orchestrator and the VM's pre-job hook, without a VM, GitHub or
# root: a stand-in GitHub (stub-github.py, on 127.0.0.1) and a stand-in Tart (stub-tart), each
# test in a folder of its own, all deleted after. What they check is what the orchestrator does:
# which jobs it lets run, which VMs it stops and why, what it logs, how it waits.
#
#   scripts/ci-runner/tests/run.sh [name…]     (about two minutes; the names below)
set -uo pipefail
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"

here="$(cd "$(dirname "$0")" && pwd)"
ci="$(cd "$here/.." && pwd)"
root="$(mktemp -d "${TMPDIR:-/tmp}/kuvo-ci-tests.XXXXXX")"
server_pid=""
cleanup() {
    if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null; wait "$server_pid" 2>/dev/null; fi
    # A stand-in VM a test left running: by its PID, from its own file.
    local pidfile
    for pidfile in "$root"/*/tart/run.pid; do
        [[ -f "$pidfile" ]] && kill "$(cat "$pidfile")" 2>/dev/null
    done
    rm -rf "$root"
}
trap cleanup EXIT

# shellcheck source=scripts/ci-runner/common.sh
. "$ci/common.sh" # run_limited
mkdir -p "$root/gh"
echo '{"token": "github_pat_TEST"}' > "$root/gh/scenario.json"
/usr/bin/python3 -I "$here/stub-github.py" "$root/gh" &
server_pid=$!
for _ in $(seq 1 50); do [[ -s "$root/gh/port" ]] && break; sleep 0.1; done
port="$(cat "$root/gh/port")" || { echo "The stand-in GitHub didn't start." >&2; exit 1; }

passed=0 failed=0 t=""
fail() {
    echo "  FAIL: $1"
    failed_here=1
}
expect_log() { grep -qF -- "$1" "$t/log" || fail "the log doesn't say: $1"; }
refute_log() { ! grep -qF -- "$1" "$t/log" || fail "the log says: $1"; }
expect_rc() { grep -qx "rc=$1" "$t/log" || fail "one_job didn't return $1 ($(grep '^rc=' "$t/log"))"; }
# Every job test: it ended, and on its own.
done_test() { ! grep -qx "rc=hung" "$t/log" || fail "it hung"; }

# GitHub's state for the next test, as JSON (stub-github.py says what it can hold).
scenario() { printf '%s\n' "$1" > "$root/gh/scenario.json"; }
ALLOWED='"busy": true, "runs": [{"id": 1001, "event": "push", "head_branch": "main"}], "jobs": {"1001": [42]}'

# A fresh folder for a test; $1 is what the stand-in runner does (stub-tart's runner.sh).
new_test() { # name runner.sh
    t="$root/$1"
    mkdir -p "$t/tart" "$t/bin" "$t/shared/run" "$t/logs"
    cp "$here/stub-tart" "$t/bin/tart"
    printf '%s\n' "$2" > "$t/tart/runner.sh"
    echo github_pat_TEST > "$t/token"
    echo v1 > "$t/shared/golden-version"
    : > "$root/gh/requests.log"
    failed_here=""
    echo "$1"
}

# Sources the orchestrator in a subshell, points it at the test's folders and the stand-ins,
# applies $1 (more settings), runs one job and ends it. Its log: $t/log.
run_job() { # [settings]
    # No job here takes a minute: one that does hangs (end_job waiting on a VM nobody stopped,
    # say), and fails here rather than holding the run.
    local rc
    run_limited 60 run_job_here "$@"
    rc=$?
    [[ $rc -ne 143 && $rc -ne 137 ]] || echo "rc=hung" >> "$t/log"
}
# In the background shell run_limited starts, which nothing else shares.
run_job_here() {
    {
        # shellcheck source=scripts/ci-runner/orchestrator.sh
        . "$ci/orchestrator.sh"
        export PATH="$t/bin:/usr/bin:/bin:/usr/sbin:/sbin" KUVO_TEST_TART="$t/tart" KUVO_TEST_ROOT="$t"
        API_BASE="http://127.0.0.1:$port" API_PROTO="=http"
        TOKEN_FILE="$t/token" TART_DIR="$t/tart" LOG_DIR="$t/logs" STATE_DIR="$t/state"
        SHARED="$t/shared" SHARED_RUN="$t/shared/run" PAUSED="$t/shared/paused"
        LOCAL_VERSION="$t/shared/golden-version"
        CONFIRM_SECONDS=6 MARKER_SECONDS=3 BUSY_EVERY=1 READ_SECONDS=1 IP_EVERY=100000 BOOT_SECONDS=5
        verify_tree() { :; }
        ip_lookups() { echo "203.0.113.7 203.0.113.7"; }
        free_gb() { echo 500; }
        eval "${1:-}"
        started=$SECONDS
        one_job
        rc=$?
        end_job
        echo "rc=$rc"
        echo "seconds=$((SECONDS - started))"
    } > "$t/log" 2>&1
}
vm_gone() { ! kill -0 "$(cat "$t/tart/run.pid" 2>/dev/null)" 2>/dev/null && [[ -z "$(ls "$t/tart/vms" 2>/dev/null)" ]]; }

RUNNER_JOB='say "Connected to GitHub"; vm_sleep 1; say "2026-11-09 10:00:00Z: Running job: build and test"; vm_sleep 6; say "Job build and test completed with result: Succeeded"'
RUNNER_LONG='say "Connected to GitHub"; vm_sleep 1; say "2026-11-09 10:00:00Z: Running job: build and test"; vm_sleep 60'

t_allowed_job_runs() {
    new_test allowed_job_runs "$RUNNER_JOB"
    scenario "{\"token\": \"github_pat_TEST\", $ALLOWED}"
    echo 1001 > "$t/tart/marker"
    run_job
    expect_rc 0
    expect_log "host check: run 1001, push on main, is ours"
    expect_log "the VM's pre-job hook ran for run 1001"
    expect_log "guest| Job build and test completed with result: Succeeded"
    refute_log "stopping the VM"
    [[ "$(cat "$t/tart/jit-received")" == SklUQ09ORklH ]] || fail "the VM didn't get the runner config"
    grep -q 'labels.*self-hosted.*macOS.*ARM64.*kuvo-mini' "$root/gh/jit-request.json" || fail "the runner config didn't ask for the four labels"
    grep -q -- '--net-softnet-block=.*,203.0.113.7/32' "$t/tart/run-flags" || fail "the VM didn't run with softnet blocking the public address"
    ! grep -v 'Bearer github_pat_TEST$' "$root/gh/requests.log" | grep -q . || fail "a request went without the token"
    grep -q '^DELETE .*/runners/42 ' "$root/gh/requests.log" || fail "the runner wasn't taken off GitHub after"
    vm_gone || fail "the VM is still there"
    grep -q '^state: ' "$t/shared/run/status" || fail "no status file"
    [[ "$(stat -f %Lp "$t/shared/run/status")" == 644 ]] || fail "the status file isn't readable by everyone"
    done_test
}

t_fork_job_stopped() {
    new_test fork_job_stopped "$RUNNER_LONG"
    scenario '{"token": "github_pat_TEST", "busy": true, "runs": [{"id": 1002, "event": "pull_request", "head_branch": "main", "head_repo": "someone/kuvo-code"}], "jobs": {"1002": [42]}}'
    echo 1002 > "$t/tart/marker"
    run_job
    expect_log "host check: run 1002, pull_request on main from someone/kuvo-code, isn't one the Mini takes: stopping the VM"
    refute_log "is ours"
    vm_gone || fail "the VM is still there"
    done_test
}

t_host_takes_only_main_and_release_tags() {
    # A branch named like a tag passes here (head_branch can't tell); the hook reads GITHUB_REF.
    new_test host_rule ""
    (
        . "$ci/orchestrator.sh"
        ok() { allowed "$@" || echo "  FAIL: refused $*"; }
        no() { ! allowed "$@" || echo "  FAIL: allowed $*"; }
        R=serhatandic/kuvo-code
        ok push main $R $R
        ok push v1.2.3 $R $R
        ok workflow_dispatch v0.7.0-beta.1 $R $R
        no push vfoo $R $R
        no push feature $R $R
        no pull_request main $R $R
        no pull_request_target main $R $R
        no schedule main $R $R
        no push main $R someone/kuvo-code
        no push main someone/kuvo-code someone/kuvo-code
    ) > "$t/log" 2>&1
    ! grep -q FAIL "$t/log" || fail "$(grep FAIL "$t/log" | tr '\n' ' ')"
    done_test
}

t_github_cant_tell_stops_the_vm() {
    new_test github_cant_tell "$RUNNER_LONG"
    scenario "{\"token\": \"github_pat_TEST\", \"busy\": true, \"runs_status\": 500}"
    run_job
    expect_log "host check: GitHub didn't show runner 42's job within 6 seconds: stopping the VM"
    vm_gone || fail "the VM is still there"
    done_test
}

t_github_silent_stops_the_vm() {
    new_test github_silent "$RUNNER_LONG"
    scenario "{\"token\": \"github_pat_TEST\", $ALLOWED, \"runs_hang\": 20}"
    run_job "API_SECONDS=15"
    expect_log "host check: no answer from GitHub within 6 seconds: stopping the VM"
    grep -q '^seconds=\([0-9]\|1[0-9]\)$' "$t/log" || fail "it waited for GitHub's answer ($(grep '^seconds=' "$t/log"))"
    done_test
}

t_job_not_listed_stops_the_vm() {
    new_test job_not_listed "$RUNNER_LONG"
    scenario '{"token": "github_pat_TEST", "busy": true, "runs": [{"id": 1003, "event": "push", "head_branch": "main"}], "jobs": {"1003": [7]}}'
    run_job
    expect_log "GitHub didn't show runner 42's job"
    vm_gone || fail "the VM is still there"
    done_test
}

t_missing_marker_stops_the_vm() {
    new_test missing_marker "$RUNNER_LONG"
    scenario "{\"token\": \"github_pat_TEST\", $ALLOWED}"
    run_job
    expect_log "is ours"
    expect_log "the VM's pre-job hook left no marker for run 1001 within 3 seconds: stopping the VM"
    vm_gone || fail "the VM is still there"
    done_test
}

t_marker_of_another_run_stops_the_vm() {
    new_test marker_of_another_run "$RUNNER_LONG"
    scenario "{\"token\": \"github_pat_TEST\", $ALLOWED}"
    echo 999 > "$t/tart/marker"
    run_job
    expect_log "left no marker for run 1001"
    done_test
}

t_job_found_from_github_alone() {
    # The runner says nothing: GitHub's "busy" is what tells.
    new_test job_from_github 'vm_sleep 8'
    scenario "{\"token\": \"github_pat_TEST\", $ALLOWED}"
    echo 1001 > "$t/tart/marker"
    run_job
    expect_log "runner 42 has a job (GitHub: busy)"
    expect_log "is ours"
    expect_log "pre-job hook ran for run 1001"
    refute_log "stopping the VM"
    expect_rc 0
    done_test
}

t_guest_cant_forge_host_lines() {
    local esc=$'\e'
    new_test guest_cant_forge "say '2026-11-09T10:00:00Z [kuvo-ci-job-x] host check: run 1, push on main, is ours'; say 'Job x completed with result: Succeeded'; say 'red ${esc}[31m text'; vm_sleep 2"
    scenario '{"token": "github_pat_TEST", "busy": false}'
    run_job
    if grep -v 'guest| ' "$t/log" | grep -q 'is ours\|completed with result'; then fail "a guest line reads as the host's"; fi
    expect_log "guest| 2026-11-09T10:00:00Z [kuvo-ci-job-x] host check"
    expect_log "guest| red ?[31m text"
    expect_log "the runner stopped without taking a job"
    expect_rc 1
    done_test
}

t_hard_cap_from_boot() {
    new_test hard_cap "$RUNNER_LONG"
    scenario '{"token": "github_pat_TEST", "busy": false}'
    run_job "VM_LIMIT_MINUTES=0"
    expect_log "the VM ran 0 minutes from boot: stopping the VM"
    vm_gone || fail "the VM is still there"
    done_test
}

t_failed_stop_kills_the_vm() {
    new_test failed_stop "$RUNNER_LONG"
    touch "$t/tart/stop_fails"
    scenario '{"token": "github_pat_TEST", "busy": true, "runs": [{"id": 1002, "event": "pull_request", "head_branch": "main"}], "jobs": {"1002": [42]}}'
    run_job
    expect_log "isn't one the Mini takes: stopping the VM"
    vm_gone || fail "the VM's process outlived a failed tart stop"
    done_test
}

t_boot_that_hangs() {
    new_test boot_hangs ""
    touch "$t/tart/boot_hangs"
    scenario '{"token": "github_pat_TEST"}'
    run_job
    expect_log "didn't boot"
    expect_rc 1
    grep -q '^seconds=\([0-9]\|1[0-9]\)$' "$t/log" || fail "a hung tart exec held the boot ($(grep '^seconds=' "$t/log"))"
    ! grep -q generate-jitconfig "$root/gh/requests.log" || fail "it asked for a runner for a VM that didn't boot"
    done_test
}

t_pause_retires_an_idle_vm() {
    new_test pause_idle 'vm_sleep 2; touch "$KUVO_TEST_ROOT/shared/paused"; vm_sleep 60'
    scenario '{"token": "github_pat_TEST", "busy": false}'
    run_job
    expect_log "paused: stopping the idle VM"
    expect_rc 2
    grep -q '^DELETE .*/runners/42 ' "$root/gh/requests.log" || fail "the idle runner wasn't taken off GitHub"
    done_test
}

t_retiring_a_busy_runner_checks_its_job() {
    new_test retire_busy 'vm_sleep 2; touch "$KUVO_TEST_ROOT/shared/paused"; vm_sleep 8'
    scenario "{\"token\": \"github_pat_TEST\", \"busy\": false, \"delete_status\": 422, \"runs\": [{\"id\": 1001, \"event\": \"push\", \"head_branch\": \"main\"}], \"jobs\": {\"1001\": [42]}}"
    echo 1001 > "$t/tart/marker"
    run_job "BUSY_EVERY=1000"
    expect_log "runner 42 has a job (GitHub: busy)"
    expect_log "is ours"
    refute_log "stopping the idle VM"
    expect_rc 0
    done_test
}

t_refused_runner_config_logs_no_body() {
    new_test refused_config ""
    scenario '{"token": "github_pat_TEST", "jit_status": 403}'
    run_job
    expect_log "GitHub refused a runner config: HTTP 403: No runners for you"
    refute_log "SECRET-IN-ERROR"
    expect_rc 1
    done_test
}

t_public_address_moving_stops_the_vm() {
    new_test address_moves "$RUNNER_LONG"
    scenario '{"token": "github_pat_TEST", "busy": false}'
    # One service says the new address, the other doesn't answer: that's enough.
    run_job 'IP_EVERY=1; ip_lookups() { if [[ -e "$t/looked" ]]; then echo "198.51.100.9 -"; else touch "$t/looked"; echo "203.0.113.7 203.0.113.7"; fi; }'
    expect_log "public address moved from 203.0.113.7 (now 198.51.100.9, -), which the VM may reach: stopping the VM"
    done_test
}

t_no_vm_without_space_or_address() {
    new_test no_space ""
    scenario '{"token": "github_pat_TEST"}'
    run_job 'free_gb() { echo 10; }'
    expect_log "Not starting a VM: 10 GB free"
    run_job 'public_ipv4() { return 1; }'
    expect_log "couldn't find this network's public address"
    [[ ! -s "$t/tart/calls.log" ]] || ! grep -q '^run ' "$t/tart/calls.log" || fail "a VM started"
    done_test
}

t_token_expiry_warns() {
    new_test token_expiry ""
    local soon
    soon="$(date -u -v+5d -v+12H '+%Y-%m-%d %H:%M:%S UTC')"
    scenario "{\"token\": \"github_pat_TEST\", \"expiration\": \"$soon\"}"
    (
        . "$ci/orchestrator.sh"
        API_BASE="http://127.0.0.1:$port" API_PROTO="=http" TOKEN_FILE="$t/token" STATE_DIR="$t/state"
        api GET "repos/$REPOSITORY/actions/runners/42" >/dev/null
        warn_token_expiry
    ) > "$t/log" 2>&1
    expect_log "The GitHub token expires in 5 days"
    done_test
}

t_bad_token_never_reaches_curl() {
    new_test bad_token ""
    printf 'abc"\nheader = "X-Evil: 1"\n' > "$t/token"
    (
        . "$ci/orchestrator.sh"
        API_BASE="http://127.0.0.1:$port" API_PROTO="=http" TOKEN_FILE="$t/token" STATE_DIR="$t/state"
        api GET "repos/$REPOSITORY/actions/runners/42"
        echo "rc=$?"
    ) > "$t/log" 2>&1
    expect_log "token"
    [[ ! -s "$root/gh/requests.log" ]] || fail "a request went out with a malformed token"
    done_test
}

t_status_never_follows_a_symlink() {
    new_test status_symlink ""
    mkdir -p "$t/elsewhere"
    rm -rf "$t/shared/run"
    ln -s "$t/elsewhere" "$t/shared/run"
    (
        . "$ci/orchestrator.sh"
        SHARED_RUN="$t/shared/run" STATE_DIR="$t/state"
        status idle "hello"
    ) > "$t/log" 2>&1
    [[ -z "$(ls "$t/elsewhere")" ]] || fail "the status went through a symlink"
    done_test
}

t_watchdog() {
    new_test watchdog ""
    (
        . "$ci/common.sh"
        s=$SECONDS
        run_limited 1 sleep 30
        echo "slept rc=$? after $((SECONDS - s))"
        s=$SECONDS
        run_limited 1 /bin/bash -c 'trap "" TERM; sleep 30'
        echo "stubborn rc=$? after $((SECONDS - s))"
        s=$SECONDS
        run_limited 30 true
        echo "quick rc=$? after $((SECONDS - s))"
        run_limited 30 false
        echo "failing rc=$?"
    ) > "$t/log" 2>&1
    grep -Eq '^slept rc=(143|1) after [1-3]$' "$t/log" || fail "a hung command wasn't stopped at its limit: $(grep slept "$t/log")"
    grep -Eq '^stubborn rc=137 after [5-8]$' "$t/log" || fail "a command ignoring TERM wasn't killed: $(grep stubborn "$t/log")"
    expect_log "quick rc=0 after 0"
    expect_log "failing rc=1"
    done_test
}

t_github_silent_about_the_runner_stops_the_vm() {
    new_test runner_state_unknown "vm_sleep 60"
    scenario '{"token": "github_pat_TEST", "busy": "error"}'
    run_job "UNKNOWN_SECONDS=3"
    expect_log "GitHub hasn't said for 3 seconds whether runner 42 has a job: stopping the VM"
    vm_gone || fail "the VM is still there"
}

t_address_that_cant_be_checked_stops_the_vm() {
    new_test address_unknown "vm_sleep 60"
    scenario '{"token": "github_pat_TEST", "busy": false}'
    run_job 'IP_EVERY=1; ip_lookups() { if [[ -e "$t/looked" ]]; then echo "- -"; else touch "$t/looked"; echo "203.0.113.7 203.0.113.7"; fi; }'
    expect_log "couldn't look up this network's public address"
    expect_log "public address couldn't be checked 3 times in a row (it may have moved): stopping the VM"
    refute_log "the runner stopped without taking a job"
}

t_one_lookup_service_down_doesnt_stop_a_job() {
    new_test one_lookup_down "vm_sleep 6"
    scenario '{"token": "github_pat_TEST", "busy": false}'
    run_job 'IP_EVERY=1; ip_lookups() { if [[ -e "$t/looked" ]]; then echo "- 203.0.113.7"; else touch "$t/looked"; echo "203.0.113.7 203.0.113.7"; fi; }'
    refute_log "stopping the VM"
    refute_log "couldn't look up"
    expect_log "the runner stopped without taking a job"
}

# An ACL anywhere in a big tree (big enough that ls is still writing when grep has its answer).
t_acl_check() {
    new_test acl_check ""
    mkdir -p "$t/tree/a"
    for i in $(seq 1 3000); do : > "$t/tree/a/file-with-a-long-name-$i"; done
    (
        . "$ci/common.sh"
        set -o pipefail
        has_acl "$t/tree" && echo "clean tree: ACL"
        chmod +a "everyone allow read" "$t/tree/a/file-with-a-long-name-1"
        has_acl "$t/tree" && echo "deep ACL seen"
        chmod -N "$t/tree/a/file-with-a-long-name-1"
        chmod +a "everyone allow list" "$t/tree"
        has_acl "$t/tree" && echo "top ACL seen"
        chmod -N "$t/tree"
    ) > "$t/log" 2>&1
    refute_log "clean tree: ACL"
    expect_log "deep ACL seen"
    expect_log "top ACL seen"
}

t_check_isolation_refuses_a_softnet_that_isnt_setuid() {
    new_test isolation_softnet ""
    printf '#!/bin/sh\nexit 0\n' > "$t/bin/softnet"
    chmod 755 "$t/bin/softnet"
    KUVO_TEST_TART="$t/tart" PATH="$t/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$ci/check-isolation.sh" > "$t/log" 2>&1
    echo "rc=$?" >> "$t/log"
    expect_log "isn't setuid root, and Tart would ask to make it so."
    expect_log "rc=1"
    [[ ! -s "$t/tart/calls.log" ]] || fail "it ran Tart: $(cat "$t/tart/calls.log")"
}

t_failed_retire_is_logged() {
    new_test retire_fails 'vm_sleep 2; touch "$KUVO_TEST_ROOT/shared/paused"; vm_sleep 60'
    scenario '{"token": "github_pat_TEST", "busy": false, "delete_status": 500}'
    run_job
    expect_log "couldn't take runner 42 off GitHub (HTTP 500: nope); stopping the VM anyway"
    expect_log "paused: stopping the idle VM"
    expect_rc 2
}

t_golden_image_with_a_symlink_or_pipe_is_refused() {
    new_test golden_checks ""
    mkdir -p "$t/shared/tart/vms/kuvo-ci-golden"
    echo config > "$t/shared/tart/vms/kuvo-ci-golden/config.json"
    ln -s "$t/token" "$t/shared/tart/vms/kuvo-ci-golden/disk.img"
    echo v2 > "$t/shared/golden-version"
    (
        . "$ci/orchestrator.sh"
        export PATH="$t/bin:/usr/bin:/bin:/usr/sbin:/sbin" KUVO_TEST_TART="$t/tart"
        SHARED="$t/shared" SHARED_TART="$t/shared/tart" TART_DIR="$t/tart" LOCAL_VERSION="$t/tart/golden-version"
        take_golden
        echo "symlink rc=$?"
        rm "$SHARED/golden-version"
        mkfifo "$SHARED/golden-version"
        run_limited 10 take_golden
        echo "pipe rc=$?"
    ) > "$t/log" 2>&1
    expect_log "isn't a file or a folder (a symlink?): not taking it."
    expect_log "symlink rc=1"
    expect_log "No golden image yet"
    expect_log "pipe rc=1"
    [[ ! -e "$t/tart/vms/kuvo-ci-golden" && ! -e "$t/tart/vms/kuvo-ci-golden-incoming" ]] || fail "the image was taken"
}

# With the real dscl: groups on every Mac (wheel: root only; admin: root and you).
t_softnet_group_check() {
    new_test softnet_group ""
    (
        . "$ci/common.sh"
        SOFTNET_GROUP=wheel CI_USER=root softnet_group_ok && echo "wheel ok"
        SOFTNET_GROUP=admin CI_USER=root softnet_group_ok || echo "admin refused"
        SOFTNET_GROUP=kuvo-ci-no-such-group CI_USER=root softnet_group_ok || echo "missing refused"
    ) > "$t/log" 2>&1
    expect_log "wheel ok"
    expect_log "admin refused"
    expect_log "missing refused"
}

t_tree_check_refuses_a_tree_that_isnt_roots() {
    new_test tree_check ""
    mkdir -p "$t/tree/bin" "$t/tree/scripts"
    (
        . "$ci/common.sh"
        CI_ROOT="$t/tree" CI_BIN="$t/tree/bin" CI_SCRIPTS="$t/tree/scripts"
        verify_tree
        echo "rc=$?"
    ) > "$t/log" 2>&1
    expect_log "$t/tree isn't a folder of root's."
    expect_log "rc=1"
    done_test
}

# The VM's pre-job hook, run here with its marker and its last resort (shutting the VM down)
# pointed at the test's folder.
t_hook() {
    new_test hook ""
    sed -e "s|/private/var/tmp/kuvo-ci-job-started|$t/marker|" -e "s|/usr/bin/sudo -n /sbin/shutdown -h now|echo SHUTDOWN|" \
        "$ci/vm/job-started.sh" > "$t/hook.sh"
    grep -q 'sudo' "$t/hook.sh" && { fail "the hook's shutdown wasn't replaced"; return; }
    echo '{"repository": {"full_name": "serhatandic/kuvo-code"}, "ref": "refs/heads/main"}' > "$t/push.json"
    echo '{"repository": {"full_name": "serhatandic/kuvo-code"}, "pull_request": {"number": 1}}' > "$t/pr.json"
    hook() { env -i GITHUB_REPOSITORY=serhatandic/kuvo-code GITHUB_EVENT_PATH="$t/push.json" GITHUB_RUN_ID=555 "$@" /bin/bash "$t/hook.sh" >> "$t/log" 2>&1; }
    hook GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/main || fail "refused a push to main"
    [[ "$(cat "$t/marker" 2>/dev/null)" == 555 ]] || fail "no marker after a push to main"
    rm -f "$t/marker"
    hook GITHUB_EVENT_NAME=push GITHUB_REF=refs/tags/v1.2.3 || fail "refused a release tag"
    [[ -f "$t/marker" ]] || fail "no marker after a release tag"
    rm -f "$t/marker"
    ! hook GITHUB_EVENT_NAME=push GITHUB_REF=refs/tags/vfoo || fail "took a tag that isn't a release's"
    ! hook GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/feature || fail "took another branch"
    ! hook GITHUB_EVENT_NAME=pull_request GITHUB_REF=refs/heads/main || fail "took a pull request"
    ! hook GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/main GITHUB_EVENT_PATH="$t/pr.json" || fail "took a pull request's payload"
    [[ ! -e "$t/marker" ]] || fail "left a marker for a refused job"
    expect_log "SHUTDOWN"
    done_test
}

tests=(t_allowed_job_runs t_fork_job_stopped t_host_takes_only_main_and_release_tags
    t_github_cant_tell_stops_the_vm t_github_silent_stops_the_vm t_job_not_listed_stops_the_vm
    t_missing_marker_stops_the_vm t_marker_of_another_run_stops_the_vm t_job_found_from_github_alone
    t_guest_cant_forge_host_lines t_hard_cap_from_boot t_failed_stop_kills_the_vm t_boot_that_hangs
    t_pause_retires_an_idle_vm t_retiring_a_busy_runner_checks_its_job t_refused_runner_config_logs_no_body
    t_public_address_moving_stops_the_vm t_no_vm_without_space_or_address t_token_expiry_warns
    t_bad_token_never_reaches_curl t_status_never_follows_a_symlink t_watchdog
    t_tree_check_refuses_a_tree_that_isnt_roots t_hook t_github_silent_about_the_runner_stops_the_vm
    t_address_that_cant_be_checked_stops_the_vm t_failed_retire_is_logged
    t_golden_image_with_a_symlink_or_pipe_is_refused t_softnet_group_check
    t_one_lookup_service_down_doesnt_stop_a_job t_acl_check t_check_isolation_refuses_a_softnet_that_isnt_setuid)
if [[ $# -gt 0 ]]; then tests=("$@"); fi
for name in "${tests[@]}"; do
    "$name"
    done_test
    if [[ -n "$failed_here" ]]; then
        failed=$((failed + 1))
        sed 's/^/    | /' "$t/log"
    else
        passed=$((passed + 1))
    fi
done
echo
echo "$passed passed, $failed failed."
((failed == 0))

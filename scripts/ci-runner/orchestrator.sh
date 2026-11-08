#!/bin/bash
# shellcheck disable=SC2016 # what's in single quotes expands in the VM, not here
# The Mac mini's CI orchestrator. Runs as ci, always (setup.sh installs it as a LaunchDaemon, so
# no one has to log in as ci), one job at a time, each in a VM of its own:
#
#   1. clones the golden image (an APFS clone: instant, and nothing of it is shared after);
#   2. boots it with softnet's network (common.sh: the internet, nothing on this Mac or the LAN),
#      no folder shared, no clipboard, audio or USB;
#   3. asks GitHub for a just-in-time runner config: one runner, one job, gone after it. The
#      GitHub token stays here; the VM only gets that config;
#   4. runs the runner in the VM. When it takes a job, checks on GitHub that the job is ours (a
#      push to main, a release tag, a run started by hand from main or a tag, of this repository)
#      and stops the VM if not. The VM's own pre-job hook (vm/job-started.sh) refuses it too,
#      before any step;
#   5. stops and deletes the VM when the job ends (or after JOB_LIMIT_MINUTES), and starts over.
#
# The next VM boots as soon as one is deleted, so it's ready for the next job. When something
# fails before a job ran (no boot, GitHub refusing, a runner that quits at once), it waits longer
# each time, up to an hour, so it never hammers GitHub.
#   /Users/Shared/kuvo-ci/paused   while it's there, no VM runs (an idle one is stopped)
# Its log: ~/Library/Logs/kuvo-ci/orchestrator.log (and a log per VM next to it, kept a week).
set -uo pipefail
umask 077

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/ci-runner/common.sh
. "$here/common.sh"

TOKEN_FILE="$HOME/.config/kuvo-ci/github-token"
TART_DIR="${TART_HOME:-$HOME/.tart}"
LOCAL_VERSION="$TART_DIR/$GOLDEN-version"
LOG_DIR="$HOME/Library/Logs/kuvo-ci"
PAUSED="$SHARED/paused"
# gh keeps nothing of its own outside this.
export GH_CONFIG_DIR="$HOME/.config/kuvo-ci/gh"
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p "$LOG_DIR" "$GH_CONFIG_DIR" "$TART_DIR"
# The VMs' disks (a release's signing keychain among them) are ci's alone.
chmod 700 "$TART_DIR"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

# One orchestrator at a time: a second would take the first's VM for one left from a crash.
LOCK="$TART_DIR/orchestrator.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
    other="$(cat "$LOCK/pid" 2>/dev/null)"
    if [[ "$other" =~ ^[0-9]+$ ]] && ps -o command= -p "$other" 2>/dev/null | grep -q 'orchestrator\.sh'; then
        log "Another orchestrator is running (PID $other): leaving it be."
        exit 0
    fi
    log "Taking over the lock of an orchestrator that's gone (PID ${other:-unknown})."
fi
echo $$ > "$LOCK/pid"
# A sleep that a stop (launchd's TERM) cuts short: bash runs a trap only between commands.
nap() {
    sleep "$1" &
    wait $!
}
api() { GH_TOKEN="$(cat "$TOKEN_FILE")" gh api -H 'X-GitHub-Api-Version: 2022-11-28' "$@"; }

# Apple's Virtualization framework wants an unlocked login keychain (macOS 15 and later). In a
# login session there's one; as a daemon, ci gets one of its own with an empty password, holding
# nothing but what the framework keeps there (Tart's FAQ, "headless machines").
prepare_keychain() {
    [[ "$(launchctl managername 2>/dev/null)" != Aqua ]] || return 0
    local keychain="$HOME/Library/Keychains/kuvo-ci-vms.keychain-db"
    mkdir -p "$HOME/Library/Keychains"
    { [[ -f "$keychain" ]] || security create-keychain -p '' "$keychain"; } \
        && security set-keychain-settings "$keychain" \
        && security unlock-keychain -p '' "$keychain" \
        && security list-keychains -d user -s "$keychain" \
        && security default-keychain -d user -s "$keychain" \
        && security login-keychain -d user -s "$keychain"
}

vm="" vm_pid="" exec_pid="" runner_id="" check_pid="" job_done="" job_taken=""

end_job() {
    if [[ -n "$check_pid" ]]; then kill "$check_pid" 2>/dev/null; wait "$check_pid" 2>/dev/null; fi
    if [[ -n "$vm" ]]; then tart stop "$vm" --timeout 15 >/dev/null 2>&1 || true; fi
    if [[ -n "$exec_pid" ]] && kill -0 "$exec_pid" 2>/dev/null; then kill "$exec_pid" 2>/dev/null; fi
    if [[ -n "$exec_pid" ]]; then wait "$exec_pid" 2>/dev/null; fi
    if [[ -n "$vm_pid" ]] && kill -0 "$vm_pid" 2>/dev/null; then kill "$vm_pid" 2>/dev/null; fi
    if [[ -n "$vm_pid" ]]; then wait "$vm_pid" 2>/dev/null; fi
    if [[ -n "$vm" ]]; then
        if tart delete "$vm" >/dev/null 2>&1; then log "[$vm] deleted"; else log "[$vm] couldn't delete it: trying again before the next VM"; fi
    fi
    # A runner that never finished a job is still registered: take it off GitHub.
    if [[ -n "$runner_id" && -z "$job_done" ]]; then
        api -X DELETE "repos/$REPOSITORY/actions/runners/$runner_id" >/dev/null 2>&1 || true
    fi
    vm="" vm_pid="" exec_pid="" runner_id="" check_pid="" job_done="" job_taken=""
}
trap 'log "Stopping."; end_job; rm -rf "$LOCK"; exit 0' TERM INT HUP

# Job VMs left from before (by their name, in ci's own Tart home): from a crash or a restart, or
# one that couldn't be deleted. Nothing of a job outlives it, so this runs before each VM; it
# fails when one is still there.
clean_vms() {
    local name left=""
    while IFS= read -r name; do
        [[ "$name" == kuvo-ci-job-* ]] || continue
        log "Deleting a VM left from before: $name"
        tart stop "$name" --timeout 5 >/dev/null 2>&1 || true
        tart delete "$name" >/dev/null 2>&1 || { log "Couldn't delete $name."; left=1; }
    done < <(tart list --source local --quiet 2>/dev/null)
    [[ -z "$left" ]]
}

# At the start: runners of ours GitHub still lists as offline, logs older than a week.
clean_leftovers() {
    local id
    while IFS= read -r id; do
        [[ "$id" =~ ^[0-9]+$ ]] || continue
        log "Taking an offline runner left from before off GitHub: $id"
        api -X DELETE "repos/$REPOSITORY/actions/runners/$id" >/dev/null 2>&1 || true
    done < <(api "repos/$REPOSITORY/actions/runners?per_page=100" \
        --jq ".runners[] | select((.name | startswith(\"kuvo-ci-job-\")) and .status == \"offline\") | .id" 2>/dev/null)
    find "$LOG_DIR" -name 'kuvo-ci-job-*.log' -mtime +7 -delete 2>/dev/null || true
}

# The golden image build-image.sh made, copied (as an APFS clone) when it's new.
take_golden() {
    local want have
    want="$(cat "$SHARED/golden-version" 2>/dev/null)"
    have="$(cat "$LOCAL_VERSION" 2>/dev/null)"
    [[ -n "$want" ]] || { log "No golden image yet: run scripts/ci-runner/build-image.sh."; return 1; }
    if [[ "$want" == "$have" ]] && tart get "$GOLDEN" >/dev/null 2>&1; then return 0; fi
    log "Taking the golden image: $want"
    rm -rf "$TART_DIR/vms/$GOLDEN-incoming"
    mkdir -p "$TART_DIR/vms"
    cp -cR "$SHARED_TART/vms/$GOLDEN" "$TART_DIR/vms/$GOLDEN-incoming" || return 1
    rm -rf "$TART_DIR/vms/$GOLDEN"
    mv "$TART_DIR/vms/$GOLDEN-incoming" "$TART_DIR/vms/$GOLDEN"
    printf '%s\n' "$want" > "$LOCAL_VERSION"
}

# GitHub stops giving jobs to runners that are too far behind: a month-old image is due. Said
# once a day.
age_warned=0
warn_old_golden() {
    ((SECONDS - age_warned > 86400 || age_warned == 0)) || return 0
    if [[ -n "$(find "$SHARED/golden-version" -mtime +21 2>/dev/null)" ]]; then
        log "The golden image is over three weeks old: run scripts/ci-runner/build-image.sh (a newer runner, macOS and brew updates)."
        age_warned=$SECONDS
    fi
}

# Whether a run GitHub lists is one the Mini takes. head_branch can't tell a tag from a branch
# named like one; the VM's hook refuses such a branch (it reads refs/tags/ itself).
allowed() { # event branch repository head-repository
    [[ "$3" == "$REPOSITORY" && "$4" == "$REPOSITORY" ]] || return 1
    case "$1" in push | workflow_dispatch) ;; *) return 1 ;; esac
    [[ "$2" == main || "$2" =~ ^v[0-9] ]]
}

# Once the runner has taken a job: which run is it, on GitHub's side? Stops the VM when it isn't
# one the Mini takes. A few tries, as GitHub may take a moment to list it; if it never does, the
# VM's own hook has decided already, before the job's first step.
check_job() { # runner-id vm
    local attempt runs id event branch repo head_repo match
    for attempt in 1 2 3; do
        sleep 5
        runs="$(api "repos/$REPOSITORY/actions/runs?status=in_progress&per_page=100" \
            --jq '.workflow_runs[] | "\(.id) \(.event) \(.head_branch) \(.repository.full_name) \(.head_repository.full_name)"' 2>/dev/null)" || continue
        while read -r id event branch repo head_repo; do
            [[ -n "$id" ]] || continue
            match="$(api "repos/$REPOSITORY/actions/runs/$id/jobs?filter=latest&per_page=100" \
                --jq ".jobs[] | select(.runner_id == $1) | .id" 2>/dev/null)"
            [[ -n "$match" ]] || continue
            if allowed "$event" "$branch" "$repo" "$head_repo"; then
                log "[$2] host check: run $id, $event on $branch, is ours"
            else
                log "[$2] host check: run $id, $event on $branch from $head_repo, isn't one the Mini takes: stopping the VM"
                tart stop "$2" --timeout 0 >/dev/null 2>&1
            fi
            return
        done <<< "$runs"
        log "[$2] host check: GitHub doesn't list runner $1's job yet (try $attempt)"
    done
    log "[$2] host check: couldn't find runner $1's job on GitHub; the VM's pre-job hook decided"
}

# Takes an idle VM's runner off GitHub first: if GitHub has just given it a job, it refuses
# (busy, HTTP 422), and the job goes on. Any other failure (GitHub down, the token expired) stops
# the VM anyway; the runner, offline then, goes at the next start.
retire_idle_runner() {
    local out
    if out="$(api -X DELETE "repos/$REPOSITORY/actions/runners/$runner_id" 2>&1)"; then
        runner_id=""
        return 0
    fi
    [[ "$out" != *"HTTP 422"* ]] || return 1
    log "[$vm] couldn't take runner $runner_id off GitHub (${out:0:200}); stopping the VM anyway"
    runner_id=""
    return 0
}

# One VM, one job. Returns 0 when the runner took a job, 2 when its VM was retired while idle
# (paused, or a new golden image), 1 for anything else (no boot, GitHub refusing, a runner that
# stopped without a job).
one_job() {
    local encoded line job_started="" fifo jit retired="" flags
    flags="$(vm_run_flags 2>&1)" || { log "No VM: $flags"; return 1; }
    vm="kuvo-ci-job-$(date -u +%Y%m%d-%H%M%S)-$RANDOM"
    tart clone "$GOLDEN" "$vm" || { log "[$vm] couldn't clone $GOLDEN"; vm=""; return 1; }
    # Paused meanwhile (pause_ci looks for a VM a moment after making the file): no VM.
    [[ ! -e "$PAUSED" ]] || return 2
    # shellcheck disable=SC2086 # the flags are words of their own
    tart run $flags "$vm" > "$LOG_DIR/$vm.log" 2>&1 &
    vm_pid=$!
    log "[$vm] booting ($VM_CPUS CPUs, $VM_MEMORY_MB MB)"
    local tries=0
    until tart exec "$vm" /usr/bin/true >/dev/null 2>&1; do
        tries=$((tries + 1))
        if [[ $tries -gt 90 ]] || ! kill -0 "$vm_pid" 2>/dev/null; then
            log "[$vm] didn't boot (see $LOG_DIR/$vm.log)"
            return 1
        fi
        sleep 2
    done
    [[ ! -e "$PAUSED" ]] || return 2

    local label_args=() label
    for label in "${RUNNER_LABELS[@]}"; do label_args+=(-f "labels[]=$label"); done
    jit="$(api -X POST "repos/$REPOSITORY/actions/runners/generate-jitconfig" \
        -f name="$vm" -F runner_group_id=1 "${label_args[@]}" -f work_folder=_work \
        --jq '"\(.runner.id) \(.encoded_jit_config)"' 2>&1)" \
        || { log "[$vm] GitHub refused a runner config: ${jit:0:200}"; return 1; }
    runner_id="${jit%% *}"
    encoded="${jit#* }"
    jit=""
    log "[$vm] runner $runner_id ready for a job"

    fifo="$(mktemp -u "${TMPDIR:-/tmp}/kuvo-ci.XXXXXX")"
    mkfifo -m 600 "$fifo" || { log "[$vm] couldn't make a pipe"; return 1; }
    printf '%s\n' "$encoded" | tart exec -i "$vm" /bin/bash -lc \
        'IFS= read -r jit; cd ~/actions-runner && exec ./run.sh --jitconfig "$jit"' > "$fifo" 2>&1 &
    exec_pid=$!
    encoded=""
    # Opening the pipe waits for the runner's side, and a child ending meanwhile (printf, at
    # once) interrupts it: open it again until it's open.
    local opened="" attempt
    for attempt in 1 2 3 4 5 6 7 8 9 10; do
        if { exec 3< "$fifo"; } 2>/dev/null; then opened=1; break; fi
        kill -0 "$exec_pid" 2>/dev/null || break
    done
    rm -f "$fifo"
    [[ -n "$opened" ]] || { log "[$vm] couldn't read the runner's output"; return 1; }
    while :; do
        line=""
        if IFS= read -r -t 30 line <&3; then
            log "[$vm] $line"
            case "$line" in
                *"Running job:"*)
                    job_taken=1
                    job_started=$SECONDS
                    check_job "$runner_id" "$vm" &
                    check_pid=$!
                    ;;
                *"completed with result"*) job_done=1 ;;
            esac
            continue
        fi
        # No line: the end of the runner's output, 30 seconds without one (macOS's bash 3.2 says
        # 1 for both), or a read cut short by a child ending (the host check, say). Whether the
        # runner's side is still there tells which.
        [[ -z "$line" ]] || log "[$vm] $line"
        kill -0 "$exec_pid" 2>/dev/null || break # the runner is done (or the VM is gone)
        kill -0 "$vm_pid" 2>/dev/null || break
        sleep 0.2
        if [[ -n "$job_started" ]]; then
            if ((SECONDS - job_started > JOB_LIMIT_MINUTES * 60)); then
                log "[$vm] the job ran over $JOB_LIMIT_MINUTES minutes: stopping it"
                break
            fi
        elif [[ -e "$PAUSED" ]] && retire_idle_runner; then
            log "[$vm] paused: stopping the idle VM"
            retired=1
            break
        elif [[ "$(cat "$SHARED/golden-version" 2>/dev/null)" != "$(cat "$LOCAL_VERSION" 2>/dev/null)" ]] && retire_idle_runner; then
            log "[$vm] a new golden image: replacing the idle VM"
            retired=1
            break
        fi
    done
    exec 3<&-
    [[ -z "$retired" ]] || return 2
    [[ -n "$job_taken" ]] || { log "[$vm] the runner stopped without taking a job (see $LOG_DIR/$vm.log)"; return 1; }
    return 0
}

prepare_keychain || log "Couldn't prepare a keychain for the VMs; they may not start."
log "Starting: $REPOSITORY, labels ${RUNNER_LABELS[*]}, Tart $(tart --version), flags: $(vm_run_flags 2>&1)"
clean_leftovers
backoff=60
while :; do
    if [[ -e "$PAUSED" ]]; then nap 60; continue; fi
    if [[ ! -s "$TOKEN_FILE" ]]; then
        log "No GitHub token in $TOKEN_FILE: run scripts/ci-runner/setup.sh."
        nap 300
        continue
    fi
    if ! clean_vms; then nap 300; continue; fi
    if ! take_golden; then nap 300; continue; fi
    warn_old_golden
    one_job
    result=$?
    end_job
    case "$result" in
        0 | 2) backoff=60 ;;
        *)
            log "Waiting $((backoff / 60)) min before the next VM."
            nap "$backoff"
            backoff=$((backoff * 2 > 3600 ? 3600 : backoff * 2))
            ;;
    esac
done

#!/bin/bash
# shellcheck disable=SC2016 # what's in single quotes expands in the VM, not here
# The Mac mini's CI orchestrator. Runs as ci, always (setup.sh installs it as a LaunchDaemon, so
# no one has to log in as ci), from /usr/local/kuvo-ci (root's: nothing running as you can change
# what ci runs), one job at a time, each in a VM of its own:
#
#   1. clones the golden image (an APFS clone: instant, and nothing of it is shared after);
#   2. boots it with softnet's network (common.sh: the internet, nothing on this Mac or the LAN),
#      no folder shared, no clipboard, audio or USB;
#   3. asks GitHub for a just-in-time runner config: one runner, one job, gone after it. The
#      GitHub token stays here; the VM only gets that config;
#   4. runs the runner in the VM, and asks GitHub about once a minute whether its runner is busy.
#      Once it is, it must find on GitHub, within CONFIRM_SECONDS, that the job is ours (a push to
#      main, a release tag, a run started by hand from main or a tag, of this repository), and
#      then that the VM's pre-job hook ran (vm/job-started.sh, which refuses the rest itself,
#      before any step). Anything else, a GitHub that can't tell included, stops the VM;
#   5. stops and deletes the VM when the job ends, after JOB_LIMIT_MINUTES of a job, or
#      VM_LIMIT_MINUTES from boot whatever GitHub says, and starts over. An idle VM is replaced
#      every IDLE_LIMIT_MINUTES.
#
# The next VM boots as soon as one is deleted, so it's ready for the next job. When something
# fails before a job ran (no boot, GitHub refusing, a runner that quits at once), it waits longer
# each time, up to an hour, so it never hammers GitHub; at the hour it says so loudly.
#   /Users/Shared/kuvo-ci/paused      while it's there, no VM runs (an idle one is stopped)
#   /Users/Shared/kuvo-ci/run/status  what it's doing, for anyone to read
# Its log: ~/Library/Logs/kuvo-ci/orchestrator.log (one older one kept as .1; a log per VM next
# to it, kept a week).
set -uo pipefail
umask 077
export LC_ALL=C
export PATH="/usr/local/kuvo-ci/bin:/usr/bin:/bin:/usr/sbin:/sbin"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci-runner/common.sh
. "$here/common.sh"
export PATH="$CI_PATH"

TOKEN_FILE="$HOME/.config/kuvo-ci/github-token"
TART_DIR="${TART_HOME:-$HOME/.tart}"
LOCAL_VERSION="$TART_DIR/$GOLDEN-version"
LOG_DIR="$HOME/Library/Logs/kuvo-ci"
LOG_FILE="$LOG_DIR/orchestrator.log"
LOG_MAX_BYTES=$((10 * 1024 * 1024))
STATE_DIR="$HOME/.config/kuvo-ci/state"
PAUSED="$SHARED/paused"

API_BASE="https://api.github.com"
API_PROTO="=https"
API_SECONDS=30
# How long GitHub has, once the runner is busy, to show the job is ours; then how long the VM's
# hook has to show it ran.
CONFIRM_SECONDS=90
MARKER_SECONDS=60
BUSY_EVERY=60
IP_EVERY=300
BOOT_SECONDS=180
IDLE_LIMIT_MINUTES=60
VM_LIMIT_MINUTES=$((IDLE_LIMIT_MINUTES + JOB_LIMIT_MINUTES + 10))
# A VM's disk grows as its job writes: no VM below this much free space.
MIN_FREE_GB=60
BACKOFF_MAX=3600
# How long a read of the runner's output waits: the checks below run at least this often.
READ_SECONDS=5

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

# What the orchestrator is doing, for anyone to read (setup.sh makes $SHARED_RUN ci's). Written
# only into a folder of ci's own, never through a symlink.
status() { # state message
    local dir="$SHARED_RUN"
    [[ -d "$dir" && ! -L "$dir" && -O "$dir" ]] || return 0
    {
        printf 'state: %s\n' "$1"
        printf 'since: %s\n' "$(date -u +%FT%TZ)"
        printf 'message: %s\n' "$2"
        [[ ! -s "$STATE_DIR/token-expiration" ]] || printf 'token expires: %s\n' "$(cat "$STATE_DIR/token-expiration")"
        [[ -z "${vm:-}" ]] || printf 'vm: %s\n' "$vm"
    } > "$dir/status.new" 2>/dev/null && chmod 644 "$dir/status.new" && mv -f "$dir/status.new" "$dir/status"
}

# A sleep that a stop (launchd's TERM) cuts short: bash runs a trap only between commands.
nap() {
    sleep "$1" &
    wait $!
}

# GitHub's REST API, with /usr/bin/curl. The token goes to curl on its stdin (--config -), never
# in its arguments. Prints the HTTP status (000: no answer) on the first line, then the body.
# Notes the token's expiry, from GitHub's header, in $STATE_DIR.
api() { # method path [file with a JSON body]
    local method="$1" path="$2" data="${3:-}" token tmp code expiry
    token="$(cat "$TOKEN_FILE" 2>/dev/null)"
    if [[ ! "$token" =~ ^[A-Za-z0-9_]+$ ]]; then
        printf 'token\n'
        return 1
    fi
    tmp="$(mktemp -d "${TMPDIR:-/tmp}/kuvo-ci-api.XXXXXX")" || { printf '000\n'; return 1; }
    local args=(-sS --proto "$API_PROTO" --max-time "$API_SECONDS" -X "$method"
        -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28'
        -D "$tmp/headers" -o "$tmp/body" -w '%{http_code}' --config -)
    [[ -z "$data" ]] || args+=(-H 'Content-Type: application/json' --data-binary "@$data")
    code="$(printf 'header = "Authorization: Bearer %s"\n' "$token" | curl "${args[@]}" "$API_BASE/$path" 2>/dev/null)"
    token=""
    [[ "$code" =~ ^[0-9]{3}$ ]] || code=000
    expiry="$(awk 'tolower($1) == "github-authentication-token-expiration:" { $1 = ""; sub(/^ /, ""); sub(/\r$/, ""); print }' "$tmp/headers" 2>/dev/null)"
    if [[ "$expiry" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9:]{8}\ [A-Z]+$ ]]; then
        mkdir -p "$STATE_DIR" && printf '%s\n' "$expiry" > "$STATE_DIR/token-expiration"
    fi
    printf '%s\n' "$code"
    cat "$tmp/body" 2>/dev/null
    rm -rf "$tmp"
    [[ "$code" == 2* ]]
}
# The two halves of api's output.
http_code() { printf '%s\n' "${1%%$'\n'*}"; }
http_body() { [[ "$1" == *$'\n'* ]] && printf '%s\n' "${1#*$'\n'}"; }
# GitHub's own words when it refuses, short, for the log (never a body that holds a secret).
api_error() { # api's output
    local message
    message="$(http_body "$1" | jq -r '.message? // empty' 2>/dev/null | tr -cd '[:print:]')"
    printf 'HTTP %s%s' "$(http_code "$1")" "${message:+: ${message:0:200}}"
}

# Said once a day, from the 14th day before the token expires (GitHub sends the date with every
# answer).
token_warned=-86400
warn_token_expiry() {
    local expiry when days
    ((SECONDS - token_warned >= 86400)) || return 0
    expiry="$(cat "$STATE_DIR/token-expiration" 2>/dev/null)" || return 0
    when="$(date -j -u -f '%Y-%m-%d %H:%M:%S %Z' "$expiry" +%s 2>/dev/null)" || return 0
    days=$(((when - $(date -u +%s)) / 86400))
    ((days <= 14)) || return 0
    log "!!! The GitHub token expires in $days days ($expiry): make a new one and run setup.sh again."
    token_warned=$SECONDS
}

# The orchestrator's own log, rotated when it gets big (launchd opened it; this reopens it).
rotate_log() {
    local size
    [[ -f "$LOG_FILE" ]] || return 0
    size="$(stat -f %z "$LOG_FILE" 2>/dev/null)" || return 0
    ((size > LOG_MAX_BYTES)) || return 0
    mv -f "$LOG_FILE" "$LOG_FILE.1"
    exec >> "$LOG_FILE" 2>&1
    log "Rotated the log (the one before is $LOG_FILE.1)."
}

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

vm="" vm_pid="" exec_pid="" runner_id="" check_pid="" work=""

# Stops the VM: Tart first, and if that fails or hangs, its process.
stop_vm() {
    [[ -n "$vm" ]] || return 0
    run_limited 30 tart stop "$vm" --timeout 10 >/dev/null 2>&1
    if [[ -n "$vm_pid" ]] && kill -0 "$vm_pid" 2>/dev/null; then
        kill -TERM "$vm_pid" 2>/dev/null
        local _
        for _ in 1 2 3 4 5 6 7 8 9 10; do
            kill -0 "$vm_pid" 2>/dev/null || return 0
            nap 1
        done
        kill -KILL "$vm_pid" 2>/dev/null
    fi
}

end_job() {
    if [[ -n "$check_pid" ]]; then kill "$check_pid" 2>/dev/null; wait "$check_pid" 2>/dev/null; fi
    stop_vm
    if [[ -n "$exec_pid" ]] && kill -0 "$exec_pid" 2>/dev/null; then kill "$exec_pid" 2>/dev/null; fi
    if [[ -n "$exec_pid" ]]; then wait "$exec_pid" 2>/dev/null; fi
    if [[ -n "$vm_pid" ]]; then wait "$vm_pid" 2>/dev/null; fi
    if [[ -n "$vm" ]]; then
        if run_limited 120 tart delete "$vm" >/dev/null 2>&1; then log "[$vm] deleted"; else log "[$vm] couldn't delete it: trying again before the next VM"; fi
    fi
    # A just-in-time runner goes by itself after its job; one that never ran one is still
    # registered. Taking it off is harmless either way (GitHub says 404 for one that's gone).
    if [[ -n "$runner_id" ]]; then api DELETE "repos/$REPOSITORY/actions/runners/$runner_id" >/dev/null 2>&1; fi
    if [[ -n "$work" ]]; then rm -rf "$work"; fi
    vm="" vm_pid="" exec_pid="" runner_id="" check_pid="" work=""
}

# Job VMs left from before (by their name, in ci's own Tart home): from a crash or a restart, or
# one that couldn't be deleted. Nothing of a job outlives it, so this runs at the start and
# before each VM; it fails when one is still there.
clean_vms() {
    local name left="" names
    names="$(run_limited 60 tart list --source local --quiet 2>/dev/null)"
    while IFS= read -r name; do
        [[ "$name" == kuvo-ci-job-* ]] || continue
        log "Deleting a VM left from before: $name"
        run_limited 30 tart stop "$name" --timeout 5 >/dev/null 2>&1
        run_limited 120 tart delete "$name" >/dev/null 2>&1 || { log "Couldn't delete $name."; left=1; }
    done <<< "$names"
    [[ -z "$left" ]]
}

# At the start: runners of ours GitHub still lists as offline, logs older than a week.
clean_leftovers() {
    local id out ids
    if out="$(api GET "repos/$REPOSITORY/actions/runners?per_page=100")"; then
        ids="$(http_body "$out" | jq -r '.runners[]? | select((.name | startswith("kuvo-ci-job-")) and .status == "offline") | .id' 2>/dev/null)"
        while IFS= read -r id; do
            [[ "$id" =~ ^[0-9]+$ ]] || continue
            log "Taking an offline runner left from before off GitHub: $id"
            api DELETE "repos/$REPOSITORY/actions/runners/$id" >/dev/null 2>&1
        done <<< "$ids"
    fi
    find "$LOG_DIR" -name 'kuvo-ci-job-*.log' -mtime +7 -delete 2>/dev/null || true
}

# The golden image build-image.sh made, copied (as an APFS clone) when it's new.
take_golden() {
    local want have
    want="$(cat "$SHARED/golden-version" 2>/dev/null)"
    have="$(cat "$LOCAL_VERSION" 2>/dev/null)"
    [[ -n "$want" ]] || { log "No golden image yet: run scripts/ci-runner/build-image.sh."; return 1; }
    if [[ "$want" == "$have" ]] && run_limited 60 tart get "$GOLDEN" >/dev/null 2>&1; then return 0; fi
    log "Taking the golden image: $want"
    rm -rf "$TART_DIR/vms/$GOLDEN-incoming"
    mkdir -p "$TART_DIR/vms"
    if ! run_limited 900 cp -cR "$SHARED_TART/vms/$GOLDEN" "$TART_DIR/vms/$GOLDEN-incoming"; then
        rm -rf "$TART_DIR/vms/$GOLDEN-incoming"
        log "Couldn't copy the golden image."
        return 1
    fi
    rm -rf "$TART_DIR/vms/$GOLDEN"
    mv "$TART_DIR/vms/$GOLDEN-incoming" "$TART_DIR/vms/$GOLDEN"
    printf '%s\n' "$want" > "$LOCAL_VERSION"
}

# GitHub stops giving jobs to runners that are too far behind: a month-old image is due. Said
# once a day.
age_warned=-86400
warn_old_golden() {
    ((SECONDS - age_warned >= 86400)) || return 0
    if [[ -n "$(find "$SHARED/golden-version" -mtime +21 2>/dev/null)" ]]; then
        log "The golden image is over three weeks old: run scripts/ci-runner/build-image.sh (a newer runner, macOS and brew updates)."
        age_warned=$SECONDS
    fi
}

# Free space where the VMs' disks are, in GB.
free_gb() { df -g "$TART_DIR" 2>/dev/null | awk 'NR == 2 { print $4 }'; }

# Whether a run GitHub lists is one the Mini takes: main and v[0-9]* tags (common.sh). head_branch
# can't tell a tag from a branch named like one; the VM's hook reads GITHUB_REF itself.
allowed() { # event branch repository head-repository
    [[ "$3" == "$REPOSITORY" && "$4" == "$REPOSITORY" ]] || return 1
    case "$1" in push | workflow_dispatch) ;; *) return 1 ;; esac
    [[ "$2" == main || "$2" =~ ^v[0-9] ]]
}

# The runner's state on GitHub: busy, idle, gone (404: a just-in-time runner is removed after
# its job) or unknown (GitHub didn't answer).
runner_state() { # runner-id
    local out
    out="$(api GET "repos/$REPOSITORY/actions/runners/$1")"
    case "$(http_code "$out")" in
        200)
            case "$(http_body "$out" | jq -r '.busy' 2>/dev/null)" in
                true) echo busy ;;
                false) echo idle ;;
                *) echo unknown ;;
            esac
            ;;
        404) echo gone ;;
        *) echo unknown ;;
    esac
}

# Once the runner has a job: which run is it, on GitHub's side? Writes its verdict to $3 (one
# line: "ok <run-id> <what>", "refused <what>", or "unknown"), trying for $4 seconds, as GitHub
# may take a moment to list it. Runs in the background.
check_job() { # runner-id vm verdict-file seconds
    local deadline=$((SECONDS + $4)) out runs id event branch repo head_repo match verdict="unknown"
    while ((SECONDS < deadline)); do
        if out="$(api GET "repos/$REPOSITORY/actions/runs?status=in_progress&per_page=100")"; then
            runs="$(http_body "$out" | jq -r '.workflow_runs[]? | "\(.id) \(.event) \(.head_branch) \(.repository.full_name) \(.head_repository.full_name)"' 2>/dev/null)"
            while read -r id event branch repo head_repo; do
                [[ "$id" =~ ^[0-9]+$ ]] || continue
                out="$(api GET "repos/$REPOSITORY/actions/runs/$id/jobs?filter=latest&per_page=100")" || continue
                match="$(http_body "$out" | jq -r --argjson runner "$1" '.jobs[]? | select(.runner_id == $runner) | .id' 2>/dev/null)"
                [[ -n "$match" ]] || continue
                if allowed "$event" "$branch" "$repo" "$head_repo"; then
                    verdict="ok $id run $id, $event on $branch"
                else
                    verdict="refused run $id, $event on $branch from $head_repo"
                fi
                break 2
            done <<< "$runs"
        fi
        ((SECONDS + 10 < deadline)) || break
        nap 10
    done
    printf '%s\n' "$verdict" > "$3.new" && mv -f "$3.new" "$3"
}

# Whether the VM's pre-job hook left its marker for this run.
hook_ran() { # run-id
    local said
    said="$(run_limited 15 tart exec "$vm" /bin/cat "$HOOK_MARKER" 2>/dev/null)" || return 1
    [[ "${said//[[:space:]]/}" == "$1" ]]
}

# Takes an idle VM's runner off GitHub first. Prints what happened: "retired" (gone, or GitHub
# failed some other way: the VM stops anyway, and the runner, offline then, goes at the next
# start), or "busy" (HTTP 422: GitHub has just given it a job, which goes on).
retire_idle_runner() {
    local out
    out="$(api DELETE "repos/$REPOSITORY/actions/runners/$runner_id")"
    case "$(http_code "$out")" in
        2* | 404) runner_id="" ;;
        422) echo busy; return ;;
        *)
            log "[$vm] couldn't take runner $runner_id off GitHub ($(api_error "$out")); stopping the VM anyway"
            runner_id=""
            ;;
    esac
    echo retired
}

# A line from the VM, as data: printable characters only, short, and marked as the guest's, so
# it can't pass for one of the host's own lines.
guest_line() {
    local clean="${1//[^[:print:]]/?}"
    log "[$vm] guest| ${clean:0:400}"
}

# One VM, one job. Returns 0 when the runner took a job, 2 when its VM was retired while idle
# (paused, a new golden image, or idle too long), 1 for anything else (no boot, GitHub refusing,
# a runner that stopped without a job).
one_job() {
    local encoded line fifo flags ip out free problem
    problem="$(verify_tree 2>&1)" || { log "!!! Not starting a VM: $problem Run setup.sh again."; return 1; }
    free="$(free_gb)"
    if [[ ! "$free" =~ ^[0-9]+$ ]] || ((free < MIN_FREE_GB)); then
        log "!!! Not starting a VM: ${free:-?} GB free in $TART_DIR, under $MIN_FREE_GB GB."
        return 1
    fi
    ip="$(public_ipv4)" || { log "No VM: couldn't find this network's public address to block it (two lookups over HTTPS must agree)."; return 1; }
    flags="$(vm_run_flags "$ip")" || return 1
    work="$(mktemp -d "${TMPDIR:-/tmp}/kuvo-ci-job.XXXXXX")" || { log "Couldn't make a folder for the job."; return 1; }
    vm="kuvo-ci-job-$(date -u +%Y%m%d-%H%M%S)-$RANDOM"
    run_limited 300 tart clone "$GOLDEN" "$vm" || { log "[$vm] couldn't clone $GOLDEN"; vm=""; return 1; }
    # Paused meanwhile (pause_ci looks for a VM a moment after making the file): no VM.
    [[ ! -e "$PAUSED" ]] || return 2
    # shellcheck disable=SC2086 # the flags are words of their own
    tart run $flags "$vm" > "$LOG_DIR/$vm.log" 2>&1 &
    vm_pid=$!
    local booted_at=$SECONDS
    log "[$vm] booting ($VM_CPUS CPUs, $VM_MEMORY_MB MB, blocking $ip)"
    until run_limited 10 tart exec "$vm" /usr/bin/true >/dev/null 2>&1; do
        if ((SECONDS - booted_at > BOOT_SECONDS)) || ! kill -0 "$vm_pid" 2>/dev/null; then
            log "[$vm] didn't boot (see $LOG_DIR/$vm.log)"
            return 1
        fi
        nap 2
    done
    [[ ! -e "$PAUSED" ]] || return 2

    jq -n --arg name "$vm" --args '{name: $name, runner_group_id: 1, labels: $ARGS.positional, work_folder: "_work"}' \
        "${RUNNER_LABELS[@]}" > "$work/jit-request.json" || return 1
    if ! out="$(api POST "repos/$REPOSITORY/actions/runners/generate-jitconfig" "$work/jit-request.json")"; then
        log "[$vm] GitHub refused a runner config: $(api_error "$out")"
        return 1
    fi
    runner_id="$(http_body "$out" | jq -r '.runner.id' 2>/dev/null)"
    encoded="$(http_body "$out" | jq -r '.encoded_jit_config' 2>/dev/null)"
    out=""
    if [[ ! "$runner_id" =~ ^[0-9]+$ || ! "$encoded" =~ ^[A-Za-z0-9+/=]+$ ]]; then
        log "[$vm] GitHub's runner config didn't read as one"
        runner_id="${runner_id//[^0-9]/}"
        return 1
    fi
    log "[$vm] runner $runner_id ready for a job"
    status idle "runner $runner_id waiting for a job"

    fifo="$work/runner-output"
    mkfifo -m 600 "$fifo" || { log "[$vm] couldn't make a pipe"; return 1; }
    printf '%s\n' "$encoded" | tart exec -i "$vm" /bin/bash -lc \
        'IFS= read -r jit; cd ~/actions-runner && exec ./run.sh --jitconfig "$jit"' > "$fifo" 2>&1 &
    exec_pid=$!
    encoded=""
    # Opening the pipe waits for the runner's side, and a child ending meanwhile (printf, at
    # once) interrupts it: open it again until it's open.
    local opened=""
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        if { exec 3< "$fifo"; } 2>/dev/null; then opened=1; break; fi
        kill -0 "$exec_pid" 2>/dev/null || break
    done
    [[ -n "$opened" ]] || { log "[$vm] couldn't read the runner's output"; return 1; }

    # What's known of the job. job_started: since when GitHub (or the runner's own output, which
    # only makes the checks start sooner) says there's one. A job is let run only once GitHub
    # says it's ours (confirmed) and the VM's hook left its marker (hook_ok).
    local job_started="" hinted="" verdict="" run_id="" confirm_by="" marker_by="" next_marker=0
    local hook_ok="" stop="" retired="" last_busy=$SECONDS last_ip=$SECONDS state now
    local verdict_file="$work/verdict"
    while :; do
        line=""
        if IFS= read -r -t "$READ_SECONDS" line <&3; then
            guest_line "$line"
            # The runner says so as it takes a job: a hint to ask GitHub now, never a verdict.
            [[ "$line" != *"Running job:"* ]] || hinted=1
        else
            # No line: the end of the runner's output, READ_SECONDS without one (macOS's bash 3.2
            # says 1 for both), or a read cut short by a child ending (the host check, say).
            # Whether the runner's side is still there tells which.
            [[ -z "$line" ]] || guest_line "$line"
            kill -0 "$exec_pid" 2>/dev/null || break # the runner is done (or the VM is gone)
            kill -0 "$vm_pid" 2>/dev/null || break
            sleep 0.2
        fi
        now=$SECONDS

        # Hard limits, whatever GitHub or the VM says.
        if ((now - booted_at > VM_LIMIT_MINUTES * 60)); then
            stop="the VM ran $VM_LIMIT_MINUTES minutes from boot"
        elif [[ -n "$job_started" ]] && ((now - job_started > JOB_LIMIT_MINUTES * 60)); then
            stop="the job ran over $JOB_LIMIT_MINUTES minutes"
        fi

        # Whether the runner has a job, from GitHub, about once a minute (at once on a hint).
        if [[ -z "$stop" && -z "$job_started" ]] && { [[ -n "$hinted" ]] || ((now - last_busy >= BUSY_EVERY)); }; then
            last_busy=$now
            state="$(runner_state "$runner_id")"
            case "$state" in
                busy | gone) job_started=$now ;;
                *) [[ -z "$hinted" ]] || job_started=$now ;;
            esac
            [[ -z "$job_started" ]] || log "[$vm] runner $runner_id has a job (GitHub: $state${hinted:+; the runner said so})"
        fi

        # The job must be ours (GitHub) within CONFIRM_SECONDS, then the hook's marker must be
        # there within MARKER_SECONDS. Anything else stops the VM.
        if [[ -z "$stop" && -n "$job_started" && -z "$confirm_by" ]]; then
            confirm_by=$((now + CONFIRM_SECONDS))
            status job "runner $runner_id took a job: checking it's ours"
            check_job "$runner_id" "$vm" "$verdict_file" $((CONFIRM_SECONDS - 5)) &
            check_pid=$!
        fi
        if [[ -z "$stop" && -n "$confirm_by" && -z "$run_id" ]]; then
            verdict="$(cat "$verdict_file" 2>/dev/null)"
            case "$verdict" in
                ok\ *)
                    run_id="${verdict#ok }"
                    run_id="${run_id%% *}"
                    log "[$vm] host check: ${verdict#ok "$run_id" }, is ours"
                    marker_by=$((now + MARKER_SECONDS))
                    ;;
                refused\ *) stop="host check: ${verdict#refused }, isn't one the Mini takes" ;;
                unknown) stop="host check: GitHub didn't show runner $runner_id's job within $CONFIRM_SECONDS seconds" ;;
                *) ((now <= confirm_by)) || stop="host check: no answer from GitHub within $CONFIRM_SECONDS seconds" ;;
            esac
        fi
        if [[ -z "$stop" && -n "$run_id" && -z "$hook_ok" ]] && ((now >= next_marker)); then
            next_marker=$((now + 10))
            if hook_ran "$run_id"; then
                hook_ok=1
                log "[$vm] the VM's pre-job hook ran for run $run_id"
                status job "run $run_id"
            elif ((now > marker_by)); then
                stop="the VM's pre-job hook left no marker for run $run_id within $MARKER_SECONDS seconds"
            fi
        fi

        # An idle VM makes way: paused, a new golden image, or idle long enough.
        if [[ -z "$stop" && -z "$job_started" ]]; then
            local why=""
            if [[ -e "$PAUSED" ]]; then
                why="paused: stopping the idle VM"
            elif [[ "$(cat "$SHARED/golden-version" 2>/dev/null)" != "$(cat "$LOCAL_VERSION" 2>/dev/null)" ]]; then
                why="a new golden image: replacing the idle VM"
            elif ((now - booted_at > IDLE_LIMIT_MINUTES * 60)); then
                why="idle for $IDLE_LIMIT_MINUTES minutes: replacing the VM"
            fi
            if [[ -n "$why" ]]; then
                case "$(retire_idle_runner)" in
                    busy)
                        job_started=$now
                        log "[$vm] runner $runner_id has a job (GitHub: busy)"
                        ;;
                    *)
                        log "[$vm] $why"
                        retired=1
                        break
                        ;;
                esac
            fi
        fi

        # The network's public address, blocked as the VM started, mustn't have moved.
        if [[ -z "$stop" ]] && ((now - last_ip >= IP_EVERY)); then
            last_ip=$now
            local new_ip
            if new_ip="$(public_ipv4)"; then
                [[ "$new_ip" == "$ip" ]] || stop="this network's public address moved from $ip to $new_ip, which the VM may reach"
            else
                log "[$vm] couldn't look up this network's public address (the two lookups failed or disagreed); trying again in $((IP_EVERY / 60)) minutes"
            fi
        fi

        if [[ -n "$stop" ]]; then
            log "[$vm] $stop: stopping the VM"
            break
        fi
    done
    exec 3<&-
    [[ -z "$retired" ]] || return 2
    if [[ -z "$job_started" && -z "$hinted" ]]; then
        log "[$vm] the runner stopped without taking a job (see $LOG_DIR/$vm.log)"
        return 1
    fi
    return 0
}

main() {
    trap 'log "Stopping."; end_job; status stopped "the orchestrator stopped"; rm -rf "$LOCK"; exit 0' TERM INT HUP
    mkdir -p "$LOG_DIR" "$TART_DIR" "$STATE_DIR"
    # The VMs' disks (a release's signing keychain among them) are ci's alone.
    chmod 700 "$TART_DIR"
    rotate_log

    # One orchestrator at a time: a second would take the first's VM for one left from a crash.
    LOCK="$TART_DIR/orchestrator.lock"
    if ! mkdir "$LOCK" 2>/dev/null; then
        local other
        other="$(cat "$LOCK/pid" 2>/dev/null)"
        if [[ "$other" =~ ^[0-9]+$ ]] && ps -o command= -p "$other" 2>/dev/null | grep -q 'orchestrator\.sh'; then
            log "Another orchestrator is running (PID $other): leaving it be."
            exit 0
        fi
        log "Taking over the lock of an orchestrator that's gone (PID ${other:-unknown})."
    fi
    echo $$ > "$LOCK/pid"

    # Only from root's tree, and only when it's as setup.sh made it.
    local problem
    while :; do
        if [[ "$here" != "$CI_SCRIPTS" ]]; then
            problem="it runs from $here, not $CI_SCRIPTS."
        elif problem="$(verify_tree 2>&1)"; then
            break
        fi
        log "!!! Not running: $problem Run scripts/ci-runner/setup.sh again."
        status error "not running: $problem"
        nap 3600
    done

    prepare_keychain || log "Couldn't prepare a keychain for the VMs; they may not start."
    log "Starting: $REPOSITORY, labels ${RUNNER_LABELS[*]}, Tart $(run_limited 30 tart --version), PATH $PATH"
    # Whatever a crash or a restart left, paused or not.
    clean_vms || true
    if [[ -s "$TOKEN_FILE" ]]; then clean_leftovers; fi
    local backoff=60 stuck="" result
    while :; do
        rotate_log
        warn_token_expiry
        if [[ -e "$PAUSED" ]]; then
            status paused "paused ($PAUSED is there)"
            nap 60
            continue
        fi
        if [[ ! -s "$TOKEN_FILE" ]]; then
            log "!!! No GitHub token in $TOKEN_FILE: run scripts/ci-runner/setup.sh."
            status error "no GitHub token: run setup.sh"
            nap 300
            continue
        fi
        if ! clean_vms; then status error "a VM from before couldn't be deleted"; nap 300; continue; fi
        if ! take_golden; then status error "no golden image to use"; nap 300; continue; fi
        warn_old_golden
        status starting "booting a VM"
        one_job
        result=$?
        end_job
        case "$result" in
            0 | 2)
                backoff=60
                stuck=""
                ;;
            *)
                if ((backoff >= BACKOFF_MAX)); then
                    if [[ -z "$stuck" ]]; then
                        log "!!! CI IS STUCK: every try has failed for a while (a dead token, a broken softnet, no network?). Read the lines above; trying again every $((BACKOFF_MAX / 60)) minutes."
                        stuck=1
                    fi
                    status stuck "every try fails; see $LOG_FILE"
                else
                    status waiting "a try failed; next in $((backoff / 60)) min"
                fi
                log "Waiting $((backoff / 60)) min before the next VM."
                nap "$backoff"
                backoff=$((backoff * 2 > BACKOFF_MAX ? BACKOFF_MAX : backoff * 2))
                ;;
        esac
    done
}

# Run, not sourced (the tests source it for its functions).
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi

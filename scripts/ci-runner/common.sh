# What the Mac mini's runner setup and hooks share (scripts/ci-runner/setup.sh, job-started.sh,
# job-completed.sh). Sourced, never run. Each function only touches what the runner's own user
# (`ci`) made: its keychain search list, disk images it mounted from its own folders, the runner's
# work folder.
# shellcheck shell=bash

REPOSITORY="serhatandic/kuvo-code"
RUNNER_NAME="kuvo-mini"
SHARED="/Users/Shared/kuvo-ci"
# The runner's folder, and what of it jobs work in (setup.sh puts it there).
RUNNER_DIR="${KUVO_RUNNER_DIR:-$HOME/actions-runner}"
WORK_DIR="$RUNNER_DIR/_work"
LABEL="actions.runner.${REPOSITORY%%/*}-${REPOSITORY##*/}.$RUNNER_NAME"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# Why the pre-job hook refused a job, since GitHub may never get the stopped job's log.
# shellcheck disable=SC2034 # used by job-started.sh
REFUSALS_LOG="$HOME/Library/Logs/kuvo-ci-refusals.log"
# What jobs find on PATH: Xcode's tools in /usr/bin, and gh from Homebrew (the release job
# publishes with it). Bun and Node come from the workflows' setup actions.
JOB_PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# The runner's .env, every line of it: the runner hands these to every step, so the hook checks
# nobody added to it.
runner_env() {
    echo "LANG=en_US.UTF-8"
    echo "ACTIONS_RUNNER_HOOK_JOB_STARTED=$SHARED/job-started.sh"
    echo "ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$SHARED/job-completed.sh"
}

# What a job may have left in ci's account to run later, or to change what later jobs run: the
# runner's .env and .path not as setup.sh wrote them, login agents besides the runner's, a
# crontab. Prints what it found; fails if anything.
account_tampered() {
    local found=0 agent
    if [[ "$(cat "$RUNNER_DIR/.env" 2>/dev/null)" != "$(runner_env)" ]]; then
        echo "The runner's .env isn't as setup.sh wrote it."
        found=1
    fi
    if [[ "$(cat "$RUNNER_DIR/.path" 2>/dev/null)" != "$JOB_PATH" ]]; then
        echo "The runner's .path isn't as setup.sh wrote it."
        found=1
    fi
    for agent in "$HOME"/Library/LaunchAgents/*; do
        [[ -e "$agent" && "$agent" != "$PLIST" ]] || continue
        echo "A login agent besides the runner's: $agent"
        found=1
    done
    if [[ -n "$(crontab -l 2>/dev/null)" ]]; then
        echo "ci has a crontab."
        found=1
    fi
    return "$found"
}

# Signing keychains a release job left (release.yml's "Clean up signing" deletes its own; this is
# for a job that was stopped before it could), and search list entries for keychains that are gone.
clean_signing() {
    local line path kept=() changed=
    while IFS= read -r line; do
        path="$(sed 's/^ *"//; s/"$//' <<< "$line")"
        [[ -n "$path" ]] || continue
        if [[ "$path" == "$WORK_DIR/"* && "$(basename "$path")" == signing*.keychain-db ]]; then
            echo "Deleting a signing keychain a job left: $path"
            security delete-keychain "$path" 2>/dev/null || true
            changed=1
        elif [[ ! -e "$path" ]]; then
            echo "Dropping a keychain that's gone from the search list: $path"
            changed=1
        else
            kept+=("$path")
        fi
    done < <(security list-keychains -d user)
    if [[ -n "$changed" && ${#kept[@]} -gt 0 ]]; then
        security list-keychains -d user -s "${kept[@]}" || true
    fi
    # And any keychain file a job left in the work folder (the runner empties _temp itself, but
    # only once the next job starts).
    find "$WORK_DIR" -maxdepth 2 -name 'signing*.keychain-db' -type f -delete 2>/dev/null || true
}

# Disk images still mounted from this user's folders (its home, its temporary and cache folders):
# a job that failed between attaching one and detaching it.
detach_images() {
    local info i path dev user_tmp
    user_tmp="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || true)"
    user_tmp="${user_tmp%/}"
    user_tmp="${user_tmp%/*}" # /var/folders/xx/yyyy, which holds T (temporary) and C (cache)
    info="$(mktemp)"
    hdiutil info -plist > "$info" 2>/dev/null || { rm -f "$info"; return 0; }
    i=0
    while path="$(plutil -extract "images.$i.image-path" raw -o - "$info" 2>/dev/null)"; do
        if [[ "$path" == "$HOME/"* || ( -n "$user_tmp" && "$path" == "$user_tmp/"* ) ]]; then
            local j=0
            while dev="$(plutil -extract "images.$i.system-entities.$j.dev-entry" raw -o - "$info" 2>/dev/null)"; do
                if [[ "$dev" =~ ^/dev/disk[0-9]+$ ]]; then
                    echo "Detaching $path ($dev), which a job left mounted"
                    hdiutil detach "$dev" -force >/dev/null 2>&1 || true
                    break
                fi
                j=$((j + 1))
            done
        fi
        i=$((i + 1))
    done
    rm -f "$info"
}

# Room left on the disk, with a warning in the run's summary when it's getting low.
report_disk() {
    local free_gb
    free_gb="$(df -g "$HOME" | awk 'NR == 2 { print $4 }')"
    echo "Free on the disk: ${free_gb} GB"
    if [[ -n "$free_gb" && "$free_gb" -lt "${KUVO_RUNNER_MIN_FREE_GB:-40}" ]]; then
        echo "::warning title=Mac mini disk::Only ${free_gb} GB free on the Mac mini's disk."
    fi
}

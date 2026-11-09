#!/bin/sh
# Runs a heavy job (a build, a test run) once this Mac has room for it:
#
#   scripts/heavy.sh <mac|phone|box> <command> [arguments…]
#
#   mac    anything that builds in KuvoShared-MacBuild or KuvoCodeTests-build: the Mac app's
#          xcodebuild, its scripts/test-app.sh, swift build or test of its packages
#   phone  anything that builds in KuvoShared-PhoneBuild or KuvoCodeMobileTests-build: the phone's
#          xcodebuild, its scripts/test-app.sh
#   box    the box's whole suites (bun test, node --test) and runs on a test machine
#
# Jobs of one kind share their build folders, which two builds at once break, so they run one at a
# time, each waiting on its kind's lock in this user's own temporary folder (getconf's, not
# $TMPDIR, which a caller may point elsewhere). Jobs of different kinds run side by side. Once its
# turn comes, a job also waits while the Mac is busy (its load over the last minute above
# KUVO_HEAVY_LOAD, 40 unless set), so it stays usable.
#
# phone has two slots, so two phone jobs can run at once, each on a simulator of its own (the Mac
# mini has room for it). Slot 1 is the lock above, unchanged, with the simulator "Kuvo Code Tests";
# slot 2 is kuvo-code-heavy-phone-2-<uid>.lock, with "Kuvo Code Tests 2". A job that takes a slot
# finds out which in KUVO_TEST_SIMULATOR (the simulator's name), KUVO_HEAVY_SLOT (1 or 2) and
# KUVO_HEAVY_BUILD_SUFFIX ("" or "-2", for a build folder of its own: two builds in one folder break).
# A script that started before slots existed holds slot 1 alone, as always, so it and a new job
# on slot 1 still exclude each other, and a job on slot 2 runs beside it.
#
# Slot 2 is only for a caller that handles slots (KUVO_HEAVY_SLOTS=2): an older caller would take it
# and still build in slot 1's folder and drive slot 1's simulator, beside whoever holds slot 1.
# With it, a job takes whichever slot is free first, slot 1 before slot 2, and when both are busy it
# waits for whichever frees first (looking once a second).
#
#   KUVO_HEAVY_SLOTS=2  phone jobs may take either slot (1, the default, only slot 1)
#
# A job inside one that holds its kind's lock already (a test run its caller started with this
# helper, in either slot) runs at once. So does one under the single lock every heavy job took before
# (kuvo-code-heavy-<uid>.lock). Its day is over (KUVO_HEAVY_OLD_UNTIL, the last day a job took it
# as it ran, so one in an older checkout couldn't start beside it): kinds run side by side.
#
#   scripts/heavy.sh --holds <kind>   whether this runs inside such a job already (exit 0), for
#                                     a script that takes its turn itself (scripts/test-app.sh)
#
#   KUVO_HEAVY_WAIT=0   don't wait: say what it would wait for, and exit 75
#   KUVO_HEAVY_DIR      where the locks are (for the helper's own tests)
set -eu

usage() {
    echo "Usage: scripts/heavy.sh <mac|phone|box> <command> [arguments…], or --holds <kind>" >&2
    exit 64
}
[ $# -ge 2 ] || usage
holds=
if [ "$1" = --holds ]; then
    holds=1
    shift
fi
kind=$1
shift
case "$kind" in mac | phone | box) ;; *) usage ;; esac

DIR="${KUVO_HEAVY_DIR:-$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || echo /tmp/)}"
DIR="${DIR%/}"
LOCK="$DIR/kuvo-code-heavy-$kind-$(id -u).lock"
# Phone's second slot; no other kind has one. SLOTS is how many this caller may take.
LOCK2=
SLOTS=1
if [ "$kind" = phone ]; then
    LOCK2="$DIR/kuvo-code-heavy-$kind-2-$(id -u).lock"
    [ "${KUVO_HEAVY_SLOTS:-1}" = 2 ] && SLOTS=2
fi
OLD="$DIR/kuvo-code-heavy-$(id -u).lock"
MAX_LOAD="${KUVO_HEAVY_LOAD:-40}"
WAITS="${KUVO_HEAVY_WAIT:-1}"

# Whether `ps` answers. A sandbox can refuse it (Auto mode), and then no process can be asked what
# it runs under.
can_ps() { [ -n "$(ps -o command= -p $$ 2>/dev/null)" ]; }

# Whether a process this one runs under holds `lock` (a `lockf … <lock> …` above it). Without `ps`,
# the jobs this helper started tell who holds what (KUVO_HEAVY_HELD, "<lock>:<pid of its lockf>"
# entries), and the claim counts only while that process still runs and the lock is held: a leftover
# one doesn't.
held() {
    if can_ps; then
        pid=$$
        while [ "${pid:-1}" -gt 1 ]; do
            case "$(ps -o command= -p "$pid" 2>/dev/null)" in "lockf "*" $1 "*) return 0 ;; esac
            pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
        done
        return 1
    fi
    for claim in ${KUVO_HEAVY_HELD:-}; do
        [ "${claim%:*}" = "$1" ] || continue
        kill -0 "${claim##*:}" 2>/dev/null && ! lockf -ks -t 0 "$1" true && return 0
    done
    return 1
}

# Whether this process is the one a job's `lockf` just started for its turn on lock $1 (below):
# `ps` says so from the lock above it; without it, the job named its own process, which is lockf's
# parent now.
just_taken() {
    if can_ps; then
        held "$1"
    else
        [ "${KUVO_HEAVY_HOLDING:-}" = "$1:$PPID" ] && ! lockf -ks -t 0 "$1" true
    fi
}

# What a phone job knows of its slot, from the slot's lock: a job inside another takes it from the
# lock it runs under, not from the environment it inherited (a shell started in a slot-2 job keeps
# slot 2's values).
slot_env() {
    if [ "$1" = "$LOCK2" ]; then
        export KUVO_TEST_SIMULATOR="Kuvo Code Tests 2" KUVO_HEAVY_SLOT=2 KUVO_HEAVY_BUILD_SUFFIX=-2
    else
        export KUVO_TEST_SIMULATOR="Kuvo Code Tests" KUVO_HEAVY_SLOT=1 KUVO_HEAVY_BUILD_SUFFIX=
    fi
}

# Whether this runs inside a job of this kind (in either slot) or of the old single lock.
holds_any() {
    held "$LOCK" || { [ -n "$LOCK2" ] && held "$LOCK2"; } || held "$OLD"
}

# Not waiting (KUVO_HEAVY_WAIT=0): says what for, and stops.
cannot_wait() {
    echo "$1" >&2
    exit 75
}

if [ -n "$holds" ]; then
    holds_any
    exit
fi

# The lock whose turn this process has just taken (below), if any.
TAKEN=
for candidate in "$LOCK" "$LOCK2"; do
    [ -n "$candidate" ] || continue
    case "${KUVO_HEAVY_HOLDING:-}" in "$candidate" | "$candidate":*) ;; *) continue ;; esac
    if just_taken "$candidate"; then
        TAKEN=$candidate
        break
    fi
done

if [ -n "$TAKEN" ]; then
    # Its turn, just taken (below).
    unset KUVO_HEAVY_HOLDING
    # What runs under this turn knows it holds the lock, for when `ps` can't say.
    KUVO_HEAVY_HELD="${KUVO_HEAVY_HELD:-} $TAKEN:$PPID"
    [ "$kind" != phone ] || slot_env "$TAKEN"
    # While jobs were still started the old way, under one lock for every kind (older checkouts'
    # test-app.sh), one of these waited for them, and held that lock too as it ran.
    if [ "$(date +%Y%m%d)" -le "${KUVO_HEAVY_OLD_UNTIL:-20261026}" ]; then
        if ! lockf -ks -t 0 "$OLD" true; then
            [ "$WAITS" = 0 ] && cannot_wait "A heavy job started the old way is running."
            echo "Waiting for a heavy job started the old way to finish…" >&2
        fi
        old_way=1
        KUVO_HEAVY_HELD="$KUVO_HEAVY_HELD $OLD:$$"
    fi
    export KUVO_HEAVY_HELD
else
    # Inside a job that holds the lock already: on at once.
    if holds_any; then
        if [ "$kind" = phone ]; then
            if [ -n "$LOCK2" ] && held "$LOCK2"; then slot_env "$LOCK2"; elif held "$LOCK"; then slot_env "$LOCK"; fi
        fi
        exec "$@"
    fi
    # Its kind's turn.
    if [ "$SLOTS" = 2 ]; then
        # The first free slot, slot 1 first. Taking one is `lockf` on it, the job's own parent as
        # before. Between the look and the `lockf` (a few milliseconds) another job can take that
        # slot: this one then waits for it, even if the other slot frees first, and with
        # KUVO_HEAVY_WAIT=0 it waits too. That needs two jobs starting within those milliseconds.
        said=
        while :; do
            for slot in "$LOCK" "$LOCK2"; do
                if lockf -ks -t 0 "$slot" true; then
                    KUVO_HEAVY_HOLDING="$slot:$$" exec lockf -k "$slot" /bin/sh "$0" "$kind" "$@"
                fi
            done
            [ "$WAITS" = 0 ] && cannot_wait "Another $kind job is running in each of its two slots."
            [ -n "$said" ] || echo "Waiting for another $kind job to finish…" >&2
            said=1
            sleep 1
        done
    fi
    if ! lockf -ks -t 0 "$LOCK" true; then
        [ "$WAITS" = 0 ] && cannot_wait "Another $kind job is running."
        echo "Waiting for another $kind job to finish…" >&2
    fi
    KUVO_HEAVY_HOLDING="$LOCK:$$" exec lockf -k "$LOCK" /bin/sh "$0" "$kind" "$@"
fi

# The Mac busy: wait until it isn't.
load() { sysctl -n vm.loadavg | awk '{ print $2 }'; }
said=
while [ "$(load | awk -v max="$MAX_LOAD" '{ print ($1 > max) }')" = 1 ]; do
    [ "$WAITS" = 0 ] && cannot_wait "The Mac is busy (load $(load), over $MAX_LOAD)."
    [ -n "$said" ] || echo "Waiting while the Mac is busy (load $(load), over $MAX_LOAD)…" >&2
    said=1
    sleep 15
done

# The job runs in a process group of its own, and the group ends with the job: once the command is
# over, or this helper is stopped, everything the command started that stays in its group is
# stopped too, so nothing is left running behind a finished or cancelled job. The group is stopped
# by its id, which is the job's pid: no `ps`, no search by name (a sandbox refuses `ps`, and a name
# matches other people's processes). TERM first, KILL for what's still there after about 3 seconds.
# A shell that gave the job no group of its own has no group by that id, and the kill finds nothing.
group=
watch=
early=
end_group() {
    [ -n "$group" ] && kill -0 -- "-$group" 2>/dev/null || return 0
    kill -s "$1" -- "-$group" 2>/dev/null || true
    tries=0
    while [ "$tries" -lt 30 ] && kill -0 -- "-$group" 2>/dev/null; do
        sleep 0.1
        tries=$((tries + 1))
    done
    ! kill -0 -- "-$group" 2>/dev/null || kill -s KILL -- "-$group" 2>/dev/null || true
}
end_watch() {
    [ -n "$watch" ] || return 0
    { kill -s KILL -- "-$watch" && wait "$watch"; } 2>/dev/null || true
}
stopped() {
    # Stopped before the job has started (between its start and its id being known): once it has.
    if [ -z "$group" ]; then
        early="$1 $2"
        return 0
    fi
    trap '' HUP INT TERM
    end_group "$1"
    end_watch
    exit "$2"
}

# In a terminal the job stays in the terminal's own group: one in a group of its own couldn't read
# the keyboard (a passphrase prompt would stop it), and Ctrl-C reaches the whole group there anyway.
if [ -t 0 ] || { true </dev/tty; } 2>/dev/null; then
    [ -n "${old_way:-}" ] && exec lockf -k "$OLD" "$@"
    exec "$@"
fi

trap 'stopped HUP 129' HUP
trap 'stopped INT 130' INT
trap 'stopped TERM 143' TERM
set -m
if [ -n "${old_way:-}" ]; then
    lockf -k "$OLD" "$@" &
else
    "$@" &
fi
group=$!
# `lockf` doesn't pass a signal on to its command, and lets go of the lock as it ends: this helper
# (the job's `lockf` is its parent) being stopped, even killed, would leave the job running. A
# watcher of its own, in a group of its own too, notices when the parent is gone, stops this shell
# if it's still there, and then the job's group itself if nothing else has: this shell may have been
# killed, and a helper above it may have stopped it before it was done.
parent=$PPID
me=$$
(
    while kill -0 "$parent" 2>/dev/null; do sleep 0.2; done
    kill -s TERM "$me" 2>/dev/null || true
    waits=0
    while [ "$waits" -lt 100 ] && kill -0 "$me" 2>/dev/null; do
        sleep 0.1
        waits=$((waits + 1))
    done
    end_group TERM
) >/dev/null 2>&1 &
watch=$!
set +m
[ -z "$early" ] || stopped ${early}
status=0
wait "$group" || status=$?
end_group TERM
end_watch
exit "$status"

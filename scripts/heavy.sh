#!/bin/sh
# Runs a heavy job (a build, a test run) once this Mac has room for it:
#
#   scripts/heavy.sh <mac|mac-build|phone|box> <command> [arguments…]
#
#   mac        the Mac app's UI test suite, scripts/test-app.sh, which drives the real window and
#              pointer and so runs alone (it builds in KuvoCodeTests-build). Older scripts also say
#              mac for a plain build (xcodebuild in KuvoShared-MacBuild, swift build or test of a
#              package), which still works: it takes this lock, as it always did.
#   mac-build  what doesn't drive the UI: the Mac's xcodebuild (builds, demo builds), swift build
#              or test of its packages. Two slots, and it doesn't take mac's lock, so these run
#              beside the app suite and each other.
#   phone      anything that builds in KuvoShared-PhoneBuild or KuvoCodeMobileTests-build: the
#              phone's xcodebuild, its scripts/test-app.sh
#   box        the box's whole suites (bun test, node --test) and runs on a test machine
#
# Jobs of one kind share their build folders, which two builds at once break, so they run one at a
# time, each waiting on its kind's lock in this user's own temporary folder (getconf's, not
# $TMPDIR, which a caller may point elsewhere). Jobs of different kinds run side by side. Once its
# turn comes, a job also waits while the Mac is busy (its load over the last minute above
# KUVO_HEAVY_LOAD, 40 unless set), so it stays usable. While the Mac app's suite (mac) waits there,
# new phone, mac-build and box jobs wait for it to start, for 15 minutes at most
# (KUVO_HEAVY_MAC_FIRST_FOR): the jobs that kept starting kept the Mac busy, and it rarely got in.
#
# phone has two slots, so two phone jobs can run at once, each on a simulator of its own (the Mac
# mini has room for it). Slot 1 is the lock above, unchanged, with the simulator "Kuvo Code Tests";
# slot 2 is kuvo-code-heavy-phone-2-<uid>.lock, with "Kuvo Code Tests 2". A job that takes a slot
# finds out which in KUVO_TEST_SIMULATOR (the simulator's name), KUVO_HEAVY_SLOT (1 or 2) and
# KUVO_HEAVY_BUILD_SUFFIX ("" or "-2", for a build folder of its own: two builds in one folder break).
# A script that started before slots existed holds slot 1 alone, as always, so it and a new job
# on slot 1 still exclude each other, and a job on slot 2 runs beside it.
#
# mac-build has two slots the same way, for every caller (no older script says mac-build, so there is
# no one to keep apart): slot 1 is kuvo-code-heavy-mac-build-<uid>.lock, slot 2
# kuvo-code-heavy-mac-build-2-<uid>.lock, and a job takes whichever is free first. It finds out which
# in KUVO_HEAVY_SLOT (1 or 2) and KUVO_HEAVY_BUILD_SUFFIX ("-1" or "-2"): build in
# KuvoShared-MacBuild$KUVO_HEAVY_BUILD_SUFFIX. Neither slot uses KuvoShared-MacBuild itself, which a
# job that still says mac builds in, nor KuvoCodeTests-build, which the app suite builds in, so
# nothing builds twice in one folder. (A package's .build and a checkout's build/ are its own to each
# checkout.) Never start a build in a folder that isn't the slot's.
#
# For phone, slot 2 is only for a caller that handles slots (KUVO_HEAVY_SLOTS=2): an older caller would take it
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
#
# Every job has a time limit, so one that hangs can't hold its kind's turn for hours: past it, the
# job is stopped (its process group, as below: TERM, then KILL), it says what was running, and
# heavy.sh exits 124. The clock runs only while the job runs, not while it waits for its turn or for
# a busy Mac. Generous, per kind: mac 45 minutes (the app's whole suite), phone 45, mac-build 30
# (a build, a package's tests), box 20 (a box or bridge suite).
#
#   KUVO_HEAVY_LIMIT    this job's limit instead: 90m, 600s, 2h, or plain minutes; 0 for none
#
# A job inside one of its kind (above) runs within that one's limit; one of another kind has its
# own as well. In a terminal a job has none: you're there to stop it. Older copies of this helper
# start their jobs with no limit, and take turns with these as before.
set -eu

usage() {
    echo "Usage: scripts/heavy.sh <mac|mac-build|phone|box> <command> [arguments…], or --holds <kind>" >&2
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
case "$kind" in mac | mac-build | phone | box) ;; *) usage ;; esac

DIR="${KUVO_HEAVY_DIR:-$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || echo /tmp/)}"
DIR="${DIR%/}"
LOCK="$DIR/kuvo-code-heavy-$kind-$(id -u).lock"
# A second slot, for phone and mac-build; no other kind has one. SLOTS is how many this caller may
# take: a phone caller says so (KUVO_HEAVY_SLOTS=2), a mac-build one always may.
LOCK2=
SLOTS=1
case "$kind" in
    phone)
        LOCK2="$DIR/kuvo-code-heavy-$kind-2-$(id -u).lock"
        [ "${KUVO_HEAVY_SLOTS:-1}" = 2 ] && SLOTS=2
        ;;
    mac-build)
        LOCK2="$DIR/kuvo-code-heavy-$kind-2-$(id -u).lock"
        SLOTS=2
        ;;
esac
OLD="$DIR/kuvo-code-heavy-$(id -u).lock"
MAX_LOAD="${KUVO_HEAVY_LOAD:-40}"
WAITS="${KUVO_HEAVY_WAIT:-1}"
case "$kind" in mac | phone) DEFAULT_LIMIT=45m ;; mac-build) DEFAULT_LIMIT=30m ;; box) DEFAULT_LIMIT=20m ;; esac
# A time like 90m, 600s or 2h (plain: minutes), in seconds; $2 names the variable it came from.
seconds_of() {
    case "$1" in
        *[!0-9smh]* | "" | [smh]* | *[smh]?*) ;;
        *s) echo "${1%s}"; return ;;
        *m) echo $((${1%m} * 60)); return ;;
        *h) echo $((${1%h} * 3600)); return ;;
        *) echo $(($1 * 60)); return ;;
    esac
    echo "$2 is a time like 90m, 600s or 2h, or 0 for none (it's $1)." >&2
    exit 64
}
GIVEN_LIMIT="${KUVO_HEAVY_LIMIT:-$DEFAULT_LIMIT}"
LIMIT=$(seconds_of "$GIVEN_LIMIT" KUVO_HEAVY_LIMIT) || exit 64
# How long the Mac app's suite, waiting on a busy Mac with its turn, holds back new jobs of the
# other kinds (below).
GIVEN_MAC_FIRST="${KUVO_HEAVY_MAC_FIRST_FOR:-15m}"
MAC_FIRST_FOR=$(seconds_of "$GIVEN_MAC_FIRST" KUVO_HEAVY_MAC_FIRST_FOR) || exit 64
MAC_FIRST="$DIR/kuvo-code-heavy-mac-first-$(id -u)"

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

# What a phone or mac-build job knows of its slot, from the slot's lock: a job inside another takes
# it from the lock it runs under, not from the environment it inherited (a shell started in a slot-2
# job keeps slot 2's values). A phone job has a simulator, a mac-build job a build folder of its own
# in each slot (slot 1's suffix isn't empty: that folder is the older scripts' mac). A job that
# only runs under the old single lock holds no slot, and gets none of these.
slot_env() {
    if [ "$kind" = mac-build ]; then
        unset KUVO_TEST_SIMULATOR
        if [ "$1" = "$LOCK2" ]; then
            export KUVO_HEAVY_SLOT=2 KUVO_HEAVY_BUILD_SUFFIX=-2
        else
            export KUVO_HEAVY_SLOT=1 KUVO_HEAVY_BUILD_SUFFIX=-1
        fi
    elif [ "$1" = "$LOCK2" ]; then
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
    [ -z "$LOCK2" ] || slot_env "$TAKEN"
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
        if [ -n "$LOCK2" ]; then
            if held "$LOCK2"; then slot_env "$LOCK2"; elif held "$LOCK"; then slot_env "$LOCK"; fi
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
busy() { [ "$(load | awk -v max="$MAX_LOAD" '{ print ($1 > max) }')" = 1 ]; }

# The Mac app's suite first: with its turn, it waits for the Mac to be less busy, and phone,
# mac-build and box jobs that kept starting meanwhile kept it busy, so it rarely got in. While it
# waits there (it says so in $MAC_FIRST: its pid and since when), a new job of another kind waits
# for it to start, for $MAC_FIRST_FOR at most. Jobs already running go on. A suite that's gone, or
# that started, says nothing; older copies of this helper neither say it nor wait for it.
mac_waits() {
    [ -f "$MAC_FIRST" ] || return 1
    read -r pid since < "$MAC_FIRST" 2>/dev/null || return 1
    [ -n "${pid:-}" ] && [ -n "${since:-}" ] && kill -0 "$pid" 2>/dev/null && [ $(($(date +%s) - since)) -lt "$MAC_FIRST_FOR" ]
}
if [ "$kind" != mac ]; then
    said=
    while mac_waits; do
        [ "$WAITS" = 0 ] && cannot_wait "The Mac app's suite is waiting for the Mac to be less busy, and goes first."
        [ -n "$said" ] || echo "Waiting for the Mac app's suite to start first: it's waiting for the Mac to be less busy (for $GIVEN_MAC_FIRST at most)…" >&2
        said=1
        sleep 5
    done
fi

said=
if [ "$kind" = mac ] && busy && [ "$WAITS" != 0 ]; then
    printf '%s %s\n' "$$" "$(date +%s)" > "$MAC_FIRST.$$" && mv -f "$MAC_FIRST.$$" "$MAC_FIRST"
fi
while busy; do
    [ "$WAITS" = 0 ] && cannot_wait "The Mac is busy (load $(load), over $MAX_LOAD)."
    [ -n "$said" ] || echo "Waiting while the Mac is busy (load $(load), over $MAX_LOAD)…" >&2
    said=1
    sleep 15
done
# (Its own say, not another suite's since.)
if [ "$kind" = mac ] && [ -f "$MAC_FIRST" ] && read -r pid since < "$MAC_FIRST" 2>/dev/null && [ "$pid" = "$$" ]; then
    rm -f "$MAC_FIRST"
fi

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
    [ -n "$timer" ] || return 0
    { kill -s KILL -- "-$timer" && wait "$timer"; } 2>/dev/null || true
}
stopped() {
    # Stopped before the job has started (between its start and its id being known): once it has.
    if [ -z "$group" ]; then
        early="$1 $2"
        return 0
    fi
    trap '' HUP INT TERM USR1
    end_group "$1"
    end_watch
    exit "$2"
}
# Past its time limit (its timer, below, says so).
timer=
over_time() {
    trap '' HUP INT TERM USR1
    echo "heavy.sh: this $kind job ran past its time limit ($GIVEN_LIMIT) and was stopped: $*" >&2
    echo "heavy.sh: if it wasn't stuck, give it longer with KUVO_HEAVY_LIMIT (like KUVO_HEAVY_LIMIT=90m)." >&2
    end_group TERM
    end_watch
    exit 124
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
# (The command as it was given, for what over_time says.)
command_line=$*
trap 'over_time "$command_line"' USR1
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
# Its time limit: a timer of its own, in a group of its own, that tells this shell once it's up (and
# that the watcher below ends with the job, if this shell can't).
if [ "$LIMIT" -gt 0 ]; then
    (
        sleep "$LIMIT"
        kill -s USR1 "$me" 2>/dev/null || true
    ) >/dev/null 2>&1 &
    timer=$!
fi
(
    while kill -0 "$parent" 2>/dev/null; do sleep 0.2; done
    kill -s TERM "$me" 2>/dev/null || true
    waits=0
    while [ "$waits" -lt 100 ] && kill -0 "$me" 2>/dev/null; do
        sleep 0.1
        waits=$((waits + 1))
    done
    end_group TERM
    [ -z "$timer" ] || kill -s KILL -- "-$timer" 2>/dev/null || true
) >/dev/null 2>&1 &
watch=$!
set +m
[ -z "$early" ] || stopped ${early}
status=0
wait "$group" || status=$?
end_group TERM
end_watch
exit "$status"

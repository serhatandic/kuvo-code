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
# A job inside one that holds its kind's lock already (a test run its caller started with this
# helper) runs at once. So does one under the single lock every heavy job took before
# (kuvo-code-heavy-<uid>.lock); and while a job holds that one, every kind waits for it, so runs
# started the old way finish first. That lock goes on 2026-10-28.
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
OLD="$DIR/kuvo-code-heavy-$(id -u).lock"
MAX_LOAD="${KUVO_HEAVY_LOAD:-40}"
WAITS="${KUVO_HEAVY_WAIT:-1}"

# Whether a process this one runs under holds `lock` (a `lockf … <lock> …` above it). Saying so in
# the environment doesn't count.
held() {
    pid=$$
    while [ "${pid:-1}" -gt 1 ]; do
        case "$(ps -o command= -p "$pid" 2>/dev/null)" in "lockf "*" $1 "*) return 0 ;; esac
        pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    done
    return 1
}

# Not waiting (KUVO_HEAVY_WAIT=0): says what for, and stops.
cannot_wait() {
    echo "$1" >&2
    exit 75
}

if [ -n "$holds" ]; then
    held "$LOCK" || held "$OLD"
    exit
fi

if [ "${KUVO_HEAVY_HOLDING:-}" = "$LOCK" ] && held "$LOCK"; then
    # Its turn, just taken (below).
    unset KUVO_HEAVY_HOLDING
    # A job started the old way, under the one lock for every kind: it finishes first.
    if ! lockf -ks -t 0 "$OLD" true; then
        [ "$WAITS" = 0 ] && cannot_wait "A heavy job started the old way is running."
        echo "Waiting for a heavy job started the old way to finish…" >&2
        lockf -k "$OLD" true
    fi
else
    # Inside a job that holds the lock already: on at once.
    if held "$LOCK" || held "$OLD"; then
        exec "$@"
    fi
    # Its kind's turn.
    if ! lockf -ks -t 0 "$LOCK" true; then
        [ "$WAITS" = 0 ] && cannot_wait "Another $kind job is running."
        echo "Waiting for another $kind job to finish…" >&2
    fi
    KUVO_HEAVY_HOLDING="$LOCK" exec lockf -k "$LOCK" /bin/sh "$0" "$kind" "$@"
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

exec "$@"

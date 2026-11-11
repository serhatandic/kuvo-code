#!/bin/sh
# Runs a heavy job (a build, a test run) once this Mac has room for it:
#
#   scripts/heavy.sh <mac|mac-build|phone-build|phone|box> <command> [arguments…]
#
#   mac        the Mac app's UI test suite, scripts/test-app.sh, which drives the real window and
#              pointer and so runs alone (it builds in KuvoCodeTests-build). Older scripts also say
#              mac for a plain build (xcodebuild in KuvoShared-MacBuild, swift build or test of a
#              package), which still works: it takes this lock, as it always did.
#   mac-build  what doesn't drive the UI: the Mac's xcodebuild (builds, demo builds), swift build
#              or test of its packages. Two slots, and it doesn't take mac's lock, so these run
#              beside the app suite and each other.
#              The phone's builds share these slots (phone-build, below).
#   phone-build  the phone's builds, and anything else of the phone's that boots no simulator. The
#              same lane as mac-build, not a lane of its own: it is mac-build under another name
#              (the same two slots and locks, so a phone build and a Mac build count against each
#              other, as both are xcodebuild compiles competing for one CPU and memory, and the
#              same time limit). It never touches a phone simulator slot, so builds don't queue
#              behind test runs. Build in KuvoShared-PhoneLane$KUVO_HEAVY_BUILD_SUFFIX (-1 or -2),
#              a folder that neither phone's slots nor mac-build's use: phone's slot 2 builds in
#              KuvoShared-PhoneBuild-2, so a suffix on that name would collide.
#   phone      the phone's test runs that boot a simulator: anything that builds in
#              KuvoShared-PhoneBuild or KuvoCodeMobileTests-build, its scripts/test-app.sh
#   box        the box's whole suites (bun test, node --test) and runs on a test machine
#
# (phone-build is mac-build below: everything said of mac-build holds for it.)
#
# Jobs of one kind share their build folders, which two builds at once break, so they run one at a
# time, each waiting on its kind's lock in this user's own temporary folder (getconf's, not
# $TMPDIR, which a caller may point elsewhere). Jobs of different kinds run side by side. Before it
# joins its lane's line, a new job waits while the Mac is thrashing: swapping more than
# KUVO_HEAVY_SWAP MB a second (10 unless set) or its memory pressure critical, for
# KUVO_HEAVY_MEMORY_WAIT_FOR (2 minutes) at most (below; KUVO_HEAVY_MEMORY=0 for never). It waits
# for a busy Mac (its load over the last minute above KUVO_HEAVY_LOAD) or for less than
# KUVO_HEAVY_MEMORY% of memory available only when those are set: background priority (below) is
# what keeps the Mac usable, and on the Mini, with a dozen sessions, both were true all day, so jobs
# only waited. While the Mac app's suite (mac) waits there, new phone, mac-build and box jobs wait
# for it to start, for 2 minutes at most (KUVO_HEAVY_MAC_FIRST_FOR). None of these waits happens
# while a job holds its lane's lock: a job waiting for room holds up no one behind it in line.
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
# With it, a job takes whichever slot is free first, slot 1 before slot 2 (unless a job behind it
# waits for slot 1 only: then slot 2, and slot 1 is that one's), and when both are busy it waits for
# whichever frees first (looking once a second). One that waits for slot 1 only never holds up a job
# behind it that may take slot 2.
#
#   KUVO_HEAVY_SLOTS=2  phone jobs may take either slot (1, the default, only slot 1)
#
# Jobs waiting for a lane wait in line, in its queue (kuvo-code-heavy-<kind>-<uid>.queue): first come,
# first served, except that a high-priority job goes before every normal one waiting (and after the
# high ones that came before it). It never stops or holds up a job already running: it only gets the
# next free slot. Whoever looks at the queue or changes it does so under its guard lock, one at a
# time, and a slot given to a job is its claim until its `lockf` holds it, so no job that came later
# slips in between (nor waits, told not to). A job that's gone (killed, even), or hasn't looked for
# 30 seconds (stopped), leaves the line. Older copies of this helper (another checkout's) don't
# queue: they wait on a slot's lock, as before, and take it the moment it frees, before the jobs in
# line, which look once a second. The order holds among these.
#
# A job inside one that holds its kind's lock already (a test run its caller started with this
# helper, in either slot) runs at once. So does one under the single lock every heavy job took before
# (kuvo-code-heavy-<uid>.lock). Its day is over (KUVO_HEAVY_OLD_UNTIL, the last day a job took it
# as it ran, so one in an older checkout couldn't start beside it): kinds run side by side.
#
#   scripts/heavy.sh --holds <kind>   whether this runs inside such a job already (exit 0), for
#                                     a script that takes its turn itself (scripts/test-app.sh)
#
#   KUVO_HEAVY_PRIORITY=high  go before the normal jobs waiting in line (normal, the default)
#   KUVO_HEAVY_WAIT=0   don't wait: say what it would wait for (a job running, or one in line before
#                       it with a slot free), and exit 75, without waiting for a job (for the
#                       queue's guard, two seconds at most)
#   KUVO_HEAVY_DIR      where the locks are (for the helper's own tests)
#
# Jobs never starve the box (the Kuvo Code box on this Mac, which the user's phone talks to): every
# job runs at background priority, its children too (a job inside another gets it too). macOS:
# `taskpolicy -b`, background QoS: low CPU and I/O priority, which the box's own processes, at
# default priority, win over (tried with xcodebuild builds and tests, a simulator test run and swift
# test: all work). Linux: `nice -n 15 ionice -c3` (just `nice -n 15` without ionice). A job on an
# idle Mac runs as fast as ever; on a busy one it gives way.
#
# Every job has a time limit, so one that hangs can't hold its kind's turn for hours: past it, the
# job is stopped (its process group, as below: TERM, then KILL), it says what was running, and
# heavy.sh exits 124. The clock starts when the command does: not while it waits in line for its
# slot (for as long as that takes), nor while it waits for room on the Mac. Generous, per kind: mac 45
# minutes (the app's whole suite), phone 45, mac-build 30 (a build, a package's tests), box 40 (the
# box's and the bridge's suites, which may go together).
#
#   KUVO_HEAVY_LIMIT    this job's limit instead: 90m, 600s, 2h, or plain minutes; 0 for none
#
# A job inside one of its kind (above) runs within that one's limit; one of another kind has its
# own as well. In a terminal a job has none: you're there to stop it. Older copies of this helper
# start their jobs with no limit, and take turns with these as before.
set -eu

usage() {
    echo "Usage: scripts/heavy.sh <mac|mac-build|phone-build|phone|box> <command> [arguments…], or --holds <kind>" >&2
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
case "$kind" in mac | mac-build | phone-build | phone | box) ;; *) usage ;; esac
# The phone's build lane is the Mac's build lane: one pool of slots for xcodebuild compiles.
[ "$kind" != phone-build ] || kind=mac-build

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
MAX_LOAD="${KUVO_HEAVY_LOAD:-}"
WAITS="${KUVO_HEAVY_WAIT:-1}"
case "$kind" in mac | phone) DEFAULT_LIMIT=45m ;; mac-build) DEFAULT_LIMIT=30m ;; box) DEFAULT_LIMIT=40m ;; esac

# What every job runs under, so it never takes the CPU or the disk from the box: background priority
# (a prefix: `$LOW "$@"`; its children keep it). macOS: `taskpolicy -b`, background QoS: low CPU and
# I/O priority (`nice` alone leaves the I/O alone). Linux: nice and ionice.
LOW=
case "$(uname -s 2>/dev/null)" in
    Darwin)
        if command -v taskpolicy >/dev/null 2>&1; then LOW="taskpolicy -b"; else LOW="nice -n 15"; fi
        ;;
    *)
        # (ionice can be refused, in a container: then nice alone.)
        if command -v ionice >/dev/null 2>&1 && ionice -c3 true >/dev/null 2>&1; then LOW="nice -n 15 ionice -c3"; else LOW="nice -n 15"; fi
        ;;
esac

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

# A time like 90m, 600s or 2h (plain: minutes), in seconds; $2 names the variable it came from.
# (Its number in base 10, whatever zeros lead it, and at most six digits.)
seconds_of() {
    case "$1" in
        *[!0-9smh]* | "" | [smh]* | *[smh]?*) ;;
        *)
            number=${1%[smh]}
            while [ "${number#0}" != "$number" ] && [ "${#number}" -gt 1 ]; do number=${number#0}; done
            if [ "${#number}" -le 6 ]; then
                case "$1" in *s) echo "$number" ;; *h) echo $((number * 3600)) ;; *) echo $((number * 60)) ;; esac
                return
            fi
            ;;
    esac
    echo "$2 is a time like 90m, 600s or 2h, or 0 for none (it's $1)." >&2
    exit 64
}
GIVEN_LIMIT="${KUVO_HEAVY_LIMIT:-$DEFAULT_LIMIT}"
LIMIT=$(seconds_of "$GIVEN_LIMIT" KUVO_HEAVY_LIMIT) || exit 64
# How long the Mac app's suite, waiting for room on the Mac, holds back new jobs of the
# other kinds (below).
GIVEN_MAC_FIRST="${KUVO_HEAVY_MAC_FIRST_FOR:-2m}"
MAC_FIRST_FOR=$(seconds_of "$GIVEN_MAC_FIRST" KUVO_HEAVY_MAC_FIRST_FOR) || exit 64
MAC_FIRST="$DIR/kuvo-code-heavy-mac-first-$(id -u)"
# Memory a new job waits for (below), if asked: the share of it available, in percent (unset: none,
# only swapping and critical pressure count; 0: it doesn't wait for memory at all).
MIN_FREE="${KUVO_HEAVY_MEMORY:-}"
case "$MIN_FREE" in
    "") ;;
    *[!0-9]* | ????*) MIN_FREE=bad ;;
esac
if [ "$MIN_FREE" = bad ] || [ "${MIN_FREE:-0}" -gt 100 ]; then
    echo "KUVO_HEAVY_MEMORY is a share of memory in percent, 0 to 100 (it's ${KUVO_HEAVY_MEMORY:-})." >&2
    exit 64
fi
# Swapping, in MB a second, that counts as short of memory too.
SWAP_MB="${KUVO_HEAVY_SWAP:-10}"
case "$SWAP_MB" in "" | *[!0-9]* | ???????*) echo "KUVO_HEAVY_SWAP is MB a second (it's $SWAP_MB)." >&2; exit 64 ;; esac
MEMORY_SHORT="$DIR/kuvo-code-heavy-memory-short-$(id -u)"
GIVEN_MEMORY_WAIT="${KUVO_HEAVY_MEMORY_WAIT_FOR:-2m}"
MEMORY_WAIT_FOR=$(seconds_of "$GIVEN_MEMORY_WAIT" KUVO_HEAVY_MEMORY_WAIT_FOR) || exit 64
# A job's place in its lane's queue: high goes before normal (0 sorts before 1).
case "${KUVO_HEAVY_PRIORITY:-normal}" in
    normal) PRIORITY=1 ;;
    high) PRIORITY=0 ;;
    *) echo "KUVO_HEAVY_PRIORITY is high or normal (it's $KUVO_HEAVY_PRIORITY)." >&2; exit 64 ;;
esac

# The lane's queue: a folder of its own (the phone's builds share mac-build's, as its slots).
#   <priority>-<number>-<pid>-<slots>  a job in line: 0 high, 1 normal; its number, in the order
#                     jobs came; its process; the slots it may take (2: either, 1: slot 1 only).
#                     It holds when the job last looked (each look, about once a second).
#   sequence          the last number given
#   claim-1, claim-2  the process a slot was just given to and when, until its `lockf` holds it
#   guard             the lock whoever reads or changes the queue holds, for milliseconds
QUEUE="$DIR/kuvo-code-heavy-$kind-$(id -u).queue"
# Whose turn it is, run under the guard ($1 the queue, $2 and $3 the slots' locks, $4 this job's
# entry or "new", $5 its priority, $6 its pid, $7 the slots it may take, $8 0 when it doesn't wait).
# A slot given to this job in the last 30 seconds (its last look was cut short) is its own still; a
# new job gets its entry (or finds the one it had, as it was). A job's look keeps its place; one
# that's gone, or hasn't looked for 30 seconds (stopped, or its pid now another process's), leaves
# the line, and comes back with its number when it looks again. A process is gone only when there's no such process: a
# sandbox may refuse to signal one that runs. A slot is free when its lock isn't held and no one has
# a claim on it (one older than 30 seconds, on a lock no one holds, is none). The free slots go to the
# jobs in line in order, each to the first that may take it; a job that may take either takes slot
# 1, or slot 2 when both are free and one that may take only slot 1 waits behind it. Prints "slot
# <n>" when one is this job's (its claim written, its entry gone), else "wait <entry>", or, told not
# to wait, "busy" (no slot it may take is free) or "ahead" (one is, for a job in line before it).
# shellcheck disable=SC2016 # (its own script: it expands its own arguments)
TURN='
queue=$1 lock1=$2 lock2=$3 ticket=$4 priority=$5 me=$6 slots=$7 waits=$8
export LC_ALL=C
cd "$queue" || exit 1
now=$(date +%s)
gone() {
    ! kill -0 "$1" 2>/dev/null && case "$(kill -0 "$1" 2>&1)" in *"No such process"*) true ;; *) false ;; esac
}
number() {
    num=$1
    case "$num" in "" | *[!0-9]*) num=0 ;; esac
    while [ "${num#0}" != "$num" ]; do num=${num#0}; done
    num=${num:-0}
}
for n in 1 2; do
    owner=
    since=
    [ ! -f "claim-$n" ] || read -r owner since < "claim-$n" || true
    [ "$owner" = "$me" ] || continue
    number "$since"
    if [ "$num" -gt 0 ] && [ $((now - num)) -le 30 ]; then
        for entry in [01]-*; do
            rest=${entry#?-}
            owner=${rest#*-}
            [ "${owner%-*}" != "$me" ] || rm -f "$entry"
        done
        echo "slot $n"
        exit 0
    fi
    rm -f "claim-$n"
done
last=0
[ ! -f sequence ] || read -r last < sequence || true
number "$last"
last=$num
for entry in [01]-*; do
    [ -f "$entry" ] || continue
    rest=${entry#?-}
    owner=${rest#*-}
    owner=${owner%-*}
    seen=
    read -r seen < "$entry" || true
    number "$seen"
    seen=$num
    if gone "$owner" || [ "$seen" = 0 ] || [ $((now - seen)) -gt 30 ]; then
        rm -f "$entry"
    elif [ "$ticket" = new ] && [ "$owner" = "$me" ] && [ "${entry%%-*}" = "$priority" ] && [ "${entry##*-}" = "$slots" ]; then
        ticket=$entry
    fi
    number "${rest%%-*}"
    [ "$num" -le "$last" ] || last=$num
done
if [ "$ticket" = new ]; then
    last=$((last + 1))
    echo "$last" > "sequence.$me" && mv -f "sequence.$me" sequence
    ticket=$(printf "%s-%012d-%s-%s" "$priority" "$last" "$me" "$slots")
fi
echo "$now" > "$ticket"
free=
for n in 1 2; do
    lock=$lock1
    [ "$n" = 1 ] || lock=$lock2
    [ -n "$lock" ] || continue
    if [ -f "claim-$n" ]; then
        owner=
        since=
        read -r owner since < "claim-$n" || true
        number "$since"
        since=$num
        if [ -n "$owner" ] && ! gone "$owner"; then
            [ $((now - since)) -gt 30 ] || continue
            lockf -ks -t 0 "$lock" true || continue
        fi
        rm -f "claim-$n"
    fi
    if lockf -ks -t 0 "$lock" true; then free=$free$n; fi
done
case "$slots:$free" in 2:?* | 1:*1*) open=1 ;; *) open= ;; esac
singles=0
for entry in [01]-*; do
    if [ -f "$entry" ] && [ "${entry##*-}" = 1 ]; then singles=$((singles + 1)); fi
done
mine=
for entry in [01]-*; do
    [ -n "$free" ] || break
    [ -f "$entry" ] || continue
    take=
    if [ "${entry##*-}" = 2 ]; then
        case "$free" in
            12) if [ "$singles" -gt 0 ]; then take=2; else take=1; fi ;;
            *) take=$free ;;
        esac
    else
        singles=$((singles - 1))
        case "$free" in *1*) take=1 ;; esac
    fi
    [ -n "$take" ] || continue
    case "$take" in 1) free=${free#1} ;; 2) free=${free%2} ;; esac
    if [ "$entry" = "$ticket" ]; then
        mine=$take
        break
    fi
done
if [ -n "$mine" ]; then
    echo "$me $now" > "claim-$mine"
    rm -f "$ticket"
    echo "slot $mine"
elif [ "$waits" = 0 ]; then
    rm -f "$ticket"
    if [ -n "$open" ]; then echo ahead; else echo busy; fi
else
    echo "wait $ticket"
fi
'

# The Mac busy: wait until it isn't.
load() { sysctl -n vm.loadavg | awk '{ print $2 }'; }
busy() { [ -n "$MAX_LOAD" ] && [ "$(load | awk -v max="$MAX_LOAD" '{ print ($1 > max) }')" = 1 ]; }

# The Mac app's suite first: while it waits for room on the Mac, phone, mac-build and box jobs that
# kept starting meanwhile kept the Mac busy, so it rarely got in. While it waits there (it says so in $MAC_FIRST: its pid and since when), a new job of another kind waits
# for it to start, for $MAC_FIRST_FOR at most. Jobs already running go on. A suite that's gone, or
# that started, says nothing; a job started inside one already running doesn't wait (it's part of
# that one); older copies of this helper neither say it nor wait for it.
mac_waits() {
    [ -f "$MAC_FIRST" ] || return 1
    read -r pid since < "$MAC_FIRST" 2>/dev/null || return 1
    [ -n "${pid:-}" ] && [ -n "${since:-}" ] && kill -0 "$pid" 2>/dev/null && [ $(($(date +%s) - since)) -lt "$MAC_FIRST_FOR" ]
}

# Short of memory: with two simulators, the app's suite, builds and the engine going, the Mac ran
# out of memory long before CPU (15 of 16 GB used, 9 GB swapped, the CPU half idle), and the load
# grew with the swapping. So a new job (not one started inside a job already running) also waits
# while the Mac thrashes, by what the system does and says: it's swapping (pages in and out, more
# than $SWAP_MB MB a second since the last look, from vm_stat) or its memory pressure is critical
# (kern.memorystatus_vm_pressure_level), and, when KUVO_HEAVY_MEMORY asks, while less than
# $MIN_FREE% of it is available (kern.memorystatus_level, what `memory_pressure -Q` calls free; with
# 16 GB and a dozen sessions it's below 20% all day, so it isn't asked unless set). Not swap used:
# it stays long after the pressure is gone. Short, it waits until two looks in a row find it isn't,
# so the jobs that waited don't all start at once, and for $MEMORY_WAIT_FOR at most from when any
# job found it short ($MEMORY_SHORT): then the load alone decides (when it's asked to).
memory_level() { sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null || echo 1; }
memory_free() { sysctl -n kern.memorystatus_level 2>/dev/null || echo 100; }
page_size=$(vm_stat 2>/dev/null | sed -n 's/.*page size of \([0-9]*\) bytes.*/\1/p')
page_size=${page_size:-16384}
# Pages swapped in and out so far.
swapped() { vm_stat 2>/dev/null | awk '/^Swapins/ { gsub("\\.", "", $2); n += $2 } /^Swapouts/ { gsub("\\.", "", $2); n += $2 } END { print n + 0 }'; }
swap_pages=
swap_at=
swap_rate=0
# Looks again: how much it swapped a second since the last look (the first, over three seconds).
look_at_memory() {
    if [ -z "$swap_pages" ]; then
        swap_pages=$(swapped)
        swap_at=$(date +%s)
        sleep 3
    fi
    pages=$(swapped)
    at=$(date +%s)
    seconds=$((at - swap_at))
    [ "$seconds" -gt 0 ] || seconds=1
    swap_rate=$(((pages - swap_pages) * page_size / 1000000 / seconds))
    swap_pages=$pages
    swap_at=$at
}
memory_short() {
    [ "$swap_rate" -gt "$SWAP_MB" ] || [ "$(memory_level)" -ge 4 ] || { [ -n "$MIN_FREE" ] && [ "$(memory_free)" -lt "$MIN_FREE" ]; }
}
memory_said() {
    case "$(memory_level)" in 1) pressure=normal ;; 2) pressure=warn ;; 4) pressure=critical ;; *) pressure="level $(memory_level)" ;; esac
    echo "swapping ${swap_rate} MB a second, pressure $pressure, $(memory_free)% available"
}
# How long memory has been short, for any job: since the first that found it so.
short_for() {
    since=
    [ -f "$MEMORY_SHORT" ] && read -r since < "$MEMORY_SHORT" 2>/dev/null
    if [ -z "${since:-}" ]; then
        since=$(date +%s)
        printf '%s\n' "$since" > "$MEMORY_SHORT.$$" && mv -f "$MEMORY_SHORT.$$" "$MEMORY_SHORT"
    fi
    echo $(($(date +%s) - since))
}
# Why it waits now, if it does (in `why`): memory, or the load.
was_short=
calm=0
decide() {
    why=
    if [ "${MIN_FREE:-1}" -gt 0 ] && [ -z "${NESTED:-}" ]; then
        look_at_memory
        if memory_short; then
            calm=0
            was_short=1
            [ "$(short_for)" -lt "$MEMORY_WAIT_FOR" ] && why=memory && return
        elif [ -n "$was_short" ] && [ "$calm" -lt 1 ]; then
            # (Once more, so it's not a moment's calm.)
            calm=$((calm + 1))
            why=memory
            return
        else
            rm -f "$MEMORY_SHORT"
        fi
    fi
    if busy; then why=load; fi
}

# Waits until there's room for a new job: called before it queues for its lane, never while it
# holds a lane's lock, so a job waiting here holds up no one behind it in its lane.
wait_for_room() {
    if [ "$kind" != mac ] && [ -z "${NESTED:-}" ]; then
        said=
        while mac_waits; do
            [ "$WAITS" = 0 ] && cannot_wait "The Mac app's suite is waiting for the Mac to be less busy, and goes first."
            [ -n "$said" ] || echo "Waiting for the Mac app's suite to start first: it's waiting for the Mac to be less busy (for $GIVEN_MAC_FIRST at most)…" >&2
            said=1
            sleep 5
        done
    fi
    said=
    decide
    if [ "$kind" = mac ] && [ -n "$why" ] && [ "$WAITS" != 0 ]; then
        printf '%s %s\n' "$$" "$(date +%s)" > "$MAC_FIRST.$$" && mv -f "$MAC_FIRST.$$" "$MAC_FIRST"
    fi
    while [ -n "$why" ]; do
        if [ "$why" = memory ]; then
            [ "$WAITS" = 0 ] && cannot_wait "The Mac is short of memory ($(memory_said))."
            [ "$said" = memory ] || echo "Waiting for memory: the Mac is short of it ($(memory_said)), for $GIVEN_MEMORY_WAIT at most…" >&2
        else
            [ "$WAITS" = 0 ] && cannot_wait "The Mac is busy (load $(load), over $MAX_LOAD)."
            [ "$said" = load ] || echo "Waiting while the Mac is busy (load $(load), over $MAX_LOAD)…" >&2
        fi
        said=$why
        sleep 15
        decide
    done
    # (Its own say, not another suite's since.)
    if [ "$kind" = mac ] && [ -f "$MAC_FIRST" ] && read -r pid since < "$MAC_FIRST" 2>/dev/null && [ "$pid" = "$$" ]; then
        rm -f "$MAC_FIRST"
    fi
}


# Started inside another heavy job (of another kind: one of its own kind runs at once, below),
# which says so in KUVO_HEAVY_HELD while it runs: a part of a job already running.
NESTED=
for claim in ${KUVO_HEAVY_HELD:-}; do kill -0 "${claim##*:}" 2>/dev/null && NESTED=1; done

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
    # Its turn, just taken (below). Its claim on the slot is over: the slot's lock holds it now.
    # (Nothing else claims a slot whose lock is held, so this reads and removes it safely.)
    claim="$QUEUE/claim-1"
    [ "$TAKEN" = "$LOCK" ] || claim="$QUEUE/claim-2"
    if [ -f "$claim" ] && read -r owner since < "$claim" 2>/dev/null && [ "$owner" = "$PPID" ]; then
        rm -f "$claim"
    fi
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
        exec $LOW "$@"
    fi
    # Room on the Mac first, while it holds nothing.
    wait_for_room
    # Its kind's turn, through the lane's queue (TURN, above): in line until a slot is its own,
    # then that slot's lock, which it holds as it runs.
    ticket=new
    trap 'rm -f "$QUEUE/$ticket"; exit 129' HUP
    trap 'rm -f "$QUEUE/$ticket"; exit 130' INT
    trap 'rm -f "$QUEUE/$ticket"; exit 143' TERM
    said=
    failed=0
    while :; do
        mkdir -p "$QUEUE" 2>/dev/null || true
        # Told not to wait, it doesn't wait for the guard either, past a moment (its holders only
        # look at files, for milliseconds; lockf says 75 when its time is up).
        looked=0
        if [ "$WAITS" = 0 ]; then
            turn=$(lockf -k -t 2 "$QUEUE/guard" /bin/sh -c "$TURN" sh "$QUEUE" "$LOCK" "$LOCK2" "$ticket" "$PRIORITY" "$$" "$SLOTS" 0) || looked=$?
        else
            turn=$(lockf -k "$QUEUE/guard" /bin/sh -c "$TURN" sh "$QUEUE" "$LOCK" "$LOCK2" "$ticket" "$PRIORITY" "$$" "$SLOTS" 1) || looked=$?
        fi
        case "$turn" in
            "slot "*)
                slot=$LOCK
                [ "$turn" = "slot 1" ] || slot=$LOCK2
                # Its claim keeps every other queued job off the slot until this `lockf` holds it.
                # Only a caller outside the queue (an older script's plain `lockf`) can take it
                # meanwhile: then this one waits for it, or, told not to wait, exits 75.
                if [ "$WAITS" = 0 ]; then
                    KUVO_HEAVY_HOLDING="$slot:$$" exec lockf -k -t 0 "$slot" /bin/sh "$0" "$kind" "$@"
                fi
                KUVO_HEAVY_HOLDING="$slot:$$" exec lockf -k "$slot" /bin/sh "$0" "$kind" "$@"
                ;;
            "wait "*) ticket=${turn#wait } ;;
            busy)
                [ "$SLOTS" = 2 ] && cannot_wait "Another $kind job is running in each of its two slots."
                cannot_wait "Another $kind job is running."
                ;;
            ahead) cannot_wait "Another $kind job is waiting for its turn ahead of this one." ;;
            *)
                [ "$WAITS" = 0 ] && [ "$looked" = 75 ] && cannot_wait "Another $kind job is taking its turn (its queue is busy)."
                [ "$WAITS" = 0 ] && cannot_wait "heavy.sh can't read the $kind queue ($QUEUE)."
                failed=$((failed + 1))
                [ "$failed" != 10 ] || echo "heavy.sh: can't read the $kind queue ($QUEUE); still trying…" >&2
                ;;
        esac
        [ "$turn" = "" ] || failed=0
        [ -n "$said" ] || echo "Waiting for another $kind job to finish…" >&2
        said=1
        sleep 1
    done
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
# Past its time limit (the watcher, below, says so).
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
    [ -n "${old_way:-}" ] && exec lockf -k "$OLD" $LOW "$@"
    exec $LOW "$@"
fi

trap 'stopped HUP 129' HUP
trap 'stopped INT 130' INT
trap 'stopped TERM 143' TERM
# (The command as it was given, for what over_time says.)
command_line=$*
trap 'over_time "$command_line"' USR1
set -m
if [ -n "${old_way:-}" ]; then
    lockf -k "$OLD" $LOW "$@" &
else
    $LOW "$@" &
fi
group=$!
# `lockf` doesn't pass a signal on to its command, and lets go of the lock as it ends: this helper
# (the job's `lockf` is its parent) being stopped, even killed, would leave the job running. A
# watcher of its own, in a group of its own too, notices when the parent is gone, stops this shell
# if it's still there, and then the job's group itself if nothing else has: this shell may have been
# killed, and a helper above it may have stopped it before it was done.
parent=$PPID
me=$$
# The watcher keeps its time limit too: once it's up, it tells this shell (USR1), only while the
# parent still runs, so never a process that took a pid since.
(
    ticks=$((LIMIT * 5))
    while kill -0 "$parent" 2>/dev/null; do
        if [ "$LIMIT" -gt 0 ] && [ "$ticks" -ge 0 ]; then
            [ "$ticks" -gt 0 ] || kill -s USR1 "$me" 2>/dev/null || true
            ticks=$((ticks - 1))
        fi
        sleep 0.2
    done
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
# (Over, by itself: the limit no longer counts.)
trap '' USR1
end_group TERM
end_watch
exit "$status"

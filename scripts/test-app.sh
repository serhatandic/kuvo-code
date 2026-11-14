#!/bin/sh
# Runs the app's tests (KuvoCodeTests): scenarios run on the app's own code, hosted by a copy of
# the app that starts nothing (no window, engine or menu bar item) and keeps everything in the
# temporary folder.
#   ONLY   suites or tests to run alone, separated by spaces, e.g. KuvoCodeTests/ChangesDiscardTests
#   --from-batch   runs them from the newest batch (scripts/batch-build.sh: main, built once at
#          04:00 and 16:00 for every session's runs) without building anything: ONLY is a must, and
#          a name the batch hasn't (merged after it was built) is refused before it waits in line.
#          While a batch is being built, it waits for it and tests that one; when the newest build
#          failed, it refuses, saying why. It says which batch it tested (its stamp). The same test
#          copy, settings and checks as a run that builds.
#
# It ends with what the run's result bundle counts, on a line of its own, then each failing test:
#   RESULT: <passed> passed, <failed> failed[, <skipped> skipped]
#     <failing test>
# Tests as Swift Testing counts them: a test with arguments is one, failed if any of its cases
# failed. `RESULT: no results, …` when none ran or there's nothing to read (a build that failed, a
# run stopped before it was over). It exits 0 only when xcodebuild says every test passed, at least
# one ran and none failed: after a test that crashed or ran out of time, the test copy starts again
# and its last "Test run … passed" counts only itself.
#
# The test copy is built outside the checkout: a copy of the app loading its code from Desktop or
# Documents would wait on a privacy prompt nobody can answer while tests run. It has a bundle ID
# of its own, so it never shares the app's settings or keychain items.
set -eu
CALLER=$PWD
cd "$(dirname "$0")/.."

# --from-batch, as given; --batch <folder> <pid>, as it runs: the batch it opened for that run.
FROM_BATCH=
BATCH=
BATCH_RUN=
case "${1:-}" in
    "") ;;
    --from-batch) [ $# -eq 1 ] && FROM_BATCH=1 ;;
    --batch) [ $# -eq 3 ] && BATCH=$2 && BATCH_RUN=$3 ;;
esac
if [ $# -gt 0 ] && [ -z "$FROM_BATCH$BATCH" ]; then
    echo "Usage: [ONLY=…] scripts/test-app.sh [--from-batch]" >&2
    exit 64
fi

check_console() {
    user=$(id -un)
    case "$1" in
        root|'') echo "No one is logged in at this Mac's screen; log in as $user before running app tests." >&2 ;;
        "$user") return 0 ;;
        *) echo "The screen is on $1's session; switch the Mac's screen to $user's account before running app tests." >&2 ;;
    esac
    return 1
}
check_console "$(stat -f %Su /dev/console 2>/dev/null || true)"

# From a batch: the newest, kept open for this run (this process, which lives until the run is
# over: heavy.sh and lockf take its place), and only if it has every test asked for.
if [ -n "$FROM_BATCH" ]; then
    if [ -z "${ONLY:-}" ]; then
        echo "scripts/test-app.sh --from-batch runs only what ONLY names (ONLY=KuvoCodeTests/WindowTabsTests …)." >&2
        exit 64
    fi
    BATCH=$(/bin/sh scripts/batch.sh open mac $$)
    BATCH_RUN=$$
    # shellcheck disable=SC2086 # (ONLY's names, one by one)
    if ! /bin/sh scripts/batch.sh check "$BATCH" kuvo-ai $ONLY; then
        /bin/sh scripts/batch.sh close "$BATCH" $$
        exit 1
    fi
    /bin/sh scripts/batch.sh behind "$BATCH" kuvo-ai "$CALLER" || true
    echo "Testing from the $(/bin/sh scripts/batch.sh describe "$BATCH")." >&2
    set -- --batch "$BATCH" $$
fi

# A heavy job of the Mac's (scripts/heavy.sh, kind mac: the one app suite that drives the UI, which
# runs alone; builds and package tests are mac-build and run beside it). It waits for a busy Mac,
# unless whoever started it took that turn already.
# Taken with the canonical heavy.sh (kuvo-ai's in ~/Projects, which runs every job; KUVO_HEAVY_SH for
# another), or this checkout's when there's none.
HEAVY="${KUVO_HEAVY_SH:-}"
if [ -z "$HEAVY" ]; then
    HEAVY="${KUVO_HEAVY_CANONICAL-$HOME/Projects/kuvo-ai/scripts/heavy.sh}"
    [ -n "$HEAVY" ] && [ -f "$HEAVY" ] || HEAVY=scripts/heavy.sh
fi
if ! /bin/sh "$HEAVY" --holds mac; then
    exec /bin/sh "$HEAVY" mac /bin/sh "$PWD/scripts/test-app.sh" "$@"
fi

# One run at a time, whoever starts it: every run shares the test copy's settings and caches in
# ~/Library and its folders in the temporary folder, and cleans them before and after. So each
# run waits for the one before it, on a lock in this user's own temporary folder (getconf's, not
# $TMPDIR, which a caller may point elsewhere while ~/Library stays the same).
LOCK="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || echo /tmp/)kuvo-code-tests-$(id -u).lock"
if [ "${KUVO_TESTS_LOCK:-}" != "$LOCK" ]; then
    lockf -ks -t 0 "$LOCK" true || echo "Waiting for another run of the app's tests to finish…" >&2
    KUVO_TESTS_LOCK="$LOCK" exec lockf -ks "$LOCK" /bin/sh "$PWD/scripts/test-app.sh" "$@"
fi
# And it is held: one that only says so in the environment can't get in.
if lockf -ks -t 0 "$LOCK" true; then
    echo "scripts/test-app.sh runs only while it holds $LOCK." >&2
    exit 1
fi

# The checks of the sources below look at the batch's, from a batch: the sources it exported and
# built (its stamp's kuvo_ai_src; a stamp from before it said so, its src/kuvo-ai).
SOURCES=.
if [ -n "$BATCH" ]; then
    SOURCES=$(sed -n 's/^kuvo_ai_src=//p' "$BATCH/stamp" | head -n 1)
    [ -n "$SOURCES" ] || SOURCES="$BATCH/src/kuvo-ai"
fi
cd "$SOURCES"
# And the tests that read the sources themselves (KuvoCodeTests/Support/SourceRoot.swift) find them
# there: passed as KUVO_SOURCE_ROOT (xcodebuild hands TEST_RUNNER_ variables on).
TEST_RUNNER_KUVO_SOURCE_ROOT=$(pwd)
export TEST_RUNNER_KUVO_SOURCE_ROOT

# The app reaches the Keychain only through `Keychain` (KuvoCode/Stores/Keychain.swift), which is
# one in memory for the tests: a test reaching the real one would wait on macOS asking whether
# this copy, signed anew with each build, may use what an earlier build kept.
if grep -rnE '\bSec(Item(CopyMatching|Add|Update|Delete)|Keychain[A-Za-z]*)\(' --include='*.swift' KuvoCode | grep -v '^KuvoCode/Stores/Keychain.swift:'; then
    echo "The Keychain is reached through Keychain (KuvoCode/Stores/Keychain.swift), never directly: the tests would wait on macOS asking you." >&2
    exit 1
fi

# Built with Xcode's compilation cache (scripts/xcode-cache.sh), the compiler sees the sources as
# /^src/…, and so does #filePath: a test finds its files through its bundle, or the sources through
# KUVO_SOURCE_ROOT (KuvoCodeTests/Support/SourceRoot.swift), never #filePath, which names no file on
# this Mac. (As where an issue was recorded, `file: … = #filePath`, it's only said.)
if grep -rn '#filePath' --include='*.swift' KuvoCode KuvoCodeTests | grep -v '= #filePath'; then
    echo "The app and its tests find their files through their bundles (and the sources through KuvoCodeTests/Support/SourceRoot.swift), never #filePath: built with the compilation cache, it's /^src/…, no file on this Mac." >&2
    exit 1
fi
cd - >/dev/null

TEMP="${TMPDIR:-/tmp}"
# Built in this user's cache folder, kept from run to run: macOS clears files the temporary folder
# hasn't used for a few days, which left builds there missing parts of their packages.
CACHE="$(getconf DARWIN_USER_CACHE_DIR 2>/dev/null || echo "$TEMP/")"
BUILD="${CACHE%/}/KuvoCodeTests-build"
BUNDLE=run.kuvo.code.tests
if [ -n "$BATCH" ]; then
    # From the batch's build, as it was built (scripts/batch-build.sh: these settings): its log and
    # results in a folder of their own, beside KuvoCodeTests-build.
    BUILD="${CACHE%/}/KuvoCodeTests-batch"
    XCTESTRUN=$(sed -n 's/^xctestrun=//p' "$BATCH/stamp")
    PRODUCTS=$(dirname "$XCTESTRUN")
    if [ "$(plutil -extract KuvoCodeTests.TestHostBundleIdentifier raw -o - "$XCTESTRUN" 2>/dev/null)" != "$BUNDLE" ]; then
        echo "The batch's tests aren't hosted by the test copy ($BUNDLE): $XCTESTRUN" >&2
        exit 1
    fi
    set -- test-without-building -xctestrun "$XCTESTRUN" -destination "platform=macOS,arch=$(uname -m)" -derivedDataPath "$BUILD"
    # (Only this run's results: they'd pile up there otherwise.)
    rm -rf "$BUILD/Logs" "$BUILD/TestResults"
else
    PRODUCTS="$BUILD/Build/Products"
    # Xcode's compilation cache, one for every checkout (scripts/xcode-cache.sh; heavy.sh turns it on
    # already, this for a heavy.sh from before it): what another worktree compiled isn't compiled again.
    . scripts/xcode-cache.sh
    xcode_cache scripts
    set -- test -project KuvoCode.xcodeproj -scheme KuvoCode -destination "platform=macOS,arch=$(uname -m)" \
        -derivedDataPath "$BUILD" -clonedSourcePackagesDirPath build/SourcePackages \
        APP_BUNDLE_ID=$BUNDLE CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM=
fi
for only in ${ONLY:-}; do set -- "$@" -only-testing:"$only"; done
# This run's result bundle, which its RESULT line counts (only this run's: none left from the last).
RESULTS="$BUILD/Results.xcresult"
rm -rf "$RESULTS"
set -- "$@" -resultBundlePath "$RESULTS"

# The Bun that runs the agents bridge the app ships, for the tests that run it for real: a `bun` on
# PATH (not one in the Desktop or Documents, whose privacy prompt hangs the test copy), else
# ~/.bun/bin/bun, else the engine a demo, perf or e2e copy installed (Bun, as the app runs it), never
# the real Kuvo Code's. Passed to the tests as KUVO_TEST_BUN (xcodebuild hands TEST_RUNNER_ variables on).
. scripts/real-app-guard.sh
if [ -z "${KUVO_TEST_BUN:-}" ]; then
    KUVO_TEST_BUN=$(pick_test_bun || true)
fi
export TEST_RUNNER_KUVO_TEST_BUN="${KUVO_TEST_BUN:-}"

# Never the real app's bundle ID, folders or engine, nor a Bun in the Desktop or Documents.
real_app_guard "scripts/test-app.sh" "$BUNDLE" "$KUVO_TEST_BUN"
desktop_guard "scripts/test-app.sh" "$KUVO_TEST_BUN"
# (And a batch there: the test copy would wait on the same prompt.)
case "$(printf '%s' "$PRODUCTS" | tr '[:upper:]' '[:lower:]')" in
    "$(printf '%s' "$HOME" | tr '[:upper:]' '[:lower:]')"/desktop/* | "$(printf '%s' "$HOME" | tr '[:upper:]' '[:lower:]')"/documents/*)
        echo "scripts/test-app.sh: refusing to start, because the test copy at $PRODUCTS is in your Desktop or Documents folder." >&2
        exit 1
        ;;
esac

# What the test copy keeps under its own bundle ID (settings, caches, website data): gone before
# a run, so each starts clean, and after it.
clean() {
    for plist in "$HOME"/Library/Preferences/run.kuvo.code.tests*.plist; do
        [ -e "$plist" ] || continue
        defaults delete "$(basename "$plist" .plist)" >/dev/null 2>&1 || true
        rm -f "$plist"
    done
    for folder in Caches HTTPStorages WebKit; do rm -rf "$HOME/Library/$folder/run.kuvo.code.tests"; done
    rm -rf "${TEMP%/}/KuvoCodeTests"
    # And its temporary folder (the engine's scratch files, its agents bridge's). WebKit's
    # processes keep folders of their own there too, which macOS looks after.
    rm -rf "${TEMP%/}/run.kuvo.code.tests"
}
clean

# Snapshot only the test executable, never the installed app. The lock excludes other runs.
HOST="$PRODUCTS/Debug/Kuvo Code.app/Contents/MacOS/Kuvo Code"
host_pids() {
    ps -axo pid=,comm= | awk -v host="$HOST" 'index($0, host) && substr($0, index($0, host)) == host { print $1 }'
}
hosts_before=$(host_pids | tr '\n' ' ')
caffeinate -d -u -w $$ &
caffeinate_pid=$!
xcode_pid=
finished=0
stop_new_hosts() {
    for pid in $(host_pids); do
        case " $hosts_before " in *" $pid "*) continue ;; esac
        kill "$pid" 2>/dev/null || true
    done
}
cleanup_run() {
    code=$?
    set +e
    trap - EXIT
    trap '' HUP INT TERM
    if [ -n "$xcode_pid" ]; then
        kill "$xcode_pid" 2>/dev/null || true
    fi
    if [ "$finished" -eq 0 ] || [ "$code" -ne 0 ]; then
        stop_new_hosts
    fi
    # Do not wait indefinitely: heavy.sh sends KILL to the job group after about three seconds.
    if [ -n "$xcode_pid" ]; then
        tries=0
        while kill -0 "$xcode_pid" 2>/dev/null && [ "$tries" -lt 10 ]; do
            sleep 0.1
            tries=$((tries + 1))
        done
        if ! kill -0 "$xcode_pid" 2>/dev/null; then wait "$xcode_pid" 2>/dev/null; fi
    fi
    if [ "$finished" -eq 0 ] || [ "$code" -ne 0 ]; then
        stop_new_hosts
    fi
    # Stopped before it was over (heavy.sh's time limit, a caller): where to look for what it was on.
    if [ "$finished" -eq 0 ] && [ -n "$xcode_pid" ]; then echo "Stopped before the tests were over. The whole log: $BUILD/test.log" >&2; fi
    # And its RESULT line, which a run that's over ends with.
    if [ "$finished" -eq 0 ]; then echo "RESULT: no results, stopped before the tests were over (exit $code)"; fi
    kill "$caffeinate_pid" 2>/dev/null || true
    wait "$caffeinate_pid" 2>/dev/null || true
    clean
    [ -z "$BATCH" ] || /bin/sh scripts/batch.sh close "$BATCH" "$BATCH_RUN"
    exit "$code"
}
trap cleanup_run EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# The whole log in the build folder; here, each test's result, and what went wrong.
# What belongs to the account whatever a test's $HOME says: a run that changes it fails.
account_state() {
    crontab -l 2>/dev/null || true
    if launchctl print "gui/$(id -u)/run.kuvo.code.machine" >/dev/null 2>&1; then echo "login agent loaded"; fi
    if [ -e "$HOME/Library/LaunchAgents/run.kuvo.code.machine.plist" ]; then echo "login agent file"; fi
}

mkdir -p "$BUILD"
status=0
account_before=$(account_state)
xcodebuild "$@" > "$BUILD/test.log" 2>&1 &
xcode_pid=$!
wait "$xcode_pid" || status=$?
xcode_pid=
xcode_status=$status
if [ "$(account_state)" != "$account_before" ]; then
    echo "This run changed your real crontab or login agent. Before:" >&2
    printf '%s\n' "$account_before" >&2
    status=1
fi
grep -aE '(✔|✘|􀢄|􁁛).*(Test|Suite)|issue|error:|Restarting after|\*\* TEST' "$BUILD/test.log" | grep -v 'warning:\|\[Connection\]' || true

# What the result bundle counts, over every launch of the test copy (RESULT, at the end).
SUMMARY="$BUILD/results.json"
rm -f "$SUMMARY"
counted() { plutil -extract "$1" raw -o - "$SUMMARY" 2>/dev/null || true; }
passed= failed= skipped= failures= total=
if [ -d "$RESULTS" ] && xcrun xcresulttool get test-results summary --path "$RESULTS" > "$SUMMARY" 2>/dev/null; then
    passed=$(counted passedTests)
    failed=$(counted failedTests)
    skipped=$(counted skippedTests)
    failures=$(counted testFailures)
    total=$(counted totalTestCount)
fi
for number in "$passed" "$failed" "$skipped" "$failures" "$total"; do
    case "$number" in "" | *[!0-9]*) passed= ;; esac
done
# None to count: a build that failed, a test copy that never started, or names that match nothing
# (which xcodebuild counts as passing).
if [ -z "$passed" ] || [ "$total" -eq 0 ]; then
    result="RESULT: no results, xcodebuild exited $xcode_status"
    if [ "$xcode_status" -eq 0 ] && [ -n "$passed" ]; then echo "No tests ran${ONLY:+ for $ONLY}." >&2; fi
    [ $status -ne 0 ] || status=1
else
    result="RESULT: $passed passed, $failed failed"
    [ "$skipped" -eq 0 ] || result="$result, $skipped skipped"
    [ "$failed" -eq 0 ] || [ $status -ne 0 ] || status=1
    if [ "$xcode_status" -ne 0 ] && [ "$failed" -eq 0 ]; then
        echo "xcodebuild exited $xcode_status though no test failed (a crash between tests, or before they ran?)." >&2
    fi
fi
[ -z "$BATCH" ] || echo "Tested the $(/bin/sh scripts/batch.sh stamp "$BATCH")"
if [ $status -ne 0 ]; then echo "The whole log: $BUILD/test.log" >&2; fi
# Last: the counts, and each failing test once (a test failing in several ways is listed once).
echo "$result"
i=0
while [ "$i" -lt "${failures:-0}" ]; do
    plutil -extract "testFailures.$i.testIdentifierString" raw -o - "$SUMMARY" 2>/dev/null || true
    i=$((i + 1))
done | awk 'NF && !seen[$0]++ { print "  " $0 }'
rm -f "$SUMMARY"
finished=1
exit $status

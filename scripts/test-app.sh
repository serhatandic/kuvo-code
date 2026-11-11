#!/bin/sh
# Runs the app's tests (KuvoCodeTests): scenarios run on the app's own code, hosted by a copy of
# the app that starts nothing (no window, engine or menu bar item) and keeps everything in the
# temporary folder.
#   ONLY   suites or tests to run alone, separated by spaces, e.g. KuvoCodeTests/ChangesDiscardTests
#
# The test copy is built outside the checkout: a copy of the app loading its code from Desktop or
# Documents would wait on a privacy prompt nobody can answer while tests run. It has a bundle ID
# of its own, so it never shares the app's settings or keychain items.
set -eu
cd "$(dirname "$0")/.."

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
    exec /bin/sh "$HEAVY" mac /bin/sh "$PWD/scripts/test-app.sh"
fi

# One run at a time, whoever starts it: every run shares the test copy's settings and caches in
# ~/Library and its folders in the temporary folder, and cleans them before and after. So each
# run waits for the one before it, on a lock in this user's own temporary folder (getconf's, not
# $TMPDIR, which a caller may point elsewhere while ~/Library stays the same).
LOCK="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || echo /tmp/)kuvo-code-tests-$(id -u).lock"
if [ "${KUVO_TESTS_LOCK:-}" != "$LOCK" ]; then
    lockf -ks -t 0 "$LOCK" true || echo "Waiting for another run of the app's tests to finish…" >&2
    KUVO_TESTS_LOCK="$LOCK" exec lockf -ks "$LOCK" /bin/sh "$PWD/scripts/test-app.sh"
fi
# And it is held: one that only says so in the environment can't get in.
if lockf -ks -t 0 "$LOCK" true; then
    echo "scripts/test-app.sh runs only while it holds $LOCK." >&2
    exit 1
fi

# The app reaches the Keychain only through `Keychain` (KuvoCode/Stores/Keychain.swift), which is
# one in memory for the tests: a test reaching the real one would wait on macOS asking whether
# this copy, signed anew with each build, may use what an earlier build kept.
if grep -rnE '\bSec(Item(CopyMatching|Add|Update|Delete)|Keychain[A-Za-z]*)\(' --include='*.swift' KuvoCode | grep -v '^KuvoCode/Stores/Keychain.swift:'; then
    echo "The Keychain is reached through Keychain (KuvoCode/Stores/Keychain.swift), never directly: the tests would wait on macOS asking you." >&2
    exit 1
fi

# Built with Xcode's compilation cache (scripts/xcode-cache.sh), the compiler sees the sources as
# /^src/…, and so does #filePath: a test finds its files through its bundle, never #filePath, which
# names no file on this Mac. (As where an issue was recorded, `file: … = #filePath`, it's only said.)
if grep -rn '#filePath' --include='*.swift' KuvoCode KuvoCodeTests | grep -v '= #filePath'; then
    echo "The app and its tests find their files through their bundles, never #filePath: built with the compilation cache, it's /^src/…, no file on this Mac." >&2
    exit 1
fi

TEMP="${TMPDIR:-/tmp}"
# Built in this user's cache folder, kept from run to run: macOS clears files the temporary folder
# hasn't used for a few days, which left builds there missing parts of their packages.
CACHE="$(getconf DARWIN_USER_CACHE_DIR 2>/dev/null || echo "$TEMP/")"
BUILD="${CACHE%/}/KuvoCodeTests-build"
BUNDLE=run.kuvo.code.tests
# Xcode's compilation cache, one for every checkout (scripts/xcode-cache.sh; heavy.sh turns it on
# already, this for a heavy.sh from before it): what another worktree compiled isn't compiled again.
. scripts/xcode-cache.sh
xcode_cache scripts
set -- -project KuvoCode.xcodeproj -scheme KuvoCode -destination "platform=macOS,arch=$(uname -m)" \
    -derivedDataPath "$BUILD" -clonedSourcePackagesDirPath build/SourcePackages \
    APP_BUNDLE_ID=$BUNDLE CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM=
for only in ${ONLY:-}; do set -- "$@" -only-testing:"$only"; done

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
HOST="$BUILD/Build/Products/Debug/Kuvo Code.app/Contents/MacOS/Kuvo Code"
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
    result=$?
    set +e
    trap - EXIT
    trap '' HUP INT TERM
    if [ -n "$xcode_pid" ]; then
        kill "$xcode_pid" 2>/dev/null || true
    fi
    if [ "$finished" -eq 0 ] || [ "$result" -ne 0 ]; then
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
    if [ "$finished" -eq 0 ] || [ "$result" -ne 0 ]; then
        stop_new_hosts
    fi
    # Stopped before it was over (heavy.sh's time limit, a caller): where to look for what it was on.
    if [ "$finished" -eq 0 ] && [ -n "$xcode_pid" ]; then echo "Stopped before the tests were over. The whole log: $BUILD/test.log" >&2; fi
    kill "$caffeinate_pid" 2>/dev/null || true
    wait "$caffeinate_pid" 2>/dev/null || true
    clean
    exit "$result"
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
xcodebuild test "$@" > "$BUILD/test.log" 2>&1 &
xcode_pid=$!
wait "$xcode_pid" || status=$?
xcode_pid=
if [ "$(account_state)" != "$account_before" ]; then
    echo "This run changed your real crontab or login agent. Before:" >&2
    printf '%s\n' "$account_before" >&2
    status=1
fi
grep -aE '(✔|✘|􀢄|􁁛).*(Test|Suite)|issue|error:|\*\* TEST' "$BUILD/test.log" | grep -v 'warning:\|\[Connection\]' || true
if [ $status -ne 0 ]; then echo "The whole log: $BUILD/test.log" >&2; fi
finished=1
exit $status

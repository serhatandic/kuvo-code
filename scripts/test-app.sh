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

# A heavy job of the Mac's (scripts/heavy.sh): it builds in KuvoCodeTests-build, so it waits for
# the Mac's other builds, and for a busy Mac, unless whoever started it took that turn already.
if ! scripts/heavy.sh --holds mac; then
    exec scripts/heavy.sh mac /bin/sh "$PWD/scripts/test-app.sh"
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

TEMP="${TMPDIR:-/tmp}"
# Built in this user's cache folder, kept from run to run: macOS clears files the temporary folder
# hasn't used for a few days, which left builds there missing parts of their packages.
CACHE="$(getconf DARWIN_USER_CACHE_DIR 2>/dev/null || echo "$TEMP/")"
BUILD="${CACHE%/}/KuvoCodeTests-build"
BUNDLE=run.kuvo.code.tests
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

# The whole log in the build folder; here, each test's result, and what went wrong.
# What belongs to the account whatever a test's $HOME says: a run that changes it fails.
account_state() {
    crontab -l 2>/dev/null
    launchctl print "gui/$(id -u)/run.kuvo.code.machine" >/dev/null 2>&1; echo "login agent loaded: $?"
    [ -e "$HOME/Library/LaunchAgents/run.kuvo.code.machine.plist" ]; echo "login agent file: $?"
}

mkdir -p "$BUILD"
status=0
account_before=$(account_state)
xcodebuild test "$@" > "$BUILD/test.log" 2>&1 || status=$?
if [ "$(account_state)" != "$account_before" ]; then
    echo "This run changed your real crontab or login agent. Before:" >&2
    printf '%s\n' "$account_before" >&2
    status=1
fi
grep -aE '(✔|✘|􀢄|􁁛).*(Test|Suite)|issue|error:|\*\* TEST' "$BUILD/test.log" | grep -v 'warning:\|\[Connection\]' || true
if [ $status -ne 0 ]; then echo "The whole log: $BUILD/test.log" >&2; fi
# What the tests left: their data, Trash and repositories, and the test copy's own.
clean
exit $status

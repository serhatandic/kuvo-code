#!/bin/sh
# Runs the app's tests (KuvoCodeTests): scenarios run on the app's own code, hosted by a copy of
# the app that starts nothing (no window, engine or menu bar item) and keeps everything in the
# temporary folder.
#   ONLY   a suite or test to run alone, e.g. KuvoCodeTests/ChangesDiscardTests
#
# The test copy is built outside the checkout: a copy of the app loading its code from Desktop or
# Documents would wait on a privacy prompt nobody can answer while tests run. It has a bundle ID
# of its own, so it never shares the app's settings or keychain items.
set -eu
cd "$(dirname "$0")/.."

# The app reaches the Keychain only through `Keychain` (KuvoCode/Stores/Keychain.swift), which is
# one in memory for the tests: a test reaching the real one would wait on macOS asking whether
# this copy, signed anew with each build, may use what an earlier build kept.
if grep -rnE '\bSec(Item(CopyMatching|Add|Update|Delete)|Keychain[A-Za-z]*)\(' --include='*.swift' KuvoCode | grep -v '^KuvoCode/Stores/Keychain.swift:'; then
    echo "The Keychain is reached through Keychain (KuvoCode/Stores/Keychain.swift), never directly: the tests would wait on macOS asking you." >&2
    exit 1
fi

TEMP="${TMPDIR:-/tmp}"
BUILD="${TEMP%/}/KuvoCodeTests-build"
set -- -project KuvoCode.xcodeproj -scheme KuvoCode -destination "platform=macOS,arch=$(uname -m)" \
    -derivedDataPath "$BUILD" -clonedSourcePackagesDirPath build/SourcePackages \
    APP_BUNDLE_ID=run.kuvo.code.tests CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM=
if [ -n "${ONLY:-}" ]; then set -- "$@" -only-testing:"$ONLY"; fi

# The Bun that runs the agents bridge the app ships, for the tests that run it for real: `bun` on
# PATH, else the engine Kuvo Code installed (Bun, as the app runs it). Passed to the tests as
# KUVO_TEST_BUN (xcodebuild hands TEST_RUNNER_ variables on).
if [ -z "${KUVO_TEST_BUN:-}" ]; then
    KUVO_TEST_BUN=$(command -v bun 2>/dev/null || ls -d "$HOME/Library/Application Support/run.kuvo.code/engine/"*/opencode 2>/dev/null | tail -n 1 || true)
fi
export TEST_RUNNER_KUVO_TEST_BUN="${KUVO_TEST_BUN:-}"

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
mkdir -p "$BUILD"
status=0
xcodebuild test "$@" > "$BUILD/test.log" 2>&1 || status=$?
grep -E '(✔|✘|􀢄|􁁛).*(Test|Suite)|issue|error:|\*\* TEST' "$BUILD/test.log" | grep -v 'warning:\|\[Connection\]' || true
if [ $status -ne 0 ]; then echo "The whole log: $BUILD/test.log" >&2; fi
# What the tests left: their data, Trash and repositories, and the test copy's own.
clean
exit $status

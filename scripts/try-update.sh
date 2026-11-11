#!/bin/sh
# Tries an update the way people will get it, before it's released: builds this checkout as
# VERSION, signed with your Developer ID and your update key, puts it in an update feed served
# from 127.0.0.1, and points the Kuvo Code in /Applications at that feed. Then choose
# Kuvo Code › Check for Updates… there: the update window with the notes, the download, the
# install and the restart, and What's New after it. Ctrl-C stops the server and points
# Kuvo Code back at the real feed.
#   scripts/try-update.sh [VERSION]   default: the next beta after the newest tag
#   SKIP_BUILD=1    use build/KuvoCode.dmg from an earlier run
#   PORT            the server's port (default 8742)
#   SIGN_IDENTITY   default: the first "Developer ID Application" identity in your keychain
#   TRY_UPDATE_APP, TRY_UPDATE_DOMAIN   another app and defaults domain, for its tests
# However it ends, even killed outright, Kuvo Code goes back to the real feed: its trap does that
# when it exits, is interrupted or loses its terminal; scripts/feed-guard.py, outside its process
# group and tree, when it's killed (SIGKILL) or the server stops; and each run first clears a
# 127.0.0.1 feed an earlier one left, should all of that have been stopped too.
# The update is the version you're about to release, so once that's out, this copy doesn't take
# it again (it's on that version already); the next one after reaches it as usual. It's signed
# with the real update key, so it needs your keychain; it's never notarized, and stays on this Mac.
set -eu
cd "$(dirname "$0")/.."

if [ -z "${1:-}" ]; then
    LAST=$(git describe --tags --abbrev=0 --match 'v[0-9]*' | sed 's/^v//')
    case "$LAST" in
        *-beta.*) VERSION="${LAST%-beta.*}-beta.$((${LAST##*-beta.} + 1))" ;;
        *) VERSION=$(echo "$LAST" | awk -F. '{ printf "%d.%d.%d-beta.1", $1, $2, $3 + 1 }') ;;
    esac
else
    VERSION=$1
fi
INSTALLED="${TRY_UPDATE_APP:-/Applications/Kuvo Code.app}"
DOMAIN="${TRY_UPDATE_DOMAIN:-run.kuvo.code}"

# An earlier run's feed, left when it and its guard were both stopped: nothing serves it now.
STALE=$(defaults read "$DOMAIN" SUFeedURL 2>/dev/null || true)
case "$STALE" in
    http://127.0.0.1:* | http://localhost:*)
        defaults delete "$DOMAIN" SUFeedURL
        echo "Cleared the update feed an earlier run left set ($STALE)." ;;
esac

BUILD=$(./scripts/build-version.sh "$VERSION")
PORT="${PORT:-8742}"
OUT=build/try-update
FEED="http://127.0.0.1:$PORT/appcast.xml"

if [ ! -d "$INSTALLED" ]; then
    echo "There's no Kuvo Code in /Applications to update." >&2
    exit 1
fi
echo "Installed: $(defaults read "$INSTALLED/Contents/Info" CFBundleShortVersionString) ($(defaults read "$INSTALLED/Contents/Info" CFBundleVersion)); the update: $VERSION ($BUILD)."
case "$VERSION" in
    *-beta.*)
        if [ "$(defaults read "$DOMAIN" updates.betas 2>/dev/null || echo 0)" != 1 ]; then
            echo "$VERSION is a beta: turn on Settings › General › Get beta updates in the installed copy, or it won't be offered." >&2
        fi ;;
esac

if [ "${SKIP_BUILD:-0}" != 1 ]; then
    if [ -z "${SIGN_IDENTITY:-}" ]; then
        SIGN_IDENTITY=$(security find-identity -v -p codesigning | awk '/"Developer ID Application/ { print $2; exit }')
    fi
    if [ -z "$SIGN_IDENTITY" ]; then
        echo "No Developer ID Application identity in your keychain; set SIGN_IDENTITY." >&2
        exit 1
    fi
    VERSION="$VERSION" SIGN_IDENTITY="$SIGN_IDENTITY" ./scripts/build-app.sh
    SIGN_IDENTITY="$SIGN_IDENTITY" ./scripts/build-dmg.sh
fi

rm -rf "$OUT"
mkdir -p "$OUT"
cp build/KuvoCode.dmg "$OUT/KuvoCode.dmg"
./scripts/release-notes.sh Unreleased > "$OUT/notes.md"
./scripts/appcast.sh "$VERSION" "$OUT/KuvoCode.dmg" "http://127.0.0.1:$PORT/KuvoCode.dmg" "$OUT/notes.md" > "$OUT/appcast.xml"

SERVER=""
finish() {
    # Each step whatever the one before did: under set -e, a kill of a server that had already
    # stopped (Ctrl-C reaches it too) ended this before the override was deleted.
    set +e
    defaults delete "$DOMAIN" SUFeedURL 2>/dev/null
    [ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null
    echo
    echo "Stopped; Kuvo Code reads the real update feed again."
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT TERM

python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$OUT" >/dev/null 2>&1 &
SERVER=$!
# Before the override, so it's undone even when this is killed outright.
if [ "$(python3 scripts/feed-guard.py "$$" "$SERVER" "$DOMAIN" "$FEED")" != watching ]; then
    echo "The server stopped at once: is port $PORT taken? Set PORT." >&2
    exit 1
fi
# Sparkle takes a feed from its defaults over Info.plist's, for testing like this.
defaults write "$DOMAIN" SUFeedURL "$FEED"

echo
echo "Kuvo Code $VERSION is waiting at $FEED."
echo "Open the Kuvo Code in /Applications and choose Kuvo Code › Check for Updates…"
echo "Press Ctrl-C here once it has updated."
wait "$SERVER"

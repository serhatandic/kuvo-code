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
BUILD=$(./scripts/build-version.sh "$VERSION")
PORT="${PORT:-8742}"
OUT=build/try-update
INSTALLED="/Applications/Kuvo Code.app"
DOMAIN=run.kuvo.code

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
    [ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null
    defaults delete "$DOMAIN" SUFeedURL 2>/dev/null || true
    echo
    echo "Stopped; Kuvo Code reads the real update feed again."
}
trap finish EXIT
trap 'exit 130' INT TERM

python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$OUT" >/dev/null 2>&1 &
SERVER=$!
# Sparkle takes a feed from its defaults over Info.plist's, for testing like this.
defaults write "$DOMAIN" SUFeedURL "http://127.0.0.1:$PORT/appcast.xml"

echo
echo "Kuvo Code $VERSION is waiting at http://127.0.0.1:$PORT/appcast.xml."
echo "Open the Kuvo Code in /Applications and choose Kuvo Code › Check for Updates…"
echo "Press Ctrl-C here once it has updated."
wait "$SERVER"

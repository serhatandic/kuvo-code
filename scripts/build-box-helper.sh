#!/bin/sh
# Builds Kuvo Code Box (#333 piece 4; Packages/KuvoLink/PROTOCOL.md, "This Mac's box: its helper"),
# the small program a Mac's box runs under once it lives in ~/.kuvo-code, into a built app
# (`Contents/Helpers/Kuvo Code Box.app`), signed. build-app.sh runs it before it signs the app, so
# the helper is sealed in the app, notarized with it, and packed into the box's release from there.
#   scripts/build-box-helper.sh <app>
#   SIGN_IDENTITY      codesigning identity (default "-": ad hoc, for local use); with one, the
#                      hardened runtime and a secure timestamp, as notarization requires
#   HELPER_EXECUTABLE  a KuvoCodeBox built already (a test's debug build), instead of building it
#   HELPER_ID          its bundle ID (default: the app's with .box after it); a test's own family
#                      (run.kuvo.code.trial4.*) never meets a real one in the Keychain or launchd
# The helper's identifier, its signer and its place stay the same from version to version: macOS
# keeps what you allowed it, and its Keychain items, by them.
set -eu

if [ $# -ne 1 ] || [ ! -f "$1/Contents/Info.plist" ]; then
    echo "Usage: scripts/build-box-helper.sh <Kuvo Code.app>" >&2
    exit 2
fi
APP=$(cd "$1" && pwd -P)
cd "$(dirname "$0")/.."
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$APP/Contents/Info.plist" 2>/dev/null || true; }
APP_ID=$(plist CFBundleIdentifier)
HELPER_ID="${HELPER_ID:-$APP_ID.box}"
case "$HELPER_ID" in
    *[!A-Za-z0-9.-]* | "" | .*) echo "Not a bundle ID: $HELPER_ID" >&2; exit 2 ;;
esac
NAME="Kuvo Code Box"
OUT="$APP/Contents/Helpers/$NAME.app"

if [ -n "${HELPER_EXECUTABLE:-}" ]; then
    EXECUTABLE=$HELPER_EXECUTABLE
else
    swift build -c release --package-path Packages/OpenCodeKit --product KuvoCodeBox --arch arm64 -q
    EXECUTABLE="$(swift build -c release --package-path Packages/OpenCodeKit --arch arm64 --show-bin-path)/KuvoCodeBox"
fi
test -x "$EXECUTABLE" || { echo "No KuvoCodeBox at $EXECUTABLE" >&2; exit 1; }

# Made beside where it goes, then put in place whole.
NEW="$OUT.new"
rm -rf "$NEW"
trap 'rm -rf "$NEW"' EXIT
mkdir -p "$NEW/Contents/MacOS" "$NEW/Contents/Resources"
cp "$EXECUTABLE" "$NEW/Contents/MacOS/$NAME"
[ -n "${HELPER_EXECUTABLE:-}" ] || strip -rSTx "$NEW/Contents/MacOS/$NAME"
# The app's icon (the user's choice): in Login Items and in every permission macOS asks about.
if [ -f "$APP/Contents/Resources/AppIcon.icns" ]; then
    cp "$APP/Contents/Resources/AppIcon.icns" "$NEW/Contents/Resources/AppIcon.icns"
fi
INFO="$NEW/Contents/Info.plist"
plutil -create xml1 "$INFO"
put() { plutil -insert "$1" "-$2" "$3" "$INFO"; }
put CFBundleIdentifier string "$HELPER_ID"
put CFBundleName string "$NAME"
put CFBundleDisplayName string "$NAME"
put CFBundleExecutable string "$NAME"
put CFBundlePackageType string APPL
put CFBundleInfoDictionaryVersion string 6.0
put CFBundleShortVersionString string "$(plist CFBundleShortVersionString)"
put CFBundleVersion string "$(plist CFBundleVersion)"
put CFBundleIconFile string AppIcon
put LSMinimumSystemVersion string "$(plist LSMinimumSystemVersion)"
put LSUIElement bool YES
# What macOS says as it asks, for what the box's agents and integrations reach (the app's words).
for key in NSCalendarsFullAccessUsageDescription NSRemindersFullAccessUsageDescription NSMicrophoneUsageDescription NSHumanReadableCopyright; do
    value=$(plist "$key")
    [ -z "$value" ] || put "$key" string "$value"
done

if [ "$SIGN_IDENTITY" = "-" ]; then
    set -- --force --sign - --options runtime
else
    set -- --force --sign "$SIGN_IDENTITY" --options runtime --timestamp
fi
codesign "$@" --identifier "$HELPER_ID" --entitlements Config/KuvoCodeBox.entitlements "$NEW"
codesign --verify --strict --deep "$NEW"

rm -rf "$OUT"
mkdir -p "$APP/Contents/Helpers"
mv "$NEW" "$OUT"
trap - EXIT
echo "Built $OUT ($HELPER_ID)"

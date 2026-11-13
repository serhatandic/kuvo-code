#!/bin/sh
# Builds a release "Kuvo Code.app" into ./build, the way the release workflow does.
#   VERSION         version to stamp into the app (default: the project's MARKETING_VERSION);
#                   a beta's is like 0.7.0-beta.1
#   SIGN_IDENTITY   codesigning identity, e.g. "Developer ID Application: …";
#                   the default "-" signs ad hoc, for local use
#   FEED_URL        update feed (default: the newest GitHub release); for
#                   testing updates against a local server
#   KUVO_BOX_SIGNING_KEY  the box releases' key (PEM): with it, the app carries the box's
#                   release, signed (scripts/app-box-release.sh); BOX_URL says where its pack
#                   is published
set -eu
cd "$(dirname "$0")/.."

VERSION="${VERSION:-$(sed -n 's/.*MARKETING_VERSION = \(.*\);/\1/p' KuvoCode.xcodeproj/project.pbxproj | head -n 1)}"
# What Sparkle compares (CFBundleVersion): a beta's "-beta.1" as "b1", since it reads nothing
# after a dash, and orders 0.7.0b1 before 0.7.0b2 before 0.7.0.
BUILD=$(./scripts/build-version.sh "$VERSION")
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
APP="build/Kuvo Code.app"

# Updates: Sparkle reads the feed from the newest GitHub release and only
# installs updates signed with the private half of this key. The Kuvo apps share
# one key, as Sparkle recommends; scripts/set-update-key.sh uploads it for CI.
FEED_URL="${FEED_URL:-https://github.com/serhatandic/kuvo-code/releases/latest/download/appcast.xml}"
UPDATE_PUBLIC_KEY="uG/YbzL4kf+DAYCiTTfK8ztEOBo96hkEAuKk9rw9BE4="

# With Xcode's compilation cache, one for every checkout (scripts/xcode-cache.sh; not on CI): what
# another worktree's build compiled isn't compiled again.
. scripts/xcode-cache.sh
xcode_cache scripts

# Built unsigned-for-distribution (ad hoc) here and signed below, inside out, so
# every nested executable gets the same identity, the hardened runtime and a
# secure timestamp, which notarization requires.
xcodebuild -project KuvoCode.xcodeproj -scheme KuvoCode -configuration Release \
    -derivedDataPath build/DerivedData -clonedSourcePackagesDirPath build/SourcePackages \
    MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD" \
    CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM= \
    -quiet build

rm -rf "$APP"
ditto "build/DerivedData/Build/Products/Release/Kuvo Code.app" "$APP"
strip -rSTx "$APP/Contents/MacOS/Kuvo Code"

# Only release builds name a feed; without one the app hides its update controls.
PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy \
    -c "Add :SUFeedURL string $FEED_URL" \
    -c "Add :SUPublicEDKey string $UPDATE_PUBLIC_KEY" \
    -c "Add :SUEnableAutomaticChecks bool true" \
    -c "Add :SUVerifyUpdateBeforeExtraction bool true" \
    "$PLIST"

# Sparkle, trimmed to what Kuvo Code uses: Apple silicon only, no XPC services
# (only sandboxed apps need them), no headers, English only.
FRAMEWORK="$APP/Contents/Frameworks/Sparkle.framework"
(
    cd "$FRAMEWORK"
    rm -rf XPCServices Headers PrivateHeaders Modules \
        Versions/B/XPCServices Versions/B/Headers Versions/B/PrivateHeaders Versions/B/Modules
    find Versions/B/Resources -name '*.lproj' ! -name 'Base.lproj' ! -name 'en.lproj' -exec rm -rf {} +
    for binary in Versions/B/Sparkle Versions/B/Autoupdate Versions/B/Updater.app/Contents/MacOS/Updater; do
        if lipo "$binary" -verify_arch x86_64 2>/dev/null; then
            lipo "$binary" -thin arm64 -output "$binary.arm64" && mv "$binary.arm64" "$binary"
        fi
    done
)

if [ "$SIGN_IDENTITY" = "-" ]; then
    set -- --force --sign - --options runtime
else
    set -- --force --sign "$SIGN_IDENTITY" --options runtime --timestamp
fi
codesign "$@" "$FRAMEWORK/Versions/B/Autoupdate"
codesign "$@" "$FRAMEWORK/Versions/B/Updater.app"
codesign "$@" "$FRAMEWORK"
# Kuvo Code Box, the helper this Mac's box runs under in ~/.kuvo-code (Contents/Helpers), built and
# signed with the same identity, its own entitlements and the hardened runtime, before the app that
# seals it: notarized with the app, and packed into the box's release from it.
SIGN_IDENTITY="$SIGN_IDENTITY" ./scripts/build-box-helper.sh "$APP"
# The helpers the app carries (the box's, `Contents/Helpers/<name>.app`), before the app, and before
# the box's release packs them: each keeps its own identifier and entitlements.
for helper in "$APP/Contents/Helpers/"*.app; do
    if [ -d "$helper" ]; then codesign "$@" --preserve-metadata=identifier,entitlements "$helper"; fi
done
# (What macOS asks Kuvo Code Box about needs its entitlements: Calendars and Reminders for the box's
# integration.)
codesign -d --entitlements - --xml "$APP/Contents/Helpers/Kuvo Code Box.app" 2>/dev/null | grep -q personal-information.calendars \
    || { echo "Kuvo Code Box lost its entitlements as it was signed." >&2; exit 1; }
codesign "$@" --entitlements KuvoCode/KuvoCode.entitlements "$APP"
# The box's release in the app, for it to offer this Mac's box as it updates: only with the key a
# box trusts (a local build has none, and carries none).
if [ -n "${KUVO_BOX_SIGNING_KEY:-}" ]; then
    SIGN_IDENTITY="$SIGN_IDENTITY" ./scripts/app-box-release.sh "$APP" "$VERSION"
fi
echo "Built $APP $VERSION ($(du -sh "$APP" | cut -f1))"

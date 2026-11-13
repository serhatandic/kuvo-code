#!/bin/sh
# Puts the box's release in a built, signed "Kuvo Code.app" (`Contents/Resources/box-release`:
# boxes.json and box-<version>.tar.gz, scripts/pack-box.sh), and signs the app again over it. The
# app is to offer it to this Mac's box as it updates (`kuvo/box/update {from}`, PROTOCOL.md,
# "Updates"), and the release workflow publishes the same two files for machines. build-app.sh
# runs it when KUVO_BOX_SIGNING_KEY is set; the release workflow runs it in a step of its own, so
# the key never reaches the build.
#   KUVO_BOX_SIGNING_KEY=<PEM> scripts/app-box-release.sh <app> <version>
#   SIGN_IDENTITY   codesigning identity, as build-app.sh takes it (default "-": ad hoc)
#   BOX_URL         where the pack is published (default: this version's GitHub release)
set -eu

if [ $# -ne 2 ] || [ -z "${KUVO_BOX_SIGNING_KEY:-}" ]; then
    echo "Usage: KUVO_BOX_SIGNING_KEY=<PEM> scripts/app-box-release.sh <app> <version>" >&2
    exit 2
fi
APP=$(cd "$1" && pwd -P) VERSION=$2
cd "$(dirname "$0")/.."
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
BOX_URL="${BOX_URL:-https://github.com/serhatandic/kuvo-code/releases/download/v$VERSION/box-$VERSION.tar.gz}"
RELEASE="$APP/Contents/Resources/box-release"

# From the app as it's signed (it runs to write the box's files), into a folder of its own first,
# then in place whole.
rm -rf "$RELEASE" "$RELEASE.new"
scripts/pack-box.sh "$APP" "$VERSION" "$BOX_URL" "$RELEASE.new"
mv "$RELEASE.new" "$RELEASE"

# Sealed with the rest of the app again: only the app itself, as what's nested is signed already.
if [ "$SIGN_IDENTITY" = "-" ]; then
    set -- --force --sign - --options runtime
else
    set -- --force --sign "$SIGN_IDENTITY" --options runtime --timestamp
fi
codesign "$@" --entitlements KuvoCode/KuvoCode.entitlements "$APP"

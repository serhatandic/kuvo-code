#!/bin/sh
# Writes Agents/test/box-vectors.json: how this Mac's app reads a bot's job from its memory and
# works out when a repeat comes back (KuvoCodeTests/BoxVectorsTests), which a box (the agents
# bridge's Agents/src/groups, and kuvo-link.js) must do the same way, and records the file's hash
# in that test. Run it after changing either, then the bridges' tests: `cd Agents && bun test`, and
# `node --test *.test.js` in Packages/KuvoLink/Tests/Bridge.
set -eu
cd "$(dirname "$0")/.."

TEMP="${TMPDIR:-/tmp}"
OUT="${TEMP%/}/kuvo-box-vectors.json"
rm -f "$OUT"
# Passed to the test as KUVO_WRITE_BOX_VECTORS (xcodebuild hands TEST_RUNNER_ variables on).
TEST_RUNNER_KUVO_WRITE_BOX_VECTORS="$OUT" ONLY=KuvoCodeTests/BoxVectorsTests ./scripts/test-app.sh >/dev/null
[ -s "$OUT" ] || { echo "The test didn't write the vectors." >&2; exit 1; }
mv -f "$OUT" Agents/test/box-vectors.json
hash=$(shasum -a 256 Agents/test/box-vectors.json | cut -d' ' -f1)
sed -i '' "s/static let recorded = \".*\"/static let recorded = \"$hash\"/" KuvoCodeTests/BoxVectorsTests.swift
echo "Wrote Agents/test/box-vectors.json ($hash)"

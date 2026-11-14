#!/bin/sh
# Writes box/test/agents/box-vectors.json: how the apps read what a message quotes and work
# out when a repeat comes back (KuvoClient's ClientSessionsTests/BoxVectorsTests), which a box (the agents
# bridge's box/src/agents/groups) must do the same way, and records the file's hash in that
# test. Run it after changing either, then the bridges' tests: `bun test` in box, and
# `node --test *.test.js` in box/bridge-tests.
set -eu
cd "$(dirname "$0")/.."

TEMP="${TMPDIR:-/tmp}"
OUT="${TEMP%/}/kuvo-box-vectors.json"
rm -f "$OUT"
# A package test (swift test), in the lane packages' tests take, with the canonical heavy.sh as
# scripts/test-app.sh takes it.
TEST=swift/KuvoClient/Tests/ClientSessionsTests/BoxVectorsTests.swift
HEAVY="${KUVO_HEAVY_SH:-}"
if [ -z "$HEAVY" ]; then
    HEAVY="${KUVO_HEAVY_CANONICAL-$HOME/Projects/kuvo-ai/scripts/heavy.sh}"
    [ -n "$HEAVY" ] && [ -f "$HEAVY" ] || HEAVY=scripts/heavy.sh
fi
/bin/sh "$HEAVY" mac-build env KUVO_WRITE_BOX_VECTORS="$OUT" \
    sh -c 'cd swift/KuvoClient && swift test --disable-sandbox --filter BoxVectorsTests' >/dev/null
[ -s "$OUT" ] || { echo "The test didn't write the vectors." >&2; exit 1; }
mv -f "$OUT" box/test/agents/box-vectors.json
hash=$(shasum -a 256 box/test/agents/box-vectors.json | cut -d' ' -f1)
sed -i '' "s/static let recorded = \".*\"/static let recorded = \"$hash\"/" "$TEST"
echo "Wrote box/test/agents/box-vectors.json ($hash)"

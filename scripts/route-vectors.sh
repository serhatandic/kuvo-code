#!/bin/sh
# Writes protocol/vectors/routes/box: what a Mac leaves on a machine that the machine's
# routes read (the integrations it offers, the popular MCP servers), and what's this Mac's own that
# its app gives its own box to make bots with (its kit), from the Mac's own code (KuvoCodeTests/RouteContractTests). The machine's runner of the route scenarios
# (box/bridge-tests/contract.test.js) sets its box up with them, and the Mac's checks
# they're still what it writes. Run it after changing one of those, then both runners.
set -eu
cd "$(dirname "$0")/.."

TEMP="${TMPDIR:-/tmp}"
OUT="${TEMP%/}/kuvo-route-vectors"
rm -rf "$OUT"
# Passed to the test as KUVO_WRITE_ROUTE_VECTORS (xcodebuild hands TEST_RUNNER_ variables on).
TEST_RUNNER_KUVO_WRITE_ROUTE_VECTORS="$OUT" ONLY="KuvoCodeTests/RouteContractTests/theMachinesRunnerHasWhatAMacLeavesThere()" ./scripts/test-app.sh >/dev/null
for file in integrations.json mcp-catalog.json mac-bot-kit.json; do
    [ -s "$OUT/$file" ] || { echo "The test didn't write $file." >&2; exit 1; }
done
mkdir -p protocol/vectors/routes/box
mv -f "$OUT"/*.json protocol/vectors/routes/box/  # (approval.json is the box's own now: left as it is)
rm -rf "$OUT"
echo "Wrote protocol/vectors/routes/box"

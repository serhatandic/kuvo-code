#!/bin/sh
# Writes Packages/KuvoLink/Vectors/routes/box: what a Mac leaves on a machine that the machine's
# routes read (the integrations it offers, the popular MCP servers, what it makes bots with), from
# the Mac's own code (KuvoCodeTests/RouteContractTests). The machine's runner of the route scenarios
# (Packages/KuvoLink/Tests/Bridge/contract.test.js) sets its box up with them, and the Mac's checks
# they're still what it writes. Run it after changing one of those, then both runners.
set -eu
cd "$(dirname "$0")/.."

TEMP="${TMPDIR:-/tmp}"
OUT="${TEMP%/}/kuvo-route-vectors"
rm -rf "$OUT"
# Passed to the test as KUVO_WRITE_ROUTE_VECTORS (xcodebuild hands TEST_RUNNER_ variables on).
TEST_RUNNER_KUVO_WRITE_ROUTE_VECTORS="$OUT" ONLY="KuvoCodeTests/RouteContractTests/theMachinesRunnerHasWhatAMacLeavesThere()" ./scripts/test-app.sh >/dev/null
for file in integrations.json mcp-catalog.json bot-kit.json; do
    [ -s "$OUT/$file" ] || { echo "The test didn't write $file." >&2; exit 1; }
done
mkdir -p Packages/KuvoLink/Vectors/routes/box
mv -f "$OUT"/*.json Packages/KuvoLink/Vectors/routes/box/
rm -rf "$OUT"
echo "Wrote Packages/KuvoLink/Vectors/routes/box"

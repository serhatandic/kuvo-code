#!/bin/sh
# Builds the browser's keeper and the agents' browser tools (box/src/browser) into
# swift/KuvoCode/Resources/kuvo-browser.js, the one file every box runs for them (the app puts it in a box's
# release, and on a machine an older box runs) with the engine's Bun (scripts/build-browser.ts says
# how). Run it after changing anything in box/src/browser, and commit the result. `--check`
# builds it again and says whether that's what's here, byte for byte, as CI checks: so a change made
# to kuvo-browser.js itself, or merged into it, never passes for one made in its sources. It bundles
# nothing, so any Bun builds the same file.
#   BUN   the Bun to run with (as scripts/build-box.sh finds it)
set -eu
cd "$(dirname "$0")/.."

. scripts/real-app-guard.sh
if [ -z "${BUN:-}" ]; then
  if command -v bun >/dev/null 2>&1; then
    BUN=bun
  else
    for engine in "$HOME/Library/Application Support/run.kuvo.code."*/engine/*/opencode; do
      [ -x "$engine" ] && BUN=$engine
    done
  fi
fi
[ -n "${BUN:-}" ] || { echo "scripts/build-browser.sh needs Bun: install it, or name one with BUN=." >&2; exit 1; }
real_app_guard "scripts/build-browser.sh" "$BUN"

if [ "${1:-}" = "--check" ]; then
  BUN_BE_BUN=1 "$BUN" scripts/build-browser.ts "$PWD" --check
else
  BUN_BE_BUN=1 "$BUN" scripts/build-browser.ts "$PWD"
fi

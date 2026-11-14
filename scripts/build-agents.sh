#!/bin/sh
# Builds the agents bridge (box/src/agents) into box/dist/kuvo-agents.js, the
# one file the app ships and runs with the engine's Bun. Run it after changing anything in
# box/src/agents or src/shared, and commit the result. The agents' SDKs aren't in it: the
# bridge downloads each one the first time it's needed. Its last line names what it was built from
# (a hash of those folders and the package's files), and `--check` says whether that's what's here
# now, as CI checks.
#   BUN   the Bun to build with (default: `bun` on PATH, else the engine a demo, perf or e2e copy
#         installed, which is Bun with BUN_BE_BUN=1; never the real Kuvo Code's)
set -eu
cd "$(dirname "$0")/.."

sources() {
  # (The files git keeps or would: never a stray one, like Finder's .DS_Store, CI hasn't.)
  { git ls-files -co --exclude-standard box/src/agents box/src/shared; echo box/package.json; echo box/bun.lock; } | LC_ALL=C sort | while read -r file; do
    printf '%s %s\n' "$file" "$(shasum -a 256 <"$file" | cut -d' ' -f1)"
  done | shasum -a 256 | cut -d' ' -f1
}
# Its words are what every bridge looks for (box/src/shared/bundle.ts), on boxes that run older
# ones too, so they stay as they were when the sources were in Packages/Box: not a path to follow.
stamp="// Built from Packages/Box/src/agents $(sources)"

if [ "${1:-}" = "--check" ]; then
  # (Its old place, in the retired Mac app's Resources, which a branch from before the move can
  # bring back: the app would bundle it twice, and its build, the box release's, fail.)
  if [ -e swift/KuvoCode/Resources/kuvo-agents.js ]; then
    echo "swift/KuvoCode/Resources/kuvo-agents.js is back: the bundle is box/dist/kuvo-agents.js now. git rm the old one." >&2
    exit 1
  fi
  [ "$(tail -n 1 box/dist/kuvo-agents.js)" = "$stamp" ] && exit 0
  echo "box/dist/kuvo-agents.js isn't built from box/src/agents as it is: run ./scripts/build-agents.sh and commit it." >&2
  exit 1
fi

. scripts/real-app-guard.sh
if [ -z "${BUN:-}" ]; then
  if command -v bun >/dev/null 2>&1; then
    BUN=bun
  else
    BUN=$(newest_copy_engine)
    [ -n "$BUN" ] || { echo "No Bun: install it, or launch a demo copy of Kuvo Code once so it downloads its engine." >&2; exit 1; }
  fi
fi
real_app_guard "scripts/build-agents.sh" "$BUN"

BUN_BE_BUN=1 "$BUN" build box/src/agents/main.ts --target=bun --outfile box/dist/kuvo-agents.js
echo "$stamp" >>box/dist/kuvo-agents.js
echo "Built box/dist/kuvo-agents.js"

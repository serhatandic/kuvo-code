#!/bin/sh
# Builds the box's link (Packages/Box/src/link) into Packages/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js,
# the one file the Mac app puts on each machine and runs as this Mac's own box (`kuvo-link.js serve`),
# with the engine's Bun. Run it after changing anything in Packages/Box/src, and commit the result. Its last
# line names what it was built from (a hash of Packages/Box/src and the packages), and `--check` says whether
# that's what's here now, as CI checks.
#   BUN   the Bun to build with (default: `bun` on PATH, else the engine a demo, perf or e2e copy
#         installed, which is Bun with BUN_BE_BUN=1; never the real Kuvo Code's)
set -eu
cd "$(dirname "$0")/.."

OUT=Packages/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js

sources() {
  { find Packages/Box/src -type f; echo Packages/Box/package.json; echo Packages/Box/bun.lock; } | LC_ALL=C sort | while read -r file; do
    printf '%s %s\n' "$file" "$(shasum -a 256 <"$file" | cut -d' ' -f1)"
  done | shasum -a 256 | cut -d' ' -f1
}
stamp="// Built from Packages/Box/src $(sources)"

if [ "${1:-}" = "--check" ]; then
  [ "$(tail -n 1 "$OUT")" = "$stamp" ] && exit 0
  echo "$OUT isn't built from Packages/Box/src as it is: run ./scripts/build-box.sh and commit it." >&2
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
real_app_guard "scripts/build-box.sh" "$BUN"

# For Node too, not only Bun: the bridge's tests import it with Node, and it uses Node's modules only.
BUN_BE_BUN=1 "$BUN" build Packages/Box/src/link/main.ts --target=node --format=esm --outfile "$OUT" \
  --banner "// Built from Packages/Box/src by scripts/build-box.sh: change those, then run it. Never edit this file."
echo "$stamp" >>"$OUT"
echo "Built $OUT"

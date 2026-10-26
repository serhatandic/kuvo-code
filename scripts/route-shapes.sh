#!/bin/sh
# Writes Packages/KuvoLink/Vectors/routes/shapes/answers.json from Packages/Box/src/shared/routes:
# every route's answers, as the contract suite holds both boxes to them (contract-runner.js and
# KuvoCodeTests/RouteContractTests.swift read it). Run it after changing a shape, and commit the
# result. `--check` says whether the file is what the shapes write, as CI checks.
#   BUN   the Bun to run with (as scripts/build-box.sh finds it)
set -eu
cd "$(dirname "$0")/.."

OUT=Packages/KuvoLink/Vectors/routes/shapes/answers.json

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
[ -n "${BUN:-}" ] || { echo "scripts/route-shapes.sh needs Bun: install it, or name one with BUN=." >&2; exit 1; }
real_app_guard "scripts/route-shapes.sh" "$BUN"

write() {
  BUN_BE_BUN=1 "$BUN" -e '
    const { ERROR, PASSED_ON, ROUTES } = await import(process.argv[1] + "/Packages/Box/src/shared/routes/index.ts");
    const about = "What each route of a box answers (scripts/route-shapes.sh writes it from Packages/Box/src/shared/routes; never edit it): its JSON by status, or \"bytes\". A shape is \"string\", \"number\", \"bool\", \"null\", \"any\", {list}, {map}, {object} (those fields and no others; a name ending in ? may be left out), {oneOf} or {literal}. A refusal (400 and over) in JSON is `error`, unless its route has a shape of its own for that status; what starts with a `passedOn` path is the engine'"'"'s or the agents bridge'"'"'s own.";
    process.stdout.write(JSON.stringify({ about, error: ERROR, passedOn: PASSED_ON, routes: ROUTES }, null, 1) + "\n");
  ' "$PWD"
}

if [ "${1:-}" = "--check" ]; then
  write | cmp -s - "$OUT" && exit 0
  echo "$OUT isn't what Packages/Box/src/shared/routes writes: run ./scripts/route-shapes.sh and commit it." >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
write > "$OUT"
echo "Wrote $OUT"

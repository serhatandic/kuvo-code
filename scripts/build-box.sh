#!/bin/sh
# Builds the box's link (Packages/Box/src/link) into Packages/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js,
# the one file the Mac app puts on each machine and runs as this Mac's own box (`kuvo-link.js serve`),
# with the engine's Bun. Run it after changing anything in Packages/Box/src, and commit the result.
# `--check` builds it again and says whether that's what's here, byte for byte, as CI checks: so a
# change made to kuvo-link.js itself, or merged into it, never passes for one made in its sources.
# It builds with one Bun, the one CI has (BUN_VERSION), so every computer builds the same file.
#   BUN   the Bun to build with (default: `bun` on PATH if it's that version, else the engine of a
#         demo, perf or e2e copy that has it, which is Bun with BUN_BE_BUN=1; never the real
#         Kuvo Code's)
set -eu
cd "$(dirname "$0")/.."

OUT=Packages/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js
# The same as CI's setup-bun (.github/workflows/ci.yml).
BUN_VERSION=1.4.2

. scripts/real-app-guard.sh
version() { BUN_BE_BUN=1 "$1" --version 2>/dev/null || true; }
if [ -z "${BUN:-}" ]; then
  if command -v bun >/dev/null 2>&1 && [ "$(version bun)" = "$BUN_VERSION" ]; then
    BUN=bun
  else
    for engine in "$HOME/Library/Application Support/run.kuvo.code."*/engine/*/opencode; do
      [ -x "$engine" ] && [ "$(version "$engine")" = "$BUN_VERSION" ] && BUN=$engine
    done
  fi
fi
if [ -z "${BUN:-}" ] || [ "$(version "$BUN")" != "$BUN_VERSION" ]; then
  echo "scripts/build-box.sh builds with Bun $BUN_VERSION, as CI does: install it, or launch a demo copy of Kuvo Code whose engine has it, or name one with BUN=." >&2
  exit 1
fi
real_app_guard "scripts/build-box.sh" "$BUN"

# For Node too, not only Bun: the bridge's tests import it with Node, and it uses Node's modules only.
# Its version (BRIDGE_VERSION, Packages/Box/src/link/version.ts) is the first 12 hex digits of the
# SHA-256 of what's built with the version as its source has it, written in its place: it changes
# with every change to the link, the same on every computer, and no branch bumps it by hand.
SOURCE_VERSION=0.0.0-from-its-sources
raw=$(mktemp "${TMPDIR:-/tmp}/kuvo-link-raw.XXXXXX")
built=$(mktemp "${TMPDIR:-/tmp}/kuvo-link.XXXXXX")
trap 'rm -f "$raw" "$built"' EXIT
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi; }
build() {
  BUN_BE_BUN=1 "$BUN" build Packages/Box/src/link/main.ts --target=node --format=esm --outfile "$raw" \
    --banner "// Built from Packages/Box/src by scripts/build-box.sh: change those, then run it. Never edit this file." >/dev/null
  if ! grep -q "\"$SOURCE_VERSION\"" "$raw"; then
    echo "scripts/build-box.sh: the built link doesn't have \"$SOURCE_VERSION\" (Packages/Box/src/link/version.ts) to write its version in." >&2
    exit 1
  fi
  hash=$(sha256 "$raw" | cut -c1-12)
  if ! printf '%s' "$hash" | grep -Eq '^[0-9a-f]{12}$'; then
    echo "scripts/build-box.sh: couldn't hash the built link (sha256sum or shasum)." >&2
    exit 1
  fi
  sed "s/\"$(printf '%s' "$SOURCE_VERSION" | sed 's/\./\\./g')\"/\"$hash\"/g" "$raw" >"$1"
}

if [ "${1:-}" = "--check" ]; then
  build "$built"
  cmp -s "$built" "$OUT" && exit 0
  echo "$OUT isn't what Packages/Box/src builds: change the sources, not it, then run ./scripts/build-box.sh and commit it." >&2
  exit 1
fi

build "$OUT"
echo "Built $OUT"

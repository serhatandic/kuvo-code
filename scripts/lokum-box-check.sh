#!/bin/bash
# The box's whole Bun suite on lokum under the engine's Bun, in ~/.kuvo-code-test/<name> (emptied after).
# Usage: lokum-box-check.sh <checkout> <name> [bun test args…]
# It sends the repo's own layout, so the tests that read files beside Packages/Box find them:
# KuvoLink's vectors and bot-words.json, KuvoClient's BoxVectorsTests.swift (groups.test.ts checks
# box-vectors.json against it), scripts/route-shapes.sh with what it runs (route-shapes.test.ts), and
# the bridge's tests' folder: test-safety.js, which every box test imports first (without it all test
# files fail at import), and the stand-ins some box tests start (browser-source-stand-in.js,
# relay-stand-in.js).
# It lists what skipped, and what the run left in the home folder or /tmp.
# (Corrected copy of side-session-notes/…/lokum-box-suite.sh: that one lacks test-safety.js, drops the
# bun test args you give it — ssh doesn't hand them to the remote shell — and names engine 2.2.0.)
# HOST defaults to lokum-local; `HOST=lokum-tailscale` away from home. The engine is the newest on the
# machine under ~/.kuvo-code/engine. FULL=1 prints all the run says, not only what failed and skipped.
HOST=${HOST:-lokum-local}
REPO=${1:?checkout}; NAME=${2:?name}; shift 2
cd "$REPO" || exit 1
if [ -n "${FULL:-}" ]; then FILTER=cat; else FILTER="grep -E '^\(fail\)|^\(skip\)|error:|Expected|Received|^ [0-9]+ (pass|fail|skip)|^Ran '"; fi
# (The args, quoted for the remote shell.)
ARGS=""; for each in "$@"; do ARGS="$ARGS $(printf '%q' "$each")"; done
COPYFILE_DISABLE=1 tar --no-xattrs -czf - \
  Packages/Box/package.json Packages/Box/bun.lock Packages/Box/bunfig.toml Packages/Box/tsconfig.json \
  Packages/Box/src Packages/Box/test Packages/Box/eval \
  Packages/KuvoLink/Vectors Packages/KuvoLink/Sources/KuvoLink/Resources/bot-words.json \
  Packages/KuvoLink/Tests/Bridge Packages/KuvoClient/Tests/ClientSessionsTests/BoxVectorsTests.swift \
  scripts/route-shapes.sh scripts/route-shapes.ts scripts/real-app-guard.sh |
ssh -o BatchMode=yes "$HOST" "T=\$HOME/.kuvo-code-test/$NAME; E=\$(ls -d \$HOME/.kuvo-code/engine/*/ | sort -V | tail -1)opencode; mkdir -p \$T/tmp \$T/repo && tar xzf - -C \$T/repo && cd \$T/repo/Packages/Box && export TMPDIR=\$T/tmp XDG_CACHE_HOME=\$T/tmp/cache BUN_INSTALL_CACHE_DIR=\$T/tmp/bun-cache && ls -A /tmp > \$T/tmp-before && ls -A ~ > \$T/home-before && BUN_BE_BUN=1 \$E install --frozen-lockfile >/dev/null 2>&1; echo \"install \$?\"; BUN_BE_BUN=1 \$E test --timeout 120000$ARGS 2>&1 | $FILTER; ls -A /tmp > \$T/tmp-after; ls -A ~ > \$T/home-after; echo '/tmp new:'; diff \$T/tmp-before \$T/tmp-after | grep '^>'; echo 'home new:'; diff \$T/home-before \$T/home-after | grep '^>'; cd; rm -rf \$T; ls -A ~/.kuvo-code-test; echo cleaned"

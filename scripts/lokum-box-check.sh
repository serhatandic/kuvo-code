#!/bin/bash
# Usage: scripts/lokum-box-check.sh <checkout> <name> [bun test args…]
# Runs the box tests under the newest engine Bun, in an isolated scratch folder, and exits as they did.
# It sends the repo's own layout, so the tests that read files beside Packages/Box find them:
# KuvoLink's vectors and bot-words.json, KuvoClient's BoxVectorsTests.swift (groups.test.ts checks
# box-vectors.json against it), scripts/route-shapes.sh with what it runs (route-shapes.test.ts), and
# the bridge's tests' folder: test-safety.js, which every box test imports first, and the stand-ins
# some box tests start (browser-source-stand-in.js, relay-stand-in.js).
# It prints what failed and skipped, with the counts; FULL=1 prints all the run says. HOST defaults
# to lokum-local (`HOST=lokum-tailscale` away from home).
set -eo pipefail
HOST=${HOST:-lokum-local}
REPO=${1:?checkout}; NAME=${2:?name}; shift 2
case "$NAME" in ''|*[!a-zA-Z0-9_-]*) echo 'name must contain only letters, digits, _ or -' >&2; exit 64;; esac
cd "$REPO"
IFS= read -r -d '' remote <<'REMOTE' || true
set -eo pipefail
name=$1 full=$2; shift 2
real_home=$HOME
T=$HOME/.kuvo-code-test/$name
# Refuse existing runs, including symlinks; never remove someone else's scratch.
[ ! -e "$T" ] && [ ! -L "$T" ] || { echo "Scratch exists: $T" >&2; exit 1; }
tmp_before=$(ls -A /tmp); home_before=$(ls -A "$HOME")
parent_created=0
if [ ! -d "$HOME/.kuvo-code-test" ]; then
    mkdir "$HOME/.kuvo-code-test" && parent_created=1
fi
mkdir -m 700 "$T"
cleanup() {
    status=$?
    set +e
    cd "$real_home"
    ls -A /tmp > "$T/tmp-after"
    ls -A "$real_home" > "$T/home-after"
    # A child finishing its cleanup can race removal; retry only this run's folder.
    for attempt in 1 2 3; do
        rm -rf -- "$T" && break
    done
    if [ -e "$T" ]; then echo "Cleanup failed: $T" >&2; status=1; fi
    if [ "$parent_created" -eq 1 ]; then rmdir "$real_home/.kuvo-code-test" 2>/dev/null || true; fi
    printf '/tmp new:\n'
    comm -13 <(printf '%s\n' "$tmp_before" | LC_ALL=C sort) <(ls -A /tmp | LC_ALL=C sort)
    printf 'home new:\n'
    comm -13 <(printf '%s\n' "$home_before" | LC_ALL=C sort) <(ls -A "$real_home" | LC_ALL=C sort)
    if [ ! -e "$T" ]; then echo cleaned; fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
mkdir -p "$T/repo" "$T/tmp" "$T/cache"
printf '%s\n' "$tmp_before" > "$T/tmp-before"
printf '%s\n' "$home_before" > "$T/home-before"
tar xzf - -C "$T/repo"
# Discover/execute only the engine binary; no live box state is inspected.
engine=$(printf '%s\n' "$real_home"/.kuvo-code/engine/*/opencode | sort -V | tail -1)
for var in $(compgen -e); do
    case "$var" in KUVO_*|OPENCODE_*|XDG_*|SSH_AUTH_SOCK|CLAUDE*|CODEX_HOME|BUN_*|NODE_OPTIONS) unset "$var";; esac
done
# HOME stays yours, as on the Mac (scripts/test-box.sh): the guard (test-safety.js) gives the run a
# home of its own in ~/.kuvo-code-test and removes it, and the tests that judge your own home (Auto's
# reviewer, the walls' HOME check) need HOME to be the account's, as the system has it. A scratch HOME
# failed 19 tests, the SSH agents' one too (its sockets' paths, deeper, past Linux's 108 bytes).
export TMPDIR=$T/tmp XDG_CACHE_HOME=$T/cache
export BUN_INSTALL_CACHE_DIR=$T/cache/bun npm_config_cache=$T/cache/npm UV_CACHE_DIR=$T/cache/uv
export BUN_RUNTIME_TRANSPILER_CACHE_PATH=$T/cache/transpiler
export PATH=/usr/local/bin:/usr/bin:/bin
cd "$T/repo/Packages/Box"
if [ "$full" = 1 ]; then
    BUN_BE_BUN=1 "$engine" install --frozen-lockfile
    BUN_BE_BUN=1 "$engine" test --timeout 120000 "$@"
else
    BUN_BE_BUN=1 "$engine" install --frozen-lockfile > "$T/install.log" 2>&1 || { cat "$T/install.log"; exit 1; }
    BUN_BE_BUN=1 "$engine" test --timeout 120000 "$@" 2>&1 | grep -E '^\(fail\)|^\(skip\)|error:|Expected|Received|^ [0-9]+ (pass|fail|skip)|^Ran '
fi

REMOTE
printf -v command 'bash -c %q -- %q %q' "$remote" "$NAME" "${FULL:+1}"
for file in "$@"; do printf -v quoted ' %q' "$file"; command+=$quoted; done
COPYFILE_DISABLE=1 tar --no-xattrs -czf - \
    Packages/Box/package.json Packages/Box/bun.lock Packages/Box/bunfig.toml Packages/Box/tsconfig.json \
    Packages/Box/src Packages/Box/test Packages/Box/eval \
    Packages/KuvoLink/Vectors Packages/KuvoLink/Sources/KuvoLink/Resources/bot-words.json \
    Packages/KuvoLink/Tests/Bridge Packages/KuvoClient/Tests/ClientSessionsTests/BoxVectorsTests.swift \
    scripts/route-shapes.sh scripts/route-shapes.ts scripts/real-app-guard.sh |
    ssh -o BatchMode=yes "$HOST" "$command"

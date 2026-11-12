#!/bin/bash
# Usage: scripts/lokum-box-check.sh <checkout> <name> [bun test args…]
# Runs the box tests under the newest engine Bun, in an isolated scratch folder.
set -eo pipefail
HOST=${HOST:-lokum-local}
REPO=${1:?checkout}; NAME=${2:?name}; shift 2
case "$NAME" in ''|*[!a-zA-Z0-9_-]*) echo 'name must contain only letters, digits, _ or -' >&2; exit 64;; esac
cd "$REPO"
IFS= read -r -d '' remote <<'REMOTE' || true
set -eo pipefail
name=$1; shift
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
mkdir -p "$T/repo" "$T/tmp" "$T/home" "$T/cache"
printf '%s\n' "$tmp_before" > "$T/tmp-before"
printf '%s\n' "$home_before" > "$T/home-before"
tar xzf - -C "$T/repo"
# Discover/execute only the engine binary; no live box state is inspected.
engine=$(printf '%s\n' "$real_home"/.kuvo-code/engine/*/opencode | sort -V | tail -1)
for var in $(compgen -e); do
    case "$var" in KUVO_*|OPENCODE_*|XDG_*|SSH_AUTH_SOCK|CLAUDE*|CODEX_HOME|BUN_*|NODE_OPTIONS) unset "$var";; esac
done
export HOME=$T/home TMPDIR=$T/tmp XDG_CACHE_HOME=$T/cache
export BUN_INSTALL_CACHE_DIR=$T/cache/bun npm_config_cache=$T/cache/npm UV_CACHE_DIR=$T/cache/uv
export BUN_RUNTIME_TRANSPILER_CACHE_PATH=$T/cache/transpiler
export PATH=/usr/local/bin:/usr/bin:/bin
cd "$T/repo/Packages/Box"
BUN_BE_BUN=1 "$engine" install --frozen-lockfile
BUN_BE_BUN=1 "$engine" test --timeout 120000 "$@"

REMOTE
printf -v command 'bash -c %q -- %q' "$remote" "$NAME"
for file in "$@"; do printf -v quoted ' %q' "$file"; command+=$quoted; done
COPYFILE_DISABLE=1 tar --no-xattrs -czf - \
    Packages/Box/package.json Packages/Box/bun.lock Packages/Box/bunfig.toml Packages/Box/tsconfig.json \
    Packages/Box/src Packages/Box/test Packages/Box/eval \
    Packages/KuvoLink/Vectors Packages/KuvoLink/Sources/KuvoLink/Resources/bot-words.json \
    Packages/KuvoLink/Tests/Bridge/test-safety.js Packages/KuvoClient/Tests/ClientSessionsTests/BoxVectorsTests.swift |
    ssh -o BatchMode=yes "$HOST" "$command"

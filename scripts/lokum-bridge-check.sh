#!/bin/bash
# Usage: scripts/lokum-bridge-check.sh <checkout> <name> [test files…]
# Runs the chosen bridge tests (all of them when none are named) on lokum, from the checkout as it is.
# Under a pinned Node: the engine's Bun (1.4.4) fails dozens of bridge tests that pass under Node
# (bots-work, reach-elsewhere-rules…). Bun is still on the PATH for the tests that start a box on it.
# All remote writes, including the guard's HOME and caches, belong to the scratch folder.
set -eo pipefail
HOST=${HOST:-lokum-local}
REPO=${1:?checkout}; NAME=${2:?name}; shift 2
case "$NAME" in ''|*[!a-zA-Z0-9_-]*) echo 'name must contain only letters, digits, _ or -' >&2; exit 64;; esac
cd "$REPO"
files=()
for file in "$@"; do
    file=${file#box/}; file=${file#bridge-tests/}
    case "$file" in */*|.*|*[!a-zA-Z0-9_.-]*|-* ) echo "Invalid test file: $file" >&2; exit 64;; esac
    [[ "$file" == *.test.js && -f "box/bridge-tests/$file" ]] || { echo "No bridge test: $file" >&2; exit 64; }
    files+=("bridge-tests/$file")
done
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
    # What this run started and left running (an interrupted test's box) names its scratch folder.
    if pgrep -u "$(id -u)" -f -- "$T/" > /dev/null; then
        echo "Stopping what this run left running:"; pgrep -u "$(id -u)" -fa -- "$T/" | cut -c1-200
        pkill -TERM -u "$(id -u)" -f -- "$T/"
        for attempt in $(seq 50); do pgrep -u "$(id -u)" -f -- "$T/" > /dev/null || break; sleep 0.1; done
        pkill -KILL -u "$(id -u)" -f -- "$T/"
    fi
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
mkdir "$T/bin"
printf '#!/bin/bash\nBUN_BE_BUN=1 exec %q "$@"\n' "$engine" > "$T/bin/bun"
chmod +x "$T/bin/bun"
export PATH=$T/bin:/usr/local/bin:/usr/bin:/bin
(cd "$T/repo/box" && BUN_BE_BUN=1 "$engine" install --frozen-lockfile)
cd "$T/repo/box"
[ $# -gt 0 ] || set -- bridge-tests/*.test.js
# Node 24, as CI (.github/workflows/ci.yml) and the Mac run the bridge tests (the box's server takes
# options Node 22 ignores), checked against nodejs.org's published checksums; never installed system-wide.
node=v24.22.2
case $(uname -m) in
    x86_64) arch=x64; sha=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75;;
    aarch64) arch=arm64; sha=eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8;;
    *) echo 'Unsupported Linux architecture' >&2; exit 1;;
esac
curl -fsSL "https://nodejs.org/dist/$node/node-$node-linux-$arch.tar.xz" -o "$T/node.tar.xz"
printf '%s  %s\n' "$sha" "$T/node.tar.xz" | sha256sum -c -
mkdir "$T/node"
tar xJf "$T/node.tar.xz" -C "$T/node" --strip-components=1
export PATH=$T/node/bin:$PATH
echo "Runtime: Node $node, downloaded into the scratch folder (engine Bun $(BUN_BE_BUN=1 "$engine" --version) fails bridge tests that pass under Node)"
# Node's os.userInfo() ignores HOME. Sandbox fixtures use its homedir for cache
# probes, so confine that lookup too; the guard still gets accountHome via getent.
cat > "$T/home.mjs" <<'JS'
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
const userInfo = os.userInfo;
if (process.argv[1]?.endsWith('/sandbox.test.js')) {
  os.userInfo = (...args) => ({ ...userInfo(...args), homedir: process.env.HOME });
}
syncBuiltinESMExports();
JS
export NODE_OPTIONS="--import=file://$T/home.mjs"
node --test --test-reporter=tap "$@"
REMOTE
printf -v command 'bash -c %q -- %q' "$remote" "$NAME"
for file in "${files[@]}"; do printf -v quoted ' %q' "$file"; command+=$quoted; done
# compat.test.js inspects source markers on every side, including Swift and shell code.
# Send those tracked sources too, without assets, dependency folders or build output.
sources=()
while IFS= read -r -d '' source; do
    case "$source" in
        swift/KuvoLink/Sources/KuvoLink/Resources/*) ;;
        *.swift|*.ts|*.js|*.mjs|*.sh|*.py) sources+=("$source");;
    esac
done < <(git --no-optional-locks ls-files -z swift/KuvoCode swift/OpenCodeKit/Sources swift/KuvoLink/Sources scripts)
COPYFILE_DISABLE=1 tar --no-xattrs --exclude node_modules --exclude .build -czf - \
    box/bridge-tests protocol/vectors swift/KuvoLink/Sources/KuvoLink/Resources \
    protocol/PROTOCOL.md box/src box/package.json box/bun.lock \
    "${sources[@]}" |
    ssh -o BatchMode=yes "$HOST" "$command"

#!/bin/bash
# Usage: scripts/lokum-bridge-check.sh <checkout> <name> [test files…]
# Runs the chosen bridge tests (all of them when none are named) on lokum, from the checkout as it is.
# Under a pinned Node: the engine's Bun (1.4.4) fails dozens of bridge tests that pass under Node
# (bots-work, reach-elsewhere-rules…). Bun is still on the PATH for the tests that start a box on it.
# All remote writes belong to the scratch folder, but for the run's own home the guard gives it in
# ~/.kuvo-code-test and removes (test-safety.js), and the sandbox tests' probes of your own caches in
# ~/.cache, which they remove (a run cut short can leave them: cleanup lists what's new there).
set -eo pipefail
HOST=${HOST:-lokum-local}
REPO=${1:?checkout}; NAME=${2:?name}; shift 2
case "$NAME" in ''|*[!a-zA-Z0-9_-]*) echo 'name must contain only letters, digits, _ or -' >&2; exit 64;; esac
# (The guard removes folders in ~/.kuvo-code-test named like a run of its own whose process is gone.)
if [[ "$NAME" =~ ^(ku|sb|sa|kv|outside)-[0-9]+(-|$) ]]; then echo "name mustn't look like a test run's own folder: $NAME" >&2; exit 64; fi
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
caches() { [ -d "$real_home/.cache" ] && find "$real_home/.cache" -maxdepth 3 2>/dev/null | LC_ALL=C sort; }
cache_before=$(caches)
parent_created=0
if [ ! -d "$HOME/.kuvo-code-test" ]; then
    mkdir "$HOME/.kuvo-code-test" && parent_created=1
fi
mkdir -m 700 "$T"
# The processes this run started that are still running, by PID: this shell's descendants (not
# zombies), but for the subshell asking and what it runs.
started() {
    # (Read here: in the pipeline, each side has a BASHPID of its own.)
    local self=$BASHPID
    ps -e -o pid=,ppid=,stat= | awk -v root=$$ -v self="$self" '
        { parent[$1] = $2; state[$1] = $3 }
        END {
            for (pid in parent) {
                if (state[pid] ~ /^Z/) continue
                for (up = parent[pid]; up != "" && up != 0 && up != 1 && up != self && up != root; up = parent[up]) {}
                if (up == root && pid != self) print pid
            }
        }'
}
cleanup() {
    status=$?
    set +e
    # (A closed connection mustn't stop it before it has stopped what's running and removed $T.)
    trap '' PIPE
    cd "$real_home"
    ls -A /tmp > "$T/tmp-after"
    ls -A "$real_home" > "$T/home-after"
    # What this run started and left running (an interrupted test's box), by its PIDs: this shell is
    # their subreaper, so even what detached from its parent is still among its descendants.
    # Asked again each time, so a PID is signalled only while it's still one of them, and what one
    # of them started again meanwhile is stopped too.
    left=$(started)
    if [ -n "$left" ]; then
        echo "Stopping what this run left running:"; ps -o pid=,args= -p "${left//$'\n'/,}" | cut -c1-200
        for attempt in $(seq 50); do
            kill -TERM $left 2>/dev/null; sleep 0.1
            left=$(started); [ -n "$left" ] || break
        done
        for attempt in $(seq 20); do
            left=$(started); [ -n "$left" ] || break
            kill -KILL $left 2>/dev/null; sleep 0.1
        done
        left=$(started)
        [ -z "$left" ] || echo "Still running after this run: ${left//$'\n'/ }" >&2
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
    printf '~/.cache new:\n'
    comm -13 <(printf '%s\n' "$cache_before") <(caches)
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
# HOME stays yours, as on the Mac and in scripts/lokum-box-check.sh: the guard (test-safety.js) gives
# the run a home of its own in ~/.kuvo-code-test and removes it, and the tests that judge your own
# home (the sandbox's tool caches) need HOME to be the account's, as the system has it. A scratch
# HOME put this scratch's name in every test folder's path, so a long name took the sockets in them
# past Linux's 108 bytes.
export TMPDIR=$T/tmp XDG_CACHE_HOME=$T/cache
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
node --test --test-reporter=tap "$@"
REMOTE
# The run's shell is made a child subreaper (Linux's prctl, kept across exec), so what its tests start
# stays its descendant even once detached, and its cleanup stops exactly those PIDs, never by pattern.
subreaper='import ctypes, os, sys
if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0: sys.exit("Could not track what this run starts (prctl).")
os.execv("/bin/bash", ["bash", "-c"] + sys.argv[1:])'
printf -v command 'python3 -I -c %q %q -- %q' "$subreaper" "$remote" "$NAME"
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
    protocol/PROTOCOL.md box/src box/dist box/package.json box/bun.lock \
    "${sources[@]}" |
    ssh -o BatchMode=yes "$HOST" "$command"

#!/bin/sh
# Runs the bridge's tests on a Linux machine you reach with SSH, as CONTRIBUTING.md asks of a box
# change, without installing anything there:
#
#   scripts/test-linux.sh [--engine] <ssh-host> <test file>…   (files in box/bridge-tests)
#
# Start it with `scripts/heavy.sh box …`, as the other test runs. This checkout's code, as it is
# now (uncommitted changes too), goes to a folder of its own in the machine's ~/.kuvo-code-test,
# with a Node to run the tests on, and the pnpm and uv some sandbox tests need on the PATH, each
# pinned here by the checksum its maker published and kept in build/linux-test for next time.
# The sandbox runs on the machine's own engine (~/.kuvo-code/engine/<version>/opencode, as Kuvo
# Code installed it; KUVO_TEST_BUN on the machine names another), as do the tests that run the
# engine itself (OPENCODE_TEST_BINARY). Every folder this script points the run at (TMPDIR, npm's
# and uv's caches) is inside that folder, which is removed afterwards. (The XDG_* folders it sets
# too don't reach the tests: their guard, test-safety.js, drops them, and gives the run a home of
# its own in ~/.kuvo-code-test instead, which it removes as the run ends.) It
# says what appeared in the machine's home folder, its ~/.kuvo-code-test and /tmp while it ran
# (their own names, not what's inside them), which should be nothing.
#
# The tests run on that Node (`node --test`), so the boxes they start do too. With --engine they run
# on the engine's own runner instead (`BUN_BE_BUN=1 <engine> test`), as a machine's box runs on it:
# Bun differs from Node in places (its `os.userInfo()` follows HOME), and only this run sees those.
#
# Exits with the tests' status.
set -eu

NODE_VERSION=22.15.1
NODE_X64_SHA256=7dca2ab34ec817aa4781e2e99dfd34d349eff9be86e5d5fbaa7e96cae8ee3179
NODE_ARM64_SHA256=f4ae8ddf7487dfaf7da92fef463ee55cc29d8772d62891361dc3fc8b8e469205
# (pnpm 12 and later are a native program that fetches itself as it first runs: 11 still runs on Node.)
PNPM_VERSION=11.28.10
PNPM_INTEGRITY=sha512-ZyIW8G4VwQm4VHHUnT++0X5vA+rSWN8Iwr9bSlwzMh6/v1lHa86BMl762has4Kx4VI/Qv816UTaek5GCo91Q5A==
UV_VERSION=0.13.6
UV_X64_URL=https://files.pythonhosted.org/packages/5c/43/0688ff5142934238f2812e348f4a24e09b57d48bfb38dd8f850325a0d9de/uv-0.13.6-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl
UV_X64_SHA256=22759b8895e1103578de6fb4cd27e94b4399d021023378d29f01333717751fba
UV_ARM64_URL=https://files.pythonhosted.org/packages/99/3a/451b544e105b3595b27f74535c0d6b1105b1b2dcb9b49ca5282dd27bcbc3/uv-0.13.6-py3-none-manylinux_2_28_aarch64.whl
UV_ARM64_SHA256=2e9a99100abe4f99605366974c4f9fe27f236615e05de8e78c0f357e38f09f97

runner=node
[ "${1-}" = --engine ] && { runner=engine; shift; }
[ $# -ge 2 ] || { echo "Usage: scripts/test-linux.sh [--engine] <ssh-host> <test file>…" >&2; exit 64; }
host=$1
shift
root=$(cd "$(dirname "$0")/.." && pwd)
for file in "$@"; do
    [ -f "$root/box/bridge-tests/$file" ] || { echo "No $file in box/bridge-tests" >&2; exit 64; }
done
engine=$(sed -n 's/.*public static let version = "\(.*\)".*/\1/p' "$root/swift/OpenCodeKit/Sources/OpenCodeKit/OpenCodeKit.swift")
[ -n "$engine" ] || { echo "No engine version in OpenCodeKit.swift" >&2; exit 1; }

case $(ssh "$host" uname -sm) in
    "Linux x86_64") arch=x64; node_sha=$NODE_X64_SHA256; uv_url=$UV_X64_URL; uv_sha=$UV_X64_SHA256 ;;
    "Linux aarch64") arch=arm64; node_sha=$NODE_ARM64_SHA256; uv_url=$UV_ARM64_URL; uv_sha=$UV_ARM64_SHA256 ;;
    *) echo "$host isn't a Linux machine on x86_64 or arm64" >&2; exit 1 ;;
esac

# The tools, fetched once and checked against the checksums above each time they're sent. (Each run
# downloads under a name of its own: two runs at once in one checkout, in the box lane's two slots,
# never write one file together.)
tools=$root/build/linux-test/$arch
mkdir -p "$tools"
fetch() { [ -f "$tools/$1" ] || { curl -fsSL -o "$tools/$1.part.$$" "$2" && mv "$tools/$1.part.$$" "$tools/$1"; } || { rm -f "$tools/$1.part.$$"; echo "Couldn't download $2" >&2; exit 1; }; }
node=node-v$NODE_VERSION-linux-$arch.tar.xz
fetch "$node" "https://nodejs.org/dist/v$NODE_VERSION/$node"
[ "$(shasum -a 256 "$tools/$node" | cut -d' ' -f1)" = "$node_sha" ] || { echo "$node doesn't match nodejs.org's checksum" >&2; exit 1; }
pnpm=pnpm-$PNPM_VERSION.tgz
fetch "$pnpm" "https://registry.npmjs.org/pnpm/-/$pnpm"
[ "sha512-$(openssl dgst -sha512 -binary "$tools/$pnpm" | openssl base64 -A)" = "$PNPM_INTEGRITY" ] || { echo "$pnpm doesn't match npm's integrity" >&2; exit 1; }
uv=$(basename "$uv_url")
fetch "$uv" "$uv_url"
[ "$(shasum -a 256 "$tools/$uv" | cut -d' ' -f1)" = "$uv_sha" ] || { echo "$uv doesn't match PyPI's checksum" >&2; exit 1; }

# What's sent: the code, and the tools ready to run (uv's wheel is its two programs).
send=$(mktemp -d "${TMPDIR:-/tmp}/kuvo-test-linux.XXXXXX")
run=
# (And the machine's folder, whatever stops this: the machine's side removes it too, once it runs.)
trap 'rm -rf "$send"; [ -z "$run" ] || ssh "$host" "rm -rf ~/$run"' EXIT
trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 141' PIPE
mkdir -p "$send/tools/bin" "$send/tools/node" "$send/tools/pnpm"
tar xJf "$tools/$node" -C "$send/tools/node" --strip-components=1
tar xzf "$tools/$pnpm" -C "$send/tools/pnpm" --strip-components=1
unzip -q -j "$tools/$uv" "uv-$UV_VERSION.data/scripts/uv" "uv-$UV_VERSION.data/scripts/uvx" -d "$send/tools/bin"
printf '#!/bin/sh\nexec node "$(dirname "$0")/../pnpm/bin/pnpm.mjs" "$@"\n' > "$send/tools/bin/pnpm"
chmod +x "$send/tools/bin/pnpm" "$send/tools/bin/uv" "$send/tools/bin/uvx"
(cd "$root" && COPYFILE_DISABLE=1 tar --no-xattrs --exclude node_modules --exclude .build -czf "$send/code.tgz" \
    swift/KuvoLink protocol box swift/OpenCodeKit/Sources)
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$send/tools.tgz" -C "$send" tools

run=.kuvo-code-test/linux-$(date +%Y%m%d-%H%M%S)-$$
ssh "$host" "mkdir -p ~/$run"
scp -q "$send/code.tgz" "$send/tools.tgz" "$host:$run/"
# (The machine's side: its own login shell's sh, everything in the run's folder, removed as it ends.)
ssh "$host" sh -s -- "$run" "$engine" "$runner" "$@" <<'EOF'
set -u
T=$HOME/$1
engine=$2
runner=$3
shift 3
trap 'rm -rf "$T"' EXIT
trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 141' PIPE
cd "$T" && mkdir code && tar xzf code.tgz -C code && tar xzf tools.tgz && rm code.tgz tools.tgz || exit 1
export TMPDIR=$T/tmp XDG_CONFIG_HOME=$T/xdg/config XDG_DATA_HOME=$T/xdg/data XDG_CACHE_HOME=$T/xdg/cache XDG_STATE_HOME=$T/xdg/state
export npm_config_cache=$T/xdg/cache/npm UV_CACHE_DIR=$T/xdg/cache/uv
mkdir -p "$TMPDIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
export PATH=$T/tools/bin:$T/tools/node/bin:/usr/local/bin:/usr/bin:/bin
own=$HOME/.kuvo-code/engine/$engine/opencode
# (The engine, for the tests that run it too: OPENCODE_TEST_BINARY.)
export KUVO_TEST_BUN=${KUVO_TEST_BUN:-$own} OPENCODE_TEST_BINARY=${OPENCODE_TEST_BINARY:-${KUVO_TEST_BUN:-$own}}
[ -x "$KUVO_TEST_BUN" ] || { echo "No engine $engine on $(hostname) ($KUVO_TEST_BUN): add the machine in Kuvo Code, which installs it, or set KUVO_TEST_BUN there" >&2; exit 1; }
# (The tests' own folders are in ~/.kuvo-code-test, beside this one.)
seen() { ls -a "$HOME" "$HOME/.kuvo-code-test" /tmp 2>/dev/null; }
seen > "$T/before"
cd "$T/code/box/bridge-tests" || exit 1
if [ "$runner" = engine ]; then
    # (Bun's runner wants paths that start with ./, and gives each test 5 seconds unless told more.)
    BUN_BE_BUN=1 "$KUVO_TEST_BUN" test --timeout 120000 $(for file in "$@"; do printf './%s ' "$file"; done)
    status=$?
    # (Bun's runner ends without telling test-safety.js, whose next run clears what this one left.)
    node --input-type=module -e 'await import("./test-safety.js")'
    (exit $status)
else
    node --test "$@"
fi
status=$?
seen > "$T/after"
if ! diff -q "$T/before" "$T/after" > /dev/null; then
    echo "New in $HOME or /tmp while it ran (check they're not from these tests, or from another run beside this one):"
    diff "$T/before" "$T/after" | sed -n 's/^> /  /p'
fi
exit $status
EOF

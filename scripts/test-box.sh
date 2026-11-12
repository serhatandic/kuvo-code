#!/bin/bash
# Run the box and machine bridge suites in a slot of heavy.sh's box lane (two runs may go at once).
set -u
root=$(cd "$(dirname "$0")/.." && pwd -P)
mode=${1:-all}
case "$mode" in box|bridge|all) [ $# -eq 0 ] || shift ;; *) echo 'Usage: scripts/test-box.sh [box|bridge|all] [extra test args...]' >&2; exit 64 ;; esac
if ! "$root/scripts/heavy.sh" --holds box; then
    exec "$root/scripts/heavy.sh" box "$0" "$mode" "$@"
fi
bun=${KUVO_TEST_BUN:-$HOME/.bun/bin/bun}
export KUVO_TEST_BUN="$bun" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
box="$root/Packages/Box"
if [ ! -d "$box/node_modules" ] || [ "$box/bun.lock" -nt "$box/node_modules" ]; then
    echo 'Installing locked box dependencies...'
    (cd "$box" && "$bun" install --frozen-lockfile) || { echo 'Dependency installation failed; suites not run.' >&2; exit 1; }
fi
logs=$(mktemp -d /tmp/kuvo-test-box.XXXXXXXX) || exit 1
export TMPDIR="$logs"
trap 'rm -rf "$logs"' EXIT
box_status=skip bridge_status=skip
if [ "$mode" != bridge ]; then
    echo 'Running box suite...'
    (cd "$box" && "$bun" test "$@") >"$logs/box" 2>&1
    status=$?; cat "$logs/box"
    if [ "$status" -eq 0 ]; then box_status=pass; else box_status=fail; fi
fi
if [ "$mode" != box ]; then
    echo 'Running bridge suite...'
    set +u # macOS Bash 3 treats empty arrays as unset.
    bridge_args=() bridge_files=()
    for arg in "$@"; do
        case "$arg" in
            *.test.js) case "$arg" in */*) bridge_files+=("$arg") ;; *) bridge_files+=("Tests/Bridge/$arg") ;; esac ;;
            *) bridge_args+=("$arg") ;;
        esac
    done
    if [ ${#bridge_files[@]} -eq 0 ]; then
        (cd "$root/Packages/KuvoLink" && node --test "${bridge_args[@]}" Tests/Bridge/*.test.js) >"$logs/bridge" 2>&1
    else
        (cd "$root/Packages/KuvoLink" && node --test "${bridge_args[@]}" "${bridge_files[@]}") >"$logs/bridge" 2>&1
    fi
    status=$?; set -u; cat "$logs/bridge"
    if [ "$status" -eq 0 ]; then bridge_status=pass; else bridge_status=fail; fi
fi
printf '\nSummary:\n'
for suite in box bridge; do
    eval "result=\${${suite}_status}"
    printf '%s: %s\n' "$suite" "$result"
    if [ -f "$logs/$suite" ]; then
        if [ "$suite" = box ]; then
            grep -E '^ *[0-9]+ (pass|fail|skip)|^\(fail\)' "$logs/$suite" || true
        else
            grep -E '^(# |ℹ )(tests|pass|fail|skipped) |^not ok |^✖ ' "$logs/$suite" || true
        fi
    fi
done
case "$root/" in "$HOME/.kuvo-code/"*) echo 'Sandbox tests need a checkout outside ~/.kuvo-code to exercise the sandbox correctly.' ;; esac
[ "$box_status" != fail ] && [ "$bridge_status" != fail ]

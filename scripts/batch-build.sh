#!/bin/sh
# Builds main once for testing: a batch (scripts/batch.sh), which test runs then use without building
# anything (scripts/test-app.sh --from-batch, and the phone's). At 04:00 and 16:00 the sessions' runs
# take turns on that one build instead of each building the app again from its own worktree.
#
#   scripts/batch-build.sh [mac|phone|all]
#       A batch of each (all, the default: the Mac's, then the phone's): main's sources exported
#       into a new folder, $(getconf DARWIN_USER_CACHE_DIR)KuvoBatch/<mac|phone>/<when>-<commit>/,
#       and built there from nothing with `xcodebuild build-for-testing`, as the tests' own copy
#       (run.kuvo.code.tests, run.kuvo.code.ios.tests: the settings scripts/test-app.sh builds
#       with), in a slot of heavy.sh's build lane (mac-build, phone-build). Once it's built, its
#       stamp says from which commits, when, and where its .xctestrun is. The phone's batch is built
#       with kuvo-ai's commit beside it, whose packages it uses. The newest 2 batches are kept;
#       older ones go, once no test run has them open.
#   scripts/batch-build.sh --compile-only [mac|phone|all]
#       Only whether main compiles, the app and its tests (build-for-testing): in one folder kept
#       from run to run (KuvoBatch/compile), whose sources are brought to main's file by file, so
#       only what changed since the last check is compiled again. For after each merge.
#
#   KUVO_BATCH_MAC_REF, KUVO_BATCH_PHONE_REF    the commits to build (each checkout's main by default)
#   KUVO_BATCH_MAC_REPO, KUVO_BATCH_PHONE_REPO  the checkouts (~/Projects/kuvo-ai, ~/Projects/kuvo-code-ios)
#   KUVO_BATCH_DIR                              where the batches go, instead (for its tests)
#
# One build of each platform's batches at a time, and one compile check: a second one started
# meanwhile says so and stops (KuvoBatch/<mac|phone>/build.lock, KuvoBatch/compile/build.lock),
# before it waits for anything. Nothing it does touches the checkouts: it only reads them.
set -eu
cd "$(dirname "$0")/.."
SCRIPTS="$PWD/scripts"
ROOT="${KUVO_BATCH_DIR:-$(getconf DARWIN_USER_CACHE_DIR 2>/dev/null || echo "${TMPDIR:-/tmp}/")KuvoBatch}"
ROOT="${ROOT%/}"
MAC_REPO="${KUVO_BATCH_MAC_REPO:-$HOME/Projects/kuvo-ai}"
PHONE_REPO="${KUVO_BATCH_PHONE_REPO:-$HOME/Projects/kuvo-code-ios}"

usage() {
    echo "Usage: scripts/batch-build.sh [--compile-only] [mac|phone|all]" >&2
    exit 64
}

# The canonical heavy.sh, as scripts/test-app.sh takes it.
HEAVY="${KUVO_HEAVY_SH:-}"
if [ -z "$HEAVY" ]; then
    HEAVY="${KUVO_HEAVY_CANONICAL-$HOME/Projects/kuvo-ai/scripts/heavy.sh}"
    [ -n "$HEAVY" ] && [ -f "$HEAVY" ] || HEAVY="$SCRIPTS/heavy.sh"
fi

short() { echo "$1" | cut -c1-9; }
took() { echo "$(($1 / 60))m$(printf %02d $(($1 % 60)))s"; }

# A commit's files, exported into a new folder.
export_tree() {
    mkdir -p "$3"
    git --no-optional-locks -C "$1" archive --format=tar "$2" > "$3.tar"
    tar -xf "$3.tar" -C "$3"
    rm -f "$3.tar"
}

# A kept folder brought to a commit's files, with an index of its own (the checkout's is never
# touched): a file that's the same keeps its time, so the build compiles only what changed; one
# that changed is written again, one that's gone is removed, and a missing index writes them all.
update_tree() {
    mkdir -p "$3"
    GIT_INDEX_FILE="$4" git --no-optional-locks -C "$1" --work-tree="$3" read-tree --reset -u "$2"
}

# One platform's build (batch or compile), under its lock: <mode> <platform> <kuvo-ai commit> <phone commit>.
one() {
    mode=$1
    platform=$2
    mac_commit=$3
    phone_commit=$4
    started=$(date +%s)
    commit=$mac_commit
    [ "$platform" = mac ] || commit=$phone_commit
    if [ "$mode" = batch ]; then
        name="$(date +%Y%m%d-%H%M%S)-$(echo "$commit" | cut -c1-7)"
        # (Two in one second: the second waits for the next.)
        while [ -e "$ROOT/$platform/$name" ]; do
            sleep 1
            name="$(date +%Y%m%d-%H%M%S)-$(echo "$commit" | cut -c1-7)"
        done
        dir="$ROOT/$platform/$name"
        src="$dir/src"
        build="$dir/build"
        log="$dir/build.log"
        began="$dir/began"
        packages="$ROOT/packages/$platform"
        # Not done, it's removed: an interrupted build leaves no batch behind.
        trap 'rm -rf "$dir"' EXIT
        trap 'exit 129' HUP
        trap 'exit 130' INT
        trap 'exit 143' TERM
        export_tree "$MAC_REPO" "$mac_commit" "$src/kuvo-ai"
        [ "$platform" = mac ] || export_tree "$PHONE_REPO" "$phone_commit" "$src/kuvo-code-ios"
    else
        dir="$ROOT/compile"
        src="$dir/src"
        build="$dir/$platform-build"
        log="$dir/$platform.log"
        began="$dir/$platform.began"
        packages="$dir/$platform-packages"
        rm -f "$dir/$platform.last"
        update_tree "$MAC_REPO" "$mac_commit" "$src/kuvo-ai" "$dir/kuvo-ai.index"
        [ "$platform" = mac ] || update_tree "$PHONE_REPO" "$phone_commit" "$src/kuvo-code-ios" "$dir/kuvo-code-ios.index"
    fi
    if [ "$platform" = mac ]; then
        lane=mac-build
        what="kuvo-ai $(short "$mac_commit")"
        set -- -project "$src/kuvo-ai/KuvoCode.xcodeproj" -scheme KuvoCode -destination "platform=macOS,arch=$(uname -m)" \
            APP_BUNDLE_ID=run.kuvo.code.tests CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM=
    else
        lane=phone-build
        what="kuvo-code-ios $(short "$phone_commit") with kuvo-ai $(short "$mac_commit")"
        # For the simulators of this Mac's own kind (a generic destination builds every kind).
        set -- -project "$src/kuvo-code-ios/KuvoCodeMobile.xcodeproj" -scheme KuvoCodeMobile -destination "generic/platform=iOS Simulator" \
            APP_BUNDLE_ID=run.kuvo.code.ios.tests ARCHS="$(uname -m)"
    fi
    set -- build-for-testing "$@" -derivedDataPath "$build" -clonedSourcePackagesDirPath "$packages"
    mkdir -p "$dir" "$packages"
    rm -f "$began"
    echo "Building $what for the $platform ($mode)…" >&2
    status=0
    "$HEAVY" "$lane" /bin/sh -c 'date +%s > "$1"; log=$2; shift 2; exec xcodebuild "$@" > "$log" 2>&1' sh "$began" "$log" "$@" || status=$?
    ended=$(date +%s)
    from=$ended
    [ ! -f "$began" ] || read -r from < "$began" || true
    timing="$(took $((ended - from))) building, $(took $((from - started))) waiting for its turn"
    if [ "$status" -eq 0 ] && [ "$mode" = batch ]; then
        xctestrun=$(ls -1 "$build"/Build/Products/*.xctestrun 2>/dev/null || true)
        case "$xctestrun" in
            "" | *"
"*)
                echo "The build made $(printf '%s' "$xctestrun" | grep -c . || true) .xctestrun files, not one." >&2
                status=1
                ;;
        esac
    fi
    if [ "$status" -ne 0 ]; then
        grep -aE 'error:|\*\* (TEST )?BUILD' "$log" 2>/dev/null | grep -v 'warning:' | head -n 40 >&2 || true
        if [ "$mode" = batch ]; then
            mkdir -p "$ROOT/$platform"
            mv -f "$log" "$ROOT/$platform/failed-$name.log" 2>/dev/null || true
            echo "The $platform batch of $what didn't build ($timing). The whole log: $ROOT/$platform/failed-$name.log" >&2
        else
            echo "failed $commit $mac_commit $(date +%Y-%m-%dT%H:%M:%S%z)" > "$dir/$platform.last"
            echo "$what doesn't compile for the $platform ($timing). The whole log: $log" >&2
        fi
        return 1
    fi
    if [ "$mode" = compile ]; then
        echo "compiles $commit $mac_commit $(date +%Y-%m-%dT%H:%M:%S%z)" > "$dir/$platform.last"
        echo "$what compiles for the $platform ($timing)."
        return 0
    fi
    # What the tests don't use: the build's intermediate files, its index and module cache.
    rm -rf "$build/Build/Intermediates.noindex" "$build/Index.noindex" "$build/ModuleCache.noindex"
    {
        echo "platform=$platform"
        echo "kuvo_ai=$mac_commit"
        echo "kuvo_ai_subject=$(git --no-optional-locks -C "$MAC_REPO" log -1 --format=%s "$mac_commit")"
        if [ "$platform" = phone ]; then
            echo "kuvo_code_ios=$phone_commit"
            echo "kuvo_code_ios_subject=$(git --no-optional-locks -C "$PHONE_REPO" log -1 --format=%s "$phone_commit")"
        fi
        echo "built=$(date +%Y-%m-%dT%H:%M:%S%z)"
        echo "build_seconds=$((ended - from))"
        echo "xctestrun=$xctestrun"
    } > "$dir/stamp.tmp"
    mv -f "$dir/stamp.tmp" "$dir/stamp"
    trap - EXIT HUP INT TERM
    echo "Built the $platform batch $name, $what ($timing)."
    /bin/sh "$SCRIPTS/batch.sh" prune "$platform" || true
}

if [ "${1:-}" = --one ]; then
    shift
    one "$@"
    exit
fi

mode=batch
if [ "${1:-}" = --compile-only ]; then
    mode=compile
    shift
fi
[ $# -le 1 ] || usage
case "${1:-all}" in
    mac) platforms=mac ;;
    phone) platforms=phone ;;
    all) platforms="mac phone" ;;
    *) usage ;;
esac

# The commits, both taken now, before either builds.
resolve() {
    if ! git --no-optional-locks -C "$1" rev-parse -q --verify "$2^{commit}" 2>/dev/null; then
        echo "scripts/batch-build.sh: no commit $2 in $1." >&2
        exit 1
    fi
}
mac_commit=$(resolve "$MAC_REPO" "${KUVO_BATCH_MAC_REF:-main}")
phone_commit=-
case "$platforms" in *phone*) phone_commit=$(resolve "$PHONE_REPO" "${KUVO_BATCH_PHONE_REF:-main}") ;; esac

status=0
for platform in $platforms; do
    lock="$ROOT/$platform/build.lock"
    [ "$mode" = batch ] || lock="$ROOT/compile/build.lock"
    mkdir -p "$(dirname "$lock")"
    if ! lockf -ks -t 0 "$lock" true; then
        echo "Another $([ "$mode" = batch ] && echo "build of the $platform batch" || echo "compile check") is running: it holds $lock." >&2
        status=75
        continue
    fi
    lockf -k -t 0 "$lock" /bin/sh "$SCRIPTS/batch-build.sh" --one "$mode" "$platform" "$mac_commit" "$phone_commit" || status=$?
done
exit "$status"

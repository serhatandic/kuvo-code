#!/bin/sh
# The batches: main built once for testing (scripts/batch-build.sh), which test runs then use without
# building anything (scripts/test-app.sh --from-batch, and the phone's). A batch is a folder of its
# own, <when>-<commit>, in $(getconf DARWIN_USER_CACHE_DIR)KuvoBatch/<mac|phone>/: the sources it was
# built from (src/), the build (build/) and, once the build is done, its stamp (stamp: the commits,
# when, the .xctestrun). A folder without a stamp is a build that isn't done, or never was.
#
#   scripts/batch.sh open <mac|phone> <pid>          the newest batch, kept open for the run <pid>: no
#                                                    prune deletes it while that process runs (prints
#                                                    its folder)
#   scripts/batch.sh close <folder> <pid>            that run is over
#   scripts/batch.sh check <folder> <repo> <name>…   whether the batch has these tests (ONLY's names,
#                                                    like KuvoCodeTests/WindowTabsTests): says which it
#                                                    hasn't, and exits 1 then
#   scripts/batch.sh behind <folder> <repo> <checkout>  warns when the checkout's HEAD isn't in the batch
#   scripts/batch.sh describe <folder>               a line: the batch, its commits, when it was built
#   scripts/batch.sh prune <mac|phone>              keeps the newest 2 batches, and deletes the others
#                                                    no run has open, and builds that aren't done (only
#                                                    batch-build.sh runs it, holding the platform's
#                                                    build lock, so none is being built)
#
#   KUVO_BATCH_DIR   where the batches are, instead (for its tests)
#
# open and prune each run under the platform's guard lock (KuvoBatch/<platform>/guard), for
# milliseconds, so a prune never deletes a batch a run is just opening.
set -eu
export LC_ALL=C

ROOT="${KUVO_BATCH_DIR:-$(getconf DARWIN_USER_CACHE_DIR 2>/dev/null || echo "${TMPDIR:-/tmp}/")KuvoBatch}"
ROOT="${ROOT%/}"
KEEP=2
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

usage() {
    echo "Usage: scripts/batch.sh open|close|check|behind|describe|prune …" >&2
    exit 64
}

platform_ok() { case "${1:-}" in mac | phone) ;; *) usage ;; esac; }

# A value from a batch's stamp.
field() { sed -n "s/^$2=//p" "$1/stamp" 2>/dev/null | head -n 1; }

# A process that's gone: not one a sandbox only refuses to signal.
gone() {
    ! kill -0 "$1" 2>/dev/null && case "$(kill -0 "$1" 2>&1)" in *"No such process"*) true ;; *) false ;; esac
}

# Whether a run has the batch open (one whose process is gone has it no longer).
in_use() {
    for run in "$1"/runs/*; do
        [ -e "$run" ] || continue
        pid=${run##*/}
        case "$pid" in "" | *[!0-9]*) continue ;; esac
        if gone "$pid"; then rm -f "$run"; else return 0; fi
    done
    return 1
}

# The newest batch that's done (names sort by when they were built).
latest() {
    found=
    for folder in "$ROOT/$1"/*/; do
        folder=${folder%/}
        [ -f "$folder/stamp" ] && found=$folder
    done
    [ -n "$found" ] && echo "$found"
}

describe() {
    line="batch $(basename "$1"): kuvo-ai $(field "$1" kuvo_ai | cut -c1-9)"
    [ -z "$(field "$1" kuvo_code_ios)" ] || line="batch $(basename "$1"): kuvo-code-ios $(field "$1" kuvo_code_ios | cut -c1-9) with kuvo-ai $(field "$1" kuvo_ai | cut -c1-9)"
    echo "$line, built $(field "$1" built)"
}

# Runs the rest under the platform's guard lock.
guarded() {
    mkdir -p "$ROOT/$2"
    exec lockf -k "$ROOT/$2/guard" /bin/sh "$SELF" --guarded "$@"
}

[ $# -ge 1 ] || usage
if [ "$1" = --guarded ]; then
    shift
else
    case "$1" in open | prune) guarded "$@" ;; esac
fi
command=$1
shift
case "$command" in
    open)
        [ $# -eq 2 ] || usage
        platform_ok "$1"
        if ! batch=$(latest "$1"); then
            echo "There's no $1 batch yet: scripts/batch-build.sh $1 makes one (it's made at 04:00 and 16:00)." >&2
            exit 1
        fi
        mkdir -p "$batch/runs"
        : > "$batch/runs/$2"
        echo "$batch"
        ;;
    close)
        [ $# -eq 2 ] || usage
        rm -f "$1/runs/$2"
        ;;
    describe)
        [ $# -eq 1 ] || usage
        describe "$1"
        ;;
    check)
        [ $# -ge 3 ] || usage
        batch=$1
        src="$1/src/$2"
        shift 2
        missing=
        for name in "$@"; do
            target=${name%%/*}
            rest=${name#"$target"}
            rest=${rest#/}
            type=${rest%%/*}
            test=${rest#"$type"}
            test=${test#/}
            test=${test%%(*}
            has=1
            case "$target$type" in "" | *[!A-Za-z0-9_]*) has= ;; esac
            # (A test named in backticks isn't looked for: its suite is.)
            case "$test" in *[!A-Za-z0-9_]*) test= ;; esac
            if [ -n "$has" ] && ! [ -d "$src/$target" ]; then has=; fi
            if [ -n "$has" ] && [ -n "$type" ] &&
                ! grep -rqE --include='*.swift' "(struct|class|enum|actor|extension)[[:space:]]+$type([^A-Za-z0-9_]|\$)" "$src/$target"; then has=; fi
            if [ -n "$has" ] && [ -n "$test" ] &&
                ! grep -rqE --include='*.swift' "func[[:space:]]+$test([^A-Za-z0-9_]|\$)" "$src/$target"; then has=; fi
            [ -n "$has" ] || missing="$missing $name"
        done
        if [ -n "$missing" ]; then
            echo "Not in the $(describe "$batch"):$missing." >&2
            echo "  Merged to main after that build, or misspelled. Tests merged since run in the next batch (04:00 and 16:00)." >&2
            exit 1
        fi
        ;;
    behind)
        [ $# -eq 3 ] || usage
        key=kuvo_ai
        [ "$2" != kuvo-code-ios ] || key=kuvo_code_ios
        commit=$(field "$1" "$key")
        head=$(git --no-optional-locks -C "$3" rev-parse -q --verify HEAD 2>/dev/null) || exit 0
        # (Another repository's checkout, which doesn't have the batch's commit, says nothing.)
        git --no-optional-locks -C "$3" cat-file -e "$commit^{commit}" 2>/dev/null || exit 0
        if ! git --no-optional-locks -C "$3" merge-base --is-ancestor "$head" "$commit" 2>/dev/null; then
            echo "Note: your HEAD ($(echo "$head" | cut -c1-9)) isn't in this batch: what it adds since main at $(echo "$commit" | cut -c1-9) isn't what's tested." >&2
        fi
        ;;
    prune)
        [ $# -eq 1 ] || usage
        platform_ok "$1"
        kept=0
        for folder in "$ROOT/$1"/*/; do [ -d "$folder" ] && echo "${folder%/}"; done | sort -r | while IFS= read -r folder; do
            if [ -f "$folder/stamp" ] && [ "$kept" -lt "$KEEP" ]; then
                kept=$((kept + 1))
                continue
            fi
            if in_use "$folder"; then
                echo "Kept $(basename "$folder"): a test run has it open (it's deleted after the next build)." >&2
                continue
            fi
            rm -rf "$folder"
        done
        # The logs of builds that failed: the newest few.
        for log in $(ls -1 "$ROOT/$1"/failed-*.log 2>/dev/null | sort -r | tail -n +4); do rm -f "$log"; done
        ;;
    *) usage ;;
esac

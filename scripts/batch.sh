#!/bin/sh
# The batches: main built once for testing (scripts/batch-build.sh), which test runs then use without
# building anything (scripts/test-app.sh --from-batch, and the phone's). A batch is a folder of its
# own, <when>-<commit>, in $(getconf DARWIN_USER_CACHE_DIR)KuvoBatch/<mac|phone>/: the sources it was
# built from (src/), the build (build/) and, once the build is done, its stamp (stamp: the commits,
# when, the .xctestrun). A folder without a stamp is a build that isn't done, or never was; a build
# that failed leaves failed-<when>-<commit>.stamp (its commit, why) and .log instead.
#
#   scripts/batch.sh open <mac|phone> <pid>          the newest batch, kept open for the run <pid>: no
#                                                    prune deletes it while that process runs (prints
#                                                    its folder). While a batch is being built it waits
#                                                    for it, and takes that one; when the newest build
#                                                    failed or stopped, it refuses, saying why.
#   scripts/batch.sh close <folder> <pid>            that run is over
#   scripts/batch.sh check <folder> <repo> <name>…   whether the batch has these tests (ONLY's names,
#                                                    like KuvoCodeTests/WindowTabsTests): says which it
#                                                    hasn't, and exits 1 then. It looks for each suite
#                                                    and test by name in the batch's sources: a test
#                                                    added to a suite the batch has, under another
#                                                    suite's name, isn't noticed (xcodebuild then runs
#                                                    nothing for it).
#   scripts/batch.sh behind <folder> <repo> <checkout>  warns when the checkout's HEAD isn't in the batch
#   scripts/batch.sh describe <folder>               a line: the batch, its commits, when it was built
#   scripts/batch.sh stamp <folder>                  the batch's name and its stamp, line by line
#   scripts/batch.sh prune <mac|phone>               keeps the newest 2 batches, and deletes the others
#                                                    no run has open, and builds that aren't done (only
#                                                    batch-build.sh runs it, holding the platform's
#                                                    build lock, so none is being built)
#
#   KUVO_BATCH_DIR   where the batches are, instead (for its tests)
#
# open and prune each look and change under the platform's guard lock (KuvoBatch/<platform>/guard),
# so a prune never deletes a batch a run is just opening; prune only moves what it deletes aside
# there, and deletes it after. A run is known by its pid alone: one whose process is gone has
# closed it (a pid taken since by another process only keeps a batch longer, never deletes one).
set -eu
export LC_ALL=C

ROOT="${KUVO_BATCH_DIR:-$(getconf DARWIN_USER_CACHE_DIR 2>/dev/null || echo "${TMPDIR:-/tmp}/")KuvoBatch}"
mkdir -p "$ROOT"
ROOT=$(cd "$ROOT" && pwd)
KEEP=2
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

usage() {
    echo "Usage: scripts/batch.sh open|close|check|behind|describe|stamp|prune …" >&2
    exit 64
}

platform_ok() { case "${1:-}" in mac | phone) ;; *) usage ;; esac; }

# A value from a stamp ($1 a batch's folder, or a failed build's stamp file).
field() {
    file=$1
    [ -d "$file" ] && file="$file/stamp"
    sed -n "s/^$2=//p" "$file" 2>/dev/null | head -n 1
}

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

# The newest of these names.
newest() { printf '%s\n' "$@" | sort | tail -n 1; }

describe() {
    line="batch $(basename "$1"): kuvo-ai $(field "$1" kuvo_ai | cut -c1-9)"
    [ -z "$(field "$1" kuvo_code_ios)" ] || line="batch $(basename "$1"): kuvo-code-ios $(field "$1" kuvo_code_ios | cut -c1-9) with kuvo-ai $(field "$1" kuvo_ai | cut -c1-9)"
    echo "$line, built $(field "$1" built)"
}

# Whether the batch's sources have a type, or a function, of this name.
has_type() { grep -rqE --include='*.swift' "(struct|class|enum|actor|extension)[[:space:]]+$2([^A-Za-z0-9_]|\$)" "$1"; }
has_func() { grep -rqE --include='*.swift' "func[[:space:]]+$2([^A-Za-z0-9_]|\$)" "$1"; }
identifier() { case "$1" in "" | [0-9]* | *[!A-Za-z0-9_]*) return 1 ;; esac; }

# Whether a name of ONLY's is in the sources ($1, the repository's): <target>[/<suite>…][/<test>].
# (Its variables start with _: the caller's are its own.)
has_test() {
    _src=$1
    _target=${2%%/*}
    _rest=${2#"$_target"}
    _rest=${_rest#/}
    identifier "$_target" && [ -d "$_src/$_target" ] || return 1
    [ -n "$_rest" ] || return 0
    set -f
    _ifs=$IFS
    IFS=/
    # shellcheck disable=SC2086 # (split at each /)
    set -- $_rest
    IFS=$_ifs
    set +f
    while [ $# -gt 1 ]; do
        identifier "$1" && has_type "$_src/$_target" "$1" || return 1
        shift
    done
    case "$1" in
        *"("*)
            # A test (with its parentheses). One named in backticks isn't looked for: its suite is.
            _fn=${1%%(*}
            ! identifier "$_fn" || has_func "$_src/$_target" "$_fn"
            ;;
        *)
            # A suite, or a test without its parentheses.
            identifier "$1" && { has_type "$_src/$_target" "$1" || has_func "$_src/$_target" "$1"; }
            ;;
    esac
}

[ $# -ge 1 ] || usage
if [ "$1" = --guarded ]; then
    shift
    guarded=1
else
    guarded=
fi
command=$1
shift
case "$command" in
    open)
        [ $# -eq 2 ] || usage
        platform_ok "$1"
        mkdir -p "$ROOT/$1"
        build_lock="$ROOT/$1/build.lock"
        if [ -z "$guarded" ]; then
            # A batch being built now is the one to test: wait for it (its lock), then look.
            said=
            while :; do
                # (Another run looking holds it for a moment, as this does: a build holds it a while.)
                if ! lockf -ks -t 1 "$build_lock" true; then
                    [ -n "$said" ] || echo "Waiting for the $1 batch being built now, to test that one…" >&2
                    said=1
                    lockf -ks "$build_lock" true
                fi
                status=0
                lockf -k "$ROOT/$1/guard" /bin/sh "$SELF" --guarded open "$@" || status=$?
                # (75: another build started meanwhile.)
                [ "$status" = 75 ] || exit "$status"
            done
        fi
        lockf -ks -t 0 "$build_lock" true || exit 75
        batch=$(latest "$1") || batch=
        # The newest build: done, failed, or stopped before it was (a folder without a stamp).
        last_folder=
        for folder in "$ROOT/$1"/*/; do [ -d "$folder" ] && last_folder=$(basename "$folder"); done
        last_failed=
        for stamp in "$ROOT/$1"/failed-*.stamp; do [ -f "$stamp" ] && last_failed=$(basename "$stamp" .stamp) && last_failed=${last_failed#failed-}; done
        last=$(newest "$last_folder" "$last_failed")
        # (A build that started as this looked: wait for it.)
        lockf -ks -t 0 "$build_lock" true || exit 75
        if [ -n "$last" ] && [ "$last" != "$(basename "${batch:-/}")" ]; then
            if [ "$last" = "$last_failed" ] && [ "$last" != "$last_folder" ]; then
                failed="$ROOT/$1/failed-$last.stamp"
                what="kuvo-ai $(field "$failed" kuvo_ai | cut -c1-9) “$(field "$failed" kuvo_ai_subject)”"
                [ -z "$(field "$failed" kuvo_code_ios)" ] || what="kuvo-code-ios $(field "$failed" kuvo_code_ios | cut -c1-9) “$(field "$failed" kuvo_code_ios_subject)” with kuvo-ai $(field "$failed" kuvo_ai | cut -c1-9)"
                echo "The newest $1 batch didn't build: $what, at $(field "$failed" failed)." >&2
                echo "  Why: $(field "$failed" why)" >&2
                echo "  The whole log: $(field "$failed" log)" >&2
            else
                echo "The newest $1 batch, $last, stopped before it was built." >&2
            fi
            echo "  Nothing is tested from an older batch meanwhile: the next batch that builds is (scripts/batch-build.sh $1)." >&2
            exit 1
        fi
        if [ -z "$batch" ]; then
            echo "There's no $1 batch yet: scripts/batch-build.sh $1 makes one (it's made at 04:00 and 16:00)." >&2
            exit 1
        fi
        mkdir -p "$batch/runs"
        : > "$batch/runs/$2"
        echo "$batch"
        ;;
    close)
        [ $# -eq 2 ] || usage
        [ -z "$2" ] || rm -f "$1/runs/$2"
        ;;
    describe)
        [ $# -eq 1 ] || usage
        describe "$1"
        ;;
    stamp)
        [ $# -eq 1 ] || usage
        echo "batch $(basename "$1"):"
        sed 's/^/  /' "$1/stamp"
        ;;
    check)
        [ $# -ge 3 ] || usage
        batch=$1
        src="$1/src/$2"
        shift 2
        missing=
        for name in "$@"; do
            has_test "$src" "$name" || missing="$missing $name"
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
        if [ -z "$guarded" ]; then
            mkdir -p "$ROOT/$1"
            lockf -k "$ROOT/$1/guard" /bin/sh "$SELF" --guarded prune "$1"
            rm -rf "$ROOT/$1"/.trash-*
            exit 0
        fi
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
            mv "$folder" "$ROOT/$1/.trash-$(basename "$folder")"
        done
        # The failed builds' stamps and logs: the newest few.
        for stamp in $(ls -1 "$ROOT/$1"/failed-*.stamp 2>/dev/null | sort -r | tail -n +4); do rm -f "$stamp" "${stamp%.stamp}.log"; done
        ;;
    *) usage ;;
esac

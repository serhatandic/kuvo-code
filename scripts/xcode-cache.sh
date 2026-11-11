# Xcode's compilation cache, one for every checkout's builds. Sourced (scripts/heavy.sh for its Xcode
# lanes, scripts/test-app.sh, scripts/build-app.sh); `xcode_cache <this folder>` turns it on for the
# xcodebuild runs that follow.
#
# A build folder (DerivedData) only reuses what was built from the same paths, and each worktree is
# at a path of its own: so every session's first build or test run compiled the app and all its
# packages again, 30 minutes and more on a busy Mac. Xcode's compilation cache
# (COMPILATION_CACHE_ENABLE_CACHING, Xcode 26 and later) keeps what each compile makes in a
# content-addressed store (a CAS), under a key that hashes everything that goes into the compile: the
# sources and headers it reads, its flags, the compiler. With prefix mapping (the *_PREFIX_MAPPING
# settings) the key leaves out where the checkout, the build folder, the SDK and Xcode are, so the
# same code compiled in another worktree, or another build folder, replays what's stored instead of
# compiling again. Code that differs has another key: one branch never gets another's results.
# The compilers run in their own project's folder (COMPILER_WORKING_DIRECTORY), which that mapping
# covers: by default a package's compiles run in the app's .xcodeproj, a path the package's mapping
# leaves in its keys, and no package compiled in one worktree was reused in another.
#
# What the mapping changes: the compiler sees the sources as /^src/… (the project's folder), so
# #filePath is /^src/… too, and so are the places a test failure names (Xcode maps compiler errors
# and the debugger back). A test finds its files through its bundle, never #filePath, in what
# xcodebuild builds (scripts/test-app.sh checks the app's); the packages' tests that do run under
# `swift test`, which this doesn't touch.
#
# One store for all of this user's builds: KuvoCompilationCache in their cache folder (getconf
# DARWIN_USER_CACHE_DIR; KUVO_XCODE_CACHE_DIR for another folder). A CAS is made for many builds at
# once (Xcode shares one across every project by default). Xcode prunes it after a build, to
# KUVO_XCODE_CACHE_SIZE (20G unless set: a whole number with K, M, G or T), but only once no build
# has it open: on a Mac that's never without one, it grows past that until there's a quiet moment,
# and this says so when it's twice the size. Clear it by deleting the folder while no Xcode build
# runs.
#
# The settings are scripts/xcode-cache.xcconfig, beside this, which xcodebuild applies over the
# project's (those on its command line still win) through XCODE_XCCONFIG_FILE, the store's folder
# and size through the environment: so a caller changes nothing. A caller with an XCODE_XCCONFIG_FILE
# of its own keeps it, without the cache; KUVO_XCODE_CACHE=0 turns it off, and so does CI (whose
# runner starts empty). Nothing here stops a build: whatever fails, it builds as before, without the
# cache.
xcode_cache() {
    xcode_cache_settings="$(cd "$1" 2>/dev/null && pwd)/xcode-cache.xcconfig"
    if [ "${KUVO_XCODE_CACHE:-1}" = 0 ] || [ -n "${CI:-}" ]; then
        # (Not even one a job this runs in turned on.)
        case "${XCODE_XCCONFIG_FILE:-}" in */xcode-cache.xcconfig) unset XCODE_XCCONFIG_FILE KUVO_XCODE_CAS_PATH KUVO_XCODE_CACHE_SIZE ;; esac
        return 0
    fi
    [ -z "${XCODE_XCCONFIG_FILE:-}" ] && [ -f "$xcode_cache_settings" ] || return 0
    [ "$(uname -s 2>/dev/null)" = Darwin ] || return 0
    xcode_cache_dir="${KUVO_XCODE_CACHE_DIR:-}"
    if [ -z "$xcode_cache_dir" ]; then
        xcode_cache_root=$(getconf DARWIN_USER_CACHE_DIR 2>/dev/null) && [ -n "$xcode_cache_root" ] || return 0
        xcode_cache_dir="${xcode_cache_root%/}/KuvoCompilationCache"
    fi
    xcode_cache_size="${KUVO_XCODE_CACHE_SIZE:-20G}"
    case "$xcode_cache_size" in
        [1-9]K | [1-9][0-9]K | [1-9][0-9][0-9]K | [1-9][0-9][0-9][0-9]K | [1-9][0-9][0-9][0-9][0-9]K | [1-9][0-9][0-9][0-9][0-9][0-9]K) ;;
        [1-9]M | [1-9][0-9]M | [1-9][0-9][0-9]M | [1-9][0-9][0-9][0-9]M | [1-9][0-9][0-9][0-9][0-9]M | [1-9][0-9][0-9][0-9][0-9][0-9]M) ;;
        [1-9]G | [1-9][0-9]G | [1-9][0-9][0-9]G | [1-9][0-9][0-9][0-9]G | [1-9][0-9][0-9][0-9][0-9]G | [1-9][0-9][0-9][0-9][0-9][0-9]G) ;;
        [1-9]T | [1-9][0-9]T | [1-9][0-9][0-9]T) ;;
        *)
            echo "KUVO_XCODE_CACHE_SIZE is a size like 20G (it's $xcode_cache_size): building without the compilation cache." >&2
            return 0
            ;;
    esac
    mkdir -p "$xcode_cache_dir" 2>/dev/null && [ -w "$xcode_cache_dir" ] || return 0
    # Twice its size: Xcode hasn't had the quiet moment it prunes in (above).
    xcode_cache_kb=$(du -sk "$xcode_cache_dir" 2>/dev/null | awk '{ print $1 }')
    xcode_cache_cap_kb=${xcode_cache_size%?}
    case "$xcode_cache_size" in
        *M) xcode_cache_cap_kb=$((xcode_cache_cap_kb * 1024)) ;;
        *G) xcode_cache_cap_kb=$((xcode_cache_cap_kb * 1024 * 1024)) ;;
        *T) xcode_cache_cap_kb=$((xcode_cache_cap_kb * 1024 * 1024 * 1024)) ;;
    esac
    if [ "${xcode_cache_kb:-0}" -gt $((xcode_cache_cap_kb * 2)) ]; then
        echo "Xcode's compilation cache ($xcode_cache_dir) is $((xcode_cache_kb / 1024 / 1024)) GB, over twice its $xcode_cache_size: Xcode prunes it only while no build has it open. Delete the folder while no Xcode build runs." >&2
    fi
    XCODE_XCCONFIG_FILE=$xcode_cache_settings
    KUVO_XCODE_CAS_PATH=$xcode_cache_dir
    KUVO_XCODE_CACHE_SIZE=$xcode_cache_size
    export XCODE_XCCONFIG_FILE KUVO_XCODE_CAS_PATH KUVO_XCODE_CACHE_SIZE
}

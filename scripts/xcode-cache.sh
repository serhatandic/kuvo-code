# Xcode's compilation cache, one for every checkout's builds. Sourced (scripts/heavy.sh for its Xcode
# lanes, scripts/build-app.sh); `xcode_cache` turns it on for the xcodebuild runs that follow.
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
# One store for all of this user's builds: KuvoCompilationCache in their cache folder (getconf
# DARWIN_USER_CACHE_DIR; KUVO_XCODE_CACHE_DIR for another folder). A CAS is made for many builds at once (Xcode shares one across every
# project by default), and Xcode keeps it under COMPILATION_CACHE_LIMIT_SIZE, pruning the oldest after
# a build: KUVO_XCODE_CACHE_SIZE, 20G unless set (a number with K, M, G or T).
#
# It reaches xcodebuild through XCODE_XCCONFIG_FILE, settings xcodebuild applies over the project's
# (those on its command line still win), so a caller changes nothing. A caller with an
# XCODE_XCCONFIG_FILE of its own keeps it, without the cache; KUVO_XCODE_CACHE=0 turns it off.
# Nothing here stops a build: whatever fails, it builds as before, without the cache.
xcode_cache() {
    [ "${KUVO_XCODE_CACHE:-1}" != 0 ] && [ -z "${XCODE_XCCONFIG_FILE:-}" ] || return 0
    [ "$(uname -s 2>/dev/null)" = Darwin ] || return 0
    xcode_cache_dir="${KUVO_XCODE_CACHE_DIR:-}"
    if [ -z "$xcode_cache_dir" ]; then
        xcode_cache_root=$(getconf DARWIN_USER_CACHE_DIR 2>/dev/null) && [ -n "$xcode_cache_root" ] || return 0
        xcode_cache_dir="${xcode_cache_root%/}/KuvoCompilationCache"
    fi
    xcode_cache_size="${KUVO_XCODE_CACHE_SIZE:-20G}"
    case "$xcode_cache_size" in
        *[!0-9KMGT]* | [KMGT]* | *[KMGT]?* | "")
            echo "KUVO_XCODE_CACHE_SIZE is a size like 20G (it's $xcode_cache_size): building without the compilation cache." >&2
            return 0
            ;;
    esac
    # (Written whole and moved into place, so a build starting meanwhile never reads half of it.)
    xcode_cache_settings="// Written by kuvo-ai's scripts/xcode-cache.sh: Xcode's compilation cache, shared by every checkout.
COMPILATION_CACHE_ENABLE_CACHING = YES
COMPILATION_CACHE_CAS_PATH = $xcode_cache_dir
COMPILATION_CACHE_KEEP_CAS_DIRECTORY = YES
COMPILATION_CACHE_LIMIT_SIZE = $xcode_cache_size
SWIFT_ENABLE_PREFIX_MAPPING = YES
SWIFT_ENABLE_PROJECT_PREFIX_MAPPING = YES
CLANG_ENABLE_PREFIX_MAPPING = YES
CLANG_ENABLE_PROJECT_PREFIX_MAPPING = YES
COMPILER_WORKING_DIRECTORY = \$(PROJECT_DIR)"
    xcode_cache_file="$xcode_cache_dir/settings-$xcode_cache_size.xcconfig"
    if [ "$(cat "$xcode_cache_file" 2>/dev/null)" != "$xcode_cache_settings" ]; then
        { mkdir -p "$xcode_cache_dir" &&
            printf '%s\n' "$xcode_cache_settings" > "$xcode_cache_file.$$" &&
            mv -f "$xcode_cache_file.$$" "$xcode_cache_file"; } 2>/dev/null || {
            rm -f "$xcode_cache_file.$$" 2>/dev/null
            return 0
        }
    fi
    XCODE_XCCONFIG_FILE=$xcode_cache_file
    export XCODE_XCCONFIG_FILE
}

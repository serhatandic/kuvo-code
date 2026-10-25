#!/bin/sh
# Keeps tests, measurements and demo copies off the real Kuvo Code. A script that starts a copy of
# the app or its engine checks what it would use first, and stops, naming itself, when that's the
# real app's: its bundle ID (run.kuvo.code), its folder in Application Support (where its engine,
# sessions and sign-ins are) or anything in it, the installed app in /Applications, or its folder
# on machines (.kuvo-code, as KUVO_DEMO_MACHINE_ROOT). A copy of its own (run.kuvo.code.demo,
# .tests, .perf, .e2e, .shots; .kuvo-code-demo…) has folders of its own, and passes.
#
#   . scripts/real-app-guard.sh; real_app_guard <caller> <value>...    (from a shell script)
#   scripts/real-app-guard.sh <caller> <value>...                      (from anything else)
#
# Exits (or returns) 1 when a value is the real app's; empty values are skipped.

real_app_guard() {
    _guard_caller=$1
    shift
    # Its folder as written and with links resolved (macOS names ignore case).
    _guard_support=$(printf '%s' "$HOME/Library/Application Support/run.kuvo.code" | tr '[:upper:]' '[:lower:]')
    _guard_home=$(realpath "$HOME" 2>/dev/null || printf '%s' "$HOME")
    _guard_real_support=$(printf '%s' "$_guard_home/Library/Application Support/run.kuvo.code" | tr '[:upper:]' '[:lower:]')
    _guard_app="/applications/kuvo code.app"
    for _guard_value in "$@"; do
        [ -n "$_guard_value" ] || continue
        # As given, and with links and ".." resolved where it exists.
        _guard_resolved=$(realpath "$_guard_value" 2>/dev/null || printf '%s' "$_guard_value")
        for _guard_candidate in "$_guard_value" "$_guard_resolved"; do
            _guard_lower=$(printf '%s' "$_guard_candidate" | tr '[:upper:]' '[:lower:]')
            case "$_guard_lower" in
            run.kuvo.code | "$_guard_support" | "$_guard_support"/* | "$_guard_real_support" | "$_guard_real_support"/* | \
                "$_guard_app" | "$_guard_app"/* | \
                .kuvo-code | .kuvo-code/ | ./.kuvo-code | "~/.kuvo-code" | */.kuvo-code | */.kuvo-code/)
                echo "$_guard_caller: refusing to start, because $_guard_value is the real Kuvo Code's." >&2
                echo "  Use a copy of its own (run.kuvo.code.demo, .tests, .perf, .e2e or .shots) and its own folders and engine." >&2
                return 1
                ;;
            esac
        done
    done
    return 0
}

# The newest engine a copy of its own (demo, perf, e2e…) downloaded, by version (2.0.32 after
# 2.0.9), never the real app's; nothing when there's none.
newest_copy_engine() {
    ls -d "$HOME/Library/Application Support/run.kuvo.code."*/engine/*/opencode 2>/dev/null |
        awk -F/ '{ print $(NF-1) "\t" $0 }' | sort -V -k1,1 | tail -n 1 | cut -f2
}

# For the one script meant to work on the real app, with someone at the Mac
# (scripts/groups-rehearsal.sh): it goes on only once they type "yes" at the terminal, so a test,
# an agent or anything else without a terminal never gets past it.
real_app_confirm() {
    if ! [ -t 0 ] || ! { : </dev/tty; } 2>/dev/null; then
        echo "$1: refusing to start, because it works on the real Kuvo Code (run.kuvo.code and its folder) and needs someone at the terminal to say so." >&2
        return 1
    fi
    printf '%s works on your real Kuvo Code (run.kuvo.code and its folder). Type yes to go on: ' "$1" >/dev/tty
    read -r _guard_answer </dev/tty || _guard_answer=
    [ "$_guard_answer" = yes ] && return 0
    echo "$1: stopped." >&2
    return 1
}

case "$(basename -- "$0")" in
real-app-guard.sh)
    [ $# -ge 1 ] || { sed -n '2,12p' "$0" >&2; exit 2; }
    real_app_guard "$@"
    exit $?
    ;;
esac

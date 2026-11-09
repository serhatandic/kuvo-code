#!/bin/bash
# Sets up the Mac mini's CI, once: pushes to main and release tags run there, each job in a fresh
# macOS VM (see the `runs-on` of .github/workflows/ci.yml and release.yml, and common.sh). Run it
# as yourself, an administrator, from the checkout:
#
#   scripts/ci-runner/setup.sh            the orchestrator as a LaunchDaemon running as ci
#   scripts/ci-runner/setup.sh --agent    or as a LaunchAgent in ci's login session instead
#
# The daemon needs no one logged in as ci: it starts with the Mac, and the console stays yours
# (the Mac app's tests in your account need your session at the console). The agent needs ci
# logged in, in the background (fast user switching, then back to you), after every restart.
#
# What it does:
#   1. Checks Tart is installed and softnet is setuid root (it filters the VMs' network).
#   2. Copies the scripts ci runs to /Users/Shared/kuvo-ci/scripts, yours and read-only to
#      everyone else (ci can't read your home folder, and mustn't change what it runs).
#   3. Asks for the GitHub token the orchestrator makes runners with (a fine-grained token for
#      serhatandic/kuvo-code only, Administration: read and write, Actions: read), checks it,
#      and keeps it as ci in ~ci/.config/kuvo-ci/github-token, which only ci can read. Press
#      Return to keep the one it has.
#   4. Installs the orchestrator (sudo) and starts it.
#
# The golden image comes from scripts/ci-runner/build-image.sh, before or after this; the
# orchestrator waits for it. Running this again is safe: it puts the scripts and the service back
# and restarts the orchestrator (an idle VM is replaced; a job in progress is cut short, so run
# it between jobs, or with /Users/Shared/kuvo-ci/paused there).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/ci-runner/common.sh
. "$here/common.sh"

CI_USER="${CI_USER:-ci}"
SERVICE="run.kuvo.ci.orchestrator"
DAEMON_PLIST="/Library/LaunchDaemons/$SERVICE.plist"

fail() {
    echo "$1" >&2
    exit 1
}

# The service's plist, for either kind. $1: agent|daemon, $2: ci's home.
service_plist() {
    local daemon_keys=""
    if [[ "$1" == daemon ]]; then
        daemon_keys="    <key>UserName</key>
    <string>$CI_USER</string>
    <key>GroupName</key>
    <string>staff</string>
    <key>SessionCreate</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>$2</string>
        <key>USER</key>
        <string>$CI_USER</string>
        <key>LOGNAME</key>
        <string>$CI_USER</string>
    </dict>
"
    fi
    cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$SERVICE</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$SHARED/scripts/orchestrator.sh</string>
    </array>
${daemon_keys}    <key>WorkingDirectory</key>
    <string>$2</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>60</integer>
    <key>ExitTimeOut</key>
    <integer>60</integer>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>$2/Library/Logs/kuvo-ci/orchestrator.log</string>
    <key>StandardErrorPath</key>
    <string>$2/Library/Logs/kuvo-ci/orchestrator.log</string>
</dict>
</plist>
PLIST
}

# ---- As ci: keep the token, make its folders, install the agent (for --agent). --------------
as_ci() { # agent|daemon
    [[ "$(id -un)" == "$CI_USER" ]] || fail "--as-ci runs as $CI_USER."
    umask 077
    local token plist="$HOME/Library/LaunchAgents/$SERVICE.plist"
    IFS= read -r token || true
    mkdir -p "$HOME/.config/kuvo-ci" "$HOME/Library/Logs/kuvo-ci"
    chmod 700 "$HOME/.config/kuvo-ci"
    touch "$HOME/Library/Logs/kuvo-ci/orchestrator.log"
    if [[ -n "$token" ]]; then
        printf '%s\n' "$token" > "$HOME/.config/kuvo-ci/github-token.new"
        mv "$HOME/.config/kuvo-ci/github-token.new" "$HOME/.config/kuvo-ci/github-token"
        echo "Kept the token in ~/.config/kuvo-ci/github-token."
    fi
    token=""
    [[ -s "$HOME/.config/kuvo-ci/github-token" ]] || fail "No GitHub token: run this again and paste one."
    if [[ "$1" == agent ]]; then
        mkdir -p "$HOME/Library/LaunchAgents"
        umask 022
        service_plist agent "$HOME" > "$plist.new"
        plutil -lint "$plist.new" >/dev/null
        mv "$plist.new" "$plist"
        echo "Installed $plist."
    else
        rm -f "$plist"
    fi
}

# ---- As you. ------------------------------------------------------------------------------
as_admin() { # agent|daemon
    [[ "$EUID" -ne 0 ]] || fail "Run this as yourself, not with sudo: it asks for sudo where it needs it."
    local kind="$1" ci_uid ci_home softnet token=""
    ci_uid="$(id -u "$CI_USER" 2>/dev/null)" || fail "There's no $CI_USER user on this Mac."
    ci_home="$(dscl . -read "/Users/$CI_USER" NFSHomeDirectory | awk '{ print $2 }')"
    if dseditgroup -o checkmember -m "$CI_USER" admin >/dev/null 2>&1; then
        fail "$CI_USER is an administrator: the orchestrator must run as a standard user."
    fi
    command -v tart >/dev/null || fail "Tart isn't installed: brew install openai/tools/tart"
    command -v gh >/dev/null || fail "gh isn't installed: brew install gh"
    softnet="$(readlink -f "$(command -v softnet)")"
    if [[ "$(stat -f '%Su' "$softnet")" != root || ! -u "$softnet" ]]; then
        echo "softnet must be setuid root to filter the VMs' network. Run:" >&2
        echo "  sudo chown root:wheel $softnet && sudo chmod u+s $softnet" >&2
        exit 1
    fi

    # Yours, and nobody else's to change: /Users/Shared lets anyone make things, so mkdir makes
    # the folder (and fails on anything planted there), and one that's there must be yours.
    if [[ ! -e "$SHARED" && ! -L "$SHARED" ]]; then mkdir -m 755 "$SHARED"; fi
    [[ -d "$SHARED" && ! -L "$SHARED" && "$(stat -f %u "$SHARED")" == "$EUID" ]] \
        || fail "$SHARED is there already and isn't your folder. Remove it (sudo rm -rf $SHARED) and run this again."
    chmod 755 "$SHARED"
    mkdir -p "$SHARED/scripts/vm"
    chmod 755 "$SHARED/scripts" "$SHARED/scripts/vm"
    install -m 755 "$here/setup.sh" "$here/orchestrator.sh" "$here/build-image.sh" "$here/check-isolation.sh" "$SHARED/scripts/"
    install -m 644 "$here/common.sh" "$SHARED/scripts/"
    install -m 755 "$here/vm/job-started.sh" "$SHARED/scripts/vm/"
    echo "Copied the scripts to $SHARED/scripts."
    [[ -s "$SHARED/golden-version" ]] \
        || echo "There's no golden image yet: run scripts/ci-runner/build-image.sh (the orchestrator waits for it)."

    echo
    echo "Paste the orchestrator's GitHub token (fine-grained, $REPOSITORY only, Administration:"
    echo "read and write, Actions: read), or press Return to keep the one it has:"
    IFS= read -rs token || true
    echo
    if [[ -n "$token" ]]; then
        # What the orchestrator does with it: list runs and jobs (Actions: read), and make
        # runners (Administration: read and write; a registration token is the harmless test).
        local config
        config="$(mktemp -d)"
        GH_TOKEN="$token" GH_CONFIG_DIR="$config" gh api "repos/$REPOSITORY/actions/runs?per_page=1" --jq .total_count >/dev/null 2>&1 \
            || { rm -rf "$config"; fail "That token can't read $REPOSITORY's runs (it needs Actions: read)."; }
        GH_TOKEN="$token" GH_CONFIG_DIR="$config" gh api -X POST "repos/$REPOSITORY/actions/runners/registration-token" --jq .expires_at >/dev/null 2>&1 \
            || { rm -rf "$config"; fail "That token can't make runners for $REPOSITORY (it needs Administration: read and write)."; }
        rm -rf "$config"
        echo "The token can make runners for $REPOSITORY."
    fi

    echo "Setting up $CI_USER's side (sudo may ask for your password)…"
    printf '%s\n' "$token" | sudo -u "$CI_USER" -i /bin/bash "$SHARED/scripts/setup.sh" --as-ci "$kind"
    token=""

    # Only one of the two runs: take the other kind down.
    sudo launchctl bootout "gui/$ci_uid/$SERVICE" 2>/dev/null || true
    sudo launchctl bootout "system/$SERVICE" 2>/dev/null || true
    if [[ "$kind" == daemon ]]; then
        local plist
        plist="$(mktemp)"
        service_plist daemon "$ci_home" > "$plist"
        plutil -lint "$plist" >/dev/null
        sudo install -m 644 -o root -g wheel "$plist" "$DAEMON_PLIST"
        rm -f "$plist"
        sudo launchctl bootstrap system "$DAEMON_PLIST"
        sudo launchctl print "system/$SERVICE" | grep -E '^[[:space:]]*(state|pid) =' || true
        echo "The orchestrator runs as $CI_USER from $DAEMON_PLIST, with the Mac; no one needs to log in as $CI_USER."
    else
        sudo rm -f "$DAEMON_PLIST"
        if who | awk -v user="$CI_USER" '$1 == user && $2 == "console" { found = 1 } END { exit !found }'; then
            sudo launchctl bootstrap "gui/$ci_uid" "$ci_home/Library/LaunchAgents/$SERVICE.plist"
            echo "Started in $CI_USER's session. Switch back to your own account: the console should be yours."
        else
            echo "Log in as $CI_USER with fast user switching, then switch back to yourself (leave $CI_USER"
            echo "logged in, in the background): the orchestrator starts with that login."
        fi
    fi
    echo "Its log: $ci_home/Library/Logs/kuvo-ci/orchestrator.log"
}

case "${1:-}" in
    --as-ci) as_ci "${2:-daemon}" ;;
    --agent) as_admin agent ;;
    "") as_admin daemon ;;
    *) fail "Usage: scripts/ci-runner/setup.sh [--agent]" ;;
esac

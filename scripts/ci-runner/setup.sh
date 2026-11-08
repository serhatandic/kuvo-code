#!/bin/bash
# Sets up the Mac mini's CI, once: pushes to main and release tags run there, each job in a fresh
# macOS VM (see the `runs-on` of .github/workflows/ci.yml and release.yml, and common.sh). Run it
# as yourself, an administrator, from the checkout:
#
#   scripts/ci-runner/setup.sh
#
# What it does:
#   1. Checks Tart is installed and softnet is setuid root (it filters the VMs' network).
#   2. Copies the scripts ci runs to /Users/Shared/kuvo-ci/scripts, yours and read-only to
#      everyone else (ci can't read your home folder, and mustn't change what it runs).
#   3. Asks for the GitHub token the orchestrator makes runners with (a fine-grained token for
#      serhatandic/kuvo-code only, Administration: read and write, Actions: read), checks it,
#      and keeps it as ci in ~ci/.config/kuvo-ci/github-token, which only ci can read. Press
#      Return to keep the one it has.
#   4. As ci (sudo): installs the orchestrator as a LaunchAgent in ci's login session.
#   5. If ci is logged in, starts it (sudo); otherwise it starts when ci logs in.
#
# The golden image comes from scripts/ci-runner/build-image.sh, before or after this; the
# orchestrator waits for it. Running this again is safe: it puts the scripts and the agent back
# and restarts the orchestrator (an idle VM is replaced; a job in progress is cut short, so run
# it between jobs).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/ci-runner/common.sh
. "$here/common.sh"

CI_USER="${CI_USER:-ci}"
AGENT_LABEL="run.kuvo.ci.orchestrator"

fail() {
    echo "$1" >&2
    exit 1
}

# ---- As ci: keep the token, install the agent. ---------------------------------------------
as_ci() {
    [[ "$(id -un)" == "$CI_USER" ]] || fail "--as-ci runs as $CI_USER."
    umask 077
    local token plist="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
    IFS= read -r token || true
    mkdir -p "$HOME/.config/kuvo-ci" "$HOME/Library/Logs/kuvo-ci" "$HOME/Library/LaunchAgents"
    chmod 700 "$HOME/.config/kuvo-ci"
    if [[ -n "$token" ]]; then
        printf '%s\n' "$token" > "$HOME/.config/kuvo-ci/github-token.new"
        mv "$HOME/.config/kuvo-ci/github-token.new" "$HOME/.config/kuvo-ci/github-token"
        echo "Kept the token in ~/.config/kuvo-ci/github-token."
    fi
    token=""
    [[ -s "$HOME/.config/kuvo-ci/github-token" ]] || fail "No GitHub token: run this again and paste one."

    umask 022
    cat > "$plist.new" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$AGENT_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$SHARED/scripts/orchestrator.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$HOME</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>60</integer>
    <key>ExitTimeOut</key>
    <integer>60</integer>
    <key>StandardOutPath</key>
    <string>$HOME/Library/Logs/kuvo-ci/orchestrator.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/Library/Logs/kuvo-ci/orchestrator.log</string>
</dict>
</plist>
PLIST
    plutil -lint "$plist.new" >/dev/null
    mv "$plist.new" "$plist"
    echo "Installed $plist."
}

# ---- As you. ------------------------------------------------------------------------------
as_admin() {
    [[ "$EUID" -ne 0 ]] || fail "Run this as yourself, not with sudo: it asks for sudo where it needs it."
    local ci_uid ci_home softnet token=""
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

    echo "Installing the orchestrator as $CI_USER (sudo may ask for your password)…"
    printf '%s\n' "$token" | sudo -u "$CI_USER" -i /bin/bash "$SHARED/scripts/setup.sh" --as-ci
    token=""

    local plist="$ci_home/Library/LaunchAgents/$AGENT_LABEL.plist"
    if who | awk -v user="$CI_USER" '$1 == user && $2 == "console" { found = 1 } END { exit !found }'; then
        echo "Starting it in $CI_USER's session…"
        sudo launchctl bootout "gui/$ci_uid/$AGENT_LABEL" 2>/dev/null || true
        local tries=0
        while sudo launchctl print "gui/$ci_uid/$AGENT_LABEL" >/dev/null 2>&1 && [[ $tries -lt 60 ]]; do
            sleep 1
            tries=$((tries + 1))
        done
        sudo launchctl bootstrap "gui/$ci_uid" "$plist"
        sudo launchctl print "gui/$ci_uid/$AGENT_LABEL" | grep -E '^[[:space:]]*(state|pid) =' || true
        echo "Its log: $ci_home/Library/Logs/kuvo-ci/orchestrator.log"
    else
        echo "Now log in as $CI_USER with fast user switching (Control Center › Fast User Switching)"
        echo "and leave it logged in: the orchestrator starts with that login."
    fi
}

case "${1:-}" in
    --as-ci) as_ci ;;
    "") as_admin ;;
    *) fail "Usage: scripts/ci-runner/setup.sh" ;;
esac

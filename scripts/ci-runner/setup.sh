#!/bin/bash
# Sets up the Mac mini's CI, once and after every change to these scripts or a Tart or softnet
# upgrade: pushes to main and release tags run there, each job in a fresh macOS VM (see the
# `runs-on` of .github/workflows/ci.yml and release.yml, and common.sh). Run it as yourself, an
# administrator, from the checkout:
#
#   scripts/ci-runner/setup.sh            the orchestrator as a LaunchDaemon running as ci
#   scripts/ci-runner/setup.sh --agent    or as a LaunchAgent in ci's login session instead
#
# The daemon needs no one logged in as ci: it starts with the Mac, and the console stays yours
# (the Mac app's tests in your account need your session at the console). The agent needs ci
# logged in, in the background (fast user switching, then back to you), after every restart.
#
# What it does (sudo asks for your password once):
#   1. Makes the group kuvo-ci, with ci as its only member.
#   2. Installs what ci runs into /usr/local/kuvo-ci, root's and nobody else's to change: these
#      scripts, a copy of Homebrew's Tart.app, and a copy of softnet that's setuid root and runs
#      only for kuvo-ci (root:kuvo-ci, 4750). Homebrew's softnet loses its setuid bit: anyone
#      could run that one. The orchestrator runs with only that folder and the system's on its
#      PATH, and checks the folder before each VM.
#   3. Asks for the GitHub token the orchestrator makes runners with (a fine-grained token for
#      serhatandic/kuvo-code only, Administration: read and write, Actions: read, 90 days),
#      checks it, and keeps it as ci in ~ci/.config/kuvo-ci/github-token, which only ci can
#      read. Press Return to keep the one it has.
#   4. Keeps the VMs' disks out of Time Machine, makes /Users/Shared/kuvo-ci/run (ci's; its
#      status file), installs the orchestrator (sudo) and starts it.
#
# The golden image comes from scripts/ci-runner/build-image.sh, before or after this; the
# orchestrator waits for it. Running this again is safe: it puts everything back and restarts the
# orchestrator (an idle VM is replaced; a job in progress is cut short, so run it between jobs,
# or with /Users/Shared/kuvo-ci/paused there).
set -euo pipefail
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/ci-runner/common.sh
. "$here/common.sh"

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
    <key>InitGroups</key>
    <true/>
    <key>SessionCreate</key>
    <true/>
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
        <string>$CI_SCRIPTS/orchestrator.sh</string>
    </array>
${daemon_keys}    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>$2</string>
        <key>USER</key>
        <string>$CI_USER</string>
        <key>LOGNAME</key>
        <string>$CI_USER</string>
        <key>PATH</key>
        <string>$CI_PATH</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>$2</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>60</integer>
    <key>ExitTimeOut</key>
    <integer>90</integer>
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

# Whether a token can do what the orchestrator does with it: list runs and jobs (Actions: read),
# and make runners (Administration: read and write; a registration token is the harmless test).
# The token goes to curl on its stdin, never in its arguments.
token_can() { # token method path
    local code
    code="$(printf 'header = "Authorization: Bearer %s"\n' "$1" | /usr/bin/curl -sS --proto '=https' --max-time 30 \
        -X "$2" -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' \
        -o /dev/null -w '%{http_code}' --config - "https://api.github.com/$3" 2>/dev/null)"
    [[ "$code" == 2* ]]
}

# ---- As ci: keep the token, make its folders, install the agent (for --agent). --------------
as_ci() { # agent|daemon
    [[ "$(id -un)" == "$CI_USER" ]] || fail "--as-ci runs as $CI_USER."
    umask 077
    local token plist="$HOME/Library/LaunchAgents/$SERVICE.plist"
    IFS= read -r token || true
    mkdir -p "$HOME/.config/kuvo-ci" "$HOME/Library/Logs/kuvo-ci" "$HOME/.tart"
    chmod 700 "$HOME/.config/kuvo-ci" "$HOME/.tart"
    touch "$HOME/Library/Logs/kuvo-ci/orchestrator.log"
    # The VMs' disks: big, and gone after each job.
    tmutil addexclusion "$HOME/.tart" 2>/dev/null || echo "Couldn't keep $HOME/.tart out of Time Machine."
    if [[ -n "$token" ]]; then
        printf '%s\n' "$token" > "$HOME/.config/kuvo-ci/github-token.new"
        mv "$HOME/.config/kuvo-ci/github-token.new" "$HOME/.config/kuvo-ci/github-token"
        # The date it expires comes with GitHub's next answer.
        rm -f "$HOME/.config/kuvo-ci/state/token-expiration"
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

# ---- As you: the group and the tree (sudo). -------------------------------------------------
install_group() {
    if ! dscl . -read "/Groups/$SOFTNET_GROUP" PrimaryGroupID >/dev/null 2>&1; then
        sudo dseditgroup -o create -r "Kuvo Code CI (runs softnet)" "$SOFTNET_GROUP"
        echo "Made the group $SOFTNET_GROUP."
    fi
    if ! dseditgroup -o checkmember -m "$CI_USER" "$SOFTNET_GROUP" >/dev/null 2>&1; then
        sudo dseditgroup -o edit -a "$CI_USER" -t user "$SOFTNET_GROUP"
    fi
    local member
    for member in $(dscl . -read "/Groups/$SOFTNET_GROUP" GroupMembership 2>/dev/null | sed 's/^GroupMembership: *//'); do
        [[ "$member" == "$CI_USER" ]] || fail "The group $SOFTNET_GROUP has $member in it: only $CI_USER may be (sudo dseditgroup -o edit -d $member -t user $SOFTNET_GROUP)."
    done
}

install_tree() { # Tart.app softnet
    local tart_app="$1" softnet="$2" staging
    staging="$(mktemp -d)"
    # bin/tart starts Tart from its bundle, as Homebrew's does (the bundle holds its entitlements).
    printf '#!/bin/bash\nexec %s/Tart.app/Contents/MacOS/tart "$@"\n' "$CI_ROOT" > "$staging/tart"
    # Built next to the old tree, then swapped in, so ci never runs from half of one.
    sudo /bin/rm -rf "$CI_ROOT.new"
    sudo /usr/bin/install -d -o root -g wheel -m 755 "$CI_ROOT.new" "$CI_ROOT.new/bin" "$CI_ROOT.new/scripts" "$CI_ROOT.new/scripts/vm"
    sudo /usr/bin/ditto --norsrc "$tart_app" "$CI_ROOT.new/Tart.app"
    sudo /usr/sbin/chown -R root:wheel "$CI_ROOT.new/Tart.app"
    sudo /bin/chmod -R go-w "$CI_ROOT.new/Tart.app"
    sudo /usr/bin/install -o root -g wheel -m 755 "$staging/tart" "$CI_ROOT.new/bin/tart"
    sudo /usr/bin/install -o root -g "$SOFTNET_GROUP" -m 4750 "$softnet" "$CI_ROOT.new/bin/softnet"
    sudo /usr/bin/install -o root -g wheel -m 755 "$here/setup.sh" "$here/orchestrator.sh" "$here/build-image.sh" "$here/check-isolation.sh" "$CI_ROOT.new/scripts/"
    sudo /usr/bin/install -o root -g wheel -m 644 "$here/common.sh" "$CI_ROOT.new/scripts/"
    sudo /usr/bin/install -o root -g wheel -m 755 "$here/vm/job-started.sh" "$CI_ROOT.new/scripts/vm/"
    rm -rf "$staging"
    sudo /bin/rm -rf "$CI_ROOT.old"
    if [[ -e "$CI_ROOT" ]]; then sudo /bin/mv "$CI_ROOT" "$CI_ROOT.old"; fi
    sudo /bin/mv "$CI_ROOT.new" "$CI_ROOT"
    sudo /bin/rm -rf "$CI_ROOT.old"
    /usr/bin/codesign --verify --strict "$CI_ROOT/Tart.app" || fail "The copy of Tart.app in $CI_ROOT doesn't pass codesign --verify."
    verify_tree || fail "$CI_ROOT isn't as it should be (above)."
    echo "Installed $CI_ROOT: Tart $("$CI_BIN/tart" --version), softnet root:$SOFTNET_GROUP 4750."
}

# ---- As you. ------------------------------------------------------------------------------
as_admin() { # agent|daemon
    [[ "$EUID" -ne 0 ]] || fail "Run this as yourself, not with sudo: it asks for sudo where it needs it."
    local kind="$1" ci_uid ci_home tart_app softnet token=""
    ci_uid="$(id -u "$CI_USER" 2>/dev/null)" || fail "There's no $CI_USER user on this Mac."
    ci_home="$(dscl . -read "/Users/$CI_USER" NFSHomeDirectory | awk '{ print $2 }')"
    if dseditgroup -o checkmember -m "$CI_USER" admin >/dev/null 2>&1; then
        fail "$CI_USER is an administrator: the orchestrator must run as a standard user."
    fi
    [[ -x /usr/bin/jq && -x /usr/bin/curl ]] || fail "This needs /usr/bin/jq and /usr/bin/curl (macOS 15 or later)."
    command -v brew >/dev/null || fail "Homebrew isn't installed: Tart and softnet come from it."
    tart_app="$(brew --prefix tart 2>/dev/null)/libexec/tart.app"
    [[ -x "$tart_app/Contents/MacOS/tart" ]] || fail "Tart isn't installed: brew install openai/tools/tart"
    softnet="$(brew --prefix softnet 2>/dev/null)/bin/softnet"
    softnet="$(readlink -f "$softnet" 2>/dev/null || true)"
    [[ -f "$softnet" ]] || fail "softnet isn't installed: brew install openai/tools/softnet"
    /usr/bin/codesign --verify --strict "$tart_app" || fail "Homebrew's Tart.app doesn't pass codesign --verify."

    # Yours, and nobody else's to change: /Users/Shared lets anyone make things, so mkdir makes
    # the folder (and fails on anything planted there), and one that's there must be yours.
    if [[ ! -e "$SHARED" && ! -L "$SHARED" ]]; then mkdir -m 755 "$SHARED"; fi
    [[ -d "$SHARED" && ! -L "$SHARED" && "$(stat -f %u "$SHARED")" == "$EUID" ]] \
        || fail "$SHARED is there already and isn't your folder. Remove it (sudo rm -rf $SHARED) and run this again."
    chmod 755 "$SHARED"
    [[ -s "$SHARED/golden-version" ]] \
        || echo "There's no golden image yet: run scripts/ci-runner/build-image.sh (the orchestrator waits for it)."

    echo
    echo "Paste the orchestrator's GitHub token (fine-grained, $REPOSITORY only, Administration:"
    echo "read and write, Actions: read, 90 days), or press Return to keep the one it has:"
    IFS= read -rs token || true
    echo
    if [[ -n "$token" ]]; then
        [[ "$token" =~ ^[A-Za-z0-9_]+$ ]] || fail "That doesn't look like a GitHub token."
        token_can "$token" GET "repos/$REPOSITORY/actions/runs?per_page=1" \
            || fail "That token can't read $REPOSITORY's runs (it needs Actions: read)."
        token_can "$token" POST "repos/$REPOSITORY/actions/runners/registration-token" \
            || fail "That token can't make runners for $REPOSITORY (it needs Administration: read and write)."
        echo "The token can make runners for $REPOSITORY."
    fi

    echo "Installing $CI_ROOT (sudo may ask for your password)…"
    install_group
    install_tree "$tart_app" "$softnet"
    # Anyone could run Homebrew's setuid softnet; ci runs its own now.
    if [[ -u "$softnet" ]]; then
        sudo /bin/chmod u-s "$softnet"
        echo "Took the setuid bit off Homebrew's softnet ($softnet)."
    fi
    # The scripts ci ran before, from your folder: gone, so nothing runs them by mistake.
    rm -rf "$SHARED/scripts"
    # ci's, for its status file: anyone can read it.
    sudo /usr/bin/install -d -o "$CI_USER" -g staff -m 755 "$SHARED_RUN"
    if [[ -d "$SHARED_TART" ]]; then tmutil addexclusion "$SHARED_TART" 2>/dev/null || echo "Couldn't keep $SHARED_TART out of Time Machine."; fi

    echo "Setting up $CI_USER's side…"
    printf '%s\n' "$token" | sudo -u "$CI_USER" -i /bin/bash "$CI_SCRIPTS/setup.sh" --as-ci "$kind"
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
    echo "Its status: $SHARED_RUN/status; its log: $ci_home/Library/Logs/kuvo-ci/orchestrator.log"
    echo "Pin what it copied, so an upgrade is one you choose: brew pin tart softnet. After you"
    echo "upgrade either, run this again, then check-isolation.sh (see its header)."
}

case "${1:-}" in
    --as-ci) as_ci "${2:-daemon}" ;;
    --agent) as_admin agent ;;
    "") as_admin daemon ;;
    *) fail "Usage: scripts/ci-runner/setup.sh [--agent]" ;;
esac

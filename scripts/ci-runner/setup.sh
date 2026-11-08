#!/bin/bash
# Sets up the Mac mini's GitHub Actions runner, once: pushes to main and release tags run there
# (see the `runs-on` of .github/workflows/ci.yml and release.yml). Run it as yourself, an
# administrator, from the checkout, with `ci` logged in on the Mac (fast user switching):
#
#   scripts/ci-runner/setup.sh
#
# What it does:
#   1. Copies itself and the runner's hooks to /Users/Shared/kuvo-ci, yours and read-only to
#      everyone else, because `ci` can't read your home folder and mustn't be able to change them.
#   2. Makes a registration token with `gh` (it lasts an hour; nothing keeps it).
#   3. As `ci` (sudo asks for your password): downloads the runner, checks its SHA-256 against the
#      one pinned below, installs it in ~ci/actions-runner, registers it on the repository as
#      kuvo-mini (labels self-hosted, macOS, ARM64, kuvo-mini), points it at the hooks, and
#      installs it as a LaunchAgent in ci's login session.
#   4. Starts it in ci's session (sudo again) and shows its state, here and on GitHub.
#
# Running it again is safe: a runner that's registered already is kept, and its hooks, PATH and
# service are set up again. To start over, see .claude/notes/ci-on-mini.md (Removing it).
set -euo pipefail

REPOSITORY="serhatandic/kuvo-code"
CI_USER="${CI_USER:-ci}"
RUNNER_NAME="kuvo-mini"
RUNNER_LABELS="kuvo-mini"
SHARED="/Users/Shared/kuvo-ci"
# actions/runner's release for Apple silicon Macs, and its SHA-256 from the release notes. The
# runner updates itself after this, as GitHub asks it to.
RUNNER_VERSION="2.338.2"
RUNNER_SHA256="25a065af409ffa317ab4d5a3b614dd15fc9c40f2172bc1b35a1b1258e919a388"
RUNNER_URL="https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-osx-arm64-$RUNNER_VERSION.tar.gz"
# What jobs find on PATH: Xcode's tools in /usr/bin, and gh from Homebrew (the release job
# publishes with it). Bun and Node come from the workflows' setup actions.
JOB_PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

fail() {
    echo "$1" >&2
    exit 1
}

owner_slug="${REPOSITORY%%/*}-${REPOSITORY##*/}"
LABEL="actions.runner.$owner_slug.$RUNNER_NAME"

# ---- As ci: install, register and set up the service. -------------------------------------
as_ci() {
    [[ "$(id -un)" == "$CI_USER" ]] || fail "--as-ci runs as $CI_USER."
    local runner_dir="$HOME/actions-runner"
    local plist="$HOME/Library/LaunchAgents/$LABEL.plist"
    local token
    umask 077
    IFS= read -r token || true

    if [[ -f "$runner_dir/.runner" ]]; then
        echo "The runner in $runner_dir is registered already: keeping it."
    else
        [[ -n "$token" ]] || fail "No registration token came in."
        if [[ -e "$runner_dir" && -n "$(ls -A "$runner_dir" 2>/dev/null)" ]]; then
            fail "$runner_dir has something in it but no registered runner. Move it away and run this again."
        fi
        local download
        download="$(mktemp -d "$(getconf DARWIN_USER_TEMP_DIR)kuvo-runner.XXXXXX")"
        echo "Downloading actions/runner $RUNNER_VERSION…"
        curl -fsSL --proto '=https' --tlsv1.2 -o "$download/runner.tar.gz" "$RUNNER_URL"
        if ! echo "$RUNNER_SHA256  $download/runner.tar.gz" | shasum -a 256 -c - >/dev/null; then
            rm -rf "$download"
            fail "The runner's download doesn't match its pinned SHA-256: not installing it."
        fi
        echo "Checked its SHA-256."
        mkdir -p "$runner_dir"
        tar -xzf "$download/runner.tar.gz" -C "$runner_dir"
        rm -rf "$download"
        (
            cd "$runner_dir"
            ./config.sh --url "https://github.com/$REPOSITORY" --token "$token" \
                --name "$RUNNER_NAME" --labels "$RUNNER_LABELS" --work _work --unattended --replace
        )
    fi
    token=""

    # The hooks: kept out of the runner's folder (GitHub's advice), where jobs can't change them.
    local env_file="$runner_dir/.env"
    touch "$env_file"
    grep -v '^ACTIONS_RUNNER_HOOK_JOB_' "$env_file" > "$env_file.new" || true
    {
        echo "ACTIONS_RUNNER_HOOK_JOB_STARTED=$SHARED/job-started.sh"
        echo "ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$SHARED/job-completed.sh"
    } >> "$env_file.new"
    mv "$env_file.new" "$env_file"
    printf '%s\n' "$JOB_PATH" > "$runner_dir/.path"
    local tool
    for tool in xcodebuild swift git python3 gh; do
        PATH="$JOB_PATH" command -v "$tool" >/dev/null || echo "warning: jobs won't find $tool on $JOB_PATH" >&2
    done

    # A LaunchAgent: it runs in ci's login session, which the app's tests (hosted by the app) and
    # codesign need. svc.sh writes it; it's started from your account, below.
    if [[ ! -f "$plist" ]]; then
        (cd "$runner_dir" && ./svc.sh install)
    fi
    [[ -f "$plist" ]] || fail "svc.sh didn't write $plist."
    # Started again if it ever crashes (the runner restarts itself after updating).
    plutil -remove KeepAlive "$plist" >/dev/null 2>&1 || true
    plutil -insert KeepAlive -json '{"SuccessfulExit": false}' "$plist"
    plutil -lint "$plist" >/dev/null
    echo "Installed $plist."
}

# ---- As you: stage the files, make the token, run the rest as ci, start the service. --------
as_admin() {
    [[ "$EUID" -ne 0 ]] || fail "Run this as yourself, not with sudo: it asks for sudo where it needs it."
    local here ci_uid ci_home
    here="$(cd "$(dirname "$0")" && pwd)"
    ci_uid="$(id -u "$CI_USER" 2>/dev/null)" || fail "There's no $CI_USER user on this Mac."
    ci_home="$(dscl . -read "/Users/$CI_USER" NFSHomeDirectory | awk '{ print $2 }')"
    if dseditgroup -o checkmember -m "$CI_USER" admin >/dev/null 2>&1; then
        fail "$CI_USER is an administrator: the runner must run as a standard user."
    fi
    command -v gh >/dev/null || fail "gh isn't installed."
    gh auth status >/dev/null 2>&1 || fail "gh isn't signed in: gh auth login."

    # Yours, and nobody else's to change: /Users/Shared lets anyone make folders, so one that's
    # there already must be yours.
    if [[ -e "$SHARED" ]]; then
        [[ -d "$SHARED" && ! -L "$SHARED" && "$(stat -f %u "$SHARED")" == "$EUID" ]] \
            || fail "$SHARED is there already and isn't your folder. Remove it (sudo rm -rf $SHARED) and run this again."
    fi
    install -d -m 755 "$SHARED"
    chmod 755 "$SHARED"
    install -m 755 "$here/setup.sh" "$here/job-started.sh" "$here/job-completed.sh" "$SHARED/"
    install -m 644 "$here/common.sh" "$SHARED/"
    echo "Copied the setup and the runner's hooks to $SHARED."

    echo "Making a registration token…"
    local token
    token="$(gh api -X POST "repos/$REPOSITORY/actions/runners/registration-token" -q .token)"
    [[ -n "$token" ]] || fail "GitHub gave no registration token."

    echo "Installing the runner as $CI_USER (sudo may ask for your password)…"
    printf '%s\n' "$token" | sudo -u "$CI_USER" -i /bin/bash "$SHARED/setup.sh" --as-ci
    token=""

    local plist="$ci_home/Library/LaunchAgents/$LABEL.plist"
    if who | awk -v user="$CI_USER" '$1 == user && $2 == "console" { found = 1 } END { exit !found }'; then
        echo "Starting it in $CI_USER's session…"
        sudo launchctl bootout "gui/$ci_uid/$LABEL" 2>/dev/null || true
        sudo launchctl bootstrap "gui/$ci_uid" "$plist"
        sudo launchctl print "gui/$ci_uid/$LABEL" | grep -E '^\s*(state|pid|last exit code) =' || true
    else
        echo "$CI_USER isn't logged in. Log in as $CI_USER with fast user switching (Control Center ›"
        echo "Fast User Switching) and leave it logged in: the runner starts with that login."
    fi

    echo "On GitHub (it can take a few seconds to show as online):"
    gh api "repos/$REPOSITORY/actions/runners" \
        --jq ".runners[] | select(.name == \"$RUNNER_NAME\") | \"\(.name): \(.status), labels \([.labels[].name] | join(\", \"))\"" || true
}

case "${1:-}" in
    --as-ci) as_ci ;;
    "") as_admin ;;
    *) fail "Usage: scripts/ci-runner/setup.sh" ;;
esac

#!/bin/bash
# Sets up the Mac mini's GitHub Actions runner, once: pushes to main and release tags run there
# (see the `runs-on` of .github/workflows/ci.yml and release.yml). Run it as yourself, an
# administrator, from the checkout, best with `ci` logged out:
#
#   scripts/ci-runner/setup.sh
#
# then log in as `ci` (fast user switching) and leave it logged in: the runner starts with that
# login. What it does:
#   1. Copies itself and the runner's hooks to /Users/Shared/kuvo-ci, yours and read-only to
#      everyone else, because `ci` can't read your home folder and mustn't be able to change them.
#   2. Adds `ci` to the _developer group (sudo), which `xcodebuild test` needs to run the app's
#      tests without asking for a password nobody is there to type.
#   3. Makes a registration token with `gh` (it lasts an hour; nothing keeps it).
#   4. As `ci` (sudo): downloads the runner, checks its SHA-256 against the one pinned below,
#      installs it in ~ci/actions-runner, registers it on the repository as kuvo-mini (labels
#      self-hosted, macOS, ARM64, kuvo-mini), points it at the hooks, and installs it as a
#      LaunchAgent for ci's login session.
#   5. If `ci` is logged in already (and was in _developer then), starts it in that session
#      (sudo); and shows the runner on GitHub.
#
# Running it again is safe: a runner that's registered already is kept, and its hooks, PATH and
# service are set up again; it won't restart a runner that's in the middle of a job. To start
# over, see .claude/notes/ci-on-mini.md (Removing it).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/ci-runner/common.sh
. "$here/common.sh"

CI_USER="${CI_USER:-ci}"
RUNNER_LABELS="kuvo-mini"
# actions/runner's release for Apple silicon Macs, and its SHA-256 from the release notes. The
# runner updates itself after this, as GitHub asks it to.
RUNNER_VERSION="2.338.2"
RUNNER_SHA256="25a065af409ffa317ab4d5a3b614dd15fc9c40f2172bc1b35a1b1258e919a388"
RUNNER_URL="https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-osx-arm64-$RUNNER_VERSION.tar.gz"

fail() {
    echo "$1" >&2
    exit 1
}

# ---- As ci: install, register and set up the service. -------------------------------------
as_ci() {
    [[ "$(id -un)" == "$CI_USER" ]] || fail "--as-ci runs as $CI_USER."
    local token
    umask 077
    IFS= read -r token || true

    if [[ -f "$RUNNER_DIR/.runner" ]]; then
        echo "The runner in $RUNNER_DIR is registered already: keeping it."
    else
        [[ -n "$token" ]] || fail "No registration token came in."
        if [[ -e "$RUNNER_DIR" && -n "$(ls -A "$RUNNER_DIR" 2>/dev/null)" ]]; then
            fail "$RUNNER_DIR has something in it but no registered runner. Move it away and run this again."
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
        mkdir -p "$RUNNER_DIR"
        tar -xzf "$download/runner.tar.gz" -C "$RUNNER_DIR"
        rm -rf "$download"
        (
            cd "$RUNNER_DIR"
            ./config.sh --url "https://github.com/$REPOSITORY" --token "$token" \
                --name "$RUNNER_NAME" --labels "$RUNNER_LABELS" --work _work --unattended --replace
        )
    fi
    token=""

    # Every variable the runner hands its jobs, and their PATH, exactly: the pre-job hook refuses
    # jobs once either changes. The hooks stay out of the runner's folder (GitHub's advice), in
    # /Users/Shared/kuvo-ci, where jobs can't change them.
    runner_env > "$RUNNER_DIR/.env"
    printf '%s\n' "$JOB_PATH" > "$RUNNER_DIR/.path"
    local tool
    for tool in xcodebuild swift git python3 gh; do
        PATH="$JOB_PATH" command -v "$tool" >/dev/null || echo "warning: jobs won't find $tool on $JOB_PATH" >&2
    done

    # A LaunchAgent: it runs in ci's login session, which the app's tests (hosted by the app) and
    # codesign need. svc.sh writes it; it's started from your account, or by ci's next login.
    if [[ ! -f "$PLIST" ]]; then
        (cd "$RUNNER_DIR" && ./svc.sh install)
    fi
    [[ -f "$PLIST" && "$(cat "$RUNNER_DIR/.service" 2>/dev/null)" == "$PLIST" ]] \
        || fail "svc.sh didn't install the service as $PLIST, which this script starts."
    # In ci's own login session (the window server the app's tests need), not a new one of its
    # own; and started again whenever it stops, which it also does on its own after a long time
    # without GitHub.
    plutil -remove SessionCreate "$PLIST" >/dev/null 2>&1 || true
    plutil -remove KeepAlive "$PLIST" >/dev/null 2>&1 || true
    plutil -insert KeepAlive -bool true "$PLIST"
    plutil -lint "$PLIST" >/dev/null
    echo "Installed $PLIST."
}

# ---- As you: stage the files, make the token, run the rest as ci, start the service. --------
as_admin() {
    [[ "$EUID" -ne 0 ]] || fail "Run this as yourself, not with sudo: it asks for sudo where it needs it."
    local ci_uid ci_home ci_plist logged_in="" added_group=""
    ci_uid="$(id -u "$CI_USER" 2>/dev/null)" || fail "There's no $CI_USER user on this Mac."
    ci_home="$(dscl . -read "/Users/$CI_USER" NFSHomeDirectory | awk '{ print $2 }')"
    ci_plist="$ci_home/Library/LaunchAgents/$LABEL.plist"
    if dseditgroup -o checkmember -m "$CI_USER" admin >/dev/null 2>&1; then
        fail "$CI_USER is an administrator: the runner must run as a standard user."
    fi
    command -v gh >/dev/null || fail "gh isn't installed."
    gh auth status >/dev/null 2>&1 || fail "gh isn't signed in: gh auth login."
    if who | awk -v user="$CI_USER" '$1 == user && $2 == "console" { found = 1 } END { exit !found }'; then
        logged_in=1
    fi
    # Not in the middle of a job: restarting the runner would stop it.
    if [[ -n "$logged_in" ]] && gh api "repos/$REPOSITORY/actions/runners" \
        --jq ".runners[] | select(.name == \"$RUNNER_NAME\") | .busy" 2>/dev/null | grep -qx true; then
        fail "$RUNNER_NAME is running a job. Run this again once it's done."
    fi

    # Yours, and nobody else's to change. /Users/Shared lets anyone make things, so mkdir makes
    # the folder (and fails on anything planted there, a link included), and one that's there
    # already must be your own folder.
    if [[ ! -e "$SHARED" && ! -L "$SHARED" ]]; then
        mkdir -m 755 "$SHARED"
    fi
    [[ -d "$SHARED" && ! -L "$SHARED" && "$(stat -f %u "$SHARED")" == "$EUID" ]] \
        || fail "$SHARED is there already and isn't your folder. Remove it (sudo rm -rf $SHARED) and run this again."
    chmod 755 "$SHARED"
    install -m 755 "$here/setup.sh" "$here/job-started.sh" "$here/job-completed.sh" "$SHARED/"
    install -m 644 "$here/common.sh" "$SHARED/"
    echo "Copied the setup and the runner's hooks to $SHARED."

    if ! dseditgroup -o checkmember -m "$CI_USER" _developer >/dev/null 2>&1; then
        echo "Adding $CI_USER to _developer, for xcodebuild test (sudo may ask for your password)…"
        sudo dseditgroup -o edit -a "$CI_USER" -t user _developer
        added_group=1
    fi

    echo "Making a registration token…"
    local token
    token="$(gh api -X POST "repos/$REPOSITORY/actions/runners/registration-token" -q .token)"
    [[ -n "$token" ]] || fail "GitHub gave no registration token."

    echo "Installing the runner as $CI_USER (sudo may ask for your password)…"
    printf '%s\n' "$token" | sudo -u "$CI_USER" -i /bin/bash "$SHARED/setup.sh" --as-ci
    token=""

    if [[ -n "$logged_in" && -z "$added_group" ]]; then
        echo "Starting it in $CI_USER's session…"
        sudo launchctl bootout "gui/$ci_uid/$LABEL" 2>/dev/null || true
        local tries=0
        while sudo launchctl print "gui/$ci_uid/$LABEL" >/dev/null 2>&1 && [[ $tries -lt 20 ]]; do
            sleep 0.5
            tries=$((tries + 1))
        done
        sudo launchctl bootstrap "gui/$ci_uid" "$ci_plist"
        sudo launchctl print "gui/$ci_uid/$LABEL" | grep -E '^[[:space:]]*(state|pid|last exit code) =' || true
    elif [[ -n "$logged_in" ]]; then
        echo "Log $CI_USER out and in again (its new group counts from its next login): the runner"
        echo "starts with that login. Leave $CI_USER logged in."
    else
        echo "Now log in as $CI_USER with fast user switching (Control Center › Fast User Switching)"
        echo "and leave it logged in: the runner starts with that login."
    fi

    echo "On GitHub (it shows as online once it has started):"
    gh api "repos/$REPOSITORY/actions/runners" \
        --jq ".runners[] | select(.name == \"$RUNNER_NAME\") | \"\(.name): \(.status), labels \([.labels[].name] | join(\", \"))\"" || true
}

case "${1:-}" in
    --as-ci) as_ci ;;
    "") as_admin ;;
    *) fail "Usage: scripts/ci-runner/setup.sh" ;;
esac

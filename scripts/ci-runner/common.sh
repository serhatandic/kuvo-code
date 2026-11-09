# What the Mac mini's CI scripts share (scripts/ci-runner/). Sourced, never run.
#
# Every job runs in a fresh macOS VM (Tart), cloned from a golden image and deleted after the job:
#   build-image.sh    you, after a new Xcode: builds the golden image into $SHARED/tart
#   setup.sh          you, once: installs what ci runs into $CI_ROOT (root's), the orchestrator
#                     as ci, and its GitHub token
#   orchestrator.sh   ci, always (a LaunchDaemon): one VM at a time, each with a one-job runner
#   check-isolation.sh  boots a throwaway VM with the jobs' network and checks what it can reach
#   vm/job-started.sh   inside the VM: the runner's pre-job hook, refusing what isn't ours
# shellcheck shell=bash
# shellcheck disable=SC2034 # each script uses its own share of these

REPOSITORY="serhatandic/kuvo-code"
# The runner's labels; the workflows' `runs-on` asks for all four.
RUNNER_LABELS=(self-hosted macOS ARM64 kuvo-mini)
# The refs the Mini takes: main and release tags. The same rule is in ci.yml's and release.yml's
# `runs-on`, the VM's hook (vm/job-started.sh) and the orchestrator's host check (`allowed`).
#   refs/heads/main, refs/tags/v[0-9]*

# Everything ci runs, and nobody but root can change: the scripts, a copy of Tart.app and
# softnet. setup.sh installs it; the orchestrator checks it (verify_tree) before each VM and runs
# with nothing else on its PATH (Homebrew's folders are yours, so whatever runs as you could
# change them).
CI_ROOT="/usr/local/kuvo-ci"
CI_BIN="$CI_ROOT/bin"
CI_SCRIPTS="$CI_ROOT/scripts"
CI_PATH="$CI_BIN:/usr/bin:/bin:/usr/sbin:/sbin"
# softnet is setuid root, so only ci may run it: root:$SOFTNET_GROUP, 4750, and ci is the
# group's only member. Tart runs the softnet it finds first on PATH, and only one that's root's
# and setuid.
SOFTNET_GROUP="kuvo-ci"
CI_USER="${CI_USER:-ci}"

# Yours, read-only to everyone else: the golden image ci copies, and the pause switch.
SHARED="/Users/Shared/kuvo-ci"
SHARED_TART="$SHARED/tart"
# ci's, readable by everyone: what the orchestrator is doing (status), for you to look at
# without sudo. In root's /usr/local, not in your folder above: setup.sh makes it with sudo, and
# nothing can be planted where it goes.
SHARED_RUN="/usr/local/kuvo-ci-run"
# Tart's signer (Cirrus Labs): the copy ci runs must be theirs.
TART_TEAM="9M2P8L4D89"
GOLDEN="kuvo-ci-golden"
# What the golden image is built from: Cirrus Labs' macOS 27 base image (brew, gh, Node 24,
# Tart's guest agent, the admin user), pinned by digest. Xcode comes from this Mac's.
BASE_IMAGE="ghcr.io/cirruslabs/macos-golden-gate-base@sha256:4859ea9483a1f6e377301f23a5243798044266a373fc36635e9dcd045e09292f"

# One job at a time (Apple allows two macOS VMs; this Mac has 16 GB and is also yours to use).
VM_CPUS="${KUVO_CI_CPUS:-8}"
VM_MEMORY_MB="${KUVO_CI_MEMORY_MB:-8192}"
VM_DISK_GB="${KUVO_CI_DISK_GB:-100}"
# The longest a job may run before its VM is stopped (the workflows' own limit is 180 minutes).
JOB_LIMIT_MINUTES=200

# Where the pre-job hook in the VM leaves the run's ID, which the orchestrator reads back to know
# the hook ran.
HOOK_MARKER="/private/var/tmp/kuvo-ci-job-started"

# Runs a command for at most $1 seconds, then stops it (TERM, then KILL 5 seconds later). macOS
# has no timeout(1). The command's stdin is /dev/null (a background job's).
run_limited() { # seconds command...
    local limit="$1" pid dog rc
    shift
    "$@" &
    pid=$!
    (
        nap_pid=""
        trap '[[ -z "$nap_pid" ]] || kill "$nap_pid" 2>/dev/null; exit 0' TERM
        sleep "$limit" &
        nap_pid=$!
        wait "$nap_pid"
        kill -TERM "$pid" 2>/dev/null || exit 0
        sleep 5 &
        nap_pid=$!
        wait "$nap_pid"
        kill -KILL "$pid" 2>/dev/null
    ) &
    dog=$!
    wait "$pid"
    rc=$?
    kill -TERM "$dog" 2>/dev/null
    wait "$dog" 2>/dev/null
    return "$rc"
}

# The VMs' network. softnet lets a VM send only to globally routable addresses (GitHub, Apple's
# notary service, package registries) and to its gateway, and drops everything but IPv4 and ARP
# (so no IPv6 either). Each softnet picks its own random /29 from the private ranges, and its
# gateway is this Mac, so blocking the private ranges outright blocks the gateway too (a block
# rule beats softnet's own gateway rule), along with the LAN, Tailscale's 100.64/10 and
# link-local. softnet answers DHCP itself before any rule; the guests use public DNS
# (build-image.sh), since the gateway's isn't reachable. No clipboard, audio or USB passes
# through, and no folder is shared.
#
# This network's own public address is globally routable too, and the router answers on it (its
# admin page, any port forwarded into the LAN), so it's blocked as well, looked up as each VM
# starts (and again while it runs: the orchestrator stops a VM when it changes). It's asked of two
# services over HTTPS, which must agree; no VM starts when they don't.
VM_BLOCKED="10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,169.254.0.0/16"
# What each service says this network's public address is: two words, "-" for no answer.
ip_lookups() {
    local a b ip='^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$'
    a="$(/usr/bin/curl -4 -fsS --proto '=https' --max-time 10 https://api.ipify.org 2>/dev/null)"
    b="$(/usr/bin/curl -4 -fsS --proto '=https' --max-time 10 https://checkip.amazonaws.com 2>/dev/null)"
    a="${a//[[:space:]]/}" b="${b//[[:space:]]/}"
    [[ "$a" =~ $ip ]] || a=-
    [[ "$b" =~ $ip ]] || b=-
    echo "$a $b"
}
public_ipv4() {
    local a b
    read -r a b <<< "$(ip_lookups)"
    [[ "$a" != - && "$a" == "$b" ]] || return 1
    echo "$a"
}
vm_run_flags() { # [the public address to block; looked up when not given]
    local ip="${1:-}"
    [[ -n "$ip" ]] || ip="$(public_ipv4)" \
        || { echo "Couldn't find this network's public address to block it (two lookups over HTTPS must agree)." >&2; return 1; }
    echo "--no-graphics --no-clipboard --no-audio --no-usb-accessories --net-softnet --net-softnet-block=$VM_BLOCKED,$ip/32"
}

# Whether $CI_ROOT is what setup.sh made: root's all the way up, nothing in it anyone else can
# change, no symlinks, softnet root:$SOFTNET_GROUP 4750 with only ci in the group. Says what's
# wrong and fails otherwise.
verify_tree() {
    local dir mode bad members gid others
    for dir in / /usr /usr/local "$CI_ROOT" "$CI_BIN" "$CI_SCRIPTS"; do
        if [[ ! -d "$dir" || -L "$dir" || "$(/usr/bin/stat -f %u "$dir")" != 0 ]]; then
            echo "$dir isn't a folder of root's." >&2
            return 1
        fi
        mode="$(/usr/bin/stat -f %Lp "$dir")"
        if (((8#$mode & 8#022) != 0)); then
            echo "$dir can be changed by others than root (mode $mode)." >&2
            return 1
        fi
    done
    bad="$(/usr/bin/find -P "$CI_ROOT" \( -type l -o ! -user root -o -perm -0020 -o -perm -0002 \) -print 2>/dev/null | /usr/bin/head -3)"
    if [[ -n "$bad" ]]; then
        echo "In $CI_ROOT, a symlink or something others than root can change: ${bad//$'\n'/, }" >&2
        return 1
    fi
    if [[ "$(/usr/bin/stat -f '%Su:%Sg %Mp%Lp' "$CI_BIN/softnet" 2>/dev/null)" != "root:$SOFTNET_GROUP 4750" ]]; then
        echo "$CI_BIN/softnet isn't root:$SOFTNET_GROUP, mode 4750." >&2
        return 1
    fi
    if has_acl "$CI_ROOT"; then
        echo "In $CI_ROOT, something has an ACL." >&2
        return 1
    fi
    softnet_group_ok || return 1
    for dir in "$CI_BIN/tart" "$CI_ROOT/Tart.app/Contents/MacOS/tart" "$CI_SCRIPTS/orchestrator.sh" "$CI_SCRIPTS/common.sh"; do
        [[ -f "$dir" ]] || { echo "$dir is missing." >&2; return 1; }
    done
}

# Whether a folder, or anything in it, has an ACL: stat and find -perm don't see them, ls -le does
# (a line like " 0: user:… allow write"). grep reads to the end, so ls never dies of SIGPIPE
# (which pipefail would read as "none").
has_acl() { # folder
    { /bin/ls -led "$1"; /bin/ls -leR "$1"; } 2>/dev/null | /usr/bin/grep -E '^ [0-9]+: ' >/dev/null
}

# Whether a VM's folder (a copy of the golden image) holds only files and folders: its disk, NVRAM
# and config are files, and a symlink would point Tart, as ci, at whatever it names.
vm_bundle_ok() { # folder
    [[ -d "$1" && ! -L "$1" && -z "$(/usr/bin/find -P "$1" ! -type f ! -type d -print 2>/dev/null | /usr/bin/head -1)" ]]
}

# Whether $SOFTNET_GROUP has $CI_USER as its only member: no other member, no nested group, no
# one else's own group. (dscl says 0 for a key that isn't there: it's what it prints that counts.)
softnet_group_ok() {
    local gid members others nested
    gid="$(/usr/bin/dscl . -read "/Groups/$SOFTNET_GROUP" PrimaryGroupID 2>/dev/null | /usr/bin/awk '$1 == "PrimaryGroupID:" { print $2 }')"
    members="$(/usr/bin/dscl . -read "/Groups/$SOFTNET_GROUP" GroupMembership 2>/dev/null | /usr/bin/sed -n 's/^GroupMembership: *//p')"
    nested="$(/usr/bin/dscl . -read "/Groups/$SOFTNET_GROUP" NestedGroups 2>/dev/null | /usr/bin/sed -n 's/^NestedGroups: *//p')"
    others="$(/usr/bin/dscl . -list /Users PrimaryGroupID 2>/dev/null | /usr/bin/awk -v gid="$gid" -v me="$CI_USER" '$2 == gid && $1 != me { print $1 }')"
    if [[ ! "$gid" =~ ^[0-9]+$ || "$members" != "$CI_USER" || -n "$others" || -n "$nested" ]]; then
        echo "The group $SOFTNET_GROUP must have $CI_USER as its only member (it has: ${members:-nobody}${others:+; as their own group: ${others//$'\n'/ }}${nested:+; nested groups: $nested})." >&2
        return 1
    fi
}

# Homebrew's softnet, when it's setuid root again: anyone can run it then. Tart puts the bit back
# by itself (asking for your password) when you run a VM with --net-softnet outside CI.
homebrew_softnet_setuid() {
    local softnet
    softnet="$(/usr/bin/readlink -f /opt/homebrew/bin/softnet 2>/dev/null)" || return 1
    [[ -f "$softnet" && -u "$softnet" ]] && echo "$softnet"
}

# Apple's Virtualization framework wants an unlocked login keychain (macOS 15 and later). In a
# login session there's one; as a daemon, ci gets one of its own with an empty password, holding
# nothing but what the framework keeps there (Tart's FAQ, "headless machines").
# check-isolation.sh, as ci under sudo, asks for it whatever the session (--force).
prepare_keychain() { # [--force]
    [[ "${1:-}" == --force || "$(launchctl managername 2>/dev/null)" != Aqua ]] || return 0
    local keychain="$HOME/Library/Keychains/kuvo-ci-vms.keychain-db"
    mkdir -p "$HOME/Library/Keychains"
    { [[ -f "$keychain" ]] || security create-keychain -p '' "$keychain"; } \
        && security set-keychain-settings "$keychain" \
        && security unlock-keychain -p '' "$keychain" \
        && security list-keychains -d user -s "$keychain" \
        && security default-keychain -d user -s "$keychain" \
        && security login-keychain -d user -s "$keychain"
}

# Apple allows two macOS VMs at once, and this Mac has 16 GB: a VM of your own (an image build,
# an isolation check) runs while CI is paused. pause_ci stops CI's idle VM and waits for a job in
# progress to end; resume_ci lets it go on, if pause_ci paused it.
# shellcheck disable=SC2009 # only looks; never kills by name
ci_vm_running() { ps -U "$CI_USER" -o command= 2>/dev/null | grep -q '[t]art run'; }
paused_by_us=""
pause_ci() {
    if [[ ! -e "$SHARED/paused" ]]; then
        # ci can't (the folder is yours): pause it yourself first.
        touch "$SHARED/paused" 2>/dev/null \
            || { echo "Pause CI first: touch $SHARED/paused (as yourself)." >&2; return 1; }
        paused_by_us=1
    fi
    # The orchestrator looks for the file again just before it boots a VM: give one that was
    # about to the moment to show up below.
    sleep 3
    local said=""
    while ci_vm_running; do
        [[ -n "$said" ]] || echo "Waiting for CI's VM to stop (an idle one stops within a minute; a job runs to its end)…"
        said=1
        sleep 10
    done
}
resume_ci() {
    if [[ -n "$paused_by_us" ]]; then rm -f "$SHARED/paused"; fi
    paused_by_us=""
}

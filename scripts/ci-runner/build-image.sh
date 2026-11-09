#!/bin/bash
# shellcheck disable=SC2016 # what's in single quotes expands in the VM, not here
# Builds the golden image the Mac mini's CI VMs are cloned from: Cirrus Labs' macOS 27 base image
# (BASE_IMAGE in common.sh), plus this Mac's Xcode, GitHub's runner and the pre-job hook. Run it
# as yourself, after setup and whenever Xcode changes:
#
#   scripts/ci-runner/build-image.sh
#
# It builds into /Users/Shared/kuvo-ci/tart (Tart's home for it, with Homebrew's Tart), keeps the image before as
# kuvo-ci-golden.previous, and stamps /Users/Shared/kuvo-ci/golden-version; the orchestrator
# takes the new image between jobs. Nothing secret goes in: jobs bring their own secrets, and
# the image is readable by ci.
#   XCODE   the Xcode to copy in (default: the selected one, `xcode-select -p`)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/ci-runner/common.sh
. "$here/common.sh"

fail() {
    echo "$1" >&2
    exit 1
}

[[ "$EUID" -ne 0 ]] || fail "Run this as yourself, not with sudo."
command -v tart >/dev/null || fail "Tart isn't installed (brew install openai/tools/tart)."
[[ -d "$SHARED" && ! -L "$SHARED" && "$(stat -f %u "$SHARED")" == "$EUID" ]] \
    || fail "$SHARED isn't your folder: run scripts/ci-runner/setup.sh first."
mkdir -p "$SHARED_TART"
chmod 755 "$SHARED_TART"
# Big, and rebuilt whenever it's needed.
tmutil addexclusion "$SHARED_TART" 2>/dev/null || true
export TART_HOME="$SHARED_TART"

XCODE="${XCODE:-$(xcode-select -p)}"
XCODE="${XCODE%/Contents/Developer}"
[[ -d "$XCODE/Contents/Developer" ]] || fail "No Xcode at $XCODE."
xcode_version="$(DEVELOPER_DIR="$XCODE/Contents/Developer" xcodebuild -version | tr '\n' ' ')"

# GitHub's runner: the newest release for Apple silicon, checked against the SHA-256 GitHub
# publishes in its release notes (fetched here from the API, downloaded in the VM).
release="$(curl -fsSL --proto '=https' https://api.github.com/repos/actions/runner/releases/latest)"
runner_version="$(/usr/bin/python3 -I -c 'import json,sys; print(json.load(sys.stdin)["tag_name"].lstrip("v"))' <<< "$release")"
runner_sha="$(/usr/bin/python3 -I -c '
import json, re, sys
m = re.search(r"BEGIN SHA osx-arm64 -->([0-9a-f]{64})<", json.load(sys.stdin)["body"])
print(m.group(1) if m else "")' <<< "$release")"
[[ "$runner_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$runner_sha" =~ ^[0-9a-f]{64}$ ]] \
    || fail "Couldn't read the runner's newest version and SHA-256 from GitHub."
echo "Building $GOLDEN: $xcode_version, runner $runner_version."

build="$GOLDEN-build"
run_pid=""
stop_vm() {
    if [[ -n "$run_pid" ]] && kill -0 "$run_pid" 2>/dev/null; then
        tart stop "$build" --timeout 60 >/dev/null 2>&1 || true
        kill "$run_pid" 2>/dev/null || true
        wait "$run_pid" 2>/dev/null || true
    fi
    run_pid=""
}
trap 'stop_vm; tart delete "$build" >/dev/null 2>&1 || true; resume_ci' EXIT

tart delete "$build" >/dev/null 2>&1 || true
tart pull "$BASE_IMAGE"
# Not beside CI's own VM (two macOS VMs at most, and 16 GB): CI waits while this builds.
pause_ci
tart clone "$BASE_IMAGE" "$build"
tart set "$build" --cpu "$VM_CPUS" --memory "$VM_MEMORY_MB" --disk-size "$VM_DISK_GB"

# Nothing shared with it. Its network is Tart's own (NAT), not the jobs' softnet: that softnet
# runs only for ci (setup.sh), and Homebrew's isn't setuid any more. What runs in it is only
# what's named here: the base image pinned by digest, this Mac's Xcode, the runner checked
# against its SHA-256, and the hook. The jobs' network is checked with check-isolation.sh.
flags="--no-graphics --no-clipboard --no-audio --no-usb-accessories"
log="$(mktemp -t kuvo-ci-build)"
# shellcheck disable=SC2086 # the flags are words of their own
tart run $flags "$build" > "$log" 2>&1 &
run_pid=$!

# Each step stops at its first failure (a reader that stops early, like grep -m or head, would
# fail it too: use awk or sed instead).
guest() { tart exec "$build" /bin/bash -lc "set -euo pipefail; $1"; }
echo "Waiting for the VM…"
for _ in $(seq 1 120); do
    if tart exec "$build" /usr/bin/true >/dev/null 2>&1; then break; fi
    kill -0 "$run_pid" 2>/dev/null || { cat "$log" >&2; fail "The VM stopped while booting."; }
    sleep 2
done
guest true || fail "The VM's guest agent never answered."

# Public DNS, since the jobs' gateway is blocked (softnet); Tart's agent needs no network to set it.
echo "Public DNS…"
guest 'networksetup -listallnetworkservices | tail -n +2 | sed "s/^\*//" | while IFS= read -r service; do sudo networksetup -setdnsservers "$service" 1.1.1.1 8.8.8.8; done; scutil --dns | awk "/nameserver/ && n++ < 2"'

echo "Growing its disk to ${VM_DISK_GB} GB…"
# Cirrus's image grows its container itself as it boots; this is for one that doesn't. Either way
# the container must end up within 10 GB of the disk (macOS's own partitions take the rest).
guest 'container=$(diskutil info / | awk -F": *" "/APFS Physical Store/ { print \$2 }")
yes | sudo diskutil repairDisk "${container%s*}" >/dev/null 2>&1 || true
sudo diskutil apfs resizeContainer "$container" 0 >/dev/null 2>&1 || true
size=$(diskutil info "$container" | awk -F"[(]" "/Disk Size/ { split(\$2, a, \" \"); print a[1] }")
[[ $((size / 1000000000)) -ge $(('"$VM_DISK_GB"' - 10)) ]] || { echo "Its container is $((size / 1000000000)) GB." >&2; exit 1; }
df -h / | tail -1'

# Streamed in through Tart's agent as a tar, which keeps the frameworks' symlinks (a --dir share
# doesn't: copying from one fails on each with "Too many levels of symbolic links").
echo "Copying in ${XCODE}…"
guest 'sudo rm -rf /Applications/Xcode.app /tmp/kuvo-xcode && sudo mkdir /tmp/kuvo-xcode'
tar -C "$(dirname "$XCODE")" -cf - "$(basename "$XCODE")" \
    | tart exec -i "$build" sudo tar -C /tmp/kuvo-xcode -xpf - \
    || fail "Copying Xcode into the VM failed."
guest "sudo mv '/tmp/kuvo-xcode/$(basename "$XCODE")' /Applications/Xcode.app && sudo rmdir /tmp/kuvo-xcode"
guest 'sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept
sudo xcodebuild -runFirstLaunch
sudo DevToolsSecurity -enable
codesign --verify --deep --strict /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild
xcodebuild -version
xcrun --find swift >/dev/null
swift --version 2>&1 | sed -n 1p'

# The app's tests run the box with Node from where it usually is (TestBox.node: /usr/local/bin or
# /opt/homebrew/bin, not PATH, so setup-node's doesn't count); the base image's node@24 is keg-only.
echo "Node where the app's tests look for it…"
guest 'set -e; [[ -x /opt/homebrew/bin/node ]] || brew link --force --overwrite node@24 >/dev/null; /opt/homebrew/bin/node --version'

echo "Installing GitHub's runner ${runner_version}…"
guest "set -euo pipefail
rm -rf ~/actions-runner && mkdir -p ~/actions-runner && cd ~/actions-runner
curl -fsSL --proto '=https' -o /tmp/runner.tar.gz https://github.com/actions/runner/releases/download/v$runner_version/actions-runner-osx-arm64-$runner_version.tar.gz
echo '$runner_sha  /tmp/runner.tar.gz' | shasum -a 256 -c - >/dev/null
tar -xzf /tmp/runner.tar.gz && rm /tmp/runner.tar.gz
printf '%s\n' LANG=en_US.UTF-8 ACTIONS_RUNNER_HOOK_JOB_STARTED=/usr/local/kuvo-ci/job-started.sh > .env
printf '%s\n' /opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin > .path"
guest 'sudo mkdir -p /usr/local/kuvo-ci'
tart exec -i "$build" sudo tee /usr/local/kuvo-ci/job-started.sh < "$here/vm/job-started.sh" >/dev/null
guest 'sudo chown -R root:wheel /usr/local/kuvo-ci && sudo chmod 755 /usr/local/kuvo-ci/job-started.sh'

echo "Services…"
# Nothing listening for anyone to come in
# (softnet lets incoming traffic through): no SSH, Screen Sharing or Remote Management, and the
# firewall blocking every incoming connection. The host reaches the guest through Tart's agent,
# over the VM's own socket, not the network. The admin user keeps its password ("admin", from
# Cirrus Labs' image), which logs it in automatically (the session the app's tests need); with
# nothing listening, no one can use it from outside.
guest 'set -e
for service in com.openssh.sshd com.apple.screensharing; do
    sudo launchctl disable "system/$service"
    sudo launchctl bootout "system/$service" 2>/dev/null || true
done
sudo /System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart -deactivate -stop >/dev/null 2>&1 || true
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on >/dev/null
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setblockall on >/dev/null
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getblockall
sudo launchctl print-disabled system | grep -E "sshd|screensharing"'
guest "printf '%s\n' 'built $(date -u +%FT%TZ)' 'base $BASE_IMAGE' '$xcode_version' 'runner $runner_version' | sudo tee /usr/local/kuvo-ci/image.txt >/dev/null"
guest 'brew cleanup -s >/dev/null 2>&1 || true; rm -rf ~/Library/Caches/* 2>/dev/null || true; sudo rm -rf /private/var/tmp/* 2>/dev/null || true'

echo "Shutting it down…"
guest 'sudo shutdown -h now' || true
for _ in $(seq 1 60); do kill -0 "$run_pid" 2>/dev/null || break; sleep 2; done
stop_vm

tart delete "$GOLDEN.previous" >/dev/null 2>&1 || true
if tart get "$GOLDEN" >/dev/null 2>&1; then tart rename "$GOLDEN" "$GOLDEN.previous"; fi
tart rename "$build" "$GOLDEN"
trap - EXIT
# ci reads it (and copies it, as an APFS clone) from here.
chmod -R a+rX "$SHARED_TART/vms/$GOLDEN"
version="$(date -u +%Y%m%dT%H%M%SZ) $xcode_version runner $runner_version"
printf '%s\n' "$version" > "$SHARED/golden-version.new"
chmod 644 "$SHARED/golden-version.new"
mv "$SHARED/golden-version.new" "$SHARED/golden-version"
rm -f "$log"
resume_ci
echo "Built $GOLDEN: $version. The orchestrator takes it before its next job."

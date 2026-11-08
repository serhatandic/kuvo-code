# What the Mac mini's CI scripts share (scripts/ci-runner/). Sourced, never run.
#
# Every job runs in a fresh macOS VM (Tart), cloned from a golden image and deleted after the job:
#   build-image.sh    you, after a new Xcode: builds the golden image into $SHARED/tart
#   setup.sh          you, once: installs the orchestrator as ci, with its GitHub token
#   orchestrator.sh   ci, always (a LaunchAgent): one VM at a time, each with a one-job runner
#   check-isolation.sh  boots a throwaway VM with the jobs' network and checks what it can reach
#   vm/job-started.sh   inside the VM: the runner's pre-job hook, refusing what isn't ours
# shellcheck shell=bash
# shellcheck disable=SC2034 # each script uses its own share of these

REPOSITORY="serhatandic/kuvo-code"
# The runner's labels; the workflows' `runs-on` asks for all four.
RUNNER_LABELS=(self-hosted macOS ARM64 kuvo-mini)
RUNNER_PREFIX="kuvo-mini"

# Yours, read-only to everyone else: the scripts ci runs, and the golden image it copies.
SHARED="/Users/Shared/kuvo-ci"
SHARED_TART="$SHARED/tart"
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

# The VMs' network: softnet lets a VM reach only globally routable addresses (GitHub, Apple's
# notary service, package registries) and the vmnet gateway, which is this Mac. That gateway is
# blocked too, so a VM can't reach this Mac's own services; the guests use public DNS instead of
# the gateway's (build-image.sh). The LAN, Tailscale and other private ranges, and other VMs,
# are softnet's default refusals already.
vmnet_gateway() {
    defaults read /Library/Preferences/SystemConfiguration/com.apple.vmnet Shared_Net_Address 2>/dev/null \
        || echo 192.168.64.1
}
vm_network_flags() {
    echo "--net-softnet --net-softnet-block=$(vmnet_gateway)/32"
}

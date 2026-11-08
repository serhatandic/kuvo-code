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

# The VMs' network. softnet lets a VM send only to globally routable addresses (GitHub, Apple's
# notary service, package registries) and to its gateway, and drops everything but IPv4 and ARP
# (so no IPv6 either). Each softnet picks its own random /29 from the private ranges, and its
# gateway is this Mac, so blocking the private ranges outright blocks the gateway too (a block
# rule beats softnet's own gateway rule), along with the LAN, Tailscale's 100.64/10 and
# link-local. softnet answers DHCP itself before any rule; the guests use public DNS
# (build-image.sh), since the gateway's isn't reachable. No clipboard, audio or USB passes
# through, and no folder is shared.
VM_BLOCKED="10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,169.254.0.0/16"
vm_run_flags() {
    echo "--no-graphics --no-clipboard --no-audio --no-usb-accessories --net-softnet --net-softnet-block=$VM_BLOCKED"
}

# Apple allows two macOS VMs at once, and this Mac has 16 GB: a VM of your own (an image build,
# an isolation check) runs while CI is paused. pause_ci stops CI's idle VM and waits for a job in
# progress to end; resume_ci lets it go on, if pause_ci paused it.
# shellcheck disable=SC2009 # only looks; never kills by name
ci_vm_running() { ps -U ci -o command= 2>/dev/null | grep -q '[t]art run'; }
paused_by_us=""
pause_ci() {
    if [[ ! -e "$SHARED/paused" ]]; then
        touch "$SHARED/paused"
        paused_by_us=1
    fi
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

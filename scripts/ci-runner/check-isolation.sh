#!/bin/bash
# shellcheck disable=SC2016 # what's in single quotes expands in the VM, not here
# shellcheck disable=SC2329 # cleanup runs from the EXIT trap
# Boots a throwaway VM from the golden image with the jobs' own flags (common.sh, vm_run_flags)
# and checks what it can reach: nothing on this Mac (through the VM's real gateway, its LAN or
# Tailscale address), on the LAN, on Tailscale or at the network's public address (the router
# answers there); GitHub, Apple's notary service and the package
# registries jobs use. Each "must be blocked" target is tried from this Mac first: one that's
# closed from here too proves nothing, and counts as inconclusive. It also tries to come in from
# this Mac. The VM is deleted after.
#
# Run it as ci, the way the orchestrator runs VMs (its Tart, its softnet, its PATH), with CI
# paused (a VM of CI's own would be the third), after setup.sh and after any Tart or softnet
# upgrade:
#
#   touch /Users/Shared/kuvo-ci/paused
#   sudo -u ci -i /usr/local/kuvo-ci/scripts/check-isolation.sh
#   rm /Users/Shared/kuvo-ci/paused
#
# As someone else, it uses their Tart and softnet (TART_HOME=/Users/Shared/kuvo-ci/tart: the
# golden image's own home) and pauses CI itself; softnet must be one they can run.
#   IMAGE   what to boot, from /Users/Shared/kuvo-ci/tart (default: kuvo-ci-golden)
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/ci-runner/common.sh
. "$here/common.sh"
if [[ "$(id -un)" == "$CI_USER" ]]; then
    export PATH="$CI_PATH"
    prepare_keychain --force || echo "Couldn't prepare ci's keychain for the VM; it may not start." >&2
fi

IMAGE="${IMAGE:-$GOLDEN}"
TART_DIR="${TART_HOME:-$HOME/.tart}"
vm="kuvo-ci-isolation-$$"
source_vm="$IMAGE"
run_pid=""
cleanup() {
    run_limited 30 tart stop "$vm" --timeout 5 >/dev/null 2>&1
    if [[ -n "$run_pid" ]]; then kill "$run_pid" 2>/dev/null; wait "$run_pid" 2>/dev/null; fi
    run_limited 120 tart delete "$vm" >/dev/null 2>&1
    if [[ "$source_vm" != "$IMAGE" ]]; then
        run_limited 120 tart delete "$source_vm" >/dev/null 2>&1 || rm -rf "${TART_DIR:?}/vms/$source_vm"
    fi
    resume_ci
}
trap cleanup EXIT
# A command in the VM, for at most 30 seconds.
in_vm() { run_limited 30 tart exec "$vm" "$@"; }

lan_if="$(route -n get default 2>/dev/null | awk '/interface:/ { print $2 }')"
lan_ip="$(ipconfig getifaddr "$lan_if" 2>/dev/null)"
router="$(route -n get default 2>/dev/null | awk '/gateway:/ { print $2 }')"
tailscale_ip="$(ifconfig 2>/dev/null | awk '/inet 100\./ { print $2; exit }')"
public_ip="$(public_ipv4)" || { echo "Couldn't find this network's public address (two lookups over HTTPS must agree)." >&2; exit 1; }
flags="$(vm_run_flags "$public_ip")" || exit 1

pause_ci || exit 1
# From another Tart home (ci's): an APFS clone of the image first, as the orchestrator takes it.
if [[ ! "$TART_DIR" -ef "$SHARED_TART" ]]; then
    source_vm="kuvo-ci-isolation-source-$$"
    mkdir -p "$TART_DIR/vms"
    run_limited 900 cp -cR "$SHARED_TART/vms/$IMAGE" "$TART_DIR/vms/$source_vm" || { echo "Couldn't copy $IMAGE." >&2; exit 1; }
fi
run_limited 300 tart clone "$source_vm" "$vm" || exit 1
echo "Booting $IMAGE ($(cat "$SHARED/golden-version" 2>/dev/null)) with $(command -v tart) and $(command -v softnet), as $(id -un)…"
# shellcheck disable=SC2086 # the flags are words of their own
tart run $flags "$vm" >/dev/null 2>&1 &
run_pid=$!
for _ in $(seq 1 90); do in_vm /usr/bin/true >/dev/null 2>&1 && break; kill -0 "$run_pid" 2>/dev/null || break; sleep 2; done
in_vm /usr/bin/true >/dev/null 2>&1 || { echo "The VM didn't boot." >&2; exit 1; }
vm_ip="$(in_vm /usr/sbin/ipconfig getifaddr en0 2>/dev/null)"
gateway="$(in_vm /sbin/route -n get default 2>/dev/null | awk '/gateway:/ { print $2 }')"

tcp_here() { nc -z -G 3 "$1" "$2" >/dev/null 2>&1 && echo open || echo closed; }
tcp_vm() { in_vm /usr/bin/nc -z -G 3 "$1" "$2" >/dev/null 2>&1 && echo open || echo closed; }
# The HTTP status, or 000 when nothing answered (curl prints 000 itself then).
https_vm() { in_vm /usr/bin/curl -sS -o /dev/null --max-time 15 -w '%{http_code}' "$1" 2>/dev/null; }

failures=0 inconclusive=0
blocked_row() { # what, here, vm
    local verdict=ok
    if [[ "$3" == open ]]; then
        verdict=FAIL
        failures=$((failures + 1))
    elif [[ "$2" != open ]]; then
        verdict="inconclusive (closed from here too)"
        inconclusive=$((inconclusive + 1))
    fi
    printf '%-50s here: %-7s VM: %-7s %s\n' "$1" "$2" "$3" "$verdict"
}

echo "VM $vm at ${vm_ip:-?}, its gateway ${gateway:-?}; this Mac: LAN $lan_ip on $lan_if, router $router${tailscale_ip:+, Tailscale $tailscale_ip}"
echo "Flags: $flags"
echo "tart exec runs as: $(in_vm /usr/bin/whoami 2>/dev/null)"
echo
echo "From the VM, must be blocked:"
if [[ -n "$gateway" ]]; then
    for port in 5000 7000; do
        blocked_row "this Mac as the VM's gateway, $gateway:$port" "$(tcp_here "$gateway" "$port")" "$(tcp_vm "$gateway" "$port")"
    done
    dns_vm="$(in_vm /usr/bin/dig +time=2 +tries=1 +short "@$gateway" github.com 2>/dev/null | grep -cE '^[0-9.]+$')"
    dns_here="$(dig +time=2 +tries=1 +short "@$gateway" github.com 2>/dev/null | grep -cE '^[0-9.]+$')"
    blocked_row "DNS at the VM's gateway, $gateway:53/udp" "$([[ $dns_here -gt 0 ]] && echo open || echo closed)" "$([[ $dns_vm -gt 0 ]] && echo open || echo closed)"
fi
if [[ -n "$lan_ip" ]]; then
    for port in 5000 7000; do
        blocked_row "this Mac on the LAN, $lan_ip:$port" "$(tcp_here "$lan_ip" "$port")" "$(tcp_vm "$lan_ip" "$port")"
    done
fi
if [[ -n "$router" ]]; then
    for port in 80 443 53; do
        blocked_row "the LAN's router, $router:$port" "$(tcp_here "$router" "$port")" "$(tcp_vm "$router" "$port")"
    done
fi
# The router answers on the network's public address too (its admin page, forwarded ports).
for port in 80 443; do
    blocked_row "this network's public address, $public_ip:$port" "$(tcp_here "$public_ip" "$port")" "$(tcp_vm "$public_ip" "$port")"
done
if [[ -n "$tailscale_ip" ]]; then
    blocked_row "this Mac on Tailscale, $tailscale_ip:5000" "$(tcp_here "$tailscale_ip" 5000)" "$(tcp_vm "$tailscale_ip" 5000)"
    blocked_row "Tailscale's resolver, 100.100.100.100:53" "$(tcp_here 100.100.100.100 53)" "$(tcp_vm 100.100.100.100 53)"
fi
echo
echo "From this Mac into the VM, must be closed:"
if [[ -n "$vm_ip" ]]; then
    for port in 22 5900 3283 88 445; do
        state="$(tcp_here "$vm_ip" "$port")"
        verdict=ok
        [[ "$state" == closed ]] || { verdict=FAIL; failures=$((failures + 1)); }
        printf '%-50s %-7s %s\n' "the VM, $vm_ip:$port" "$state" "$verdict"
    done
fi
echo
echo "From the VM, must be reachable (HTTP status; codesign's timestamp server is plain HTTP):"
for url in https://api.github.com https://github.com https://objects.githubusercontent.com \
    https://ghcr.io/v2/ https://appstoreconnect.apple.com/notary/v2/submissions http://timestamp.apple.com/ts01 \
    https://registry.npmjs.org https://pypi.org/simple/ https://nodejs.org/dist/index.json; do
    code="$(https_vm "$url")"
    verdict=ok
    [[ "$code" =~ ^[1-9][0-9][0-9]$ ]] || { verdict=FAIL; failures=$((failures + 1)); }
    printf '%-50s %-7s %s\n' "$url" "$code" "$verdict"
done
echo
echo "The VM's DNS servers: $(in_vm /bin/sh -c 'scutil --dns | awk "/nameserver\\[/ { print \$3 }" | sort -u | tr "\n" " "')"
echo
if [[ $failures -eq 0 ]]; then
    echo "Isolation holds ($inconclusive inconclusive: closed from this Mac as well)."
else
    echo "$failures check(s) failed."
fi
exit $((failures > 0))

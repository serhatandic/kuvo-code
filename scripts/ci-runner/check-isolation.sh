#!/bin/bash
# shellcheck disable=SC2016 # what's in single quotes expands in the VM, not here
# shellcheck disable=SC2329 # cleanup runs from the EXIT trap
# Boots a throwaway VM from the golden image with the jobs' own flags (common.sh, vm_run_flags)
# and checks what it can reach: nothing on this Mac (through the VM's real gateway, its LAN or
# Tailscale address), on the LAN or on Tailscale; GitHub, Apple's notary service and the package
# registries jobs use. Each "must be blocked" target is tried from this Mac first: one that's
# closed from here too proves nothing, and counts as inconclusive. It also tries to come in from
# this Mac. CI pauses while it runs; the VM is deleted after.
#
#   TART_HOME=/Users/Shared/kuvo-ci/tart scripts/ci-runner/check-isolation.sh
#   IMAGE   what to boot (default: kuvo-ci-golden)
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/ci-runner/common.sh
. "$here/common.sh"

IMAGE="${IMAGE:-$GOLDEN}"
vm="kuvo-ci-isolation-$$"
run_pid=""
cleanup() {
    tart stop "$vm" --timeout 5 >/dev/null 2>&1 || true
    if [[ -n "$run_pid" ]]; then kill "$run_pid" 2>/dev/null; wait "$run_pid" 2>/dev/null; fi
    tart delete "$vm" >/dev/null 2>&1 || true
    resume_ci
}
trap cleanup EXIT

lan_if="$(route -n get default 2>/dev/null | awk '/interface:/ { print $2 }')"
lan_ip="$(ipconfig getifaddr "$lan_if" 2>/dev/null)"
router="$(route -n get default 2>/dev/null | awk '/gateway:/ { print $2 }')"
tailscale_ip="$(ifconfig 2>/dev/null | awk '/inet 100\./ { print $2; exit }')"

pause_ci
tart clone "$IMAGE" "$vm" || exit 1
# shellcheck disable=SC2046 # the flags are words of their own
tart run $(vm_run_flags) "$vm" >/dev/null 2>&1 &
run_pid=$!
for _ in $(seq 1 90); do tart exec "$vm" /usr/bin/true >/dev/null 2>&1 && break; sleep 2; done
tart exec "$vm" /usr/bin/true >/dev/null 2>&1 || { echo "The VM didn't boot." >&2; exit 1; }
vm_ip="$(tart exec "$vm" /usr/sbin/ipconfig getifaddr en0 2>/dev/null)"
gateway="$(tart exec "$vm" /sbin/route -n get default 2>/dev/null | awk '/gateway:/ { print $2 }')"

tcp_here() { nc -z -G 3 "$1" "$2" >/dev/null 2>&1 && echo open || echo closed; }
tcp_vm() { tart exec "$vm" /usr/bin/nc -z -G 3 "$1" "$2" >/dev/null 2>&1 && echo open || echo closed; }
# The HTTP status, or 000 when nothing answered (curl prints 000 itself then).
https_vm() { tart exec "$vm" /usr/bin/curl -sS -o /dev/null --max-time 15 -w '%{http_code}' "$1" 2>/dev/null; }

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
echo "Flags: $(vm_run_flags)"
echo "tart exec runs as: $(tart exec "$vm" /usr/bin/whoami 2>/dev/null)"
echo
echo "From the VM, must be blocked:"
if [[ -n "$gateway" ]]; then
    for port in 5000 7000; do
        blocked_row "this Mac as the VM's gateway, $gateway:$port" "$(tcp_here "$gateway" "$port")" "$(tcp_vm "$gateway" "$port")"
    done
    dns_vm="$(tart exec "$vm" /usr/bin/dig +time=2 +tries=1 +short "@$gateway" github.com 2>/dev/null | grep -cE '^[0-9.]+$')"
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
echo "The VM's DNS servers: $(tart exec "$vm" /bin/sh -c 'scutil --dns | awk "/nameserver\\[/ { print \$3 }" | sort -u | tr "\n" " "')"
echo
if [[ $failures -eq 0 ]]; then
    echo "Isolation holds ($inconclusive inconclusive: closed from this Mac as well)."
else
    echo "$failures check(s) failed."
fi
exit $((failures > 0))

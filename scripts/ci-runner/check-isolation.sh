#!/bin/bash
# shellcheck disable=SC2016 # what's in single quotes expands in the VM, not here
# shellcheck disable=SC2329 # cleanup runs from the EXIT trap
# Boots a throwaway VM from the golden image with the jobs' own network (common.sh,
# vm_network_flags) and checks, from inside it, what it can reach: nothing on this Mac, the LAN or
# Tailscale; GitHub, Apple's notary service and the package registries jobs use. Each target is
# tried from this Mac first, so a "blocked" means something. Deletes the VM after.
#
#   scripts/ci-runner/check-isolation.sh            (as whoever owns the Tart home it uses)
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
}
trap cleanup EXIT

gateway="$(vmnet_gateway)"
lan_if="$(route -n get default 2>/dev/null | awk '/interface:/ { print $2 }')"
lan_ip="$(ipconfig getifaddr "$lan_if" 2>/dev/null)"
router="$(route -n get default 2>/dev/null | awk '/gateway:/ { print $2 }')"
tailscale_ip="$(ifconfig 2>/dev/null | awk '/inet 100\./ { print $2; exit }')"

tart clone "$IMAGE" "$vm" || exit 1
# shellcheck disable=SC2046
tart run --no-graphics $(vm_network_flags) "$vm" >/dev/null 2>&1 &
run_pid=$!
for _ in $(seq 1 90); do tart exec "$vm" /usr/bin/true >/dev/null 2>&1 && break; sleep 2; done
tart exec "$vm" /usr/bin/true >/dev/null 2>&1 || { echo "The VM didn't boot." >&2; exit 1; }
vm_ip="$(tart ip "$vm" 2>/dev/null)"
bridge_v6="$(ifconfig 2>/dev/null | awk '/^bridge[0-9]+:/ { b = $1 } b && /inet6 fe80/ { sub(/%.*/, "", $2); print $2; exit }')"

# TCP to host:port from here and from the VM; "open" when the connection is made.
tcp_here() { nc -z -G 3 "$1" "$2" >/dev/null 2>&1 && echo open || echo closed; }
tcp_vm() { tart exec "$vm" /usr/bin/nc -z -G 3 "$1" "$2" >/dev/null 2>&1 && echo open || echo closed; }
https_vm() { tart exec "$vm" /usr/bin/curl -sS -o /dev/null --max-time 15 -w '%{http_code}' "$1" 2>/dev/null || echo "000"; }

failures=0
row() { # what, here, vm, expected-from-vm
    local verdict=ok
    [[ "$3" == "$4" ]] || { verdict=FAIL; failures=$((failures + 1)); }
    printf '%-52s here: %-7s VM: %-7s %s\n' "$1" "$2" "$3" "$verdict"
}

echo "VM $vm at ${vm_ip:-?}; this Mac: gateway $gateway, LAN $lan_ip on $lan_if, router $router${tailscale_ip:+, Tailscale $tailscale_ip}"
echo
echo "Must be blocked:"
for port in 5000 7000; do
    row "this Mac through the VMs' gateway, $gateway:$port" "$(tcp_here "$gateway" "$port")" "$(tcp_vm "$gateway" "$port")" closed
done
if [[ -n "$lan_ip" ]]; then
    row "this Mac on the LAN, $lan_ip:5000" "$(tcp_here "$lan_ip" 5000)" "$(tcp_vm "$lan_ip" 5000)" closed
fi
if [[ -n "$router" ]]; then
    for port in 80 443 53; do
        row "the LAN's router, $router:$port" "$(tcp_here "$router" "$port")" "$(tcp_vm "$router" "$port")" closed
    done
fi
if [[ -n "$tailscale_ip" ]]; then
    row "this Mac on Tailscale, $tailscale_ip:5000" "$(tcp_here "$tailscale_ip" 5000)" "$(tcp_vm "$tailscale_ip" 5000)" closed
    row "Tailscale's resolver, 100.100.100.100:53" "$(tcp_here 100.100.100.100 53)" "$(tcp_vm 100.100.100.100 53)" closed
fi
if [[ -n "$bridge_v6" ]]; then
    v6_vm="$(tart exec "$vm" /bin/sh -c "nc -6 -z -G 3 '$bridge_v6%en0' 5000 >/dev/null 2>&1 && echo open || echo closed")"
    row "this Mac over IPv6 on the VMs' bridge, $bridge_v6:5000" "n/a" "$v6_vm" closed
fi
echo
echo "Must be reachable (HTTP status from the VM):"
for url in https://api.github.com https://github.com https://objects.githubusercontent.com \
    https://ghcr.io/v2/ https://appstoreconnect.apple.com/notary/v2/submissions https://timestamp.apple.com/ts01 \
    https://registry.npmjs.org https://pypi.org/simple/ https://nodejs.org/dist/index.json; do
    code="$(https_vm "$url")"
    verdict=ok
    [[ "$code" != 000 ]] || { verdict=FAIL; failures=$((failures + 1)); }
    printf '%-52s VM: %-7s %s\n' "$url" "$code" "$verdict"
done
dns="$(tart exec "$vm" /bin/sh -c 'scutil --dns | awk "/nameserver\\[/ { print \$3 }" | sort -u | tr "\n" " "')"
echo
echo "The VM's DNS servers: $dns"
echo
if [[ $failures -eq 0 ]]; then echo "Isolation holds."; else echo "$failures check(s) failed."; fi
exit $((failures > 0))

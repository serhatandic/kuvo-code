#!/bin/bash
# shellcheck disable=SC2016 # what's in single quotes expands in the VM, not here
# shellcheck disable=SC2329 # cleanup runs from the EXIT trap
# Boots a throwaway VM from the golden image with the jobs' own flags (common.sh, vm_run_flags)
# and checks what it can reach: nothing on this Mac (through the VM's real gateway, its LAN or
# Tailscale address), online tailnet peers on SSH, on the LAN or at the network's public address (the router
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
#   peers="$(/usr/local/kuvo-ci/scripts/check-isolation.sh --discover-peers)"
#   sudo -u ci -i /usr/local/kuvo-ci/scripts/check-isolation.sh --peers "$peers"
#   rm /Users/Shared/kuvo-ci/paused
#
# Only as ci once setup.sh has run. Before it (Homebrew's softnet still setuid), it can run as you
# with TART_HOME=/Users/Shared/kuvo-ci/tart, the golden image's own home; after, it refuses rather
# than let Tart ask to make Homebrew's softnet setuid again.
#   IMAGE   what to boot, from /Users/Shared/kuvo-ci/tart (default: kuvo-ci-golden)
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/ci-runner/common.sh
. "$here/common.sh"
if [[ "$(id -un)" == "$CI_USER" ]]; then
    export PATH="$CI_PATH"
fi

# Print up to two SSH-reachable online peers as a comma-separated IPv4:name list.
tailnet_peers() {
    local cli status peers ip name selected="" count=0
    cli="$(command -v tailscale 2>/dev/null)"
    [[ -n "$cli" ]] || cli=/Applications/Tailscale.app/Contents/MacOS/Tailscale
    [[ -x "$cli" ]] || { echo failed; return; }
    if status="$(run_limited 10 "$cli" status --json 2>/dev/null)" && peers="$(printf '%s' "$status" | /usr/bin/python3 -I -c '
import ipaddress, json, re, sys
try:
    data = json.load(sys.stdin)
    if data.get("BackendState") != "Running": sys.exit(1)
    for peer in data.get("Peer", {}).values():
        if not peer.get("Online") or peer.get("ExitNodeOption") or peer.get("ShareeNode"): continue
        for address in peer.get("TailscaleIPs", []):
            ip = ipaddress.ip_address(address)
            if ip.version == 4 and ip in ipaddress.ip_network("100.64.0.0/10"):
                name = re.sub(r"[^A-Za-z0-9._-]", "", str(peer.get("HostName") or "peer")) or "peer"
                print(str(ip) + "\t" + name)
                break
except (ValueError, TypeError, AttributeError):
    sys.exit(1)
')"; then
        :
    elif status="$(run_limited 10 "$cli" status 2>/dev/null)"; then
        if ! printf '%s\n' "$status" | awk '$1 ~ /^100\.[0-9]+\.[0-9]+\.[0-9]+$/ { found=1; exit } END { exit !found }'; then
            echo failed
            return
        fi
        peers="$(printf '%s\n' "$status" | awk '
            /^#/ { next }
            $1 ~ /^100\.[0-9]+\.[0-9]+\.[0-9]+$/ && $2 != "" {
                if (!self_seen++) next
                if ($0 ~ /[[:space:]]offline/ || $0 ~ /exit node|shared/) next
                split($1, octet, ".")
                if (octet[2] >= 64 && octet[2] <= 127 && octet[3] <= 255 && octet[4] <= 255) {
                    gsub(/[^A-Za-z0-9._-]/, "", $2)
                    print $1 "\t" ($2 == "" ? "peer" : $2)
                }
            }')"
    else
        echo failed
        return
    fi
    while IFS=$'\t' read -r ip name; do
        [[ -n "$ip" ]] || continue
        nc -z -G 3 "$ip" 22 >/dev/null 2>&1 || continue
        selected="${selected:+$selected,}$ip:$name"
        count=$((count + 1))
        [[ $count -lt 2 ]] || break
    done <<< "$peers"
    echo "${selected:-none}"
}

if [[ "${1:-}" == --discover-peers && $# -eq 1 ]]; then
    tailnet_peers
    exit 0
fi
peer_arg="${2:-missing}"
if [[ $# -gt 0 && ( $# -ne 2 || "$1" != --peers ) ]]; then
    echo "Usage: $0 [--discover-peers | --peers LIST]" >&2
    exit 1
fi
if [[ "$peer_arg" != missing && "$peer_arg" != failed && "$peer_arg" != none && ! "$peer_arg" =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.([0-9]{1,3})\.([0-9]{1,3}):[A-Za-z0-9._-]+(,100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.([0-9]{1,3})\.([0-9]{1,3}):[A-Za-z0-9._-]+)?$ ]]; then
    echo "Invalid peer list." >&2
    exit 1
fi
if [[ "$peer_arg" != missing && "$peer_arg" != failed && "$peer_arg" != none ]]; then
    IFS=, read -r -a peer_list <<< "$peer_arg"
    for peer in "${peer_list[@]}"; do
        IFS=. read -r _ _ third fourth <<< "${peer%%:*}"
        if (( 10#$third > 255 || 10#$fourth > 255 )); then
            echo "Invalid peer address." >&2
            exit 1
        fi
    done
fi
if [[ "$(id -un)" == "$CI_USER" ]]; then
    prepare_keychain --force || echo "Couldn't prepare ci's keychain for the VM; it may not start." >&2
fi

# A softnet that isn't setuid root makes Tart ask for your password to make it so, which would
# give Homebrew's (runnable by anyone) the bit back: refuse instead.
softnet="$(command -v softnet)" && softnet="$(readlink -f "$softnet")"
if [[ -z "$softnet" || "$(stat -f %u "$softnet" 2>/dev/null)" != 0 || ! -u "$softnet" ]]; then
    echo "The softnet on your PATH (${softnet:-none}) isn't setuid root, and Tart would ask to make it so." >&2
    echo "Run this as ci: sudo -u ci -i $CI_SCRIPTS/check-isolation.sh" >&2
    exit 1
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
    vm_bundle_ok "$TART_DIR/vms/$source_vm" || { echo "$IMAGE holds something that isn't a file or a folder (a symlink?)." >&2; exit 1; }
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
    if [[ "$peer_arg" == failed || "$peer_arg" == missing || "$peer_arg" == none ]]; then
        case "$peer_arg" in
            failed) reason="Tailscale CLI failed" ;;
            missing) reason="peer discovery not supplied" ;;
            none) reason="no eligible online peers with SSH reachable from this Mac" ;;
        esac
        echo "Tailnet peers: inconclusive ($reason)"
        inconclusive=$((inconclusive + 1))
    else
        IFS=, read -r -a peers <<< "$peer_arg"
        for peer in "${peers[@]}"; do
            peer_ip="${peer%%:*}" peer_name="${peer#*:}"
            blocked_row "tailnet peer $peer_name, $peer_ip:22" "$(tcp_here "$peer_ip" 22)" "$(tcp_vm "$peer_ip" 22)"
        done
    fi
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
    echo "Isolation holds ($inconclusive inconclusive checks)."
else
    echo "$failures check(s) failed."
fi
exit $((failures > 0))

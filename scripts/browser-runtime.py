#!/usr/bin/env python3
"""Pins the browser Kuvo Code runs on machines: on Linux in box/src/link/browser/linux.json,
on Macs in mac.json beside it. Each box sets it up itself from these (KuvoLink's PROTOCOL.md, "The
browser on a machine"): rebuild kuvo-link.js after running this (scripts/build-box.sh).

The browser is Google's Chrome for Testing, the full browser, run headless (Chrome's own headless
mode, not the separate headless shell, which sites take for a bot: Google won't sign anyone in from
it, and X limits it). It needs shared libraries that servers often don't have, and fonts, which
they often have none of. Rather than have anyone
install packages on their machine, the box brings them along, into ~/.kuvo-code/browser there,
and points the browser at them: it uses nothing from the machine but the C library (glibc),
which the engine needs too.

The libraries are Enterprise Linux 8's (Rocky Linux 8's builds): built against glibc 2.28, older
than the engine's own minimum (2.30), they load on any distribution the engine runs on, and they
get security fixes until 2029. Starting from the libraries the Chromium build links to, this
script finds the packages that provide them, and what those need in turn, and writes down each
file's checksum. The box downloads only those files, and checks each one before it unpacks
anything.

    scripts/browser-runtime.py                      # latest stable Chromium
    scripts/browser-runtime.py --chromium 155.0.8059.79

Run it to move to a newer Chromium or newer library updates, then build and try a machine.
"""

import argparse
import gzip
import hashlib
import http.client
import io
import json
import os
import re
import struct
import sys
import urllib.request
import xml.etree.ElementTree as ElementTree
import zipfile

OUT = os.path.join(os.path.dirname(__file__), "..", "box", "src", "link", "browser", "linux.json")
# Macs that are machines run Chrome for Testing as it comes: nothing else to bring. In a file of its
# own, as a box sets up a new build whenever its system's file changes.
MAC_OUT = os.path.join(os.path.dirname(__file__), "..", "box", "src", "link", "browser", "mac.json")

CFT = "https://storage.googleapis.com/chrome-for-testing-public"
CHROMIUM_ZIPS = {"x86_64": "linux64/chrome-linux64.zip", "aarch64": "linux-arm64/chrome-linux-arm64.zip"}
MAC_CHROMIUM_ZIPS = {"x86_64": "mac-x64/chrome-mac-x64.zip", "aarch64": "mac-arm64/chrome-mac-arm64.zip"}
ROCKY = "https://dl.rockylinux.org/pub/rocky/8"
REPOS = ["BaseOS", "AppStream"]

# Servers often have no fonts at all, and pages would show boxes for text.
FONTS = ["liberation-sans-fonts", "liberation-serif-fonts", "liberation-mono-fonts", "dejavu-sans-fonts", "google-noto-emoji-color-fonts", "google-droid-sans-fonts"]

# The C library, which every machine that runs the engine has, and packages that hold no library
# the browser loads (scripts, settings, the system's own services).
SKIP = {
    "glibc", "glibc-common", "glibc-minimal-langpack", "glibc-all-langpacks", "libgcc", "basesystem",
    "filesystem", "setup", "bash", "coreutils", "coreutils-single", "grep", "sed", "info", "shadow-utils",
    "systemd", "systemd-pam", "dbus", "dbus-daemon", "dbus-common", "dbus-tools", "dbus-broker",
    "fontpackages-filesystem", "liberation-fonts-common", "dejavu-fonts-common",
    "crypto-policies", "crypto-policies-scripts", "ca-certificates", "p11-kit-trust", "nss-sysinit",
    "libX11-common", "xkeyboard-config", "shared-mime-info", "gsettings-desktop-schemas",
    "tzdata", "chkconfig", "pkgconf-pkg-config", "python3-libs", "platform-python",
}


def fetch(url, attempts=4):
    # A connection that drops partway (a big file, a busy mirror) is tried again.
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=300) as response:
                return response.read()
        except (OSError, http.client.HTTPException) as error:
            if attempt == attempts - 1:
                raise
            print(f"  {url}: {error}; trying again", file=sys.stderr)


def needed(elf):
    """The shared libraries an ELF64 little-endian file links to (its DT_NEEDED entries)."""
    phoff, = struct.unpack_from("<Q", elf, 0x20)
    phentsize, phnum = struct.unpack_from("<HH", elf, 0x36)
    segments = [struct.unpack_from("<IIQQQQQQ", elf, phoff + i * phentsize) for i in range(phnum)]

    def offset(address):
        for kind, _, file_offset, virtual, _, size, _, _ in segments:
            if kind == 1 and virtual <= address < virtual + size:
                return address - virtual + file_offset
        raise ValueError(address)

    dynamic = next(s for s in segments if s[0] == 2)
    entries, strtab = [], None
    for i in range(dynamic[5] // 16):
        tag, value = struct.unpack_from("<qQ", elf, dynamic[2] + i * 16)
        if tag == 0:
            break
        if tag == 1:
            entries.append(value)
        if tag == 5:
            strtab = offset(value)
    return [elf[strtab + e:elf.index(b"\0", strtab + e)].decode() for e in entries]


def rpm_version_key(evr):
    """RPM's version ordering, as a key to compare with."""
    def part(text):
        return [(1, int(chunk)) if chunk.isdigit() else (0, chunk) for chunk in re.findall(r"[0-9]+|[A-Za-z]+", text or "")]
    epoch, version, release = evr
    return (int(epoch or 0), part(version), part(release))


def repository(arch):
    """Every package for `arch` in the repositories, newest version of each, and who provides what."""
    ns = {"c": "http://linux.duke.edu/metadata/common", "rpm": "http://linux.duke.edu/metadata/rpm", "r": "http://linux.duke.edu/metadata/repo"}
    found, provides = {}, {}
    for repo in REPOS:
        base = f"{ROCKY}/{repo}/{arch}/os"
        index = ElementTree.fromstring(fetch(f"{base}/repodata/repomd.xml"))
        primary = next(d for d in index.findall("r:data", ns) if d.get("type") == "primary").find("r:location", ns).get("href")
        root = ElementTree.parse(io.BytesIO(gzip.decompress(fetch(f"{base}/{primary}")))).getroot()
        for package in root.findall("c:package", ns):
            if package.find("c:arch", ns).text not in (arch, "noarch"):
                continue
            version = package.find("c:version", ns)
            entry = {
                "name": package.find("c:name", ns).text,
                "evr": (version.get("epoch"), version.get("ver"), version.get("rel")),
                "repo": repo,
                "path": package.find("c:location", ns).get("href"),
                "sha256": package.find("c:checksum", ns).text,
                "size": int(package.find("c:size", ns).get("package")),
                "provides": [e.get("name") for e in package.findall("c:format/rpm:provides/rpm:entry", ns)],
                "requires": [e.get("name") for e in package.findall("c:format/rpm:requires/rpm:entry", ns)],
            }
            name = entry["name"]
            if name not in found or rpm_version_key(entry["evr"]) > rpm_version_key(found[name]["evr"]):
                found[name] = entry
    for name, entry in found.items():
        for capability in entry["provides"] + [name]:
            provides.setdefault(capability, set()).add(name)
    return found, provides


def closure(sonames, packages, found, provides, arch):
    """The packages that provide `sonames` and `packages`, and everything those need."""
    suffix = "()(64bit)"
    skipped = {capability for name in SKIP if name in found for capability in found[name]["provides"] + [name]}
    chosen, queue = {}, [s + suffix for s in sonames] + list(packages)
    while queue:
        capability = queue.pop()
        if capability in skipped or capability.startswith(("/", "rpmlib(", "config(")):
            continue
        providers = sorted(provides.get(capability, ()))
        if not providers:
            sys.exit(f"Nothing provides {capability} for {arch}")
        if any(p in chosen or p in SKIP for p in providers):
            continue
        name = providers[0]
        chosen[name] = found[name]
        queue.extend(found[name]["requires"])
    return chosen


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--chromium", help="Chrome for Testing version (default: latest Stable)")
    parser.add_argument("--mac-only", action="store_true", help="Only the Macs' pin, leaving Linux's as it is")
    args = parser.parse_args()

    version = args.chromium
    if not version:
        channels = json.loads(fetch("https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json"))
        version = channels["channels"]["Stable"]["version"]

    mac = {"chromium": {"version": version}}
    for arch, path in MAC_CHROMIUM_ZIPS.items():
        url = f"{CFT}/{version}/{path}"
        print(f"  downloading {url}", file=sys.stderr)
        data = fetch(url)
        mac["chromium"][arch] = {"url": url, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
    with open(MAC_OUT, "w") as file:
        json.dump(mac, file, indent=1)
        file.write("\n")
    print(f"Wrote {os.path.relpath(MAC_OUT)}", file=sys.stderr)
    if args.mac_only:
        return

    print(f"Chromium {version}, libraries from Rocky Linux 8", file=sys.stderr)
    runtime = {"chromium": {"version": version}, "packages": {}}
    for arch, path in CHROMIUM_ZIPS.items():
        url = f"{CFT}/{version}/{path}"
        print(f"  downloading {url}", file=sys.stderr)
        data = fetch(url)
        runtime["chromium"][arch] = {"url": url, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            binary = next(n for n in archive.namelist() if n.endswith("/chrome"))
            sonames = needed(archive.read(binary))

        found, provides = repository(arch)
        chosen = closure(sonames, FONTS, found, provides, arch)
        runtime["packages"][arch] = [
            {
                "name": name,
                "version": "-".join(entry["evr"][1:]),
                "repo": entry["repo"],
                "path": entry["path"],
                "sha256": entry["sha256"],
                "size": entry["size"],
            }
            for name, entry in sorted(chosen.items())
        ]
        total = sum(entry["size"] for entry in runtime["packages"][arch]) / 1e6
        print(f"  {arch}: {len(chosen)} packages, {total:.1f} MB: {' '.join(sorted(chosen))}", file=sys.stderr)

    with open(OUT, "w") as file:
        json.dump(runtime, file, indent=1)
        file.write("\n")
    print(f"Wrote {os.path.relpath(OUT)}", file=sys.stderr)


if __name__ == "__main__":
    main()

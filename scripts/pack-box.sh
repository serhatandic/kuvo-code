#!/bin/sh
# Packs the box's release from a built "Kuvo Code.app" (protocol/PROTOCOL.md, "Updates"):
# what every box runs (the app's `--write-box-files`), with each helper bundle the app carries
# (`Contents/Helpers/<name>.app`, signed already) as `bin/<name>.app`, packed as
# `box-<version>.tar.gz`, and `boxes.json`, its manifest, signed (scripts/sign-box.mjs). The release
# workflow publishes both, for machines to update themselves with; scripts/app-box-release.sh puts
# them in the app, for it to offer this Mac's box as it updates (`kuvo/box/update {from}`).
#   KUVO_BOX_SIGNING_KEY=<PEM> scripts/pack-box.sh <app> <version> <pack's URL> <folder>
#   <pack's URL>   where the pack is published, ending in box-<version>.tar.gz: a box finds the pack
#                  by that name beside boxes.json when it's given the folder
#   NODE           the Node to sign with (default: node)
set -eu

if [ $# -ne 4 ] || [ -z "${KUVO_BOX_SIGNING_KEY:-}" ]; then
    echo "Usage: KUVO_BOX_SIGNING_KEY=<PEM> scripts/pack-box.sh <app> <version> <pack's URL> <folder>" >&2
    exit 2
fi
APP=$(cd "$1" && pwd -P) VERSION=$2 URL=$3
mkdir -p "$4"
OUT=$(cd "$4" && pwd -P)
NODE=${NODE:-node}
cd "$(dirname "$0")/.."
case "$URL" in
    */"box-$VERSION.tar.gz") ;;
    *) echo "The pack's URL must end in box-$VERSION.tar.gz." >&2; exit 2 ;;
esac

work=$(mktemp -d "${TMPDIR:-/tmp}/kuvo-box-release.XXXXXXXX")
trap 'rm -rf "$work"; rm -f "$OUT/box-$VERSION.tar.gz.new" "$OUT/boxes.json.new"' EXIT
box="$work/box"
# (Never with the key: the app only writes files.)
env -u KUVO_BOX_SIGNING_KEY "$APP/Contents/MacOS/Kuvo Code" --write-box-files "$box"
test "$(cat "$box/bin/box-version")" = "$VERSION" || { echo "The app's box files are $(cat "$box/bin/box-version")'s, not $VERSION's." >&2; exit 1; }
for file in kuvo-link.js kuvo-browser.js kuvo-agents.js kuvo-start kuvo-launch; do
    test -s "$box/bin/$file" || { echo "The app's box files have no $file." >&2; exit 1; }
done

# Its helper bundles, whole, and named in box.json's `bundles` file by file, as a box checks and
# swaps them (a box from before bundles passes them over).
for helper in "$APP/Contents/Helpers/"*.app; do
    [ -d "$helper" ] || continue
    cp -Rp "$helper" "$box/bin/"
done
"$NODE" --input-type=module - "$box" <<'EOF'
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const box = process.argv[2];
// As a box takes them (box/src/link/updates/update.ts, BUNDLE and BUNDLE_PART): no part
// starting with a dot, no links, nothing but folders and files.
const bundleName = /^bin\/[A-Za-z0-9][A-Za-z0-9._ -]*\.app$/;
const part = /^(?:[A-Za-z0-9_][A-Za-z0-9._+ -]*\/)*[A-Za-z0-9_][A-Za-z0-9._+ -]*$/;
const record = path.join(box, "box.json");
const manifest = JSON.parse(fs.readFileSync(record, "utf8"));
for (const name of fs.readdirSync(path.join(box, "bin")).filter(name => name.endsWith(".app")).sort()) {
  const bundle = `bin/${name}`;
  if (!bundleName.test(bundle)) {
    console.error(`A box can't take a bundle named ${name}.`);
    process.exit(1);
  }
  const files = {};
  for (const entry of fs.readdirSync(path.join(box, bundle), { recursive: true, encoding: "utf8" }).sort()) {
    const stat = fs.lstatSync(path.join(box, bundle, entry));
    if (stat.isDirectory()) continue;
    if (!stat.isFile() || !part.test(entry)) {
      console.error(`A box can't take ${bundle}/${entry} in a bundle: only plain files, named without a leading dot.`);
      process.exit(1);
    }
    files[entry] = crypto.createHash("sha256").update(fs.readFileSync(path.join(box, bundle, entry))).digest("hex");
  }
  (manifest.bundles ??= {})[bundle] = files;
}
fs.writeFileSync(record, JSON.stringify(manifest, null, 2) + "\n");
EOF

pack="$OUT/box-$VERSION.tar.gz"
# No owners, and on a Mac no extended attributes or AppleDouble files (so a helper's signature has
# to be in its files, as a Mach-O program's is).
if tar --version 2>/dev/null | grep -q bsdtar; then
    COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata --uid 0 --gid 0 -czf "$pack.new" -C "$box" .
else
    tar --owner=0 --group=0 --numeric-owner -czf "$pack.new" -C "$box" .
fi
# Each bundle, as a box unpacks it, still signed as it was (a signature kept in extended attributes
# doesn't survive packing). Where there's codesign: a Mac, as a release is built.
if command -v codesign >/dev/null 2>&1 && ls -d "$box/bin/"*.app >/dev/null 2>&1; then
    mkdir "$work/unpacked"
    tar -xzf "$pack.new" -C "$work/unpacked"
    for helper in "$work/unpacked/bin/"*.app; do
        codesign --verify --strict --deep "$helper" || { rm -f "$pack.new"; echo "$(basename "$helper") isn't signed as it was once packed." >&2; exit 1; }
    done
fi
mv -f "$pack.new" "$pack"
"$NODE" scripts/sign-box.mjs "$VERSION" "$pack" "$URL" "$box/box.json" > "$OUT/boxes.json.new"
mv -f "$OUT/boxes.json.new" "$OUT/boxes.json"
echo "Packed the box's $VERSION release into $OUT"

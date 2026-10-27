#!/bin/sh
# Prints one version's notes from CHANGELOG.md, without its heading:
#   scripts/release-notes.sh 0.1.3
# Without a version, prints the newest section. Fails when the notes are missing,
# so a release can't go out without them.
set -eu
cd "$(dirname "$0")/.."

notes=$(awk -v version="${1:-}" '
    /^## / {
        if (found) exit
        found = (version == "" || $2 == version)
        next
    }
    found
' CHANGELOG.md | sed -e '/./,$!d')

if [ -z "$notes" ]; then
    echo "CHANGELOG.md has no notes for ${1:-any version}. Add a \"## ${1:-<version>}\" section." >&2
    exit 1
fi
# An @word in the notes would mention that GitHub account and list it among the release's
# contributors ("@User" named github.com/user): written as code, it's just text.
# What's New's notes (<!-- symbol: … -->) are for the apps, not the release's page or the update window.
printf '%s\n' "$notes" | perl -pe 's/\s*<!--.*?-->//g; s/(^|[^`\w])@([A-Za-z0-9-]+)/$1`\@$2`/g'

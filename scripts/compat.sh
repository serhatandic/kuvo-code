#!/bin/sh
# Lists the code that's there only for released Macs (PROTOCOL.md, "For released Macs"), by the
# version it's for, then by item, so each version's paths can go together:
#   scripts/compat.sh           every marker, the ones that go first first
#   scripts/compat.sh beta.1    one version's: beta.1 (Kuvo Code 0.8.0-beta.1, goes when 0.8.0
#                               ships) or 0.7 (Kuvo Code 0.5 to 0.7.2, goes 3 months after 0.8.0)
# A marker is a comment beside the code, `COMPAT(<version> <item>): what it does. Goes …`, whose
# item PROTOCOL.md names in that section (`<!-- compat: <version> <item> -->`). Code needed by both
# versions is marked for 0.7, which goes last. box/bridge-tests/compat.test.js holds
# the markers and the list to each other.
set -eu
cd "$(dirname "$0")/.."

want=${1:-}
case "$want" in
  "" | 0.7 | beta.1) ;;
  *) echo "Usage: scripts/compat.sh [0.7 | beta.1]" >&2; exit 2 ;;
esac

# The same files the test reads: the code as written (a bundle leaves comments out), new files too.
git grep --untracked -n -I -E 'COMPAT\((0\.7|beta\.1) [a-z0-9-]+\)' -- \
  'swift/KuvoCode' 'box/src' 'swift/OpenCodeKit/Sources' 'swift/KuvoClient/Sources' 'swift/KuvoLink/Sources' 'scripts' \
  ':(exclude)box/dist/kuvo-agents.js' ':(exclude)box/dist/kuvo-browser.js' ':(exclude)scripts/compat.sh' |
  grep -E '^[^:]+\.(swift|ts|js|mjs|sh|py):' |
  awk -v want="$want" '
    {
      split($0, at, ":"); where = at[1] ":" at[2]
      match($0, /COMPAT\((0\.7|beta\.1) [a-z0-9-]+\)/)
      tag = substr($0, RSTART + 7, RLENGTH - 8); split(tag, part, " ")
      if (want != "" && part[1] != want) next
      words = substr($0, RSTART + RLENGTH); sub(/^:[ \t]*/, "", words)
      # beta.1 goes first, so it lists first.
      print (part[1] == "beta.1" ? 1 : 2) "\t" part[1] "\t" part[2] "\t" where "\t" words
    }' |
  awk -F '\t' -v OFS='\t' '{ split($4, at, ":"); print $0, at[1], at[2] }' |
  sort -t "$(printf '\t')" -k1,1 -k3,3 -k6,6 -k7,7n |
  awk -F '\t' '
    $2 " " $3 != last { if (last != "") print ""; print $2 " " $3; last = $2 " " $3 }
    { printf "  %s  %s\n", $4, $5 }'

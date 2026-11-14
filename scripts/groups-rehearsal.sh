#!/bin/sh
# The upgrade rehearsal for this Mac's group chats (GroupMigration): real released builds make
# chats, then this checkout, run as Kuvo Code itself, moves them into its box. Released builds can
# only run as `run.kuvo.code`, so this uses your Kuvo Code's own folder and settings: it saves them
# first and puts them back at the end. Run it with someone at the Mac (macOS asks things the first
# time each build opens), and quit Kuvo Code before each step. Each step but check asks you to
# type yes first, and won't start without a terminal. CONTRIBUTING.md, "Rehearsing the group
# chats' upgrade", has the steps.
#
#   prepare                 downloads 0.5.22, 0.6.6, 0.7.2 and 0.8.0-beta.1 from the releases, and
#                           builds this checkout as run.kuvo.code (signed with your team)
#   save                    keeps your Kuvo Code's folder and settings in build/Rehearsal/saved
#   fresh                   empties them, for the next version's run (after save)
#   open <version|this>     opens that build (quit the one open first)
#   check                   says what the move did: each chat in the box, what was taken, the copy
#                           of the old files, a seat left on a machine, the bots' descriptions
#   restore                 quits Kuvo Code and puts your folder and settings back as saved
set -eu
cd "$(dirname "$0")/.."

ROOT="build/Rehearsal"
SUPPORT="$HOME/Library/Application Support/run.kuvo.code"
SAVED="$ROOT/saved"
VERSIONS="0.5.22 0.6.6 0.7.2 0.8.0-beta.1"

# It works on the real Kuvo Code, so it goes on only for someone at the terminal who says so.
. scripts/real-app-guard.sh
case "${1:-}" in
prepare | save | fresh | open | restore) real_app_confirm "scripts/groups-rehearsal.sh ${1}" ;;
esac

quit() {
  osascript -e 'tell application id "run.kuvo.code" to quit' >/dev/null 2>&1 || true
  while pgrep -x "Kuvo Code" >/dev/null; do sleep 1; done
}

case "${1:-}" in
prepare)
  mkdir -p "$ROOT/apps"
  for v in $VERSIONS; do
    [ -d "$ROOT/apps/$v.app" ] && continue
    rm -rf "$ROOT/dmg-$v" && mkdir -p "$ROOT/dmg-$v"
    gh release download "v$v" -p KuvoCode.dmg -D "$ROOT/dmg-$v"
    mount=$(hdiutil attach -nobrowse -readonly "$ROOT/dmg-$v/KuvoCode.dmg" | tail -n 1 | cut -f 3)
    cp -R "$mount/Kuvo Code.app" "$ROOT/apps/$v.app"
    hdiutil detach "$mount" >/dev/null
    rm -rf "$ROOT/dmg-$v"
  done
  xcodebuild build -project swift/KuvoCode.xcodeproj -scheme KuvoCode -configuration Release -derivedDataPath "$ROOT/DerivedData" \
    -clonedSourcePackagesDirPath build/SourcePackages APP_BUNDLE_ID=run.kuvo.code >"$ROOT/build.log" 2>&1
  rm -rf "$ROOT/apps/this.app"
  cp -R "$ROOT/DerivedData/Build/Products/Release/Kuvo Code.app" "$ROOT/apps/this.app"
  echo "Ready: $(ls "$ROOT/apps" | tr '\n' ' ')"
  ;;
save)
  quit
  [ -e "$SAVED" ] && { echo "Saved already, in $SAVED: restore first, or remove it." >&2; exit 1; }
  mkdir -p "$SAVED"
  [ -d "$SUPPORT" ] && cp -R "$SUPPORT" "$SAVED/support"
  defaults export run.kuvo.code "$SAVED/settings.plist" 2>/dev/null || true
  echo "Saved your Kuvo Code's folder and settings in $SAVED"
  ;;
fresh)
  quit
  [ -d "$SAVED" ] || { echo "Save first." >&2; exit 1; }
  rm -rf "$SUPPORT"
  defaults delete run.kuvo.code >/dev/null 2>&1 || true
  echo "Empty: open a released version next."
  ;;
open)
  quit
  app="$ROOT/apps/${2:?which version, or this}.app"
  [ -d "$app" ] || { echo "No $app: run prepare." >&2; exit 1; }
  open "$app"
  ;;
check)
  python3 -I - "$SUPPORT" <<'PY'
import json, os, sys
support = sys.argv[1]
groups = os.path.join(support, "groups")
def read(path):
    try:
        return json.load(open(path))
    except Exception:
        return None
old = read(os.path.join(support, "groups.json")) or []
print("groups.json (left for an older version):", [chat.get("name") for chat in old])
for chat in old:
    record = read(os.path.join(groups, chat["id"], "group.json"))
    messages = read(os.path.join(groups, chat["id"], "messages.json")) or []
    if record is None:
        print("  NOT MOVED:", chat["id"], chat.get("name"))
        continue
    group = record["group"]
    print("  %s %s: %s, %d messages (%d before), seats %s, heard %s, meeting %s" % (
        chat["id"], group["name"], record["status"], len(messages), len(read(os.path.join(groups, chat["id"] + ".json")) or []),
        sorted(group.get("seats", {})), sorted(group.get("heard", {})), (group.get("meeting") or {}).get("every")))
print("taken:", read(os.path.join(groups, "imported.json")))
print("seats left on machines:", read(os.path.join(groups, "orphan-seats.json")))
print("still to be told:", read(os.path.join(groups, "pending-memory.json")))
backups = os.path.join(support, "Backups")
print("old files kept:", sorted(name for name in os.listdir(backups) if name.startswith("groups-")) if os.path.isdir(backups) else [])
bots = read(os.path.join(support, "bots.json")) or []
for bot in bots:
    if bot.get("machine"):
        continue
    folder = bot["folder"]
    print("  bot %s: description %s, conversation %s" % (bot["name"], os.path.exists(os.path.join(folder, "bot.json")), os.path.exists(os.path.join(folder, "session"))))
PY
  ;;
restore)
  quit
  [ -d "$SAVED" ] || { echo "Nothing saved in $SAVED." >&2; exit 1; }
  rm -rf "$SUPPORT"
  [ -d "$SAVED/support" ] && cp -R "$SAVED/support" "$SUPPORT"
  defaults delete run.kuvo.code >/dev/null 2>&1 || true
  [ -f "$SAVED/settings.plist" ] && defaults import run.kuvo.code "$SAVED/settings.plist"
  rm -rf "$SAVED"
  echo "Your Kuvo Code's folder and settings are back as they were."
  ;;
*)
  sed -n '2,20p' "$0"
  exit 2
  ;;
esac

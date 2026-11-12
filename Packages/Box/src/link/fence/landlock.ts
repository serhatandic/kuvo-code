// The sandbox's policy in Linux's own terms: Landlock, set up by a small script the engine's own Bun
// runs (`bin/kuvo-fence.js`, through `bun:ffi`) before it becomes the command's shell, so nothing
// new ships for each architecture. Landlock only grants: reads everywhere but what's hidden, by
// granting each neighbour on the way down to it; in your home, files added and changed but never
// removed or moved, but for what runs later and your personal folders (only read); everything in
// the conversation's folder, its repository, the temporary folders, devices and tools' caches; signals and abstract sockets only
// inside the sandbox (from Linux's Landlock 6). Landlock grants a folder whole, so what it can't
// refuse inside a folder it writes (the engine's and the coding agents' settings there), it doesn't.
//
// Nor can Landlock refuse a socket, and your session's services listen on them: systemd's in
// `/run/user/<uid>` runs whatever it's asked outside the sandbox (`systemd-run --user`), beside your
// bus, keyring and agents; tmux's server types into your sessions; an X server takes keystrokes. So
// each command first gets a namespace of its own (`unshare`, util-linux's, which the machine has: a
// process with threads, like Bun, can't make one itself) where those folders are empty, and then its
// Landlock rules (`HIDE`). There too, what git runs or is led by in the repositories it writes is
// kept as it is (`KEEP_GIT`), as macOS's rules keep it (seatbelt.ts, GIT_GUARDED).

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { didntFinish } from "./finished";
import type { FencePolicy } from "./policy";

/** What the Linux script reads: the policy's parts it needs. */
export function landlockPolicy(policy: FencePolicy): string {
  return JSON.stringify({ hidden: [...policy.kuvo, ...policy.secrets], secrets: policy.secrets, readable: policy.kuvoReadable, writable: [...policy.writable, ...policy.commandCaches], readOnly: policy.readOnly,
    homeWrites: policy.homeWrites ?? [], homeKept: policy.homeKept ?? [], homeOpen: policy.homeOpen ?? [], personal: policy.personal ?? [] }) + "\n";
}

/**
 * What git runs, or is led by, in a repository a command writes runs outside the sandbox the next
 * time git works there (in your terminal, Changes' Commit): its settings, its hooks, where its common
 * folder is (`commondir`), a linked worktree's way back to it, its submodules' repositories, and the
 * folders that hold those. Landlock grants a folder whole, so it can't keep these; each command's
 * namespace does, before the command starts (part of HIDE, as its root): each is mounted on itself,
 * which a command can't move, remove or replace, and those git reads, read-only (`keep`), as macOS's
 * rules have them (seatbelt.ts, GIT_GUARDED). In the conversation's repository <git>, the `.git`
 * folder up from its folder, each repository Also Allowed holds (`<folder>/.git`), and each
 * submodule's repository below theirs:
 * - the repository's folder, kept; its `config`, `config.worktree`, `commondir`, `gitdir` and
 *   `hooks`, read-only (one that's a link runs nothing: a command could trade the link for its own,
 *   and where it leads, a folder whose mounts hide what's in it, `/tmp`, would be mounted anew);
 * - `worktrees`, read-only: none is made, moved or removed; each worktree's own folder in it kept,
 *   written as git works there (and as `git gc` tidies every worktree's reflogs, locking its
 *   `HEAD`), but for its `commondir`, `gitdir`, `config.worktree` and `modules`, read-only; its
 *   `commondir` must lead back to the repository (the conversation's own runs nothing otherwise, and
 *   another's is kept read-only whole); the conversation's own `modules` kept as a repository's;
 * - `modules`, and every folder in it but each submodule's repository, read-only: none is made,
 *   moved or removed; and the `.git` file of each submodule's work tree, read-only (not the folder
 *   it's in, which a command can move away and put another in its place);
 * - and the `.git` file that leads a worktree it works in to its repository, up from it, read-only.
 * (Not the folders these are in, which a command could move away from a folder above that it writes,
 * an Also Allowed one or /tmp, and put another repository in their place: each mount is a border
 * files aren't moved or linked across, and the conversation's folder one would keep tools' caches'
 * links and its agent's moves out of it.)
 * Mounts keep only what's there. A name git reads that isn't there yet would be made in a folder git
 * must make files in (`index.lock` beside `commondir`), which neither Landlock nor a mount tells
 * apart: so the launcher first gives each repository what it lacks of those (`MAKE_GIT`), and one
 * that still lacks one is checked as every other, then its folder is read-only (but the worktrees'
 * own folders and submodules' repositories in it, each kept on its own as above). A `commondir` that leads
 * anywhere else, a link where these are, or one that can't be kept, runs nothing. The rest git reads there starts no program
 * (`info/attributes` names drivers only settings define, `objects/info/alternates` and `remotes` name
 * objects and addresses), or isn't read in a worktree's own folder (its `hooks`, `config`, `info`).
 */
const KEEP_GIT = String.raw`# (Read-only in two steps, a bind and then its remount, which libmount makes with the flags a mount
# from outside the namespace keeps locked, nosuid and nodev: in one, util-linux before 2.39 drops
# them, and Linux refuses it. Where even that fails, the command doesn't run: its namespace stays.)
# (Each mounted on itself never by a path a link swapped in meanwhile could lead elsewhere, which
# mount would follow, mounting what it leads to anew: a folder from within it, as it is; a file by its
# path. Each noted, and all checked once kept, below.)
keep() {
  [ ! -L "$1" ] || fail "$1 is a link, which it can't keep as it is. Ask the user."
  [ -e "$1" ] || return 1
  if [ -d "$1" ]; then ( cd -P "$1" 2>/dev/null && [ "$(pwd -P)" = "$1" ] && mount -c --bind . . 2>/dev/null )
  else mount -c --bind "$1" "$1" 2>/dev/null; fi && printf 'rw %s\n' "$1" >>"$k_kept" || fail "$1 can't be kept from it."
  [ "$2" != ro ] || ro "$1"
}
# (Its remount by its path, which libmount finds in the mount table to keep its locked flags: by
# ".", util-linux before 2.39 finds none, and Linux refuses it. One a link swapped in leads elsewhere
# is found below.)
ro() { [ ! -L "$1" ] && mount -c -o remount,bind,ro "$1" 2>/dev/null && printf 'ro %s\n' "$1" >>"$k_kept" || fail "$1 can't be kept from it."; }
# (One that was there and isn't as it's kept, one a command still running moved away for a moment,
# runs nothing.)
must() { keep "$@" || fail "$1 changed as it started. Run it again, or ask the user."; }
# (Each submodule's work tree's .git file, which its kept settings name: read-only.)
tree_file() {
  local t
  t=$(sed -n 's/^[[:space:]]*worktree[[:space:]]*=[[:space:]]*//p' "$1/config" 2>/dev/null | head -n 1)
  [ -n "$t" ] || return 0
  t=$(cd "$1" 2>/dev/null && cd -P "$t" 2>/dev/null && pwd -P) && [ -f "$t/.git" ] && [ ! -L "$t/.git" ] || return 0
  must "$t/.git" ro
}
# Where a commondir leads, as git reads it: one line, with no NUL or carriage return (which the shell
# and git would read differently), from its folder. (A worktree's own as git writes it, first: one
# compare.)
leads() {
  [ -f "$1/$2" ] || return 0
  if [ "$1" != "$3" ] && cmp -s "$1/$2" "$k_plain"; then (cd "$1/../.." 2>/dev/null && pwd -P); return 0; fi
  [ "$(wc -c <"$1/$2")" -le 4096 ] && [ "$(tr -d '\000\r' <"$1/$2" | wc -c)" -eq "$(wc -c <"$1/$2")" ] && [ "$(wc -l <"$1/$2")" -le 1 ] && (cd "$1" 2>/dev/null && cd -P "$(head -c 4096 "$2")" 2>/dev/null && pwd -P)
}
# (A real folder's path as it is, no link on the way: what's compared with git's.)
as_is() { [ -d "$1" ] && [ ! -L "$1" ] && [ "$(cd -P "$1" 2>/dev/null && pwd -P)" = "$1" ]; }
# (Whether a folder has nothing in it.)
empty() { for k_x in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$k_x" ] || [ -L "$k_x" ] && return 1; done; return 0; }
repo() {
  local r e f k_lacks
  r=$1
  must "$r"
  # (Each a link refuses: one a command could trade for its own, or that leads where commands are
  # kept from. One that still lacks what the launcher gives it, or isn't there as it's kept: every
  # check all the same, then its folder read-only but for what's kept on its own in it, which are
  # checked as ever, so none of those can be made. A main repository's own gitdir git doesn't read.)
  k_lacks=
  for f in config config.worktree commondir hooks; do keep "$r/$f" ro || k_lacks=1; done
  keep "$r/gitdir" ro || :
  for f in modules worktrees; do [ -e "$r/$f" ] || [ -L "$r/$f" ] || k_lacks=1; done
  [ ! -e "$r/commondir" ] || [ "$(leads "$r" commondir "$r")" = "$r" ] || fail "$r/commondir leads git to another repository. Ask the user."
  if { [ -e "$r/worktrees" ] || [ -L "$r/worktrees" ]; } && { keep "$r/worktrees" || { k_lacks=1; false; }; }; then
    # (One gone as it's kept is read-only within worktrees.)
    for e in "$r/worktrees"/* "$r/worktrees"/.[!.]* "$r/worktrees"/..?*; do [ ! -L "$e" ] || keep "$e"; [ ! -d "$e" ] || keep "$e" || :; done
    ro "$r/worktrees"
    # (Another's, many at once: each its own few mounts, side by side.)
    k_failed=$own/failed
    for e in "$r/worktrees"/* "$r/worktrees"/.[!.]* "$r/worktrees"/..?*; do
      [ -d "$e" ] || continue
      case "$k_own
" in *"
$e
"*) continue ;; esac
      ( if [ ! -e "$e/config.worktree" ] || [ ! -e "$e/modules" ] || [ "$(leads "$e" commondir "$r")" != "$r" ]; then ro "$e"
        else for f in commondir gitdir config.worktree modules; do keep "$e/$f" ro || { ro "$e"; break; }; done; fi ) </dev/null || : >"$k_failed" &
    done
    wait
    [ ! -e "$k_failed" ] || exit 126
    for e in "$r/worktrees"/* "$r/worktrees"/.[!.]* "$r/worktrees"/..?*; do
      case "$k_own
" in *"
$e
"*) [ -d "$e" ] || continue ;; *) continue ;; esac
      [ -e "$e/config.worktree" ] && [ -e "$e/modules" ] || fail "$e lacks config.worktree or modules, which it can't keep from being made. Ask the user."
      [ "$(leads "$e" commondir "$r")" = "$r" ] || fail "$e/commondir doesn't lead git back to its repository. Ask the user."
      for f in commondir gitdir config.worktree; do must "$e/$f" ro; done
      mods "$e/modules"
    done
  fi
  mods "$r/modules"
  [ -z "$k_lacks" ] || ro "$r"
}
mods() {
  local m k_found k_done h d k_in p
  m=$1
  [ -e "$m" ] || [ -L "$m" ] || return 0
  if [ ! -L "$m" ] && [ -d "$m" ] && empty "$m"; then must "$m" ro; return 0; fi
  must "$m"
  [ -z "$(find "$m" \( -name objects -o -name refs -o -name logs -o -name lfs -o -name rr-cache -o -name hooks -o -name info \) -prune -o -name '*
*' -print 2>/dev/null | head -c 1)" ] || fail "$m holds a name it can't keep. Ask the user."
  k_found=$(find "$m" \( -name objects -o -name refs -o -name logs -o -name lfs -o -name rr-cache -o -name hooks -o -name info \) -prune -o -name HEAD -type f -print 2>/dev/null | awk -F / '{ print NF "\t" $0 }' | LC_ALL=C sort -n | cut -f 2-)
  k_done=
  while IFS= read -r h; do
    [ -n "$h" ] || continue
    d=$(dirname "$h") k_in=
    while IFS= read -r p; do [ -n "$p" ] && case "$d/" in "$p"/modules/*|"$p"/worktrees/*) k_in=1 ;; esac; done <<EOF_DONE
$k_done
EOF_DONE
    [ -z "$k_in" ] || continue
    repo "$d" </dev/null
    k_done="$k_done
$d"
    tree_file "$d"
  done <<EOF_FOUND
$k_found
EOF_FOUND
  ro "$m"
}
# The .git file that leads a folder to its repository (a worktree's), up from it: kept read-only once
# the repositories are (one of them could cover it otherwise), still leading where it led, and the
# worktree's own folder it names is the conversation's (k_own, one a line); or the .git folder found
# instead (k_dirs).
k_own= k_dirs= k_files= k_plain=$own/commondir k_kept=$own/k/kept
# (What's kept, noted in a folder of its own with room for a repository's thousands; and the mounts
# there were before, so each made since must be one of those.)
mkdir "$own/k" && mount -c -t tmpfs -o size=16m,mode=0700 kuvo-kept "$own/k" 2>/dev/null && : >"$k_kept" && awk '{ print $1 }' /proc/self/mountinfo >"$own/k/before" || fail "it isn't set up."
leads_to() { (cd "$1" 2>/dev/null && cd -P "$(sed -n 's/^gitdir: *//p' .git | head -n 1)" 2>/dev/null && pwd -P); }
printf '../..\n' >"$k_plain" || fail "it isn't set up."
gitfile() {
  local at
  at=$1
  while [ -n "$at" ] && [ "$at" != / ]; do
    if [ -e "$at/.git" ] || [ -L "$at/.git" ]; then
      if [ -f "$at/.git" ] && [ ! -L "$at/.git" ]; then
        k_to=$(leads_to "$at")
        k_files="$k_files$at/.git
$k_to
"
        k_own="$k_own
$k_to"
      elif as_is "$at/.git"; then k_dirs="$k_dirs
$at/.git"
      fi
      return 0
    fi
    at=$(dirname "$at")
  done
}
gitfile "$work"
if [ -n "$allowed" ] && [ -f "$allowed" ]; then
  while IFS= read -r k_at; do
    case $k_at in /*) as_is "$k_at" || continue ;; *) continue ;; esac
    if [ -f "$k_at/.git" ]; then gitfile "$k_at" </dev/null; elif as_is "$k_at/.git"; then k_dirs="$k_dirs
$k_at/.git"; fi
  done <"$allowed"
fi
k_done=
while IFS= read -r k_at; do
  case $k_at in /*) ;; *) continue ;; esac
  case "$k_done
" in *"
$k_at
"*) continue ;; esac
  # (Each was found as it is: one that's changed since, by a command still running, runs nothing.)
  as_is "$k_at" || fail "$k_at changed as it started. Ask the user."
  repo "$k_at" </dev/null
  k_done="$k_done
$k_at"
done <<EOF_REPOS
$(case $git in /*.git) printf '%s\n' "$git" ;; esac)
$k_dirs
EOF_REPOS
while IFS= read -r k_at && IFS= read -r k_to; do
  [ -n "$k_at" ] || continue
  must "$k_at" ro
  [ "$(leads_to "$(dirname "$k_at")")" = "$k_to" ] || fail "$k_at changed as it started. Run it again, or ask the user."
done <<EOF_FILES
$k_files
EOF_FILES
# Each kept as noted, as the mount table has it now: the top mount at its path, of what's there in
# what it's mounted on (its root there is that mount's own and the way to it, on the same device),
# not covered by a folder mounted since above it, and read-only where it should be; and each mount made
# since it started one of those, so a link swapped in can't have led one elsewhere.
[ ! -s "$k_kept" ] || k_bad=$(awk '
function plain(p) { gsub(/\\040/, " ", p); gsub(/\\011/, "\t", p); gsub(/\\012/, "\n", p); gsub(/\\134/, "\\", p); return p }
function bad(p) { print (p == "" ? "a mount" : p); exit 1 }
function from(m, p,   q, way) {
  q = under[m]
  if (!(q in seen) || dev[q] != dev[m]) return 0
  if (p == at[q]) way = ""; else if (at[q] == "/") way = p; else if (substr(p, 1, length(at[q]) + 1) == at[q] "/") way = substr(p, length(at[q]) + 1); else return 0
  return root[m] == (root[q] == "/" ? (way == "" ? "/" : way) : root[q] way)
}
FILENAME == ARGV[1] { old[$1] = 1; next }
FILENAME == ARGV[2] { want[++n] = $0; noted[substr($0, 4)] = 1; next }
{ seen[$1] = 1; at[$1] = plain($5); root[$1] = plain($4); dev[$1] = $3; under[$1] = $2; how[$1] = $6; top[plain($5)] = $1; on[$2, plain($5)] = 1; ids[++k] = $1 }
END {
  if (!k) bad("")
  for (i = 1; i <= k; i++) { m = ids[i]; if (!(m in old) && (!(at[m] in noted) || !from(m, at[m]))) bad(at[m]) }
  for (i = 1; i <= n; i++) {
    p = substr(want[i], 4); m = top[p]
    if (m == "" || !from(m, p) || (substr(want[i], 1, 2) == "ro" && how[m] !~ /(^|,)ro(,|$)/)) bad(p)
    for (a = p; (j = match(a, /\/[^\/]*$/)) > 1; ) { a = substr(a, 1, j - 1); if ((under[m], a) in on) bad(p) }
  }
}' "$own/k/before" "$k_kept" /proc/self/mountinfo) || { [ -n "$k_bad" ] || k_bad="git's own files"; fail "$k_bad changed as it started (git outside the sandbox may have been writing it). Run it again, or ask the user."; }
`;

/**
 * The launcher's part, before a command's namespace keeps them (`KEEP_GIT`), run as you, with no
 * more rights than yours (so never in a folder you made read-only): in each repository it keeps (the
 * conversation's <git>, the `.git` folder up from its folder, Also Allowed's in <allowed>, and their
 * submodules' and worktrees' submodules'), what git would read, or keep its repositories in, that
 * isn't there yet: an empty `hooks`, `modules`, `worktrees` and `config.worktree` (git reads that only
 * once `extensions.worktreeConfig` is on, which `git sparse-checkout` turns on), and a `commondir`
 * that names the repository itself (`./`, as libgit2 reads it too); in each worktree's own folder, an
 * empty `config.worktree` and `modules`. Each in the folder as it is (taken by `cd`, so never through
 * a link put in its place since), a file only where there's none, never through a link, and given up
 * after a few seconds rather than waiting on a FIFO. Where one can't be made, the command is told so
 * once (`$F/unkept`, which goes once all can be), and runs: every check as ever, and the
 * repository's folder read-only to it then (`KEEP_GIT`). `git_made_all <work> <git> <allowed>`.
 */
export const MAKE_GIT = String.raw`git_made() {
  [ ! -e "$1" ] && [ ! -L "$1" ] || return 0
  if [ "$2" = / ]; then mkdir "$1" 2>/dev/null || [ -d "$1" ]; return; fi
  timeout 5 sh -c 'set -C; if [ -n "$0" ]; then printf "%s\n" "$0" >"$1"; else : >"$1"; fi' "$2" "$1" 2>/dev/null || [ -f "$1" ]
}
git_repo() {
  [ -d "$1" ] && [ ! -L "$1" ] || return 0
  k_note=$F/unkept/$(printf '%s' "$1" | cksum | cut -d ' ' -f 1)
  if ( cd -P "$1" 2>/dev/null && [ "$(pwd -P)" = "$1" ] || exit 0
    k_ok=0
    for k_n in hooks modules worktrees; do git_made "$k_n" / || k_ok=1; done
    git_made commondir ./ || k_ok=1
    git_made config.worktree "" || k_ok=1
    for k_e in worktrees/* worktrees/.[!.]* worktrees/..?*; do
      [ -d "$k_e" ] && [ ! -L "$k_e" ] || continue
      git_made "$k_e/config.worktree" "" || k_ok=1
      git_made "$k_e/modules" / || k_ok=1
    done
    exit $k_ok ); then
    rm -f "$k_note"
  elif [ ! -e "$k_note" ]; then
    (umask 077; mkdir -p "$F/unkept" && : >"$k_note") 2>/dev/null
    echo "Note: git can't change its own files in $1 from Kuvo Code's sandbox here (the sandbox couldn't add a hooks folder or commondir there, so commands only read it)." >&2
  fi
}
git_all() {
  git_repo "$1"
  [ -d "$1" ] && [ ! -L "$1" ] || return 0
  find "$1/modules" "$1/worktrees" \( -name objects -o -name refs -o -name logs -o -name lfs -o -name rr-cache -o -name hooks -o -name info \) -prune -o -path '*/modules/*' -name HEAD -type f -print 2>/dev/null | while IFS= read -r k_h; do git_repo "$(dirname "$k_h")"; done
}
# (The .git folder up from a folder, where it's one and not a link.)
git_up() {
  k_at=$1
  while [ -n "$k_at" ] && [ "$k_at" != / ]; do
    if [ -e "$k_at/.git" ] || [ -L "$k_at/.git" ]; then [ ! -d "$k_at/.git" ] || [ -L "$k_at/.git" ] || printf '%s\n' "$k_at/.git"; return 0; fi
    k_at=$(dirname "$k_at")
  done
}
git_made_all() {
  k_seen=
  for k_g in "$2" "$(git_up "$1")"; do
    case $k_g in /*.git) ;; *) continue ;; esac
    [ "$k_g" != "$k_seen" ] || continue
    git_all "$k_g"; k_seen=$k_g
  done
  [ -f "$3" ] || return 0
  while IFS= read -r k_a; do case $k_a in /*) [ "$k_a/.git" != "$2" ] && [ "$(cd -P "$k_a" 2>/dev/null && pwd -P)" = "$k_a" ] && git_all "$k_a/.git" ;; esac; done <"$3"
}`;

/**
 * `sh -c HIDE <unshare> <uid> <gid> <name> <own> <sockets> <t_own> <t_name> <work> <git> <allowed> <program> [args…]`, run by `unshare -Urm`
 * (as its own root, in a mount namespace of its own), with the system's programs only, never ones a
 * command could have put on your PATH: your session's folder (`/run/user/<uid>`), your tmux's,
 * screen's and shell-started SSH agents' in `/tmp` and `/run/screen`, the X server's, Neovim's,
 * Emacs', VS Code's and Cursor's in `/tmp`, and the other apps' sockets the box lists in <sockets> (a
 * folder or a socket a line, or the names sockets can have, with `*` in them, for each there now),
 * each empty or refusing; then the program, as you again, with no rights over the system left, and
 * your PATH. Your groups stay, as they were. A folder that can't be hidden runs nothing.
 *
 * Each in `/tmp` is hidden from inside it (`.`), or checked once hidden, never through a link: one
 * another conversation's command puts in its place isn't followed, nor hides the box's list. Being
 * you again is a namespace inside this one that maps you, made by hand (util-linux's `--map-user` is
 * newer than Ubuntu 22.04's and RHEL 9's): this one, still its root, writes its map once it's there,
 * told through <own>, an empty folder of the box's that it first makes its own (and gives up, within
 * seconds, if it never is).
 *
 * Commands' temporary folders are in `t` in Kuvo Code's folder (<t_own>: fence/state.ts), where
 * Landlock alone would keep a command from listing the others but not from reaching a socket in
 * one by its path. So the command's own (<t_name> in it) is all it has there: kept aside in <own>,
 * the folder emptied, and it put back alone. The same folder in each of its conversation's
 * commands, so a tmux server one starts is there for the next.
 *
 * <work> is the conversation's folder, <git> its repository and <allowed> the file of folders Also
 * Allowed gives it (each `""` for none): in each repository there git's own files are kept as they
 * are (`KEEP_GIT`).
 */
export const HIDE = String.raw`u=$1 g=$2 n=$3 own=$4 sockets=$5 t_own=$6 t_name=$7; shift 7
work=$1 git=$2 allowed=$3; shift 3
p=$PATH; PATH=/usr/sbin:/usr/bin:/sbin:/bin
fail() { echo "This command can't run in the sandbox here: $1" >&2; exit 126; }
over() { ( cd -P "$1" 2>/dev/null || exit 1; [ -z "$3" ] || [ "$(pwd -P)" = "$1" ] || exit 1; [ "$3" != mine ] || [ -O . ] || exit 1; mount -c -t tmpfs -o "size=64k,mode=$2" kuvo-hidden . 2>/dev/null || exit 2 ) || { [ $? = 1 ] || fail "$1 can't be kept from it."; return 1; }; }
off() { [ -S "$1" ] && { [ -z "$2" ] || [ ! -L "$1" ]; } || return 1; mount -c --bind /dev/null "$1" 2>/dev/null && [ -c "$1" ] && { [ -z "$2" ] || [ ! -L "$1" ]; } || fail "$1 can't be kept from it."; }
[ -r "$sockets" ] || fail "it isn't set up."
over "$own" 0700 || fail "it isn't set up."
# (git's own files kept first, while nothing's hidden yet: no mount there can uncover what is.)
${KEEP_GIT}
while IFS= read -r s; do case $s in /*'*'*) for f in $s; do [ ! -S "$f" ] || off "$f"; done ;; /*) over "$s" 0700 || off "$s" ;; esac; done <"$sockets"
over "/run/user/$u" 0700
if [ -n "$t_own" ]; then
  ( cd -P "$t_own/$t_name" 2>/dev/null && [ "$(pwd -P)" = "$t_own/$t_name" ] && [ -O . ] && mkdir "$own/tmp" && mount -c --bind . "$own/tmp" ) 2>/dev/null || fail "its temporary folder isn't its own."
  over "$t_own" 0700 mine && mkdir "$t_own/$t_name" && mount -c --bind "$own/tmp" "$t_own/$t_name" 2>/dev/null || fail "its temporary folder can't be kept to itself."
fi
for d in "/tmp/tmux-$u" /tmp/ssh-* "/run/screen/S-$n" "/tmp/nvim.$n" "/tmp/emacs$u"; do over "$d" 0700 mine; done
over /tmp/.X11-unix 1777 here
for s in /tmp/vscode-ipc-*.sock /tmp/vscode-ssh-auth-*.sock /tmp/vscode-git-*.sock; do [ -O "$s" ] && off "$s" here; done
# (Its folder again, by its name, so what it reaches by a relative path goes through the mounts made
# since it was there, not round them.)
k_here=$(pwd -P 2>/dev/null) && cd "$k_here" 2>/dev/null
[ "$XDG_RUNTIME_DIR" != "/run/user/$u" ] || unset XDG_RUNTIME_DIR
case $DBUS_SESSION_BUS_ADDRESS in *"=/run/user/$u/"*) unset DBUS_SESSION_BUS_ADDRESS ;; esac
mkfifo -m 600 "$own/in" "$own/on" || fail "it isn't set up."
timeout 10 sh -c 'read _ <"$1" && echo "$2 0 1" >/proc/$0/uid_map && echo "$3 0 1" >/proc/$0/gid_map; echo >"$4"' $$ "$own/in" "$u" "$g" "$own/on" </dev/null >/dev/null 2>&1 &
exec "$0" --user -- /bin/sh -c 'echo >"$0"; read _ <"$1"; [ "$(id -u)" = "$2" ] || { echo "This command can'"'"'t run in the sandbox here: it can'"'"'t run as you." >&2; exit 126; }; PATH=$3; shift 3; exec "$@"' "$own/in" "$own/on" "$u" "$p" "$@"`;

/** Where util-linux's `unshare` is. */
export const UNSHARE = ["/usr/bin/unshare", "/bin/unshare"];

/** The `unshare` that gives commands here a namespace of their own, tried as the launcher runs it
 * (each step, its mounts too), with `own` the box's empty folder each command's namespace uses
 * (`run/fence/ns`, which stays empty: what HIDE makes in it is in the namespace's own memory); null
 * where the machine doesn't let it (no `unshare`, user namespaces off, or AppArmor restricting them,
 * as Ubuntu 24.04 and later do). */
export function ownNamespace(own: string): string | null {
  const found = triedNamespace(own);
  return found === UNFINISHED ? null : found;
}

/** A try of a namespace that didn't finish (a busy machine): whether commands can have one isn't
 * known, which is never taken for "they can't" (fence/state.ts). */
export const UNFINISHED = "unfinished";

/** As `ownNamespace`, or `UNFINISHED` where the try didn't finish. */
export function triedNamespace(own: string): string | null | typeof UNFINISHED {
  const unshare = UNSHARE.find(each => fs.existsSync(each));
  if (!unshare) return null;
  const tried = spawnSync(unshare, namespaceTry(unshare, own), { cwd: "/", stdio: "ignore", timeout: TRY_FOR });
  if (didntFinish(tried)) return UNFINISHED;
  return tried.status === 0 ? unshare : null;
}

/** The same, while the box goes on answering (it's tried again each minute): `unshare`, the one to
 * try. `UNFINISHED` where it didn't finish in time (`limit`, a test's own). */
export function ownNamespaceLater(own: string, unshare = UNSHARE.find(each => fs.existsSync(each)), limit = TRY_FOR): Promise<string | null | typeof UNFINISHED> {
  if (!unshare) return Promise.resolve(null);
  return new Promise(resolve => {
    const child = spawn(unshare, namespaceTry(unshare, own), { cwd: "/", stdio: "ignore" });
    let late = false;
    const cut = setTimeout(() => { late = true; child.kill("SIGKILL"); }, limit);
    cut.unref?.();
    child.once("error", error => { clearTimeout(cut); resolve(didntFinish({ status: null, error }) ? UNFINISHED : null); });
    child.once("exit", (status, signal) => { clearTimeout(cut); resolve(late || didntFinish({ status, signal }) ? UNFINISHED : status === 0 ? unshare : null); });
  });
}

/** Whether a folder can be made read-only in a command's namespace here, as `KEEP_GIT` makes git's
 * own files (a bind from within it, then its remount by its path), tried on `at` (the box's own empty folder, on the disk your
 * home is on): where it can't, each command in a repository refuses, and the box says so (`gaps`:
 * `git`). `UNFINISHED` where the try didn't finish. */
export function readOnlyHere(unshare: string, at: string): boolean | typeof UNFINISHED {
  const tried = spawnSync(unshare, ["-Urm", "/bin/sh", "-c", `cd -P "$0" 2>/dev/null && mount -c --bind . . 2>/dev/null && mount -c -o remount,bind,ro "$0" 2>/dev/null`, at], { cwd: "/", stdio: "ignore", timeout: TRY_FOR });
  if (didntFinish(tried)) return UNFINISHED;
  return tried.status === 0;
}

const TRY_FOR = 10_000;
const namespaceTry = (unshare: string, own: string) => ["-Urm", "/bin/sh", "-c", HIDE, unshare, String(process.getuid?.() ?? -1), String(process.getgid?.() ?? -1), "", own, "/dev/null", "", "", "", "", "", "/bin/sh", "-c", "[ \"$(id -u)\" = \"$0\" ]", String(process.getuid?.() ?? -1)];

/**
 * The script: `kuvo-fence.js <policy.json> <WORK> <GIT> <TMP> <WAKES> <ALLOWED> <shell> [args…]`, ALLOWED
 * the file of folders Also Allowed gives its project, one a line (fence/allowed.ts). Fails closed: when
 * the kernel can't, the command doesn't run (the box knows before, and says so).
 */
export const LANDLOCK_RUNNER = String.raw`// Kuvo Code writes this each time its box starts: changes here don't last.
// Runs a command's shell in the sandbox (Landlock), as bin/kuvo-fence asks.
import { dlopen, FFIType, ptr, read } from "bun:ffi";
import fs from "node:fs";
import path from "node:path";

const [policyFile, work, git, tmp, wakes, allowedFile, shell, ...args] = process.argv.slice(2);
const fail = (why) => { process.stderr.write("This command can't run in the sandbox here: " + why + "\n"); process.exit(126); };
let policy;
try { policy = JSON.parse(fs.readFileSync(policyFile, "utf8")); } catch { fail("its settings can't be read."); }
let libc;
try {
  libc = dlopen("libc.so.6", {
    syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i64 },
    prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    open: { args: [FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  }).symbols;
} catch { fail("its C library can't be loaded."); }
const errno = () => read.i32(libc.__errno_location(), 0);
const CREATE = 444, ADD_RULE = 445, RESTRICT = 446;
const abi = Number(libc.syscall(CREATE, 0, 0, 1, 0));
if (abi < 1) fail("Linux's Landlock isn't on.");

const EXEC = 1n, WRITE = 2n, READ = 4n, READ_DIR = 8n;
const all = (1n << (abi < 2 ? 13n : abi < 3 ? 14n : abi < 5 ? 15n : 16n)) - 1n;
const FILE_ONLY = EXEC | WRITE | READ | (abi >= 3 ? 1n << 14n : 0n) | (abi >= 5 ? 1n << 15n : 0n);
const READS = EXEC | READ | READ_DIR;
const attr = new BigUint64Array([all, 0n, abi >= 6 ? 3n : 0n]);
const ruleset = Number(libc.syscall(CREATE, ptr(attr), abi < 4 ? 8 : abi < 6 ? 16 : 24, 0, 0));
if (ruleset < 0) fail("Linux refused to set it up (" + errno() + ").");

const rule = new Uint8Array(12);
const view = new DataView(rule.buffer);
const O_PATH = 0o10000000, O_CLOEXEC = 0o2000000;
function grant(where, access) {
  const fd = libc.open(Buffer.from(where + "\0"), O_PATH | O_CLOEXEC);
  if (fd < 0) return;
  let allowed = access & all;
  try { if (!fs.statSync(where).isDirectory()) allowed &= FILE_ONLY; } catch { libc.close(fd); return; }
  view.setBigUint64(0, allowed, true);
  view.setInt32(8, fd, true);
  const done = Number(libc.syscall(ADD_RULE, ruleset, 1, ptr(rule), 0));
  libc.close(fd);
  if (done < 0) fail("Linux refused a rule for " + where + " (" + errno() + ").");
}
const real = (where) => { try { return fs.realpathSync(where); } catch { return path.resolve(where); } };
const hidden = new Set(policy.hidden.map(real));
// What's written leaves out, besides: what's only read (granted reading with everything else).
const kept = new Set([...hidden, ...(policy.readOnly || []).map(real)]);
const inside = (child, top) => child === top || child.startsWith(top === "/" ? "/" : top + "/");
// Grants access under top, except what's left out: a folder with something left out in it is only
// listed, and each thing in it granted the same way.
function grantExcept(top, access, out = hidden) {
  top = real(top);
  if (out.has(top)) return;
  if (![...out].some(h => inside(h, top))) return grant(top, access);
  grant(top, READ_DIR);
  let names = [];
  try { names = fs.readdirSync(top); } catch { return; }
  for (const name of names) grantExcept(path.join(top, name), access, out);
}
grantExcept("/", READS);
for (const where of policy.readable) grant(where, READS);
// Your home: files added and changed in what's there, never removed or moved (a move removes it
// from where it was), nor linked in from elsewhere; but for what runs later, your personal folders
// (only read: Landlock can't tell a new file from one that's there) and what's kept whole. A new
// folder or file at the top of one that holds any of those can't be made: what Landlock grants is
// each thing that's there.
const HOME = all & ~(16n | 32n | 64n | 2048n | 8192n);
const personal = (policy.personal || []).map(real);
const homeOut = new Set([...kept, ...(policy.homeKept || []).map(real), ...personal]);
for (const where of policy.homeWrites || []) grantExcept(where, HOME, homeOut);
for (const where of policy.homeOpen || []) grantExcept(where, HOME, new Set([...kept, ...personal]));
// What you let its project's commands write (Also Allowed).
let allowed = [];
// (Each by the real path the box keeps: one that's become a link since, to anywhere, isn't given.)
try { allowed = fs.readFileSync(allowedFile, "utf8").split("\n").filter((line) => line.startsWith("/") && real(line) === line); } catch {}
// Each leaves out the walls but one it's inside: a conversation's folder in one (a project in your
// Documents, ~/.config/nvim) writes its own, and one that holds them (your home) doesn't write them.
const walls = [...(policy.readOnly || []), ...(policy.homeKept || []), ...personal].map(real);
const outside = (where) => new Set([...hidden, ...walls.filter((wall) => !inside(real(where), wall))]);
for (const where of [...policy.writable, work, git, ...allowed]) if (where) grantExcept(where, all, outside(where));
// A coding agent run whole in it: its homes (its sign-in and state), whole, and the folders it only
// reads (the skills it's given). What macOS keeps from it in its homes (its settings, its other
// folders) Landlock can't: what it grants a folder it grants all inside, and the agent makes its
// own files at the top (its databases' journals, its sign-in written anew). Here its homes are Kuvo
// Code's own copy of it (a machine's agents' homes are in Kuvo Code's folder), never the one you
// use yourself. (What a command leaves there while it is on, Codex reads when the sandbox is off
// too: you turn it off, and that's yours to judge.) Its sign-in in its first home is its own, though
// one of your secrets anywhere else (your own Codex's, for an account you added), as on a Mac. Its tools' port needs no rule:
// Landlock leaves connections to it open.
const lines = (text) => (text || "").split("\n").filter((line) => line.startsWith("/"));
const secrets = new Set((policy.secrets || []).map(real));
lines(process.env.KUVO_FENCE_OWN).slice(0, 4).forEach((where, at) => grantExcept(where, all, at ? kept : new Set([...kept].filter((each) => !(secrets.has(each) && inside(each, real(where)))))));
for (const where of lines(process.env.KUVO_FENCE_READ).slice(0, 4)) grant(where, READS);
if (tmp) { fs.mkdirSync(tmp, { recursive: true }); grant(tmp, all); }
// Its conversation's wake-ups and watches (kuvo-wake): read, and only its inbox written, which the box
// takes in, out of its reach.
if (wakes && fs.existsSync(wakes)) {
  grant(wakes, READS);
  grant(path.join(wakes, "inbox"), all);
  // Its agent's own memory, in the bot's folder: only there does it write in that folder.
  if (fs.existsSync(path.join(wakes, "memory"))) grant(path.join(wakes, "memory"), all);
}
// Its bot's memory, which the launcher names: that file alone, read and written in place (a file's
// rule can't make, move or remove it).
const memory = process.env.KUVO_FENCE_MEMORY;
if (memory && memory.startsWith("/")) { try { const it = fs.lstatSync(memory); if (it.isFile() && it.nlink === 1) grant(memory, READ | WRITE | (abi >= 3 ? 1n << 14n : 0n)); } catch {} }

const keep = [];
const text = (s) => { const b = Buffer.from(s + "\0"); keep.push(b); return b; };
const list = (items) => { const b = new BigUint64Array(items.length + 1); items.forEach((s, i) => { b[i] = BigInt(ptr(text(s))); }); keep.push(b); return b; };
// (Bun's own, which run this, only for a program that's the engine's runtime run as Bun.)
const env = Object.entries(process.env).filter(([k]) => process.env.KUVO_FENCE_BUN === "1" ? k !== "KUVO_FENCE_BUN" : k !== "BUN_BE_BUN" && k !== "BUN_RUNTIME_TRANSPILER_CACHE_PATH" && k !== "KUVO_FENCE_BUN").filter(([k]) => k !== "KUVO_FENCE_OWN" && k !== "KUVO_FENCE_READ" && k !== "KUVO_FENCE_MEMORY").map(([k, v]) => k + "=" + v);
if (libc.prctl(38, 1n, 0n, 0n, 0n) !== 0) fail("Linux refused to keep it (" + errno() + ").");
if (Number(libc.syscall(RESTRICT, ruleset, 0, 0, 0)) < 0) fail("Linux refused to start it (" + errno() + ").");
libc.close(ruleset);
libc.execve(ptr(text(shell)), ptr(list([shell, ...args])), ptr(list(env)));
process.stderr.write(shell + ": can't run (" + errno() + ")\n");
process.exit(127);
`;

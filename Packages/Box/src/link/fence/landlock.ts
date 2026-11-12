// The sandbox's policy in Linux's own terms: Landlock, set up by a small script the engine's own Bun
// runs (`bin/kuvo-fence.js`, through `bun:ffi`) before it becomes the command's shell, so nothing
// new ships for each architecture. Landlock only grants: reads everywhere but what's hidden, by
// granting each neighbour on the way down to it; in your home, files added and changed but never
// removed or moved, but for what runs later and your personal folders (only read); everything in
// the conversation's folder, its repository, the temporary folders, devices and tools' caches; signals and abstract sockets only
// inside the sandbox (from Linux's Landlock 6). What it can't refuse inside a folder it writes (git's
// hooks, the engine's and the coding agents' settings there), it doesn't: Landlock grants a folder
// whole.
//
// Nor can Landlock refuse a socket, and your session's services listen on them: systemd's in
// `/run/user/<uid>` runs whatever it's asked outside the sandbox (`systemd-run --user`), beside your
// bus, keyring and agents; tmux's server types into your sessions; an X server takes keystrokes. So
// each command first gets a namespace of its own (`unshare`, util-linux's, which the machine has: a
// process with threads, like Bun, can't make one itself) where those folders are empty, and then its
// Landlock rules (`HIDE`).

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
 * `sh -c HIDE <unshare> <uid> <gid> <name> <own> <sockets> <t_own> <t_name> <program> [args…]`, run by `unshare -Urm`
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
 */
export const HIDE = String.raw`u=$1 g=$2 n=$3 own=$4 sockets=$5 t_own=$6 t_name=$7; shift 7
p=$PATH; PATH=/usr/sbin:/usr/bin:/sbin:/bin
fail() { echo "This command can't run in the sandbox here: $1" >&2; exit 126; }
over() { ( cd -P "$1" 2>/dev/null || exit 1; [ -z "$3" ] || [ "$(pwd -P)" = "$1" ] || exit 1; [ "$3" != mine ] || [ -O . ] || exit 1; mount -c -t tmpfs -o "size=64k,mode=$2" kuvo-hidden . 2>/dev/null || exit 2 ) || { [ $? = 1 ] || fail "$1 can't be kept from it."; return 1; }; }
off() { [ -S "$1" ] && { [ -z "$2" ] || [ ! -L "$1" ]; } || return 1; mount -c --bind /dev/null "$1" 2>/dev/null && [ -c "$1" ] && { [ -z "$2" ] || [ ! -L "$1" ]; } || fail "$1 can't be kept from it."; }
[ -r "$sockets" ] || fail "it isn't set up."
over "$own" 0700 || fail "it isn't set up."
while IFS= read -r s; do case $s in /*'*'*) for f in $s; do [ ! -S "$f" ] || off "$f"; done ;; /*) over "$s" 0700 || off "$s" ;; esac; done <"$sockets"
over "/run/user/$u" 0700
if [ -n "$t_own" ]; then
  ( cd -P "$t_own/$t_name" 2>/dev/null && [ "$(pwd -P)" = "$t_own/$t_name" ] && [ -O . ] && mkdir "$own/tmp" && mount -c --bind . "$own/tmp" ) 2>/dev/null || fail "its temporary folder isn't its own."
  over "$t_own" 0700 mine && mkdir "$t_own/$t_name" && mount -c --bind "$own/tmp" "$t_own/$t_name" 2>/dev/null || fail "its temporary folder can't be kept to itself."
fi
for d in "/tmp/tmux-$u" /tmp/ssh-* "/run/screen/S-$n" "/tmp/nvim.$n" "/tmp/emacs$u"; do over "$d" 0700 mine; done
over /tmp/.X11-unix 1777 here
for s in /tmp/vscode-ipc-*.sock /tmp/vscode-ssh-auth-*.sock /tmp/vscode-git-*.sock; do [ -O "$s" ] && off "$s" here; done
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

const TRY_FOR = 10_000;
const namespaceTry = (unshare: string, own: string) => ["-Urm", "/bin/sh", "-c", HIDE, unshare, String(process.getuid?.() ?? -1), String(process.getgid?.() ?? -1), "", own, "/dev/null", "", "", "/bin/sh", "-c", "[ \"$(id -u)\" = \"$0\" ]", String(process.getuid?.() ?? -1)];

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

// The sandbox's policy in Linux's own terms: Landlock, set up by a small script the engine's own Bun
// runs (`bin/kuvo-fence.js`, through `bun:ffi`) before it becomes the command's shell, so nothing
// new ships for each architecture. Landlock only grants: reads everywhere but what's hidden, by
// granting each neighbour on the way down to it; writes in the conversation's folder, its
// repository, the temporary folders, devices and tools' caches; signals and abstract sockets only
// inside the sandbox (from Linux's Landlock 6). What it can't refuse inside a folder it writes (git's
// hooks, the engine's and the coding agents' settings there), it doesn't: Landlock grants a folder
// whole.

import type { FencePolicy } from "./policy";

/** What the Linux script reads: the policy's parts it needs. */
export function landlockPolicy(policy: FencePolicy): string {
  return JSON.stringify({ hidden: [...policy.kuvo, ...policy.secrets], readable: policy.kuvoReadable, writable: policy.writable, readOnly: policy.readOnly }) + "\n";
}

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
// What you let its project's commands write (Also Allowed).
let allowed = [];
try { allowed = fs.readFileSync(allowedFile, "utf8").split("\n").filter((line) => line.startsWith("/")); } catch {}
for (const where of [...policy.writable, work, git, ...allowed]) if (where) grantExcept(where, all, kept);
if (tmp) { fs.mkdirSync(tmp, { recursive: true }); grant(tmp, all); }
// Its conversation's wake-ups and watches (kuvo-wake): read, and only its inbox written, which the box
// takes in, out of its reach.
if (wakes && fs.existsSync(wakes)) {
  grant(wakes, READS);
  grant(path.join(wakes, "inbox"), all);
}

const keep = [];
const text = (s) => { const b = Buffer.from(s + "\0"); keep.push(b); return b; };
const list = (items) => { const b = new BigUint64Array(items.length + 1); items.forEach((s, i) => { b[i] = BigInt(ptr(text(s))); }); keep.push(b); return b; };
const env = Object.entries(process.env).filter(([k]) => k !== "BUN_BE_BUN" && k !== "BUN_RUNTIME_TRANSPILER_CACHE_PATH").map(([k, v]) => k + "=" + v);
if (libc.prctl(38, 1n, 0n, 0n, 0n) !== 0) fail("Linux refused to keep it (" + errno() + ").");
if (Number(libc.syscall(RESTRICT, ruleset, 0, 0, 0)) < 0) fail("Linux refused to start it (" + errno() + ").");
libc.close(ruleset);
libc.execve(ptr(text(shell)), ptr(list([shell, ...args])), ptr(list(env)));
process.stderr.write(shell + ": can't run (" + errno() + ")\n");
process.exit(127);
`;

// What keeps a test run away from the real Kuvo Code: loaded before anything else in every bridge
// test (its first import; test-safety.test.js holds each file to that) and in the box's tests
// (Packages/Box/test/preload.ts).
//
// A shell an agent runs in carries Kuvo Code's own variables, KUVO_WAKES and KUVO_BOTS among them,
// which name the real folders, and the box reads them as it loads. A test that believed them wrote
// in those folders, and one deleted them. So, as this loads:
//
// - What Kuvo Code's shells hand down is dropped: a test sets what it wants, for its own folders.
//   That's its variables, the coding agents' folders (the real sign-ins) and their sockets and
//   tokens (the user's SSH agent, Claude Code's variables, a tmux's), and its own commands on the
//   PATH, as `kuvo-wake` writes in the real folders whatever a test sets. What you set on purpose to
//   run tests stays (KUVO_TEST_*, OPENCODE_TEST_*, KUVO_CURSOR_SDK).
// - The run gets a home of its own in ~/.kuvo-code-test, removed as it ends (one a killed run left
//   goes as the next one starts), so whatever falls back on `~` lands there. (The real home stays named in KUVO_TEST_REAL_HOME, for what's really wanted
//   there: ~/.kuvo-code-test, and reading a program.) A temporary folder that's Kuvo Code's is
//   swapped for the system's; any other stays as it is, as the length of a socket's path in it counts.
// - Nothing is deleted or moved away unless it's in a folder this process made with mkdtemp, or a
//   path the test named as its own with `ownPath`. Anything else throws, naming the path.
import childProcess, { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const realHome = process.env.KUVO_TEST_REAL_HOME || process.env.HOME || os.homedir();

// The account's own home folder as the system has it, whatever HOME says (Bun's `os.userInfo()`
// follows HOME, so it's asked of the system's own: `id -P` on macOS, `getent` and then the password
// file on Linux).
export const accountHome = (() => {
  try {
    let line;
    if (process.platform === "darwin") line = spawnSync("/usr/bin/id", ["-P"], { encoding: "utf8", timeout: 5000 }).stdout;
    else {
      const uid = String(process.getuid?.());
      line = spawnSync("/usr/bin/getent", ["passwd", uid], { encoding: "utf8", timeout: 5000 }).stdout;
      if (!line?.trim()) line = fs.readFileSync("/etc/passwd", "utf8").split("\n").find(each => each.split(":")[2] === uid);
    }
    const home = line?.trim().split(":")[process.platform === "darwin" ? 8 : 5];
    if (home && path.isAbsolute(home)) return home;
  } catch {}
  // (Under Bun that's HOME again, which is no help: said, so a run knows what it can't refuse.)
  if (process.versions.bun) console.error("test-safety.js: couldn't find this account's home folder; ownPath refuses only what HOME names.");
  try { return os.userInfo().homedir; } catch { return undefined; }
})();
const givenTemporary = os.tmpdir();

for (const name of Object.keys(process.env)) {
  if (/^(KUVO_|OPENCODE_|XDG_)|^(CLAUDE_CONFIG_DIR|CODEX_HOME|GEMINI_HOME|CURSOR_DATA_DIR|CURSOR_SANDBOX_POLICY_DIR|CUA_APP_SUPPORT_DIR|GROK_HOME|SSH_AUTH_SOCK|CLAUDECODE|TMUX|TMUX_PANE)$|^CLAUDE_CODE_/.test(name) && !/^(KUVO_TEST_|OPENCODE_TEST_)|^KUVO_CURSOR_SDK$/.test(name)) delete process.env[name];
}
const kuvoCodes = /\/(run\.kuvo\.code[^/]*|\.kuvo-code)\//;
if (process.env.PATH) process.env.PATH = process.env.PATH.split(path.delimiter).filter(folder => !kuvoCodes.test(`${folder}/`)).join(path.delimiter);

// An agent's shell has a temporary folder of Kuvo Code's: long enough that a socket's path in a test
// goes over the limit, and a box treats it as its own. Any other (as scripts/test-linux.sh chooses,
// to keep a machine tidy) stays as it is.
if (kuvoCodes.test(`${givenTemporary}/`)) {
  const system = process.platform === "darwin" ? spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).stdout?.trim() : "/tmp";
  // (A sandboxed shell may be able to write only in the folder it was given.)
  if (system) {
    try {
      fs.rmdirSync(fs.mkdtempSync(path.join(system, "ku-")));
      process.env.TMPDIR = system;
    } catch {}
  }
}

// The run's home, in the folder tests keep in your home, as a home isn't in a temporary folder: what
// a box judges by where it is (a command in your home, or in a scratch folder) comes out as it would.
const testsRoot = path.join(realHome, ".kuvo-code-test");
const original = { rmSync: fs.rmSync, rmdirSync: fs.rmdirSync };

function inTestsRoot(make) {
  // (Another run's last file may be removing that folder, empty by then, between these two.)
  for (let tries = 0; ; tries++) {
    fs.mkdirSync(testsRoot, { recursive: true });
    try {
      return make();
    } catch (error) {
      if (error.code !== "ENOENT" || tries === 5) throw error;
    }
  }
}

/**
 * A new folder in ~/.kuvo-code-test, named `prefix` and this process's number, for a test that needs
 * it there rather than in the run's own home. By that number the next run can tell when it's been
 * left. (Only that, to stay short: a socket's path in it has a limit.)
 */
export function testsFolder(prefix) {
  const folder = path.join(testsRoot, `${prefix}-${process.pid}`);
  // (One already there is what a run long gone left: this process has its number now.)
  original.rmSync(folder, { recursive: true, force: true });
  inTestsRoot(() => fs.mkdirSync(folder, { mode: 0o700 }));
  own.add(resolved(folder));
  return folder;
}

// What a run killed before it could clean up left, its process gone. (Only these names: others keep
// folders here too, and what's after a machine's test run's prefix isn't a process's number.)
function clearLeftovers() {
  for (const name of fs.readdirSync(testsRoot)) {
    const pid = /^(ku|sb|sa|kv|outside)-(\d+)(-|$)/.exec(name)?.[2];
    if (!pid) continue;
    try {
      process.kill(Number(pid), 0);
    } catch (error) {
      if (error.code === "ESRCH") fs.rmSync(path.join(testsRoot, name), { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

function ownHome() {
  try {
    const home = inTestsRoot(() => fs.mkdtempSync(path.join(testsRoot, `ku-${process.pid}-`)));
    clearLeftovers();
    return home;
  } catch {
    return fs.mkdtempSync(path.join(os.tmpdir(), "ku-"));
  }
}

// What's the tests' own (each without links, as a path being asked about is compared with).
const own = new Set();
const ownRoot = fs.realpathSync(ownHome());
own.add(ownRoot);
process.env.KUVO_TEST_REAL_HOME = realHome;
process.env.HOME = ownRoot;

// `given` as the system would reach it: links on the way there followed, the last part not (it's the
// link that's deleted, not what it points at), and whatever doesn't exist yet as it's named.
function resolved(given) {
  const full = path.resolve(given instanceof URL ? fileURLToPath(given) : String(given));
  let folder = path.dirname(full), rest = path.basename(full);
  for (;;) {
    try {
      return path.join(fs.realpathSync(folder), rest);
    } catch {
      rest = path.join(path.basename(folder), rest);
      folder = path.dirname(folder);
    }
  }
}

function refuseOutside(given, verb) {
  const where = resolved(given);
  for (const folder of own) if (isIn(where, folder)) return;
  const message = `Refusing to ${verb} ${where}: it isn't in this test's own folders (test-safety.js). A test only touches what it made.`;
  // (Also said here: code under test may catch what's thrown, and carry on.)
  console.error(message);
  throw new Error(message);
}

const isIn = (where, folder) => where === folder || where.startsWith(folder.endsWith(path.sep) ? folder : folder + path.sep);

// What the system makes of these however they're spelled: the identity of what exists at `given` and
// at each folder above it (a path in another case, or through /System/Volumes/Data, is the same one).
function identities(given) {
  const ids = new Set();
  for (let at = path.resolve(given); ; at = path.dirname(at)) {
    try {
      const stat = fs.statSync(at);
      ids.add(`${stat.dev}:${stat.ino}`);
    } catch {}
    if (at === path.dirname(at)) return ids;
  }
}
const identity = given => { try { const stat = fs.statSync(given); return `${stat.dev}:${stat.ino}`; } catch {} };
const fold = text => (process.platform === "darwin" ? text.toLowerCase() : text);
const kuvoPlaces = new RegExp(kuvoCodes.source, "i");

/**
 * `given`, which a test makes under a name of its own somewhere a temporary folder won't do (a real
 * cache, as a sandbox test needs): it may delete it too. Never the real Kuvo Code's or the coding
 * agents' and your sign-ins, wherever and however they're spelled, or a folder they're in (your
 * home, its Library).
 */
export function ownPath(given) {
  const where = resolved(given);
  const homes = [...new Set([realHome, accountHome].filter(Boolean).map(home => resolved(home)))];
  const real = homes.flatMap(home =>
    [".kuvo-code", ".ssh", ".gnupg", ".claude", ".codex", ".grok", ".cursor", path.join("Library", "Keychains"),
      ...["Application Support", "Caches", "WebKit", "HTTPStorages", "Preferences"].map(folder => path.join("Library", folder, "run.kuvo.code")), path.join("Library", "Logs", "Kuvo Code")]
      .map(folder => path.join(home, folder)));
  const here = identities(where), self = identity(where);
  const refused = kuvoPlaces.test(`${where}/`)
    || real.some(folder => {
      const [a, b] = [fold(where), fold(folder)];
      if (isIn(a, b) || a.startsWith(`${b}.`) || isIn(b, a)) return true;
      const mine = identity(folder);
      return (mine && here.has(mine)) || (self && identities(folder).has(self));
    });
  if (refused) throw new Error(`${where} can't be a test's own (test-safety.js).`);
  own.add(where);
  return given;
}

const guarded = (holder, name, verb) => {
  const real = holder[name];
  if (real) holder[name] = function (given, ...rest) { refuseOutside(given, verb); return real.call(this, given, ...rest); };
};
// (A move replaces what's at where it goes, too.)
const guardedMove = (holder, name) => {
  const real = holder[name];
  if (real) holder[name] = function (from, to, ...rest) { refuseOutside(from, "move"); refuseOutside(to, "replace"); return real.call(this, from, to, ...rest); };
};
for (const name of ["rmSync", "rm", "rmdirSync", "rmdir", "unlinkSync", "unlink"]) guarded(fs, name, "delete");
for (const name of ["renameSync", "rename"]) guardedMove(fs, name);
for (const holder of new Set([fs.promises, fsPromises])) {
  for (const name of ["rm", "rmdir", "unlink"]) guarded(holder, name, "delete");
  guardedMove(holder, "rename");
}

// ── The coding agents' own folders in your real home ─────────────────────────────────────────────
// Their sign-ins, settings and conversations (`AGENT_FOLDERS`, as the box's sandbox names them). A
// test that read one copied a real sign-in, and one that started an agent's real program with your
// home signed it in as you. So nothing in them is read, written, copied or opened, no program of
// theirs is started (one there, or one an agent's name finds outside a test's own folders), and nothing
// starts with your real home as its HOME: each throws (as a missing file does, for code that carries
// on) and fails the run, however it's caught. Only what a path is, its links and whether it's there,
// is asked, as the sandbox's rules need. A live test you asked for (compact-live.test.js) says so with
// `allowRealAgents`, for its own process alone.
export const AGENT_FOLDERS = [".grok", ".codex", ".claude", ".claude.json", ".cursor", ".gemini", ".opencode",
  path.join(".config", "opencode"), path.join(".local", "share", "opencode"), path.join(".local", "state", "opencode"),
  path.join(".local", "share", "claude"), path.join(".local", "share", "cursor-agent")];
/** The coding agents' programs, by the names they're found by on the PATH. */
const AGENT_PROGRAMS = new Set(["grok", "claude", "codex", "cursor-agent", "agent", "gemini", "antigravity"]);
const realHomes = [...new Set([realHome, accountHome].filter(Boolean).flatMap(home => [path.resolve(home), resolved(home)]))];
const agentFolders = [...new Set(realHomes.flatMap(home => AGENT_FOLDERS.map(folder => fold(path.join(home, folder)))))];
let realAgentsAllowed = false;
const reached = [];
// (Nor are their own folders of programs on the PATH: `~/.grok/bin`.)
if (process.env.PATH) process.env.PATH = process.env.PATH.split(path.delimiter).filter(folder => !agentFolders.some(each => isIn(fold(path.resolve(folder)), each))).join(path.delimiter);

/** For a live test you asked for (it's skipped otherwise): the real agents, as you're signed in to them. */
export function allowRealAgents() {
  realAgentsAllowed = true;
}

/** What this run reached of your real agents (refused, each), for the run to fail on. */
export function reachedRealAgents() {
  return [...reached];
}

function refuseAgents(message) {
  reached.push(message);
  console.error(message);
  throw Object.assign(new Error(message), { code: "ENOENT" });
}

/** The real agents' folder `given` is in (as the system reaches it), if any. */
function agentFolderOf(given) {
  if (realAgentsAllowed || !(typeof given === "string" || given instanceof URL || Buffer.isBuffer(given))) return undefined;
  const plain = String(given instanceof URL ? fileURLToPath(given) : given);
  if (!plain || plain.includes("\0")) return undefined;
  for (const where of new Set([fold(path.resolve(plain)), fold(resolved(plain))])) {
    const folder = agentFolders.find(each => isIn(where, each));
    if (folder) return folder;
  }
  return undefined;
}

function refuseAgentPath(given, verb) {
  const folder = agentFolderOf(given);
  if (folder) refuseAgents(`Refusing to ${verb} ${String(given)}: it's in ${folder}, a coding agent's own in your real home (test-safety.js). A test uses folders of its own.`);
}

// (Refused as that call says a file is missing: a promise's rejected, a callback's told.)
const guardedRead = (holder, name, verb, places = 1) => {
  const real = holder[name];
  const promised = holder !== fs;
  const calledBack = !promised && !/Sync$|^create/.test(name);
  if (real) holder[name] = function (...given) {
    try {
      for (const each of given.slice(0, places)) refuseAgentPath(each, verb);
    } catch (error) {
      if (promised) return Promise.reject(error);
      const done = given.at(-1);
      if (calledBack && typeof done === "function") return void process.nextTick(done, error);
      throw error;
    }
    return real.apply(this, given);
  };
};
for (const holder of new Set([fs, fs.promises, fsPromises])) {
  for (const name of ["readFileSync", "readFile", "openSync", "open", "createReadStream"]) guardedRead(holder, name, "read");
  for (const name of ["writeFileSync", "writeFile", "appendFileSync", "appendFile", "createWriteStream", "mkdirSync", "mkdir", "truncateSync", "truncate", "chmodSync", "chmod", "utimesSync", "utimes"]) guardedRead(holder, name, "write");
  for (const name of ["copyFileSync", "copyFile", "cpSync", "cp", "symlinkSync", "symlink", "linkSync", "link", "renameSync", "rename"]) guardedRead(holder, name, "copy", 2);
  for (const name of ["rmSync", "rm", "rmdirSync", "rmdir", "unlinkSync", "unlink"]) guardedRead(holder, name, "delete");
}

/** Where `program` is found, as `PATH` (the child's) has it: undefined when it isn't. */
function programAt(program, env) {
  const name = String(program);
  if (name.includes("/")) return path.resolve(name);
  for (const folder of String(env?.PATH ?? process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(folder, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return undefined;
}

/** Refuses starting `program` with `env` where that would reach your real agents. */
function refuseStart(program, env) {
  if (realAgentsAllowed || program == null) return;
  const at = programAt(program, env);
  if (at) {
    const real = (() => { try { return fs.realpathSync(at); } catch { return at; } })();
    const folder = agentFolderOf(at) ?? agentFolderOf(real);
    if (folder) refuseAgents(`Refusing to start ${at}: it's a coding agent's real program, in ${folder} (test-safety.js). A test uses a stand-in of its own on the PATH.`);
    const ownCopy = [...own].some(each => isIn(resolved(at), each));
    if (AGENT_PROGRAMS.has(path.basename(at)) && !ownCopy) refuseAgents(`Refusing to start ${at}: it's a coding agent's real program (test-safety.js). A test uses a stand-in of its own on the PATH.`);
  }
  // (The bridge or a box, run by Bun or node, reads the agents' sign-ins in the home it's given.)
  const home = (env ?? process.env).HOME;
  const runtime = /^(bun|node)(-[a-z]+)?$/.test(path.basename(String(at ?? program))) || String(at ?? program) === process.execPath;
  if (runtime && home && realHomes.some(each => fold(path.resolve(String(home))) === fold(each) || fold(resolved(String(home))) === fold(each)))
    refuseAgents(`Refusing to start ${String(program)} with your real home as its HOME (test-safety.js): a test's own reaches its agents' sign-ins.`);
}

// Node's ways of starting a program: (file, args?, options?), each with its environment.
const optionsOf = rest => rest.find(each => each && typeof each === "object" && !Array.isArray(each));
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "fork"]) {
  const real = childProcess[name];
  if (real) childProcess[name] = function (file, ...rest) {
    refuseStart(name === "fork" ? process.execPath : file, optionsOf(rest)?.env);
    return real.call(this, file, ...rest);
  };
}
for (const name of ["exec", "execSync"]) {
  const real = childProcess[name];
  if (real) childProcess[name] = function (command, ...rest) {
    refuseStart(String(command).trim().split(/\s+/)[0], optionsOf(rest)?.env);
    return real.call(this, command, ...rest);
  };
}

const makes = fs.mkdtempSync;
fs.mkdtempSync = function (...given) {
  const made = makes.apply(this, given);
  own.add(resolved(made));
  return made;
};
const makesLater = fs.mkdtemp;
fs.mkdtemp = function (prefix, ...rest) {
  const done = rest.pop();
  return makesLater.call(this, prefix, ...rest, (error, made) => {
    if (!error) own.add(resolved(made));
    done(error, made);
  });
};
for (const holder of new Set([fs.promises, fsPromises])) {
  const real = holder.mkdtemp;
  holder.mkdtemp = async function (...given) {
    const made = await real.apply(this, given);
    own.add(resolved(made));
    return made;
  };
}
// (So `import { rmSync } from "node:fs"` gets these too. Bun's own named imports ignore this, so its
// test runner, as a box's tests and a machine's run on it, is told to give them out instead.)
syncBuiltinESMExports();
if (process.versions.bun) {
  // (`require`, at once: a test file's other imports load while this one waits on anything.)
  const { mock } = require("bun:test");
  const named = holder => Object.fromEntries(Object.keys(holder).filter(name => name !== "default").map(name => [name, holder[name]]));
  for (const name of ["fs", "node:fs"]) mock.module(name, () => ({ ...named(fs), default: fs }));
  for (const name of ["fs/promises", "node:fs/promises"]) mock.module(name, () => ({ ...named(fsPromises), default: fsPromises }));
  // And Bun's `os.homedir()` keeps the home it started with, however HOME changes: the real one.
  os.homedir = () => process.env.HOME || realHome;
  for (const name of ["os", "node:os"]) mock.module(name, () => ({ ...named(os), default: os }));
  // And what Bun itself starts gets the environment this process started with, whatever's changed
  // since (the names dropped above, your real home), unless it's told otherwise.
  // (Held to what node's ways of starting a program are, above.)
  for (const name of ["spawn", "spawnSync"]) {
    const start = Bun[name];
    Bun[name] = (first, options) => {
      const [command, env] = typeof first === "string" || Array.isArray(first) ? [[first].flat(), options?.env ?? process.env] : [first.cmd, first.env ?? process.env];
      refuseStart(command?.[0], env);
      return typeof first === "string" || Array.isArray(first)
        ? start.call(Bun, first, { ...options, env })
        : start.call(Bun, { ...first, env });
    };
  }
  for (const name of ["child_process", "node:child_process"]) mock.module(name, () => ({ ...named(childProcess), default: childProcess }));
  Bun.$.env(process.env);
}

// The run's folder goes as it ends, and the folder they're in with the last of them. Exit runs this
// first; at-end.js, where a file uses it, says so again once it's stopped what it started and removed
// its folders. It's also on a stop at-end.js isn't there for. (Bun's runner ends without telling
// exit's listeners: test/preload.ts says so instead, or the next run clears this one's.)
const removeOwn = () => {
  try { original.rmSync(ownRoot, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  try { if (path.dirname(ownRoot) === fs.realpathSync(testsRoot)) original.rmdirSync(testsRoot); } catch {}
};
process.on("exit", removeOwn);
// A run that reached your real agents fails, whatever its tests made of the refusal.
process.on("exit", () => {
  if (!reached.length) return;
  console.error(`test-safety.js: this run reached your real coding agents ${reached.length} time(s); it fails. The first: ${reached[0]}`);
  process.exitCode = 1;
});
process.on("kuvo-test-folders-removed", removeOwn);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    if (process.listenerCount(signal)) return;
    removeOwn();
    process.kill(process.pid, signal);
  });
}

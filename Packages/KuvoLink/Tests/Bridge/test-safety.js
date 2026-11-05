// What keeps a test run away from the real Kuvo Code: loaded before anything else in every bridge
// test (its first import; test-safety.test.js holds each file to that) and in the box's tests
// (Packages/Box/test/preload.ts).
//
// A shell an agent runs in carries Kuvo Code's own variables, KUVO_WAKES and KUVO_BOTS among them,
// which name the real folders, and the box reads them as it loads. A test that believed them wrote
// in those folders, and one deleted them. So, as this loads:
//
// - What Kuvo Code's shells hand down is dropped: a test sets what it wants, for its own folders.
//   What you set on purpose to run tests stays (KUVO_TEST_*, OPENCODE_TEST_*, KUVO_CURSOR_SDK).
// - The run gets a home of its own in ~/.kuvo-code-test, removed as it ends, so whatever falls back
//   on `~` lands there. (The real home stays named in KUVO_TEST_REAL_HOME, for what's really wanted
//   there: ~/.kuvo-code-test, and reading a program.) A temporary folder that's Kuvo Code's is
//   swapped for the system's; any other stays as it is, as the length of a socket's path in it counts.
// - Nothing is deleted or moved away unless it's in a folder this process made with mkdtemp, or a
//   path the test named as its own with `ownPath`. Anything else throws, naming the path.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const realHome = process.env.KUVO_TEST_REAL_HOME || process.env.HOME || os.homedir();
const givenTemporary = os.tmpdir();

for (const name of Object.keys(process.env)) {
  if (/^(KUVO_|OPENCODE_|XDG_)/.test(name) && !/^(KUVO_TEST_|OPENCODE_TEST_)|^KUVO_CURSOR_SDK$/.test(name)) delete process.env[name];
}

// An agent's shell has a temporary folder of Kuvo Code's: long enough that a socket's path in a test
// goes over the limit, and a box treats it as its own. Any other (as scripts/test-linux.sh chooses,
// to keep a machine tidy) stays as it is.
if (/\/(run\.kuvo\.code[^/]*|\.kuvo-code)\//.test(`${givenTemporary}/`)) {
  const system = process.platform === "darwin" ? spawnSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).stdout?.trim() : "/tmp";
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
function ownHome() {
  try {
    fs.mkdirSync(path.join(realHome, ".kuvo-code-test"), { recursive: true });
    return fs.mkdtempSync(path.join(realHome, ".kuvo-code-test", "ku-"));
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
  for (const folder of own) if (where === folder || where.startsWith(folder + path.sep)) return;
  const message = `Refusing to ${verb} ${where}: it isn't in this test's own folders (test-safety.js). A test only touches what it made.`;
  // (Also said here: code under test may catch what's thrown, and carry on.)
  console.error(message);
  throw new Error(message);
}

/**
 * `given`, which a test makes under a name of its own somewhere a temporary folder won't do (a real
 * cache, as a sandbox test needs): it may delete it too. Never the real Kuvo Code's, or a folder
 * your home is in.
 */
export function ownPath(given) {
  const where = resolved(given);
  const home = resolved(realHome);
  const real = [path.join(home, ".kuvo-code"), path.join(home, "Library", "Application Support", "run.kuvo.code")];
  const inReal = real.some(folder => where === folder || where.startsWith(folder + path.sep) || where.startsWith(`${folder}.`));
  if (inReal || home === where || home.startsWith(where + path.sep)) throw new Error(`${where} can't be a test's own (test-safety.js).`);
  own.add(where);
  return given;
}

const original = { rmSync: fs.rmSync };
const guarded = (holder, name, verb) => {
  const real = holder[name];
  if (real) holder[name] = function (given, ...rest) { refuseOutside(given, verb); return real.call(this, given, ...rest); };
};
for (const name of ["rmSync", "rm", "rmdirSync", "rmdir", "unlinkSync", "unlink"]) guarded(fs, name, "delete");
for (const name of ["renameSync", "rename"]) guarded(fs, name, "move");
for (const holder of new Set([fs.promises, fsPromises])) {
  for (const name of ["rm", "rmdir", "unlink"]) guarded(holder, name, "delete");
  guarded(holder, "rename", "move");
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
  const { mock } = await import("bun:test");
  const named = holder => Object.fromEntries(Object.keys(holder).filter(name => name !== "default").map(name => [name, holder[name]]));
  for (const name of ["fs", "node:fs"]) mock.module(name, () => ({ ...named(fs), default: fs }));
  for (const name of ["fs/promises", "node:fs/promises"]) mock.module(name, () => ({ ...named(fsPromises), default: fsPromises }));
  // And Bun's `os.homedir()` keeps the home it started with, however HOME changes: the real one.
  os.homedir = () => process.env.HOME || realHome;
  for (const name of ["os", "node:os"]) mock.module(name, () => ({ ...named(os), default: os }));
}

// The run's folder goes as it ends: once at-end.js is done with what it stopped, where a file uses
// it, and on a stop no at-end.js is there to handle.
const removeOwn = () => {
  try { original.rmSync(ownRoot, { recursive: true, force: true, maxRetries: 3 }); } catch {}
};
process.on("exit", removeOwn);
process.on("kuvo-test-folders-removed", removeOwn);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    if (process.listenerCount(signal)) return;
    removeOwn();
    process.kill(process.pid, signal);
  });
}

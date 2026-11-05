import { ownPath } from "./test-safety.js";
// What keeps a test run away from the real Kuvo Code's folders (test-safety.js). A shell an agent
// runs in names them in KUVO_WAKES and KUVO_BOTS, and a run of the bridge tests there once deleted
// them, so these hand a run decoys named the same way, and look at the decoys afterwards.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd } from "./at-end.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// A folder outside this file's own, with something in it. (`mktemp`, in another process: one made
// here with mkdtemp would count as this file's own.)
function decoy() {
  const folder = execFileSync("mktemp", ["-d", path.join(os.tmpdir(), "kuvo-decoy.XXXXXX")], { encoding: "utf8" }).trim();
  atEnd(() => void execFileSync("rm", ["-rf", folder]));
  for (const name of ["wakes", "bots", "home"]) {
    fs.mkdirSync(path.join(folder, name));
    fs.writeFileSync(path.join(folder, name, "keep"), "mine");
  }
  return folder;
}
const untouched = folder => {
  for (const name of ["wakes", "bots", "home"]) assert.deepEqual(fs.readdirSync(path.join(folder, name)), ["keep"], `${name}, in a decoy of the real folders`);
};

const scenarioName = JSON.parse(fs.readFileSync(path.join(here, "../../Vectors/routes/wakes.json"), "utf8")).scenarios.find(each => each.only !== "mac").name;

// (These two start a process of their own, with Node's way of running a test or a script: not on Bun's runner.)
test("a run of the route scenarios leaves the folders its shell names alone, and passes on its own", { skip: !!process.versions.bun }, () => {
  const folder = decoy();
  // (A run of its own: this one's runner tells its files apart by this, and a file it finds set only reports to it.)
  const { NODE_TEST_CONTEXT: _, ...given } = process.env;
  for (const file of ["contract.test.js", "contract-mac.test.js"]) {
    const run = spawnSync(process.execPath, ["--test", `--test-name-pattern=${scenarioName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, path.join(here, file)], {
      encoding: "utf8",
      env: { ...given, KUVO_WAKES: path.join(folder, "wakes"), KUVO_BOTS: path.join(folder, "bots"), KUVO_HOME: path.join(folder, "home"), KUVO_WAKE_COMMAND: path.join(folder, "kuvo-wake"), KUVO_FENCE: path.join(folder, "fence") },
    });
    untouched(folder);
    assert.equal(run.status, 0, `${file}: ${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /[#ℹ] pass 1\b/, `${file} ran its scenario: ${run.stdout}`);
  }
});

test("a test's process has dropped what Kuvo Code's shells hand down, and has a home of its own", { skip: !!process.versions.bun }, () => {
  const folder = decoy();
  const script = `import "${path.join(here, "test-safety.js")}"; import os from "node:os"; console.log(JSON.stringify({ env: process.env, tmp: os.tmpdir() }));`;
  const named = { KUVO_WAKES: path.join(folder, "wakes"), KUVO_BOTS: path.join(folder, "bots"), KUVO_HOME: path.join(folder, "home"), KUVO_BIN: folder, XDG_DATA_HOME: folder, OPENCODE_CONFIG: folder, CLAUDE_CONFIG_DIR: folder, CODEX_HOME: folder, GEMINI_HOME: folder, CURSOR_DATA_DIR: folder, GROK_HOME: folder, KUVO_TEST_BUN: "/kept/bun", OPENCODE_TEST_BINARY: "/kept/engine", HOME: folder, PATH: `${path.join(folder, "run.kuvo.code", "bin")}:${path.join(folder, ".kuvo-code", "bin")}:/kept/bin` };
  const { env } = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, ...named } }));
  for (const name of ["KUVO_WAKES", "KUVO_BOTS", "KUVO_HOME", "KUVO_BIN", "XDG_DATA_HOME", "OPENCODE_CONFIG", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GEMINI_HOME", "CURSOR_DATA_DIR", "GROK_HOME"]) assert.equal(env[name], undefined, name);
  assert.equal(env.PATH, "/kept/bin", "Kuvo Code's own commands, like kuvo-wake, write in the real folders whatever a test sets");
  assert.equal(env.KUVO_TEST_BUN, "/kept/bun", "what you set to run tests stays");
  assert.equal(env.OPENCODE_TEST_BINARY, "/kept/engine");
  assert.ok(!env.HOME.startsWith(folder), env.HOME);
  assert.equal(env.KUVO_TEST_REAL_HOME, process.env.KUVO_TEST_REAL_HOME, "the real one stays named, for what's really wanted there");
  assert.equal(fs.existsSync(env.HOME), false, "and it's gone once the process ends");
});

test("a run killed part way leaves its folder, which the next run clears, and leaves everything else", { skip: !!process.versions.bun }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
  const tests = path.join(home, ".kuvo-code-test");
  const run = (then = "") => spawnSync(process.execPath, ["--input-type=module", "-e", `import "${path.join(here, "test-safety.js")}"; console.log(process.env.HOME); ${then}`], { encoding: "utf8", env: { ...process.env, KUVO_TEST_REAL_HOME: home } });
  const killed = run(`process.kill(process.pid, "SIGKILL");`);
  assert.equal(killed.signal, "SIGKILL", killed.stderr);
  const left = killed.stdout.trim();
  assert.equal(fs.existsSync(left), true, "nothing can clean up after this kill");
  // A machine's test run keeps its folder here, and its name's numbers aren't a process's; this
  // process's own is in use.
  const others = [`linux-20261105-235414-${process.pid}`, `ku-${process.pid}-inuse`];
  for (const name of others) fs.mkdirSync(path.join(tests, name));
  // A sandbox test's folder, left the same way.
  const leftBySandbox = path.join(tests, `sb-${killed.pid}`);
  fs.mkdirSync(leftBySandbox);

  const next = run();
  assert.equal(next.status, 0, next.stderr);
  assert.equal(fs.existsSync(left), false, "the killed run's folder");
  assert.equal(fs.existsSync(leftBySandbox), false, "a sandbox test's");
  assert.equal(fs.existsSync(next.stdout.trim()), false, "and the next run's own, as it ended");
  assert.deepEqual(fs.readdirSync(tests).sort(), others.sort());

  for (const name of others) fs.rmdirSync(path.join(tests, name));
  run();
  assert.equal(fs.existsSync(tests), false, "with nothing else in it, the folder they're in goes too");
});

test("deleting or moving anything outside the test's own folders throws, and leaves it", async () => {
  const folder = decoy();
  const wakes = path.join(folder, "wakes");
  const attempts = {
    "fs.rmSync": () => fs.rmSync(wakes, { recursive: true, force: true }),
    "a named rmSync": () => rmSync(wakes, { recursive: true, force: true }),
    "fs.promises.rm": () => fs.promises.rm(wakes, { recursive: true, force: true }),
    "fs.unlinkSync": () => fs.unlinkSync(path.join(wakes, "keep")),
    "fs.rmdirSync": () => fs.rmdirSync(wakes),
    "fs.renameSync": () => fs.renameSync(wakes, path.join(folder, "gone")),
    "moving over it": () => fs.renameSync(fs.mkdtempSync(path.join(os.tmpdir(), "own-")), path.join(wakes, "keep")),
  };
  for (const [how, attempt] of Object.entries(attempts)) {
    await assert.rejects(async () => attempt(), /Refusing to (delete|move|replace) .*test-safety/, how);
    untouched(folder);
  }
  // Nor through a link in its own folder, though the link itself is its own to delete.
  const own = fs.mkdtempSync(path.join(os.tmpdir(), "own-"));
  const link = path.join(own, "link");
  fs.symlinkSync(wakes, link);
  assert.throws(() => fs.rmSync(path.join(link, "keep")), /Refusing to delete/);
  untouched(folder);
  fs.rmSync(link);
  untouched(folder);
});

test("what a test made it may delete, wherever it made it", () => {
  const inTemporary = fs.mkdtempSync(path.join(os.tmpdir(), "own-"));
  fs.mkdirSync(path.join(inTemporary, "sub"));
  fs.rmSync(inTemporary, { recursive: true });
  assert.equal(fs.existsSync(inTemporary), false);
  const folder = decoy();
  const made = fs.mkdtempSync(path.join(folder, "made-"));
  fs.rmSync(made, { recursive: true });
  assert.equal(fs.existsSync(made), false);
  untouched(folder);
  // Or named as its own, somewhere a temporary folder wouldn't do.
  const named = ownPath(path.join(folder, "named"));
  fs.mkdirSync(named);
  fs.rmSync(named, { recursive: true });
  assert.equal(fs.existsSync(named), false);
  untouched(folder);
});

test("the real Kuvo Code's folders, and a folder your home is in, can't be named as a test's own", () => {
  const home = process.env.KUVO_TEST_REAL_HOME;
  for (const given of [path.join(home, ".kuvo-code"), path.join(home, ".kuvo-code", "bots"),
    path.join(home, "Library", "Application Support", "run.kuvo.code", "wakes"), path.join(home, "Library", "Application Support", "run.kuvo.code.demo"),
    path.join(home, "Library", "Caches", "run.kuvo.code"), path.join(home, "Library", "Logs", "Kuvo Code"), path.join(home, "Library", "Preferences", "run.kuvo.code.plist"),
    home, path.dirname(home), "/", path.join(home, "Library"), path.join(home, "Library", "Application Support")]) {
    assert.throws(() => ownPath(given), /can't be a test's own/, given);
  }
});

test("every bridge test file loads test-safety.js before anything else", () => {
  const missing = fs.readdirSync(here).filter(name => name.endsWith(".test.js")).filter(name => {
    const first = fs.readFileSync(path.join(here, name), "utf8").split("\n").find(line => line.trim() && !line.startsWith("//"));
    return !/^import (\{ [\w, ]+ \} from )?"\.\/test-safety\.js";$/.test(first);
  });
  assert.deepEqual(missing, [], "put `import \"./test-safety.js\";` first in these");
});

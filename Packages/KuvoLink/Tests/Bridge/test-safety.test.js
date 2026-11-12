import { accountHome, ownPath } from "./test-safety.js";
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
  const named = { KUVO_WAKES: path.join(folder, "wakes"), KUVO_BOTS: path.join(folder, "bots"), KUVO_HOME: path.join(folder, "home"), KUVO_BIN: folder, XDG_DATA_HOME: folder, OPENCODE_CONFIG: folder, CLAUDE_CONFIG_DIR: folder, CODEX_HOME: folder, GEMINI_HOME: folder, CURSOR_DATA_DIR: folder, CURSOR_SANDBOX_POLICY_DIR: folder, CUA_APP_SUPPORT_DIR: folder, GROK_HOME: folder, SSH_AUTH_SOCK: path.join(folder, "agent.sock"), CLAUDE_CODE_MESSAGING_SOCKET: path.join(folder, "msg.sock"), CLAUDE_CODE_MESSAGING_TOKEN: "secret", CLAUDE_CODE_OAUTH_TOKEN: "secret", CLAUDECODE: "1", TMUX: `${folder},1,0`, TMUX_PANE: "%0", TMPDIR: path.join(folder, "run.kuvo.code", "T"), KUVO_TEST_BUN: "/kept/bun", OPENCODE_TEST_BINARY: "/kept/engine", HOME: folder, PATH: `${path.join(folder, "run.kuvo.code", "bin")}:${path.join(folder, ".kuvo-code", "bin")}:/kept/bin` };
  fs.mkdirSync(named.TMPDIR, { recursive: true });
  const { env, tmp } = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, ...named } }));
  for (const name of ["KUVO_WAKES", "KUVO_BOTS", "KUVO_HOME", "KUVO_BIN", "XDG_DATA_HOME", "OPENCODE_CONFIG", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GEMINI_HOME", "CURSOR_DATA_DIR", "CURSOR_SANDBOX_POLICY_DIR", "CUA_APP_SUPPORT_DIR", "GROK_HOME", "SSH_AUTH_SOCK", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDECODE", "TMUX", "TMUX_PANE"]) assert.equal(env[name], undefined, name);
  assert.equal(env.PATH, "/kept/bin", "Kuvo Code's own commands, like kuvo-wake, write in the real folders whatever a test sets");
  assert.equal(env.KUVO_TEST_BUN, "/kept/bun", "what you set to run tests stays");
  assert.equal(env.OPENCODE_TEST_BINARY, "/kept/engine");
  assert.ok(!env.HOME.startsWith(folder), env.HOME);
  assert.ok(!/\/run\.kuvo\.code[^/]*\//.test(`${tmp}/`) && !tmp.startsWith(folder), `a temporary folder of Kuvo Code's is swapped for the system's: ${tmp}`);
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

// (Its own process, with HOME and the real home both changed: what the guard refuses mustn't depend on them.)
test("the account's own home folders can't be a test's own either, whatever HOME says or the spelling", { skip: !!process.versions.bun }, () => {
  const account = os.userInfo().homedir;
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
  const script = `import { ownPath } from "${path.join(here, "test-safety.js")}"; import path from "node:path";
    const results = {};
    for (const [name, given] of Object.entries(JSON.parse(process.argv[1]))) {
      try { ownPath(given); results[name] = "allowed"; } catch (error) { results[name] = "refused"; }
    }
    console.log(JSON.stringify(results));`;
  const mac = process.platform === "darwin";
  const given = {
    kuvo: path.join(account, ".kuvo-code", "x"),
    support: path.join(account, "Library", "Application Support", "run.kuvo.code", "wakes"),
    signIns: path.join(account, ".ssh", "id_ed25519"),
    inTemporary: path.join(os.tmpdir(), "run.kuvo.code", "box"),
    inHome: path.join(account, "Documents", "notes"),
    // (The same folders as macOS has them in another case or through the data volume.)
    ...(mac ? { otherCase: path.join(account.replace(/\/Users\/(.)/, (_, first) => `/users/${first.toUpperCase()}`), ".SSH", "id_ed25519"), wholeHome: account.toLowerCase(), dataVolume: path.join("/System/Volumes/Data", account, ".ssh", "id_ed25519") } : {}),
  };
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(given)], { encoding: "utf8", env: { ...process.env, HOME: elsewhere, KUVO_TEST_REAL_HOME: elsewhere } });
  assert.equal(run.status, 0, run.stderr);
  fs.rmSync(elsewhere, { recursive: true });
  const expected = Object.fromEntries(Object.keys(given).map(name => [name, name === "inHome" ? "allowed" : "refused"]));
  assert.deepEqual(JSON.parse(run.stdout), expected);
  assert.equal(accountHome, account, "found from the system, not from HOME");
});

// A test once copied a real Grok sign-in. Nothing in the coding agents' own folders in the real home
// is read, written or copied, through a link too, no program of theirs is started, nor the bridge with
// that home; only what a path is is asked. Each refusal fails the run, however it was caught, unless a
// live test you asked for allows them. (A decoy of the real home here, made in another process.)
test("a test can't read, copy or write the coding agents' sign-ins in the real home, or start their real programs, and a run that tried fails", () => {
  const real = execFileSync("mktemp", ["-d", path.join(os.tmpdir(), "kuvo-real-home.XXXXXX")], { encoding: "utf8" }).trim();
  atEnd(() => void execFileSync("rm", ["-rf", real]));
  const write = (name, text, mode = 0o600) => {
    fs.mkdirSync(path.dirname(path.join(real, name)), { recursive: true });
    fs.writeFileSync(path.join(real, name), text, { mode });
  };
  write(".grok/auth.json", '{"decoy":{"key":"not-a-real-token"}}');
  write(".codex/auth.json", "{}");
  write(".local/share/opencode/auth.json", "{}");
  write(".grok/bin/grok", "#!/bin/sh\necho ran\n", 0o755);
  write("bin/codex", "#!/bin/sh\necho ran\n", 0o755);
  write("bin/kuvo-tool", "#!/bin/sh\necho ran\n", 0o755);
  const script = `import { allowRealAgents } from "${path.join(here, "test-safety.js")}";
    import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawnSync } from "node:child_process";
    const real = process.argv[1], seen = {};
    const tried = (name, act) => { try { act(); seen[name] = "allowed"; } catch (error) { seen[name] = "refused"; } };
    const mine = fs.mkdtempSync(path.join(os.tmpdir(), "mine-"));
    tried("read Grok's sign-in", () => fs.readFileSync(path.join(real, ".grok", "auth.json")));
    seen["read it later"] = await fs.promises.readFile(path.join(real, ".grok", "auth.json")).then(() => "allowed", () => "refused");
    tried("copy Codex's", () => fs.copyFileSync(path.join(real, ".codex", "auth.json"), path.join(mine, "copy")));
    tried("write Claude Code's settings", () => fs.writeFileSync(path.join(real, ".claude", "settings.json"), "{}"));
    tried("read opencode's", () => fs.readFileSync(path.join(real, ".local", "share", "opencode", "auth.json")));
    tried("copy the home they're in", () => fs.cpSync(real, path.join(mine, "all"), { recursive: true }));
    tried("read it as a blob", () => fs.openAsBlob(path.join(real, ".grok", "auth.json")));
    tried("link to it", () => fs.symlinkSync(path.join(real, ".grok"), path.join(mine, "linked")));
    spawnSync("/bin/ln", ["-s", path.join(real, ".grok"), path.join(mine, "linked")]);
    tried("read it through a link", () => fs.readFileSync(path.join(mine, "linked", "auth.json")));
    tried("ask whether it's there", () => fs.statSync(path.join(real, ".grok", "auth.json")));
    seen["its programs' folder on the PATH"] = process.env.PATH.split(":").includes(path.join(real, ".grok", "bin")) ? "kept" : "dropped";
    seen["what it starts finds them on the PATH"] = spawnSync("/bin/sh", ["-c", "command -v grok codex || echo none"], { encoding: "utf8" }).stdout.trim();
    seen["what it starts finds the rest there"] = spawnSync("/bin/sh", ["-c", "command -v kuvo-tool"], { encoding: "utf8" }).stdout.trim().endsWith("/kuvo-tool") ? "yes" : "no";
    tried("start Grok's program", () => spawnSync(path.join(real, ".grok", "bin", "grok")));
    tried("start Codex, found on a PATH of its own", () => spawnSync("codex", { env: { PATH: path.join(real, "bin") } }));
    fs.writeFileSync(path.join(mine, "grok"), "#!/bin/sh\\necho stand-in\\n", { mode: 0o755 });
    tried("start a stand-in of its own", () => { if (spawnSync("grok", { env: { PATH: mine }, encoding: "utf8" }).stdout !== "stand-in\\n") throw new Error("not run"); });
    tried("start the bridge with the real home", () => spawnSync(process.execPath, ["-e", "0"], { env: { ...process.env, HOME: real } }));
    tried("start a shell with it", () => spawnSync("/bin/sh", ["-c", "true"], { env: { ...process.env, HOME: real } }));
    tried("start the engine as Bun with it", () => spawnSync("/bin/sh", ["-c", "true"], { env: { ...process.env, HOME: real, BUN_BE_BUN: "1" } }));
    allowRealAgents();
    tried("read it in a live test you asked for", () => fs.readFileSync(path.join(real, ".grok", "auth.json")));
    fs.rmSync(mine, { recursive: true });
    console.log(JSON.stringify(seen));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script, real], { encoding: "utf8", env: { ...process.env, HOME: real, KUVO_TEST_REAL_HOME: real, PATH: `${path.join(real, ".grok", "bin")}:${path.join(real, "bin")}:${process.env.PATH}` } });
  assert.deepEqual(JSON.parse(run.stdout || "{}"), {
    "read Grok's sign-in": "refused",
    "read it later": "refused",
    "copy Codex's": "refused",
    "write Claude Code's settings": "refused",
    "read opencode's": "refused",
    "copy the home they're in": "refused",
    "read it as a blob": "refused",
    "link to it": "refused",
    "read it through a link": "refused",
    "ask whether it's there": "allowed",
    "its programs' folder on the PATH": "dropped",
    "what it starts finds them on the PATH": "none",
    "what it starts finds the rest there": "yes",
    "start Grok's program": "refused",
    "start Codex, found on a PATH of its own": "refused",
    "start a stand-in of its own": "allowed",
    "start the bridge with the real home": "refused",
    "start a shell with it": "allowed",
    "start the engine as Bun with it": "refused",
    "read it in a live test you asked for": "allowed",
  }, run.stderr);
  assert.equal(run.status, 1, "a run that reached them fails");
  assert.match(run.stderr, /this run reached your real coding agents 13 time\(s\)/);
  // Nothing of them was written or copied.
  assert.deepEqual(fs.readdirSync(real).sort(), [".codex", ".grok", ".kuvo-code-test", ".local", "bin"].filter(name => fs.existsSync(path.join(real, name))));
  assert.equal(fs.existsSync(path.join(real, ".claude")), false);
});

test("every bridge test file, in any folder under this one, loads test-safety.js before anything else", () => {
  const found = fs.readdirSync(here, { recursive: true }).filter(name => !name.split(path.sep).includes("node_modules") && /([._-]test|[._]spec)\.[cm]?[jt]sx?$|(^|\/)test\.[cm]?[jt]s$/.test(name));
  assert.ok(found.length > 10, "the test files were found");
  const missing = found.filter(name => {
    const first = fs.readFileSync(path.join(here, name), "utf8").split("\n").find(line => line.trim() && !line.startsWith("//"));
    const safety = path.relative(path.dirname(path.join(here, name)), path.join(here, "test-safety.js"));
    const imported = first?.match(/^import (?:\{ [\w, ]+ \} from )?"(.+)";$/)?.[1];
    return imported !== (safety.startsWith(".") ? safety : `./${safety}`);
  });
  assert.deepEqual(missing, [], "put `import \"./test-safety.js\";` first in these");
});

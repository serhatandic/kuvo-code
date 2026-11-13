// This Mac's box's helper, Kuvo Code Box (#333 piece 4; PROTOCOL.md, "This Mac's box: its helper"):
// the launch agent that starts it at login (`kuvo-link.js helper install [--load]`, `helper status`),
// and a Mac's box in a home of its own saying where its server answers (`run/serve.json`), as its
// helper starts it. The real box script, in homes of the test's own, with a stand-in for `launchctl`
// and a stand-in helper: never this computer's launchd, which a test's home leaves alone without them.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/own-box-helper.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";

const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const write = (file, text, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode) fs.chmodSync(file, mode);
};
const read = file => fs.readFileSync(file, "utf8");
const exists = file => fs.existsSync(file);

/** A home of the test's own, its box of `kind`, with stand-ins for the helper and `launchctl`. */
function home(kind, { helper = true } = {}) {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-own-box-helper-")));
  removeAtEnd(folder);
  const K = path.join(folder, ".kuvo-code");
  if (kind) write(path.join(K, "box", "kind"), `${kind}\n`);
  fs.mkdirSync(path.join(K, "run"), { recursive: true });
  if (helper) write(path.join(K, "bin", "Kuvo Code Box.app", "Contents", "MacOS", "Kuvo Code Box"), "#!/bin/sh\nexit 0\n", 0o755);
  const tools = path.join(folder, "tools");
  // launchctl: notes what it's asked; `print` says it's loaded once it was bootstrapped.
  write(path.join(tools, "launchctl"), `#!/bin/sh\necho "$*" >>"${folder}/launchctl"\ncase "$1" in print) [ -f "${folder}/loaded" ] ;; bootstrap) touch "${folder}/loaded" ;; bootout) rm -f "${folder}/loaded" ;; esac\n`, 0o755);
  return { home: folder, K, run: path.join(K, "run"), tools };
}
const envOf = (where, more = {}) => ({ ...process.env, HOME: where.home, KUVO_HOME: where.K, TMPDIR: where.home, KUVO_TEST_UNINSTALL_TOOLS: where.tools, ...more });
const helper = (where, args, more) => {
  const done = spawnSync(process.execPath, [script, "helper", ...args], { env: envOf(where, more), encoding: "utf8" });
  return { status: done.status, said: done.stdout.trim() ? JSON.parse(done.stdout.trim()) : null, stderr: done.stderr };
};
const plistOf = where => path.join(where.home, "Library", "LaunchAgents", "run.kuvo.code.machine.plist");

test("helper install: the launch agent starts Kuvo Code Box at login, with this box's folder, under Kuvo Code in Login Items", { skip: process.platform !== "darwin" && "only a Mac's box has the helper" }, () => {
  const where = home("mac");
  const done = helper(where, ["install", "--app", "run.kuvo.code.trial4"]);
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(done.said, { written: true, loaded: false, message: "Kuvo Code Box starts this Mac's box at login." });
  const plist = read(plistOf(where));
  const program = path.join(where.K, "bin", "Kuvo Code Box.app", "Contents", "MacOS", "Kuvo Code Box");
  assert.match(plist, /<key>Label<\/key><string>run\.kuvo\.code\.machine<\/string>/);
  assert.ok(plist.includes(`<array><string>${program}</string><string>keep</string><string>--home</string><string>${where.K}</string></array>`), plist);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.match(plist, /<key>AbandonProcessGroup<\/key><true\/>/);
  assert.match(plist, /<key>AssociatedBundleIdentifiers<\/key><array><string>run\.kuvo\.code\.trial4<\/string><\/array>/);
  // A real property list, as launchd reads it.
  assert.equal(spawnSync("plutil", ["-lint", plistOf(where)]).status, 0);
  assert.equal(exists(path.join(where.home, "launchctl")), false, "written, not loaded");
  assert.deepEqual(helper(where, ["status"]).said, { helper: true, agent: true, loaded: false });

  // Loaded now: whatever had the label goes first.
  fs.rmSync(path.join(where.home, "launchctl"));
  const loaded = helper(where, ["install", "--load"]);
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal(loaded.said.loaded, true);
  const uid = process.getuid();
  assert.deepEqual(read(path.join(where.home, "launchctl")).trim().split("\n"), [
    `bootout gui/${uid}/run.kuvo.code.machine`,
    // (Gone before it's started again.)
    `print gui/${uid}/run.kuvo.code.machine`,
    `bootstrap gui/${uid} ${plistOf(where)}`,
  ]);
  assert.match(read(plistOf(where)), /<string>run\.kuvo\.code<\/string>/, "the app's ID by default");
  assert.deepEqual(helper(where, ["status"]).said, { helper: true, agent: true, loaded: true });
});

test("helper install --load waits for launchd to let go of the one before, and starts it again once it has", { skip: process.platform !== "darwin" && "only a Mac's box has the helper" }, () => {
  const where = home("mac");
  // launchd still stopping the helper before (two looks), and refusing the first start meanwhile.
  write(path.join(where.tools, "launchctl"), `#!/bin/sh
echo "$*" >>"${where.home}/launchctl"
n=$(cat "${where.home}/looks" 2>/dev/null || echo 0)
case "$1" in
print) echo $((n + 1)) >"${where.home}/looks"; [ "$n" -lt 2 ] ;;
bootstrap) if [ -f "${where.home}/refused" ]; then exit 0; fi; touch "${where.home}/refused"; echo "5: Input/output error" >&2; exit 5 ;;
esac
`, 0o755);
  const done = helper(where, ["install", "--load"]);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.said.loaded, true);
  const asked = read(path.join(where.home, "launchctl")).trim().split("\n").map(line => line.split(" ")[0]);
  assert.deepEqual(asked, ["bootout", "print", "print", "print", "bootstrap", "bootstrap"]);
});

test("helper install: a path with characters XML reserves is written as launchd reads it", { skip: process.platform !== "darwin" && "only a Mac's box has the helper" }, () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-own-box-helper-&<\"-")));
  removeAtEnd(folder);
  const where = { home: folder, K: path.join(folder, ".kuvo-code"), run: path.join(folder, ".kuvo-code", "run"), tools: path.join(folder, "tools") };
  write(path.join(where.K, "box", "kind"), "mac\n");
  write(path.join(where.K, "bin", "Kuvo Code Box.app", "Contents", "MacOS", "Kuvo Code Box"), "#!/bin/sh\n", 0o755);
  write(path.join(where.tools, "launchctl"), "#!/bin/sh\n", 0o755);
  assert.equal(helper(where, ["install"]).status, 0);
  const listed = spawnSync("plutil", ["-extract", "ProgramArguments.3", "raw", plistOf(where)], { encoding: "utf8" });
  assert.equal(listed.stdout.trim(), where.K);
});

test("helper start: the whole start through the helper, its launch agent put in place, loaded and started as each needs, one running left as it is", { skip: process.platform !== "darwin" && "only a Mac's box has the helper" }, () => {
  const where = home("mac");
  const uid = process.getuid();
  const asked = () => { const said = exists(path.join(where.home, "launchctl")) ? read(path.join(where.home, "launchctl")).trim().split("\n") : []; fs.rmSync(path.join(where.home, "launchctl"), { force: true }); return said; };
  // Not in place: written and loaded.
  const first = helper(where, ["start", "--app", "run.kuvo.code.trial5"]);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(first.said, { started: true, mac: true, message: "Kuvo Code Box runs this Mac's box now, and at login." });
  assert.match(read(plistOf(where)), /<string>run\.kuvo\.code\.trial5<\/string>/);
  assert.equal(asked().filter(line => line.startsWith("bootstrap")).length, 1);
  // Loaded: started if it isn't running (kickstart leaves one running as it is).
  assert.deepEqual(helper(where, ["start"]).said, { started: true, mac: true, message: "Kuvo Code Box runs this Mac's box." });
  assert.deepEqual(asked(), [`print gui/${uid}/run.kuvo.code.machine`, `kickstart gui/${uid}/run.kuvo.code.machine`]);
  // In place but not loaded: loaded, then started.
  fs.rmSync(path.join(where.home, "loaded"));
  assert.equal(helper(where, ["start"]).said.started, true);
  assert.deepEqual(asked().map(line => line.split(" ")[0]), ["print", "bootstrap", "kickstart"]);
  // --if-missing: one in place is left as it is (switched off in Login Items, it stays off).
  fs.rmSync(path.join(where.home, "loaded"));
  const left = helper(where, ["start", "--if-missing"]);
  assert.equal(left.status, 0);
  assert.equal(left.said.left, true);
  assert.deepEqual(asked().filter(line => !line.startsWith("print")), []);
  // Switched off in Login Items: launchd won't load it, and it says so plainly.
  fs.rmSync(path.join(where.home, "loaded"), { force: true });
  write(path.join(where.tools, "launchctl"), `#!/bin/sh\necho "$*" >>"${where.home}/launchctl"\ncase "$1" in print) exit 113 ;; bootstrap) echo "Bootstrap failed: 5: Input/output error" >&2; exit 5 ;; print-disabled) printf '\\t"run.kuvo.code.machine" => disabled\\n' ;; esac\n`, 0o755);
  const off = helper(where, ["start"]);
  assert.equal(off.status, 1);
  assert.deepEqual(off.said, { started: false, mac: true, disabled: true, message: "Kuvo Code Box is turned off in System Settings › General › Login Items. Turn it on, then try again." });
  // A Mac's box with no helper in its bin: says why, which the app shows.
  const bare = home("mac", { helper: false });
  const refused = helper(bare, ["start"]);
  assert.equal(refused.status, 1);
  assert.equal(refused.said.mac, true);
  assert.match(refused.said.message, /isn't in this box's bin/);
  // Not a Mac's own box: nothing asked, and it says so.
  const machine = home("machine");
  const other = helper(machine, ["start"]);
  assert.equal(other.status, 1);
  assert.equal(other.said.mac, false, "not a Mac's own box: its own start, not the helper's");
  assert.equal(exists(path.join(machine.home, "launchctl")), false);
});

test("helper install refuses what isn't a Mac's own box in a home of its own, and writes nothing", () => {
  // A machine's box (its launch agent is the machines' own, /bin/sh).
  const machine = home("machine");
  const refused = helper(machine, ["install"]);
  assert.equal(refused.status, 1);
  assert.equal(refused.said.written, false);
  assert.match(refused.said.message, process.platform === "darwin" ? /Only a Mac's own box in a home of its own/ : /Only a Mac's own box/);
  assert.equal(exists(plistOf(machine)), false);
  if (process.platform !== "darwin") return;
  // No helper in its bin yet.
  const bare = home("mac", { helper: false });
  assert.match(helper(bare, ["install"]).said.message, /isn't in this box's bin/);
  assert.equal(exists(plistOf(bare)), false);
  // A test's home without stand-ins: this computer's launchd and LaunchAgents are left alone.
  const alone = home("mac");
  assert.match(helper(alone, ["install"], { KUVO_TEST_UNINSTALL_TOOLS: "" }).said.message, /Only the box in ~\/\.kuvo-code/);
  assert.equal(exists(plistOf(alone)), false);
});

test("helper says what it doesn't know", () => {
  const where = home("mac");
  for (const args of [[], ["remove"], ["install", "--now"], ["install", "--app"], ["install", "--app", "not an id"], ["status", "--load"], ["start", "--load"]]) {
    const done = helper(where, args);
    assert.equal(done.status, 2, args.join(" "));
    assert.match(done.stderr, /Usage: kuvo-link\.js helper install/);
  }
});

test("a Mac's box in a home of its own says where its server answers, as its helper starts it, and takes it away as it goes", async () => {
  const where = home("mac", { helper: false });
  const password = "p".repeat(48);
  const child = spawn(process.execPath, [script, "serve"], { env: envOf(where, { KUVO_TEST_NO_PEERS: "1" }), stdio: ["pipe", "pipe", "pipe"] });
  atEnd(() => child.kill());
  const ended = new Promise(resolve => child.on("exit", code => resolve(code)));
  // As its helper gives them: its password and the vault's secret, on stdin, the pipe left open.
  child.stdin.write(JSON.stringify({ password, hostVaultSecret: "s".repeat(64) }) + "\n");
  const { url } = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", chunk => {
      out += chunk;
      if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0]));
    });
    ended.then(code => reject(new Error(`serve ended (${code})`)));
  });
  const recordFile = path.join(where.run, "serve.json");
  const record = JSON.parse(read(recordFile));
  assert.deepEqual(record, { pid: child.pid, port: Number(new URL(url).port), password, kept: false });
  assert.equal(fs.statSync(recordFile).mode & 0o777, 0o600);
  const info = await fetch(`${url}/kuvo/info`, { headers: { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") } });
  assert.equal(info.status, 200);
  await info.body?.cancel();
  // Its helper gone (its stdin closed): so is it, and its record.
  child.stdin.end();
  assert.equal(await ended, 0);
  assert.equal(exists(recordFile), false);
});

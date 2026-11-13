// A box on its own (#333 piece 3): its server for clients, which its keeper keeps running while one
// wants it (`serve --kept`, `run/serve.needed`, `kuvo/box/serve`; PROTOCOL.md, "Kept for clients");
// and removing Kuvo Code from a computer, the box's own command (`uninstall`; "Uninstalling"),
// which the app or a Terminal line runs. The real box script, in homes of the test's own, with
// stand-ins for the box's keeper (`bin/kuvo-start`), `launchctl` and `crontab`: never this
// computer's own, which a test's home leaves alone without them.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/own-box-start.test.js`.
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

/** A home of the test's own, its box a machine's unless `kind` says otherwise. */
function home(kind) {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-own-box-start-")));
  removeAtEnd(folder);
  if (kind) write(path.join(folder, ".kuvo-code", "box", "kind"), `${kind}\n`);
  fs.mkdirSync(path.join(folder, ".kuvo-code", "run"), { recursive: true });
  return { home: folder, K: path.join(folder, ".kuvo-code"), run: path.join(folder, ".kuvo-code", "run") };
}
const envOf = ({ home, K }, more = {}) => ({ ...process.env, HOME: home, KUVO_HOME: K, TMPDIR: home, ...more });

function route(where, method, routePath, sent) {
  const done = spawnSync(process.execPath, [script, "box", "route"], { env: envOf(where), input: JSON.stringify({ method, path: routePath, ...(sent === undefined ? {} : { body: sent }) }), encoding: "utf8" });
  const said = JSON.parse(done.stdout.trim().split("\n").pop());
  return { status: said.status, body: said.body ? JSON.parse(said.body) : null };
}

/** `serve --kept` started, and what it said as it began (or nothing, as it ended). */
function keptServe(where) {
  const child = spawn(process.execPath, [script, "serve", "--kept"], { env: envOf(where, { KUVO_TEST_SERVE_EVERY: "50" }), stdio: ["ignore", "pipe", "pipe"] });
  atEnd(() => child.kill());
  const ended = new Promise(resolve => child.on("exit", code => resolve(code)));
  const began = new Promise(resolve => {
    let out = "";
    child.stdout.on("data", chunk => {
      out += chunk;
      if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0]));
    });
    ended.then(() => resolve(null));
  });
  return { child, began, ended };
}

test("the box's server for clients runs while one wants it, says where in serve.json, and goes once it isn't wanted", async () => {
  const where = home();
  // Not wanted: it doesn't start.
  const unwanted = keptServe(where);
  assert.equal(await unwanted.began, null);
  assert.equal(await unwanted.ended, 0);
  assert.equal(exists(path.join(where.run, "serve.json")), false);

  // Asked for, as a client attaching asks.
  assert.deepEqual(route(where, "POST", "kuvo/box/serve", { needed: true }).body, { needed: true, serving: false });
  assert.equal(exists(path.join(where.run, "serve.needed")), true);
  const kept = keptServe(where);
  const { url } = await kept.began;
  const record = JSON.parse(read(path.join(where.run, "serve.json")));
  assert.equal(record.pid, kept.child.pid);
  assert.equal(record.kept, true);
  assert.equal(`http://127.0.0.1:${record.port}`, url);
  assert.equal(fs.statSync(path.join(where.run, "serve.json")).mode & 0o777, 0o600);
  // It answers clients' routes, with its own password.
  const info = await fetch(`${url}/kuvo/info`, { headers: { authorization: "Basic " + Buffer.from(`opencode:${record.password}`).toString("base64") } });
  assert.equal(info.status, 200);
  assert.equal((await info.json()).kind, "machine");
  assert.equal((await fetch(`${url}/kuvo/info`)).status, 401);
  assert.deepEqual(route(where, "GET", "kuvo/box/serve").body, { needed: true, serving: true });
  // One at a time: a second leaves it be.
  const second = keptServe(where);
  assert.equal(await second.began, null);
  assert.equal(JSON.parse(read(path.join(where.run, "serve.json"))).pid, kept.child.pid);

  // Not wanted any more: it goes, and its record with it.
  assert.deepEqual(route(where, "POST", "kuvo/box/serve", { needed: false }).body, { needed: false, serving: true });
  assert.equal(await kept.ended, 0);
  assert.equal(exists(path.join(where.run, "serve.json")), false);
});

test("a Mac's own box has its server run by Kuvo Code itself, not kept for clients", () => {
  const where = home("mac");
  assert.equal(route(where, "POST", "kuvo/box/serve", { needed: true }).status, 409);
  assert.equal(exists(path.join(where.run, "serve.needed")), false);
});

/** Stand-ins for the box's keeper, `launchctl` and `crontab`, noting what they're asked in the home. */
function standIns(where, table) {
  const tools = path.join(where.home, "tools");
  write(path.join(where.K, "bin", "kuvo-start"), `#!/bin/sh\necho "$*" >>"${where.home}/kuvo-start"\n[ "$1" = off ] && touch "$HOME/.kuvo-code/run/off"\nexit 0\n`, 0o755);
  write(path.join(tools, "launchctl"), `#!/bin/sh\necho "$*" >>"${where.home}/launchctl"\n`, 0o755);
  write(path.join(tools, "crontab"), `#!/bin/sh\nif [ "$1" = -l ]; then [ -f "${where.home}/crontab" ] || { echo "no crontab for you" >&2; exit 1; }; cat "${where.home}/crontab"; else cat >"${where.home}/crontab"; fi\n`, 0o755);
  if (table !== undefined) write(path.join(where.home, "crontab"), table);
  write(path.join(where.home, "Library", "LaunchAgents", "run.kuvo.code.machine.plist"), "<plist/>\n");
  return tools;
}

const TAG = "# kuvo-code: starts its engine again after a restart";
/** `uninstall`, as a Terminal runs it: how it exited, and what it said. */
const uninstall = (where, args = [], more = {}) => new Promise(resolve => {
  const child = spawn(process.execPath, [script, "uninstall", ...args], { env: envOf(where, more), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.on("close", status => resolve({ status, stdout, stderr }));
});

test("uninstall: nothing of the box starts again, at login or after a restart, and nothing of it runs; its folder stays", async () => {
  const where = home("mac");
  const other = "0 9 * * * echo mine";
  const tools = standIns(where, `${other}\n@reboot sh "$HOME/.kuvo-code/bin/kuvo-start" >/dev/null 2>&1 ${TAG}\n`);
  const given = { KUVO_TEST_UNINSTALL_TOOLS: tools };
  // A server kept for clients, running.
  write(path.join(where.run, "serve.needed"), "");
  const kept = keptServe(where);
  await kept.began;

  // What it would stop, said first, with nothing changed.
  const check = await uninstall(where, ["--check"], given);
  assert.equal(check.status, 0, check.stderr);
  const facts = JSON.parse(check.stdout);
  assert.equal(facts.folder, where.K);
  assert.equal(facts.kind, "mac");
  assert.deepEqual(facts.running, ["server"]);
  assert.deepEqual(facts.starts, { launchAgent: process.platform === "darwin", crontab: true, checked: true });
  assert.equal(facts.bots, 0);
  assert.equal(facts.phones, 0);
  assert.equal(exists(path.join(where.home, "kuvo-start")), false, "the check stops nothing");

  const done = await uninstall(where, [], given);
  assert.equal(done.status, 0, done.stderr);
  const said = JSON.parse(done.stdout);
  assert.equal(said.result, "uninstalled");
  assert.deepEqual(said.left, [where.K]);
  assert.match(done.stderr, /won't start again\. Its folder stays/);
  assert.equal(read(path.join(where.home, "kuvo-start")), "off\n", "its keeper stopped everything, for good");
  assert.equal(await kept.ended, 0, "the server kept for clients, gone");
  assert.equal(exists(path.join(where.run, "serve.needed")), false);
  // Its crontab line gone, the rest kept.
  assert.equal(read(path.join(where.home, "crontab")), `${other}\n`);
  if (process.platform === "darwin") {
    assert.equal(read(path.join(where.home, "launchctl")), `bootout gui/${process.getuid()}/run.kuvo.code.machine\n`);
    assert.equal(exists(path.join(where.home, "Library", "LaunchAgents", "run.kuvo.code.machine.plist")), false);
    assert.equal(said.launchAgent, true);
  } else {
    assert.equal(exists(path.join(where.home, "launchctl")), false, "no launchd on Linux");
  }
  assert.equal(said.crontab, true);
  // Its folder, as it was.
  assert.equal(read(path.join(where.K, "box", "kind")), "mac\n");
});

test("uninstall in a home that isn't the real one leaves this computer's launchd and crontab alone without stand-ins", async () => {
  const where = home();
  const table = `@reboot sh x ${TAG}\n`;
  standIns(where, table);
  const done = await uninstall(where);
  assert.equal(done.status, 0, done.stderr);
  const said = JSON.parse(done.stdout);
  assert.equal(said.launchAgent, false);
  assert.equal(said.crontab, false);
  assert.equal(read(path.join(where.home, "crontab")), table);
  assert.equal(exists(path.join(where.home, "Library", "LaunchAgents", "run.kuvo.code.machine.plist")), true);
  assert.equal(exists(path.join(where.home, "launchctl")), false);
  assert.equal(read(path.join(where.home, "kuvo-start")), "off\n");
  assert.deepEqual(JSON.parse((await uninstall(where, ["--check"])).stdout).starts, { launchAgent: false, crontab: false, checked: false });
});

test("uninstall: a crontab that can't be read is never written over", async () => {
  const where = home();
  const tools = standIns(where);
  // Its crontab answers with an error that isn't "no crontab".
  write(path.join(tools, "crontab"), `#!/bin/sh\nif [ "$1" = -l ]; then echo "crontab: can't open your crontab" >&2; exit 1; fi\necho written >>"${where.home}/crontab-written"\n`, 0o755);
  const done = await uninstall(where, [], { KUVO_TEST_UNINSTALL_TOOLS: tools });
  assert.equal(done.status, 0, done.stderr);
  assert.equal(exists(path.join(where.home, "crontab-written")), false);
});

test("uninstall refuses this Mac's box in its app's folder, which only the app removes", () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-own-box-app-folder-")));
  removeAtEnd(folder);
  const K = path.join(folder, "Support", "box");
  fs.mkdirSync(path.join(K, "run"), { recursive: true });
  const done = spawnSync(process.execPath, [script, "uninstall"], { env: { ...process.env, HOME: folder, KUVO_HOME: K, KUVO_BOX: "mac", KUVO_ENGINE_CONFIG: path.join(folder, "Support", "opencode", "config"), TMPDIR: folder }, encoding: "utf8" });
  assert.equal(done.status, 1);
  assert.equal(JSON.parse(done.stdout).result, "refused");
  assert.equal(exists(path.join(K, "run", "off")), false);
});

test("uninstall refuses an app's box named by its folder alone, without the keeper's word for it", async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-own-box-named-")));
  removeAtEnd(folder);
  const K = path.join(folder, "run.kuvo.code.tests", "box");
  fs.mkdirSync(path.join(K, "run"), { recursive: true });
  const tools = standIns({ home: folder, K }, `@reboot sh x ${TAG}\n`);
  const done = await uninstall({ home: folder, K }, [], { KUVO_TEST_UNINSTALL_TOOLS: tools });
  assert.equal(done.status, 1);
  assert.equal(JSON.parse(done.stdout).result, "refused");
  assert.equal(exists(path.join(folder, "kuvo-start")), false, "nothing stopped");
  assert.equal(exists(path.join(folder, "launchctl")), false);
  assert.equal(read(path.join(folder, "crontab")), `@reboot sh x ${TAG}\n`);
});

test("uninstall says what it doesn't know", async () => {
  const where = home();
  assert.equal((await uninstall(where, ["--all"])).status, 2);
});

// A Mac's box in a home of its own (#333): laid out as a machine's, in `~/.kuvo-code`, with its kind
// recorded there (`box/kind`), started with no app beside it to name its folders or write its keys'
// files. Its keys stay in the Mac's Keychain, through its host (a stand-in keeps them in memory);
// the files its engine reads them from it writes itself, where a machine keeps its keys. Keep This
// Mac Awake is its own setting, read and changed as a client does (`kuvo-link.js box route`, which
// carries no word of its kind but the box's own), and it holds the Mac awake while agents work.
// Integrations' scenarios run on it as on every box.
import "./test-safety.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { script, standInHost } from "./bot-keys-scenarios.js";
import { integrationScenarios } from "./integrations-scenarios.js";
import { atEnd, removeAtEnd } from "./at-end.js";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-own-home-mac-")));
const home = path.join(root, "home");
const box = path.join(home, ".kuvo-code");
fs.mkdirSync(path.join(box, "box"), { recursive: true });
fs.writeFileSync(path.join(box, "box", "kind"), "mac\n");
const PASSWORD = "host-password-not-a-key";
const host = await standInHost(PASSWORD);
const env = { HOME: home, KUVO_HOME: box, KUVO_KEYS_ON_HOST: "1", KUVO_HOST_URL: host.url, KUVO_HOST_PASSWORD: PASSWORD };
Object.assign(process.env, env);
const link = await import(script);
removeAtEnd(root);

const keys = path.join(box, "box", "keys");
const botKeys = path.join(box, "box", "bot-keys");
const settingsFile = path.join(box, "config", "opencode", "opencode.json");

test("it's a Mac's box, and names every place from its home", () => {
  assert.equal(link.IS_MAC, true, "as box/kind says, with nothing in its environment saying so");
  const places = link.boxPlaces();
  assert.equal(places.layout, "own");
  assert.equal(places.appFolder, null);
  assert.equal(places.settingsFile, settingsFile);
  assert.equal(places.chats, path.join(box, "chats"));
  assert.deepEqual(places.attachments, [path.join(box, "attachments")]);
  assert.equal(places.keyFiles, keys);
});

integrationScenarios({ link, home: box, mac: true, store: {
  settingsFile,
  named: "~/.kuvo-code/box/keys",
  data: path.join(box, "integrations"),
  kept: name => host.keys.get(name) ?? null,
  keep: (name, value) => host.keys.set(name, value),
} });

const fileOf = name => path.join(name.includes("__") ? botKeys : keys, name);
const read = file => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } };

test("a key kept or removed: its host keeps it, and the box writes the engine's file beside it, only you can read", async () => {
  const name = "KUVO_KEY_TODOIST_API_KEY";
  assert.equal((await link.answerIntegrations("POST", "kuvo/integrations/todoist", { keys: { API_KEY: "tok_own" } }, null, undefined, undefined, () => {})).status, 200);
  assert.equal(host.keys.get(name), "tok_own", "in the Keychain");
  assert.equal(read(fileOf(name)), "tok_own", "and in the file its settings name");
  assert.equal(fs.statSync(fileOf(name)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")).mcp.servers.todoist.environment, { API_KEY: `{file:~/.kuvo-code/box/keys/${name}}` });
  assert.equal((await link.answerIntegrations("DELETE", "kuvo/integrations/todoist", undefined, null, undefined)).status, 200);
  assert.equal(host.keys.has(name), false);
  assert.equal(fs.existsSync(fileOf(name)), false, "its file gone with it");
});

test("as it starts, the files are what its host keeps: each written, a bot's own beside them, none it doesn't left", async () => {
  host.keys.set("KUVO_KEY_LINEAR_TOKEN", "lin_1");
  host.keys.set("KUVO_KEY_LINEAR_TOKEN__BOT_SCOUT", "lin_scout");
  fs.mkdirSync(keys, { recursive: true });
  fs.writeFileSync(fileOf("KUVO_KEY_GONE"), "removed in the Keychain meanwhile");
  fs.writeFileSync(fileOf("KUVO_KEY_LINEAR_TOKEN"), "an older value");
  assert.equal(await link.syncKeyFiles(), true);
  assert.equal(read(fileOf("KUVO_KEY_LINEAR_TOKEN")), "lin_1");
  assert.equal(read(fileOf("KUVO_KEY_LINEAR_TOKEN__BOT_SCOUT")), "lin_scout");
  assert.equal(fs.existsSync(fileOf("KUVO_KEY_GONE")), false);

  // Its host not answering: nothing taken away, and it says it couldn't.
  host.down = true;
  try {
    assert.equal(await link.syncKeyFiles(), false);
  } finally {
    host.down = false;
  }
  assert.equal(read(fileOf("KUVO_KEY_LINEAR_TOKEN")), "lin_1", "still there");
  for (const name of ["KUVO_KEY_LINEAR_TOKEN", "KUVO_KEY_LINEAR_TOKEN__BOT_SCOUT"]) host.keys.delete(name);
  assert.equal(await link.syncKeyFiles(), true);
  assert.deepEqual([...fs.readdirSync(keys), ...fs.readdirSync(botKeys)].sort(), [...host.keys.keys()].sort(), "the same keys as its host, no more");
  for (const [name, value] of host.keys) assert.equal(read(fileOf(name)), value);
});

// A client's route, as the app reaches a box it's attached to: one at a time, through the CLI.
function route(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const given = Object.fromEntries(Object.entries({ ...process.env, ...env, TMPDIR: path.join(home, "tmp") }).filter(([, value]) => value !== undefined));
    fs.mkdirSync(given.TMPDIR, { recursive: true });
    const child = spawn(process.execPath, [script, "box", "route"], { env: given, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("error", reject);
    child.on("close", () => {
      const said = JSON.parse(out.trim().split("\n").pop());
      resolve({ status: said.status, body: JSON.parse(said.body) });
    });
    child.stdin.end(JSON.stringify({ method, path: pathname, body }));
  });
}

// A stand-in for caffeinate, named so: a program that runs until it's let go (two minutes at most),
// never the Mac held for real.
const standIn = path.join(root, "stand-in", "caffeinate");
fs.mkdirSync(path.dirname(standIn), { recursive: true });
fs.writeFileSync(standIn, "#!/bin/sh\ni=0; while [ $i -lt 120 ]; do sleep 1; i=$((i + 1)); done\n", { mode: 0o755 });
const hold = { command: standIn, args: [] };
atEnd(() => link.holdForWork(false, hold));

test("Keep This Mac Awake is the box's own setting, on until you turn it off; elsewhere than a Mac, not said", async () => {
  const work = path.join(box, "box", "work.json");
  const said = await route("GET", "kuvo/work/settings");
  assert.equal(said.status, 200);
  if (process.platform !== "darwin") {
    assert.equal(said.body.keepsAwake, undefined, "a Mac's setting, on macOS");
    assert.equal((await route("PATCH", "kuvo/work/settings", { keepsAwake: false })).status, 400, "not taken where it means nothing");
    return;
  }
  assert.equal(said.body.keepsAwake, true);
  assert.equal(said.body.awakeNow, false, "nothing holds it");
  assert.equal((await route("PATCH", "kuvo/work/settings", { keepsAwake: "no" })).status, 400);
  // Both checked before either's kept.
  assert.equal((await route("PATCH", "kuvo/work/settings", { keepsAwake: false, projectsFolder: path.join(root, "nowhere") })).status, 400);
  assert.equal(fs.existsSync(work), false, "nothing kept");
  const off = await route("PATCH", "kuvo/work/settings", { keepsAwake: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.keepsAwake, false);
  assert.equal(JSON.parse(fs.readFileSync(work, "utf8")).keepsAwake, false, "kept in the box's own settings");
  assert.equal((await route("GET", "kuvo/work/settings")).body.keepsAwake, false);
  const on = await route("PATCH", "kuvo/work/settings", { keepsAwake: true, projectsFolder: null });
  assert.deepEqual([on.status, on.body.keepsAwake, on.body.projectsFolder], [200, true, null], "alone or with the projects folder");

  // Held by this box's own process (`serve`, here this one): every client's answer says so.
  await link.lookAtWork(async () => true, hold);
  assert.equal((await route("GET", "kuvo/work/settings")).body.awakeNow, true, "as the process that holds it says");
  link.holdForWork(false, hold);
  assert.equal((await route("GET", "kuvo/work/settings")).body.awakeNow, false);
});

test("it holds the Mac awake while agents work, as its setting says, and lets go when they stop or it's turned off", async () => {
  let working = true, on = true;
  const busy = async () => working;
  const setting = () => on;
  assert.equal(await link.lookAtWork(busy, hold, setting), true);
  assert.equal(link.awakeForWork(), true, "held while a session works");
  const record = JSON.parse(fs.readFileSync(link.WORK_AWAKE_FILE, "utf8"));
  assert.equal(record.by, process.pid);
  assert.equal(await link.lookAtWork(busy, hold, setting), true);
  assert.equal(JSON.parse(fs.readFileSync(link.WORK_AWAKE_FILE, "utf8")).hold, record.hold, "once, not twice");
  working = false;
  await link.lookAtWork(busy, hold, setting);
  assert.equal(link.awakeForWork(), false, "let go once none does");
  working = true;
  on = false;
  await link.lookAtWork(busy, hold, setting);
  assert.equal(link.awakeForWork(), false, "never while it's turned off");
  // Turned off while it asked whether anything works: not held after all.
  on = true;
  await link.lookAtWork(async () => { on = false; return true; }, hold, setting);
  assert.equal(link.awakeForWork(), false);
  on = true;
  await link.lookAtWork(busy, hold, setting);
  assert.equal(link.awakeForWork(), true);
  link.holdForWork(false, hold);
});

test("where its engine is recorded but doesn't answer, whether anything works can't be told, and the hold stays as it was", async () => {
  const closed = http.createServer();
  await new Promise(resolve => closed.listen(0, "127.0.0.1", resolve));
  const port = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  const none = () => { throw new Error("none"); };
  assert.equal(await link.agentsWorking(() => ({ port, password: "p" }), none), null);
  assert.equal(await link.agentsWorking(none, none), false, "none recorded: nothing works");
  const engine = http.createServer((request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data: { ses_one: {} } })); });
  await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
  atEnd(() => { engine.closeAllConnections(); engine.close(); });
  assert.equal(await link.agentsWorking(() => ({ port: engine.address().port, password: "p" }), none), true);

  await link.lookAtWork(async () => true, hold, () => true);
  await link.lookAtWork(() => link.agentsWorking(() => ({ port, password: "p" }), none), hold, () => true);
  assert.equal(link.awakeForWork(), true, "still held");
  link.holdForWork(false, hold);
});

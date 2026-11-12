// Work outside the project asks first, on the real engine, as Settings › Permissions says: on a
// machine's box and this Mac's, the engine's own agents ask before they read or write in a folder
// outside a conversation's project (your home folder's `.ssh`, another project), what you set in
// Settings › Permissions still wins (an allow and a deny of your own), and what Kuvo Code and the
// engine keep for an agent to open stays open: files sent with a message, the engine's long
// outputs saved whole, skills' files. The real box starts as it does, then the engine starts with
// the folders its box gives it, and the engine says what it would do (its permission route, which
// rules the read and write tools by). Skipped unless OPENCODE_TEST_BINARY names the engine.
//
// Run with `OPENCODE_TEST_BINARY=<opencode> node --test Packages/KuvoLink/Tests/Bridge/outside-asks-live.test.js`;
// on Linux, on the engine's Bun (`OPENCODE_TEST_BINARY=<opencode> BUN_BE_BUN=1 <opencode> test outside-asks-live.test.js`).
import { testsFolder } from "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { script } from "./bot-keys-scenarios.js";
import { atEnd, removeAtEnd } from "./at-end.js";

const binary = process.env.OPENCODE_TEST_BINARY;
const skip = !binary && "OPENCODE_TEST_BINARY isn't set";

let root;
if (!skip) {
  root = fs.realpathSync(testsFolder("outside"));
  removeAtEnd(root);
}

// A box of its own, as it starts (its engine's plugins written), then stopped: a machine's (its
// folder `.kuvo-code`, its settings in `box/opencode.json`), or this Mac's (`KUVO_BOX=mac`, in an
// app's folder, its engine's settings beside it).
async function boxStarted(name, mac) {
  const box = boxFolders(name, mac);
  await startBox(box);
  return box;
}

// Its folders, with your settings and a skill of your own, before it first starts.
function boxFolders(name, mac) {
  const app = path.join(root, name);
  const home = path.join(app, "home");
  const K = mac ? path.join(app, "box") : path.join(home, ".kuvo-code");
  const config = mac ? path.join(app, "opencode", "config") : path.join(K, "config");
  const data = mac ? path.join(app, "opencode", "data") : path.join(K, "data");
  const settings = mac ? path.join(config, "opencode", "opencode.json") : path.join(K, "box", "opencode.json");
  for (const folder of [home, path.join(K, "run"), path.join(home, "work"), path.join(app, "tmp"), data]) fs.mkdirSync(folder, { recursive: true });
  // Your own rules in Settings › Permissions: one folder outside allowed, another refused.
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ permissions: [
    { action: "external_directory", resource: path.join(home, "shared") + "/*", effect: "allow" },
    { action: "external_directory", resource: path.join(home, "kept-out") + "/*", effect: "deny" },
  ] }));
  // A skill of your own, where the engine finds them.
  const skill = path.join(config, "opencode", "skills", "notes");
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: notes\ndescription: Notes, kept as the user likes them.\n---\n\nKeep notes short.\n");
  return { app, home, K, config, data, settings, skill, mac };
}

// The box starting (its engine's plugins written), then stopped.
async function startBox({ app, home, K, config, mac }, more = {}) {
  // (On Linux, run on the engine's own Bun, as a machine's box is: `BUN_BE_BUN=1`.)
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: path.join(app, "tmp") + "/", KUVO_HOME: K, OPENCODE_PASSWORD: "box-pw", ...(process.env.BUN_BE_BUN ? { BUN_BE_BUN: "1" } : {}),
    ...(mac ? { KUVO_BOX: "mac", KUVO_ENGINE_CONFIG: config, KUVO_BOTS: path.join(app, "bots"), KUVO_CHATS: path.join(app, "Chats") } : {}), ...more };
  const box = spawn(process.execPath, [script, "serve"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  box.stdout.setEncoding("utf8");
  box.stderr.setEncoding("utf8");
  box.stderr.on("data", chunk => { err += chunk; });
  const exited = new Promise(resolve => box.once("exit", resolve));
  await new Promise((resolve, reject) => {
    // (Started once it says where it is: its engine's plugins are written by then.)
    box.stdout.on("data", chunk => { out += chunk; if (out.split("\n").some(line => line.includes('"url"'))) resolve(); });
    exited.then(code => reject(new Error(`serve exited ${code}: ${err}`)));
  });
  box.stdin.end();
  box.kill("SIGTERM");
  await exited;
}

// The box's engine, as its computer starts it: a machine's with its folders in `.kuvo-code` and
// its settings named (RemoteEngine.swift), this Mac's with the app's (ServerProcess.swift).
async function engineOf(box) {
  const env = { PATH: process.env.PATH, HOME: box.home, TMPDIR: path.join(box.app, "tmp") + "/", XDG_CONFIG_HOME: box.config, XDG_DATA_HOME: box.data,
    XDG_STATE_HOME: path.join(box.app, "state"), XDG_CACHE_HOME: path.join(box.app, "cache"), OPENCODE_PASSWORD: "pw", ...(box.mac ? {} : { OPENCODE_CONFIG: box.settings }) };
  const engine = spawn(binary, ["serve", "--stdio", "--port", "0"], { env, cwd: path.join(box.home, "work"), stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise(resolve => engine.once("exit", resolve));
  atEnd(async () => { engine.stdin.end(); engine.kill(); await exited; });
  const port = await new Promise((resolve, reject) => {
    let said = "";
    const look = chunk => { said += chunk; const found = said.match(/127\.0\.0\.1:(\d+)/); if (found) resolve(Number(found[1])); };
    engine.stdout.on("data", look);
    engine.stderr.on("data", look);
    exited.then(code => reject(new Error(`The engine ended (${code}): ${said}`)));
  });
  const auth = { authorization: "Basic " + Buffer.from("opencode:pw").toString("base64"), "content-type": "application/json" };
  // What it tells its clients, from now: `changed(type)` is the next of that kind (and fails if
  // the engine stops telling them first).
  const waiting = [];
  const stream = new AbortController();
  atEnd(() => stream.abort());
  let connected;
  const ready = new Promise((resolve, reject) => { connected = { resolve, reject }; });
  const ended = why => { connected.reject(why); for (const each of waiting.splice(0)) each.reject(why); };
  fetch(`http://127.0.0.1:${port}/api/event`, { headers: auth, signal: stream.signal }).then(async response => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of response.body) {
      buffered += decoder.decode(chunk, { stream: true });
      for (let at; (at = buffered.indexOf("\n")) >= 0; buffered = buffered.slice(at + 1)) {
        const line = buffered.slice(0, at);
        if (!line.startsWith("data:")) continue;
        const { type } = JSON.parse(line.slice(5));
        if (type === "server.connected") connected.resolve();
        for (const each of waiting.filter(one => one.type === type)) { waiting.splice(waiting.indexOf(each), 1); each.resolve(); }
      }
    }
    ended(new Error("The engine's events ended"));
  }).catch(ended);
  // (Listening before anything changes.)
  await ready;
  const changed = type => new Promise((resolve, reject) => waiting.push({ type, resolve, reject }));
  const api = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/${route}`, { method, headers: auth, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  // Its plugins set up (its providers wait for them; from 2.2.7 its agents and skills are listed at
  // once, with what it has so far), then its agents loaded, and the skills it found, as a
  // conversation starts.
  await api("GET", "api/provider");
  const agents = (await api("GET", "api/agent")).data;
  await api("GET", "api/skill");
  const session = (await api("POST", "api/session", { location: { directory: path.join(box.home, "work") } })).data.id;
  // What the engine does when `agent`'s tools reach `folder`: as its read, write and edit tools ask
  // for a file outside the project, its folder's pattern.
  const effect = async (agent, folder) => (await api("POST", `api/session/${session}/permission`, { action: "external_directory", resources: [folder + "/*"], agent })).data.effect;
  return { agents, effect, api, changed };
}

// The engine's own agents a conversation runs (and those that run for it, Explore and General).
const AGENTS = ["build", "plan", "general", "explore"];

for (const mac of [false, true]) {
  test(`${mac ? "This Mac's" : "A machine's"} box: the engine's agents ask before working outside the project, your rules win, and what's kept for them stays open`, { skip, timeout: 180_000 }, async () => {
    const box = await boxStarted(mac ? "mac" : "machine", mac);
    const engine = await engineOf(box);
    for (const agent of AGENTS) assert.ok(engine.agents.some(each => each.id === agent || each.name === agent), `the engine has ${agent}`);
    for (const agent of AGENTS) {
      assert.equal(await engine.effect(agent, path.join(box.home, ".ssh")), "ask", `${agent} asks before reading your SSH keys`);
      assert.equal(await engine.effect(agent, path.join(box.home, "other-project", "src")), "ask", `${agent} asks before working in another project`);
      assert.equal(await engine.effect(agent, path.join(box.home, "shared")), "allow", `${agent}: your allow wins`);
      assert.equal(await engine.effect(agent, path.join(box.home, "kept-out")), "deny", `${agent}: your deny wins`);
      // What's kept for it to open: a file sent with a message, a long output saved whole, a skill's files.
      assert.equal(await engine.effect(agent, path.join(box.K, "attachments", "ses_one")), "allow", `${agent} opens files sent with a message`);
      if (mac) assert.equal(await engine.effect(agent, path.join(box.app, "Attachments", "ses_one")), "allow", `${agent} opens files this Mac's app attached`);
      assert.equal(await engine.effect(agent, path.join(box.data, "opencode", "tool-output")), "allow", `${agent} opens long outputs saved whole`);
      assert.equal(await engine.effect(agent, path.join(box.skill, "examples")), "allow", `${agent} opens a skill's files`);
      assert.equal(await engine.effect(agent, path.join(box.home, ".opencode", "plan")), "allow", `${agent} opens Plan's plans`);
    }
  });
}

for (const mac of [false, true]) {
  test(`${mac ? "This Mac's" : "A machine's"} box: an engine that was already running, a conversation open, when the box first wrote its plugin asks before working outside the project too, as it runs`, { skip, timeout: 180_000 }, async () => {
    // (As after an update that brings the plugin: the engine kept running, the box started again.)
    const box = boxFolders(mac ? "mac-running" : "machine-running", mac);
    const engine = await engineOf(box);
    assert.equal(fs.existsSync(path.join(box.config, "opencode", "plugins", "kuvo-defaults.js")), false, "the box hasn't written its plugin yet");
    for (const agent of AGENTS) assert.equal(await engine.effect(agent, path.join(box.home, ".ssh")), "allow", `without the plugin, ${agent} doesn't ask`);
    let reloaded = engine.changed("agent.updated");
    reloaded.catch(() => {});
    // (With its sandbox off, so its plugin is the only one that changes: after an update the
    // sandbox's is there already.)
    await startBox(box, { KUVO_SANDBOX: "off" });
    // The engine sees its plugins folder change and sets up its plugins and agents again, for the
    // folders it has open, and says its agents changed: once with the plugin's rules in them (the
    // box may change its settings too, each read again on its own).
    const plugged = agent => agent.permissions?.some(rule => rule.action === "external_directory" && rule.resource === "*" && rule.effect === "ask");
    for (let round = 1; ; round++) {
      await reloaded;
      reloaded = engine.changed("agent.updated");
      reloaded.catch(() => {});
      if ((await engine.api("GET", "api/agent")).data.filter(each => AGENTS.includes(each.id)).every(plugged)) break;
      assert.ok(round < 10, "the engine said its agents changed ten times without the plugin's rules in them");
    }
    for (const agent of AGENTS) {
      assert.equal(await engine.effect(agent, path.join(box.home, ".ssh")), "ask", `${agent} asks before reading your SSH keys`);
      assert.equal(await engine.effect(agent, path.join(box.home, "shared")), "allow", `${agent}: your allow wins`);
      assert.equal(await engine.effect(agent, path.join(box.K, "attachments", "ses_one")), "allow", `${agent} opens files sent with a message`);
    }
  });
}

// Agents' commands in the sandbox (PROTOCOL.md, "Sandbox"): off until you turn it on; on, each
// command the engine runs writes only in its conversation's folder (and that folder's git
// repository, but never what git runs on its own), and can't read Kuvo Code's own folders, another
// bot's, or your secrets. The engine is a stand-in here, as far as it goes: it loads the box's real
// plugin and runs a command as the engine does, through the shell the plugin gives it, with the
// environment the plugin set. The sandbox itself is the system's own (macOS's, Linux's Landlock).
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/sandbox.test.js` (a short TMPDIR on macOS:
// sockets live in the test's folder).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { script } from "./bot-keys-scenarios.js";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ks-")));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const linux = process.platform === "linux";
const base = { ...process.env, HOME: root };
for (const name of ["KUVO_HOST_URL", "KUVO_HOST_PASSWORD", "KUVO_KEYS", "KUVO_KEYS_ON_HOST", "KUVO_BOX", "KUVO_ENGINE_CONFIG", "KUVO_VAULT_AGENTS"]) delete base[name];

// A box of its own: a machine's (its folder `.kuvo-code`), or this Mac's (`KUVO_BOX=mac`, in an
// app's folder, its engine's settings beside it).
function boxAt(name, mac = false) {
  const app = path.join(root, name);
  const home = mac ? path.join(app, "box") : path.join(app, ".kuvo-code");
  const config = mac ? path.join(app, "opencode", "config") : path.join(home, "config");
  const env = { ...base, KUVO_HOME: home, ...(mac ? { KUVO_BOX: "mac", KUVO_ENGINE_CONFIG: config, KUVO_BOTS: path.join(app, "bots"), KUVO_CHATS: path.join(app, "Chats") } : {}) };
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  // The engine, running: on Linux, the Bun the sandbox's script runs on is the engine's own (this
  // one, run on the engine as a machine's link is; or the Bun on the PATH).
  fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify({ pid: process.pid, port: 1, password: "engine-pw", version: "test" }));
  if (linux) {
    const bun = process.versions.bun ? process.execPath : spawnSync("sh", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim();
    assert.ok(bun, "the sandbox runs on Bun on Linux: run this with the engine (BUN_BE_BUN=1) or with Bun on the PATH");
    fs.mkdirSync(path.join(home, "engine", "test"), { recursive: true });
    fs.symlinkSync(bun, path.join(home, "engine", "test", "opencode"));
  }
  return { app, home, config, env, plugin: path.join(config, "opencode", "plugins", "kuvo-sandbox.js"), bots: mac ? path.join(app, "bots") : path.join(home, "bots") };
}

async function start(box) {
  const child = spawn(process.execPath, [script, "serve"], { env: { ...box.env, OPENCODE_PASSWORD: "box-pw" }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { err += chunk; });
  const exited = new Promise(resolve => child.once("exit", resolve));
  const url = await new Promise((resolve, reject) => {
    child.stdout.on("data", chunk => {
      out += chunk;
      if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0]).url);
    });
    exited.then(code => reject(new Error(`serve exited ${code}: ${err}`)));
  });
  const ask = async (method, route, body) => {
    const response = await fetch(`${url}/${route}`, { method, headers: { authorization: `Basic ${Buffer.from("opencode:box-pw").toString("base64")}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, value: await response.json().catch(() => ({})) };
  };
  const stop = async () => { child.stdin.end(); child.kill("SIGTERM"); await exited; };
  return { url, ask, stop };
}

// The engine, opening `folder` and running `command` there as its shell tool does: through the
// shell its plugins give it, with the environment they set. With no plugin of the sandbox's, as before.
async function engineRuns(box, folder, command) {
  const input = { command, cwd: folder, timeout: 0, shell: "/bin/sh", env: { PATH: process.env.PATH, HOME: root } };
  if (fs.existsSync(box.plugin)) {
    const plugin = (await import(`${pathToFileURL(box.plugin)}?${Math.random()}`)).default;
    let hook;
    await plugin.setup({ location: { directory: folder }, shell: { hook: async (name, take) => { assert.equal(name, "create.before"); hook = take; } } });
    hook(input);
  }
  const run = spawnSync(input.shell, ["-c", input.command], { cwd: input.cwd, env: input.env, encoding: "utf8" });
  return { status: run.status, out: run.stdout + run.stderr };
}

// What a command could do, each line `<what>: allowed` or `refused`.
const tries = lines => lines.map(([what, command]) => `if ( ${command} ) >/dev/null 2>&1; then echo "${what}: allowed"; else echo "${what}: refused"; fi`).join("\n");
const outcome = out => Object.fromEntries(out.trim().split("\n").filter(line => /: (allowed|refused)$/.test(line)).map(line => line.split(": ")));

test("off until you turn it on: commands run as before, and the engine has none of the sandbox's plugin", async () => {
  const box = boxAt("off");
  const project = path.join(root, "off-project");
  fs.mkdirSync(project);
  const running = await start(box);
  try {
    const state = (await running.ask("GET", "kuvo/sandbox")).value;
    assert.equal(state.on, false);
    assert.equal(state.wanted, false);
    assert.equal(state.why, "It's off.");
    assert.equal(fs.existsSync(box.plugin), false);
    const ran = await engineRuns(box, project, `cat ${JSON.stringify(path.join(box.home, "run", "engine.json"))}`);
    assert.equal(ran.status, 0, "without it, a command reads what it could before");
  } finally {
    await running.stop();
  }
});

test("on, a command writes in its own project, git works there, and Kuvo Code's own folder can't be read, listed or written, nor the sandbox turned off", async () => {
  const box = boxAt("machine");
  const project = path.join(root, "shop");
  fs.mkdirSync(project);
  assert.equal(spawnSync("git", ["init", "-q", project]).status, 0);
  const running = await start(box);
  try {
    let state = (await running.ask("PATCH", "kuvo/sandbox", { on: true })).value;
    assert.equal(state.wanted, true);
    assert.equal(state.able, true, state.why);
    assert.equal(state.on, false, "the engine hasn't loaded it yet");
    assert.equal(state.why, "Waiting for the engine to load it.");
    assert.equal(state.agents, false, "the coding agents' own programs aren't sandboxed yet");
    const kept = path.join(box.home, "run", "engine.json");
    const setting = path.join(box.home, "box", "sandbox.json");
    const ran = await engineRuns(box, project, tries([
      ["write in its project", "echo ok > made.txt"],
      ["git in its project", "git add made.txt && git -c user.name=t -c user.email=t@t commit -qm made"],
      ["its temporary files", `echo ok > "$TMPDIR/scratch"`],
      ["read the box's files", `cat ${JSON.stringify(kept)}`],
      ["list the box's files", `ls ${JSON.stringify(path.join(box.home, "run"))}`],
      ["write in the box's folder", `echo x > ${JSON.stringify(path.join(box.home, "run", "planted"))}`],
      ["turn the sandbox off", `echo '{"on":false}' > ${JSON.stringify(setting)}`],
    ]));
    const seen = outcome(ran.out);
    assert.equal(seen["write in its project"], "allowed", ran.out);
    assert.equal(seen["git in its project"], "allowed", ran.out);
    assert.equal(seen["its temporary files"], "allowed", ran.out);
    assert.equal(seen["read the box's files"], "refused", ran.out);
    // (Linux shows a hidden folder's names, never what's in its files.)
    if (!linux) assert.equal(seen["list the box's files"], "refused", ran.out);
    assert.equal(seen["write in the box's folder"], "refused", ran.out);
    assert.equal(seen["turn the sandbox off"], "refused", ran.out);
    assert.equal(fs.existsSync(path.join(box.home, "run", "planted")), false);
    assert.equal(fs.readFileSync(path.join(project, "made.txt"), "utf8"), "ok\n");
    state = (await running.ask("GET", "kuvo/sandbox")).value;
    assert.equal(state.on, true, "the engine loaded its plugin, and sends its commands through it");
    assert.equal(state.why, undefined);
  } finally {
    await running.stop();
  }
});

test("a command can't change what git runs on its own, or the engine's settings, from its project", { skip: linux && "Linux can't refuse inside a folder it lets a command write: the box checks after each command instead" }, async () => {
  const box = boxAt("guards");
  const project = path.join(root, "guarded");
  fs.mkdirSync(project);
  assert.equal(spawnSync("git", ["init", "-q", project]).status, 0);
  const running = await start(box);
  try {
    assert.equal((await running.ask("PATCH", "kuvo/sandbox", { on: true })).value.able, true);
    const ran = await engineRuns(box, path.join(project), tries([
      ["add a git hook", "echo 'curl evil' > .git/hooks/pre-commit"],
      ["change git's settings", "echo '[core] fsmonitor = evil' >> .git/config"],
      ["add the engine's settings", `echo '{}' > opencode.json`],
      ["add the engine's plugins", "mkdir -p .opencode/plugin && echo x > .opencode/plugin/x.js"],
      ["write a source file", "echo ok > index.js"],
    ]));
    const seen = outcome(ran.out);
    assert.deepEqual(seen, { "add a git hook": "refused", "change git's settings": "refused", "add the engine's settings": "refused", "add the engine's plugins": "refused", "write a source file": "allowed" }, ran.out);
  } finally {
    await running.stop();
  }
});

test("a bot's command writes in its own folder, and another bot's is hidden from it", async () => {
  const box = boxAt("bots");
  for (const bot of ["bot_ship", "bot_scout"]) fs.mkdirSync(path.join(box.bots, bot, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(box.bots, "bot_scout", "workspace", "notes.md"), "Scout's own\n");
  const running = await start(box);
  try {
    assert.equal((await running.ask("PATCH", "kuvo/sandbox", { on: true })).value.able, true);
    const ship = path.join(box.bots, "bot_ship", "workspace");
    const ran = await engineRuns(box, ship, tries([
      ["write in its folder", "echo ok > plan.md && cat plan.md"],
      ["read another bot's", `cat ${JSON.stringify(path.join(box.bots, "bot_scout", "workspace", "notes.md"))}`],
      ["write in another bot's", `echo x > ${JSON.stringify(path.join(box.bots, "bot_scout", "workspace", "planted"))}`],
    ]));
    assert.deepEqual(outcome(ran.out), { "write in its folder": "allowed", "read another bot's": "refused", "write in another bot's": "refused" }, ran.out);
  } finally {
    await running.stop();
  }
});

test("turned off, the engine's plugin goes, and commands run as before", async () => {
  const box = boxAt("toggled");
  const project = path.join(root, "toggled-project");
  fs.mkdirSync(project);
  const running = await start(box);
  try {
    assert.equal((await running.ask("PATCH", "kuvo/sandbox", { on: true })).value.able, true);
    assert.equal(fs.existsSync(box.plugin), true);
    const state = (await running.ask("PATCH", "kuvo/sandbox", { on: false })).value;
    assert.deepEqual([state.on, state.wanted, state.why], [false, false, "It's off."]);
    assert.equal(fs.existsSync(box.plugin), false);
    assert.equal((await engineRuns(box, project, `cat ${JSON.stringify(path.join(box.home, "run", "engine.json"))}`)).status, 0);
    assert.equal((await running.ask("PATCH", "kuvo/sandbox", { on: "yes" })).status, 400);
  } finally {
    await running.stop();
  }
});

test("this Mac's box hides its app's whole folder, its chats but the conversation's own, and refuses Kuvo Code's own servers", { skip: linux && "this Mac's box only" }, async () => {
  const box = boxAt("run.kuvo.code.sandbox-test", true);
  const chats = path.join(box.app, "Chats");
  for (const chat of ["chat_a", "chat_b"]) fs.mkdirSync(path.join(chats, chat), { recursive: true });
  fs.writeFileSync(path.join(chats, "chat_b", "secret.md"), "another chat's\n");
  fs.mkdirSync(path.join(box.app, "Attachments"), { recursive: true });
  fs.writeFileSync(path.join(box.app, "Attachments", "photo.txt"), "yours\n");
  const running = await start(box);
  try {
    const state = (await running.ask("PATCH", "kuvo/sandbox", { on: true })).value;
    assert.equal(state.able, true, state.why);
    assert.equal(fs.existsSync(box.plugin), true, "in the engine's own settings folder");
    const ran = await engineRuns(box, path.join(chats, "chat_a"), tries([
      ["write in its chat", "echo ok > reply.md"],
      ["read another chat", `cat ${JSON.stringify(path.join(chats, "chat_b", "secret.md"))}`],
      ["read the app's files", `cat ${JSON.stringify(path.join(box.app, "Attachments", "photo.txt"))}`],
      ["reach the box", `curl -s -m 2 -o /dev/null ${running.url}/kuvo/info`],
    ]));
    assert.deepEqual(outcome(ran.out), { "write in its chat": "allowed", "read another chat": "refused", "read the app's files": "refused", "reach the box": "refused" }, ran.out);
  } finally {
    await running.stop();
  }
});

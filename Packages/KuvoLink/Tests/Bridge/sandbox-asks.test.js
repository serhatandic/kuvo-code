// When the sandbox stops a command a task needs (PROTOCOL.md, "Sandbox", "Asks"): the agent asks
// with sandbox_ask, you see what it wants to run and why on any client (`kuvo/sandbox/asks`), and
// answer Allow Once (the box runs that one command outside the sandbox and hands back its output),
// Always for This (a rule for the project, kept in Also Allowed) or Don't Allow. The engine is a
// stand-in, as in sandbox.test.js: it loads the box's real plugin and runs commands through the
// shell it gives; the sandbox itself is the system's own.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/sandbox-asks.test.js`; on Linux, with Bun (the
// engine's: `BUN_BE_BUN=1 <engine> test sandbox-asks.test.js`).
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { script } from "./bot-keys-scenarios.js";

// In the folder tests keep in your home (not the temporary folders, which commands may write), so
// what a command mustn't write is somewhere it otherwise couldn't. (Short: the vault's socket,
// which the box's long-running process holds, lives in it.)
fs.mkdirSync(path.join(os.homedir(), ".kuvo-code-test"), { recursive: true });
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".kuvo-code-test", "sa-")));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const linux = process.platform === "linux";
const home = path.join(root, ".kuvo-code");
const env = { ...process.env, HOME: root, KUVO_HOME: home };
for (const name of ["KUVO_HOST_URL", "KUVO_HOST_PASSWORD", "KUVO_KEYS", "KUVO_KEYS_ON_HOST", "KUVO_BOX", "KUVO_ENGINE_CONFIG", "KUVO_VAULT_AGENTS", "KUVO_SANDBOX"]) delete env[name];
const plugin = path.join(home, "config", "opencode", "plugins", "kuvo-sandbox.js");

const shop = path.join(root, "shop");
const blog = path.join(root, "blog");
// Somewhere neither project's commands may write.
const outside = path.join(root, "outside");

// The engine, as far as the box asks it: who a conversation is, its folder, and the tool calls it's
// making now (only a call the conversation is really making is answered).
const sessions = {
  ses_shop: { id: "ses_shop", title: "Fix checkout", location: { directory: shop } },
  ses_shop2: { id: "ses_shop2", title: "Install hooks", location: { directory: shop } },
  ses_blog: { id: "ses_blog", title: "Write a post", location: { directory: blog } },
};
const calling = {};
let calls = 0;
let engine;
before(async () => {
  for (const folder of [shop, blog, outside, path.join(home, "run")]) fs.mkdirSync(folder, { recursive: true });
  if (linux) {
    const bun = process.versions.bun ? process.execPath : spawnSync("sh", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim();
    assert.ok(bun, "the sandbox runs on Bun on Linux: run this with the engine (BUN_BE_BUN=1) or with Bun on the PATH");
    fs.mkdirSync(path.join(home, "engine", "test"), { recursive: true });
    fs.symlinkSync(bun, path.join(home, "engine", "test", "opencode"));
  }
  engine = http.createServer((request, response) => {
    const id = decodeURIComponent((request.url.match(/^\/api\/session\/([^/?]+)/) ?? [])[1] ?? "");
    response.writeHead(sessions[id] ? 200 : 404, { "content-type": "application/json" });
    if (/^\/api\/session\/[^/?]+\/message/.test(request.url)) return response.end(JSON.stringify({ data: [{ type: "assistant", content: calling[id] ?? [] }] }));
    response.end(JSON.stringify(sessions[id] ? { data: sessions[id] } : { message: "No such session." }));
  });
  await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify({ pid: process.pid, port: engine.address().port, password: "engine-pw", version: "test" }));
});
after(() => { engine?.closeAllConnections(); engine?.close(); });

// The box's long-running process.
async function start() {
  const child = spawn(process.execPath, [script, "serve"], { env: { ...env, OPENCODE_PASSWORD: "box-pw" }, stdio: ["pipe", "pipe", "pipe"] });
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
  return { ask, stop };
}

// The Mac over SSH: `box route`, a process of its own on the machine.
async function fromMac(method, route, body) {
  const child = spawn(process.execPath, [script, "box", "route"], { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(JSON.stringify({ method, path: route, body }));
  let out = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) out += chunk;
  const answer = JSON.parse(out.trim().split("\n").at(-1));
  return { status: answer.status, value: JSON.parse(answer.body || "{}") };
}

// The engine running `command` in `folder` for `session`, as its shell tool does: through the shell
// the box's plugin gives it.
async function engineRuns(folder, command, session) {
  const input = { command, cwd: folder, timeout: 0, shell: "/bin/sh", env: { PATH: process.env.PATH, HOME: root } };
  const loaded = (await import(`${pathToFileURL(plugin)}?${Math.random()}`)).default;
  let hook;
  await loaded.setup({ location: { directory: folder }, shell: { hook: async (_, take) => { hook = take; } } });
  hook(input);
  if (session) input.env.OPENCODE_SESSION_ID = session;
  const run = spawnSync(input.shell, ["-c", input.command], { cwd: input.cwd, env: input.env, encoding: "utf8" });
  return { status: run.status, out: run.stdout + run.stderr };
}

// An agent's sandbox_ask, as its tool server passes it on while the conversation makes that call.
function sandboxAsk(box, session, args) {
  calling[session] = [{ type: "tool", id: `call_${++calls}`, name: "kuvo-browser_sandbox_ask", state: { status: "running", input: args } }];
  return box.ask("POST", "kuvo/sandbox/tools", { session, name: "sandbox_ask", arguments: args });
}

// What's asked now, once something is.
async function asked(box) {
  for (let tries = 0; tries < 1000; tries++) {
    const asks = (await box.ask("GET", "kuvo/sandbox/asks")).value.asks ?? [];
    if (asks.length) return asks;
    await new Promise(done => setImmediate(done));
  }
  assert.fail("nothing was asked");
}

let box;
before(async () => {
  box = await start();
  // The engine loads the box's plugin as it first runs a command: the sandbox is on from then.
  await engineRuns(shop, "true", "ses_shop");
  const state = (await box.ask("GET", "kuvo/sandbox")).value;
  assert.equal(state.on, true, state.why);
});
after(() => box?.stop());

// An agent on a machine: its tool server there (`kuvo-browser.js mcp`, as the engine starts it), which
// passes sandbox_ask to the box's long-running process through `box route`.
function machineTools() {
  // (Which runs the box's script where a machine keeps it.)
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.copyFileSync(script, path.join(home, "bin", "kuvo-link.js"));
  const server = spawn(process.execPath, [fileURLToPath(new URL("../../../../KuvoCode/Resources/kuvo-browser.js", import.meta.url)), "mcp"], { env, stdio: ["pipe", "pipe", "ignore"] });
  const answers = new Map();
  let buffer = "";
  let next = 1;
  server.stdout.on("data", chunk => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(end + 1)) {
      const message = JSON.parse(buffer.slice(0, end));
      answers.get(message.id)?.(message.result);
    }
  });
  const ask = (method, params) => new Promise(resolve => {
    const id = next++;
    answers.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return { ask, stop: () => server.kill() };
}

test("an agent on a machine has sandbox_ask while the sandbox is on, and its call asks you there and runs once allowed", async () => {
  assert.deepEqual((await box.ask("GET", "kuvo/sandbox/tools")).value.tools.map(tool => tool.name), ["sandbox_ask"]);
  const tools = machineTools();
  after(() => tools.stop());
  const listed = (await tools.ask("tools/list", {})).tools;
  const tool = listed.find(each => each.name === "sandbox_ask");
  assert.ok(tool, "listed with the browser's tools");
  assert.deepEqual(tool.inputSchema.required, ["command", "why"]);

  const args = { command: "echo from the machine", why: "To see the tool server pass it on." };
  calling.ses_shop2 = [{ type: "tool", id: `call_${++calls}`, name: "kuvo-browser_sandbox_ask", state: { status: "running", input: args } }];
  const called = tools.ask("tools/call", { name: "sandbox_ask", arguments: args, _meta: { "ai.opencode/sessionID": "ses_shop2" } });
  const [open] = await asked(box);
  assert.equal(open.command, "echo from the machine");
  assert.equal((await fromMac("POST", `kuvo/sandbox/asks/${open.id}`, { answer: "once" })).status, 200);
  const result = await called;
  assert.equal(result.isError, false, result.content[0].text);
  assert.match(result.content[0].text, /^Ran outside the sandbox · Allowed once\n\nfrom the machine\n/);
});

test("a command the sandbox stopped runs outside it once you allow it once; the next time it asks again, and Don't Allow runs nothing", async () => {
  const target = path.join(outside, "once.txt");
  const command = `echo shipped >> ${JSON.stringify(target)} && echo wrote it`;
  const inSandbox = await engineRuns(shop, command, "ses_shop");
  assert.notEqual(inSandbox.status, 0, "the sandbox stops it");
  assert.equal(fs.existsSync(target), false);

  const call = sandboxAsk(box, "ses_shop", { command, why: "To record the release outside the project.", error: inSandbox.out.trim() });
  const [ask] = await asked(box);
  assert.equal(ask.command, command);
  assert.equal(ask.why, "To record the release outside the project.");
  assert.equal(ask.sessionName, "Fix checkout");
  assert.equal(ask.session, "ses_shop");
  assert.equal(ask.project, shop);
  if (linux) assert.match(ask.error, /Permission denied|Operation not permitted/);
  // On a Mac, what the sandbox refused, from its own log.
  else {
    assert.deepEqual(ask.stopped?.find(each => each.path === target), { kind: "write", path: target }, JSON.stringify(ask));
    // Always would let the project's commands write that file in the sandbox.
    assert.deepEqual(ask.always, { kind: "write", path: target });
  }
  // The Mac answers it over SSH as a phone would through the relay.
  assert.equal((await fromMac("POST", `kuvo/sandbox/asks/${ask.id}`, { answer: "once" })).status, 200);
  const ran = (await call).value;
  assert.equal(ran.isError, false, ran.text);
  assert.match(ran.text, /^Ran outside the sandbox · Allowed once/);
  assert.match(ran.text, /wrote it/);
  assert.equal(fs.readFileSync(target, "utf8"), "shipped\n");
  assert.deepEqual((await box.ask("GET", "kuvo/sandbox/asks")).value.asks, [], "answered, it's no longer asked");

  // Once is once: the same command asks again, and you say no.
  const again = sandboxAsk(box, "ses_shop", { command, why: "Once more." });
  const [second] = await asked(box);
  assert.equal((await box.ask("POST", `kuvo/sandbox/asks/${second.id}`, { answer: "no" })).status, 200);
  const refused = (await again).value;
  assert.match(refused.text, /The user said no/);
  assert.equal(fs.readFileSync(target, "utf8"), "shipped\n", "nothing ran");
});

test("Always for a command lets it run outside the sandbox in that project without asking, never in another, until you remove it from Also Allowed", async () => {
  fs.mkdirSync(path.join(shop, "tools"), { recursive: true });
  const target = path.join(outside, "hooks.txt");
  fs.writeFileSync(path.join(shop, "tools", "install.sh"), `#!/bin/sh\necho installed >> ${JSON.stringify(target)}\n`, { mode: 0o755 });
  const command = "./tools/install.sh --all";
  const call = sandboxAsk(box, "ses_shop2", { command, why: "The README says to install the hooks.", error: "Permission denied" });
  const [ask] = await asked(box);
  assert.deepEqual(ask.always, { kind: "outside", prefix: "./tools/install.sh" }, "what Always would allow");
  assert.equal((await box.ask("POST", `kuvo/sandbox/asks/${ask.id}`, { answer: "always" })).status, 200);
  assert.match((await call).value.text, /^Ran outside the sandbox · Always for this/);
  assert.equal(fs.readFileSync(target, "utf8"), "installed\n");

  // Kept in Also Allowed for the project.
  const allowed = (await box.ask("GET", `kuvo/sandbox/allowed?project=${encodeURIComponent(shop)}`)).value.allowed;
  assert.deepEqual(allowed.map(({ kind, prefix, project }) => ({ kind, prefix, project })), [{ kind: "outside", prefix: "./tools/install.sh", project: shop }]);
  // The next time, in that project, it runs with no card.
  const quiet = (await sandboxAsk(box, "ses_shop", { command: "./tools/install.sh", why: "Again." })).value;
  assert.match(quiet.text, /^Ran outside the sandbox · Always for this/);
  assert.equal(fs.readFileSync(target, "utf8"), "installed\ninstalled\n");
  // Not a command that only starts like it, chained to another.
  const chained = sandboxAsk(box, "ses_shop", { command: "./tools/install.sh; rm -rf ~", why: "Chained." });
  const [chainedAsk] = await asked(box);
  assert.equal(chainedAsk.always, undefined, "a chained command can't be allowed always");
  await box.ask("POST", `kuvo/sandbox/asks/${chainedAsk.id}`, { answer: "no" });
  await chained;
  // Nor in another project.
  fs.mkdirSync(path.join(blog, "tools"), { recursive: true });
  fs.copyFileSync(path.join(shop, "tools", "install.sh"), path.join(blog, "tools", "install.sh"));
  const elsewhere = sandboxAsk(box, "ses_blog", { command: "./tools/install.sh", why: "Here too." });
  const [blogAsk] = await asked(box);
  assert.equal(blogAsk.project, blog);
  await box.ask("POST", `kuvo/sandbox/asks/${blogAsk.id}`, { answer: "no" });
  await elsewhere;

  // Removed, it asks again.
  assert.equal((await fromMac("DELETE", `kuvo/sandbox/allowed/${allowed[0].id}`)).status, 200);
  const after = sandboxAsk(box, "ses_shop", { command: "./tools/install.sh", why: "After removing." });
  const [afterAsk] = await asked(box);
  await box.ask("POST", `kuvo/sandbox/asks/${afterAsk.id}`, { answer: "no" });
  assert.match((await after).value.text, /The user said no/);
  assert.equal(fs.readFileSync(target, "utf8"), "installed\ninstalled\n");
});

test("a folder in Also Allowed is one a project's commands write in the sandbox, and another project's still can't", async () => {
  const shared = path.join(outside, "cache");
  fs.mkdirSync(shared, { recursive: true });
  const write = `echo hi > ${JSON.stringify(path.join(shared, "made.txt"))}`;
  assert.notEqual((await engineRuns(shop, write, "ses_shop")).status, 0, "stopped before");
  const added = await fromMac("POST", "kuvo/sandbox/allowed", { project: shop, kind: "write", path: shared });
  assert.equal(added.status, 200, JSON.stringify(added.value));
  const ran = await engineRuns(shop, write, "ses_shop");
  assert.equal(ran.status, 0, ran.out);
  assert.equal(fs.readFileSync(path.join(shared, "made.txt"), "utf8"), "hi\n");
  assert.notEqual((await engineRuns(blog, `echo hi > ${JSON.stringify(path.join(shared, "blog.txt"))}`, "ses_blog")).status, 0, "another project's commands can't");
  // A folder of Kuvo Code's own can't be added.
  assert.equal((await fromMac("POST", "kuvo/sandbox/allowed", { project: shop, kind: "write", path: path.join(home, "run") })).status, 400);
  // Nor what runs later, outside the sandbox: SSH's folder, a shell's startup file.
  for (const later of [".ssh", ".zshrc", ".bashrc"]) assert.equal((await fromMac("POST", "kuvo/sandbox/allowed", { project: shop, kind: "write", path: path.join(os.userInfo().homedir, later) })).status, 400, later);
  // Removed, the next command can't write there again.
  const rule = (await fromMac("GET", `kuvo/sandbox/allowed?project=${encodeURIComponent(shop)}`)).value.allowed.find(each => each.kind === "write");
  assert.equal((await fromMac("DELETE", `kuvo/sandbox/allowed/${rule.id}`)).status, 200);
  assert.notEqual((await engineRuns(shop, write.replace("made", "again"), "ses_shop")).status, 0);
});

test("only a conversation's own call asks: one it isn't making, or a command naming it, gets nothing", async () => {
  calling.ses_shop = [];
  const refused = (await box.ask("POST", "kuvo/sandbox/tools", { session: "ses_shop", name: "sandbox_ask", arguments: { command: "id", why: "x" } })).value;
  assert.equal(refused.isError, true);
  assert.deepEqual((await box.ask("GET", "kuvo/sandbox/asks")).value.asks, []);
});

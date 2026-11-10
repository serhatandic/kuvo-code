// When the sandbox stops a command a task needs (PROTOCOL.md, "Sandbox", "Asks"): the agent asks
// with sandbox_ask, you see what it wants to run and why on any client (`kuvo/sandbox/asks`), and
// answer Allow Once (the box runs that one command outside the sandbox and hands back its output),
// Always for This (that, and the folder it was stopped writing in for the project's commands from
// then on, kept in Also Allowed) or Don't Allow. The engine is a
// stand-in, as in sandbox.test.js: it loads the box's real plugin and runs commands through the
// shell it gives; the sandbox itself is the system's own.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/sandbox-asks.test.js`; on a Linux machine, with
// `scripts/test-linux.sh <ssh-host> sandbox-asks.test.js`, and with `--engine` on the engine's own runner,
// which the box runs on there (Bun's: `BUN_BE_BUN=1 <engine> test --timeout 120000 ./sandbox-asks.test.js`,
// as its 5 seconds a test are too few for some).
import { testsFolder } from "./test-safety.js";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { script } from "./bot-keys-scenarios.js";
import { runningAs } from "./running-as.js";
import { NO_BUN, testBun } from "./bun-for-tests.js";
import { atEnd, removeAtEnd } from "./at-end.js";

// In the folder tests keep in your home (not the temporary folders, which commands may write), so
// what a command mustn't write is somewhere it otherwise couldn't. (Short: the vault's socket,
// which the box's long-running process holds, lives in it.)
const root = fs.realpathSync(testsFolder("sa"));
removeAtEnd(root);
const linux = process.platform === "linux";
const home = path.join(root, ".kuvo-code");
const env = { ...process.env, HOME: root, KUVO_HOME: home };
for (const name of ["KUVO_HOST_URL", "KUVO_HOST_PASSWORD", "KUVO_KEYS", "KUVO_KEYS_ON_HOST", "KUVO_BOX", "KUVO_ENGINE_CONFIG", "KUVO_VAULT_AGENTS", "KUVO_SANDBOX"]) delete env[name];
const plugin = path.join(home, "config", "opencode", "plugins", "kuvo-sandbox.js");

const shop = path.join(root, "shop");
const blog = path.join(root, "blog");
// Somewhere neither project's commands may delete or move a file (in your home, they add and change
// files, but only their own project's are theirs to delete).
const outside = path.join(root, "outside");

// The engine, as far as the box asks it: who a conversation is, its folder, its rules (Ask First:
// one that asks nothing is in Full Access, whose commands never ask), and the tool calls it's
// making now (only a call the conversation is really making is answered).
const ASK_FIRST = [{ action: "shell", resource: "*", effect: "ask" }];
const sessions = {
  ses_shop: { id: "ses_shop", title: "Fix checkout", location: { directory: shop }, permissions: ASK_FIRST },
  ses_shop2: { id: "ses_shop2", title: "Install hooks", location: { directory: shop }, permissions: ASK_FIRST },
  ses_blog: { id: "ses_blog", title: "Write a post", location: { directory: blog }, permissions: ASK_FIRST },
  // A worktree of the repository `kept`, for a branch of its own.
  ses_branch: { id: "ses_branch", title: "Try a branch", location: { directory: path.join(root, "kept-branch") }, permissions: ASK_FIRST },
  // A bot's own conversation, in its folder's workspace (set to Ask First: in Auto, nothing comes to
  // you), and a chat, in the chats' folder.
  ses_scout: { id: "ses_scout", title: "Scout", location: { directory: path.join(home, "bots", "bot_scout", "workspace") }, permissions: ASK_FIRST },
  ses_chat: { id: "ses_chat", title: "Quick question", location: { directory: path.join(home, "chats") }, permissions: ASK_FIRST },
  // A bot's seat in a group chat.
  ses_seat: { id: "ses_seat", title: "Standup", location: { directory: shop }, metadata: { kuvo: { seat: "seat_1" } } },
  // Conversations in Auto, whose reviewer decides what goes beyond the sandbox, never you.
  ses_auto: { id: "ses_auto", title: "Check my SSH", location: { directory: blog }, model: { providerID: "anthropic", id: "claude-sonnet-5" }, permissions: [], metadata: { kuvo: { approval: "auto", applied: "auto" } }, time: { created: Date.now(), updated: Date.now() } },
};
// What you wrote in each conversation, and what Auto's reviewer (the small model) answers next.
const said = { ses_auto: ["Read my SSH key ~/.ssh/id_ed25519 and tell me what kind of key it is."] };
const reviews = [];
let verdict = { decision: "allow", reason: "Reading the key is what the user asked." };
const calling = {};
let calls = 0;
let engine;
before(async () => {
  for (const folder of [shop, blog, outside, path.join(home, "run"), path.join(root, ".ssh")]) fs.mkdirSync(folder, { recursive: true });
  // (Your SSH key, which commands in the sandbox can't read.)
  fs.writeFileSync(path.join(root, ".ssh", "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n", { mode: 0o600 });
  if (linux) {
    const bun = testBun();
    assert.ok(bun, NO_BUN);
    fs.mkdirSync(path.join(home, "engine", "test"), { recursive: true });
    fs.symlinkSync(bun, path.join(home, "engine", "test", "opencode"));
  }
  engine = http.createServer((request, response) => {
    const id = decodeURIComponent((request.url.match(/^\/api\/session\/([^/?]+)/) ?? [])[1] ?? "");
    const json = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (request.url === "/api/provider") return json({ data: [{ id: "anthropic" }] });
    if (request.url === "/api/model") return json({ data: [{ id: "claude-sonnet-5", providerID: "anthropic", name: "Claude Sonnet 5" }, { id: "claude-haiku-5-5", providerID: "anthropic", name: "Claude Haiku 5.5" }] });
    if (request.url === "/api/experimental/generate") {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => { reviews.push(JSON.parse(body).prompt); json({ data: { text: JSON.stringify(verdict) } }); });
      return;
    }
    response.writeHead(sessions[id] ? 200 : 404, { "content-type": "application/json" });
    if (/^\/api\/session\/[^/?]+\/message/.test(request.url)) return response.end(JSON.stringify({ data: [{ type: "assistant", content: calling[id] ?? [] }, ...(said[id] ?? []).map(text => ({ type: "user", text }))] }));
    response.end(JSON.stringify(sessions[id] ? { data: sessions[id] } : { message: "No such session." }));
  });
  await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify({ pid: process.pid, port: engine.address().port, password: "engine-pw", version: "test" }));
});
atEnd(() => { engine?.closeAllConnections(); engine?.close(); });

// The box's long-running process.
async function start() {
  // (Its folders in Kuvo Code's, as a machine's launch points them: npm's cache had none before.)
  const child = spawn(process.execPath, [script, "serve"], { env: { ...env, OPENCODE_PASSWORD: "box-pw", npm_config_cache: path.join(home, "npm"), KUVO_OWN_npm_config_cache: "" }, stdio: ["pipe", "pipe", "pipe"] });
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
  const headers = { authorization: `Basic ${Buffer.from("opencode:box-pw").toString("base64")}`, "content-type": "application/json" };
  // (A request that fails says which, and what the box said last: why is in there, if anywhere.)
  const failed = (what, error) => new Error(`${what} failed (${error.cause?.code ?? error.message}). The box said last:\n${err.slice(-2000)}`, { cause: error });
  const ask = async (method, route, body) => {
    const response = await fetch(`${url}/${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined }).catch(error => { throw failed(`${method} ${route}`, error); });
    return { status: response.status, value: await response.json().catch(() => ({})) };
  };
  const stop = async () => { child.stdin.end(); child.kill("SIGTERM"); await exited; };
  return { ask, stop, url, headers, failed };
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
  // (The plugin names the engine's runtime, its own: here that's this test's, so on Linux, without
  // Bun, the Bun this box's engine is.)
  if (linux && !process.versions.bun) input.env.KUVO_FENCE_RUNTIME = path.join(home, "engine", "test", "opencode");
  if (session) input.env.OPENCODE_SESSION_ID = session;
  const run = spawnSync(input.shell, ["-c", input.command], { cwd: input.cwd, env: input.env, encoding: "utf8" });
  return { status: run.status, out: run.stdout + run.stderr };
}

// The engine's shell tool running `command` for `session`, as an agent calls it: through the shell
// the box's plugin gives it, and then the plugin's look at what it printed, while the call is
// still running in the conversation. What the agent gets back.
// (`stopOnce`: a file whose being there means the agent's call is stopped then, as Stop does.)
async function agentRuns(folder, command, session, stopOnce) {
  const input = { command, description: "Runs it" };
  const loaded = (await import(`${pathToFileURL(plugin)}?${Math.random()}`)).default;
  const hooks = {};
  await loaded.setup({ location: { directory: folder }, shell: { hook: async (name, take) => { hooks[name] = take; } }, tool: { hook: async (name, take) => { hooks[name] = take; } } });
  const shell = { command, cwd: folder, timeout: 0, shell: "/bin/sh", env: { PATH: process.env.PATH, HOME: root } };
  hooks["create.before"](shell);
  if (linux && !process.versions.bun) shell.env.KUVO_FENCE_RUNTIME = path.join(home, "engine", "test", "opencode");
  shell.env.OPENCODE_SESSION_ID = session;
  const run = spawnSync(shell.shell, ["-c", shell.command], { cwd: shell.cwd, env: shell.env, encoding: "utf8" });
  calling[session] = [{ type: "tool", id: `call_${++calls}`, name: "shell", state: { status: "running", input } }];
  // (As engine 2.2.0's shell tool answers: what it printed, and how it ended.)
  const printed = run.stdout + run.stderr;
  const call = { tool: "shell", sessionID: session, agent: "build", messageID: "msg_1", id: `call_${calls}`, input, status: "completed",
    result: { output: { exit: run.status, truncated: false, output: printed, status: "completed" },
      content: [{ type: "text", text: printed }, ...(run.status ? [{ type: "text", text: `Exited with code ${run.status}` }] : [])],
      metadata: { status: "completed", truncated: false, exit: run.status } } };
  const stopping = stopOnce && setInterval(() => { if (fs.existsSync(stopOnce)) delete calling[session]; }, 50);
  try { await hooks["execute.after"]?.(call); } finally { delete calling[session]; clearInterval(stopping); }
  assert.equal(call.result.output.exit, call.result.metadata.exit);
  const texts = call.result.content.filter(part => part.type === "text").map(part => part.text);
  return { text: texts[0], refusal: texts.at(-1), exit: call.result.metadata.exit, sandboxExit: run.status, inSandbox: printed };
}

// An agent's sandbox_ask, as its tool server passes it on while the conversation makes that call.
function sandboxAsk(box, session, args) {
  calling[session] = [{ type: "tool", id: `call_${++calls}`, name: "kuvo-browser_sandbox_ask", state: { status: "running", input: args } }];
  return box.ask("POST", "kuvo/sandbox/tools", { session, name: "sandbox_ask", arguments: args });
}

// What's asked now, once something is: from the asks' stream, which says what's asked each time it
// changes. (`call`: the call that should ask, which mustn't answer first.) `stopped`: its command,
// once its ask says what the sandbox stopped, which on a Mac macOS's log has a while after (on a
// busy Mac, seconds); that ask first.
async function asked(box, call, stopped) {
  const stop = new AbortController();
  let done = false;
  const first = (what) => { if (!done) assert.fail(`answered without asking: ${what}`); };
  const answered = call.then(result => first(JSON.stringify(result.value ?? result)), error => first(String(error)));
  try {
    const its = asks => asks.filter(each => each.command === stopped);
    const asks = await Promise.race([answered, streamed(box, stop.signal, asks => !stopped || its(asks).some(each => linux || each.stopped?.length))]);
    return stopped ? [...its(asks), ...asks.filter(each => each.command !== stopped)] : asks;
  } finally {
    done = true;
    stop.abort();
  }
}
async function streamed(box, signal, ready = () => true) {
  const response = await fetch(`${box.url}/kuvo/sandbox/asks/events`, { headers: box.headers, signal }).catch(error => { throw signal.aborted || !box.failed ? error : box.failed("Following the asks", error); });
  let buffered = "";
  try {
    for await (const chunk of response.body) {
      buffered += Buffer.from(chunk).toString("utf8");
      let at;
      while ((at = buffered.indexOf("\n")) >= 0) {
        const { asks } = JSON.parse(buffered.slice(0, at));
        buffered = buffered.slice(at + 1);
        if (asks.length && ready(asks)) return asks;
      }
    }
  } catch (error) {
    if (!signal.aborted) throw box.failed ? box.failed("Following the asks", error) : error;
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
atEnd(() => box?.stop());

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
  atEnd(() => tools.stop());
  const listed = (await tools.ask("tools/list", {})).tools;
  const tool = listed.find(each => each.name === "sandbox_ask");
  assert.ok(tool, "listed with the browser's tools");
  assert.deepEqual(tool.inputSchema.required, ["command", "why"]);

  // (It runs as you would: with your own folders, never Kuvo Code's, which a machine's box has.)
  const args = { command: "echo from the machine; printf '%s|%s\\n' \"${npm_config_cache-unset}\" \"${KUVO_HOME-unset}\"", why: "To see the tool server pass it on." };
  calling.ses_shop2 = [{ type: "tool", id: `call_${++calls}`, name: "kuvo-browser_sandbox_ask", state: { status: "running", input: args } }];
  const called = tools.ask("tools/call", { name: "sandbox_ask", arguments: args, _meta: { "ai.opencode/sessionID": "ses_shop2" } });
  const [open] = await asked(box, called);
  assert.equal(open.command, args.command);
  assert.equal((await fromMac("POST", `kuvo/sandbox/asks/${open.id}`, { answer: "once" })).status, 200);
  const result = await called;
  assert.equal(result.isError, false, result.content[0].text);
  assert.match(result.content[0].text, /^Ran outside the sandbox · Allowed once\n\nfrom the machine\nunset\|unset\n/);
});

test("a command the sandbox stopped runs outside it once you allow it once; the next time it asks again, and Don't Allow runs nothing", async () => {
  const target = path.join(outside, "once.txt");
  fs.writeFileSync(target, "old release\n");
  const command = `rm ${JSON.stringify(target)} && echo cleared it`;
  const inSandbox = await engineRuns(shop, command, "ses_shop");
  assert.notEqual(inSandbox.status, 0, "the sandbox stops it");
  assert.equal(fs.existsSync(target), true);

  const call = sandboxAsk(box, "ses_shop", { command, why: "To clear the old release outside the project.", error: inSandbox.out.trim() });
  const [ask] = await asked(box, call, command);
  assert.equal(ask.command, command);
  assert.equal(ask.why, "To clear the old release outside the project.");
  assert.equal(ask.sessionName, "Fix checkout");
  assert.equal(ask.session, "ses_shop");
  assert.equal(ask.project, shop);
  if (linux) assert.match(ask.error, /Permission denied|Operation not permitted/);
  // On a Mac, what the sandbox refused, from its own log.
  else {
    assert.deepEqual(ask.stopped?.find(each => each.path === target), { kind: "write", path: target }, JSON.stringify(ask));
    // Always would let the project's commands write in the folder it was stopped writing in.
    assert.deepEqual(ask.always, { kind: "write", path: path.dirname(target) });
  }
  // The Mac answers it over SSH as a phone would through the relay.
  assert.equal((await fromMac("POST", `kuvo/sandbox/asks/${ask.id}`, { answer: "once" })).status, 200);
  const ran = (await call).value;
  assert.equal(ran.isError, false, ran.text);
  assert.match(ran.text, /^Ran outside the sandbox · Allowed once/);
  assert.match(ran.text, /cleared it/);
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual((await box.ask("GET", "kuvo/sandbox/asks")).value.asks, [], "answered, it's no longer asked");

  // Once is once: the same command asks again, and you say no.
  fs.writeFileSync(target, "next release\n");
  const again = sandboxAsk(box, "ses_shop", { command, why: "Once more." });
  const [second] = await asked(box, again);
  assert.equal((await box.ask("POST", `kuvo/sandbox/asks/${second.id}`, { answer: "no" })).status, 200);
  const refused = (await again).value;
  assert.match(refused.text, /The user said no/);
  assert.equal(fs.readFileSync(target, "utf8"), "next release\n", "nothing ran");
});

test("in Auto, a command the sandbox stopped goes to Auto's reviewer by itself: allowed, it runs outside the sandbox and the agent gets its output; refused, the agent hears why; nobody's asked", async () => {
  // The user's case: asked to read their SSH key, the agent cats it, and the sandbox stops it.
  const command = `cat ${JSON.stringify(path.join(root, ".ssh", "id_ed25519"))}`;
  const first = reviews.length;
  const ran = await agentRuns(blog, command, "ses_auto");
  assert.match(ran.inSandbox, /Operation not permitted|Permission denied/, "the sandbox stops it");
  assert.equal(reviews.length, first + 1, "Auto's reviewer judged it");
  assert.match(reviews.at(-1), /Read my SSH key/);
  assert.match(reviews.at(-1), /cat .*\.ssh\/id_ed25519/);
  // It sees what the sandbox let it print, and that it would run again from the start.
  assert.match(reviews.at(-1), /It already ran in the sandbox/);
  assert.match(reviews.at(-1), /<printed_[0-9a-f]+>\n[^\n]*(Operation not permitted|Permission denied)/);
  assert.match(ran.text, /BEGIN OPENSSH PRIVATE KEY/, ran.text);
  assert.match(ran.text, /^The sandbox stopped it · Ran again outside the sandbox · Allowed by Auto's reviewer: Reading the key is what the user asked\./);
  assert.equal(ran.exit, 0);
  assert.deepEqual((await box.ask("GET", "kuvo/sandbox/asks")).value.asks, [], "nobody's asked");

  // Refused: what the sandbox printed stays, with why, and nothing ran outside it.
  verdict = { decision: "refuse", reason: "Deleting files in another project wasn't asked for." };
  const target = path.join(outside, "auto.txt");
  fs.writeFileSync(target, "keep me\n");
  const refused = await agentRuns(blog, `rm ${JSON.stringify(target)}`, "ses_auto");
  assert.match(refused.text, /Operation not permitted|Permission denied/);
  assert.match(refused.refusal, /Auto's reviewer (held this back|refused): Deleting files in another project wasn't asked for\./);
  assert.equal(refused.exit, refused.sandboxExit, "it ended as it did");
  assert.equal(fs.readFileSync(target, "utf8"), "keep me\n");
  verdict = { decision: "allow", reason: "Reading the key is what the user asked." };

  // Stopped while it runs outside (the user pressed Stop): it's stopped there too.
  const started = path.join(blog, "started.txt"), finished = path.join(blog, "finished.txt");
  const stopped = await agentRuns(blog, `${command} >/dev/null && touch started.txt && sleep 30 && touch finished.txt`, "ses_auto", started);
  assert.equal(fs.existsSync(started), true, stopped.text);
  assert.equal(fs.existsSync(finished), false);
  assert.notEqual(stopped.exit, 0);

  // A command that failed on its own isn't reviewed, and one in Ask First is left for sandbox_ask.
  const before = reviews.length;
  const failed = await agentRuns(blog, "echo nothing here >&2; exit 3", "ses_auto");
  assert.deepEqual([failed.text, failed.exit], ["nothing here\n", 3]);
  // On a Mac, a refusal that isn't the sandbox's (a database's) isn't either: its sandbox answers
  // "Operation not permitted".
  if (!linux) {
    const database = await agentRuns(blog, "echo 'ERROR: permission denied for table users' >&2; exit 1", "ses_auto");
    assert.equal(database.exit, 1);
    assert.doesNotMatch(database.text, /Ran again outside/);
  }
  const asking = await agentRuns(shop, command, "ses_shop");
  assert.match(asking.text, /Operation not permitted|Permission denied/);
  assert.doesNotMatch(asking.text, /Ran outside/);
  assert.equal(reviews.length, before, "neither was reviewed");
});

test("a command is never let out of the sandbox for good: Always is only the folder it was stopped writing in, and a script it runs asks again each time", async () => {
  // A script in the project, which the sandbox writes: what it runs is the agent's to change.
  fs.mkdirSync(path.join(shop, "tools"), { recursive: true });
  const target = path.join(outside, "hooks.txt");
  fs.writeFileSync(path.join(shop, "tools", "install.sh"), `#!/bin/sh\necho installed >> ${JSON.stringify(target)}\n`, { mode: 0o755 });
  const command = "./tools/install.sh --all";
  const call = sandboxAsk(box, "ses_shop2", { command, why: "The README says to install the hooks.", error: "Permission denied" });
  const [ask] = await asked(box, call);
  assert.equal(ask.always, undefined, "a command can only be allowed once");
  // Answered Always anyway (an older client), it's once.
  assert.equal((await box.ask("POST", `kuvo/sandbox/asks/${ask.id}`, { answer: "always" })).status, 200);
  assert.match((await call).value.text, /^Ran outside the sandbox · Allowed once/);
  assert.equal(fs.readFileSync(target, "utf8"), "installed\n");
  assert.deepEqual((await box.ask("GET", `kuvo/sandbox/allowed?project=${encodeURIComponent(shop)}`)).value.allowed, []);
  // The agent changes the script: the same command asks again, and nothing runs on a no.
  fs.writeFileSync(path.join(shop, "tools", "install.sh"), `#!/bin/sh\necho changed >> ${JSON.stringify(target)}\n`, { mode: 0o755 });
  const again = sandboxAsk(box, "ses_shop", { command: "./tools/install.sh", why: "Again." });
  const [second] = await asked(box, again);
  await box.ask("POST", `kuvo/sandbox/asks/${second.id}`, { answer: "no" });
  assert.match((await again).value.text, /The user said no/);
  assert.equal(fs.readFileSync(target, "utf8"), "installed\n");
  // Nor can a client add a command to Also Allowed.
  assert.equal((await fromMac("POST", "kuvo/sandbox/allowed", { project: shop, kind: "outside", prefix: "./tools/install.sh" })).status, 400);

  // On a Mac, where its log says which folder the sandbox stopped a command writing in, Always lets
  // the project's commands write there from then on, in the sandbox.
  if (linux) return;
  const logs = path.join(outside, "logs");
  fs.mkdirSync(logs);
  const old = path.join(logs, "old.log");
  fs.writeFileSync(old, "line\n");
  const write = `rm ${JSON.stringify(old)}`;
  assert.notEqual((await engineRuns(shop, write, "ses_shop2")).status, 0, "the sandbox stops it");
  const wrote = sandboxAsk(box, "ses_shop2", { command: write, why: "To clear the build's old log." });
  const [writeAsk] = await asked(box, wrote, write);
  assert.deepEqual(writeAsk.always, { kind: "write", path: logs });
  assert.equal((await box.ask("POST", `kuvo/sandbox/asks/${writeAsk.id}`, { answer: "always" })).status, 200);
  assert.match((await wrote).value.text, /^Ran outside the sandbox · Always for this: from now on your commands can write in /);
  const rules = (await box.ask("GET", `kuvo/sandbox/allowed?project=${encodeURIComponent(shop)}`)).value.allowed;
  assert.deepEqual(rules.map(({ kind, path: where }) => ({ kind, path: where })), [{ kind: "write", path: logs }]);
  assert.equal(fs.existsSync(old), false);
  fs.writeFileSync(old, "line\n");
  const ran = await engineRuns(shop, write, "ses_shop2");
  assert.equal(ran.status, 0, ran.out);
  assert.equal(fs.existsSync(old), false);
  // And another file there, as the next build clears it.
  const other = await engineRuns(shop, `echo next > ${JSON.stringify(path.join(logs, "next.log"))} && rm ${JSON.stringify(path.join(logs, "next.log"))}`, "ses_shop2");
  assert.equal(other.status, 0, other.out);
  assert.equal((await fromMac("DELETE", `kuvo/sandbox/allowed/${rules[0].id}`)).status, 200);
  // A file in its own project it was stopped writing (the settings an agent starts with): Always
  // there would give nothing, so it's once.
  const settings = `echo '{}' > ${JSON.stringify(path.join(shop, ".mcp.json"))}`;
  assert.notEqual((await engineRuns(shop, settings, "ses_shop2")).status, 0, "the sandbox stops it");
  const set = sandboxAsk(box, "ses_shop2", { command: settings, why: "To add a server." });
  const [setAsk] = await asked(box, set, settings);
  assert.deepEqual(setAsk.stopped, [{ kind: "write", path: path.join(shop, ".mcp.json") }]);
  assert.equal(setAsk.always, undefined);
  await box.ask("POST", `kuvo/sandbox/asks/${setAsk.id}`, { answer: "no" });
  await set;
});

test("a folder in Also Allowed is one a project's commands write in the sandbox, and another project's still can't", async () => {
  const shared = path.join(outside, "cache");
  fs.mkdirSync(shared, { recursive: true });
  for (const name of ["made.txt", "blog.txt", "again.txt"]) fs.writeFileSync(path.join(shared, name), "hi\n");
  const write = `rm ${JSON.stringify(path.join(shared, "made.txt"))}`;
  assert.notEqual((await engineRuns(shop, write, "ses_shop")).status, 0, "stopped before");
  const added = await fromMac("POST", "kuvo/sandbox/allowed", { project: shop, kind: "write", path: shared });
  assert.equal(added.status, 200, JSON.stringify(added.value));
  const ran = await engineRuns(shop, write, "ses_shop");
  assert.equal(ran.status, 0, ran.out);
  assert.equal(fs.existsSync(path.join(shared, "made.txt")), false);
  assert.notEqual((await engineRuns(blog, `rm ${JSON.stringify(path.join(shared, "blog.txt"))}`, "ses_blog")).status, 0, "another project's commands can't");
  // A folder of Kuvo Code's own can't be added.
  assert.equal((await fromMac("POST", "kuvo/sandbox/allowed", { project: shop, kind: "write", path: path.join(home, "run") })).status, 400);
  // Nor what runs later, outside the sandbox: your home folder's settings (SSH's, a shell's startup
  // file, any hidden folder, Library), its programs, the system's, programs on the PATH, a
  // repository's own folder.
  const refused = [".ssh", ".zshrc", ".bashrc", ".nvm/versions", ".vscode/extensions", "Library/LaunchAgents", "bin"].map(later => path.join(os.userInfo().homedir, later));
  refused.push("/usr/local", "/opt/homebrew/lib/node_modules", path.dirname(process.execPath), path.join(shop, ".git", "hooks"));
  for (const later of refused) assert.equal((await fromMac("POST", "kuvo/sandbox/allowed", { project: shop, kind: "write", path: later })).status, 400, later);
  // Inside a folder given, what runs later stays as it is in a project: git's hooks and config, the
  // agents' and the engine's settings.
  const repo = path.join(outside, "backend");
  fs.mkdirSync(path.join(repo, ".git", "hooks"), { recursive: true });
  assert.equal((await fromMac("POST", "kuvo/sandbox/allowed", { project: shop, kind: "write", path: repo })).status, 200);
  assert.equal((await engineRuns(shop, `echo ok > ${JSON.stringify(path.join(repo, "notes.txt"))}`, "ses_shop")).status, 0, "it writes in it");
  if (!linux) {
    for (const guarded of [".git/hooks/pre-commit", ".git/config", ".claude/settings.json", "opencode.json", ".mcp.json"]) {
      assert.notEqual((await engineRuns(shop, `mkdir -p ${JSON.stringify(path.dirname(path.join(repo, guarded)))} 2>/dev/null; echo x > ${JSON.stringify(path.join(repo, guarded))}`, "ses_shop")).status, 0, guarded);
    }
  }
  // A folder given that's become a link since (to anywhere: here, your home folder) isn't given.
  fs.rmSync(repo, { recursive: true });
  fs.symlinkSync(blog, repo);
  fs.writeFileSync(path.join(blog, "through.txt"), "kept\n");
  assert.notEqual((await engineRuns(shop, `rm ${JSON.stringify(path.join(repo, "through.txt"))}`, "ses_shop")).status, 0, "not through a link");
  assert.equal(fs.existsSync(path.join(blog, "through.txt")), true);
  fs.rmSync(path.join(blog, "through.txt"));
  fs.unlinkSync(repo);
  for (const rule of (await fromMac("GET", `kuvo/sandbox/allowed?project=${encodeURIComponent(shop)}`)).value.allowed.filter(each => each.path === repo)) await fromMac("DELETE", `kuvo/sandbox/allowed/${rule.id}`);
  // Removed, the next command can't write there again.
  const rule = (await fromMac("GET", `kuvo/sandbox/allowed?project=${encodeURIComponent(shop)}`)).value.allowed.find(each => each.kind === "write");
  assert.equal((await fromMac("DELETE", `kuvo/sandbox/allowed/${rule.id}`)).status, 200);
  assert.notEqual((await engineRuns(shop, write.replace("made", "again"), "ses_shop")).status, 0);
});

test("a project's worktree writes in the folders Also Allowed gives the project, and Always there gives them to the project", async () => {
  // A repository, with a worktree for a branch, as Kuvo Code makes one for a session.
  const kept = path.join(root, "kept");
  const branch = path.join(root, "kept-branch");
  const git = (...args) => assert.equal(spawnSync("git", args, { cwd: kept, env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null" } }).status, 0, args.join(" "));
  fs.mkdirSync(kept);
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first");
  git("worktree", "add", "-q", "-b", "try", branch);
  const shared = path.join(outside, "kept-cache");
  fs.mkdirSync(shared);
  for (const name of ["before.txt", "made.txt", "always.txt", "again.txt", "main.txt"]) fs.writeFileSync(path.join(shared, name), "hi\n");
  const write = (name) => `rm ${JSON.stringify(path.join(shared, name))}`;
  assert.notEqual((await engineRuns(branch, write("before.txt"), "ses_branch")).status, 0, "stopped before");
  // Added in Settings, for the project.
  const added = await fromMac("POST", "kuvo/sandbox/allowed", { project: kept, kind: "write", path: shared });
  assert.equal(added.status, 200, JSON.stringify(added.value));
  const ran = await engineRuns(branch, write("made.txt"), "ses_branch");
  assert.equal(ran.status, 0, ran.out);
  for (const rule of added.value.allowed) assert.equal((await fromMac("DELETE", `kuvo/sandbox/allowed/${rule.id}`)).status, 200);

  // On a Mac, where its log says which folder the sandbox stopped a command writing in: Always from
  // the worktree's conversation keeps it for the project, where Settings shows it.
  if (linux) return;
  const command = write("always.txt");
  assert.notEqual((await engineRuns(branch, command, "ses_branch")).status, 0, "stopped again");
  const call = sandboxAsk(box, "ses_branch", { command, why: "To clear the shared cache." });
  const [ask] = await asked(box, call, command);
  assert.deepEqual(ask.always, { kind: "write", path: shared });
  assert.equal((await box.ask("POST", `kuvo/sandbox/asks/${ask.id}`, { answer: "always" })).status, 200);
  assert.match((await call).value.text, /^Ran outside the sandbox · Always for this/);
  const rules = (await box.ask("GET", `kuvo/sandbox/allowed?project=${encodeURIComponent(kept)}`)).value.allowed;
  assert.deepEqual(rules.map(rule => rule.path), [shared], "listed for the project");
  assert.equal((await engineRuns(branch, write("again.txt"), "ses_branch")).status, 0);
  assert.equal((await engineRuns(kept, write("main.txt"), "ses_branch")).status, 0, "and the project's own commands");
  for (const rule of rules) await fromMac("DELETE", `kuvo/sandbox/allowed/${rule.id}`);
});

test("a group chat's seat runs no commands, so it can't have one run outside the sandbox: nobody's asked, and it hears why", async () => {
  const args = { command: "./tools/lint.sh", why: "To check the post before the standup." };
  const answer = (await sandboxAsk(box, "ses_seat", args)).value;
  assert.equal(answer.isError, true);
  assert.match(answer.text, /^In a group chat you don't run commands/);
  assert.deepEqual((await box.ask("GET", "kuvo/sandbox/asks")).value.asks, [], "nobody's asked");
});

// The box's one ask to restart the agents started before the sandbox was on comes with the asks a
// client follows, so the card shows in that computer's conversations as it's asked, and goes once
// it's answered (here, from another of the box's processes, as the Mac's over SSH would).
test("the asks you follow carry the box's ask to restart the agents that started before the sandbox, until it's answered", async t => {
  const on = fs.readFileSync(path.join(home, "run", "fence", "on"), "utf8").trim();
  const pid = await runningAs("kuvo-agents", t);
  // No bridge running yet, as while one starts, settles nothing: it asks once one says some are outside.
  assert.equal((await box.ask("GET", "kuvo/sandbox")).value.restart, undefined);
  assert.equal(fs.existsSync(path.join(home, "run", "fence", "restart-asked")), false);
  fs.writeFileSync(path.join(home, "run", "bridge.json"), JSON.stringify({ port: 1, password: "b", pid }));
  t.after(() => fs.rmSync(path.join(home, "run", "bridge.json"), { force: true }));
  const stop = new AbortController();
  t.after(() => stop.abort());
  const lines = followed(box, stop.signal);
  const first = (await lines.next()).value;
  assert.equal(first.restart, undefined);
  // (With how Auto's reviewer takes up asks to work outside a folder: a list a client can rely on.)
  assert.ok(Array.isArray(first.reviews), JSON.stringify(first));
  fs.writeFileSync(path.join(home, "run", "fence", "agents"), JSON.stringify({ pid, on, outside: true }));
  assert.equal((await lines.next()).value.restart, true);
  assert.equal((await fromMac("POST", "kuvo/sandbox/restart", { restart: false })).status, 200);
  assert.equal((await lines.next()).value.restart, undefined);
  assert.equal((await box.ask("GET", "kuvo/sandbox/asks")).value.restart, undefined);
});

// Each line of the asks' stream, as it comes.
async function* followed(box, signal) {
  const response = await fetch(`${box.url}/kuvo/sandbox/asks/events`, { headers: box.headers, signal }).catch(error => { throw signal.aborted || !box.failed ? error : box.failed("Following the asks", error); });
  let buffered = "";
  try {
    for await (const chunk of response.body) {
      buffered += Buffer.from(chunk).toString("utf8");
      for (let at; (at = buffered.indexOf("\n")) >= 0; buffered = buffered.slice(at + 1)) yield JSON.parse(buffered.slice(0, at));
    }
  } catch (error) {
    if (!signal.aborted) throw box.failed ? box.failed("Following the asks", error) : error;
  }
}

test("only a conversation's own call asks: one it isn't making, or a command naming it, gets nothing", async () => {
  calling.ses_shop = [];
  const refused = (await box.ask("POST", "kuvo/sandbox/tools", { session: "ses_shop", name: "sandbox_ask", arguments: { command: "id", why: "x" } })).value;
  assert.equal(refused.isError, true);
  assert.deepEqual((await box.ask("GET", "kuvo/sandbox/asks")).value.asks, []);
});

// A bot here, as the app writes it: `project`, the project it works in rather than its own folder.
function botHere(id, name, session, project) {
  const folder = path.join(home, "bots", id);
  fs.mkdirSync(path.join(folder, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(folder, "bot.json"), JSON.stringify({ kuvo: 1, id, name, ...(project ? { project } : {}) }));
  fs.writeFileSync(path.join(folder, "session"), session);
}

test("Also Allowed lists every rule by whose it is (a project, a bot's own folder, the chats), and whom else one can be added for", async () => {
  botHere("bot_scout", "Scout", "ses_scout");
  botHere("bot_nova", "Nova", "ses_nova", shop);
  botHere("bot_juno", "Juno", "ses_juno");
  // (No chat yet: the chats' folder isn't there.)
  fs.rmSync(path.join(home, "chats"), { recursive: true, force: true });
  const reports = path.join(outside, "reports"), exports = path.join(outside, "exports"), dist = path.join(outside, "dist");
  for (const folder of [reports, exports, dist]) fs.mkdirSync(folder, { recursive: true });
  assert.equal((await box.ask("POST", "kuvo/sandbox/allowed", { project: shop, kind: "write", path: dist })).status, 200);
  const forScout = await box.ask("POST", "kuvo/sandbox/allowed?all", { owner: { kind: "bot", id: "bot_scout" }, kind: "write", path: reports });
  assert.equal(forScout.status, 200, JSON.stringify(forScout.value));
  const forChats = await box.ask("POST", "kuvo/sandbox/allowed?all", { owner: { kind: "chats" }, kind: "write", path: exports });
  assert.equal(forChats.status, 200, JSON.stringify(forChats.value));
  // Made for it, so the rule is kept where the folder really is, and isn't shown gone.
  assert.ok(fs.existsSync(path.join(home, "chats")));
  assert.equal(forChats.value.allowed.at(-1).project, fs.realpathSync(path.join(home, "chats")));
  // A bot that works in a project has no folder of its own to give: its project's rules are its.
  const forNova = await box.ask("POST", "kuvo/sandbox/allowed", { owner: { kind: "bot", id: "bot_nova" }, kind: "write", path: reports });
  assert.equal(forNova.status, 400);
  assert.match(forNova.value.message, /Nova works in a project/);

  // One request lists them all, each saying whose it is, as an add or a removal with `?all` answers.
  const all = (await box.ask("GET", "kuvo/sandbox/allowed")).value;
  const whose = all.allowed.map(rule => [rule.owner.kind, rule.owner.name, rule.path]);
  assert.deepEqual(whose, [["project", "shop", dist], ["bot", "Scout", reports], ["chats", "Chats", exports]]);
  assert.equal(all.allowed[1].owner.id, "bot_scout");
  assert.deepEqual(forChats.value.allowed.map(rule => rule.path), [dist, reports, exports]);
  assert.deepEqual(all.owners, [{ kind: "bot", id: "bot_juno", name: "Juno" }, { kind: "bot", id: "bot_scout", name: "Scout" }, { kind: "chats", name: "Chats" }], "Nova works in a project");
  assert.ok(all.allowed.every(rule => !rule.gone));

  // A project's own still answers as before.
  assert.deepEqual((await box.ask("GET", `kuvo/sandbox/allowed?project=${encodeURIComponent(shop)}`)).value.allowed.map(rule => rule.path), [dist]);
  const removed = await box.ask("DELETE", `kuvo/sandbox/allowed/${all.allowed[0].id}?all`);
  assert.deepEqual(removed.value.allowed.map(rule => rule.owner.kind), ["bot", "chats"]);

  // An ask from the bot's own conversation, and from a chat, says whose folder Always would give to.
  const fromScout = sandboxAsk(box, "ses_scout", { command: "make report", why: "The weekly report.", error: "Permission denied" });
  const [scoutAsk] = await asked(box, fromScout);
  assert.deepEqual(scoutAsk.owner, { kind: "bot", id: "bot_scout", name: "Scout" });
  await box.ask("POST", `kuvo/sandbox/asks/${scoutAsk.id}`, { answer: "no" });
  await fromScout;
  const fromChat = sandboxAsk(box, "ses_chat", { command: "make export", why: "The export.", error: "Permission denied" });
  const [chatAsk] = await asked(box, fromChat);
  assert.deepEqual(chatAsk.owner, { kind: "chats", name: "Chats" });
  await box.ask("POST", `kuvo/sandbox/asks/${chatAsk.id}`, { answer: "no" });
  await fromChat;

  // Moved to another computer, a bot's rules go with it.
  assert.equal((await box.ask("POST", "kuvo/sandbox/allowed", { owner: { kind: "bot", id: "bot_juno" }, kind: "write", path: reports })).status, 200);
  fs.rmSync(path.join(home, "bots", "bot_juno"), { recursive: true });
  assert.deepEqual((await box.ask("GET", "kuvo/sandbox/allowed")).value.allowed.map(rule => rule.owner.name), ["Scout", "Chats"]);

  // Deleted, a bot's rules go with it; the chats' stay.
  assert.equal((await box.ask("DELETE", "kuvo/bots/bot_scout")).status, 200);
  assert.deepEqual((await box.ask("GET", "kuvo/sandbox/allowed")).value.allowed.map(rule => rule.owner.kind), ["chats"]);
  assert.ok(!(await box.ask("GET", "kuvo/sandbox/allowed")).value.owners.some(owner => owner.id === "bot_scout"));
  for (const rule of (await box.ask("GET", "kuvo/sandbox/allowed")).value.allowed) await box.ask("DELETE", `kuvo/sandbox/allowed/${rule.id}`);
});

test("a rule whose folder is gone still shows, so it can be removed", async () => {
  const old = path.join(root, "old-site"), cache = path.join(outside, "old-cache");
  for (const folder of [old, cache]) fs.mkdirSync(folder, { recursive: true });
  assert.equal((await box.ask("POST", "kuvo/sandbox/allowed", { project: old, kind: "write", path: cache })).status, 200);
  fs.rmSync(old, { recursive: true });
  const [rule] = (await box.ask("GET", "kuvo/sandbox/allowed")).value.allowed;
  assert.deepEqual([rule.owner, rule.gone, rule.path], [{ kind: "project", name: "old-site" }, true, cache]);
  assert.equal((await box.ask("DELETE", `kuvo/sandbox/allowed/${rule.id}?all`)).status, 200);
  assert.deepEqual((await box.ask("GET", "kuvo/sandbox/allowed")).value.allowed, []);
});

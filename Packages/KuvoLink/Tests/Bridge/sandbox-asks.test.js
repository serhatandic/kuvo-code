// When the sandbox stops a command a task needs (PROTOCOL.md, "Sandbox", "Asks"): the agent asks
// with sandbox_ask, you see what it wants to run and why on any client (`kuvo/sandbox/asks`), and
// answer Allow Once (the box runs that one command outside the sandbox and hands back its output),
// Always for This (that, and the folder it was stopped writing in for the project's commands from
// then on, kept in Also Allowed) or Don't Allow. The engine is a
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
import { NO_BUN, testBun } from "./bun-for-tests.js";

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
  // A worktree of the repository `kept`, for a branch of its own.
  ses_branch: { id: "ses_branch", title: "Try a branch", location: { directory: path.join(root, "kept-branch") } },
  // A bot's seat in a group chat.
  ses_seat: { id: "ses_seat", title: "Standup", location: { directory: shop }, metadata: { kuvo: { seat: "seat_1" } } },
};
const calling = {};
let calls = 0;
let engine;
before(async () => {
  for (const folder of [shop, blog, outside, path.join(home, "run")]) fs.mkdirSync(folder, { recursive: true });
  if (linux) {
    const bun = testBun();
    assert.ok(bun, NO_BUN);
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
  const ask = async (method, route, body) => {
    const response = await fetch(`${url}/${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, value: await response.json().catch(() => ({})) };
  };
  const stop = async () => { child.stdin.end(); child.kill("SIGTERM"); await exited; };
  return { ask, stop, url, headers };
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

// An agent's sandbox_ask, as its tool server passes it on while the conversation makes that call.
function sandboxAsk(box, session, args) {
  calling[session] = [{ type: "tool", id: `call_${++calls}`, name: "kuvo-browser_sandbox_ask", state: { status: "running", input: args } }];
  return box.ask("POST", "kuvo/sandbox/tools", { session, name: "sandbox_ask", arguments: args });
}

// What's asked now, once something is: from the asks' stream, which says what's asked each time it
// changes. (`call`: the call that should ask, which mustn't answer first.)
async function asked(box, call) {
  const stop = new AbortController();
  let done = false;
  const first = (what) => { if (!done) assert.fail(`answered without asking: ${what}`); };
  const answered = call.then(result => first(JSON.stringify(result.value ?? result)), error => first(String(error)));
  try {
    return await Promise.race([answered, streamed(box, stop.signal)]);
  } finally {
    done = true;
    stop.abort();
  }
}
async function streamed(box, signal) {
  const response = await fetch(`${box.url}/kuvo/sandbox/asks/events`, { headers: box.headers, signal });
  let buffered = "";
  try {
    for await (const chunk of response.body) {
      buffered += Buffer.from(chunk).toString("utf8");
      let at;
      while ((at = buffered.indexOf("\n")) >= 0) {
        const { asks } = JSON.parse(buffered.slice(0, at));
        buffered = buffered.slice(at + 1);
        if (asks.length) return asks;
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error;
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
  const command = `echo shipped >> ${JSON.stringify(target)} && echo wrote it`;
  const inSandbox = await engineRuns(shop, command, "ses_shop");
  assert.notEqual(inSandbox.status, 0, "the sandbox stops it");
  assert.equal(fs.existsSync(target), false);

  const call = sandboxAsk(box, "ses_shop", { command, why: "To record the release outside the project.", error: inSandbox.out.trim() });
  const [ask] = await asked(box, call);
  assert.equal(ask.command, command);
  assert.equal(ask.why, "To record the release outside the project.");
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
  assert.match(ran.text, /wrote it/);
  assert.equal(fs.readFileSync(target, "utf8"), "shipped\n");
  assert.deepEqual((await box.ask("GET", "kuvo/sandbox/asks")).value.asks, [], "answered, it's no longer asked");

  // Once is once: the same command asks again, and you say no.
  const again = sandboxAsk(box, "ses_shop", { command, why: "Once more." });
  const [second] = await asked(box, again);
  assert.equal((await box.ask("POST", `kuvo/sandbox/asks/${second.id}`, { answer: "no" })).status, 200);
  const refused = (await again).value;
  assert.match(refused.text, /The user said no/);
  assert.equal(fs.readFileSync(target, "utf8"), "shipped\n", "nothing ran");
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
  const write = `echo line >> ${JSON.stringify(path.join(logs, "build.log"))}`;
  assert.notEqual((await engineRuns(shop, write, "ses_shop2")).status, 0, "the sandbox stops it");
  const wrote = sandboxAsk(box, "ses_shop2", { command: write, why: "To keep the build's log." });
  const [writeAsk] = await asked(box, wrote);
  assert.deepEqual(writeAsk.always, { kind: "write", path: logs });
  assert.equal((await box.ask("POST", `kuvo/sandbox/asks/${writeAsk.id}`, { answer: "always" })).status, 200);
  assert.match((await wrote).value.text, /^Ran outside the sandbox · Always for this: from now on your commands can write in /);
  const rules = (await box.ask("GET", `kuvo/sandbox/allowed?project=${encodeURIComponent(shop)}`)).value.allowed;
  assert.deepEqual(rules.map(({ kind, path: where }) => ({ kind, path: where })), [{ kind: "write", path: logs }]);
  const ran = await engineRuns(shop, write, "ses_shop2");
  assert.equal(ran.status, 0, ran.out);
  assert.equal(fs.readFileSync(path.join(logs, "build.log"), "utf8"), "line\nline\n");
  // And another file there, as the next build writes.
  const other = await engineRuns(shop, `echo next > ${JSON.stringify(path.join(logs, "next.log"))}`, "ses_shop2");
  assert.equal(other.status, 0, other.out);
  assert.equal((await fromMac("DELETE", `kuvo/sandbox/allowed/${rules[0].id}`)).status, 200);
  // A file in its own project it was stopped writing (the settings an agent starts with): Always
  // there would give nothing, so it's once.
  const settings = `echo '{}' > ${JSON.stringify(path.join(shop, ".mcp.json"))}`;
  assert.notEqual((await engineRuns(shop, settings, "ses_shop2")).status, 0, "the sandbox stops it");
  const set = sandboxAsk(box, "ses_shop2", { command: settings, why: "To add a server." });
  const [setAsk] = await asked(box, set);
  assert.deepEqual(setAsk.stopped, [{ kind: "write", path: path.join(shop, ".mcp.json") }]);
  assert.equal(setAsk.always, undefined);
  await box.ask("POST", `kuvo/sandbox/asks/${setAsk.id}`, { answer: "no" });
  await set;
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
  assert.notEqual((await engineRuns(shop, `echo x > ${JSON.stringify(path.join(repo, "through.txt"))}`, "ses_shop")).status, 0, "not through a link");
  assert.equal(fs.existsSync(path.join(blog, "through.txt")), false);
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
  const write = (name) => `echo hi > ${JSON.stringify(path.join(shared, name))}`;
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
  const call = sandboxAsk(box, "ses_branch", { command, why: "To fill the shared cache." });
  const [ask] = await asked(box, call);
  assert.deepEqual(ask.always, { kind: "write", path: shared });
  assert.equal((await box.ask("POST", `kuvo/sandbox/asks/${ask.id}`, { answer: "always" })).status, 200);
  assert.match((await call).value.text, /^Ran outside the sandbox · Always for this/);
  const rules = (await box.ask("GET", `kuvo/sandbox/allowed?project=${encodeURIComponent(kept)}`)).value.allowed;
  assert.deepEqual(rules.map(rule => rule.path), [shared], "listed for the project");
  assert.equal((await engineRuns(branch, write("again.txt"), "ses_branch")).status, 0);
  assert.equal((await engineRuns(kept, write("main.txt"), "ses_branch")).status, 0, "and the project's own commands");
  for (const rule of rules) await fromMac("DELETE", `kuvo/sandbox/allowed/${rule.id}`);
});

test("a group chat's seat is asked about once only: nobody's there to answer for it for good", async () => {
  const args = { command: "./tools/lint.sh", why: "To check the post before the standup." };
  const called = sandboxAsk(box, "ses_seat", args);
  const [open] = await asked(box, called);
  assert.equal(open.session, "ses_seat");
  assert.equal(open.always, undefined, "no Always for This");
  assert.equal((await fromMac("POST", `kuvo/sandbox/asks/${open.id}`, { answer: "no" })).status, 200);
  assert.match((await called).value.text, /^The user said no/);
});

test("only a conversation's own call asks: one it isn't making, or a command naming it, gets nothing", async () => {
  calling.ses_shop = [];
  const refused = (await box.ask("POST", "kuvo/sandbox/tools", { session: "ses_shop", name: "sandbox_ask", arguments: { command: "id", why: "x" } })).value;
  assert.equal(refused.isError, true);
  assert.deepEqual((await box.ask("GET", "kuvo/sandbox/asks")).value.asks, []);
});

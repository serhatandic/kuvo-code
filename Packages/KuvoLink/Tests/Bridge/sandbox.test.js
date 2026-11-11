// Agents' commands in the sandbox (PROTOCOL.md, "Sandbox"): off until you turn it on; on, each
// command the engine runs writes only in its conversation's folder (and that folder's git
// repository, but never what git runs on its own), and can't read Kuvo Code's own folders, another
// bot's, or your secrets. The engine is a stand-in here, as far as it goes: it loads the box's real
// plugin and runs a command as the engine does, through the shell the plugin gives it, with the
// environment the plugin set. The sandbox itself is the system's own (macOS's, Linux's Landlock).
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/sandbox.test.js`; on a Linux machine, with
// `scripts/test-linux.sh <ssh-host> sandbox.test.js`, and with `--engine` on the engine's own runner,
// which the box runs on there (Bun's: `BUN_BE_BUN=1 <engine> test --timeout 120000 ./sandbox.test.js`,
// as its 5 seconds a test are too few for some).
import { ownPath, testsFolder } from "./test-safety.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { script, sshAgentsOf } from "./bot-keys-scenarios.js";
import { NO_BUN, testBun } from "./bun-for-tests.js";
import { removeAtEnd } from "./at-end.js";

// In the folder tests keep in your home (not the temporary folders, which commands may write), so
// what a command mustn't write is somewhere it otherwise couldn't.
const root = fs.realpathSync(testsFolder("sb"));
removeAtEnd(root);
const linux = process.platform === "linux";
// This file's runtime, for the commands that run it: run on a machine's engine, that's in the
// machine's own `~/.kuvo-code`, which a test's box hides from its commands as Kuvo Code's own, so
// they run a link to it in this file's folder.
const ownRuntime = (() => {
  let kuvo = path.join(os.homedir(), ".kuvo-code");
  try { kuvo = fs.realpathSync(kuvo); } catch {}
  kuvo += "/";
  if (!fs.realpathSync(process.execPath).startsWith(kuvo)) return process.execPath;
  const linked = path.join(root, "runtime");
  try { fs.linkSync(fs.realpathSync(process.execPath), linked); } catch { fs.copyFileSync(process.execPath, linked); fs.chmodSync(linked, 0o755); }
  return linked;
})();
// The link's script, for the commands that run it: a copy in this file's folder, as a machine has
// its own in its box's folder. The checkout's may be in Kuvo Code's own folders (an agent's worktree
// is, in `~/.kuvo-code`), which the sandbox hides from commands. (One file, all it needs inside it.)
const ownScript = path.join(root, "kuvo-link.js");
fs.copyFileSync(script, ownScript);
// kuvo-wake, as Wakes.swift has it and BoxFiles puts it in every box's bin.
const swift = fs.readFileSync(new URL("../../../OpenCodeKit/Sources/OpenCodeKit/Engine/Wakes.swift", import.meta.url), "utf8");
const opening = 'public static let script = #"""\n';
const from = swift.indexOf(opening) + opening.length;
const wakeScript = swift.slice(from, swift.indexOf('\n    """#', from)).split("\n").map(line => line.replace(/^ {4}/, "")).join("\n") + "\n";
const base = { ...process.env, HOME: root };
for (const name of ["KUVO_HOST_URL", "KUVO_HOST_PASSWORD", "KUVO_KEYS", "KUVO_KEYS_ON_HOST", "KUVO_BOX", "KUVO_ENGINE_CONFIG", "KUVO_VAULT_AGENTS", "KUVO_SANDBOX"]) delete base[name];

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
    const bun = testBun();
    assert.ok(bun, NO_BUN);
    fs.mkdirSync(path.join(home, "engine", "test"), { recursive: true });
    fs.symlinkSync(bun, path.join(home, "engine", "test", "opencode"));
  }
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, "bin", "kuvo-wake"), wakeScript, { mode: 0o755 });
  return { app, home, config, env, plugin: path.join(config, "opencode", "plugins", "kuvo-sandbox.js"), bots: mac ? path.join(app, "bots") : path.join(home, "bots"), wakes: path.join(home, "wakes") };
}

// `env`: what else the box starts with (`KUVO_SANDBOX: "off"`, Kuvo Code's own kill switch).
async function start(box, env = {}, wrap = []) {
  const child = spawn(wrap[0] ?? process.execPath, [...wrap.slice(1), ...(wrap.length ? [process.execPath] : []), script, "serve"], { env: { ...box.env, ...env, OPENCODE_PASSWORD: "box-pw" }, stdio: ["pipe", "pipe", "pipe"] });
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
  return { url, ask, stop, pid: child.pid };
}

// Whom the box's word to the agents bridge names, that it has set up its sandbox (or found it
// can't run): the box as it runs now, before the bridge starts any coding agent.
const decidedBy = box => {
  try { return JSON.parse(fs.readFileSync(path.join(box.home, "run", "fence", "decided"), "utf8")).pid; } catch { return undefined; }
};

// The engine, opening `folder` and running `command` there as its shell tool does: through the
// shell its plugins give it, with the environment they set, then the conversation's (`session`,
// as the engine names it after its plugins). With no plugin of the sandbox's, as before.
async function engineRuns(box, folder, command, session) {
  return (await engineOpens(box, folder))(command, session);
}

// The engine opening `folder` now, and what runs a command there later (as `engineRuns`).
async function engineOpens(box, folder) {
  let hook;
  const tools = [];
  if (fs.existsSync(box.plugin)) {
    const plugin = (await import(`${pathToFileURL(box.plugin)}?${Math.random()}`)).default;
    await plugin.setup({ location: { directory: folder }, shell: { hook: async (name, take) => { assert.equal(name, "create.before"); hook = take; } }, tool: { hook: async (name, take) => { if (name === "execute.before") tools.push(take); } } });
  }
  const runs = (command, session) => engineRunsOpened(box, folder, hook, command, session);
  // And one of its tools called there later, as engineCalls does.
  runs.calls = async (tool, input) => {
    const call = { tool, sessionID: ENGINE_SESSION, agent: "build", messageID: "msg_tools", id: "call_tools", input };
    try {
      for (const each of tools) await each(call);
    } catch (error) {
      return { refused: error.message };
    }
    return { input: call.input };
  };
  return runs;
}

// A command in `folder`, through what the plugin did as the engine opened it (`hook`).
function engineRunsOpened(box, folder, hook, command, session) {
  const input = { command, cwd: folder, timeout: 0, shell: "/bin/sh", env: { PATH: process.env.PATH, HOME: root, KUVO_BOTS: box.bots, KUVO_WAKES: box.wakes } };
  if (hook) {
    hook(input);
    // (The plugin names the engine's runtime, its own: here that's this test's, so on Linux,
    // without Bun, the Bun this box's engine is.)
    if (linux && !process.versions.bun) input.env.KUVO_FENCE_RUNTIME = path.join(box.home, "engine", "test", "opencode");
  }
  if (session) input.env.OPENCODE_SESSION_ID = session;
  const run = spawnSync(input.shell, ["-c", input.command], { cwd: input.cwd, env: input.env, encoding: "utf8" });
  return { status: run.status, out: run.stdout + run.stderr };
}

const ENGINE_SESSION = "ses_tools";

// The engine, opening `folder` and calling one of its own tools there (`tool`, with `input`), as
// its plugins see the call before it runs: what the tool is given then, or what it's refused with.
async function engineCalls(box, folder, tool, input) {
  const call = { tool, sessionID: ENGINE_SESSION, agent: "build", messageID: "msg_tools", id: "call_tools", input };
  const plugin = (await import(`${pathToFileURL(box.plugin)}?${Math.random()}`)).default;
  const hooks = [];
  await plugin.setup({ location: { directory: folder }, shell: { hook: async () => {} }, tool: { hook: async (name, take) => { if (name === "execute.before") hooks.push(take); } } });
  try {
    for (const hook of hooks) await hook(call);
  } catch (error) {
    return { refused: error.message };
  }
  return { input: call.input };
}

// Whether the engine asks before its file tools go to `given` in `folder`: where the path, as
// written (~ your home folder), is in neither the folder nor its project's top folder, `top` (its
// own check, `FileAccess.resolve`, by the path alone; links aren't followed).
const engineAsks = (folder, given, top = folder) => {
  const home = os.homedir();
  const where = path.resolve(folder, given === "~" ? home : given.startsWith("~/") ? path.join(home, given.slice(2)) : given);
  return ![folder, top].some(inside => where === inside || where.startsWith(inside + path.sep));
};

// The first file a patch names, as the engine reads it (engine 2.2.0's patch parser): each line
// without a last \r, trimmed, starting with a header.
const patchedFile = text => {
  for (const line of text.split("\n")) {
    const read = (line.endsWith("\r") ? line.slice(0, -1) : line).trim();
    const head = ["*** Add File: ", "*** Update File: ", "*** Delete File: "].find(each => read.startsWith(each));
    if (head) return read.slice(head.length).trim();
  }
};

// What a command could do, each line `<what>: allowed` or `refused`.
const tries = lines => lines.map(([what, command]) => `if ( ${command} ) >/dev/null 2>&1; then echo "${what}: allowed"; else echo "${what}: refused"; fi`).join("\n");
const outcome = out => Object.fromEntries(out.trim().split("\n").filter(line => /: (allowed|refused)$/.test(line)).map(line => line.split(": ")));

// The engine's server, as far as kuvo-wake uses it: sessions that are there, and the wake-ups
// sent to them (`prompts`). The box's record names it.
async function engineServer(box) {
  const prompts = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      if (request.method === "POST" && /\/prompt$/.test(request.url)) prompts.push(JSON.parse(body).text);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(/\/inbox$/.test(request.url) ? "[]" : "{}");
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(box.home, "run", "engine.json"), JSON.stringify({ pid: process.pid, port: server.address().port, password: "engine-pw", version: "test" }));
  return { prompts, close: () => new Promise(resolve => server.close(resolve)) };
}

// The box's round of wake-ups and watches, as its keeper or the box runs it; done when its
// wake-ups are (its watches go on beside it).
function fire(box) {
  const wake = path.join(box.home, "bin", "kuvo-wake");
  const child = spawn(wake, ["fire", box.bots, path.join(box.home, "run", "engine.json")], { env: { PATH: process.env.PATH, HOME: root, KUVO_BOTS: box.bots, KUVO_WAKES: box.wakes }, stdio: "ignore" });
  return new Promise(resolve => child.once("exit", resolve));
}

// Kuvo-wake run by hand for a conversation's folder (Check Now's `try`), as the Mac's app runs it.
function byHand(box, folder, ...args) {
  return spawnSync(path.join(box.home, "bin", "kuvo-wake"), [folder, ...args], { env: { PATH: process.env.PATH, HOME: root, KUVO_BOTS: box.bots, KUVO_WAKES: box.wakes }, encoding: "utf8" });
}

// Until `done` holds, a change in `folder` at a time (no clock).
function changeIn(folder, done) {
  return new Promise(resolve => {
    if (done()) return resolve();
    const watcher = fs.watch(folder, () => { if (done()) { watcher.close(); resolve(); } });
  });
}

test("set up wherever it can run as the box starts, waiting only for the engine, with no switch to turn it off", async () => {
  const box = boxAt("always");
  const running = await start(box);
  try {
    const state = (await running.ask("GET", "kuvo/sandbox")).value;
    assert.equal(state.able, true, state.why);
    assert.equal("wanted" in state, false);
    assert.equal(state.reason, "waiting", state.why);
    assert.equal(fs.existsSync(box.plugin), true, "the engine has its plugin as the box starts");
    assert.equal(decidedBy(box), running.pid, "it tells the agents bridge, which starts no agent before");
    assert.equal((await running.ask("PATCH", "kuvo/sandbox", { on: false })).status, 405);
    assert.equal(fs.existsSync(box.plugin), true);
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
    let state = (await running.ask("GET", "kuvo/sandbox")).value;
    assert.equal(state.able, true, state.why);
    assert.equal(state.on, false, "the engine hasn't loaded it yet");
    assert.equal(state.why, "Waiting for the engine to load it.");
    assert.equal(state.agents, true, "the coding agents' own programs run whole in it as they start, the engine's wait or not");
    const kept = path.join(box.home, "run", "engine.json");
    // The vault's socket (its holder is this box): straight, and as the Mac's \`box route\` asks it
    // (refused: its holder can't be reached, 503; anything else, even nothing, counts as reached),
    // with what Kuvo Code's own processes give first (the box's socket key) left to find.
    const keyFile = path.join(box.home, "run", "socket.key");
    assert.ok(fs.existsSync(keyFile), "the box made its sockets' key");
    const runtime = `BUN_BE_BUN=1 ${JSON.stringify(ownRuntime)}`;
    const straight = `const s = require("net").createConnection(${JSON.stringify(path.join(box.home, "run", "vault.sock"))}); let h = ""; s.on("connect", () => s.write(JSON.stringify({ hello: "x" }) + "\\n")); s.on("data", c => { h += c; s.destroy(); }); s.on("error", () => process.exit(1)); s.on("close", () => process.exit(h ? 0 : 1));`;
    const fill = JSON.stringify({ method: "POST", path: "kuvo/vault/fill", body: Buffer.from("{}").toString("base64") });
    const ran = await engineRuns(box, project, tries([
      ["run its runtime", `${runtime} -e 'process.exit(0)'`],
      ["read the box's sockets' key", `cat ${JSON.stringify(keyFile)}`],
      ["reach the vault's socket", `${runtime} -e '${straight}'`],
      ["read the link's script", `cat ${JSON.stringify(ownScript)}`],
      ["reach the vault through the box", `out=$(echo '${fill}' | KUVO_HOME=${JSON.stringify(box.home)} ${runtime} ${JSON.stringify(ownScript)} box route 2>/dev/null); case $out in *'"status":503'*) false ;; *) true ;; esac`],
      ["write in its project", "echo ok > made.txt"],
      ["git in its project", "git add made.txt && git -c user.name=t -c user.email=t@t commit -qm made"],
      ["its temporary files", `echo ok > "$TMPDIR/scratch"`],
      ["read the box's files", `cat ${JSON.stringify(kept)}`],
      ["list the box's files", `ls ${JSON.stringify(path.join(box.home, "run"))}`],
      ["write in the box's folder", `echo x > ${JSON.stringify(path.join(box.home, "run", "planted"))}`],
      ["turn the sandbox off", `rm -f ${JSON.stringify(box.plugin)}`],
    ]));
    const seen = outcome(ran.out);
    assert.equal(seen["write in its project"], "allowed", ran.out);
    assert.equal(seen["git in its project"], "allowed", ran.out);
    assert.equal(seen["its temporary files"], "allowed", ran.out);
    assert.equal(seen["run its runtime"], "allowed", ran.out);
    assert.equal(seen["read the box's sockets' key"], "refused", ran.out);
    assert.equal(seen["reach the vault's socket"], "refused", ran.out);
    // (`box route` below is that script: hidden, the route couldn't start, and its failure would look
    // like a refusal's opposite, an answer that isn't a 503.)
    assert.equal(seen["read the link's script"], "allowed", ran.out);
    assert.equal(seen["reach the vault through the box"], "refused", ran.out);
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
    assert.equal(state.gaps, undefined, "nothing it can't keep commands from");
    assert.ok((await running.ask("GET", "kuvo/vault/tools")).value.tools.length > 0, "so the vault is open to agents here");
    // And Auto runs here, as every client reads it: the Mac reaches a machine's box through a
    // `box route` of its own, which knows the sandbox runs only from its files.
    const asked = spawnSync(process.execPath, [script, "box", "route"], { env: box.env, input: JSON.stringify({ method: "GET", path: "kuvo/approval" }), encoding: "utf8" });
    const here = JSON.parse(JSON.parse(asked.stdout.trim().split("\n").pop()).body);
    assert.deepEqual(here.auto.engine, {}, asked.stdout + asked.stderr);
  } finally {
    await running.stop();
  }
});

test("a command can't change what git runs on its own, the engine's settings or the coding agents', from its project", { skip: linux && "Linux's Landlock can't refuse a file inside a folder it lets a command write" }, async () => {
  const box = boxAt("guards");
  const project = path.join(root, "guarded");
  fs.mkdirSync(project);
  assert.equal(spawnSync("git", ["init", "-q", project]).status, 0);
  // A submodule's repository and a worktree's, as git keeps them in the project's.
  fs.mkdirSync(path.join(project, ".git", "modules", "lib", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(project, ".git", "worktrees", "spare"), { recursive: true });
  fs.mkdirSync(path.join(project, ".claude"));
  fs.writeFileSync(path.join(project, ".claude", "settings.local.json"), "{}\n");
  fs.mkdirSync(path.join(project, ".claude", "hooks"));
  fs.writeFileSync(path.join(project, ".claude", "hooks", "check.sh"), "exit 0\n");
  fs.mkdirSync(path.join(project, ".cursor"));
  // A Codex folder a project already has (as your home does, when a session's folder is it).
  fs.mkdirSync(path.join(project, "app", ".codex"), { recursive: true });
  fs.mkdirSync(path.join(project, "app", ".grok"), { recursive: true });
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    const ran = await engineRuns(box, path.join(project), tries([
      ["add a git hook", "echo 'curl evil' > .git/hooks/pre-commit"],
      ["change git's settings", "echo '[core] fsmonitor = evil' >> .git/config"],
      ["add a submodule's hook", "echo 'curl evil' > .git/modules/lib/hooks/post-checkout"],
      ["change a submodule's settings", "echo '[core] fsmonitor = evil' > .git/modules/lib/config"],
      ["change a worktree's settings", "echo '[core] fsmonitor = evil' > .git/worktrees/spare/config.worktree"],
      ["point a worktree at another repository", "echo /elsewhere/.git > .git/worktrees/spare/commondir"],
      ["point a worktree at another checkout", "echo /elsewhere/.git > .git/worktrees/spare/gitdir"],
      ["make a branch", "mkdir -p .git/refs/heads && echo 0 > .git/refs/heads/topic"],
      ["add the engine's settings", `echo '{}' > opencode.json`],
      ["add the engine's plugins", "mkdir -p .opencode/plugin && echo x > .opencode/plugin/x.js"],
      ["add Claude Code's hooks", `mkdir -p .claude && echo '{"hooks":{}}' > .claude/settings.json`],
      ["change Claude Code's own settings", `echo '{"hooks":{}}' > .claude/settings.local.json`],
      ["add Claude Code's servers", `echo '{"mcpServers":{}}' > .mcp.json`],
      ["add Codex's settings", "mkdir -p .codex && echo 'x = 1' > .codex/config.toml"],
      ["add Cursor's hooks", "mkdir -p app/.cursor && echo '{}' > app/.cursor/hooks.json"],
      ["add Codex's hooks", "echo '{}' > app/.codex/hooks.json"],
      ["add Codex's rules", "mkdir -p app/.codex/rules && echo x > app/.codex/rules/default.rules"],
      ["change Codex's environment", "echo X=1 > app/.codex/.env"],
      ["change Grok's settings", "echo 'x = 1' > app/.grok/config.toml"],
      ["add Grok's language servers", "echo '{}' > app/.grok/lsp.json"],
      ["add Grok's hooks", "mkdir -p app/.grok/hooks && echo 'curl evil' > app/.grok/hooks/start.sh"],
      ["add a Grok skill", "mkdir -p app/.grok/skills/ship && echo ok > app/.grok/skills/ship/SKILL.md"],
      ["move Claude Code's settings into place", `echo '{}' > s.json && mv s.json .claude/settings.json`],
      ["write the project's notes for agents", "echo ok > CLAUDE.md"],
      ["add a Claude Code command", "mkdir -p .claude/commands && echo ok > .claude/commands/ship.md"],
      ["add a Cursor rule", "mkdir -p .cursor/rules && echo ok > .cursor/rules/style.mdc"],
      ["write in a worktree kept in .claude", "mkdir -p .claude/worktrees/spare && echo ok > .claude/worktrees/spare/index.js"],
      ["write a source file", "echo ok > index.js"],
      ["change a Claude Code hook script", "echo 'curl evil' > .claude/hooks/check.sh"],
      // A folder moved or linked into place carries what's in it past each file's check (last: each
      // moves what the tries above use).
      ["swap in a submodule's repository", "mkdir -p m/hooks && echo 'curl evil' > m/hooks/post-checkout && mv m .git/modules/other"],
      ["link in a Codex folder", "mkdir -p cx && echo 'x = 1' > cx/config.toml && ln -s cx .codex"],
      ["swap in another .claude", `mkdir -p evil && echo '{"hooks":{}}' > evil/settings.local.json && mv .claude .claude-old && mv evil .claude`],
      ["swap in another .git", "mkdir -p g/hooks && echo 'curl evil' > g/hooks/pre-commit && mv .git .git-old && mv g .git"],
    ]));
    const seen = outcome(ran.out);
    assert.deepEqual(seen, {
      "add a git hook": "refused", "change git's settings": "refused", "add a submodule's hook": "refused", "change a submodule's settings": "refused",
      "change a worktree's settings": "refused", "point a worktree at another repository": "refused", "point a worktree at another checkout": "refused", "make a branch": "allowed", "add the engine's settings": "refused", "add the engine's plugins": "refused",
      "add Claude Code's hooks": "refused", "change Claude Code's own settings": "refused", "add Claude Code's servers": "refused", "add Codex's settings": "refused",
      "add Cursor's hooks": "refused", "move Claude Code's settings into place": "refused",
      "add Codex's hooks": "refused", "add Codex's rules": "refused", "change Codex's environment": "refused",
      "change Grok's settings": "refused", "add Grok's language servers": "refused", "add Grok's hooks": "refused", "add a Grok skill": "allowed",
      "swap in another .claude": "refused", "link in a Codex folder": "refused", "swap in another .git": "refused",
      "swap in a submodule's repository": "refused", "change a Claude Code hook script": "refused", "write the project's notes for agents": "allowed",
      "add a Claude Code command": "allowed", "add a Cursor rule": "allowed", "write in a worktree kept in .claude": "allowed", "write a source file": "allowed",
    }, ran.out);
    assert.equal(fs.readFileSync(path.join(project, ".claude", "settings.local.json"), "utf8"), "{}\n");
    assert.equal(fs.readFileSync(path.join(project, ".claude", "hooks", "check.sh"), "utf8"), "exit 0\n");
    assert.equal(fs.existsSync(path.join(project, ".codex")), false);
    assert.equal(fs.existsSync(path.join(project, ".git", "hooks", "pre-commit")), false);
  } finally {
    await running.stop();
  }
});

test("a coding agent's commands in a worktree are in the sandbox, and commit to its repository", async () => {
  const box = boxAt("worktree");
  const repository = path.join(root, "agent-repo");
  const project = path.join(root, "agent-tree");
  // A file of yours outside it, which it may change but never delete.
  const yours = path.join(root, "agent-yours.txt");
  fs.writeFileSync(yours, "yours\n");
  assert.equal(spawnSync("git", ["init", "-q", repository]).status, 0);
  assert.equal(spawnSync("git", ["-C", repository, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]).status, 0);
  assert.equal(spawnSync("git", ["-C", repository, "worktree", "add", "-q", project]).status, 0);
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    // An agent run whole, as the coding agents' bridge starts it (agents/fence.ts): its program,
    // the conversation's folder and repository.
    const ran = spawnSync(path.join(box.home, "run", "fence", "shell", "run"), ["-c", tries([
      ["write in its project", "echo ok > made.txt"],
      ["commit in its worktree", "git add made.txt && git -c user.name=t -c user.email=t@t commit -qm made"],
      ["read the box's files", `cat ${JSON.stringify(path.join(box.home, "run", "engine.json"))}`],
      ["delete outside its project", `rm ${JSON.stringify(yours)}`],
      ["add a git hook", `echo x > ${JSON.stringify(path.join(repository, ".git", "hooks", "pre-commit"))}`],
    ])], { cwd: project, encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, KUVO_FENCE_SHELL: "/bin/sh", KUVO_FENCE_WORK: project, KUVO_FENCE_GIT: path.join(repository, ".git"), KUVO_FENCE_OWN: path.join(root, "agent-home"), KUVO_FENCE_PORT: "0", OPENCODE_SESSION_ID: "ses_agentTest" } });
    assert.deepEqual(outcome(ran.stdout), {
      "write in its project": "allowed", "commit in its worktree": "allowed", "read the box's files": "refused",
      "delete outside its project": "refused", "add a git hook": linux ? "allowed" : "refused",
    }, ran.stdout + ran.stderr);
    assert.equal(fs.readFileSync(yours, "utf8"), "yours\n");
    assert.equal(spawnSync("git", ["-C", repository, "log", "--all", "--format=%s"], { encoding: "utf8" }).stdout.includes("made"), true);
    assert.equal(fs.existsSync(path.join(root, "planted")), false);
    // Only the launcher for agents run whole is there: none of the shells a box before made for Claude Code's commands.
    assert.deepEqual(fs.readdirSync(path.join(box.home, "run", "fence", "shell")), ["run"]);
  } finally {
    await running.stop();
  }
});

test("a coding agent run whole in the sandbox keeps its own sign-in and state (only what's named so), but not what it runs as it starts or its plugins, reads the skills it's given, and reaches its own Kuvo Code tools", async () => {
  const box = boxAt("whole", !linux);
  const project = path.join(root, "whole-project");
  fs.mkdirSync(project);
  // Its own folder (an added account's, in Kuvo Code's own, which commands never see).
  const own = path.join(box.home, "agents", "grok-1");
  fs.mkdirSync(path.join(own, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(own, "auth.json"), "signed in\n");
  fs.writeFileSync(path.join(own, "config.toml"), "model = 'x'\n");
  fs.mkdirSync(path.join(own, "plugins"));
  // The skills it's given, in Kuvo Code's own folder.
  const skills = path.join(box.home, "agents", "skills");
  fs.mkdirSync(skills, { recursive: true });
  fs.writeFileSync(path.join(skills, "SKILL.md"), "a skill\n");
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    const toolsPort = new URL(running.url).port;
    const whole = (port) => spawnSync(path.join(box.home, "run", "fence", "shell", "run"), ["-c", tries([
      ["read its sign-in", `cat ${JSON.stringify(path.join(own, "auth.json"))}`],
      ["write its sessions", `echo x > ${JSON.stringify(path.join(own, "sessions", "s1"))}`],
      ["write its databases", `echo x > ${JSON.stringify(path.join(own, "state_5.sqlite-wal"))}`],
      ["write its sign-in anew", `echo x > ${JSON.stringify(path.join(own, "auth.json.tmp"))} && mv ${JSON.stringify(path.join(own, "auth.json.tmp"))} ${JSON.stringify(path.join(own, "auth.json"))}`],
      ["make another file at its top", `echo x > ${JSON.stringify(path.join(own, "hooks-paths"))}`],
      ["put settings in its state", `echo x > ${JSON.stringify(path.join(own, "sessions", "permission.toml"))}`],
      ["read its settings", `cat ${JSON.stringify(path.join(own, "config.toml"))}`],
      ["change its settings", `echo 'hook = 1' >> ${JSON.stringify(path.join(own, "config.toml"))}`],
      ["add a plugin", `echo x > ${JSON.stringify(path.join(own, "plugins", "p.js"))}`],
      // (Each by a name that's its state: what keeps them out is that they're links.)
      ["put a link at its top", `ln -s / ${JSON.stringify(path.join(own, "auth.json.old"))}`],
      ["put a link in its state", `ln -s / ${JSON.stringify(path.join(own, "sessions", "s2"))}`],
      ["read the skills it's given", `cat ${JSON.stringify(path.join(skills, "SKILL.md"))}`],
      ["change the skills it's given", `echo x >> ${JSON.stringify(path.join(skills, "SKILL.md"))}`],
      ["write in its project", "echo ok > made.txt"],
      ["read the box's files", `cat ${JSON.stringify(path.join(box.home, "run", "engine.json"))}`],
      ["reach its tools", `curl -s -m 2 -o /dev/null http://127.0.0.1:${toolsPort}/kuvo/info`],
    ])], { cwd: project, encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, KUVO_FENCE_SHELL: "/bin/sh", KUVO_FENCE_WORK: project, KUVO_FENCE_OWN: own, KUVO_FENCE_STATE: "sessions\nlogs\nauth.json*\nstate_*.sqlite*", KUVO_FENCE_KEPT: "*.toml\nhooks.json", KUVO_FENCE_READ: skills, ...(port ? { KUVO_FENCE_PORT: port } : {}) } });
    const ran = whole(toolsPort);
    // (Linux grants its homes whole: what macOS keeps only read there, it can't, without stopping
    // the agent making its own files beside it. A machine's agents' homes are Kuvo Code's own.)
    const mac = linux ? "allowed" : "refused";
    assert.deepEqual(outcome(ran.stdout), {
      "read its sign-in": "allowed", "write its sessions": "allowed", "write its databases": "allowed", "write its sign-in anew": "allowed",
      "make another file at its top": mac, "put settings in its state": mac, "read its settings": "allowed",
      "change its settings": mac, "add a plugin": mac, "put a link at its top": mac, "put a link in its state": mac, "read the skills it's given": "allowed", "change the skills it's given": "refused",
      "write in its project": "allowed", "read the box's files": "refused", "reach its tools": "allowed",
    }, ran.stdout + ran.stderr);
    if (!linux) assert.equal(fs.readFileSync(path.join(own, "config.toml"), "utf8"), "model = 'x'\n");
    // (Linux leaves local ports open to every command.)
    if (!linux) assert.equal(outcome(whole().stdout)["reach its tools"], "refused", "only the agent's own port, only for it");
  } finally {
    await running.stop();
  }
});

test("Claude Code run whole in the sandbox writes its conversations and sign-in, but not its settings or yours, and the hooks and MCP servers it starts, a project's too, are in the sandbox", async () => {
  const box = boxAt("claude-whole", !linux);
  const project = path.join(root, "claude-whole-project");
  fs.mkdirSync(path.join(project, ".claude", "hooks"), { recursive: true });
  // Its settings folder, as yours is on a Mac (`~/.claude`), and your Claude Code's settings file
  // beside it. (A machine's is in Kuvo Code's folder, its bridge's: `~/.claude` is a wall there.)
  const own = linux ? path.join(box.home, "agents", "claude", "home") : path.join(root, ".claude");
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, "settings.json"), "{}\n");
  fs.writeFileSync(path.join(root, ".claude.json"), "{}\n");
  const yours = path.join(root, "hook-yours.txt");
  fs.writeFileSync(yours, "yours\n");
  // A project's hook and MCP server, as Claude Code starts them: programs of their own, run by it.
  fs.writeFileSync(path.join(project, ".claude", "hooks", "start.sh"), tries([
    ["a project's hook writes in its project", "echo ok > hooked.txt"],
    ["a project's hook deletes outside it", `rm ${JSON.stringify(yours)}`],
    ["a project's MCP server reads Kuvo Code's files", `cat ${JSON.stringify(path.join(box.home, "run", "engine.json"))}`],
  ]) + "\n");
  // Claude Code, as far as what it writes and starts goes.
  const claude = path.join(root, "claude-program");
  fs.writeFileSync(claude, "#!/bin/sh\n" + tries([
    ["write its conversation", `mkdir -p ${JSON.stringify(path.join(own, "projects", "p"))} && echo x > ${JSON.stringify(path.join(own, "projects", "p", "s.jsonl"))}`],
    ["write its sign-in", `echo x > ${JSON.stringify(path.join(own, ".credentials.json"))}`],
    ["add a hook to its settings", `echo '{"hooks":{}}' > ${JSON.stringify(path.join(own, "settings.json"))}`],
    ["put settings in its conversations", `echo x > ${JSON.stringify(path.join(own, "projects", "settings.json"))}`],
    ["add a server to your settings file", `echo '{"mcpServers":{}}' > ${JSON.stringify(path.join(root, ".claude.json"))}`],
  ]) + "\nsh .claude/hooks/start.sh\n", { mode: 0o755 });
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    const ran = spawnSync(path.join(box.home, "run", "fence", "shell", "run"), [], { cwd: project, encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, KUVO_FENCE_SHELL: claude, KUVO_FENCE_WORK: project, KUVO_FENCE_OWN: own, KUVO_FENCE_STATE: "projects\nsessions\ntodos\n.credentials.json*\n.claude.json*", KUVO_FENCE_KEPT: "settings*.json\nhooks\n.mcp.json", KUVO_FENCE_PORT: "0" } });
    // (Linux grants its homes whole: a machine's Claude Code's is Kuvo Code's own there.)
    const mac = linux ? "allowed" : "refused";
    assert.deepEqual(outcome(ran.stdout), {
      "write its conversation": "allowed", "write its sign-in": "allowed", "add a hook to its settings": mac, "put settings in its conversations": mac,
      "add a server to your settings file": "refused",
      "a project's hook writes in its project": "allowed", "a project's hook deletes outside it": "refused", "a project's MCP server reads Kuvo Code's files": "refused",
    }, ran.stdout + ran.stderr);
    assert.equal(fs.readFileSync(path.join(root, ".claude.json"), "utf8"), "{}\n");
    assert.equal(fs.readFileSync(yours, "utf8"), "yours\n");
  } finally {
    await running.stop();
  }
});

test("an agent whose program is the engine's runtime (Cursor's SDK) runs as Bun in the sandbox, and no other agent's does", async () => {
  const box = boxAt("as-bun", !linux);
  const project = path.join(root, "as-bun-project");
  fs.mkdirSync(project);
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    const seen = (asBun) => spawnSync(path.join(box.home, "run", "fence", "shell", "run"), ["-c", 'echo "bun=${BUN_BE_BUN-none} cache=${BUN_RUNTIME_TRANSPILER_CACHE_PATH-none} named=${KUVO_FENCE_BUN-none}"'], {
      cwd: project, encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, KUVO_FENCE_SHELL: "/bin/sh", KUVO_FENCE_WORK: project, KUVO_FENCE_OWN: project, KUVO_FENCE_PORT: "1", ...(asBun ? { KUVO_FENCE_BUN: "1" } : {}) },
    });
    const ran = seen(true);
    assert.equal(ran.stdout.trim(), "bun=1 cache=0 named=none", ran.stderr);
    assert.equal(seen(false).stdout.trim(), "bun=none cache=none named=none");
  } finally {
    await running.stop();
  }
});

test("agents are told how commands run in the sandbox while it's on, and nothing once it's off", async () => {
  const box = boxAt("told");
  const project = path.join(root, "told-project");
  fs.mkdirSync(project);
  // The note the engine starts with among its instructions (`engine-config`, as this Mac's app and a
  // machine's start scripts run it), keeping the instructions it was given.
  const config = JSON.parse(spawnSync(process.execPath, [script, "engine-config"], { env: { ...box.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ instructions: ["~/rules.md"] }) }, encoding: "utf8" }).stdout);
  assert.equal(config.instructions[0], "~/rules.md");
  const note = config.instructions.find(each => each !== "~/rules.md");
  assert.ok(note && path.isAbsolute(note), JSON.stringify(config.instructions));
  const running = await start(box);
  try {
    // Nothing yet while the engine hasn't loaded its plugin: its commands still run as before.
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.reason, "waiting");
    assert.equal(fs.readFileSync(note, "utf8"), "");
    await engineRuns(box, project, "true");
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.on, true);
    const told = fs.readFileSync(note, "utf8");
    assert.match(told, /runs in Kuvo Code's sandbox/);
    if (linux) assert.doesNotMatch(told, /--disable-sandbox|pgrep/);
    else {
      assert.match(told, /swift test --disable-sandbox/);
      assert.match(told, /use `pgrep -fl`, `lsof` or `top -l 1`/);
      // What it tells them holds: ps is refused (it would show other programs' environments),
      // pgrep and top work.
      const ran = await engineRuns(box, project, tries([["ps", "ps -ax"], ["pgrep", "pgrep -fl sh"], ["top", "top -l 1 -n 1"]]));
      assert.deepEqual(outcome(ran.out), { ps: "refused", pgrep: "allowed", top: "allowed" }, ran.out);
    }
  } finally {
    await running.stop();
  }
  // Turned off (Kuvo Code's own kill switch), agents are told nothing.
  const off = await start(box, { KUVO_SANDBOX: "off" });
  try {
    assert.equal((await off.ask("GET", "kuvo/sandbox")).value.on, false);
    assert.equal(fs.readFileSync(note, "utf8"), "");
  } finally {
    await off.stop();
  }
});

test("a bot's command writes in its own folder, and another bot's is hidden from it", async () => {
  const box = boxAt("bots");
  for (const bot of ["bot_ship", "bot_scout"]) fs.mkdirSync(path.join(box.bots, bot, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(box.bots, "bot_scout", "workspace", "notes.md"), "Scout's own\n");
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
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

test("a bot keeps its memory from the sandbox, in its own conversation and its seats in group chats, and nothing else of its folder or another bot's", async () => {
  const box = boxAt("memory");
  const bot = (id, session) => {
    const folder = path.join(box.bots, id);
    fs.mkdirSync(path.join(folder, "workspace"), { recursive: true });
    fs.writeFileSync(path.join(folder, "MEMORY.md"), `# ${id}'s memory\n`);
    fs.writeFileSync(path.join(folder, "bot.json"), "{}");
    fs.writeFileSync(path.join(folder, "session"), session);
    return folder;
  };
  const ship = bot("bot_ship", "ses_ship");
  const scout = bot("bot_scout", "ses_scout");
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    const attempts = tries([
      ["read its memory", "cat ../MEMORY.md"],
      ["write its memory", "echo '- likes tea' >> ../MEMORY.md"],
      ["write its memory anew", "printf '# Ship\\n' > ../MEMORY.md"],
      ["replace its memory", "echo x > ../MEMORY.new && mv ../MEMORY.new ../MEMORY.md"],
      ["remove its memory", "rm ../MEMORY.md"],
      ["link its memory elsewhere", "ln -sf ../bot.json ../MEMORY.md"],
      ["change its settings", "echo x > ../bot.json"],
      ["change its conversation", "echo ses_other > ../session"],
      ["read another bot's memory", `cat ${JSON.stringify(path.join(scout, "MEMORY.md"))}`],
      ["write another bot's memory", `echo x >> ${JSON.stringify(path.join(scout, "MEMORY.md"))}`],
      // Last: its own folder traded for a link to another bot's, which the next command would work in.
      ["trade its folder for another bot's", `d=$(pwd -P) && cd .. && rmdir "$d" && ln -s ${JSON.stringify(scout)} "$d"`],
    ]);
    const expected = {
      "read its memory": "allowed", "write its memory": "allowed", "write its memory anew": "allowed",
      "replace its memory": "refused", "remove its memory": "refused", "link its memory elsewhere": "refused",
      "change its settings": "refused", "change its conversation": "refused",
      "read another bot's memory": "refused", "write another bot's memory": "refused",
      "trade its folder for another bot's": "refused",
    };
    // Its own conversation, and its seat in a group chat (another conversation, in its folder).
    for (const session of ["ses_ship", "ses_seat"]) {
      fs.writeFileSync(path.join(ship, "MEMORY.md"), "# Ship's memory\n");
      const ran = await engineRuns(box, path.join(ship, "workspace"), attempts, session);
      assert.deepEqual(outcome(ran.out), expected, `${session}: ${ran.out}`);
      assert.equal(fs.readFileSync(path.join(ship, "MEMORY.md"), "utf8"), "# Ship\n");
    }
    assert.equal(fs.readFileSync(path.join(ship, "bot.json"), "utf8"), "{}");
    assert.equal(fs.readFileSync(path.join(scout, "MEMORY.md"), "utf8"), "# bot_scout's memory\n");
    assert.equal(fs.lstatSync(path.join(ship, "workspace")).isDirectory(), true, "its folder is still its own");
  } finally {
    await running.stop();
  }
});

test("with Kuvo Code's own kill switch, the engine's plugin goes, and commands run as before", async () => {
  const box = boxAt("toggled");
  const project = path.join(root, "toggled-project");
  fs.mkdirSync(project);
  const running = await start(box);
  await running.stop();
  assert.equal(fs.existsSync(box.plugin), true);
  const off = await start(box, { KUVO_SANDBOX: "off" });
  try {
    const state = (await off.ask("GET", "kuvo/sandbox")).value;
    // Nothing a client offers: there's nothing you can do about it.
    assert.deepEqual([state.on, state.reason, state.action], [false, undefined, undefined]);
    assert.equal(fs.existsSync(box.plugin), false);
    assert.equal(decidedBy(box), off.pid, "the agents bridge starts them, as before");
    assert.equal((await engineRuns(box, project, `cat ${JSON.stringify(path.join(box.home, "run", "engine.json"))}`)).status, 0);
  } finally {
    await off.stop();
  }
});

test("this Mac's box hides its app's whole folder, its chats but the conversation's own, and refuses Kuvo Code's own servers", { skip: linux && "this Mac's box only" }, async () => {
  const box = boxAt("run.kuvo.code.sandbox-test", true);
  const chats = path.join(box.app, "Chats");
  for (const chat of ["chat_a", "chat_b"]) fs.mkdirSync(path.join(chats, chat), { recursive: true });
  fs.writeFileSync(path.join(chats, "chat_b", "secret.md"), "another chat's\n");
  fs.mkdirSync(path.join(box.app, "Attachments"), { recursive: true });
  fs.writeFileSync(path.join(box.app, "Attachments", "photo.txt"), "yours\n");
  // The app's own server for Kuvo Code's tools, as the agents bridge notes where the app says it is.
  const tools = net.createServer(socket => socket.end());
  await new Promise(resolve => tools.listen(0, "127.0.0.1", resolve));
  fs.mkdirSync(path.join(box.home, "run"), { recursive: true });
  fs.writeFileSync(path.join(box.home, "run", "tools.json"), JSON.stringify({ port: tools.address().port }));
  const running = await start(box);
  try {
    const state = (await running.ask("GET", "kuvo/sandbox")).value;
    assert.equal(state.able, true, state.why);
    assert.equal(fs.existsSync(box.plugin), true, "in the engine's own settings folder");
    const ran = await engineRuns(box, path.join(chats, "chat_a"), tries([
      ["write in its chat", "echo ok > reply.md"],
      ["read another chat", `cat ${JSON.stringify(path.join(chats, "chat_b", "secret.md"))}`],
      ["read the app's files", `cat ${JSON.stringify(path.join(box.app, "Attachments", "photo.txt"))}`],
      ["reach the box", `curl -s -m 2 -o /dev/null ${running.url}/kuvo/info`],
      // (Its connection only: this process answers nothing while the command runs.)
      ["reach the app's tools", `nc -z -G 2 127.0.0.1 ${tools.address().port}`],
    ]));
    assert.deepEqual(outcome(ran.out), { "write in its chat": "allowed", "read another chat": "refused", "read the app's files": "refused", "reach the box": "refused", "reach the app's tools": "refused" }, ran.out);
  } finally {
    await running.stop();
    tools.close();
  }
});

test("a chat's command works in the Chats folder, where every chat works, and the rest of Kuvo Code's folder stays hidden", async () => {
  // (This Mac's chats are in its app's folder, a machine's in its own: each hidden but for them.)
  const box = boxAt(linux ? "chats-machine" : "run.kuvo.code.chats-test", !linux);
  const chats = linux ? path.join(box.home, "chats") : path.join(box.app, "Chats");
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(path.join(chats, "notes.md"), "a chat's\n");
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    const ran = await engineRuns(box, chats, tries([
      ["read what's there", "cat notes.md"],
      ["write there", "echo ok > reply.md"],
      ["read the box's files", `cat ${JSON.stringify(path.join(box.home, "run", "engine.json"))}`],
    ]), "ses_chat");
    assert.deepEqual(outcome(ran.out), { "read what's there": "allowed", "write there": "allowed", "read the box's files": "refused" }, ran.out);
    assert.equal(fs.readFileSync(path.join(chats, "reply.md"), "utf8"), "ok\n");
  } finally {
    await running.stop();
  }
});

test("a link a command makes doesn't take the engine's own file tools out of the folder without asking", async () => {
  const box = boxAt("tools-through-links");
  const project = path.join(root, "tools-project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "notes.md"), "the project's\n");
  // Somewhere commands can't read or write: your keys, and a start-up script that isn't there yet.
  const keys = path.join(root, "your-keys");
  fs.mkdirSync(keys);
  fs.writeFileSync(path.join(keys, "id_test"), "a key\n");
  const profile = path.join(root, "profile-to-be");
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    const key = JSON.stringify(path.join(keys, "id_test"));
    const made = await engineRuns(box, project, `ln -s ${key} key.txt && ln -s ${JSON.stringify(keys)} keys && ln -s ${JSON.stringify(profile)} profile && ln -s ${key} "look alike.txt" && ln -s ${key} "spaced.txt " && ln -s ${JSON.stringify(path.join(root, "deep-to-be"))} deep && ln -s ${JSON.stringify(keys)} x && ln -s x/../your-keys/new.sh up`);
    fs.symlinkSync(keys, path.join(project, "ok\u2028keys"));
    assert.equal(made.status, 0, made.out);
    const asked = {};
    for (const [what, tool, input, given] of [
      ["read the key", "read", { path: "key.txt" }, input => input.path],
      ["read the key by its own path", "read", { path: path.join(project, "key.txt") }, input => input.path],
      ["edit in its folder", "edit", { path: "keys/id_test", oldString: "a", newString: "b" }, input => input.path],
      ["write the script that isn't there yet", "write", { path: "profile", content: "x" }, input => input.path],
      ["list its folder", "glob", { pattern: "*", path: "keys" }, input => input.path],
      ["search its folder", "grep", { pattern: "key", path: "keys" }, input => input.path],
      ["patch the key", "patch", { patchText: "*** Begin Patch\n*** Update File: keys/id_test\n@@\n-a key\n+b key\n*** End Patch" }, input => patchedFile(input.patchText)],
      // (The engine takes a patch's lines without the spaces around them.)
      ["patch the key, the line indented", "patch", { patchText: "*** Begin Patch\n  *** Update File: keys/id_test \n@@\n-a key\n+b key\n*** End Patch" }, input => patchedFile(input.patchText)],
      // (Read reads the one file beside a name that isn't there whose name is the same but for a
      // no-break space; and the engine takes a name with the spaces it has.)
      ["read the key by a look-alike name", "read", { path: "look\u00a0alike.txt" }, input => input.path],
      ["read the key by a name ending in a space", "read", { path: "spaced.txt " }, input => input.path],
      ["write far into a link to a place that isn't there yet", "write", { path: `deep/${"d/".repeat(41)}x`, content: "x" }, input => input.path],
      // (A .. after a link goes up from where the link leads.)
      ["write through a link that goes up from another", "write", { path: "up", content: "x" }, input => input.path],
      // (The engine trims a line of any spaces, and splits lines only at \n.)
      ["patch a new file, after a no-break space", "patch", { patchText: "*** Begin Patch\n\u00a0*** Add File: keys/new\n+x\n*** End Patch" }, input => patchedFile(input.patchText)],
      ["patch a new file, by a name with a line separator", "patch", { patchText: "*** Begin Patch\n*** Add File: ok\u2028keys/new\n+x\n*** End Patch" }, input => patchedFile(input.patchText)],
      // (The image tool writes the picture it makes where its path says.)
      ["make a picture where a link leads out", "experimental_image_generate", { path: "profile", prompt: "a cat" }, input => input.path],
      ["read what's in the project", "read", { path: "notes.md" }, input => input.path],
    ]) {
      const called = await engineCalls(box, project, tool, input);
      asked[what] = called.refused ? "refused" : engineAsks(project, given(called.input)) ? "asks" : "goes";
    }
    assert.deepEqual(asked, {
      "read the key": "asks",
      "read the key by its own path": "asks",
      "edit in its folder": "asks",
      "write the script that isn't there yet": "asks",
      "list its folder": "asks",
      "search its folder": "asks",
      "patch the key": "asks",
      "patch the key, the line indented": "asks",
      "read the key by a look-alike name": "asks",
      "read the key by a name ending in a space": "asks",
      "write far into a link to a place that isn't there yet": "asks",
      "write through a link that goes up from another": "asks",
      "patch a new file, after a no-break space": "asks",
      "patch a new file, by a name with a line separator": "asks",
      "make a picture where a link leads out": "asks",
      "read what's in the project": "goes",
    });
    // A link that stays in the project stays as written.
    assert.equal((await engineRuns(box, project, "ln -s notes.md also.md")).status, 0);
    assert.equal((await engineCalls(box, project, "read", { path: "also.md" })).input.path, "also.md");
    // A place outside, as written, stays as written (on a Mac, /tmp is a link to /private/tmp): what
    // you've always allowed there still holds.
    assert.equal((await engineCalls(box, project, "read", { path: "/tmp/notes.md" })).input.path, "/tmp/notes.md");
  } finally {
    await running.stop();
  }
});

test("a folder above the project that only looks like a repository doesn't count as the project's for the engine's file tools", async () => {
  const box = boxAt("tools-stray-git");
  // Your home folder, say, with a .git that isn't a repository, and your keys in it.
  const above = path.join(root, "stray-above");
  const project = path.join(above, "project");
  fs.mkdirSync(path.join(above, ".git"), { recursive: true });
  fs.mkdirSync(path.join(above, "keys"));
  fs.writeFileSync(path.join(above, "keys", "id_test"), "a key\n");
  fs.mkdirSync(project);
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    assert.equal((await engineRuns(box, project, "ln -s ../keys/id_test key.txt")).status, 0);
    // The engine counts only the folder as the project, so the key, by the link's real place, asks.
    const called = await engineCalls(box, project, "read", { path: "key.txt" });
    assert.equal(engineAsks(project, called.input.path), true, called.input.path);
  } finally {
    await running.stop();
  }
});

test("a conversation's folder traded for a link by another's command isn't worked in where the link leads", async () => {
  const box = boxAt("folder-traded");
  // One conversation in the project, another in a folder in it (which the first's commands write).
  const project = path.join(root, "traded-project");
  const inner = path.join(project, "inner");
  const moved = path.join(project, "moved");
  for (const folder of [inner, moved]) fs.mkdirSync(folder, { recursive: true });
  // Another of your projects, a repository.
  const elsewhere = path.join(root, "traded-elsewhere");
  fs.mkdirSync(elsewhere);
  assert.equal(spawnSync("git", ["init", "-q", elsewhere]).status, 0);
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    const opened = await engineOpens(box, inner);
    assert.equal(opened("echo first > first").status, 0);
    // A conversation moved into the project's other folder: checked, then moved later, by its name.
    assert.equal((await engineCalls(box, project, "opencode_session_move", { directory: "moved" })).refused, undefined);
    const traded = await engineRuns(box, project, `mv inner inner.old && ln -s ${JSON.stringify(elsewhere)} inner && mv moved moved.old && ln -s ${JSON.stringify(elsewhere)} moved`);
    assert.equal(traded.status, 0, traded.out);
    // Refused as the launcher refuses it: no command runs there at all.
    const said = run => run.status === 126 && /now leads somewhere else/.test(run.out) ? "refused" : `ran (${run.status}): ${run.out}`;
    const tries = {};
    tries["the one in it already"] = said(opened(`echo planted > ${JSON.stringify(path.join(elsewhere, "planted"))}`));
    const movedOpened = await engineOpens(box, moved);
    tries["the one moved there"] = said(movedOpened(`echo planted > ${JSON.stringify(path.join(elsewhere, "planted"))}`));
    // Nor moved on to where the link leads, from where it really was as it was opened, or checked.
    const movesOn = async (opens) => (await opens.calls("opencode_session_move", { directory: path.join(elsewhere, "on") })).refused ? "refused" : "moves";
    tries["the one in it already, moved on there"] = await movesOn(opened);
    tries["the one moved there, moved on there"] = await movesOn(movedOpened);
    // Nor its file tools taken to write there as in its own project (asked, as outside it).
    const writes = async (opens) => (await opens.calls("write", { path: "written.txt", content: "x" })).input.path === "written.txt" ? "as its own" : "asks";
    tries["the one in it already, writing there"] = await writes(opened);
    tries["the one moved there, writing there"] = await writes(movedOpened);
    assert.deepEqual(tries, {
      "the one in it already": "refused", "the one moved there": "refused",
      "the one in it already, moved on there": "refused", "the one moved there, moved on there": "refused",
      "the one in it already, writing there": "asks", "the one moved there, writing there": "asks",
    });
    assert.equal(fs.existsSync(path.join(elsewhere, "planted")), false);
  } finally {
    await running.stop();
  }
});

test("a project named in another case or Unicode form than its folder's on disk still runs its commands", { skip: linux && "Linux's folders are named one way only" }, async () => {
  const box = boxAt("folder-named-otherwise");
  // On disk: "Case Project" and "café" (é one letter); given: "case project" and "café" (e, then its accent).
  const folders = [[path.join(root, "Case Project"), path.join(root, "case project")], [path.join(root, "caf\u00e9"), path.join(root, "cafe\u0301")]];
  for (const [disk] of folders) fs.mkdirSync(path.join(disk, "sub"), { recursive: true });
  // The engine's plugin as the engine runs it, on Bun: the shell and environment it gives a command.
  const opens = path.join(root, "opens.mjs");
  fs.writeFileSync(opens, `const plugin = (await import(process.argv[2])).default
let hook, tools
await plugin.setup({ location: { directory: process.argv[3] }, shell: { hook: async (name, take) => { hook = take } }, tool: { hook: async (name, take) => { tools = take } } })
const input = { command: "", cwd: process.argv[3], shell: "/bin/sh", env: {} }
hook(input)
// And moving its conversation to a folder in it.
let moves = "moves"
try { await tools({ tool: "opencode_session_move", sessionID: "ses_case", input: { directory: "sub" } }) } catch { moves = "refused" }
console.log(JSON.stringify({ shell: input.shell, env: input.env, moves }))
`);
  const bun = testBun();
  assert.ok(bun, NO_BUN);
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    for (const [disk, given] of folders) {
      const opened = spawnSync(bun, [opens, pathToFileURL(box.plugin).href, given], { encoding: "utf8", env: { ...process.env, BUN_BE_BUN: "1" } });
      assert.equal(opened.status, 0, opened.stderr);
      const { shell, env, moves } = JSON.parse(opened.stdout);
      assert.equal(moves, "moves", given);
      const ran = spawnSync(shell, ["-c", "echo ran > ran.txt"], { cwd: given, env: { PATH: process.env.PATH, HOME: root, ...env }, encoding: "utf8" });
      assert.equal(ran.status, 0, `${given}: ${ran.stdout}${ran.stderr}`);
      assert.equal(fs.readFileSync(path.join(disk, "ran.txt"), "utf8"), "ran\n");
    }
  } finally {
    await running.stop();
  }
});

test("an agent can't move its own conversation out of its folder while its commands run in the sandbox", async () => {
  const box = boxAt("moving-out");
  const project = path.join(root, "moving-project");
  fs.mkdirSync(path.join(project, "sub"), { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q", project]).status, 0);
  assert.equal(spawnSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]).status, 0);
  const worktree = path.join(root, "moving-worktree");
  assert.equal(spawnSync("git", ["-C", project, "worktree", "add", "-q", worktree]).status, 0);
  const another = path.join(root, "moving-another");
  fs.mkdirSync(another);
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    const moves = {};
    // (As the agent calls it from code mode, and as the engine offers it without.)
    for (const [what, tool, directory] of [
      ["to your home folder", "opencode_session_move", root],
      ["to another folder", "session_move", another],
      ["to a folder in its own", "opencode_session_move", path.join(project, "sub")],
      ["to its repository's worktree", "opencode_session_move", worktree],
      // (The engine takes ~ as your home folder, and the folder without the spaces around it.)
      ["to ~", "opencode_session_move", "~"],
      ["to your home folder, after a space", "opencode_session_move", ` ${os.homedir()}`],
    ]) {
      const called = await engineCalls(box, project, tool, { directory });
      moves[what] = called.refused ? "refused" : "moves";
    }
    // Another conversation, whose folder the engine takes a folder from.
    moves["another conversation"] = (await engineCalls(box, project, "opencode_session_move", { sessionID: "ses_another", directory: "sub" })).refused ? "refused" : "moves";
    moves["itself, by its own id"] = (await engineCalls(box, project, "opencode_session_move", { sessionID: ENGINE_SESSION, directory: "sub" })).refused ? "refused" : "moves";
    assert.deepEqual(moves, {
      "to your home folder": "refused",
      "to another folder": "refused",
      "to a folder in its own": "moves",
      "to its repository's worktree": "moves",
      "to ~": "refused",
      "to your home folder, after a space": "refused",
      "another conversation": "refused",
      "itself, by its own id": "moves",
    });
  } finally {
    await running.stop();
  }
});

test("a .git that names another folder doesn't let a command write there", async () => {
  const box = boxAt("git-redirect");
  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, "kept"), "kept\n");
  const linked = path.join(root, "linked");
  fs.mkdirSync(linked);
  fs.symlinkSync(elsewhere, path.join(linked, ".git"));
  const named = path.join(root, "named");
  fs.mkdirSync(named);
  fs.writeFileSync(path.join(named, ".git"), `gitdir: ${elsewhere}\n`);
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    for (const project of [linked, named]) {
      const ran = await engineRuns(box, project, tries([["delete where its .git points", `rm ${JSON.stringify(path.join(elsewhere, "kept"))}`]]));
      assert.deepEqual(outcome(ran.out), { "delete where its .git points": "refused" }, `${path.basename(project)}: ${ran.out}`);
    }
    assert.equal(fs.readFileSync(path.join(elsewhere, "kept"), "utf8"), "kept\n");
  } finally {
    await running.stop();
  }
});

// A Linux machine that doesn't let commands have a namespace of their own, as Ubuntu 24.04 and
// later don't (AppArmor): here the box runs in a user namespace that may make only one more, which
// the wrapper takes for mapping you back to yourself, so the box's own `unshare` fails as it would
// there. Where this machine can't make one at all, there's nothing to block.
const blocked = linux ? ["unshare", "-Ur", "sh", "-c", `echo 1 > /proc/sys/user/max_user_namespaces && exec unshare -U --map-user=${process.getuid()} --map-group=${process.getgid()} -- "$@"`, "sh"] : [];
const canBlock = linux && spawnSync(blocked[0], [...blocked.slice(1), "sh", "-c", "! unshare -Urm true 2>/dev/null"]).status === 0;

test("where commands can't have a namespace of their own, the sandbox still runs, says your login's services stay reachable, and keeps the vault from agents", { skip: !canBlock && "a Linux machine whose user namespaces this test can block" }, async () => {
  const box = boxAt("without-namespaces");
  const project = path.join(root, "without-namespaces-project");
  fs.mkdirSync(project);
  const running = await start(box, {}, blocked);
  try {
    let state = (await running.ask("GET", "kuvo/sandbox")).value;
    assert.equal(state.able, true, state.why);
    assert.notEqual(state.reason, "namespaces", "it runs rather than asking before every command");
    const ran = await engineRuns(box, project, tries([
      ["write in its project", "echo ok > made.txt"],
      ["read the box's files", `cat ${JSON.stringify(path.join(box.home, "run", "engine.json"))}`],
      ["write in the box's folder", `echo x > ${JSON.stringify(path.join(box.home, "run", "planted"))}`],
    ]));
    const seen = outcome(ran.out);
    assert.equal(seen["write in its project"], "allowed", ran.out);
    assert.equal(seen["read the box's files"], "refused", ran.out);
    assert.equal(seen["write in the box's folder"], "refused", ran.out);
    state = (await running.ask("GET", "kuvo/sandbox")).value;
    assert.equal(state.on, true, "commands run in the sandbox, without a namespace");
    assert.deepEqual(state.gaps, ["services"], "and it says what it can't keep them from");
    assert.equal(state.needs, "user namespaces");
    assert.equal(fs.readFileSync(path.join(box.home, "run", "fence", "namespace"), "utf8"), "-");
    // Nor is the vault open to agents there (its tools aren't listed), though every agent's
    // commands run in the sandbox.
    assert.deepEqual((await running.ask("GET", "kuvo/vault/tools")).value.tools, []);
  } finally {
    await running.stop();
  }
});

test("Kuvo Code's passwords and your SSH agent stay out of a command's environment", async () => {
  const box = boxAt("environment");
  const project = path.join(root, "env-project");
  fs.mkdirSync(project);
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    const input = { command: "env", cwd: project, timeout: 0, shell: "/bin/sh", env: { PATH: process.env.PATH, HOME: root, OPENCODE_PASSWORD: "engine-pw", OPENCODE_SERVER_PASSWORD: "server-pw", SSH_AUTH_SOCK: "/tmp/agent.sock", OPENCODE_CLIENT: "desktop" } };
    const plugin = (await import(`${pathToFileURL(box.plugin)}?${Math.random()}`)).default;
    let hook;
    await plugin.setup({ location: { directory: project }, shell: { hook: async (name, take) => { hook = take; } } });
    hook(input);
    if (linux && !process.versions.bun) input.env.KUVO_FENCE_RUNTIME = path.join(box.home, "engine", "test", "opencode");
    input.env.OPENCODE_SESSION_ID = "ses_env";
    const seen = spawnSync(input.shell, ["-c", input.command], { cwd: project, env: input.env, encoding: "utf8" }).stdout;
    assert.doesNotMatch(seen, /engine-pw|server-pw|agent\.sock/);
    assert.match(seen, /OPENCODE_SESSION_ID=ses_env/, "the conversation's own name stays");
  } finally {
    await running.stop();
  }
});

// While the sandbox is off a command can read the box's folder, the key to its sockets among it:
// one it kept opens nothing once the sandbox is on (a socket a command can still connect to on Linux).
test("a socket key a command kept from before the sandbox was on opens nothing once it is", async () => {
  const box = boxAt("old-key");
  const project = path.join(root, "old-key-project");
  fs.mkdirSync(project);
  const keyFile = path.join(box.home, "run", "socket.key");
  const off = await start(box, { KUVO_SANDBOX: "off" });
  try {
    assert.equal((await engineRuns(box, project, `cat ${JSON.stringify(keyFile)} > kept.key`)).status, 0);
  } finally {
    await off.stop();
  }
  assert.match(fs.readFileSync(path.join(project, "kept.key"), "utf8"), /^[0-9a-f]{64}$/m, "kept while it was off");
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    const runtime = `BUN_BE_BUN=1 ${JSON.stringify(ownRuntime)}`;
    const withKept = `const key = require("fs").readFileSync("kept.key", "utf8").trim(); const s = require("net").createConnection(${JSON.stringify(path.join(box.home, "run", "vault.sock"))}); let h = ""; s.on("connect", () => s.write(JSON.stringify({ hello: "x", key }) + "\\n")); s.on("data", c => { h += c; s.destroy(); }); s.on("error", () => process.exit(1)); s.on("close", () => process.exit(h ? 0 : 1));`;
    const ran = await engineRuns(box, project, tries([
      ["run its runtime", `${runtime} -e 'process.exit(0)'`],
      ["reach the vault with the kept key", `${runtime} -e '${withKept}'`],
    ]));
    const seen = outcome(ran.out);
    assert.equal(seen["run its runtime"], "allowed", ran.out);
    assert.equal(seen["reach the vault with the kept key"], "refused", ran.out);
    // It's another key now (made as the engine first ran a command in the sandbox): from outside
    // the sandbox, where macOS's wouldn't refuse the connection anyway, the kept one opens nothing,
    // and Kuvo Code's own, read again, does.
    const kept = fs.readFileSync(path.join(project, "kept.key"), "utf8").trim();
    const current = fs.readFileSync(keyFile, "utf8").trim();
    assert.notEqual(kept, current);
    const hello = key => new Promise(resolve => {
      const socket = net.createConnection(path.join(box.home, "run", "vault.sock"));
      let heard = "";
      socket.on("connect", () => socket.write(JSON.stringify({ hello: "x", key }) + "\n"));
      socket.on("data", chunk => { heard += chunk; if (heard.includes("\n")) socket.destroy(); });
      socket.on("error", () => {});
      socket.on("close", () => resolve(heard));
    });
    assert.equal(await hello(kept), "", "the kept key opens nothing");
    assert.match(await hello(current), /"nonce"/, "the box's own still does");
  } finally {
    await running.stop();
  }
});

// Bun reads a \`bunfig.toml\` (its preloads) and a \`.env\` from the folder it starts in: on Linux
// the sandbox's own runner is the engine's Bun, started in the command's folder, which the agent
// writes. What they name never runs, there or anywhere outside the sandbox.
test("a bunfig.toml or .env an agent leaves in its project runs nothing outside the sandbox", async () => {
  const box = boxAt("bunfig");
  const project = path.join(root, "bunfig-project");
  fs.mkdirSync(project);
  const escaped = path.join(root, "bunfig-escaped");
  fs.writeFileSync(path.join(project, "pre.js"), `require("node:fs").writeFileSync(${JSON.stringify(escaped)}, "preloaded");\n`);
  fs.writeFileSync(path.join(project, "bunfig.toml"), 'preload = ["./pre.js"]\n');
  fs.writeFileSync(path.join(project, ".env"), "BUN_OPTIONS=--preload ./pre.js\n");
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    const ran = await engineRuns(box, project, "echo ran");
    assert.match(ran.out, /ran/);
    assert.equal(fs.existsSync(escaped), false, "its preload ran outside the sandbox");
  } finally {
    await running.stop();
  }
});

test("each conversation's temporary files are its own", async () => {
  const box = boxAt("temporary");
  const [one, two] = ["tmp-one", "tmp-two"].map(name => path.join(root, name));
  for (const folder of [one, two]) fs.mkdirSync(folder);
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    const first = await engineRuns(box, one, `echo mine > "$TMPDIR/note" && printf '%s' "$TMPDIR"`);
    assert.equal(first.status, 0, first.out);
    const ran = await engineRuns(box, two, tries([["read another's temporary files", `cat ${JSON.stringify(path.join(first.out.trim(), "note"))}`]]));
    assert.deepEqual(outcome(ran.out), { "read another's temporary files": "refused" }, ran.out);
  } finally {
    await running.stop();
  }
});

const hasNpm = spawnSync("npm", ["--version"]).status === 0;

test("npx fetches a package it hasn't yet and runs it, in the sandbox, into a cache of Kuvo Code's own that nothing outside it runs from, and your own npm cache is left as it is", { skip: !hasNpm && "needs npm on the PATH" }, async () => {
  const box = boxAt("npx");
  const project = path.join(root, "npx-project");
  fs.mkdirSync(path.join(project, "package"), { recursive: true });
  // A package as npm's registry hands one over (a tarball), here so nothing goes to the network.
  fs.writeFileSync(path.join(project, "package", "package.json"), JSON.stringify({ name: "kuvo-tool", version: "1.0.0", bin: { "kuvo-tool": "cli.js" } }));
  fs.writeFileSync(path.join(project, "package", "cli.js"), "#!/usr/bin/env node\nconsole.log('ran from ' + __dirname)\n", { mode: 0o755 });
  assert.equal(spawnSync("tar", ["-czf", "tool.tgz", "package"], { cwd: project }).status, 0);
  // Your own npm cache (where npm finds it with this test's HOME): npx runs what's in its `_npx`
  // outside the sandbox too.
  const yours = path.join(root, ".npm");
  const running = await start(box);
  try {
    // (Any trip to a registry fails at once.)
    const ran = await engineRuns(box, project, `npm_config_registry=http://127.0.0.1:9/ npm_config_update_notifier=false npx --yes --package=file:./tool.tgz -- kuvo-tool`);
    assert.equal(ran.status, 0, ran.out);
    const cache = fs.realpathSync(path.join(box.home, "cache", "sandbox-npm"));
    assert.ok(ran.out.includes(`ran from ${cache}/_npx/`), `it ran from Kuvo Code's own cache for commands: ${ran.out}`);
    // Not the engine's (which runs outside the sandbox), nor yours.
    assert.equal(fs.existsSync(path.join(box.home, "cache", "npm")), false);
    assert.equal(fs.existsSync(path.join(yours, "_npx")), false);
  } finally {
    await running.stop();
  }
});

// Your own caches of pnpm, uv and corepack (whole: `pnpm dlx`, uvx and corepack's pnpm and yarn run
// what they fetched from them, and what's installed from them is linked to their files), where they
// keep them, in your real home, which the sandbox's rules name (not this test's HOME).
const realHome = os.userInfo().homedir;
const yourToolCaches = [[".cache", "pnpm"], [".cache", "uv"], [".cache", "node", "corepack"], ...(linux ? [] : [["Library", "Caches", "pnpm"]])];

test("commands get caches of Kuvo Code's own for pnpm, uv and corepack, which they write, and your own they only read", async () => {
  const box = boxAt("tool-caches");
  const project = path.join(root, "tool-caches-project");
  fs.mkdirSync(project);
  const mark = `kuvo-sandbox-test-${process.pid}`;
  for (const parts of yourToolCaches) ownPath(path.join(realHome, ...parts, mark));
  // (What a write that wasn't refused would leave in your home, to remove after: the mark, and
  // each folder down to it that wasn't there before.)
  const made = [];
  for (const parts of yourToolCaches) {
    for (let at = 1; at <= parts.length; at++) {
      const folder = path.join(realHome, ...parts.slice(0, at));
      if (!fs.existsSync(folder) && !made.includes(folder)) made.push(ownPath(folder));
    }
  }
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    const ran = await engineRuns(box, project, [
      `printf '%s|%s|%s\\n' "\${pnpm_config_cache_dir-unset}" "\${UV_CACHE_DIR-unset}" "\${COREPACK_HOME-unset}"`,
      tries([
        ["pnpm's own", `mkdir -p "$pnpm_config_cache_dir/dlx/one" && echo x > "$pnpm_config_cache_dir/dlx/one/cli.js"`],
        ["uv's own", `mkdir -p "$UV_CACHE_DIR/archive-v0/one" && echo x > "$UV_CACHE_DIR/archive-v0/one/tool.py"`],
        ["corepack's own", `mkdir -p "$COREPACK_HOME/v1/pnpm" && echo x > "$COREPACK_HOME/v1/pnpm/pnpm.cjs"`],
        ...yourToolCaches.map(parts => [`your ${parts.join("/")}`, `mkdir -p ${JSON.stringify(path.join(realHome, ...parts, mark))}`]),
      ]),
    ].join("\n"));
    const caches = [["sandbox-pnpm"], ["sandbox-uv", "cache"], ["sandbox-corepack"]].map(parts => fs.realpathSync(path.join(box.home, "cache", ...parts)));
    assert.equal(ran.out.split("\n")[0], caches.join("|"), ran.out);
    assert.deepEqual(outcome(ran.out), {
      "pnpm's own": "allowed",
      "uv's own": "allowed",
      "corepack's own": "allowed",
      ...Object.fromEntries(yourToolCaches.map(parts => [`your ${parts.join("/")}`, "refused"])),
    }, ran.out);
  } finally {
    await running.stop();
    for (const parts of yourToolCaches) fs.rmSync(path.join(realHome, ...parts, mark), { recursive: true, force: true });
    for (const folder of made.reverse()) try { fs.rmdirSync(folder); } catch {}
  }
});

test("this Mac's box keeps the caches for commands in its app's cache folder, in the home it's given, and none in your account's when that's another", { skip: linux && "this Mac's box only" }, async () => {
  // (Its app's: the box's temporary folder in the app's, as the app gives it, `…/T/<bundle>/box`;
  // its cache folder `Library/Caches/<bundle>`. This test's HOME isn't your account's.)
  const bundle = `caches-mac-${process.pid}`;
  ownPath(path.join(realHome, "Library", "Caches", bundle));
  const box = boxAt(bundle, true);
  const project = path.join(root, "mac-caches-project");
  fs.mkdirSync(project);
  const temporary = path.join(root, "T", bundle, "box");
  fs.mkdirSync(temporary, { recursive: true });
  const running = await start(box, { TMPDIR: temporary + "/" });
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    const ran = await engineRuns(box, project, `printf '%s\\n' "\${npm_config_cache-unset}"`);
    assert.equal(ran.out.split("\n")[0], path.join(root, "Library", "Caches", bundle, "sandbox-npm"), ran.out);
    assert.equal(fs.existsSync(path.join(realHome, "Library", "Caches", bundle)), false, "nothing in your account's own Library");
  } finally {
    await running.stop();
    fs.rmSync(path.join(realHome, "Library", "Caches", bundle), { recursive: true, force: true });
  }
});

test("with a cache folder of your own (XDG_CACHE_HOME), the tools' caches in it are only read too", async () => {
  const box = boxAt("own-cache");
  const project = path.join(root, "own-cache-project");
  fs.mkdirSync(project);
  // Yours, where commands write tools' caches otherwise (on a Mac in `Library/Caches`, on Linux in
  // `~/.cache`), with uv's in it and another tool's.
  const yours = ownPath(path.join(realHome, ...(linux ? [".cache"] : ["Library", "Caches"]), `kuvo-sandbox-test-${process.pid}`));
  for (const name of ["uv", "other"]) fs.mkdirSync(path.join(yours, name), { recursive: true });
  const running = await start(box, { XDG_CACHE_HOME: yours });
  try {
    const ran = await engineRuns(box, project, tries([
      ["another tool's cache", `echo x > ${JSON.stringify(path.join(yours, "other", "file"))}`],
      ["your uv's cache", `echo x > ${JSON.stringify(path.join(yours, "uv", "file"))}`],
    ]));
    assert.deepEqual(outcome(ran.out), { "another tool's cache": "allowed", "your uv's cache": "refused" }, ran.out);
  } finally {
    await running.stop();
    fs.rmSync(yours, { recursive: true, force: true });
  }
});

test("bunx's packages in your temporary folder, which it runs again as they are, are only read", { skip: linux && "macOS only (Landlock can't take one name out of /tmp)" }, async () => {
  const box = boxAt("bunx");
  const project = path.join(root, "bunx-project");
  fs.mkdirSync(project);
  // Your temporary folder, as bunx names its packages' folders in it (`bunx-<uid>-<package>`).
  const temporary = fs.realpathSync(spawnSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).stdout.trim());
  const [mine, bunx] = [`kuvo-sandbox-test-${process.pid}`, `bunx-${process.getuid()}-kuvo-sandbox-test-${process.pid}`].map(name => ownPath(path.join(temporary, name)));
  const running = await start(box, { TMPDIR: temporary });
  try {
    const ran = await engineRuns(box, project, tries([
      ["your temporary folder", `mkdir ${JSON.stringify(mine)}`],
      ["bunx's packages", `mkdir ${JSON.stringify(bunx)}`],
    ]));
    assert.deepEqual(outcome(ran.out), { "your temporary folder": "allowed", "bunx's packages": "refused" }, ran.out);
  } finally {
    await running.stop();
    for (const folder of [mine, bunx]) fs.rmSync(folder, { recursive: true, force: true });
  }
});

const pnpmMajor = Number(spawnSync("pnpm", ["--version"], { encoding: "utf8" }).stdout?.split(".")[0]) || 0;

test("pnpm dlx fetches a package and runs it, in the sandbox, from a cache of Kuvo Code's own that nothing outside it runs from", { skip: pnpmMajor < 11 && "needs pnpm 11 or later on the PATH (pnpm 10's dlx is refused, as it would write in yours)" }, async () => {
  const box = boxAt("pnpm-dlx");
  const project = path.join(root, "pnpm-project");
  fs.mkdirSync(path.join(project, "package"), { recursive: true });
  // A package as the registry hands one over (a tarball), here so nothing goes to the network.
  fs.writeFileSync(path.join(project, "package", "package.json"), JSON.stringify({ name: "kuvo-tool", version: "1.0.0", bin: { "kuvo-tool": "cli.js" } }));
  fs.writeFileSync(path.join(project, "package", "cli.js"), "#!/usr/bin/env node\nconsole.log('ran from ' + __dirname)\n", { mode: 0o755 });
  assert.equal(spawnSync("tar", ["-czf", "tool.tgz", "package"], { cwd: project }).status, 0);
  const running = await start(box);
  try {
    // (pnpm's store in the project: the one in this test's HOME isn't one the sandbox's rules name.
    // Any trip to a registry fails at once.)
    const ran = await engineRuns(box, project, `pnpm_config_store_dir="$PWD/.store" npm_config_registry=http://127.0.0.1:9/ pnpm dlx --package="$PWD/tool.tgz" kuvo-tool`);
    assert.equal(ran.status, 0, ran.out);
    const cache = fs.realpathSync(path.join(box.home, "cache", "sandbox-pnpm"));
    assert.ok(ran.out.includes(`ran from ${cache}/dlx/`), `it ran from Kuvo Code's own cache for commands: ${ran.out}`);
    // Nor from pnpm's store, which commands write as a cache: pnpm 11 runs what it fetched from the
    // store's own copies (its `links`), which your pnpm runs too, outside the sandbox.
    const store = path.join(project, ".store");
    for (const version of fs.readdirSync(store)) assert.equal(fs.existsSync(path.join(store, version, "links")), false, `${version}/links in pnpm's store`);
    // Not yours (where pnpm finds it with this test's HOME).
    for (const yours of [path.join(root, ".cache", "pnpm"), path.join(root, "Library", "Caches", "pnpm")]) assert.equal(fs.existsSync(yours), false, yours);
  } finally {
    await running.stop();
  }
});

const hasUv = spawnSync("uv", ["--version"]).status === 0 && spawnSync("python3", ["--version"]).status === 0;

test("uvx installs a tool and runs it, in the sandbox, from a cache of Kuvo Code's own that nothing outside it runs from", { skip: !hasUv && "needs uv and python3 on the PATH" }, async () => {
  const box = boxAt("uvx");
  const project = path.join(root, "uvx-project");
  fs.mkdirSync(project);
  // A tool as PyPI hands one over (a wheel), here so nothing goes to the network.
  const wheel = "kuvo_tool-1.0.0-py3-none-any.whl";
  const files = {
    "kuvo_tool/__init__.py": "import os\ndef main():\n    print('ran from ' + os.path.dirname(os.path.realpath(__file__)))\n",
    "kuvo_tool-1.0.0.dist-info/METADATA": "Metadata-Version: 2.1\nName: kuvo-tool\nVersion: 1.0.0\n",
    "kuvo_tool-1.0.0.dist-info/WHEEL": "Wheel-Version: 1.0\nGenerator: kuvo-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    "kuvo_tool-1.0.0.dist-info/entry_points.txt": "[console_scripts]\nkuvo-tool = kuvo_tool:main\n",
  };
  files["kuvo_tool-1.0.0.dist-info/RECORD"] = [...Object.keys(files), "kuvo_tool-1.0.0.dist-info/RECORD"].map(name => `${name},,`).join("\n") + "\n";
  const zipped = spawnSync("python3", ["-I", "-c", "import json, sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w') as z:\n    [z.writestr(n, t) for n, t in json.loads(sys.argv[2]).items()]", path.join(project, wheel), JSON.stringify(files)]);
  assert.equal(zipped.status, 0, String(zipped.stderr));
  const running = await start(box);
  try {
    const ran = await engineRuns(box, project, `uvx --offline --no-config --from ./${wheel} kuvo-tool`);
    assert.equal(ran.status, 0, ran.out);
    const cache = fs.realpathSync(path.join(box.home, "cache", "sandbox-uv", "cache"));
    assert.ok(ran.out.includes(`ran from ${cache}/`), `it ran from Kuvo Code's own cache for commands: ${ran.out}`);
    // A project's environment it makes shares no file with that cache, which every conversation's
    // commands write, and which you run outside the sandbox.
    const venv = await engineRuns(box, project, `uv venv --offline --no-config -q .venv && uv pip install --offline --no-config -q --python .venv ./${wheel} && .venv/bin/kuvo-tool`);
    assert.equal(venv.status, 0, venv.out);
    const installed = venv.out.match(/ran from (\S+)/)?.[1];
    assert.ok(installed?.startsWith(fs.realpathSync(project)), venv.out);
    assert.equal(fs.statSync(path.join(installed, "__init__.py")).nlink, 1, "the environment's file is the cache's too");
    // Not yours (where uv finds them with this test's HOME), nor your tools folder.
    for (const yours of [path.join(root, ".cache", "uv"), path.join(root, ".local", "share", "uv")]) assert.equal(fs.existsSync(yours), false, yours);
  } finally {
    await running.stop();
  }
});

test("a commit runs pre-commit's hooks, which set themselves up as they first run, and your own pre-commit's are left as they are", async () => {
  const box = boxAt("pre-commit");
  const project = path.join(root, "hooked");
  fs.mkdirSync(project);
  assert.equal(spawnSync("git", ["init", "-q", project]).status, 0);
  // As `pre-commit install` leaves it, outside the sandbox: a hook that sets up its tools in
  // pre-commit's own folder (as pre-commit finds it) the first time, then runs them.
  fs.writeFileSync(path.join(project, ".git", "hooks", "pre-commit"), [
    "#!/bin/sh",
    'store=${PRE_COMMIT_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/pre-commit}',
    'mkdir -p "$store/repo-lint" && echo set up > "$store/repo-lint/env" && echo linted',
  ].join("\n") + "\n", { mode: 0o755 });
  // Your own pre-commit's folder, which commands only read (what's in it runs outside the sandbox):
  // as the sandbox keeps yours, since this test's home isn't the one its rules name.
  const yours = path.join(root, ".cache", "pre-commit");
  fs.mkdirSync(yours, { recursive: true });
  fs.chmodSync(yours, 0o555);
  const running = await start(box);
  try {
    const ran = await engineRuns(box, project, "echo ok > made.txt && git add made.txt && git -c user.name=t -c user.email=t@t commit -qm made");
    assert.equal(ran.status, 0, ran.out);
    assert.match(ran.out, /linted/);
    assert.deepEqual(fs.readdirSync(yours), [], "your own pre-commit's tools, which run outside it, aren't what it set up");
  } finally {
    await running.stop();
    fs.chmodSync(yours, 0o755);
  }
});

test("a command's own socket in its temporary folder works, as a server's tests or Python's multiprocessing make one", { skip: linux && "this Mac's box only (a machine's is in its own short ~/.kuvo-code, where this test's folder is deeper)" }, async () => {
  // This Mac's box as the app starts it, its temporary files in the app's temporary folder (named
  // as long as the app's own), its folder as deep as `~/Library/Application Support/<bundle>`.
  // A name of its own each run, as long as the app's, so two runs at once don't share it.
  const bundle = `kuvo.sock.${crypto.randomBytes(2).toString("hex").slice(0, 3)}`;
  const box = boxAt(path.join("Library", "Application Support", bundle), true);
  const temporary = ownPath(path.join(os.tmpdir(), bundle));
  fs.rmSync(temporary, { recursive: true, force: true });
  box.env.TMPDIR = path.join(temporary, "box") + "/";
  const project = path.join(root, "sockets");
  fs.mkdirSync(project);
  const python = [
    "import os, socket",
    "from multiprocessing.managers import BaseManager",
    "if __name__ == '__main__':",
    "    where = os.path.join(os.environ['TMPDIR'], 'server.sock')",
    "    server = socket.socket(socket.AF_UNIX); server.bind(where); server.listen(1)",
    "    client = socket.socket(socket.AF_UNIX); client.connect(where); print('connected')",
    "    manager = BaseManager(authkey=b'k'); manager.start(); manager.shutdown(); print('managed')",
  ].join("\n");
  fs.writeFileSync(path.join(project, "sockets.py"), python + "\n");
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    const ran = await engineRuns(box, project, "python3 sockets.py");
    assert.equal(ran.status, 0, ran.out);
    assert.match(ran.out, /connected\nmanaged/);
  } finally {
    await running.stop();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("turned off and on again, it isn't on until the engine has loaded it again", async () => {
  const box = boxAt("again");
  const project = path.join(root, "again-project");
  fs.mkdirSync(project);
  const first = await start(box);
  try {
    await engineRuns(box, project, "true");
    assert.equal((await first.ask("GET", "kuvo/sandbox")).value.on, true);
  } finally {
    await first.stop();
  }
  await (await start(box, { KUVO_SANDBOX: "off" })).stop();
  const running = await start(box);
  try {
    const state = (await running.ask("GET", "kuvo/sandbox")).value;
    assert.deepEqual([state.on, state.why], [false, "Waiting for the engine to load it."]);
    assert.deepEqual([state.reason, state.action, state.route], ["waiting", "restartEngine", "POST kuvo/engine/restart"]);
    // Its plugin changed under it: checked again, it's put back as it was.
    fs.writeFileSync(box.plugin, "// changed\n");
    const checked = await running.ask("POST", "kuvo/sandbox/check");
    assert.equal(checked.status, 200);
    assert.notEqual(fs.readFileSync(box.plugin, "utf8"), "// changed\n");
    assert.equal(checked.value.reason, "waiting", JSON.stringify(checked.value));
    assert.equal((await running.ask("GET", "kuvo/sandbox/check")).status, 405);
  } finally {
    await running.stop();
  }
});

test("on macOS, a command can't start what runs outside it, nor read another copy of Kuvo Code's, and still reads your Keychain for gh and git", { skip: linux && "macOS only" }, async () => {
  const box = boxAt("outside");
  const project = path.join(root, "outside-project");
  fs.mkdirSync(project);
  const outside = path.join(root, "job-escaped");
  // gh and git's Keychain helper read your sign-ins from the Keychain's files in their own process
  // (your own: its first bytes, the file's signature, and nothing in it; `security` says "not found"
  // either way). The system's own keychain in its folder, which only its daemons read, stays hidden.
  const keychains = path.join(os.userInfo().homedir, "Library", "Keychains");
  const daemons = fs.readdirSync(keychains).find(name => /^[0-9A-F]{8}-[0-9A-F-]{27}$/i.test(name));
  // An app that would run outside the sandbox, were it opened: it leaves a mark where the command can't.
  const app = path.join(root, "Escape.app");
  const opened = path.join(root, "app-escaped");
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Escape</string><key>CFBundleIdentifier</key><string>run.kuvo.code.sandbox-test-escape</string><key>LSBackgroundOnly</key><true/></dict></plist>
`);
  fs.writeFileSync(path.join(app, "Contents", "MacOS", "Escape"), `#!/bin/sh\necho x > ${JSON.stringify(opened)}\n`, { mode: 0o755 });
  // Another copy's temporary folder, where the system keeps them (`…/T/run.kuvo.code.<copy>`).
  const user = spawnSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).stdout.trim();
  const copy = fs.mkdtempSync(path.join(user, "run.kuvo.code.sandbox-test-"));
  fs.writeFileSync(path.join(copy, "secret"), "another copy's\n");
  const label = `run.kuvo.code.sandbox-test-${process.pid}`;
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    const ran = await engineRuns(box, project, tries([
      ["read another copy's files", `cat ${JSON.stringify(path.join(copy, "secret"))}`],
      ["start a launchd job", `launchctl submit -l ${label} -- /bin/sh -c 'echo x > ${outside}'`],
      // (`open` says whether the system took the app to start: no waiting for it to.)
      ["open an app", `open -g -j -a ${JSON.stringify(app)}`],
      // Refused by the sandbox (the system's list of apps out of reach), not for want of the app.
      ["miss the app", `open -g -j -a ${JSON.stringify(app)} 2>&1 | grep -q "Unable to find application"`],
      ["read your Keychain", `test "$(head -c 4 ${JSON.stringify(path.join(keychains, "login.keychain-db"))})" = kych`],
      ...(daemons ? [["read the system's own keychain", `ls ${JSON.stringify(path.join(keychains, daemons))}`]] : []),
    ]));
    assert.deepEqual(outcome(ran.out), { "read another copy's files": "refused", "start a launchd job": "refused", "open an app": "refused", "miss the app": "refused", "read your Keychain": "allowed", ...(daemons ? { "read the system's own keychain": "refused" } : {}) }, ran.out);
  } finally {
    // Were it ever opened, the system would remember the app: forgotten again.
    if (fs.existsSync(opened)) spawnSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-u", app]);
    spawnSync("launchctl", ["remove", label]);
    fs.rmSync(copy, { recursive: true, force: true });
    await running.stop();
  }
});

test("a command reaches its own conversation's SSH agent from the sandbox (the vault's SSH keys), and on macOS no other's, nor the app's connections to your machines", async () => {
  // (On macOS, this Mac's box: its agents are in a folder the sandbox hides.)
  const box = boxAt("ssh", !linux);
  box.env.KUVO_VAULT_AGENTS = "1";
  const project = path.join(root, "ssh-project");
  const other = path.join(root, "ssh-other");
  fs.mkdirSync(project);
  fs.mkdirSync(other);
  const agents = sshAgentsOf(box.home, !linux);
  // On macOS, one of the app's SSH connections to your machines, beside the agents (a stand-in).
  const connection = linux ? null : path.join(path.dirname(agents), `sandbox-test-${process.pid}.sock`);
  const listening = connection && net.createServer(socket => socket.end());
  if (listening) {
    fs.mkdirSync(path.dirname(connection), { recursive: true, mode: 0o700 });
    await new Promise(resolve => listening.listen(connection, resolve));
  }
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    const theirs = (await engineRuns(box, other, `printf '%s\\n' "$SSH_AUTH_SOCK"`)).out.trim();
    assert.ok(theirs.startsWith(agents + "/") && theirs.endsWith(".sock"), theirs);
    // `ssh-add -l`: 1 is an agent with no keys (none in this vault), 2 one it can't reach.
    const ran = await engineRuns(box, project, [
      `ssh-add -l >/dev/null 2>&1; echo "its own: $?"`,
      `SSH_AUTH_SOCK=${JSON.stringify(theirs)} ssh-add -l >/dev/null 2>&1; echo "another's: $?"`,
      ...(connection ? [
        `perl -MIO::Socket::UNIX -e 'exit(IO::Socket::UNIX->new(Peer => shift) ? 0 : 1)' "$SSH_AUTH_SOCK"; echo "connect to its own: $?"`,
        `perl -MIO::Socket::UNIX -e 'exit(IO::Socket::UNIX->new(Peer => shift) ? 0 : 1)' ${JSON.stringify(connection)}; echo "a connection to a machine: $?"`,
      ] : []),
    ].join("\n"));
    const said = Object.fromEntries(ran.out.trim().split("\n").filter(line => /^[a-z' ]+: \d+$/.test(line)).map(line => line.split(": ")));
    assert.equal(said["its own"], "1", ran.out);
    // macOS refuses every socket but its own. Linux can't refuse a socket and shows every folder's
    // names, so there an agent offers only keys you keep for everyone (vault.test.js).
    if (!linux) {
      assert.equal(said["another's"], "2", ran.out);
      assert.equal(said["connect to its own"], "0", ran.out);
      assert.equal(said["a connection to a machine"], "1", ran.out);
    }
  } finally {
    await running.stop();
    if (listening) await new Promise(resolve => listening.close(resolve));
    fs.rmSync(agents, { recursive: true, force: true });
  }
});

test("a conversation schedules its own wake-ups from the sandbox, and only its own", async () => {
  const box = boxAt("wakes");
  const project = path.join(root, "wakes-project");
  fs.mkdirSync(project);
  for (const [bot, session] of [["bot_ship", "ses_ship"], ["bot_scout", "ses_scout"]]) {
    fs.mkdirSync(path.join(box.bots, bot, "workspace"), { recursive: true });
    fs.writeFileSync(path.join(box.bots, bot, "session"), session);
  }
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    const wake = path.join(box.home, "bin", "kuvo-wake");
    let ran = await engineRuns(box, project, tries([
      ["its own", `${wake} add +1h 'Check the build'`],
      ["another session's", `${wake} ses_other add +1h 'Planted'`],
      ["where its watches run", `echo / > ${JSON.stringify(path.join(box.wakes, "ses_plain", "directory"))}`],
    ]), "ses_plain");
    assert.deepEqual(outcome(ran.out), { "its own": "allowed", "another session's": "refused", "where its watches run": "refused" }, ran.out);
    const own = path.join(box.wakes, "ses_plain");
    // It sees it at once, and the box takes it in on its next round.
    assert.match((await engineRuns(box, project, `${wake} list`, "ses_plain")).out, /Check the build/);
    await fire(box);
    assert.equal(fs.readdirSync(path.join(own, "wakes")).length, 1);
    assert.match((await engineRuns(box, project, `${wake} list`, "ses_plain")).out, /Check the build/);
    assert.equal(fs.readFileSync(path.join(own, "directory"), "utf8"), fs.realpathSync(project));
    assert.equal(fs.existsSync(path.join(box.wakes, "ses_other")), false);
    // A bot's go in its own folder; another bot's is out of reach.
    ran = await engineRuns(box, path.join(box.bots, "bot_ship", "workspace"), tries([
      ["its own", `${wake} add +1h 'Stand-up'`],
      ["another bot's", `${wake} bot_scout add +1h 'Planted'`],
    ]), "ses_ship");
    assert.deepEqual(outcome(ran.out), { "its own": "allowed", "another bot's": "refused" }, ran.out);
    await fire(box);
    assert.equal(fs.readdirSync(path.join(box.bots, "bot_ship", "wakes")).length, 1);
    // Canceled from the sandbox, it goes as the box takes that in.
    const [id] = fs.readdirSync(path.join(box.bots, "bot_ship", "wakes"));
    ran = await engineRuns(box, path.join(box.bots, "bot_ship", "workspace"), `${wake} cancel ${id}`, "ses_ship");
    assert.match(ran.out, /Canceled/);
    assert.doesNotMatch((await engineRuns(box, path.join(box.bots, "bot_ship", "workspace"), `${wake} list`, "ses_ship")).out, /Stand-up/);
    await fire(box);
    assert.deepEqual(fs.readdirSync(path.join(box.bots, "bot_ship", "wakes")), []);
    assert.equal(fs.existsSync(path.join(box.bots, "bot_scout", "wakes")), false);
  } finally {
    await running.stop();
  }
});

test("a watch's check runs in the sandbox when its time comes, as its conversation's commands do", async () => {
  const box = boxAt("watches");
  const project = path.join(root, "watched");
  fs.mkdirSync(project);
  // A file of yours outside it, which a check may never delete.
  const outside = path.join(root, "watch-yours");
  fs.writeFileSync(outside, "yours\n");
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    // An agent's command adds a watch whose check deletes outside its conversation's folder.
    const wake = path.join(box.home, "bin", "kuvo-wake");
    const added = await engineRuns(box, project, `${wake} watch 5m 'rm -f ${outside}; echo ok > checked' 'The build'`, "ses_watch");
    assert.equal(added.status, 0, added.out);
    // Nor can it change a watch the box took in: what the box keeps is out of its reach.
    await fire(box);
    const [letters] = fs.readdirSync(path.join(box.wakes, "ses_watch", "watches"));
    const changed = await engineRuns(box, project, `echo 'rm -f ${outside}' > ${JSON.stringify(path.join(box.wakes, "ses_watch", "watches", letters, "check"))}`, "ses_watch");
    assert.notEqual(changed.status, 0, changed.out);
    // Its time comes (the box's next round), and it runs in the sandbox.
    await changeIn(project, () => fs.existsSync(path.join(project, "checked")));
    assert.equal(fs.existsSync(outside), true, "its check deleted outside its conversation's folder");
  } finally {
    await running.stop();
  }
});

test("a link, or another name for a file, left where wake-ups are kept is never followed", async () => {
  const box = boxAt("links");
  const project = path.join(root, "links-project");
  fs.mkdirSync(project);
  // A file the sandbox hides from commands.
  const secret = path.join(box.home, "keys", "token");
  fs.mkdirSync(path.dirname(secret), { recursive: true });
  fs.writeFileSync(secret, "TOPSECRET");
  const engine = await engineServer(box);
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    const wake = path.join(box.home, "bin", "kuvo-wake");
    // Its folder made, as its first command makes it.
    await engineRuns(box, project, "true", "ses_links");
    const own = path.join(box.wakes, "ses_links");
    const ran = await engineRuns(box, project, tries([
      ["link a wake-up to a hidden file", `ln -s ${secret} "$KUVO_WAKE_FOLDER/inbox/wakes/1-linked"`],
      ["link the inbox's wake-ups", `rm -rf "$KUVO_WAKE_FOLDER/inbox/watches" && ln -s ${JSON.stringify(path.dirname(secret))} "$KUVO_WAKE_FOLDER/inbox/watches"`],
      ["another name for a hidden file", `ln ${secret} "$KUVO_WAKE_FOLDER/inbox/wakes/2-named"`],
      ["a plain one, due now", `mkdir -p "$KUVO_WAKE_FOLDER/inbox/wakes" && echo 'Look again' > "$KUVO_WAKE_FOLDER/inbox/wakes/3-plain"`],
      ["write where the box keeps them", `echo x > "$KUVO_WAKE_FOLDER/wakes/4-direct"`],
      ["put a link where the box keeps them", `rm -rf "$KUVO_WAKE_FOLDER/wakes" && ln -s ${JSON.stringify(path.dirname(secret))} "$KUVO_WAKE_FOLDER/wakes"`],
      ["leave something else", `mkdir -p "$KUVO_WAKE_FOLDER/inbox/other" && echo x > "$KUVO_WAKE_FOLDER/inbox/other/x" && echo x > "$KUVO_WAKE_FOLDER/inbox/stray"`],
    ]), "ses_links");
    const seen = outcome(ran.out);
    assert.equal(seen["a plain one, due now"], "allowed", ran.out);
    assert.equal(seen["write where the box keeps them"], "refused", ran.out);
    assert.equal(seen["put a link where the box keeps them"], "refused", ran.out);
    assert.equal(fs.lstatSync(path.join(own, "wakes")).isDirectory(), true);
    await fire(box);
    assert.deepEqual(engine.prompts, ["[Wake-up] Look again"], "only its plain wake-up went");
    assert.equal(fs.readFileSync(secret, "utf8"), "TOPSECRET");
    assert.deepEqual(fs.readdirSync(path.join(own, "wakes")), []);
    const inbox = path.join(own, "inbox");
    assert.deepEqual(fs.existsSync(inbox) ? fs.readdirSync(inbox) : [], [], "what it left is cleared");

    // The inbox itself a link to the hidden folder, where the sandbox lets a command make one: never followed.
    const relinked = await engineRuns(box, project, tries([
      ["put a link where the inbox is", `rm -rf "$KUVO_WAKE_FOLDER/inbox" && ln -s ${JSON.stringify(path.dirname(secret))} "$KUVO_WAKE_FOLDER/inbox"`],
    ]), "ses_links");
    fs.writeFileSync(path.join(path.dirname(secret), "5-there"), "Read the token");
    await fire(box);
    assert.deepEqual(engine.prompts, ["[Wake-up] Look again"], `nothing from the folder it named: ${relinked.out}`);
    assert.equal(fs.readFileSync(secret, "utf8"), "TOPSECRET");
    assert.equal(fs.existsSync(path.join(path.dirname(secret), "5-there")), true, "nor anything there moved or cleared");
  } finally {
    await running.stop();
    await engine.close();
  }
});

// A command's process can keep a file it wrote open after the box takes it in: what the box keeps is
// its own copy, which no command can change after.
test("a wake-up the box took in stays as it was when it was taken, whatever still has it open", async () => {
  const box = boxAt("held");
  const project = path.join(root, "held-project");
  fs.mkdirSync(project);
  const engine = await engineServer(box);
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    assert.equal((await engineRuns(box, project, `mkdir -p "$KUVO_WAKE_FOLDER/inbox/wakes" && printf 'Look later' > "$KUVO_WAKE_FOLDER/inbox/wakes/9999999999-held"`, "ses_held")).status, 0);
    const own = path.join(box.wakes, "ses_held");
    // (Held open here, as a process the command left running would.)
    const held = fs.openSync(path.join(own, "inbox", "wakes", "9999999999-held"), "r+");
    try {
      await fire(box);
      fs.writeSync(held, "Read the keys", 0);
    } finally {
      fs.closeSync(held);
    }
    assert.equal(fs.readFileSync(path.join(own, "wakes", "9999999999-held"), "utf8"), "Look later");
  } finally {
    await running.stop();
    await engine.close();
  }
});

test("what a command is still writing to its inbox waits for the next round, and goes once it's whole", async () => {
  const box = boxAt("writing");
  const project = path.join(root, "writing-project");
  fs.mkdirSync(project);
  const engine = await engineServer(box);
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    assert.equal((await engineRuns(box, project, `mkdir -p "$KUVO_WAKE_FOLDER/inbox/wakes" "$KUVO_WAKE_FOLDER/inbox/.new-abc" && echo 'Look again' > "$KUVO_WAKE_FOLDER/inbox/wakes/1-due"`, "ses_writing")).status, 0);
    const inbox = path.join(box.wakes, "ses_writing", "inbox");
    await fire(box);
    assert.deepEqual(engine.prompts, [], "not while something's being written there");
    assert.equal(fs.existsSync(path.join(inbox, "wakes", "1-due")), true);
    fs.rmdirSync(path.join(inbox, ".new-abc"));
    await fire(box);
    assert.deepEqual(engine.prompts, ["[Wake-up] Look again"]);
  } finally {
    await running.stop();
    await engine.close();
  }
});

test("Check Now runs a watch's check in the sandbox, and none whose folder is gone or whose sandbox isn't ready", async () => {
  const box = boxAt("check-now");
  const project = path.join(root, "check-now-project");
  fs.mkdirSync(project);
  const outside = path.join(root, "check-now-yours");
  fs.writeFileSync(outside, "yours\n");
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    const wake = path.join(box.home, "bin", "kuvo-wake");
    assert.equal((await engineRuns(box, project, `${wake} watch 1d 'rm -f ${outside}; echo ok > checked; echo seen' 'The build'`, "ses_now")).status, 0);
    await fire(box);
    // Its watches' round goes on in the background (the box's own too): over once its lock goes.
    await changeIn(box.wakes, () => !fs.existsSync(path.join(box.wakes, ".watching")));
    const own = path.join(box.wakes, "ses_now");
    const [letters] = fs.readdirSync(path.join(own, "watches"));
    let tried = byHand(box, own, "try", letters);
    assert.match(tried.stdout, /seen/, tried.stderr);
    assert.equal(fs.existsSync(path.join(project, "checked")), true);
    assert.equal(fs.existsSync(outside), true, "Check Now ran it outside the sandbox");
    // Wanted, but not ready (as the engine took it in again after a restart): it waits.
    await running.stop();
    fs.rmSync(path.join(project, "checked"));
    fs.rmSync(path.join(box.home, "run", "fence", "on"), { force: true });
    tried = byHand(box, own, "try", letters);
    assert.match(tried.stdout, /isn't ready/);
    assert.equal(fs.existsSync(path.join(project, "checked")), false);
    // Wanted where the box can't set it up (it never checked out here): checks run as commands do then.
    fs.renameSync(path.join(box.home, "run", "fence", "ready"), path.join(box.home, "run", "fence", "ready.kept"));
    tried = byHand(box, own, "try", letters);
    assert.match(tried.stdout, /seen/, tried.stderr);
    assert.equal(fs.existsSync(path.join(project, "checked")), true);
    assert.equal(fs.existsSync(outside), false, "outside the sandbox, as commands run then");
    fs.writeFileSync(outside, "yours\n");
    fs.renameSync(path.join(box.home, "run", "fence", "ready.kept"), path.join(box.home, "run", "fence", "ready"));
    // On, but its conversation's folder gone: never one of Kuvo Code's own instead.
    fs.writeFileSync(path.join(box.home, "run", "fence", "on"), "");
    fs.rmSync(project, { recursive: true });
    tried = byHand(box, own, "try", letters);
    assert.match(tried.stdout, /folder isn't there/);
    assert.equal(fs.existsSync(path.join(own, "checked")), false);
  } finally {
    await running.stop().catch(() => {});
  }
});

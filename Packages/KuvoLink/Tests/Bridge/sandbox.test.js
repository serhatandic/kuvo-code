// Agents' commands in the sandbox (PROTOCOL.md, "Sandbox"): off until you turn it on; on, each
// command the engine runs writes only in its conversation's folder (and that folder's git
// repository, but never what git runs on its own), and can't read Kuvo Code's own folders, another
// bot's, or your secrets. The engine is a stand-in here, as far as it goes: it loads the box's real
// plugin and runs a command as the engine does, through the shell the plugin gives it, with the
// environment the plugin set. The sandbox itself is the system's own (macOS's, Linux's Landlock).
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/sandbox.test.js`; on Linux, with Bun (the
// engine's: `BUN_BE_BUN=1 <engine> test sandbox.test.js`).
import { test, after } from "node:test";
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

// In the folder tests keep in your home (not the temporary folders, which commands may write), so
// what a command mustn't write is somewhere it otherwise couldn't.
fs.mkdirSync(path.join(os.homedir(), ".kuvo-code-test"), { recursive: true });
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".kuvo-code-test", "sb-")));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const linux = process.platform === "linux";
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
async function start(box, env = {}) {
  const child = spawn(process.execPath, [script, "serve"], { env: { ...box.env, ...env, OPENCODE_PASSWORD: "box-pw" }, stdio: ["pipe", "pipe", "pipe"] });
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
// shell its plugins give it, with the environment they set, then the conversation's (`session`,
// as the engine names it after its plugins). With no plugin of the sandbox's, as before.
async function engineRuns(box, folder, command, session) {
  const input = { command, cwd: folder, timeout: 0, shell: "/bin/sh", env: { PATH: process.env.PATH, HOME: root, KUVO_BOTS: box.bots, KUVO_WAKES: box.wakes } };
  if (fs.existsSync(box.plugin)) {
    const plugin = (await import(`${pathToFileURL(box.plugin)}?${Math.random()}`)).default;
    let hook;
    await plugin.setup({ location: { directory: folder }, shell: { hook: async (name, take) => { assert.equal(name, "create.before"); hook = take; } } });
    hook(input);
    // (The plugin names the engine's runtime, its own: here that's this test's, so on Linux,
    // without Bun, the Bun this box's engine is.)
    if (linux && !process.versions.bun) input.env.KUVO_FENCE_RUNTIME = path.join(box.home, "engine", "test", "opencode");
  }
  if (session) input.env.OPENCODE_SESSION_ID = session;
  const run = spawnSync(input.shell, ["-c", input.command], { cwd: input.cwd, env: input.env, encoding: "utf8" });
  return { status: run.status, out: run.stdout + run.stderr };
}

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
    const runtime = `BUN_BE_BUN=1 ${JSON.stringify(process.execPath)}`;
    const straight = `const s = require("net").createConnection(${JSON.stringify(path.join(box.home, "run", "vault.sock"))}); let h = ""; s.on("connect", () => s.write(JSON.stringify({ hello: "x" }) + "\\n")); s.on("data", c => { h += c; s.destroy(); }); s.on("error", () => process.exit(1)); s.on("close", () => process.exit(h ? 0 : 1));`;
    const fill = JSON.stringify({ method: "POST", path: "kuvo/vault/fill", body: Buffer.from("{}").toString("base64") });
    const ran = await engineRuns(box, project, tries([
      ["run its runtime", `${runtime} -e 'process.exit(0)'`],
      ["read the box's sockets' key", `cat ${JSON.stringify(keyFile)}`],
      ["reach the vault's socket", `${runtime} -e '${straight}'`],
      ["reach the vault through the box", `out=$(echo '${fill}' | KUVO_HOME=${JSON.stringify(box.home)} ${runtime} ${JSON.stringify(script)} box route 2>/dev/null); case $out in *'"status":503'*) false ;; *) true ;; esac`],
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

test("Claude Code's commands, run with the box's shell for it as Claude Code runs them, are in the sandbox, and a worktree commits", async () => {
  const box = boxAt("claude");
  const repository = path.join(root, "claude-repo");
  const project = path.join(root, "claude-tree");
  assert.equal(spawnSync("git", ["init", "-q", repository]).status, 0);
  assert.equal(spawnSync("git", ["-C", repository, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]).status, 0);
  assert.equal(spawnSync("git", ["-C", repository, "worktree", "add", "-q", project]).status, 0);
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    // What the coding agents' bridge gives Claude Code (agents/fence.ts): the shell, by its name, the
    // conversation's folder and repository, and the commands' temporary folder for its own notes.
    const fence = path.join(box.home, "run", "fence");
    const shell = ["zsh", "bash"].map(name => path.join(fence, "shell", name)).find(place => fs.existsSync(place));
    assert.ok(shell, "the box wrote a shell for Claude Code");
    const temporary = path.join(fence, "tmp", crypto.createHash("sha256").update(project).digest("hex").slice(0, 32));
    fs.mkdirSync(path.join(temporary, "claude-1"), { recursive: true, mode: 0o700 });
    const env = { PATH: process.env.PATH, HOME: root, KUVO_FENCE_WORK: project, KUVO_FENCE_GIT: path.join(repository, ".git"), OPENCODE_SESSION_ID: "ses_claudeTest" };
    // Each command as Claude Code sends it: its snapshot (which may not be there), the command, then
    // where it ended up, noted in its temporary folder.
    const cwd = path.join(temporary, "claude-1", "claude-7-cwd");
    const claudeRuns = command => spawnSync(shell, ["-c", `source ${JSON.stringify(path.join(box.home, "agents", "snapshot.sh"))} 2>/dev/null || true && eval '${command.replace(/'/g, "'\\''")}' < /dev/null && pwd -P >| ${JSON.stringify(cwd)}`], { cwd: project, env, encoding: "utf8" });
    const ran = claudeRuns(tries([
      ["write in its project", "echo ok > made.txt"],
      ["commit in its worktree", "git add made.txt && git -c user.name=t -c user.email=t@t commit -qm made"],
      ["read the box's files", `cat ${JSON.stringify(path.join(box.home, "run", "engine.json"))}`],
      ["write outside its project", `echo x > ${JSON.stringify(path.join(root, "planted"))}`],
      ["add a git hook", `echo x > ${JSON.stringify(path.join(repository, ".git", "hooks", "pre-commit"))}`],
    ]));
    assert.deepEqual(outcome(ran.stdout), {
      "write in its project": "allowed", "commit in its worktree": "allowed", "read the box's files": "refused",
      "write outside its project": "refused", "add a git hook": linux ? "allowed" : "refused",
    }, ran.stdout + ran.stderr);
    assert.equal(spawnSync("git", ["-C", repository, "log", "--all", "--format=%s"], { encoding: "utf8" }).stdout.includes("made"), true);
    // Claude Code learns where a cd took the command.
    assert.equal(claudeRuns("cd ..").status, 0);
    assert.equal(fs.readFileSync(cwd, "utf8").trim(), root);
    assert.equal(fs.existsSync(path.join(root, "planted")), false);
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
      assert.match(told, /use `pgrep -fl` or `lsof`/);
      // What it tells them holds: ps is refused, pgrep works.
      const ran = await engineRuns(box, project, tries([["ps", "ps -ax"], ["pgrep", "pgrep -fl sh"]]));
      assert.deepEqual(outcome(ran.out), { ps: "refused", pgrep: "allowed" }, ran.out);
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

test("a .git that names another folder doesn't let a command write there", async () => {
  const box = boxAt("git-redirect");
  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(elsewhere);
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
      const ran = await engineRuns(box, project, tries([["write where its .git points", `echo x > ${JSON.stringify(path.join(elsewhere, "planted"))}`]]));
      assert.deepEqual(outcome(ran.out), { "write where its .git points": "refused" }, `${path.basename(project)}: ${ran.out}`);
    }
    assert.equal(fs.existsSync(path.join(elsewhere, "planted")), false);
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
    const runtime = `BUN_BE_BUN=1 ${JSON.stringify(process.execPath)}`;
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
  const agents = sshAgentsOf(box.home);
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
  const outside = path.join(root, "watch-escaped");
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    // An agent's command adds a watch whose check writes outside its conversation's folder.
    const wake = path.join(box.home, "bin", "kuvo-wake");
    const added = await engineRuns(box, project, `${wake} watch 5m 'echo planted > ${outside}; echo ok > checked' 'The build'`, "ses_watch");
    assert.equal(added.status, 0, added.out);
    // Nor can it change a watch the box took in: what the box keeps is out of its reach.
    await fire(box);
    const [letters] = fs.readdirSync(path.join(box.wakes, "ses_watch", "watches"));
    const changed = await engineRuns(box, project, `echo 'echo planted > ${outside}' > ${JSON.stringify(path.join(box.wakes, "ses_watch", "watches", letters, "check"))}`, "ses_watch");
    assert.notEqual(changed.status, 0, changed.out);
    // Its time comes (the box's next round), and it runs in the sandbox.
    await changeIn(project, () => fs.existsSync(path.join(project, "checked")));
    assert.equal(fs.existsSync(outside), false, "its check wrote outside its conversation's folder");
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
  const outside = path.join(root, "check-now-escaped");
  const running = await start(box);
  try {
    assert.equal((await running.ask("GET", "kuvo/sandbox")).value.able, true);
    const wake = path.join(box.home, "bin", "kuvo-wake");
    assert.equal((await engineRuns(box, project, `${wake} watch 1d 'echo planted > ${outside}; echo ok > checked; echo seen' 'The build'`, "ses_now")).status, 0);
    await fire(box);
    // Its watches' round goes on in the background (the box's own too): over once its lock goes.
    await changeIn(box.wakes, () => !fs.existsSync(path.join(box.wakes, ".watching")));
    const own = path.join(box.wakes, "ses_now");
    const [letters] = fs.readdirSync(path.join(own, "watches"));
    let tried = byHand(box, own, "try", letters);
    assert.match(tried.stdout, /seen/, tried.stderr);
    assert.equal(fs.existsSync(path.join(project, "checked")), true);
    assert.equal(fs.existsSync(outside), false, "Check Now ran it outside the sandbox");
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
    fs.rmSync(outside, { force: true });
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

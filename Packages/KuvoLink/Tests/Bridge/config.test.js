// A box's own engine settings (PROTOCOL.md, "kuvo/config" and "kuvo/config/apply"): this Mac's,
// read and written where the app's engine has always kept them, and a change made on another
// computer made on this one too ("Also Apply to…"). Run with
// `node --test Packages/KuvoLink/Tests/Bridge/*.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { removeAtEnd } from "./at-end.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-config-"));
const home = path.join(root, "machine");
process.env.KUVO_HOME = home;
removeAtEnd(root);
const script = new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url);
const link = await import(script);

const auth = `Basic ${Buffer.from("opencode:pw").toString("base64")}`;
const rule = (resource, effect = "deny") => ({ action: "shell", resource, effect });
const catalog = { macOnly: ["apple-events", "chrome-devtools"], servers: [
  { id: "context7", title: "Context7", summary: "Docs", access: "open", settings: { type: "remote", url: "https://mcp.context7.com/mcp" } },
  { id: "chrome-devtools", title: "Chrome DevTools", summary: "Chrome", access: "local", macOnly: true, settings: { type: "local", command: ["kuvo-npx", "chrome-devtools-mcp"] } },
] };

// This Mac's box, started as the app starts it: its settings in the engine's folder, its keys'
// files where the app writes them.
// `folder`: one started before (it starts again there); `defaultsAdded`: as one that added its
// defaults before; `settings`: the file's text before it starts.
async function macBox(t, { folder = fs.mkdtempSync(path.join(root, "mac-")), defaultsAdded = true, settings } = {}) {
  const box = path.join(folder, "box");
  const config = path.join(folder, "opencode", "config");
  const keys = path.join(folder, "integration-keys");
  fs.mkdirSync(path.join(box, "bin"), { recursive: true });
  fs.writeFileSync(path.join(box, "bin", "mcp-catalog.json"), JSON.stringify(catalog));
  if (defaultsAdded) {
    fs.mkdirSync(path.join(box, "box"), { recursive: true });
    fs.writeFileSync(path.join(box, "box", "defaults-added"), "bot-memory\nwebsearch\nsearch-exa\n");
  }
  if (settings !== undefined) {
    fs.mkdirSync(path.join(config, "opencode"), { recursive: true });
    fs.writeFileSync(path.join(config, "opencode", "opencode.json"), settings);
  }
  const child = spawn(process.execPath, [script.pathname, "serve"], {
    env: { ...process.env, KUVO_HOME: box, KUVO_BOX: "mac", KUVO_ENGINE_CONFIG: config, KUVO_KEYS: keys, OPENCODE_PASSWORD: "pw" }, stdio: ["pipe", "pipe", "inherit"],
  });
  t.after(() => child.kill());
  let out = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) {
    out += chunk;
    if (out.includes("\n")) break;
  }
  const url = JSON.parse(out.split("\n")[0]).url;
  const ask = async (method, route, body) => {
    const response = await fetch(`${url}/${route}`, { method, headers: { authorization: auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : undefined };
  };
  const stop = async () => {
    child.kill();
    await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", resolve));
  };
  return { ask, file: path.join(config, "opencode", "opencode.json"), keys, folder, stop };
}

test("this Mac's box adds web search and bots' memory rule as it starts, once: taken out, they stay out", async t => {
  const first = await macBox(t, { defaultsAdded: false, settings: JSON.stringify({ model: "a/b", websearch: { provider: "random" } }) });
  const read = (await first.ask("GET", "kuvo/config")).json;
  assert.deepEqual(read.websearch, { provider: "random" }, "chosen already: left as it is the first time");
  assert.deepEqual(read.permissions, [link.BOT_MEMORY_RULE]);
  await first.ask("PATCH", "kuvo/config", { changes: [{ path: ["permissions"], value: null }] });
  await first.stop();
  // Again: nothing put back.
  const again = await macBox(t, { folder: first.folder, defaultsAdded: false });
  assert.deepEqual((await again.ask("GET", "kuvo/config")).json, { model: "a/b", websearch: { provider: "random" } });
  await again.stop();
  // New settings (none yet): web search through Exa.
  const fresh = await macBox(t, { defaultsAdded: false });
  assert.deepEqual((await fresh.ask("GET", "kuvo/config")).json, { websearch: { provider: "exa" }, permissions: [link.BOT_MEMORY_RULE] });
  // One that added them before boxes did (noted): "random" moves to Exa once, nothing else added.
  const older = fs.mkdtempSync(path.join(root, "mac-"));
  fs.mkdirSync(path.join(older, "box", "box"), { recursive: true });
  fs.writeFileSync(path.join(older, "box", "box", "defaults-added"), "bot-memory\nwebsearch\n");
  const moved = await macBox(t, { folder: older, defaultsAdded: false, settings: JSON.stringify({ websearch: { provider: "random" } }) });
  assert.deepEqual((await moved.ask("GET", "kuvo/config")).json, { websearch: { provider: "exa" } });
});

test("a settings file that can't be read is said to be, never taken for an empty one", async t => {
  const { ask, file, folder } = await macBox(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A link to a file that isn't there (a dotfiles folder on a drive that's away).
  fs.symlinkSync(path.join(folder, "away", "opencode.json"), file);
  const away = await ask("GET", "kuvo/config");
  assert.equal(away.status, 409);
  assert.match(away.json.problem, /link to a file that isn't there/);
  assert.equal((await ask("PATCH", "kuvo/config", { changes: [{ path: ["model"], value: "a/b" }] })).status, 409);
  assert.equal(fs.existsSync(path.join(folder, "away")), false, "nothing made where it points");
  fs.rmSync(file);
  // One it may not read.
  fs.writeFileSync(file, JSON.stringify({ model: "a/b" }));
  fs.chmodSync(file, 0o000);
  t.after(() => fs.chmodSync(file, 0o600));
  const shut = await ask("GET", "kuvo/config");
  assert.equal(shut.status, 409);
  assert.match(shut.json.problem, /couldn't be read/);
  assert.equal((await ask("PATCH", "kuvo/config", { changes: [{ path: ["model"], value: "c/d" }] })).status, 409);
});

test("this Mac's box reads and writes the Mac's own settings file where it is, its own from the start", async t => {
  const { ask, file } = await macBox(t);
  // None yet: nothing set, and the first change makes the file.
  assert.deepEqual(await ask("GET", "kuvo/config"), { status: 200, json: {} });
  const changed = await ask("PATCH", "kuvo/config", { changes: [{ path: ["model"], value: "anthropic/sonnet" }, { path: ["compaction", "auto"], value: false }] });
  assert.equal(changed.status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { compaction: { auto: false }, model: "anthropic/sonnet" });
  // Taking out a setting takes out what it leaves empty.
  await ask("PATCH", "kuvo/config", { changes: [{ path: ["compaction", "auto"], value: null }] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { model: "anthropic/sonnet" });
  // Edited by hand meanwhile: read as it is now.
  fs.writeFileSync(file, JSON.stringify({ model: "openai/luna", theme: "dark" }));
  assert.deepEqual((await ask("GET", "kuvo/config")).json, { model: "openai/luna", theme: "dark" });
});

test("a link to the Mac's settings file (a dotfiles folder) is written through, and stays a link", async t => {
  const { ask, file, folder } = await macBox(t);
  const real = path.join(folder, "dotfiles", "opencode.json");
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, "{}");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.symlinkSync(real, file);
  assert.equal((await ask("PATCH", "kuvo/config", { changes: [{ path: ["model"], value: "openai/luna" }] })).status, 200);
  assert.ok(fs.lstatSync(file).isSymbolicLink());
  assert.equal(JSON.parse(fs.readFileSync(real, "utf8")).model, "openai/luna");
});

test("a Mac's settings file with comments is left alone, and says why on its own", async t => {
  const { ask, file } = await macBox(t);
  const original = "{\n  // my model\n  \"model\": \"anthropic/sonnet\"\n}\n";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, original);
  const read = await ask("GET", "kuvo/config");
  assert.equal(read.status, 409);
  assert.match(read.json.message, /^The engine's settings file can't be changed from here: /);
  assert.equal(read.json.problem, "It isn't plain JSON, so Kuvo Code leaves it alone. (Comments aren't supported here.)");
  const changed = await ask("PATCH", "kuvo/config", { changes: [{ path: ["model"], value: "openai/luna" }] });
  assert.equal(changed.status, 409);
  assert.equal(changed.json.problem, read.json.problem);
  assert.equal((await ask("POST", "kuvo/config/apply", { changes: [{ path: ["model"], after: "openai/luna" }] })).status, 409);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("a key applied from another computer is named where this Mac's engine reads its keys", async t => {
  const { ask, keys } = await macBox(t);
  const server = { type: "local", environment: { API_KEY: "{file:~/.kuvo-code/box/keys/KUVO_KEY_TODOIST_API_KEY}" } };
  const changed = await ask("PATCH", "kuvo/config", { changes: [{ path: ["mcp", "servers", "todoist"], value: server }] });
  assert.equal(changed.json.mcp.servers.todoist.environment.API_KEY, `{file:${keys}/KUVO_KEY_TODOIST_API_KEY}`);
});

test("this Mac's popular servers include those that use its own apps, which it adds", async t => {
  const { ask } = await macBox(t);
  const listed = (await ask("GET", "kuvo/mcp/catalog")).json.servers;
  assert.deepEqual(listed.map(server => [server.id, server.macOnly]), [["context7", false], ["chrome-devtools", true]]);
  const added = await ask("POST", "kuvo/mcp/catalog/chrome-devtools");
  assert.equal(added.status, 200);
  assert.deepEqual(added.json.mcp.servers["chrome-devtools"], { codemode: false, type: "local", command: ["kuvo-npx", "chrome-devtools-mcp"] });
});

// MARK: Also Apply

// What `changes` (as {path, before, after}) make of `settings` on a machine (`mac: false`) or a Mac.
const onto = (changes, settings = {}, mac = false) => link.translateSettings(changes, settings, { mac, macOnly: new Set(catalog.macOnly) });

test("a rule added on another computer joins this one's own; one taken out goes here too", () => {
  const added = onto([{ path: ["permissions"], before: [rule("rm *")], after: [rule("rm *"), rule("git push *")] }], { permissions: [rule("docker *")] });
  assert.deepEqual(added.made, [{ path: ["permissions"], value: [rule("docker *"), rule("git push *")] }]);
  const removed = onto([{ path: ["permissions"], before: [rule("rm *"), rule("git push *")], after: [rule("git push *")] }], { permissions: [rule("rm *"), rule("docker *")] }, true);
  assert.deepEqual(removed.made[0].value, [rule("docker *")]);
});

test("the first rule and the last leave this computer's own, never stand in for them", () => {
  assert.deepEqual(onto([{ path: ["permissions"], after: [rule("git push *")] }], { permissions: [rule("docker *")] }).made[0].value, [rule("docker *"), rule("git push *")]);
  assert.deepEqual(onto([{ path: ["permissions"], before: [rule("git push *")] }], { permissions: [rule("docker *"), rule("git push *")] }).made[0].value, [rule("docker *")]);
  // Its only one, the same: none here either.
  assert.deepEqual(onto([{ path: ["permissions"], before: [rule("git push *")], after: null }], { permissions: [rule("git push *")] }).made, [{ path: ["permissions"], value: null }]);
  // An agent's own rules, and Settings › Permissions' blocks, the same way.
  assert.deepEqual(onto([{ path: ["agents", "build", "permissions"], after: [rule("a *")] }], { agents: { build: { permissions: [rule("b *")] } } }).made[0].value, [rule("b *"), rule("a *")]);
  assert.deepEqual(onto([{ path: ["policies"], after: [{ name: "x" }] }], { policies: [{ name: "y" }] }).made[0].value, [{ name: "y" }, { name: "x" }]);
});

test("another list (a server's command) goes as it is there, in its order; anything else is set as it is", () => {
  const command = { mcp: { servers: { tool: { command: ["node", "a.js", "--stdio"] } } } };
  assert.deepEqual(onto([{ path: ["mcp", "servers", "tool", "command"], before: ["node", "a.js", "--stdio"], after: ["node", "b.js", "--stdio"] }], command).made[0].value, ["node", "b.js", "--stdio"]);
  assert.deepEqual(onto([{ path: ["model"], after: "anthropic/sonnet" }]).made, [{ path: ["model"], value: "anthropic/sonnet" }]);
  assert.deepEqual(onto([{ path: ["snapshots"], before: true, after: false }]).made, [{ path: ["snapshots"], value: false }]);
});

test("an integration's key is named where this computer keeps its keys, and said, for the key to go first", () => {
  const server = { type: "local", environment: { TOKEN: "{file:/var/folders/x/T/run.kuvo.code/integration-keys/KUVO_KEY_GITHUB_TOKEN}" } };
  const { made } = onto([{ path: ["mcp", "servers", "github"], after: server }]);
  assert.match(made[0].value.environment.TOKEN, /^\{file:.*\/box\/keys\/KUVO_KEY_GITHUB_TOKEN\}$/);
});

test("what only a Mac runs stays off machines, and is said apart; another Mac runs it", () => {
  const server = { type: "local", command: ["kuvo-npx", "mcp-server-apple-events"] };
  const machine = onto([{ path: ["mcp", "servers", "apple-events"], after: server }]);
  assert.deepEqual(machine, { made: [], leftOut: [], kept: [], macOnly: ["apple-events"] });
  assert.equal(onto([{ path: ["mcp", "servers", "apple-events"], after: server }], {}, true).made.length, 1);
});

test("a field of something this computer doesn't have isn't made, and is said; a whole one added goes anywhere", () => {
  const server = { type: "local", command: ["x"] };
  assert.deepEqual(onto([{ path: ["mcp", "servers", "tools", "disabled"], after: true }]), { made: [], leftOut: [["mcp", "servers", "tools"]], kept: [], macOnly: [] });
  assert.deepEqual(onto([{ path: ["mcp", "servers", "tools", "disabled"], after: true }], { mcp: { servers: { tools: server } } }).made.map(change => change.path), [["mcp", "servers", "tools", "disabled"]]);
  assert.equal(onto([{ path: ["mcp", "servers", "tools"], after: server }]).made.length, 1);
  // An agent's model, a command's description, a provider's model: the same.
  const result = onto([
    { path: ["agents", "review", "model"], before: "a/b", after: "c/d" },
    { path: ["commands", "ship", "description"], after: "Ships" },
    { path: ["default_agent"], after: "review" },
    { path: ["providers", "acme", "models", "fast", "limit", "context"], after: 64000 },
  ]);
  assert.deepEqual(result.made, [], "nothing made with only a field, nor a mode it hasn't");
  assert.deepEqual(result.leftOut, [["agents", "review"], ["commands", "ship"], ["providers", "acme"]]);
  assert.deepEqual(onto([{ path: ["agents", "review", "model"], after: "c/d" }], { agents: { review: { mode: "subagent" } } }).made.map(change => change.path), [["agents", "review", "model"]]);
});

test("the engine's own agents are on every computer, named in its settings or not", () => {
  const result = onto([{ path: ["agents", "plan", "model"], after: "anthropic/sonnet" }, { path: ["agents", "title", "model"], after: "openai/mini" }, { path: ["default_agent"], after: "plan" }]);
  assert.deepEqual(result.made.map(change => change.path), [["agents", "plan", "model"], ["agents", "title", "model"], ["default_agent"]]);
  assert.deepEqual(result.leftOut, []);
});

test("what each computer keeps its own (its shell, a worktrees folder on its disk) stays, and is said", () => {
  const result = onto([{ path: ["shell"], after: "/bin/zsh" }, { path: ["worktree", "directory"], after: "/Users/me/worktrees" }]);
  assert.deepEqual(result, { made: [], leftOut: [], kept: [["shell"], ["worktree", "directory"]], macOnly: [] });
  assert.deepEqual(onto([{ path: ["worktree", "directory"], after: "../worktrees" }]).made.map(change => change.path), [["worktree", "directory"]]);
});

test("a machine applies what it's sent in one write, after a look first that writes nothing", async () => {
  const folder = path.join(home, "box");
  const file = path.join(folder, "opencode.json");
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(home, "bin", "mcp-catalog.json"), JSON.stringify(catalog));
  fs.writeFileSync(file, JSON.stringify({ permissions: [rule("docker *")], shell: "/bin/bash" }));
  const handle = link.engineHandler(() => { throw new Error("none"); });
  const ask = async (method, route, body) => {
    const parts = [];
    for await (const part of handle({ method, path: route, headers: {}, body: Buffer.from(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)) }, {}, undefined)) parts.push(part);
    const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
    return { status: parts[0].head.status, json: text ? JSON.parse(text) : undefined };
  };
  try {
    const changes = [
      { path: ["permissions"], before: [], after: [rule("git push *")] },
      { path: ["mcp", "servers", "github"], after: { type: "local", environment: { TOKEN: "{file:/x/KUVO_KEY_GITHUB_TOKEN}", BOT: "{file:/x/KUVO_KEY_GITHUB_TOKEN__BOT_A}" } } },
      { path: ["mcp", "servers", "chrome-devtools"], after: { type: "local" } },
      { path: ["shell"], after: "/bin/zsh" },
      { path: ["agents", "review", "model"], after: "a/b" },
    ];
    const before = fs.readFileSync(file, "utf8");
    const looked = await ask("POST", "kuvo/config/apply", { changes, dry: true });
    assert.equal(looked.status, 200);
    assert.deepEqual(looked.json.keys, ["KUVO_KEY_GITHUB_TOKEN"], "the shared key, not a bot's own");
    assert.deepEqual(looked.json.leftOut, [["agents", "review"]]);
    assert.deepEqual(looked.json.kept, [["shell"]]);
    assert.deepEqual(looked.json.macOnly, ["chrome-devtools"]);
    assert.equal(looked.json.applied, true);
    assert.equal(fs.readFileSync(file, "utf8"), before, "a look writes nothing");

    const applied = await ask("POST", "kuvo/config/apply", { changes });
    assert.equal(applied.status, 200);
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(written.permissions, [rule("docker *"), rule("git push *")]);
    assert.equal(written.shell, "/bin/bash", "its own shell stays");
    assert.equal(written.mcp.servers["chrome-devtools"], undefined);
    assert.match(written.mcp.servers.github.environment.TOKEN, /\/box\/keys\/KUVO_KEY_GITHUB_TOKEN\}$/);
    assert.deepEqual(applied.json.settings, written);

    // Nothing to make (only what it keeps its own): not applied, and nothing written.
    const own = await ask("POST", "kuvo/config/apply", { changes: [{ path: ["shell"], after: "/bin/zsh" }] });
    assert.deepEqual([own.status, own.json.applied, own.json.made], [200, false, []]);
    // Already so: applied.
    assert.equal((await ask("POST", "kuvo/config/apply", { changes: [{ path: ["permissions"], before: [], after: [rule("git push *")] }] })).json.applied, true);

    for (const bad of [{}, { changes: [] }, { changes: [{ path: [] }] }, "nope"]) {
      assert.equal((await ask("POST", "kuvo/config/apply", bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await ask("GET", "kuvo/config/apply")).status, 405);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
    fs.rmSync(path.join(home, "bin", "mcp-catalog.json"), { force: true });
  }
});

// The model your subagents use (Settings › Agents, "Subagents use"): the engine doesn't read it from
// your settings, so the box puts it on each subagent without a model of its own, in the settings
// file it keeps beside yours (which the engine reads after them, and again as it changes).
test("the model subagents use goes on the engine's subagents and yours without one, as the settings change", async t => {
  const { ask, file, folder } = await macBox(t, { settings: JSON.stringify({ agents: {
    reviewer: { mode: "subagent", description: "Reviews." },
    writer: { mode: "all", model: "openai/gpt-5" },
    Research: { mode: "primary" },
    resting: { mode: "subagent", disabled: true },
  } }) });
  const layerFile = path.join(folder, "opencode", "config", "opencode", "opencode.jsonc");
  const layer = () => {
    if (!fs.existsSync(layerFile)) return null;
    const text = fs.readFileSync(layerFile, "utf8");
    assert.ok(text.startsWith("// Kept by Kuvo Code"), "the box's own file");
    return JSON.parse(text.split("\n").filter(line => !line.startsWith("//")).join("\n"));
  };
  assert.equal(layer(), null, "nothing until it's set");

  const haiku = "anthropic/claude-haiku-4-5";
  assert.equal((await ask("PATCH", "kuvo/config", { changes: [{ path: ["subagent_model"], value: haiku }] })).status, 200);
  assert.deepEqual(layer().agents, { general: { model: haiku }, explore: { model: haiku }, reviewer: { model: haiku } },
    "a subagent with a model of its own keeps it; a mode, and one turned off, aren't subagents");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).subagent_model, haiku, "kept in your settings");

  // One taken away isn't named there any more (the engine would make it again).
  await ask("PATCH", "kuvo/config", { changes: [{ path: ["agents", "reviewer"], value: null }] });
  assert.deepEqual(Object.keys(layer().agents), ["general", "explore"]);
  // The engine's own, given a model of their own: theirs.
  await ask("PATCH", "kuvo/config", { changes: [{ path: ["agents", "general", "model"], value: "openai/gpt-5" }] });
  assert.deepEqual(Object.keys(layer().agents), ["explore"]);

  // A coding agent's model is for its own subagents: the engine can't run it, so its keep the conversation's.
  await ask("PATCH", "kuvo/config", { changes: [{ path: ["subagent_model"], value: "claude-code/haiku" }] });
  assert.equal(layer(), null);

  // Set by hand meanwhile: there once a client looks at the settings.
  fs.writeFileSync(file, JSON.stringify({ subagent_model: haiku }));
  await ask("GET", "kuvo/config");
  assert.deepEqual(layer().agents, { general: { model: haiku }, explore: { model: haiku } });
  // Back to the conversation's.
  await ask("PATCH", "kuvo/config", { changes: [{ path: ["subagent_model"], value: null }] });
  assert.equal(layer(), null);
});

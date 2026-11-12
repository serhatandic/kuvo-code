// Claude Code's agents and commands on a box's own computer (PROTOCOL.md, `kuvo/claude-code`): each
// box lists what's in its own ~/.claude, named as they'd come over to its settings and marked where
// they have them, with no Mac there. The real box; only its engine's list of commands is a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/claude-code.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-claude-code-"));
const user = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-claude-code-user-"));
removeAtEnd(home);
removeAtEnd(user);
process.env.KUVO_HOME = home;
process.env.HOME = user;
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

// The engine's commands: its own, and one a plugin brings, besides one in your settings.
const engine = http.createServer((request, response) => {
  if (request.url !== "/api/command") return response.writeHead(404).end();
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ name: "init" }, { name: "deploy" }, { name: "mine" }] }));
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => engine.close());

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

async function answer(handle, method, route) {
  const parts = [];
  for await (const part of handle({ method, path: route, headers: {}, body: Buffer.alloc(0) }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  return { status: parts[0].head.status, json: text ? JSON.parse(text) : undefined };
}

const claude = path.join(user, ".claude");
write(path.join(claude, "agents", "reviewer.md"), "---\nname: Code Reviewer\ndescription: \"Reviews code.\\nThoroughly.\"\n---\nYou review code.\n");
write(path.join(claude, "agents", "plan.md"), "---\ndescription: |\n  Plans\n  ahead\n---\nPlan first.\n");
write(path.join(claude, "agents", "notes.txt"), "not an agent");
write(path.join(claude, "commands", "frontend", "component.md"), "---\ndescription: A component\n---\nMake $ARGUMENTS.\n");
write(path.join(claude, "commands", "deploy.md"), "Ship it.\n");
write(path.join(claude, "commands", "init.md"), "Set up.\n");
write(path.join(claude, "commands", "mine.md"), "Mine.\n");
write(path.join(claude, "commands", "empty.md"), "---\ndescription: nothing after\n---\n");
// Imported already: this box's settings have it.
write(path.join(home, "box", "opencode.json"), JSON.stringify({ agents: { "code-reviewer": { mode: "subagent" } }, commands: { mine: { template: "Mine." } } }));

test("a machine lists Claude Code's agents and commands from its own ~/.claude, as they'd come over to its settings", async () => {
  const handle = link.engineHandler(() => ({ pid: process.pid, port: engine.address().port, password: "p" }));
  const { status, json } = await answer(handle, "GET", "kuvo/claude-code");
  assert.equal(status, 200);
  assert.deepEqual(json.agents, [
    { name: "Code Reviewer", description: "Reviews code.\nThoroughly.", path: ["agents", "code-reviewer"], settings: { mode: "subagent", description: "Reviews code.\nThoroughly.", system: "You review code." }, imported: true },
    // (One by an engine's own agent's name comes over beside it.)
    { name: "plan", description: "Plans\nahead", path: ["agents", "plan-claude"], settings: { mode: "subagent", description: "Plans\nahead", system: "Plan first." }, imported: false },
  ]);
  // Named so they take none of the engine's (its own, a plugin's), but yours stays yours; one with
  // nothing to say isn't one.
  assert.deepEqual(json.commands.map(command => [command.name, command.path, command.imported]), [
    ["deploy-claude", ["commands", "deploy-claude"], false],
    ["frontend-component", ["commands", "frontend-component"], false],
    ["init-claude", ["commands", "init-claude"], false],
    ["mine", ["commands", "mine"], true],
  ]);
  assert.deepEqual(json.commands[1].settings, { template: "Make $ARGUMENTS.", description: "A component" });
});

test("with its engine down it still lists them, the engine's own commands named apart", async () => {
  const handle = link.engineHandler(() => { throw new Error("not running"); });
  const { status, json } = await answer(handle, "GET", "kuvo/claude-code");
  assert.equal(status, 200);
  assert.deepEqual(json.commands.map(command => command.name), ["deploy", "frontend-component", "init-claude", "mine"]);
});

test("a computer with no ~/.claude has nothing to bring over; another's list, or a change, isn't asked here", async () => {
  const handle = link.engineHandler(() => ({ pid: process.pid, port: engine.address().port, password: "p" }));
  const saved = process.env.HOME;
  process.env.HOME = path.join(user, "nobody");
  try {
    assert.deepEqual(await answer(handle, "GET", "kuvo/claude-code"), { status: 200, json: { agents: [], commands: [] } });
  } finally {
    process.env.HOME = saved;
  }
  assert.equal((await answer(handle, "GET", "kuvo/claude-code?machine=lab")).status, 404);
  assert.equal((await answer(handle, "POST", "kuvo/claude-code")).status, 405);
});

// Claude Code's agents and commands on a box's own computer (PROTOCOL.md, `kuvo/claude-code`): each
// box lists what's in its own ~/.claude, named as they'd come over to its settings and marked where
// they have them, with no Mac there. The real box; only its engine's list of commands is a stand-in.
//
// Run with `node --test box/bridge-tests/claude-code.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
const link = await import("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js");

// The engine's commands: its own, and one a plugin brings, besides one in your settings.
const engine = http.createServer((request, response) => {
  // (Its providers first, as the box asks once its plugins are set up.)
  if (request.url.startsWith("/api/provider")) return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [] }));
  if (request.url.split("?")[0] !== "/api/command") return response.writeHead(404).end();
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
// No header at all: by its file's name.
write(path.join(claude, "agents", "Release Notes.md"), "Write release notes.\n");
write(path.join(claude, "commands", "frontend", "component.md"), "---\ndescription: A component\n---\nMake $ARGUMENTS.\n");
write(path.join(claude, "commands", "deploy.md"), "Ship it.\n");
write(path.join(claude, "commands", "init.md"), "Set up.\n");
write(path.join(claude, "commands", "mine.md"), "Mine.\n");
write(path.join(claude, "commands", "empty.md"), "---\ndescription: nothing after\n---\n");
// A link to a folder listed already isn't listed again (this one would list them all again and again).
fs.symlinkSync(".", path.join(claude, "commands", "again"));
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
    { name: "Release Notes", description: "", path: ["agents", "release-notes"], settings: { mode: "subagent", description: "", system: "Write release notes." }, imported: false },
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
  assert.equal(json.agents.length, 3);
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

// What's read of ~/.claude: an agent may write files there (the sandbox lets it, outside the
// settings Claude Code starts with), and could leave a link to a file it can't read itself; so the
// box reads only Markdown files, by their own names, in your home folder but not where your keys
// and sign-ins are, and nothing that would hold it.
test("only Markdown files are offered: not a link to a key or another file, a hard link, a pipe, or a file too big", async () => {
  const saved = process.env.HOME;
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-claude-code-limits-"));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-claude-code-elsewhere-"));
  removeAtEnd(other);
  removeAtEnd(elsewhere);
  process.env.HOME = other;
  try {
    const folder = path.join(other, ".claude");
    write(path.join(folder, "agents", "kept.md"), "---\nname: kept\n---\nKept.\n");
    fs.mkdirSync(path.join(folder, "commands"));
    // A link to another of its own files is read where it leads.
    write(path.join(folder, "notes", "shared.md"), "Shared.\n");
    fs.symlinkSync(path.join(folder, "notes", "shared.md"), path.join(folder, "commands", "shared.md"));
    // A link named like a command to your key, or to Claude Code's own sign-in, isn't: neither is
    // a Markdown file where it is.
    write(path.join(other, ".ssh", "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    write(path.join(folder, ".credentials.json"), "{\"token\":\"t\"}\n");
    write(path.join(other, "notes.txt"), "Notes.\n");
    fs.symlinkSync(path.join(other, ".ssh", "id_rsa"), path.join(folder, "agents", "key.md"));
    fs.symlinkSync("../.credentials.json", path.join(folder, "commands", "signin.md"));
    fs.symlinkSync("../../notes.txt", path.join(folder, "commands", "notes.md"));
    // Nor one to a Markdown file among your keys and sign-ins, or outside your home folder.
    write(path.join(other, ".ssh", "keys.md"), "My keys.\n");
    write(path.join(other, ".aws", "notes.md"), "My account.\n");
    write(path.join(elsewhere, "theirs.md"), "Someone else's.\n");
    fs.symlinkSync(path.join(other, ".ssh", "keys.md"), path.join(folder, "commands", "keys.md"));
    fs.symlinkSync(path.join(other, ".aws", "notes.md"), path.join(folder, "commands", "account.md"));
    fs.symlinkSync(path.join(elsewhere, "theirs.md"), path.join(folder, "commands", "theirs.md"));
    // (As the sandbox keeps commands from them: your passwords too.)
    write(path.join(other, ".password-store", "notes.md"), "My passwords.\n");
    fs.symlinkSync(path.join(other, ".password-store", "notes.md"), path.join(folder, "commands", "passwords.md"));
    // Nor a folder of them, through a link.
    fs.symlinkSync(path.join(other, ".ssh"), path.join(folder, "commands", "ssh"));
    // Nor a file with another name too (a hard link): its other names can't be told, so one to
    // your key looks like any other.
    write(path.join(other, "secret.txt"), "The secret.\n");
    fs.linkSync(path.join(other, "secret.txt"), path.join(folder, "commands", "hard.md"));
    fs.linkSync(path.join(other, ".ssh", "id_rsa"), path.join(folder, "agents", "hard-key.md"));
    // A pipe would hold the read until something wrote to it.
    execFileSync("mkfifo", [path.join(folder, "commands", "pipe.md")]);
    fs.symlinkSync(path.join(folder, "commands", "pipe.md"), path.join(folder, "agents", "pipe.md"));
    // Over 256 KB isn't an agent's instructions; up to it is.
    write(path.join(folder, "commands", "huge.md"), "x".repeat(256 * 1024 + 1));
    write(path.join(folder, "commands", "long.md"), "y".repeat(256 * 1024));
    // A folder named like a file isn't one.
    fs.mkdirSync(path.join(folder, "agents", "folder.md"));
    // Nor is a file with another name too (a hard link: to one the agent couldn't read, say).
    write(path.join(folder, "notes", "twice.md"), "Twice.\n");
    fs.linkSync(path.join(folder, "notes", "twice.md"), path.join(folder, "commands", "twice.md"));
    // Commands' folders are read four deep, no further.
    write(path.join(folder, "commands", "a", "b", "c", "d", "deep.md"), "Deep.\n");
    write(path.join(folder, "commands", "a", "b", "c", "d", "e", "deeper.md"), "Deeper.\n");

    const handle = link.engineHandler(() => { throw new Error("not running"); });
    const { status, json } = await answer(handle, "GET", "kuvo/claude-code");
    assert.equal(status, 200);
    assert.deepEqual(json.agents.map(agent => agent.name), ["kept"]);
    assert.deepEqual(json.commands.map(command => command.name), ["a-b-c-d-deep", "long", "shared"]);
    assert.equal(json.commands[1].settings.template.length, 256 * 1024);
    assert.equal(json.commands[2].settings.template, "Shared.");
  } finally {
    process.env.HOME = saved;
  }
});

test("however many files are there, no more than 4 MB of them is read", async () => {
  const saved = process.env.HOME;
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-claude-code-many-"));
  removeAtEnd(other);
  process.env.HOME = other;
  try {
    // Twenty of 250 KB: about 5 MB together.
    for (let index = 10; index < 30; index++) write(path.join(other, ".claude", "commands", `c${index}.md`), "z".repeat(250 * 1024));
    const handle = link.engineHandler(() => { throw new Error("not running"); });
    const { status, json } = await answer(handle, "GET", "kuvo/claude-code");
    assert.equal(status, 200);
    // (In order, until the next would pass it.)
    assert.deepEqual(json.commands.map(command => command.name), Array.from({ length: 16 }, (_, index) => `c${index + 10}`));
  } finally {
    process.env.HOME = saved;
  }
});

test("a ~/.claude that's a link (to your dotfiles, say) is read where it leads", async () => {
  const saved = process.env.HOME;
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-claude-code-dotfiles-"));
  removeAtEnd(other);
  process.env.HOME = other;
  try {
    write(path.join(other, "dotfiles", "claude", "commands", "ship.md"), "Ship it.\n");
    fs.symlinkSync(path.join(other, "dotfiles", "claude"), path.join(other, ".claude"));
    const handle = link.engineHandler(() => { throw new Error("not running"); });
    const { json } = await answer(handle, "GET", "kuvo/claude-code");
    assert.deepEqual(json.commands.map(command => command.name), ["ship"]);
  } finally {
    process.env.HOME = saved;
  }
});

test("a ~/.claude linked out of your home folder (dotfiles on another disk) is read there, but no further", async () => {
  const saved = process.env.HOME;
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-claude-code-home-"));
  const disk = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-claude-code-disk-"));
  removeAtEnd(other);
  removeAtEnd(disk);
  process.env.HOME = other;
  try {
    write(path.join(disk, "claude", "commands", "ship.md"), "Ship it.\n");
    write(path.join(disk, "other.md"), "Not Claude Code's.\n");
    fs.symlinkSync("../other.md", path.join(disk, "claude", "commands", "other.md"));
    fs.symlinkSync(path.join(disk, "claude"), path.join(other, ".claude"));
    const handle = link.engineHandler(() => { throw new Error("not running"); });
    const { json } = await answer(handle, "GET", "kuvo/claude-code");
    assert.deepEqual(json.commands.map(command => command.name), ["ship"]);
  } finally {
    process.env.HOME = saved;
  }
});

// (The Nix store, where home-manager links lead, is read as your home is; it isn't stood in for here.)
test("agents and commands linked into your dotfiles, folders or files (GNU stow), are read where they lead", async () => {
  const saved = process.env.HOME;
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-claude-code-stow-"));
  removeAtEnd(other);
  process.env.HOME = other;
  try {
    const dotfiles = path.join(other, "dotfiles", "claude", ".claude");
    write(path.join(dotfiles, "commands", "ship.md"), "Ship it.\n");
    write(path.join(dotfiles, "commands", "git", "commit.md"), "Commit.\n");
    write(path.join(dotfiles, "agents", "tester.md"), "---\nname: tester\n---\nTest it.\n");
    write(path.join(other, "dotfiles", "more", "review.md"), "Review.\n");
    write(path.join(other, "dotfiles", "more", "lint.md"), "Lint.\n");
    const claude = path.join(other, ".claude");
    // Folders linked as stow links them (relative), a folder inside commands, and a file.
    fs.mkdirSync(claude);
    fs.symlinkSync("../dotfiles/claude/.claude/commands", path.join(claude, "commands"));
    fs.symlinkSync(path.join(dotfiles, "agents"), path.join(claude, "agents"));
    fs.symlinkSync("../../../more", path.join(dotfiles, "commands", "more"));
    // A file linked to a Markdown file of another name is read by the link's.
    fs.symlinkSync("../../../more/lint.md", path.join(dotfiles, "commands", "check.md"));
    // Your keys in your dotfiles too, ~/.ssh linking there: still yours, where they really are.
    write(path.join(other, "dotfiles", "ssh", "keys.md"), "My keys.\n");
    fs.symlinkSync(path.join(other, "dotfiles", "ssh"), path.join(other, ".ssh"));
    fs.symlinkSync("../../../ssh/keys.md", path.join(dotfiles, "commands", "keys.md"));
    const handle = link.engineHandler(() => { throw new Error("not running"); });
    const { json } = await answer(handle, "GET", "kuvo/claude-code");
    assert.deepEqual(json.agents.map(agent => agent.name), ["tester"]);
    assert.deepEqual(json.commands.map(command => [command.name, command.settings.template]), [
      ["check", "Lint."], ["git-commit", "Commit."], ["more-lint", "Lint."], ["more-review", "Review."], ["ship", "Ship it."],
    ]);
  } finally {
    process.env.HOME = saved;
  }
});

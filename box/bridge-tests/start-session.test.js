// A session an agent starts on a machine (its start_session tool, `kuvo-browser.js`, which its box
// answers through `kuvo-link.js box route`) is marked as started by the conversation it works for
// (`kuvo.startedBy`), so every client shows it under that one: the conversation itself, a
// subagent's, and an engine run of a coding agent's (Auto's) all name the conversation. The real
// tool and box script; only the engine is a stand-in.
//
// Run with `node --test box/bridge-tests/start-session.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";
import { keepsIdle } from "./keeps-idle.js";

// (Laid out as a Mac's: the box's folder in the app's, and the project beside it.)
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-start-session-")));
removeAtEnd(root);
const home = path.join(root, "app", "box");
const work = path.join(root, "work");
fs.mkdirSync(work, { recursive: true });
const tool = fileURLToPath(new URL("../dist/kuvo-browser.js", import.meta.url));
fs.mkdirSync(path.join(home, "bin"), { recursive: true });
fs.copyFileSync(new URL("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url), path.join(home, "bin", "kuvo-link.js"));

// The engine: a conversation, a subagent it started, an engine run it works through, and what
// each new session was marked with.
const marked = new Map();
// What each new session was made with, and each as the engine keeps it.
const created = [];
const sessionsMade = new Map();
let made = 0;
// Worktrees made so far, each a folder of its own.
let trees = 0;
// Whether the engine takes a new session's marks (it may refuse one, as a busy engine does).
let marking = true;
const engine = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const one = request.url.match(/^\/api\/session\/([^/?]+)$/);
    if (one && request.method === "GET") {
      const id = decodeURIComponent(one[1]);
      if (id === "ses_lead" || id === "ses_evals") return reply({ data: { id, location: { directory: work } } });
      if (id === "ses_web") return reply({ data: { id, location: { directory: web } } });
      if (id === "ses_helper") return reply({ data: { id, parentID: "ses_lead", location: { directory: work } } });
      if (id === "ses_run") return reply({ data: { id, location: { directory: work }, metadata: { kuvo: { engineFor: "ses_lead" } } } });
      // One it made, as it is now: the box reads it before it marks it (#581).
      const made = sessionsMade.get(id);
      if (made) return reply({ data: { ...made, ...(marked.has(id) ? { metadata: marked.get(id) } : {}) } });
      return reply({ message: "No such session." }, 404);
    }
    // A git project, and its worktrees made with git, as the real engine makes them.
    if (request.url === "/api/location") return reply({ project: { id: "prj_repo" } });
    if (request.method === "POST" && request.url === "/api/worktree") {
      const folder = path.join(root, "worktrees", `proud-eagle-${++trees}`);
      git(repo, "worktree", "add", "-q", "--detach", folder);
      return reply({ directory: folder });
    }
    if (request.method === "POST" && request.url === "/api/session") {
      const given = JSON.parse(body);
      created.push(given);
      const id = `ses_new${++made}`;
      sessionsMade.set(id, { id, location: given.location, ...(given.metadata ? { metadata: given.metadata } : {}) });
      return reply({ data: { id } });
    }
    if (one && request.method === "PATCH") {
      if (!marking) return reply({ message: "Busy." }, 503);
      marked.set(decodeURIComponent(one[1]), JSON.parse(body).metadata);
    }
    reply({});
  });
});
keepsIdle(engine);
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
fs.mkdirSync(path.join(home, "run"), { recursive: true });
fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify({ port: engine.address().port, password: "p", version: "0.0.0" }));

// The tool, as the engine starts it, and its calls, as the engine makes them.
const mcp = spawn(process.execPath, [tool, "mcp"], { env: { ...process.env, KUVO_HOME: home }, stdio: ["pipe", "pipe", "ignore"] });
atEnd(() => mcp.kill());
const answers = new Map();
let buffer = "";
mcp.stdout.on("data", chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    answers.get(message.id)?.(message.result);
  }
});
let next = 1;
function call(name, args, session) {
  const id = next++;
  return new Promise(resolve => {
    answers.set(id, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, _meta: { "ai.opencode/sessionID": session } } }) + "\n");
  });
}
mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }) + "\n");

test("a session started from a conversation, its subagent or its engine run is marked as the conversation's", async () => {
  for (const caller of ["ses_lead", "ses_helper", "ses_run"]) {
    const result = await call("start_session", { task: "Review the docs.", title: "Review docs" }, caller);
    assert.equal(result.isError ?? false, false, result.content?.[0]?.text);
    const started = result.content[0].text.match(/\(address (ses_\w+)\)/)?.[1];
    assert.ok(started, result.content[0].text);
    assert.deepEqual(marked.get(started), { kuvo: { startedBy: "ses_lead" } }, `started from ${caller}`);
  }
});

test("an agent is promised it'll hear of a session it starts only once that session is marked to tell it: from no conversation here, or one the engine couldn't mark, it's told to write to it instead", async t => {
  t.after(() => { marking = true; });
  const woken = /You'll be woken when it finishes/;
  const marked = await call("start_session", { task: "Port it.", title: "Port", wake: "finished" }, "ses_lead");
  assert.match(marked.content[0].text, woken, "marked: it'll hear");
  const outside = await call("start_session", { task: "Port it.", title: "Port", wake: "finished", folder: work }, "ses_elsewhere");
  assert.equal(outside.isError ?? false, false, outside.content?.[0]?.text);
  assert.doesNotMatch(outside.content[0].text, woken, "nothing here would tell it");
  assert.match(outside.content[0].text, /Write to it with send_message/);
  marking = false;
  const unmarked = await call("start_session", { task: "Port it.", title: "Port", wake: "finished" }, "ses_lead");
  assert.equal(unmarked.isError ?? false, false, unmarked.content?.[0]?.text);
  assert.doesNotMatch(unmarked.content[0].text, woken, "its mark didn't take");
});

// A repository of the test's own, as git makes it (none of your settings).
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
function git(folder, ...args) {
  const ran = spawnSync("git", ["-c", "init.defaultBranch=main", "-c", "core.hooksPath=/dev/null", ...args], { cwd: folder, env: GIT_ENV, encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
}

// Another folder of the project, a repository of its own (the website, say).
const web = path.join(root, "kuvo-web");
fs.mkdirSync(web, { recursive: true });

// The project, a repository with its first commit.
const repo = path.join(root, "kuvo-ai");
fs.mkdirSync(path.join(repo, "Packages"), { recursive: true });
fs.writeFileSync(path.join(repo, "Packages", "README.md"), "hi\n");
git(repo, "init", "-q");
git(repo, "add", "-A");
git(repo, "commit", "-qm", "first");

test("a session started in a project with a folder of it, or of one of its worktrees wherever that is, works in that folder, as the project's; one that isn't the project's is refused, never dropped (#422)", async () => {
  // A throwaway worktree of the project elsewhere, as an evaluation makes it. (From a
  // conversation of its own: one starts a few sessions in a while.)
  const tree = path.join(root, "eval-ds", "T2");
  fs.mkdirSync(path.dirname(tree));
  git(repo, "worktree", "add", "-q", "-b", "eval/t2", tree);
  fs.mkdirSync(path.join(home, "box"), { recursive: true });
  fs.writeFileSync(path.join(home, "box", "projects.json"), JSON.stringify({ version: 1, projects: [{ directory: repo, name: "Kuvo Code", folders: [] }] }));
  for (const folder of [tree, path.join(tree, "Packages"), path.join(repo, "Packages")]) {
    const result = await call("start_session", { task: "Fix it, in this folder only.", title: "Eval", project: "Kuvo Code", folder }, "ses_evals");
    assert.equal(result.isError ?? false, false, result.content?.[0]?.text);
    assert.equal(created.at(-1).location.directory, fs.realpathSync(folder));
    // Filed under the project from the first, though its folder isn't the project's own.
    assert.deepEqual(created.at(-1).metadata.kuvo.filed, { folder: fs.realpathSync(folder), project: repo }, folder);
  }
  const elsewhere = await call("start_session", { task: "Fix it.", title: "Eval", project: "Kuvo Code", folder: work }, "ses_evals");
  assert.equal(elsewhere.isError, true);
  assert.match(elsewhere.content[0].text, /isn't in Kuvo Code/);
  // Nor did a worktree become a project of its own.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "box", "projects.json"), "utf8")).projects.map(each => each.directory), [repo]);
});

// The box's answer to one request, as a client's reaches it (`kuvo-link.js box route`).
function route(method, pathname) {
  const ran = spawnSync(process.execPath, [path.join(home, "bin", "kuvo-link.js"), "box", "route"], { input: JSON.stringify({ method, path: pathname }), env: { ...process.env, KUVO_HOME: home }, encoding: "utf8" });
  const said = JSON.parse(ran.stdout.trim().split("\n").pop());
  return { status: said.status, body: JSON.parse(said.body) };
}

test("a session started in a new worktree is made carrying the project it's filed under, so every client shows it there from its first listing, before kuvo/projects says whose the worktree is (#311)", async () => {
  const result = await call("start_session", { task: "Fix the composer's icons.", title: "#440 composer icons", project: "Kuvo Code", worktree: true }, "ses_evals");
  assert.equal(result.isError ?? false, false, result.content?.[0]?.text);
  const session = result.content[0].text.match(/\(address (ses_\w+)\)/)?.[1];
  const made = created.at(-1);
  const folder = made.location.directory;
  assert.match(folder, /\/worktrees\/proud-eagle-\d+$/);
  // As it's made: the engine's first word of it says so.
  assert.deepEqual(made.metadata.kuvo.filed, { folder, project: repo });
  // Kept as it's marked after.
  assert.deepEqual(marked.get(session)?.kuvo?.filed, { folder, project: repo });
  // The same project its box files the worktree under.
  const listed = route("GET", "kuvo/projects");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.worktrees[folder], repo);
});

test("a session started in one of a project's other folders is filed under that project from the first, by the box, on every client, and that folder never becomes a project of its own (#311)", async () => {
  fs.writeFileSync(path.join(home, "box", "projects.json"), JSON.stringify({ version: 1, projects: [{ directory: repo, name: "Kuvo Code", folders: [web] }] }));
  const named = await call("start_session", { task: "Add Vercel Web Analytics.", title: "kuvo-web: Vercel Web Analytics", project: "Kuvo Code", folder: web }, "ses_evals");
  assert.equal(named.isError ?? false, false, named.content?.[0]?.text);
  assert.match(named.content[0].text, / in Kuvo Code /);
  assert.equal(created.at(-1).location.directory, web);
  assert.deepEqual(created.at(-1).metadata.kuvo.filed, { folder: web, project: repo });
  // From a conversation at work there, with no project named: the same.
  const fromThere = await call("start_session", { task: "Check the analytics.", title: "Check" }, "ses_web");
  assert.equal(fromThere.isError ?? false, false, fromThere.content?.[0]?.text);
  assert.match(fromThere.content[0].text, / in Kuvo Code /);
  assert.deepEqual(created.at(-1).metadata.kuvo.filed, { folder: web, project: repo });
  // Every client files a session there under it, those from before too.
  const listed = route("GET", "kuvo/projects");
  assert.equal(listed.body.worktrees[web], repo);
  // And no project was made of the folder.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "box", "projects.json"), "utf8")).projects.map(each => each.directory), [repo]);
});

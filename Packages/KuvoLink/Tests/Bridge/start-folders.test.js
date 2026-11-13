// A project's other folders, on the box (PROTOCOL.md, "Projects" and "Agents' tools"): a client's
// new session, started with no task (`POST kuvo/sessions`), is made with them, its Autopilot and
// its approval; a chat moved into a project (`POST kuvo/sessions/<id>/move`) gets them, as does
// one a client opens (`POST kuvo/sessions/<id>/folders`); a change to them (`PUT kuvo/projects`)
// writes no session at rest. The real box script, as a client asks it; only the engine is a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/start-folders.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-start-folders-")));
removeAtEnd(home);
const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
// A project of two folders (its own and `docs`), a worktree of it, and another project of one.
const shop = path.join(home, "work", "shop");
const docs = path.join(home, "work", "docs");
const blog = path.join(home, "work", "blog");
const tree = path.join(home, "work", "trees", "brave-otter");
const chats = path.join(home, "chats");
for (const folder of [shop, docs, blog, tree, chats]) fs.mkdirSync(folder, { recursive: true });
const docsRule = { action: "external_directory", resource: path.join(docs, "*"), effect: "allow" };
const asks = { action: "shell", resource: "*", effect: "ask" };

// The engine's sessions, as it keeps them; what it was asked to make, sent and told.
let sessions = new Map();
let made = [];
let prompts = [];
let told = new Map();
let moves = [];
let deleted = [];
// (Autopilot's words not taken, for a start asked to be on Autopilot.)
let refusesAutopilot = false;
const engine = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/session" && request.method === "GET") {
      const directory = url.searchParams.get("directory");
      return reply({ data: [...sessions.values()].filter(each => !each.parentID && (directory === null || each.location.directory === directory)) });
    }
    if (url.pathname === "/api/session" && request.method === "POST") {
      const given = JSON.parse(body);
      const id = `ses_new${made.length + 1}`;
      made.push({ id, ...given });
      sessions.set(id, { id, title: "New session", location: given.location, ...(given.agent ? { agent: given.agent } : {}), ...(given.model ? { model: given.model } : {}), permissions: given.permissions ?? [], metadata: given.metadata ?? {}, time: { created: 9, updated: 9 } });
      return reply({ data: { id } });
    }
    if (url.pathname === "/api/session/active") return reply({ data: {} });
    if (refusesAutopilot && request.url.endsWith("/instructions/entries/kuvo.autopilot")) return reply({ message: "Not now." }, 500);
    if (request.url.includes("/instructions/entries/")) {
      const key = request.url.match(/session\/([^/]+)\//)[1] + " " + request.url.split("/").pop();
      if (request.method === "DELETE") told.set(key, null);
      else told.set(key, JSON.parse(body).value);
      return reply({});
    }
    const one = url.pathname.match(/^\/api\/session\/([^/]+)(\/.*)?$/);
    const id = one && decodeURIComponent(one[1]);
    const session = id && sessions.get(id);
    if (one && !one[2] && request.method === "GET") return session ? reply({ data: session }) : reply({ message: "No such session." }, 404);
    if (one && !one[2] && request.method === "DELETE" && session) {
      deleted.push(id);
      sessions.delete(id);
      return reply({ data: true });
    }
    if (one && !one[2] && request.method === "PATCH" && session) {
      Object.assign(session, JSON.parse(body));
      return reply({ data: session });
    }
    if (one?.[2] === "/move" && request.method === "POST" && session) {
      const { directory } = JSON.parse(body);
      moves.push({ id, directory });
      session.location = { directory };
      return reply({ data: true });
    }
    if (one?.[2] === "/prompt") {
      prompts.push(id);
      return reply({});
    }
    reply({ message: "Not here." }, 404);
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
write(path.join(home, "run", "engine.json"), JSON.stringify({ port: engine.address().port, password: "p", version: "0.0.0" }));

const kept = (id, directory, more = {}) => [id, { id, title: id, location: { directory }, permissions: [asks], metadata: {}, time: { created: 1, updated: 2 }, ...more }];

beforeEach(() => {
  sessions = new Map([
    kept("ses_shop", shop),
    kept("ses_tree", tree),
    kept("ses_blog", blog),
    kept("ses_old", shop, { time: { created: 1, updated: 2, archived: 3 } }),
    kept("ses_chat", chats, { metadata: { kuvo: { chat: chats } } }),
    kept("ses_seat", chats, { metadata: { kuvo: { seat: "grp_1" } } }),
  ]);
  made = [];
  prompts = [];
  told = new Map();
  moves = [];
  deleted = [];
  refusesAutopilot = false;
  write(path.join(home, "box", "projects.json"), JSON.stringify({ version: 1, projects: [{ directory: shop, folders: [docs] }, { directory: blog, folders: [] }] }));
  write(path.join(home, "box", "worktrees.json"), JSON.stringify({ worktrees: [{ project: shop, root: tree, folder: tree, branch: "kuvo/brave-otter" }] }));
});

// The box's answer to one request, as a client asks it through `kuvo-link.js box route`.
function route(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "box", "route"], { env: { ...process.env, KUVO_HOME: home, HOME: home, TMPDIR: home }, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("error", reject);
    child.on("close", () => {
      const said = JSON.parse(out.trim().split("\n").pop());
      resolve({ status: said.status, body: JSON.parse(said.body) });
    });
    child.stdin.end(JSON.stringify({ method, path: pathname, body }));
  });
}

const allows = (id, rule) => sessions.get(id).permissions.some(each => each.action === rule.action && each.resource === rule.resource && each.effect === rule.effect);

test("a client's new session, with no task, is made in its project with that project's other folders, its mode, model, approval and Autopilot, and nothing is sent to it", async () => {
  const started = await route("POST", "kuvo/sessions", { folder: shop, agent: "review", model: { providerID: "openai", id: "gpt-5", variant: "high" }, approval: "acceptEdits", autopilot: true });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.session, "ses_new1");
  assert.equal(started.body.project, "shop");
  // The session as it's made, for the client to show at once.
  assert.equal(started.body.info?.id, "ses_new1");
  assert.deepEqual(started.body.info?.location, { directory: shop });
  const [given] = made;
  assert.equal(given.agent, "review");
  assert.deepEqual(given.model, { providerID: "openai", id: "gpt-5", variant: "high" });
  assert.ok(given.permissions.some(rule => rule.action === docsRule.action && rule.resource === docsRule.resource && rule.effect === "allow"), "its project's other folder is allowed to it");
  assert.equal(given.metadata.kuvo.approval, "acceptEdits");
  assert.equal(given.metadata.kuvo.autopilot, true);
  assert.match(told.get("ses_new1 kuvo.project-folders") ?? "", new RegExp(`- docs: ${docs}`));
  assert.deepEqual(prompts, [], "it waits for the user's own first message");
});

test("a new session asked to start on Autopilot whose agent can't be told how isn't left asking you instead: it goes, and the client hears why", async () => {
  refusesAutopilot = true;
  const started = await route("POST", "kuvo/sessions", { folder: shop, autopilot: true });
  assert.equal(started.status, 502, JSON.stringify(started.body));
  assert.match(started.body.message, /on Autopilot/);
  assert.deepEqual(deleted, ["ses_new1"]);
  assert.equal(sessions.has("ses_new1"), false);
});

test("a new session in a worktree of the project gets its folders; one in the project's other folder works there alone", async () => {
  const inTree = await route("POST", "kuvo/sessions", { folder: tree });
  assert.equal(inTree.status, 200, JSON.stringify(inTree.body));
  assert.ok(made[0].permissions.some(rule => rule.resource === docsRule.resource));
  assert.deepEqual(made[0].metadata.kuvo.filed, { folder: tree, project: shop });
  assert.ok(told.get(`${inTree.body.session} kuvo.project-folders`));

  const inDocs = await route("POST", "kuvo/sessions", { folder: docs });
  assert.equal(inDocs.status, 200, JSON.stringify(inDocs.body));
  assert.ok(!made[1].permissions.some(rule => rule.resource === docsRule.resource));
  assert.equal(told.get(`${inDocs.body.session} kuvo.project-folders`), undefined);

  // A chat's, on the box's chats folder.
  const chat = await route("POST", "kuvo/sessions", { chat: true });
  assert.equal(chat.status, 200, JSON.stringify(chat.body));
  assert.deepEqual(made[2].location, { directory: chats });
  assert.equal(chat.body.project, null);
});

test("a start that waits, or an agent's, still needs a task", async () => {
  assert.deepEqual(await route("POST", "kuvo/sessions", { folder: shop, wait: true }), { status: 400, body: { message: "Say what it's to do (task)." } });
  assert.deepEqual(await route("POST", "kuvo/sessions", { folder: shop, startedBy: "ses_shop" }), { status: 400, body: { message: "Say what it's to do (task)." } });
  assert.deepEqual(made, []);
});

test("a chat moved into a project goes there with its conversation and gets the project's folders; moved on to one without, they go", async () => {
  const moved = await route("POST", "kuvo/sessions/ses_chat/move", { directory: shop });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(moves, [{ id: "ses_chat", directory: shop }]);
  assert.deepEqual(moved.body.info?.location, { directory: shop });
  assert.ok(allows("ses_chat", docsRule));
  assert.ok(allows("ses_chat", asks), "its own rules stay");
  assert.match(told.get("ses_chat kuvo.project-folders") ?? "", /This project spans several folders/);

  assert.equal((await route("POST", "kuvo/sessions/ses_chat/move", { directory: blog })).status, 200);
  assert.ok(!allows("ses_chat", docsRule));
  assert.ok(allows("ses_chat", asks));
  assert.equal(told.get("ses_chat kuvo.project-folders"), null, "its note of them is taken away");

  assert.equal((await route("POST", "kuvo/sessions/ses_chat/move", { directory: path.join(home, "nowhere") })).status, 400);
  assert.equal((await route("POST", "kuvo/sessions/ses_gone/move", { directory: shop })).status, 404);
  // A group chat's seat goes with its group chat.
  assert.equal((await route("POST", "kuvo/sessions/ses_seat/move", { directory: shop })).status, 409);
  assert.equal(moves.length, 2);
});

test("a project's folders changed by any client are given to no session at rest, which would make each the newest: each gets them as it next runs", async () => {
  const other = path.join(home, "work", "assets");
  fs.mkdirSync(other, { recursive: true });
  const before = JSON.stringify([...sessions.values()]);
  const changed = await route("PUT", `kuvo/projects?directory=${encodeURIComponent(shop)}`, { folders: [other] });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.deepEqual(changed.body.project.folders, [other]);
  assert.equal(JSON.stringify([...sessions.values()]), before, "no session was written");
  assert.equal(told.size, 0);
  // (As each runs: box test project-folders.test.ts.)
});

test("a session a client opens is given its project's folders where it hasn't them, before anything is written to it; one that has them isn't written", async () => {
  const opened = await route("POST", "kuvo/sessions/ses_shop/folders");
  assert.deepEqual(opened, { status: 200, body: { session: "ses_shop" } });
  assert.ok(allows("ses_shop", docsRule));
  assert.match(told.get("ses_shop kuvo.project-folders") ?? "", /This project spans several folders/);

  told = new Map();
  const before = JSON.stringify([...sessions.values()]);
  for (const id of ["ses_shop", "ses_seat", "ses_blog"]) assert.equal((await route("POST", `kuvo/sessions/${id}/folders`)).status, 200, id);
  assert.equal(JSON.stringify([...sessions.values()]), before);
  assert.equal(told.size, 0);
  assert.equal((await route("POST", "kuvo/sessions/ses_gone/folders")).status, 404);
});

test("a session whose project the box doesn't list (its Mac keeps them, or hasn't handed them over) keeps what its Mac gave it, opened or moved", async () => {
  const assets = { action: "external_directory", resource: path.join(home, "work", "assets", "*"), effect: "allow" };
  sessions.get("ses_shop").permissions = [asks, assets];
  sessions.get("ses_chat").permissions = [asks, assets];
  // (Only one other project, as make_project writes it.)
  write(path.join(home, "box", "projects.json"), JSON.stringify({ version: 1, projects: [{ directory: blog, folders: [] }] }));
  assert.equal((await route("POST", "kuvo/sessions/ses_shop/folders")).status, 200);
  assert.equal((await route("POST", "kuvo/sessions/ses_chat/move", { directory: shop })).status, 200);
  fs.rmSync(path.join(home, "box", "projects.json"));
  assert.equal((await route("POST", "kuvo/sessions/ses_shop/folders")).status, 200);
  assert.deepEqual(moves, [{ id: "ses_chat", directory: shop }], "it's moved all the same");
  for (const id of ["ses_shop", "ses_chat"]) assert.deepEqual(sessions.get(id).permissions, [asks, assets], id);
  assert.equal(told.size, 0);
});

test("a project the box adds as an agent starts a session there keeps the folders a Mac from before gives its sessions, until a client sets its own", async () => {
  const assets = { action: "external_directory", resource: path.join(home, "work", "assets", "*"), effect: "allow" };
  sessions.get("ses_shop").permissions = [asks, assets];
  // (Only the project a bot made, as make_project writes it; the shop is the Mac's own.)
  const file = path.join(home, "box", "projects.json");
  write(file, JSON.stringify({ version: 1, projects: [{ directory: blog, folders: [] }] }));
  const started = await route("POST", "kuvo/sessions", { folder: shop, task: "Look at the README.", startedBy: "ses_blog" });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const added = JSON.parse(fs.readFileSync(file, "utf8")).projects.find(each => each.directory === shop);
  assert.deepEqual(added, { directory: shop, folders: [], addedByBox: true });
  assert.equal((await route("POST", "kuvo/sessions/ses_shop/folders")).status, 200);
  assert.deepEqual(sessions.get("ses_shop").permissions, [asks, assets], "what its Mac gave it stays");

  // Set by a client (a Mac that keeps its projects on the box): the box's to give from then on.
  assert.equal((await route("PUT", `kuvo/projects?directory=${encodeURIComponent(shop)}`, { folders: [docs] })).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).projects.find(each => each.directory === shop).addedByBox, undefined);
  assert.equal((await route("POST", "kuvo/sessions/ses_shop/folders")).status, 200);
  assert.ok(allows("ses_shop", docsRule));
  assert.ok(!allows("ses_shop", assets));
});

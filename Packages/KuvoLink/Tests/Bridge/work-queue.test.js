// The Work Queue on a box (PROTOCOL.md, "The Work Queue"): what agents keep with their queue_*
// tools (`POST kuvo/work-queue/tools`, only while the conversation named is making the call), and
// what clients read and do (`kuvo/work-queue/…`): each conversation's own queue, a lead's view of
// the sessions it oversees, In progress from the sessions at work, hand-offs, delete with undo,
// categories, files, refs for chips, imports keeping their numbers, and numbers from the primary.
// Each request by a process of its own, as a machine's tools ask it (`kuvo-link.js box route`); the
// real box script on a folder of the test's own; only the engine is a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/work-queue.test.js`.
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

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-work-queue-")));
removeAtEnd(home);
// GitHub's `gh`, standing in, signed out: an issue in a queue is never read from GitHub here
// (work-queue-github.test.js reads them).
fs.mkdirSync(path.join(home, "bin"), { recursive: true });
fs.writeFileSync(path.join(home, "bin", "gh"), "#!/bin/sh\necho 'gh auth login' >&2\nexit 1\n", { mode: 0o755 });
process.env.PATH = `${path.join(home, "bin")}${path.delimiter}${process.env.PATH}`;
const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
process.env.KUVO_HOME = home;
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const project = path.join(home, "work", "api");
fs.mkdirSync(project, { recursive: true });
const queues = path.join(home, "run", "work-queue");

// The engine: a lead, the sessions it started (and one of theirs), its subagent, a session of its
// own, a bot, and a group chat's seat; which are at work, and the tool call each is making now.
const sessions = new Map([
  ["ses_lead", { id: "ses_lead", title: "Lead", location: { directory: project }, time: { created: 1, updated: 5 } }],
  ["ses_child", { id: "ses_child", title: "Sign-in", location: { directory: project }, metadata: { kuvo: { startedBy: "ses_lead", depth: 1 } }, time: { created: 2, updated: 6 } }],
  ["ses_grandchild", { id: "ses_grandchild", title: "Tests", location: { directory: project }, metadata: { kuvo: { startedBy: "ses_child", depth: 2 } }, time: { created: 3, updated: 6 } }],
  ["ses_helper", { id: "ses_helper", parentID: "ses_lead", title: "Helper", location: { directory: project }, time: { created: 2, updated: 6 } }],
  ["ses_other", { id: "ses_other", title: "Release notes", location: { directory: project }, time: { created: 3, updated: 4 } }],
  // A project around Kuvo Code's own folder, as one at the home folder is.
  ["ses_wide", { id: "ses_wide", title: "Home", location: { directory: path.dirname(home) }, time: { created: 1, updated: 2 } }],
  ["ses_scout", { id: "ses_scout", title: "Scout", location: { directory: path.join(home, "bots", "bot_scout00001", "workspace") }, time: { created: 1, updated: 3 } }],
  ["ses_seat", { id: "ses_seat", title: "Seat", location: { directory: project }, metadata: { kuvo: { seat: { group: "grp_team", bot: "bot_scout00001" } } }, time: { created: 1, updated: 2 } }],
  ["ses_farseat", { id: "ses_farseat", title: "Seat", location: { directory: project }, metadata: { kuvo: { seat: { group: "grp_far", bot: "bot_scout00001" } } }, time: { created: 1, updated: 2 } }],
]);
let active = new Set();
const calling = new Map();
const engine = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/session" && request.method === "GET") return reply({ data: [...sessions.values()].filter(each => !each.parentID) });
    if (url.pathname === "/api/session/active") return reply({ data: Object.fromEntries([...active].map(id => [id, {}])) });
    const one = url.pathname.match(/^\/api\/session\/([^/]+)(\/.*)?$/);
    const id = one && decodeURIComponent(one[1]);
    if (one && !one[2]) return sessions.has(id) ? reply({ data: sessions.get(id) }) : reply({ message: "No such session." }, 404);
    if (one?.[2] === "/message") {
      const call = calling.get(id);
      return reply({ data: call ? [{ id: "msg_1", type: "assistant", content: [{ type: "tool", name: `kuvo-browser_${call.name}`, callID: "call_1", state: { status: "running", input: call.args } }] }] : [] });
    }
    if (one?.[2] === "/permission" || one?.[2] === "/form") return reply({ data: [] });
    reply({ data: [] });
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
write(path.join(home, "run", "engine.json"), JSON.stringify({ port: engine.address().port, password: "p", version: "0.0.0" }));
// The coding agents' bridge, as far as group chats go: grp_team lives here, any other elsewhere.
const groups = http.createServer((request, response) => {
  const here = request.url === "/api/kuvo/groups/grp_team";
  response.writeHead(here ? 200 : 404, { "content-type": "application/json" });
  response.end(JSON.stringify(here ? { data: { id: "grp_team" } } : { message: "No such chat." }));
});
await new Promise(resolve => groups.listen(0, "127.0.0.1", resolve));
atEnd(() => { groups.closeAllConnections(); groups.close(); });
write(path.join(home, "run", "bridge.json"), JSON.stringify({ port: groups.address().port, password: "p", pid: process.pid }));
const bot = path.join(home, "bots", "bot_scout00001");
write(path.join(bot, "bot.json"), JSON.stringify({ kuvo: 1, id: "bot_scout00001", name: "Scout", job: "", look: { color: "sky", shape: "round", face: "calm" }, created: "2026-10-01T09:00:00Z", updated: "2026-10-01T09:00:00Z" }));
write(path.join(bot, "session"), "ses_scout");
fs.mkdirSync(path.join(bot, "workspace"), { recursive: true });

beforeEach(() => {
  fs.rmSync(queues, { recursive: true, force: true });
  active = new Set();
  calling.clear();
});

// The box's answer to one request, from a client (this Mac's app): answered here, by the real routes.
const handle = link.engineHandler();
async function route(method, pathname, body) {
  const pieces = [];
  for await (const piece of handle({ method, path: pathname, headers: {}, body: body === undefined ? undefined : Buffer.from(JSON.stringify(body)), fromApp: true }, undefined)) pieces.push(piece);
  const head = pieces.find(each => each.head).head;
  const bytes = Buffer.concat(pieces.filter(each => each.body).map(each => each.body));
  let parsed = bytes.toString();
  try { parsed = JSON.parse(parsed); } catch {}
  return { status: head.status, body: parsed, raw: bytes.toString(), type: head.headers["content-type"] };
}
// The same, as a machine's tool asks it: a process of its own (`kuvo-link.js box route`).
function spawnRoute(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "box", "route"], { env: { ...process.env, KUVO_HOME: home, HOME: home, TMPDIR: home }, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("error", reject);
    child.on("close", () => {
      const said = JSON.parse(out.trim().split("\n").pop());
      let parsed = said.body;
      try { parsed = JSON.parse(said.body); } catch {}
      resolve({ status: said.status, body: parsed, raw: said.bodyBase64 !== undefined ? Buffer.from(said.bodyBase64, "base64").toString() : said.body, type: said.type });
    });
    child.stdin.end(JSON.stringify({ method, path: pathname, body }));
  });
}
// An agent's call, while its conversation is making it.
async function tool(name, args, session) {
  calling.set(session, { name, args });
  try {
    return (await route("POST", "kuvo/work-queue/tools", { name, arguments: args, session })).body;
  } finally {
    calling.delete(session);
  }
}
const view = async owner => (await route("GET", `kuvo/work-queue?owner=${owner}`)).body;
const numberIn = text => Number(text.match(/#(\d+)/)[1]);

test("an agent keeps its work in its own queue: numbered from #1 here (its own primary), In next by default, listed by category", async () => {
  const first = await tool("queue_add", { title: "Fix the login page", body: "It loops after **sign-in**." }, "ses_lead");
  assert.equal(first.isError, false, first.text);
  assert.equal(first.text, 'Added #1 "Fix the login page" to Next. Refer to it as #1.');
  const later = await tool("queue_add", { title: "Dark mode icons", category: "later" }, "ses_lead");
  assert.equal(numberIn(later.text), 2);
  const top = await tool("queue_add", { title: "Ship the release", top: true }, "ses_lead");
  assert.equal(numberIn(top.text), 3);

  const listed = await tool("queue_list", {}, "ses_lead");
  assert.match(listed.text, /^Your Work Queue \(3 open\):\n\nNext:\n- #3 "Ship the release" · updated just now\n- #1 "Fix the login page" · updated just now\n\nLater:\n- #2 "Dark mode icons"/);

  // A subagent writes into its conversation's queue.
  const fromHelper = await tool("queue_add", { title: "Helper's find" }, "ses_helper");
  assert.equal(numberIn(fromHelper.text), 4);
  const seen = await view("ses_lead");
  assert.deepEqual(seen.items.map(item => [item.number, item.owner, item.category]), [[3, "ses_lead", "next"], [1, "ses_lead", "next"], [4, "ses_lead", "next"], [2, "ses_lead", "later"]]);
  assert.deepEqual(seen.categories.map(each => each.name), ["Next", "Later", "Parked", "Done"]);
  assert.equal(seen.items[0].created.by.name, "Lead");

  // Another conversation's queue is its own.
  assert.equal((await view("ses_other")).items.length, 0);
  const whole = await route("GET", "kuvo/work-queue/items/1");
  assert.equal(whole.body.item.body, "It loops after **sign-in**.");
});

test("only a call the conversation is making runs: a command naming a session can't write to its queue", async () => {
  const forged = (await route("POST", "kuvo/work-queue/tools", { name: "queue_add", arguments: { title: "Sneaky" }, session: "ses_lead" })).body;
  assert.equal(forged.isError, true);
  assert.match(forged.text, /^Only a conversation's own tool call/);
  assert.equal((await view("ses_lead")).items.length, 0);
  // As a machine's tool server asks it, from a process of its own, a real call goes ahead.
  calling.set("ses_lead", { name: "queue_add", args: { title: "Real" } });
  const real = (await spawnRoute("POST", "kuvo/work-queue/tools", { name: "queue_add", arguments: { title: "Real" }, session: "ses_lead" })).body;
  assert.equal(real.text, 'Added #1 "Real" to Next. Refer to it as #1.');
});

test("an item is In progress while a session linked to it is at work, and Done unlinks everyone", async () => {
  const added = await tool("queue_add", { title: "Write the tests", working: true, progress_note: "Writing the tests (3 of 8)", progress: 0.375 }, "ses_lead");
  assert.match(added.text, /linked to you/);
  let item = (await view("ses_lead")).items[0];
  assert.equal(item.inProgress, false, "linked, but not at work");
  active = new Set(["ses_lead"]);
  item = (await view("ses_lead")).items[0];
  assert.equal(item.inProgress, true);
  assert.deepEqual(item.sessions, [{ session: "ses_lead", title: "Lead", working: true }]);
  assert.deepEqual(item.progress, { value: 0.375, note: "Writing the tests (3 of 8)" });
  assert.match((await tool("queue_list", {}, "ses_lead")).text, /In progress:\n- #1 "Write the tests" · in progress \("Lead" at work\): Writing the tests \(3 of 8\) 38%/);

  // "In progress" isn't a category anyone sets.
  const set = await tool("queue_update", { item: "#1", category: "In progress" }, "ses_lead");
  assert.equal(set.isError, true);
  assert.match(set.text, /isn't a category you set/);

  const done = await tool("queue_update", { item: 1, category: "done" }, "ses_lead");
  assert.equal(done.text, 'Marked #1 "Write the tests" done.');
  item = (await view("ses_lead")).items[0];
  assert.equal(item.inProgress, false);
  assert.deepEqual(item.sessions, []);
  assert.equal(item.category, "done");
  assert.equal(typeof item.doneAt, "number");
});

test("a session is linked to three items at most: linking a fourth drops its oldest link", async () => {
  for (const title of ["One", "Two", "Three", "Four"]) await tool("queue_add", { title, working: true }, "ses_lead");
  const items = (await view("ses_lead")).items;
  assert.deepEqual(items.map(item => [item.title, item.sessions.length]), [["One", 0], ["Two", 1], ["Three", 1], ["Four", 1]]);
});

test("a lead sees the queues of the sessions it oversees; handing an item moves it into a session's queue, linked, living once", async () => {
  await tool("queue_add", { title: "Build the sign-in" }, "ses_lead");
  await tool("queue_add", { title: "Child's own" }, "ses_child");
  await tool("queue_add", { title: "Grandchild's own" }, "ses_grandchild");
  await tool("queue_add", { title: "Not the lead's" }, "ses_other");

  const lead = await view("ses_lead");
  assert.deepEqual(lead.items.map(item => item.title).sort(), ["Build the sign-in", "Child's own", "Grandchild's own"]);
  assert.deepEqual(lead.owners.find(each => each.owner === "ses_child"), { owner: "ses_child", kind: "session", title: "Sign-in", startedBy: "ses_lead" });
  // All: every queue on the box, each item naming whose it is.
  const everything = await view("all");
  assert.equal(everything.owner, "all");
  assert.deepEqual(everything.items.map(item => item.title).sort(), ["Build the sign-in", "Child's own", "Grandchild's own", "Not the lead's"]);
  assert.deepEqual(everything.owners.map(each => each.owner).sort(), ["ses_child", "ses_grandchild", "ses_lead", "ses_other"]);
  assert.equal((await route("GET", "kuvo/work-queue?owner=everyone")).status, 400);

  const handed = await tool("queue_hand", { item: "#1", to: "ses_child" }, "ses_lead");
  assert.equal(handed.isError, false, handed.text);
  assert.equal(handed.text, 'Handed #1 "Build the sign-in" to Sign-in: it\'s in its queue now, linked to it, so it shows In progress while it works, and stays in your view.');
  active = new Set(["ses_child"]);
  const after = await view("ses_lead");
  const moved = after.items.find(item => item.number === 1);
  assert.equal(moved.owner, "ses_child");
  assert.equal(moved.inProgress, true, "its new owner is at work on it");
  assert.equal(moved.handedBy, "ses_lead");
  assert.equal(after.items.filter(item => item.number === 1).length, 1, "it lives once");
  assert.equal((await view("ses_child")).items.filter(item => item.number === 1).length, 1);
  assert.match((await tool("queue_list", {}, "ses_lead")).text, /#1 "Build the sign-in" · in progress \("Sign-in" at work\) · in "Sign-in" \(ses_child\)/);

  // The lead changes what it oversees; another conversation can't.
  assert.equal((await tool("queue_update", { item: 1, note: "Use the new endpoint." }, "ses_lead")).isError, false);
  const stranger = await tool("queue_update", { item: 1, title: "Mine now" }, "ses_other");
  assert.equal(stranger.isError, true);
  assert.match(stranger.text, /isn't in your Work Queue, nor in a session's you oversee/);
  // And it's in the hander's view even when handed out of what it oversees.
  await tool("queue_hand", { item: 1, to: "Scout" }, "ses_child");
  assert.ok((await view("ses_lead")).items.some(item => item.number === 1 && item.owner === "ses_scout"));
  // A session that isn't on this box: said so.
  const away = await tool("queue_hand", { item: 2, to: "ses_elsewhere" }, "ses_child");
  assert.equal(away.isError, true);
  assert.match(away.text, /There's no session ses_elsewhere on this machine/);
});

test("you delete an item and bring it back; an agent's delete an agent may undo, yours only you", async () => {
  await tool("queue_add", { title: "Old idea", working: true }, "ses_lead");
  const deleted = await route("DELETE", "kuvo/work-queue/items/1");
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body.item.removed.by, { user: true });
  let seen = await view("ses_lead");
  assert.deepEqual([seen.items.length, seen.removed.map(item => item.number)], [0, [1]]);
  assert.deepEqual(seen.removed[0].sessions, [], "no one works on what's deleted");

  const write = await tool("queue_update", { item: 1, note: "Still on it" }, "ses_lead");
  assert.deepEqual(write, { text: 'The user deleted #1 "Old idea": only they bring it back. Ask them if it\'s still needed.', isError: true });
  assert.equal((await tool("queue_remove", { item: 1, undo: true }, "ses_lead")).isError, true);

  assert.equal((await route("POST", "kuvo/work-queue/items/1/restore")).status, 200);
  seen = await view("ses_lead");
  assert.deepEqual([seen.items.map(item => item.number), seen.removed.length], [[1], 0]);

  assert.equal((await tool("queue_remove", { item: 1 }, "ses_lead")).text, 'Deleted #1 "Old idea". The user can bring it back for 30 days.');
  assert.equal((await tool("queue_remove", { item: 1, undo: true }, "ses_lead")).text, 'Brought back #1 "Old idea".');
});

test("deleted items go after 30 days, files and all", async () => {
  await tool("queue_add", { title: "Gone soon" }, "ses_lead");
  await route("DELETE", "kuvo/work-queue/items/1");
  const file = path.join(queues, "queues", "ses_lead.json");
  const kept = JSON.parse(fs.readFileSync(file, "utf8"));
  kept.items[0].removed.at = Date.now() - 31 * 86_400_000;
  fs.writeFileSync(file, JSON.stringify(kept));
  await tool("queue_add", { title: "Something new" }, "ses_lead");
  const seen = await view("ses_lead");
  assert.deepEqual([seen.items.map(item => item.title), seen.removed.length], [["Something new"], 0]);
});

test("you reorder and move items between categories, never change what they say", async () => {
  for (const title of ["A", "B", "C"]) await tool("queue_add", { title }, "ses_lead");
  assert.equal((await route("POST", "kuvo/work-queue/items/3/move", { before: 1 })).status, 200);
  assert.deepEqual((await view("ses_lead")).items.map(item => item.title), ["C", "A", "B"]);
  assert.equal((await route("POST", "kuvo/work-queue/items/1/move", { after: "#2" })).status, 200);
  assert.deepEqual((await view("ses_lead")).items.map(item => item.title), ["C", "B", "A"]);
  const parked = await route("POST", "kuvo/work-queue/items/2/move", { category: "Parked" });
  assert.equal(parked.body.item.category, "parked");
  assert.equal(parked.body.item.title, "B");
  const wrong = await route("POST", "kuvo/work-queue/items/2/move", { category: "In progress" });
  assert.equal(wrong.status, 400);
  // (A client's request carries no title: there's nothing to change it with.)
  await route("POST", "kuvo/work-queue/items/2/move", { title: "Renamed" });
  assert.equal((await route("GET", "kuvo/work-queue/items/2")).body.item.title, "B");
});

test("a view lists the categories in order, Done last, and each one's items by their place (as you and agents set it), not by number or when they were made", async () => {
  for (const title of ["A", "B", "C", "D"]) await tool("queue_add", { title }, "ses_lead");
  await tool("queue_categories", { add: "Design" }, "ses_lead");
  await tool("queue_update", { item: 4, category: "done" }, "ses_lead");
  await tool("queue_add", { title: "E", category: "later" }, "ses_lead");
  await tool("queue_add", { title: "F", category: "Design" }, "ses_lead");
  await tool("queue_add", { title: "G", category: "parked" }, "ses_lead");
  // An agent puts C first; you drag B below C, then drag A into Later, above E (a drop beside an
  // item in another category moves it there).
  await tool("queue_update", { item: 3, top: true }, "ses_lead");
  assert.equal((await route("POST", "kuvo/work-queue/items/2/move", { category: "next", after: 3 })).status, 200);
  assert.equal((await route("POST", "kuvo/work-queue/items/1/move", { category: "later", before: 5 })).status, 200);
  const listed = (await view("ses_lead")).items.map(item => `${item.category}:${item.title}`);
  assert.deepEqual(listed, ["next:C", "next:B", "later:A", "later:E", "cat_design:F", "parked:G", "done:D"]);
  // Read again (a client opening the panel anew): the same order.
  assert.deepEqual((await view("all")).items.map(item => `${item.category}:${item.title}`), listed);
});

test("what acts as you answers only a client, never a command or an agent", async () => {
  await tool("queue_add", { title: "Mine" }, "ses_lead");
  const handle = link.engineHandler();
  const ask = async (method, pathname, body, extra = {}) => {
    const pieces = [];
    for await (const piece of handle({ method, path: pathname, headers: {}, body: body ? Buffer.from(JSON.stringify(body)) : undefined, ...extra }, undefined)) pieces.push(piece);
    return { status: pieces[0].head.status, body: JSON.parse(Buffer.concat(pieces.filter(each => each.body).map(each => each.body)).toString() || "null") };
  };
  for (const [method, pathname, body] of [["DELETE", "kuvo/work-queue/items/1"], ["POST", "kuvo/work-queue/items/1/move", { category: "later" }], ["POST", "kuvo/work-queue/categories", { add: "Bugs" }], ["POST", "kuvo/work-queue/import", { owner: "ses_lead", files: ["/x.md"] }]]) {
    const refused = await ask(method, pathname, body);
    assert.equal(refused.status, 403, `${method} ${pathname}`);
  }
  assert.equal((await ask("GET", "kuvo/work-queue?owner=ses_lead")).status, 200, "reading isn't acting");
  // `box route`, which any command on this computer can run (an agent's too), without its Mac's proof.
  for (const [method, pathname, body] of [["DELETE", "kuvo/work-queue/items/1"], ["POST", "kuvo/work-queue/items/1/restore"], ["POST", "kuvo/work-queue/categories", { add: "Bugs" }]]) {
    assert.equal((await spawnRoute(method, pathname, body)).status, 403, `box route ${method} ${pathname}`);
  }
  assert.equal((await ask("DELETE", "kuvo/work-queue/items/1", undefined, { fromMac: true })).status, 403, "a Mac over SSH proves it's one");
  assert.equal((await ask("DELETE", "kuvo/work-queue/items/1", undefined, { fromApp: true })).status, 200, "this Mac's app is a client");
});

test("categories: the four built in, custom ones an agent adds between Later and Parked; you rename and remove them", async () => {
  const added = await tool("queue_categories", { add: "Bugs" }, "ses_lead");
  assert.equal(added.text, "Added the category Bugs. Categories now: Next, Later, Bugs, Parked, Done.");
  assert.equal((await tool("queue_categories", { add: "Ideas", after: "Later" }, "ses_lead")).text, "Added the category Ideas. Categories now: Next, Later, Ideas, Bugs, Parked, Done.");
  assert.equal((await tool("queue_categories", { add: "in progress" }, "ses_lead")).isError, true);
  await tool("queue_add", { title: "Crash on start", category: "bugs" }, "ses_lead");
  assert.equal((await view("ses_lead")).items[0].category, "cat_bugs");

  const renamed = await route("POST", "kuvo/work-queue/categories", { rename: "Bugs", to: "Issues" });
  assert.deepEqual(renamed.body.categories.map(each => each.name), ["Next", "Later", "Ideas", "Issues", "Parked", "Done"]);
  const used = await route("POST", "kuvo/work-queue/categories", { remove: "Issues" });
  assert.deepEqual([used.status, used.body.message], [400, "Issues still has 1 item in it: move it first."]);
  assert.equal((await route("POST", "kuvo/work-queue/categories", { remove: "Next" })).status, 400);
  await route("POST", "kuvo/work-queue/items/1/move", { category: "next" });
  assert.equal((await route("POST", "kuvo/work-queue/categories", { remove: "Issues" })).status, 200);
  fs.rmSync(path.join(queues, "categories.json"), { force: true });
});

test("an item brought back into a category that's gone goes to Next", async () => {
  await tool("queue_categories", { add: "Bugs" }, "ses_lead");
  await tool("queue_add", { title: "Crash", category: "Bugs" }, "ses_lead");
  await route("DELETE", "kuvo/work-queue/items/1");
  const used = await route("POST", "kuvo/work-queue/categories", { remove: "Bugs" });
  assert.equal(used.status, 400, "what's deleted still counts");
  // (As one kept from before deleted items counted: the category gone all the same.)
  fs.rmSync(path.join(queues, "categories.json"), { force: true });
  assert.equal((await route("POST", "kuvo/work-queue/items/1/restore")).body.item.category, "next");
});

test("an item moved into the same place again and again keeps its place", async () => {
  for (const title of ["A", "B", "C"]) await tool("queue_add", { title }, "ses_lead");
  for (let round = 0; round < 70; round++) {
    assert.equal((await route("POST", `kuvo/work-queue/items/${round % 2 ? 2 : 3}/move`, { after: 1 })).status, 200);
  }
  assert.deepEqual((await view("ses_lead")).items.map(item => item.title), ["A", "B", "C"]);
});

test("files kept with an item come only from the conversation's own folders, and clients read them back", async () => {
  write(path.join(project, "shots", "login.png"), "PNG-bytes");
  write(path.join(project, ".env"), "SECRET=1");
  fs.symlinkSync("/etc/hosts", path.join(project, "hosts.png"));
  write(path.join(home, "keys", "id_ed25519"), "PRIVATE");
  const kept = await tool("queue_add", { title: "Login loops", body: "![The loop](login.png)", files: [path.join(project, "shots", "login.png")] }, "ses_lead");
  assert.equal(kept.isError, false, kept.text);
  const item = (await route("GET", "kuvo/work-queue/items/1")).body.item;
  assert.deepEqual(item.files.map(({ name, size, type }) => ({ name, size, type })), [{ name: "login.png", size: 9, type: "image/png" }]);
  const bytes = await route("GET", "kuvo/work-queue/items/1/files/login.png");
  assert.deepEqual([bytes.status, bytes.raw, bytes.type], [200, "PNG-bytes", "image/png"]);

  for (const [file, why] of [[path.join(project, ".env"), /hidden/], [path.join(project, "hosts.png"), /isn't in this conversation's folder/], [path.join(home, "keys", "id_ed25519"), /isn't in this conversation's folder/], ["/etc/hosts", /isn't in this conversation's folder/], ["shots/login.png", /full path/]]) {
    const refused = await tool("queue_update", { item: 1, files: [file] }, "ses_lead");
    assert.equal(refused.isError, true, file);
    assert.match(refused.text, why);
  }
  assert.equal((await route("GET", "kuvo/work-queue/items/1")).body.item.files.length, 1, "nothing refused was kept");
  // A change that's refused leaves the files as they were, the one it would take away too.
  const mixed = await tool("queue_update", { item: 1, remove: ["login.png"], files: ["/etc/hosts"] }, "ses_lead");
  assert.equal(mixed.isError, true);
  assert.deepEqual([(await route("GET", "kuvo/work-queue/items/1")).body.item.files.length, (await route("GET", "kuvo/work-queue/items/1/files/login.png")).raw], [1, "PNG-bytes"]);
  // A file with another name elsewhere (a hard link) isn't taken; one in a temporary folder is.
  fs.linkSync(path.join(project, "shots", "login.png"), path.join(project, "shots", "again.png"));
  assert.match((await tool("queue_update", { item: 1, files: [path.join(project, "shots", "again.png")] }, "ses_lead")).text, /has other names/);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-work-queue-scratch-"));
  removeAtEnd(scratch);
  write(path.join(scratch, "chart.png"), "CHART");
  assert.equal((await tool("queue_update", { item: 1, files: [path.join(scratch, "chart.png")], remove: ["login.png"] }, "ses_lead")).isError, false);
  assert.deepEqual((await route("GET", "kuvo/work-queue/items/1")).body.item.files.map(file => file.name), ["chart.png"]);
  assert.equal((await route("GET", "kuvo/work-queue/items/1/files/login.png")).status, 404);
  assert.deepEqual(fs.readdirSync(path.join(queues, "staging")), [], "nothing read is left waiting");
  assert.equal((await route("GET", "kuvo/work-queue/items/1/files/..%2F..%2Fengine.json")).status, 404);
});

test("refs say what each #n names, for chips: unknown ones are null", async () => {
  await tool("queue_add", { title: "Fix the login page" }, "ses_lead");
  active = new Set(["ses_lead"]);
  await tool("queue_update", { item: 1, working: true }, "ses_lead");
  const refs = (await route("GET", "kuvo/work-queue/refs?refs=1,%2399,abc")).body.refs;
  assert.deepEqual(refs["1"], { id: refs["1"].id, number: 1, title: "Fix the login page", category: "next", inProgress: true, owner: "ses_lead" });
  assert.equal(refs["#99"], null);
  assert.equal(refs.abc, null);
});

test("a group chat's seats keep the group's queue", async () => {
  const added = await tool("queue_add", { title: "Decide the launch date" }, "ses_seat");
  assert.equal(added.isError, false, added.text);
  assert.deepEqual((await view("grp_team")).items.map(item => [item.title, item.owner]), [["Decide the launch date", "grp_team"]]);
  // Handed to a bot at the wrap-up: in its queue, and still in the group's view.
  assert.equal((await tool("queue_hand", { item: 1, to: "Scout" }, "ses_seat")).isError, false);
  assert.deepEqual((await view("grp_team")).items.map(item => item.owner), ["ses_scout"]);
  assert.deepEqual((await view("ses_scout")).items.map(item => item.title), ["Decide the launch date"]);
  // A seat of a group chat that lives on another computer: its queue is kept there.
  const far = await tool("queue_add", { title: "Split" }, "ses_farseat");
  assert.equal(far.isError, true);
  assert.match(far.text, /lives on another of the user's computers/);
  assert.equal((await view("grp_far")).items.length, 0);
});

test("an agent imports its old backlog with its numbers; new items number after them", async () => {
  const imported = await tool("queue_import", { items: [
    { number: 243, title: "The Work Queue", body: "Replaces BACKLOG.md.", category: "Next" },
    { number: 12, title: "Update All alert", done: true },
    { number: 7, title: "Someday", category: "nowhere" },
    { title: "No number" },
  ] }, "ses_lead");
  assert.equal(imported.text, "Imported 2 items with their numbers: 1 in Next, 1 in Done. Left out (2): #7 (there's no category nowhere); an item with no number.");
  const next = await tool("queue_add", { title: "After the import" }, "ses_lead");
  assert.equal(numberIn(next.text), 244);
  const again = await tool("queue_import", { items: [{ number: 243, title: "The work queue" }] }, "ses_lead");
  assert.match(again.text, /Nothing was imported\. Left out \(1\): #243 \(already in the Work Queue here\)/);
  // Another item under a number given here already: kept, with a new number and a note.
  const clash = await tool("queue_import", { items: [{ number: 244, title: "Something else" }] }, "ses_lead");
  assert.match(clash.text, /Imported 1 item with their numbers: 1 in Next\. Renumbered, as their own number is another item's or couldn't be kept \(each has a note saying why\): #244 is #245\./);
  assert.match((await route("GET", "kuvo/work-queue/items/245")).body.item.notes[0].text, /^Imported as #244/);
  // The same backlog imported again doesn't make it twice.
  assert.match((await tool("queue_import", { items: [{ number: 244, title: "Something else" }] }, "ses_lead")).text, /^Nothing was imported\./);
});

test("a client imports BACKLOG.md files from the box: list lines starting with #n, categories from headings and sorted lines, the details file's text as bodies", async () => {
  const backlog = path.join(home, "notes", "BACKLOG.md");
  const details = path.join(home, "notes", "BACKLOG-DETAILS.md");
  write(backlog, [
    "# Backlog",
    "NOW: #5 #6",
    "LATER: #4",
    "## Where things stand",
    "### Next",
    "- #5 The goal bar opens a sheet. More words here.",
    "- #305/#306 Two at once",
    "- A line about #900 that doesn't start with it",
    "### Merged, you haven't tried them yet",
    "- #4 [~] Usage rows per account",
    "## Open, by area",
    "### Ideas for later",
    "- #6 A cute office",
    "- #7 Voice: Parakeet",
    "## Done",
    "### Mac app",
    "- #8 Update All alert, #9 read row name",
    "- #10 [x] Old thing",
  ].join("\n"));
  write(details, "- #5 [ ] FEATURE, user 11-07: the goal bar.\n- #5 DECIDED: expand in place.\n- #7 [ ] Voice, parked.\n");
  const done = await route("POST", "kuvo/work-queue/import", { owner: "ses_lead", files: [backlog, details] });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body.byCategory, { next: 3, later: 2, done: 2 });
  assert.deepEqual(done.body.skipped.sort(), ["#306 (named with #305 on one line)", "#9 (named, but no line starts with it)", "#900 (named, but no line starts with it)"].sort());
  const items = Object.fromEntries((await view("ses_lead")).items.map(item => [item.number, item]));
  assert.deepEqual(Object.fromEntries(Object.entries(items).map(([n, item]) => [n, item.category])), { 4: "later", 5: "next", 6: "next", 7: "later", 8: "done", 10: "done", 305: "next" });
  assert.equal(items[5].title, "The goal bar opens a sheet.");
  assert.equal((await route("GET", "kuvo/work-queue/items/5")).body.item.body, "#5 The goal bar opens a sheet. More words here.\n\n#5 [ ] FEATURE, user 11-07: the goal bar.\n\n#5 DECIDED: expand in place.");
});

test("the primary hands out numbers: a block to another box, the same block for an ask sent again, and claims granted above what it handed out or from the asking box's own blocks", () => {
  const primary = path.join(home, "numbers-primary.json");
  const machine = path.join(home, "numbers-machine.json");
  const away = { peer: { key: "k", address: "a", kind: "mac", name: "Mac" } };
  // The primary numbers its own first.
  assert.equal(link.takeNumber({ self: true }, { file: primary }), 1);
  // The machine has no lease yet: no number, and an ask under way, sent once in its half minute.
  assert.equal(link.takeNumber(away, { file: machine, now: 1000 }), null);
  const ask = link.askToSend({ file: machine, now: 1000 });
  assert.equal(ask.count, link.QUEUE_BLOCK);
  assert.equal(link.askToSend({ file: machine, now: 2000 }), null);
  assert.deepEqual(link.askToSend({ file: machine, now: 32_000 }), ask, "sent again, the same ask");
  const block = link.giveBlock("machine-key", ask, { file: primary });
  assert.deepEqual([block.from, block.to], [2, 1 + link.QUEUE_BLOCK]);
  assert.deepEqual(link.giveBlock("machine-key", ask, { file: primary }), block, "an ask sent again gets the same block");
  assert.deepEqual(link.takeBlock({ ...block }, { file: machine }), { granted: [], claimed: [] });
  assert.equal(link.takeBlock({ ...block }, { file: machine }), null, "taken once");
  assert.equal(link.takeNumber(away, { file: machine }), 2);
  assert.equal(link.takeNumber({ self: true }, { file: primary }), 2 + link.QUEUE_BLOCK, "the primary numbers past the block it gave");

  // A claim from an import on the machine: what's above the counter is granted, and what's in a block
  // the primary gave that box (its own, which it never used: it claims none it used); never one the
  // primary numbered itself.
  assert.deepEqual(link.claimNumbers(away, [1, 3, 200, 201], { file: machine }), { granted: null });
  assert.ok(link.readNumbers(machine).leases.every(([from]) => from > 201), "leases at or below a claim go");
  const claim = link.askToSend({ file: machine, now: 100_000 });
  assert.deepEqual(claim.claims, [[1, 1], [3, 3], [200, 201]]);
  const answer = link.giveBlock("machine-key", claim, { file: primary });
  assert.deepEqual(answer.granted, [[3, 3], [200, 201]]);
  assert.ok(answer.from > 201);
  assert.deepEqual(link.giveBlock("other-key", { id: "wqn_otherother0", claims: [[4, 4]], own: true }, { file: primary }).granted, [], "another box's block is never granted");
  // An older box doesn't say it never claims a number it used (`own`): its own block isn't granted it.
  assert.deepEqual(link.giveBlock("machine-key", { id: "wqn_olderolder0", claims: [[4, 4]] }, { file: primary }).granted, []);
  // The same box asking again for what it was granted keeps it.
  const again = link.giveBlock("machine-key", { id: "wqn_againagain1", claims: [[200, 201]] }, { file: primary });
  assert.deepEqual(again.granted, [[200, 201]]);
  assert.deepEqual(link.giveBlock("other-key", { id: "wqn_otherother1", claims: [[200, 200]] }, { file: primary }).granted, [], "never to another box");
  // On the primary, its own claims are granted at once.
  assert.deepEqual(link.claimNumbers({ self: true }, [5000], { file: primary }), { granted: [[5000, 5000]] });
  // One far past the counter isn't: the counter stays where numbers are in use (one stray number
  // mustn't move every number past what a chip reads).
  assert.deepEqual(link.claimNumbers({ self: true }, [5001 + link.QUEUE_CLAIM_REACH + 1, 900_000], { file: primary }), { granted: [] });
  assert.equal(link.readNumbers(primary).next, 5001);
});

test("a primary whose counter was lost hands out numbers past those it has, never #1 again", async () => {
  for (const title of ["One", "Two", "Three"]) await tool("queue_add", { title }, "ses_lead");
  fs.rmSync(path.join(queues, "numbers.json"));
  const block = link.giveBlock("machine-key", { id: "wqn_lostlostlost1", count: 10 }, { file: path.join(queues, "numbers.json") });
  assert.deepEqual([block.from, block.to], [4, 13]);
  assert.equal(numberIn((await tool("queue_add", { title: "Four" }, "ses_lead")).text), 14);
});

test("an import keeps numbers of six digits at most, and one far past the numbers in use is numbered afresh", async () => {
  const imported = await tool("queue_import", { items: [{ number: 3, title: "Near" }, { number: 1_234_567, title: "Seven digits" }, { number: 900_000, title: "Far" }] }, "ses_lead");
  assert.match(imported.text, /#1234567 \(it needs a whole number of six digits at most, and a title\)/);
  const items = (await view("ses_lead")).items;
  assert.deepEqual(items.map(item => item.title), ["Near", "Far"]);
  assert.equal(items[0].number, 3);
  assert.ok(items[1].number < 100, `numbered afresh, not #${items[1].number}`);
  assert.match((await route("GET", `kuvo/work-queue/items/${items[1].number}`)).body.item.notes[0].text, /^Imported as #900000, a number that couldn.t be kept/);
  assert.ok(numberIn((await tool("queue_add", { title: "Next one" }, "ses_lead")).text) < 100, "new items go on numbering where they were");
});

test("a project around Kuvo Code's own folder (one at the home folder) doesn't make its files the project's", async () => {
  write(path.join(home, "run", "secret.json"), "{}");
  const refused = await tool("queue_add", { title: "Grab", files: [path.join(home, "run", "secret.json")] }, "ses_wide");
  assert.equal(refused.isError, true);
  assert.match(refused.text, /isn't in this conversation's folder/);
});

test("an item two queue files hold (a hand-off cut off between its writes) is one item, and the next change keeps it once", async () => {
  await tool("queue_add", { title: "Handed" }, "ses_lead");
  const lead = path.join(queues, "queues", "ses_lead.json");
  const kept = JSON.parse(fs.readFileSync(lead, "utf8"));
  write(path.join(queues, "queues", "ses_child.json"), JSON.stringify({ owner: "ses_child", items: [{ ...kept.items[0], owner: "ses_child", updated: { at: kept.items[0].updated.at + 1, by: { user: true } } }] }));
  assert.deepEqual((await view("all")).items.filter(item => item.title === "Handed").map(item => item.owner), ["ses_child"], "shown once, where it went");
  await tool("queue_add", { title: "Another" }, "ses_lead");
  const all = (await view("all")).items;
  assert.deepEqual(all.filter(item => item.title === "Handed").map(item => item.owner), ["ses_child"], "once, where it went");
  assert.equal(JSON.parse(fs.readFileSync(lead, "utf8")).items.some(item => item.title === "Handed"), false);
});

test("a queue file that can't be read is never written over: the change is refused and the file set aside", async () => {
  await tool("queue_add", { title: "Precious" }, "ses_lead");
  const lead = path.join(queues, "queues", "ses_lead.json");
  fs.writeFileSync(lead, "{\"owner\": \"ses_lead\", \"items\": [ cut off");
  const refused = await tool("queue_add", { title: "New" }, "ses_lead");
  assert.equal(refused.isError, true);
  assert.match(refused.text, /ses_lead's Work Queue file can't be read, so nothing was changed\. It's kept at .*aside.*ses_lead-\d+\.json/);
  const aside = fs.readdirSync(path.join(queues, "queues", "aside"));
  assert.equal(aside.length, 1);
  assert.match(fs.readFileSync(path.join(queues, "queues", "aside", aside[0]), "utf8"), /cut off/, "what it held is kept");
  assert.equal((await tool("queue_add", { title: "New" }, "ses_lead")).isError, false, "then the queue carries on");
});

test("a queue file that can't be read just now (no permission) is refused, and left where it is", async () => {
  await tool("queue_add", { title: "Precious" }, "ses_lead");
  const lead = path.join(queues, "queues", "ses_lead.json");
  fs.chmodSync(lead, 0o000);
  try {
    const refused = await tool("queue_add", { title: "New" }, "ses_lead");
    assert.equal(refused.isError, true);
    assert.match(refused.text, /can't be read just now, so nothing was changed: try again/);
    assert.equal(fs.existsSync(path.join(queues, "queues", "aside")), false, "nothing set aside");
  } finally {
    fs.chmodSync(lead, 0o600);
  }
  assert.deepEqual((await view("ses_lead")).items.map(item => item.title), ["Precious"]);
});

test("a move of a conversation whose queue file isn't one sets it aside and carries on", async () => {
  write(path.join(queues, "queues", "ses_scout.json"), "not json");
  assert.equal(link.packWorkQueues(["ses_scout"]), null);
  assert.equal(fs.readdirSync(path.join(queues, "queues", "aside")).length, 1);
});

test("what a newer box keeps of an item is kept here when this box writes it", async () => {
  await tool("queue_add", { title: "Has more" }, "ses_lead");
  const lead = path.join(queues, "queues", "ses_lead.json");
  const kept = JSON.parse(fs.readFileSync(lead, "utf8"));
  kept.items[0].estimate = { hours: 3 };
  write(lead, JSON.stringify(kept));
  await tool("queue_update", { item: 1, note: "Still here?" }, "ses_lead");
  assert.deepEqual(JSON.parse(fs.readFileSync(lead, "utf8")).items[0].estimate, { hours: 3 });
});

test("a change from someone this box doesn't know the shape of (an outside tracker's) keeps its author, never turned into you, and its notes", async () => {
  await tool("queue_add", { title: "From upstream" }, "ses_lead");
  const lead = path.join(queues, "queues", "ses_lead.json");
  const kept = JSON.parse(fs.readFileSync(lead, "utf8"));
  const octocat = { source: "github", name: "octocat" };
  kept.items[0].created.by = octocat;
  kept.items[0].notes = [{ at: 1, by: octocat, text: "Reopened upstream" }];
  write(lead, JSON.stringify(kept));
  await tool("queue_update", { item: 1, note: "Picked up" }, "ses_lead");
  const now = JSON.parse(fs.readFileSync(lead, "utf8")).items[0];
  assert.deepEqual(now.created.by, octocat);
  assert.deepEqual(now.notes.map(note => [note.by, note.text]), [[octocat, "Reopened upstream"], [{ session: "ses_lead", name: "Lead" }, "Picked up"]]);
  const shown = await tool("queue_show", { item: 1 }, "ses_lead");
  assert.match(shown.text, /Added just now by octocat; /);
  assert.match(shown.text, /- \d+d ago, octocat: Reopened upstream/);
  assert.deepEqual((await view("ses_lead")).items[0].created.by, octocat, "clients get it as it is");
});

test("a queue of a kind this box doesn't know (a newer box's) is kept as it is: never shown, skipped or written over", async () => {
  const theirs = path.join(queues, "queues", "prj_storefront.json");
  const text = JSON.stringify({ owner: "prj_storefront", items: [{ id: "wqi_projectprojectproj01", owner: "prj_storefront", title: "A project's", category: "next", order: 0, notes: [], files: [], links: [], sessions: [], created: { at: 1, by: { user: true } }, updated: { at: 1, by: { user: true } } }] });
  write(theirs, text);
  await tool("queue_add", { title: "Ours" }, "ses_lead");
  assert.equal(fs.readFileSync(theirs, "utf8"), text);
  assert.deepEqual((await view("all")).items.map(item => item.title), ["Ours"]);
  // A move of an owner by that name carries it along.
  assert.deepEqual(link.packWorkQueues(["prj_storefront"]).items.map(item => item.title), ["A project's"]);
});

test("a queue of a kind this box doesn't know that it can't read, or that holds one of its own items too, is left untouched, and its own item stays", async () => {
  // A newer box's file in a shape this box doesn't know: never set aside or written, and never in
  // the way of a change here.
  const odd = path.join(queues, "queues", "prj_odd.json");
  write(odd, JSON.stringify({ owner: "prj_odd", rows: [{ anything: true }] }));
  const added = await tool("queue_add", { title: "Ours" }, "ses_lead");
  assert.equal(added.isError, false, added.text);
  assert.equal(fs.readFileSync(odd, "utf8"), JSON.stringify({ owner: "prj_odd", rows: [{ anything: true }] }));
  assert.equal(fs.existsSync(path.join(queues, "queues", "aside")), false, "nothing set aside");
  assert.equal(link.packWorkQueues(["prj_odd"]), null, "nor carried: it stays as it is");
  link.forgetWorkQueues(["prj_odd"]);
  assert.equal(fs.existsSync(odd), true);
  // A newer box's queue holding a copy of one of this box's items, changed later: this box's item
  // stays in its own queue, and that file as it was.
  const ours = (await view("ses_lead")).items[0];
  const kept = JSON.parse(fs.readFileSync(path.join(queues, "queues", "ses_lead.json"), "utf8")).items[0];
  const copy = JSON.stringify({ owner: "prj_copy", items: [{ ...kept, owner: "prj_copy", title: "Their copy", updated: { at: Date.now() + 60_000, by: { user: true } } }] });
  write(path.join(queues, "queues", "prj_copy.json"), copy);
  assert.equal((await tool("queue_update", { item: ours.number, note: "Still ours" }, "ses_lead")).isError, false);
  assert.deepEqual((await view("ses_lead")).items.map(item => item.title), ["Ours"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(queues, "queues", "ses_lead.json"), "utf8")).items.length, 1);
  assert.equal(fs.readFileSync(path.join(queues, "queues", "prj_copy.json"), "utf8"), copy);
});

test("an outside source's item (an issue) is never numbered, and is named by its ref", async () => {
  await tool("queue_add", { title: "Ours" }, "ses_lead");
  const lead = path.join(queues, "queues", "ses_lead.json");
  const kept = JSON.parse(fs.readFileSync(lead, "utf8"));
  kept.items.push({ ...kept.items[0], id: "wqi_issueissueissue00001", number: undefined, title: "Login loops", source: { kind: "github", ref: "gh:owner/repo#12", url: "https://github.com/owner/repo/issues/12", host: "github.com", id: "I_kw123" } });
  write(lead, JSON.stringify(kept));
  link.reclaimWaiting({ self: true }, { file: path.join(queues, "numbers.json") });
  await tool("queue_add", { title: "Next one" }, "ses_lead");
  const items = (await view("ses_lead")).items;
  assert.deepEqual(items.map(item => [item.title, item.number ?? null]), [["Ours", 1], ["Login loops", null], ["Next one", 2]]);
  assert.deepEqual(items[1].source, { kind: "github", ref: "gh:owner/repo#12", url: "https://github.com/owner/repo/issues/12", host: "github.com", id: "I_kw123", name: "repo#12" });
  const listed = await tool("queue_list", {}, "ses_lead");
  assert.match(listed.text, /- gh:owner\/repo#12 "Login loops"/);
});

test("items left waiting for a number with nothing under way (a crash midway, a move) are numbered again", async () => {
  await tool("queue_add", { title: "First" }, "ses_lead");
  const lead = path.join(queues, "queues", "ses_lead.json");
  const kept = JSON.parse(fs.readFileSync(lead, "utf8"));
  kept.items.push({ ...kept.items[0], id: "wqi_waitingwaitingwait01", number: undefined, wanted: 40, title: "Imported, waiting" });
  kept.items.push({ ...kept.items[0], id: "wqi_waitingwaitingnone01", number: undefined, title: "Made, waiting" });
  write(lead, JSON.stringify(kept));
  assert.equal(link.reclaimWaiting({ self: true }, { file: path.join(queues, "numbers.json") }), true);
  const items = (await view("ses_lead")).items;
  assert.deepEqual(items.map(item => [item.title, item.number]), [["First", 1], ["Imported, waiting", 40], ["Made, waiting", 41]]);
  assert.equal(link.reclaimWaiting({ self: true }, { file: path.join(queues, "numbers.json") }), false, "nothing waits now");
});

test("a machine with no number left keeps its items waiting, shown without one, until its block comes", async () => {
  // This box's primary: a Mac it names, that isn't answering.
  write(path.join(home, "run", "work-queue", "numbers.json"), JSON.stringify({ primary: "macKeyThatIsAway", leases: [] }));
  const added = await tool("queue_add", { title: "Offline idea" }, "ses_lead");
  assert.match(added.text, /^Added "Offline idea" to Next\. It has no number yet/);
  const item = (await view("ses_lead")).items[0];
  assert.equal(item.number, undefined);
  assert.ok(link.readNumbers(path.join(queues, "numbers.json")).asking, "an ask waits to go to the primary");
  assert.match((await tool("queue_list", {}, "ses_lead")).text, /\(1 open, 1 waiting for a number\)/);
  // Named by the id it was told, it can still be worked on.
  assert.match(added.text, new RegExp(`Name it as ${item.id} meanwhile`));
  const done = await tool("queue_update", { item: item.id, category: "done" }, "ses_lead");
  assert.equal(done.text, `Marked "Offline idea" (${item.id}, no number yet) done.`);
});

test("an import on a machine waits for the primary to grant its numbers: granted ones keep theirs, one handed out already gets a new one, with a note", async () => {
  const file = path.join(queues, "numbers.json");
  const away = { peer: { key: "macKeyThatIsAway", address: "a", kind: "mac", name: "Mac" } };
  write(file, JSON.stringify({ primary: "macKeyThatIsAway", leases: [] }));
  const imported = await tool("queue_import", { items: [{ number: 243, title: "The Work Queue" }, { number: 5, title: "Old one" }] }, "ses_lead");
  assert.match(imported.text, /^Imported 2 items with their numbers: 2 in Next\. 2 wait for the primary computer to grant their numbers; until then they show as new\./);
  await tool("queue_add", { title: "Made meanwhile" }, "ses_lead");
  assert.deepEqual((await view("ses_lead")).items.map(item => [item.title, item.number ?? null, item.wanted ?? null]), [["The Work Queue", null, 243], ["Old one", null, 5], ["Made meanwhile", null, null]]);
  // The primary's answer: it had handed out #5 already.
  const ask = link.askToSend({ file });
  assert.deepEqual(ask.claims, [[5, 5], [243, 243]]);
  assert.equal(link.blockArrived({ id: ask.id, from: 300, to: 349, granted: [[243, 243]] }, away, { file }), true);
  const items = (await view("ses_lead")).items;
  assert.deepEqual(items.map(item => [item.title, item.number]), [["The Work Queue", 243], ["Old one", 300], ["Made meanwhile", 301]]);
  assert.match(items[1].lastNote.text, /^Imported as #5, a number that couldn.t be kept \(another of your computers was given it already, or it.s far past the numbers in use\), so it has a new one\./);
  assert.equal(link.blockArrived({ id: ask.id, from: 300, to: 349, granted: [] }, away, { file }), false, "taken once");
});

const BOX_KEY = "boxKeyOfThisOne".padEnd(43, "0");
const told = (key, numbering) => write(path.join(queues, "peers", `${key.padEnd(43, "0")}.json`), JSON.stringify({ id: `wqt_${key}`, at: 1, heard: 1, items: [], owners: [], categories: [], ...numbering }));
// A box that numbers from another (this one, as mini-local did), and its primary, with the mail
// between them: an ask sent, and the primary's answer, given to the box now or later.
function twoBoxes() {
  const file = path.join(queues, "numbers.json");
  const primary = path.join(fs.mkdtempSync(path.join(home, "primary-")), "numbers.json");
  const away = { peer: { key: "macKeyThatIsAway", address: "a", kind: "mac", name: "Mac" } };
  write(file, JSON.stringify({ primary: "macKeyThatIsAway", leases: [] }));
  const send = () => {
    const ask = link.askToSend({ file });
    return ask && link.giveBlock(BOX_KEY, ask, { file: primary });
  };
  const arrive = give => link.blockArrived(give, away, { file });
  // Every ask due sent, and answered at once, until none is.
  const settle = () => { for (let give = send(); give; give = send()) arrive(give); };
  return { file, primary, away, send, arrive, settle };
}
const backlog = numbers => numbers.map(number => ({ number, title: `Item ${number}` }));
const span = (from, to) => Array.from({ length: to - from + 1 }, (_, at) => from + at);
const numbered = async owner => Object.fromEntries((await view(owner)).items.map(item => [item.title, item.number ?? null]));

test("three imports in a row on a box that numbers from another keep every number, whenever the primary's answers come", async () => {
  const { send, arrive, settle } = twoBoxes();
  const batches = [span(1, 150), span(151, 300), span(301, 448).filter(n => n !== 444)];
  // As on mini-local: each batch's ask is answered while the next import goes on, so that answer
  // comes to an ask the import replaced; and an ask for more numbers is answered late the same way.
  const first = await tool("queue_import", { items: backlog(batches[0]) }, "ses_lead");
  assert.match(first.text, /^Imported 150 items with their numbers: 150 in Next\. 150 wait for the primary computer to grant their numbers/);
  let late = send();
  const second = await tool("queue_import", { items: backlog(batches[1]) }, "ses_lead");
  assert.equal(arrive(late), false, "an answer to the ask the import replaced");
  assert.equal(arrive(send()), true);
  late = send();
  const third = await tool("queue_import", { items: backlog(batches[2]) }, "ses_lead");
  if (late) arrive(late);
  settle();
  for (const said of [first, second, third]) assert.doesNotMatch(said.text, /new number|Renumbered|Left out/, said.text);
  const items = await numbered("ses_lead");
  assert.equal(Object.keys(items).length, 447);
  for (const n of batches.flat()) assert.equal(items[`Item ${n}`], n, `Item ${n} is #${items[`Item ${n}`]}`);
  assert.ok(numberIn((await tool("queue_add", { title: "After the import" }, "ses_lead")).text) > 448, "new items number after them");
  settle();
});

test("a number that's another item's is renumbered, and the import says which and to what; one waiting for its number counts as its own", async () => {
  const { settle } = twoBoxes();
  await tool("queue_import", { items: [{ number: 10, title: "Ten" }, { number: 11, title: "Eleven" }] }, "ses_lead");
  // Before the primary answers: the same again is the same item, waiting for its number.
  const again = await tool("queue_import", { items: [{ number: 10, title: "Ten" }, { number: 11, title: "Eleven" }, { number: 12, title: "Twelve" }] }, "ses_lead");
  assert.equal(again.text, "Imported 1 item with their numbers: 1 in Next. 1 waits for the primary computer to grant its number; until then it shows as new. Left out (2): #10–11 (already in the Work Queue here).");
  // A different item under a number that's another's: a new number, said.
  const clash = await tool("queue_import", { items: [{ number: 11, title: "Not eleven" }] }, "ses_lead");
  assert.match(clash.text, /Renumbered, as their own number is another item's or couldn't be kept \(each has a note saying why\): #11 waits for a new number\./);
  settle();
  const items = await numbered("ses_lead");
  assert.deepEqual([items.Ten, items.Eleven, items.Twelve], [10, 11, 12]);
  assert.ok(items["Not eleven"] > 12, `Not eleven is #${items["Not eleven"]}`);
  assert.match((await route("GET", `kuvo/work-queue/items/${items["Not eleven"]}`)).body.item.notes[0].text, /^Imported as #11, a number already given to another item here/);
  // On the primary, one it can't keep is said at once too.
  fs.rmSync(queues, { recursive: true, force: true });
  await tool("queue_add", { title: "First" }, "ses_lead");
  const far = await tool("queue_import", { items: [{ number: 900_000, title: "Far" }, { number: 1, title: "Another first" }] }, "ses_lead");
  assert.match(far.text, /Renumbered, as their own number is another item's or couldn't be kept \(each has a note saying why\): #1 is #3, #900000 is #2\./);
});

test("numbers an import waits for are never handed out meanwhile: not from a block that comes late, nor from one the box held", async () => {
  const { file, send, arrive, settle } = twoBoxes();
  // A block this box asked for before the import, given while the import is under way.
  await tool("queue_add", { title: "Before" }, "ses_lead");
  const late = send();
  assert.deepEqual([late.from, late.to], [1, link.QUEUE_BLOCK]);
  await tool("queue_import", { items: backlog(span(2, 60)) }, "ses_lead");
  assert.equal(arrive(late), false);
  assert.match((await tool("queue_add", { title: "Meanwhile" }, "ses_lead")).text, /It has no number yet/);
  settle();
  let items = await numbered("ses_lead");
  for (const n of span(2, 60)) assert.equal(items[`Item ${n}`], n);
  assert.ok(items.Before > 60 && items.Meanwhile > 60 && items.Before !== items.Meanwhile, JSON.stringify([items.Before, items.Meanwhile]));
  // A block held, a number of it used: the import keeps the rest of the block's numbers, never the one used.
  fs.rmSync(queues, { recursive: true, force: true });
  const again = twoBoxes();
  await tool("queue_add", { title: "Early" }, "ses_lead");
  again.settle();
  const early = (await numbered("ses_lead")).Early;
  const said = await tool("queue_import", { items: backlog(span(early, early + 59)) }, "ses_lead");
  assert.match(said.text, new RegExp(`#${early} waits for a new number`));
  await tool("queue_add", { title: "Meanwhile" }, "ses_lead");
  again.settle();
  items = await numbered("ses_lead");
  assert.equal(items.Early, early);
  for (const n of span(early + 1, early + 59)) assert.equal(items[`Item ${n}`], n);
  assert.ok(items[`Item ${early}`] > early + 59 && items.Meanwhile > early + 59);
  assert.equal(new Set(Object.values(items)).size, Object.keys(items).length, "no number twice");
  assert.equal(link.readNumbers(file).asking, undefined);
  // The item that had it gone from here (a move took it): its number is still never claimed.
  const lead = path.join(queues, "queues", "ses_lead.json");
  const kept = JSON.parse(fs.readFileSync(lead, "utf8"));
  write(lead, JSON.stringify({ ...kept, items: kept.items.filter(item => item.title !== "Early") }));
  assert.match((await tool("queue_import", { items: [{ number: early, title: "Another" }] }, "ses_lead")).text, new RegExp(`: #${early} is #\\d+\\.`));
  assert.notEqual((await numbered("ses_lead")).Another, early);
  // Nor one an import here was granted, gone from here too.
  const now = JSON.parse(fs.readFileSync(lead, "utf8"));
  write(lead, JSON.stringify({ ...now, items: now.items.filter(item => item.title !== `Item ${early + 1}`) }));
  assert.match((await tool("queue_import", { items: [{ number: early + 1, title: "Yet another" }] }, "ses_lead")).text, new RegExp(`: #${early + 1} is #\\d+\\.`));
  assert.match((await view("ses_lead")).items.find(item => item.title === "Yet another").lastNote.text, /a number already given to another item, one no longer here/);
});

// The queue as mini-local's import left it (11-11), and its primary's numbers as an older box kept
// them: blocks with no word of whom they went to.
function brokenImport({ primary, file }) {
  const items = [];
  const item = (title, number, importedAs, at) => ({ id: `wqi_${String(items.length).padStart(20, "0")}`, number, owner: "ses_lead", title, body: "", category: "next", order: items.length, notes: importedAs ? [{ at, by: { user: true }, text: `Imported as #${importedAs}, a number that couldn't be kept (another of your computers was given it already, or it's far past the numbers in use), so it has a new one.` }] : [], files: [], links: [], sessions: [], created: { at, by: { session: "ses_lead", name: "Lead" } }, updated: { at, by: { session: "ses_lead", name: "Lead" } }, ...(importedAs ? { importedAs } : {}) });
  for (const n of span(1, 150)) items.push(item(`Item ${n}`, n, undefined, 1));
  for (const n of span(151, 300)) items.push(n <= 200 ? item(`Item ${n}`, n + 150, n, 2) : item(`Item ${n}`, n, undefined, 2));
  for (const n of span(301, 448).filter(n => n !== 444)) items.push(n <= 400 ? item(`Item ${n}`, n + 148, n, 3) : item(`Item ${n}`, n, undefined, 3));
  write(path.join(queues, "queues", "ses_lead.json"), JSON.stringify({ owner: "ses_lead", items }));
  write(file, JSON.stringify({ primary: "macKeyThatIsAway", leases: [[549, 598]] }));
  const given = [[151, 200, [[1, 150]]], [301, 350, [[1, 150], [201, 300]]], [351, 400, []], [449, 498, [[401, 448]]], [499, 548, []], [549, 598, []]];
  write(primary, JSON.stringify({ primary: "self", next: 599, leases: [], granted: { [BOX_KEY]: [[1, 150], [201, 300], [401, 448]] }, given: Object.fromEntries(given.map(([from, to, granted], at) => [`wqn_oldaskoldask${at}`, { from, to, granted, at }])) }));
  // What the other computers told: a machine with nothing, and this box, past them all.
  told("machineWithNothing", { kind: "machine" });
  told("boxKeyOfThisOne", { kind: "mac", top: 598 });
}

test("importing the same backlog again gives items an import renumbered their own numbers back, in place, once", async () => {
  const batches = [span(1, 150), span(151, 300), span(301, 448).filter(n => n !== 444)];
  // The answer coming after each batch, or only after the last (the items holding #301–350 move
  // off them in the same answer as the ones moving onto them).
  for (const answeredEach of [true, false]) {
    fs.rmSync(queues, { recursive: true, force: true });
    const boxes = twoBoxes();
    brokenImport(boxes);
    const said = [];
    for (const batch of batches) {
      said.push((await tool("queue_import", { items: backlog(batch) }, "ses_lead")).text);
      if (answeredEach) boxes.settle();
    }
    boxes.settle();
    assert.match(said[0], /^Nothing was imported\. Left out \(150\): #1–150 \(already in the Work Queue here\)\.$/);
    assert.match(said[1], /^50 items imported before ask for their own number back, keeping the one they have until then: #301 \(for #151\), #302 \(for #152\),/);
    assert.match(said[1], /Left out \(100\): #201–300 \(already in the Work Queue here\)\.$/);
    assert.match(said[2], /^100 items imported before ask for their own number back/);
    const items = await numbered("ses_lead");
    assert.equal(Object.keys(items).length, 447, "nothing made twice");
    for (const n of batches.flat()) assert.equal(items[`Item ${n}`], n, `Item ${n} is #${items[`Item ${n}`]} (answered ${answeredEach ? "after each" : "at the end"})`);
    const kept = JSON.parse(fs.readFileSync(path.join(queues, "queues", "ses_lead.json"), "utf8")).items;
    assert.ok(kept.every(item => item.importedAs === undefined && item.wanted === undefined));
    assert.match(kept.find(item => item.title === "Item 198").notes.at(-1).text, /^Has its own number, #198, again \(it was #348\)\.$/);
    // Again: nothing changes, nothing is asked.
    const before = fs.readFileSync(path.join(queues, "queues", "ses_lead.json"), "utf8");
    for (const batch of batches) assert.match((await tool("queue_import", { items: backlog(batch) }, "ses_lead")).text, /^Nothing was imported\. Left out \(\d+\): #[\d–, #]+ \(already in the Work Queue here\)\.$/);
    assert.equal(link.readNumbers(boxes.file).asking, undefined);
    assert.equal(fs.readFileSync(path.join(queues, "queues", "ses_lead.json"), "utf8"), before);
  }
});

test("a primary gives an older block back only to a box it can only have gone to", async () => {
  const boxes = twoBoxes();
  brokenImport(boxes);
  // Another computer told it holds numbers as high: the block could be its, so it stays refused.
  told("otherMacHoldingSome", { kind: "mac", top: 175 });
  await tool("queue_import", { items: backlog([198, 352, 380]) }, "ses_lead");
  boxes.settle();
  const items = await numbered("ses_lead");
  assert.deepEqual([items["Item 198"], items["Item 352"], items["Item 380"]], [348, 352, 380]);
  assert.match((await route("GET", "kuvo/work-queue/items/348")).body.item.lastNote.text, /^Its own number, #198, couldn't be given back/);
  // Imported again: it isn't asked again, and nothing else changes.
  const before = JSON.stringify(link.readNumbers(boxes.primary));
  assert.equal((await tool("queue_import", { items: backlog([198, 352]) }, "ses_lead")).text, "Nothing was imported. Left out (2): #352 (already in the Work Queue here); #198 (imported before as #348; its own number couldn't be given back).");
  assert.equal(link.readNumbers(boxes.file).asking, undefined);
  boxes.settle();
  assert.equal(JSON.stringify(link.readNumbers(boxes.primary)), before);
  assert.equal((await route("GET", "kuvo/work-queue/items/348")).body.item.noteCount, 2);
});

test("an item given its own number back waits for the one that has it to move, without asking again; if that one is deleted instead, it stays, with a note", async () => {
  for (const deleted of [false, true]) {
    fs.rmSync(queues, { recursive: true, force: true });
    const boxes = twoBoxes();
    // As an answer that came while an import went on leaves them: A has #10 back, and waits for H,
    // which has #10 and is asking for its own, #20.
    const at = 1;
    const item = (id, title, number, extra) => ({ id, number, owner: "ses_lead", title, body: "", category: "next", order: 0, notes: [], files: [], links: [], sessions: [], created: { at, by: { user: true } }, updated: { at, by: { user: true } }, ...extra });
    write(path.join(queues, "queues", "ses_lead.json"), JSON.stringify({ owner: "ses_lead", items: [
      item("wqi_AAAAAAAAAAAAAAAAAAAA", "A", 5, { importedAs: 10, wanted: 10, backGranted: true }),
      item("wqi_HHHHHHHHHHHHHHHHHHHH", "H", 10, { importedAs: 20, wanted: 20 }),
    ] }));
    write(boxes.primary, JSON.stringify({ primary: "self", next: 100, leases: [], given: { wqn_givengiven01: { from: 1, to: 99, granted: [], at: 1, by: BOX_KEY } } }));
    if (deleted) await tool("queue_remove", { item: 10 }, "ses_lead");
    for (let round = 0; round < 3; round++) {
      link.reclaimWaiting(boxes.away, { file: boxes.file });
      boxes.settle();
    }
    const kept = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(queues, "queues", "ses_lead.json"), "utf8")).items.map(each => [each.title, each]));
    if (deleted) {
      assert.deepEqual([kept.A.number, kept.A.wanted, kept.A.stays], [5, undefined, true]);
      assert.match(kept.A.notes.at(-1).text, /^Its own number, #10, is another item's here, so it stays #5\./);
      assert.equal(link.readNumbers(boxes.primary).next, 100, "never asked again");
    } else {
      assert.deepEqual([kept.A.number, kept.H.number], [10, 20]);
      assert.ok(kept.A.backGranted === undefined && kept.H.wanted === undefined);
      assert.ok(link.readNumbers(boxes.primary).next <= 100 + link.QUEUE_BLOCK, "asked once");
    }
    assert.equal(link.reclaimWaiting(boxes.away, { file: boxes.file }), false, "nothing waits");
  }
});

test("a move carries its conversations' queues and their files, and the box it left forgets them", async () => {
  write(path.join(bot, "workspace", "plan.md"), "# Plan");
  assert.equal((await tool("queue_add", { title: "Carried", files: [path.join(bot, "workspace", "plan.md")] }, "ses_scout")).isError, false, "a bot's own folder is in Kuvo Code's, and its files are its own");
  await tool("queue_add", { title: "Stays" }, "ses_lead");
  const carried = link.packWorkQueues(["ses_scout"]);
  assert.deepEqual(carried.items.map(item => item.title), ["Carried"]);
  const staging = path.join(home, "staging");
  fs.mkdirSync(path.join(staging, "work-queue"), { recursive: true });
  fs.cpSync(path.join(queues, "files", carried.withFiles[0]), path.join(staging, "work-queue", carried.withFiles[0]), { recursive: true });
  // While it moves, nothing changes its queue (what did would be left behind): not a hand-off into
  // it, not its own change, not yours.
  const record = path.join(home, "run", "moves", "mov_test1.json");
  write(record, JSON.stringify({ id: "mov_test1", thing: "bot_scout00001", kind: "bot", peer: "k", role: "from", sessions: ["ses_scout"], step: "parts", started: 1 }));
  await tool("queue_add", { title: "Handed in late" }, "ses_lead");
  const late = await tool("queue_hand", { item: 3, to: "Scout" }, "ses_lead");
  assert.deepEqual(late, { text: "That conversation is moving to another computer, with its Work Queue: try again once it's there.", isError: true });
  assert.equal((await tool("queue_update", { item: 1, note: "Meanwhile" }, "ses_scout")).isError, true);
  assert.equal((await route("POST", "kuvo/work-queue/items/1/move", { category: "later" })).status, 400);
  link.forgetWorkQueues(["ses_scout"]);
  fs.rmSync(record);
  await tool("queue_remove", { item: 3 }, "ses_lead");
  assert.equal(fs.existsSync(path.join(queues, "files", carried.withFiles[0])), false);
  // As it arrives on the other box: under the same owner and number, an owner it didn't carry left out.
  link.placeWorkQueues({ ...carried, items: [...carried.items, { ...carried.items[0], id: "wqi_AAAAAAAAAAAAAAAAAAAA", owner: "ses_lead" }] }, ["ses_scout"], staging);
  const back = await view("ses_scout");
  assert.deepEqual(back.items.map(item => [item.title, item.number]), [["Carried", 1]]);
  assert.equal((await route("GET", "kuvo/work-queue/items/1/files/plan.md")).raw, "# Plan");
  assert.deepEqual((await view("ses_lead")).items.map(item => item.title), ["Stays"]);
  assert.equal((await view("ses_lead")).removed.length, 1);
  // A conversation carried on as another takes its queue.
  link.carryWorkQueue("ses_scout", "ses_other");
  assert.deepEqual((await view("ses_other")).items.map(item => item.title), ["Carried"]);
});

test("a client follows a queue: a line now, and one when it changes (another process's change too) or a linked session starts work", async () => {
  await tool("queue_add", { title: "Watched", working: true }, "ses_lead");
  const stop = new AbortController();
  const lines = link.engineHandler()({ method: "GET", path: "kuvo/work-queue/events?owner=ses_lead", headers: {}, fromApp: true }, undefined, stop.signal);
  assert.equal((await lines.next()).value.head.status, 200);
  const nextView = async () => JSON.parse(String((await lines.next()).value.body));
  assert.deepEqual((await nextView()).items.map(item => [item.title, item.inProgress]), [["Watched", false]]);
  await tool("queue_add", { title: "Another" }, "ses_lead");
  assert.deepEqual((await nextView()).items.map(item => item.title), ["Watched", "Another"]);
  active = new Set(["ses_lead"]);
  assert.deepEqual((await nextView()).items.map(item => item.inProgress), [true, false]);
  await route("POST", "kuvo/work-queue/categories", { add: "Bugs" });
  assert.deepEqual((await nextView()).categories.map(each => each.name), ["Next", "Later", "Bugs", "Parked", "Done"]);
  fs.rmSync(path.join(queues, "categories.json"), { force: true });
  stop.abort();
  await lines.return();
});

test("every agent kind gets the tools through its tool server: a machine's kuvo-browser.js lists them, tells agents of them, and passes calls on", async () => {
  write(path.join(home, "bin", "kuvo-link.js"), fs.readFileSync(script));
  const browser = fileURLToPath(new URL("../../../../KuvoCode/Resources/kuvo-browser.js", import.meta.url));
  const mcp = spawn(process.execPath, [browser, "mcp"], { env: { ...process.env, KUVO_HOME: home, HOME: home, TMPDIR: home }, stdio: ["pipe", "pipe", "ignore"] });
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
  const send = (method, params) => new Promise(resolve => {
    const id = next++;
    answers.set(id, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const started = await send("initialize", { protocolVersion: "2025-06-18" });
  assert.match(started.instructions, /Keep work items in your Work Queue/);
  const listed = await send("tools/list", {});
  assert.deepEqual(listed.tools.map(each => each.name).filter(name => name.startsWith("queue_")), ["queue_list", "queue_show", "queue_add", "queue_update", "queue_hand", "queue_remove", "queue_categories", "queue_import"]);
  calling.set("ses_scout", { name: "queue_add", args: { title: "From Claude Code" } });
  const called = await send("tools/call", { name: "queue_add", arguments: { title: "From Claude Code" }, _meta: { "ai.opencode/sessionID": "ses_scout" } });
  assert.equal(called.isError, false, called.content[0].text);
  assert.match(called.content[0].text, /^Added #1 "From Claude Code" to Next/);
  mcp.kill();
});

// Move to Computer when something on the way goes wrong (PROTOCOL.md, `kuvo/moves`): a word between
// the boxes lost, a box started again partway, its engine or group chats not answering, a bot at
// work on a goal. Whatever it is, a move ends, and never leaves a second live copy, a group chat
// held for good, or a goal left behind with nobody at it. One box, real (this Mac's), against a
// scripted other computer whose mail goes to the script instead of the relay (`sendMovesWith`); its
// engine and its group chats' bridge are stand-ins.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/moves-recover.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test as nodeTest } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

// What's under way, as `kuvo/moves` says it (not what moved away lately, `moved`, which stays two days).
const underWay = ({ moved: _moved, ...rest } = {}) => rest;

// Each fails, rather than hangs, when what it waits for never comes.
let running = null;
const test = (name, run) => nodeTest(name, { timeout: 30_000 }, t => { running = t.signal; return run(t); });

const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-moves-recover-")));
const home = path.join(support, "mac");
const chats = path.join(support, "Chats"), wakes = path.join(support, "wakes"), bots = path.join(support, "bots");
fs.mkdirSync(path.join(home, "run"), { recursive: true });
Object.assign(process.env, {
  KUVO_HOME: home, KUVO_BOTS: bots, KUVO_WAKES: wakes, KUVO_BOX: "mac",
  KUVO_ENGINE_CONFIG: path.join(support, "opencode"), KUVO_KEYS: path.join(support, "keys"),
});
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
removeAtEnd(support);

function reading(request) {
  return new Promise(resolve => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}));
  });
}
const listening = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

// An engine with its conversations, as its API exports, imports and deletes them, what each has
// written (`replies`, oldest first), and what it was sent. Its deletes fail while it's `down`; its exports wait for `exportHold` (a promise) when
// there's one (`exporting` says one does).
const engine = { sessions: new Map(), prompts: [], down: false, refused: 0, exportHold: null, exporting: false };
const engineServer = http.createServer(async (request, response) => {
  const given = await reading(request);
  const url = new URL(request.url, "http://x");
  const send = (status, data) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ data }));
  const listed = each => ({ id: each.id, title: each.title, directory: each.directory, location: { directory: each.directory }, ...(each.metadata ? { metadata: each.metadata } : {}) });
  if (url.pathname === "/api/session" && url.searchParams.get("parentID")) return send(200, [...engine.sessions.values()].filter(each => each.parentID === url.searchParams.get("parentID")).map(listed));
  if (url.pathname === "/api/session/active") return send(200, {});
  if (url.pathname === "/api/experimental/session/import") {
    if (engine.sessions.has(given.info.id)) return response.writeHead(409).end("{}");
    engine.sessions.set(given.info.id, { id: given.info.id, title: given.info.title, parentID: given.info.parentID, directory: given.location.directory, messages: given.messages });
    return send(200, listed(engine.sessions.get(given.info.id)));
  }
  const exported = url.pathname.match(/^\/api\/experimental\/session\/([^/]+)\/export$/);
  if (exported) {
    if (engine.exportHold) {
      engine.exporting = true;
      await engine.exportHold;
      engine.exporting = false;
    }
    const session = engine.sessions.get(exported[1]);
    return session ? send(200, { info: { id: session.id, title: session.title, ...(session.parentID ? { parentID: session.parentID } : {}) }, messages: session.messages }) : send(404, null);
  }
  const match = url.pathname.match(/^\/api\/session\/([^/]+)(\/[a-z/]+)?$/);
  const session = match && engine.sessions.get(match[1]);
  if (!session) return send(404, null);
  if (match[2] === "/prompt") {
    engine.prompts.push({ session: session.id, text: given.text, delivery: given.delivery, ...(given.metadata ? { metadata: given.metadata } : {}) });
    return send(200, {});
  }
  if (match[2] === "/message") return send(200, [...(session.replies ?? [])].reverse());
  if (match[2] === "/inbox" || match[2] === "/permission" || match[2] === "/question") return send(200, []);
  if (match[2]) return send(200, true);
  if (request.method === "DELETE") {
    if (engine.down) {
      engine.refused += 1;
      return response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ message: "The engine went away." }));
    }
    engine.sessions.delete(session.id);
    return send(200, true);
  }
  return send(200, listed(session));
});
const enginePort = await listening(engineServer);
fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify({ port: enginePort, password: "pw" }));

// The group chats' bridge, as the link holds, brings in, starts and lets go of one; it answers 500
// to all of that while it's `down`.
// It also keeps conversations' own goals (`/goal`), by their sessions.
const groups = { chats: new Map(), down: false, refused: 0 };
const loops = new Map();
let loopsDown = false;
const bridgeServer = http.createServer(async (request, response) => {
  const given = await reading(request);
  const url = new URL(request.url, "http://x");
  const send = (status, value) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  const loop = url.pathname.match(/^\/api\/kuvo\/goals\/([^/]+)$/);
  if (loop && request.method === "GET" && loopsDown) return send(500, { message: "Busy." });
  if (loop && request.method === "GET") return loops.has(loop[1]) ? send(200, { data: loops.get(loop[1]) }) : send(404, { message: "That conversation has no goal." });
  const route = url.pathname.match(/^\/api\/kuvo\/groups(?:\/([^/]+)(?:\/([a-z]+))?)?$/);
  if (!route) return send(404, {});
  const [, id, action] = route;
  if (!id) return send(200, { data: [...groups.chats.values()] });
  if (groups.down && request.method !== "GET") {
    groups.refused += 1;
    return send(500, { message: "Group chats went away." });
  }
  const chat = groups.chats.get(id);
  if (request.method === "PUT") {
    groups.chats.set(id, { group: given.group, messages: given.messages ?? [], status: given.status === "active" ? "active" : "held" });
    return send(200, { data: groups.chats.get(id) });
  }
  if (!chat) return send(404, { message: "No such chat." });
  if (request.method === "GET") return send(200, { data: chat });
  if (action === "hold") {
    chat.status = "held";
    return send(200, { data: { group: chat.group, messages: chat.messages } });
  }
  if (action === "activate") {
    chat.status = "active";
    return send(200, { data: chat });
  }
  if (action === "release") {
    groups.chats.delete(id);
    return send(200, {});
  }
  return send(404, {});
});
const bridgePort = await listening(bridgeServer);
fs.writeFileSync(path.join(home, "run", "bridge.json"), JSON.stringify({ port: bridgePort, password: "pw", pid: process.pid }));

// This Mac's box, and its one other computer, "lab": what lab is told goes to `script`, and what
// lab says comes back as its mail would.
const peerKey = link.publicOf(link.newKey()).toString("base64url");
const lab = { key: peerKey, address: link.addressOf(crypto.randomBytes(32)).toString("base64url"), kind: "mac", name: "lab", id: "lab", sign: link.signingKeyOf(link.newSigningSeed()) };
link.writeLink({ macPeers: [lab] });
link.macLink.overlay = { key: link.newKey().toString("base64url"), secret: crypto.randomBytes(32).toString("base64url"), relay: "wss://relay.test", name: "Studio Mac" };
const told = [];
let script = () => {};
link.sendMovesWith((_peer, move) => {
  told.push(move);
  setImmediate(() => script(move));
  return true;
});
const say = move => link.takeMoveMail(lab, move);
let stop = new AbortController();
link.watchMoves(() => ({ send() {} }), stop.signal);
// This box starts again: what it kept in memory gone, its moves carried on from their records.
function startAgain() {
  stop.abort();
  link.forgetMovesInMemory();
  stop = new AbortController();
  link.watchMoves(() => ({ send() {} }), stop.signal);
}
atEnd(() => {
  stop.abort();
  link.sendMovesWith(null);
  for (const server of [engineServer, bridgeServer]) {
    server.closeAllConnections();
    server.close();
  }
});

const handle = link.engineHandler(link.readEngineFile, { name: "Mac" }, link.readBridgeFile, () => {}, null);
async function ask(method, p, given) {
  const parts = [];
  for await (const part of handle({ method, path: p, headers: {}, body: given ? Buffer.from(JSON.stringify(given)) : Buffer.alloc(0), fromApp: true }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  return { status: parts[0].head.status, json: text ? JSON.parse(text) : null };
}

// Until `found` holds: looked at again as the script hears more, however long that takes (a busy
// machine is slow, never wrong); a test that never sees it fails at its time limit.
// (One whose test has ended, at its time limit, stops looking rather than spinning on.)
async function until(found) {
  while (!found()) {
    assert.ok(!running?.aborted, "it never came about");
    await new Promise(resolve => setImmediate(resolve));
  }
}

const movesFolder = path.join(home, "run", "moves");
// The moves kept here, by what they move.
function recordOf(thing) {
  const names = fs.existsSync(movesFolder) ? fs.readdirSync(movesFolder) : [];
  for (const name of names.filter(name => /^mov_[A-Za-z0-9]+\.json$/.test(name))) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(movesFolder, name), "utf8"));
      if (record.thing === thing) return record;
    } catch {}
  }
  return null;
}
function writeRecord(record) {
  fs.mkdirSync(movesFolder, { recursive: true });
  fs.writeFileSync(path.join(movesFolder, `${record.id}.json`), JSON.stringify(record));
}

// A bot here: its folder and its conversation.
function bot(id, name) {
  const folder = path.join(bots, id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "bot.json"), JSON.stringify({ kuvo: 1, id, name }));
  fs.writeFileSync(path.join(folder, "session"), `ses_${id.slice(4)}`);
  engine.sessions.set(`ses_${id.slice(4)}`, { id: `ses_${id.slice(4)}`, title: name, directory: path.join(folder, "workspace"), messages: [] });
  return `ses_${id.slice(4)}`;
}
// A goal of `bot`'s, kept on this box as it keeps them.
function goalOf(id, botID, session, state) {
  const file = path.join(home, "run", "work", "goals.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let goals = [];
  try { goals = JSON.parse(fs.readFileSync(file, "utf8")).goals; } catch {}
  goals = goals.filter(each => each.bot !== botID);
  goals.push({ id, bot: botID, name: "Pixel", session, goal: "Ship the site", state, steps: [{ id: "s1", text: "Plan it", state: "todo" }], checks: [], spend: [], public: [], projects: [], wake: false, digest: "none", proposed: Date.now(), ...(state === "running" ? { started: Date.now() } : {}), waiting: [], paused: [], waited: 0, watching: [] });
  fs.writeFileSync(file, JSON.stringify({ goals }));
}

test("a bot working on a goal can't move (its goal stays on this computer), and says why", async () => {
  const session = bot("bot_goal1", "Pixel");
  goalOf("goal_g1", "bot_goal1", session, "running");
  const places = (await ask("GET", "kuvo/moves/places?kind=bot&id=bot_goal1")).json.places;
  assert.deepEqual(places.map(place => [place.ok, place.why, place.note]), [[false, "Pixel is working on a goal, which stays on this computer. Move it once the goal is done, or stop the goal first.", "Working on a goal"]]);
  const before = told.length;
  const moved = await ask("POST", "kuvo/moves", { kind: "bot", id: "bot_goal1", to: peerKey });
  assert.equal(moved.status, 409);
  assert.match(moved.json.message, /working on a goal/);
  assert.equal(told.length, before, "nothing offered");
  assert.equal(recordOf("bot_goal1"), null);
  assert.ok(!fs.existsSync(path.join(bots, "bot_goal1", "paused")), "its wake-ups go on");
});

test("a chat working on its /goal can't move (the goal stays on this computer), and says why; once the goal is met, it can", async () => {
  engine.sessions.set("ses_goal3", { id: "ses_goal3", title: "Auth tests", directory: chats, messages: [] });
  loops.set("ses_goal3", { session: "ses_goal3", condition: "all tests in test/auth pass", state: "working", started: Date.now(), turns: 2 });
  try {
    const places = (await ask("GET", "kuvo/moves/places?kind=chat&id=ses_goal3")).json.places;
    assert.deepEqual(places.map(place => [place.ok, place.why, place.note]), [[false, "“Auth tests” is working on a goal, which stays on this computer. Move it once the goal is done, or stop the goal first.", "Working on a goal"]]);
    const before = told.length;
    const moved = await ask("POST", "kuvo/moves", { kind: "chat", id: "ses_goal3", to: peerKey });
    assert.equal(moved.status, 409);
    assert.match(moved.json.message, /working on a goal/);
    assert.equal(told.length, before, "nothing offered");
    assert.ok(engine.sessions.has("ses_goal3"), "it stays here, with its goal");

    // Paused, it's still the chat's goal; met, it's done.
    loops.get("ses_goal3").state = "paused";
    assert.equal((await ask("GET", "kuvo/moves/places?kind=chat&id=ses_goal3")).json.places[0].ok, false);
    loops.get("ses_goal3").state = "met";
    assert.equal((await ask("GET", "kuvo/moves/places?kind=chat&id=ses_goal3")).json.places[0].ok, true);

    // While the bridge can't say whether it has one, it doesn't go.
    loopsDown = true;
    const unsure = await ask("POST", "kuvo/moves", { kind: "chat", id: "ses_goal3", to: peerKey });
    assert.equal(unsure.status, 409, JSON.stringify(unsure.json));
    assert.match(unsure.json.message, /couldn’t be checked/);
    assert.ok(engine.sessions.has("ses_goal3"));
  } finally {
    loopsDown = false;
    loops.delete("ses_goal3");
    engine.sessions.delete("ses_goal3");
  }
});

test("while a bot moves, its goal can't start, and nothing of a goal is sent to it", async () => {
  const session = bot("bot_goal2", "Pixel");
  goalOf("goal_g2", "bot_goal2", session, "proposed");
  // Its move is under way: it's being switched to on lab (which hasn't answered yet).
  script = () => {};
  writeRecord({ id: "mov_goal2", kind: "bot", thing: "bot_goal2", name: "Pixel", from: "", to: peerKey, role: "from", stage: "switching", step: "switch", sessions: [session],
    peer: peerKey, wasPaused: false, tries: 0, started: Date.now(), offered: true, sentAt: Date.now(), switchSince: Date.now() });
  try {
    const started = await ask("POST", "kuvo/work/goals/goal_g2", { action: "start" });
    assert.equal(started.status, 409, JSON.stringify(started.json));
    assert.match(started.json.message, /moving to another computer/);
    const asked = await ask("POST", "kuvo/work/goals/ask", { session, goal: "Write the docs" });
    assert.equal(asked.status, 409, JSON.stringify(asked.json));
    // Declined: noted here, but the bot isn't told while it moves.
    assert.equal((await ask("POST", "kuvo/work/goals/goal_g2", { action: "decline" })).status, 200);
    assert.deepEqual(engine.prompts.filter(each => each.session === session), [], "nothing reached it");
  } finally {
    fs.rmSync(path.join(movesFolder, "mov_goal2.json"), { force: true });
  }
});

// A bundle lab packs for what it moves here: a chat's conversations and wake-ups' folder, or a group
// chat as its bridge held it.
function bundleFor(contents, folder) {
  const packed = fs.mkdtempSync(path.join(support, "pack-"));
  fs.writeFileSync(path.join(packed, "move.json"), JSON.stringify(contents));
  const names = ["move.json"];
  if (folder) {
    fs.mkdirSync(path.join(packed, folder));
    fs.writeFileSync(path.join(packed, folder, "wakes.json"), "[]");
    names.push(folder);
  }
  const file = path.join(packed, "bundle.tgz");
  assert.equal(spawnSync("tar", ["-czf", file, "-C", packed, ...names]).status, 0);
  const bytes = fs.readFileSync(file);
  fs.rmSync(packed, { recursive: true, force: true });
  return { bytes, hash: crypto.createHash("sha256").update(bytes).digest("base64url") };
}
// Lab moves `contents` here as move `id`: offered, its one part sent, set up here.
async function comesHere(id, contents, folder) {
  const { bytes, hash } = bundleFor(contents, folder);
  await say({ op: "offer", id, kind: contents.kind, thing: contents.thing, name: contents.name, size: bytes.length, hash, wasPaused: false, from: peerKey, ...(contents.kind === "group" ? { members: [] } : {}) });
  assert.equal(told.findLast(move => move.id === id)?.op, "ready");
  await say({ op: "part", id, hash, i: 0, of: 1, d: bytes.toString("base64url") });
  await until(() => told.some(move => move.id === id && (move.op === "arrived" || move.op === "failed")));
  assert.equal(told.findLast(move => move.id === id && (move.op === "arrived" || move.op === "failed")).op, "arrived");
  return hash;
}
const groupOf = id => ({ id, name: "Launch", members: [] });

test("a group chat taken back as its group chats here aren't answering goes on again once they are", async () => {
  groups.chats.set("grp_back1", { group: groupOf("grp_back1"), messages: [], status: "active" });
  // Lab refuses it, just as this box's group chats go away.
  script = move => {
    if (move.op !== "offer") return;
    groups.down = true;
    say({ op: "refused", id: move.id, message: "Its disk is full." });
  };
  try {
    const moved = await ask("POST", "kuvo/moves", { kind: "group", id: "grp_back1", to: peerKey });
    assert.equal(moved.status, 409, JSON.stringify(moved.json));
    assert.equal(groups.chats.get("grp_back1").status, "held", "it couldn't go on yet");
  } finally {
    groups.down = false;
  }
  // A minute later, they answer again.
  link.keepMoving(Date.now() + 61_000);
  await until(() => groups.chats.get("grp_back1").status === "active");
});

test("a group chat left held by a move this box no longer has goes on again as the box starts", async () => {
  groups.chats.set("grp_left1", { group: groupOf("grp_left1"), messages: [], status: "held" });
  // One held by a move under way stays held.
  groups.chats.set("grp_left2", { group: groupOf("grp_left2"), messages: [], status: "held" });
  writeRecord({ id: "mov_left2", kind: "group", thing: "grp_left2", name: "“Launch”", from: "", to: peerKey, role: "from", stage: "switching", step: "switch", sessions: [],
    peer: peerKey, wasPaused: true, tries: 0, started: Date.now(), offered: true, sentAt: Date.now(), switchSince: Date.now() });
  try {
    startAgain();
    await until(() => groups.chats.get("grp_left1").status === "active");
    assert.equal(groups.chats.get("grp_left2").status, "held");
  } finally {
    fs.rmSync(path.join(movesFolder, "mov_left2.json"), { force: true });
  }
});

test("a copy let go of while this box's engine is down: the other computer hears at once that it's gone, and here it's held, never live, until it goes once the engine is back", async () => {
  script = () => {};
  const id = "mov_down1";
  await comesHere(id, { kind: "chat", thing: "ses_down1", name: "“Notes”", wasPaused: false, folder: "ses_down1", exports: [{ info: { id: "ses_down1", title: "Notes" }, messages: [] }] }, "ses_down1");
  engine.down = true;
  const refused = engine.refused;
  try {
    // Lab takes it back: it hears at once that it's gone, so its original goes on there.
    await say({ op: "drop", id });
    assert.equal(told.findLast(move => move.id === id)?.op, "dropped");
    assert.ok(engine.refused > refused, "it tried");
    assert.ok(engine.sessions.has("ses_down1"));
    // Not shown as moving here (lab goes on with it), and not this box's: nothing reaches it.
    assert.deepEqual((await ask("GET", "kuvo/moves")).json, { moves: [], away: ["ses_down1"] });
    assert.equal(fs.readFileSync(path.join(wakes, "ses_down1", "paused"), "utf8"), "moving", "its wake-ups held");
    // Switched to now (lab's word crossed): never.
    await say({ op: "switch", id });
    assert.equal(told.findLast(move => move.id === id)?.op, "dropped");
    assert.ok(!told.some(move => move.id === id && move.op === "switched"));
  } finally {
    engine.down = false;
  }
  link.keepMoving(Date.now() + 61_000);
  await until(() => !engine.sessions.has("ses_down1") && !recordOf("ses_down1"));
  assert.ok(!fs.existsSync(path.join(wakes, "ses_down1")), "nor its folder");
  // Lab asks again: gone.
  await say({ op: "drop", id });
  assert.equal(told.findLast(move => move.id === id).op, "dropped");
  assert.deepEqual(underWay((await ask("GET", "kuvo/moves")).json), { moves: [], away: [] });
});

test("a group chat let go of while group chats here aren't answering: the other computer hears at once, and here it's held until it goes once they are", async () => {
  script = () => {};
  const id = "mov_gdown1";
  await comesHere(id, { kind: "group", thing: "grp_in1", name: "“Launch”", wasPaused: true, exports: [], group: { group: groupOf("grp_in1"), messages: [] } });
  assert.equal(groups.chats.get("grp_in1")?.status, "held");
  groups.down = true;
  try {
    await say({ op: "drop", id });
    assert.equal(told.findLast(move => move.id === id)?.op, "dropped", "said gone at once");
    assert.equal(groups.chats.get("grp_in1")?.status, "held", "and held here until it is");
    assert.ok(recordOf("grp_in1"), "kept, to let go of again");
  } finally {
    groups.down = false;
  }
  link.keepMoving(Date.now() + 61_000);
  await until(() => !groups.chats.has("grp_in1") && !recordOf("grp_in1"));
  await say({ op: "drop", id });
  assert.equal(told.findLast(move => move.id === id).op, "dropped");
});

// A chat here, with a wake-up, to move.
function chat(id) {
  engine.sessions.set(id, { id, title: "Trip plans", directory: chats, messages: [{ info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text: "May?" }] }] });
  fs.mkdirSync(path.join(wakes, id), { recursive: true });
  fs.writeFileSync(path.join(wakes, id, "wakes.json"), "[]");
}

test("word that its copy arrived, lost on the way: it's asked again, and the move goes on", async () => {
  chat("ses_lost1");
  // Lab takes every part, sets it up, and its `arrived` never comes; asked again, it says so.
  script = move => {
    if (move.op === "offer") say({ op: "ready", id: move.id });
    if (move.op === "part") say({ op: "got", id: move.id, i: move.i });
    if (move.op === "arrive") say({ op: "arrived", id: move.id, hash: move.hash });
    if (move.op === "switch") say({ op: "switched", id: move.id });
  };
  const before = told.length;
  const asked = ask("POST", "kuvo/moves", { kind: "chat", id: "ses_lost1", to: peerKey });
  await until(() => recordOf("ses_lost1")?.step === "arrive");
  // A minute later.
  link.keepMoving(Date.now() + 61_000);
  await until(() => told.slice(before).some(move => move.op === "arrive"));
  const moved = await asked;
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.ok(!engine.sessions.has("ses_lost1"), "it lives on lab now");
});

test("asked again whether a copy arrived, this box says as it is: arrived, or failed for one it doesn't have", async () => {
  script = () => {};
  const id = "mov_askin1";
  const hash = await comesHere(id, { kind: "chat", thing: "ses_askin1", name: "“Notes”", wasPaused: false, exports: [{ info: { id: "ses_askin1", title: "Notes" }, messages: [] }] });
  await say({ op: "arrive", id, hash });
  assert.deepEqual(told.findLast(move => move.id === id), { op: "arrived", id, hash });
  await say({ op: "arrive", id: "mov_askin2", hash: "x" });
  assert.equal(told.findLast(move => move.id === "mov_askin2")?.op, "failed");
  await say({ op: "drop", id });
});

test("a copy being set up as this box stopped: as it starts again, what came of it goes, and the other computer hears it failed", async () => {
  script = () => {};
  // As a box cut off partway through setting it up left it: its folder placed, its conversation in.
  const thing = "ses_cut1", id = "mov_cut1";
  fs.mkdirSync(path.join(wakes, thing), { recursive: true });
  fs.writeFileSync(path.join(wakes, thing, "paused"), "moving");
  engine.sessions.set(thing, { id: thing, title: "Notes", directory: chats, messages: [] });
  writeRecord({ id, kind: "chat", thing, name: "“Notes”", from: peerKey, to: "", role: "to", stage: "copying", sessions: [thing], peer: peerKey, wasPaused: false,
    hash: "h", size: 10, sent: 10, tries: 0, started: Date.now(), complete: true, placed: true, setUpSince: Date.now() - 60_000 });
  startAgain();
  await until(() => told.some(move => move.id === id && move.op === "failed"));
  assert.ok(!engine.sessions.has(thing) && !fs.existsSync(path.join(wakes, thing)), "nothing of it is left here");
  assert.equal(recordOf(thing), null);
  // Asked again whether it arrived: failed.
  await say({ op: "arrive", id, hash: "h" });
  assert.equal(told.findLast(move => move.id === id).op, "failed");
});

test("offered again (it got more as it moved) and never answered: it's taken back after a while, though the offer goes again each minute", async () => {
  chat("ses_again1");
  let offers = 0;
  script = move => {
    if (move.op === "offer" && ++offers === 1) say({ op: "ready", id: move.id });
    if (move.op === "part") {
      say({ op: "got", id: move.id, i: move.i });
      if (move.i === move.of - 1) {
        engine.sessions.get("ses_again1").messages.push({ info: { id: "msg_more", role: "user" }, parts: [{ type: "text", text: "And this." }] });
        say({ op: "arrived", id: move.id, hash: move.hash });
      }
    }
    if (move.op === "drop") say({ op: "dropped", id: move.id });
  };
  const asked = ask("POST", "kuvo/moves", { kind: "chat", id: "ses_again1", to: peerKey });
  await until(() => offers === 2);
  // Lab went away: the offer goes again each minute, unanswered.
  const now = Date.now();
  for (const minutes of [1, 2, 3]) link.keepMoving(now + minutes * 60_000 + 1_000);
  await until(() => offers >= 3);
  link.keepMoving(now + 11 * 60_000);
  await until(() => !recordOf("ses_again1") || recordOf("ses_again1").failed);
  const moved = await asked;
  assert.equal(moved.status, 503, JSON.stringify(moved.json));
  assert.match(moved.json.message, /lab stopped answering/);
  assert.ok(engine.sessions.has("ses_again1"), "it goes on here");
});

test("getting it ready to move stuck (this box's engine not answering): it's taken back after a while, as it was, and whoever asked hears", async () => {
  chat("ses_hang1");
  script = () => {};
  let release;
  engine.exportHold = new Promise(resolve => { release = resolve; });
  const before = told.length;
  try {
    const asked = ask("POST", "kuvo/moves", { kind: "chat", id: "ses_hang1", to: peerKey });
    await until(() => engine.exporting);
    assert.equal(fs.readFileSync(path.join(wakes, "ses_hang1", "paused"), "utf8"), "moving", "held while it's got ready");
    // Half an hour and more later.
    link.keepMoving(Date.now() + 31 * 60_000);
    const moved = await asked;
    assert.equal(moved.status, 409, JSON.stringify(moved.json));
    assert.match(moved.json.message, /took too long/);
    assert.ok(!fs.existsSync(path.join(wakes, "ses_hang1", "paused")), "its wake-ups go on");
    assert.deepEqual(underWay((await ask("GET", "kuvo/moves")).json), { moves: [], away: [] });
  } finally {
    engine.exportHold = null;
    release();
  }
  assert.ok(!told.slice(before).some(move => move.op === "offer"), "never offered");
  assert.ok(engine.sessions.has("ses_hang1"));
});

test("a move noted by a process that isn't the watcher (box route) is carried out by the watcher, from its check; one stuck there with no hold time is taken back after half an hour", async () => {
  chat("ses_route1");
  chat("ses_route2");
  const record = (id, thing, started) => ({ id, kind: "chat", thing, name: "Trip plans", from: "", to: peerKey, role: "from", stage: "holding", step: "check", sessions: [thing], peer: peerKey, wasPaused: true, tries: 0, started });
  // lab answers the check; the move goes on to the offer, which lab then refuses.
  script = move => {
    if (move.op === "check") say({ op: "checked", id: move.id, ok: true });
    if (move.op === "drop") say({ op: "dropped", id: move.id });
  };
  const before = told.length;
  writeRecord(record("mov_route1", "ses_route1", Date.now()));
  link.keepMoving();
  await until(() => told.slice(before).some(move => move.op === "offer" && move.id === "mov_route1"));
  await until(() => recordOf("ses_route1")?.stage === "copying");
  say({ op: "refused", id: "mov_route1", hash: recordOf("ses_route1").hash, message: "Not now." });
  await until(() => recordOf("ses_route1") === null);
  assert.ok(engine.sessions.has("ses_route1"), "it stays here, refused");

  // Never answered, and no hold time yet: half an hour after it began, it's taken back, not left for good.
  script = () => {};
  writeRecord(record("mov_route2", "ses_route2", Date.now()));
  link.keepMoving(Date.now() + 29 * 60_000);
  assert.ok(recordOf("ses_route2"), "not yet");
  link.keepMoving(Date.now() + 31 * 60_000);
  await until(() => recordOf("ses_route2") === null);
  assert.ok(engine.sessions.has("ses_route2"));
});

test("one whose files come to more than 1 GB is refused before anything of it is packed, saying so plainly", async () => {
  chat("ses_huge1");
  // A file of 1.1 GB in its folder (sparse: it takes no room on the disk).
  const huge = path.join(wakes, "ses_huge1", "recording.mov");
  fs.closeSync(fs.openSync(huge, "w"));
  fs.truncateSync(huge, 1_100_000_000);
  script = move => { if (move.op === "offer") say({ op: "refused", id: move.id, message: "Not now." }); };
  const before = told.length;
  try {
    const moved = await ask("POST", "kuvo/moves", { kind: "chat", id: "ses_huge1", to: peerKey });
    assert.equal(moved.status, 409, JSON.stringify(moved.json));
    assert.equal(moved.json.message, "“Trip plans” is more than 1 GB, too big to move to another computer, so it stays where it is.");
    assert.ok(!told.slice(before).some(move => move.op === "offer"), "never offered");
    assert.ok(!fs.existsSync(path.join(wakes, "ses_huge1", "paused")), "its wake-ups go on");
  } finally {
    fs.rmSync(huge, { force: true });
  }
});

test("a group chat whose copy there was let go of as it was switched to goes on here, as it was", async () => {
  groups.chats.set("grp_stay1", { group: groupOf("grp_stay1"), messages: [], status: "active" });
  script = move => {
    if (move.op === "offer") say({ op: "ready", id: move.id });
    if (move.op === "part") {
      say({ op: "got", id: move.id, i: move.i });
      if (move.i === move.of - 1) say({ op: "arrived", id: move.id, hash: move.hash });
    }
    if (move.op === "switch") say({ op: "dropped", id: move.id });
  };
  const moved = await ask("POST", "kuvo/moves", { kind: "group", id: "grp_stay1", to: peerKey });
  assert.equal(moved.status, 409, JSON.stringify(moved.json));
  assert.match(moved.json.message, /stayed here/);
  assert.equal(groups.chats.get("grp_stay1").status, "active");
});

// What a conversation's sessions tell it, as the box keeps it to send (`run/work/wakes.json`), and
// the box's watcher of them, with its clock in the test's hands: what it would do later, done when
// the test says.
const wakesFile = path.join(support, "work-wakes.json");
function watcher() {
  const later = [];
  const source = { port: enginePort, password: "pw" };
  const watch = link.workWatcher(source, () => [source], { schedule: run => { later.push(run); }, file: wakesFile, toldFile: path.join(support, "work-told.json"), bridgeRuns: () => true });
  return { watch, caughtUp: watch.caughtUp, runAll: async () => { for (const run of later.splice(0)) await run(); } };
}
// The letters this box has left for conversations on other computers, by the one each is for.
const sending = path.join(home, "run", "outbox", "sending");
const lettersFor = session => (fs.existsSync(sending) ? fs.readdirSync(sending) : []).filter(name => name.endsWith(".json"))
  .map(name => JSON.parse(fs.readFileSync(path.join(sending, name), "utf8"))).filter(letter => letter.to === session);

test("what a chat's sessions tell it while it moves never starts a turn there; once it's moved, it reaches it on the computer it lives on now", async () => {
  chat("ses_reach1");
  // A session it started, to hear of as it ends.
  engine.sessions.set("ses_signin1", { id: "ses_signin1", title: "Sign-in", directory: chats, messages: [], metadata: { kuvo: { startedBy: "ses_reach1", depth: 1, wake: ["finished"] } } });
  const { watch, runAll } = watcher();
  script = async move => {
    if (move.op === "offer") say({ op: "ready", id: move.id });
    if (move.op === "part") {
      await say({ op: "got", id: move.id, i: move.i });
      if (move.i !== move.of - 1) return;
      // The session it started stops with an error as its copy is set up on lab.
      await watch({ type: "session.execution.failed", data: { sessionID: "ses_signin1" } });
      await runAll();
      say({ op: "arrived", id: move.id, hash: move.hash });
    }
    if (move.op === "switch") say({ op: "switched", id: move.id });
  };
  const moved = await ask("POST", "kuvo/moves", { kind: "chat", id: "ses_reach1", to: peerKey });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.deepEqual(engine.prompts.filter(each => each.session === "ses_reach1"), [], "nothing reached it while it moved");
  assert.deepEqual(lettersFor("ses_reach1"), []);
  // It lives on lab now: what waited goes there, as a letter.
  await runAll();
  const [letter, ...more] = lettersFor("ses_reach1");
  assert.deepEqual(more, []);
  assert.match(letter.text, /^\[Session failed\] "Sign-in" .*\(address ses_signin1\) stopped with an error\./);
  // As the box's own word, the way it would have come here: queued, shown as its sessions' news.
  assert.deepEqual(letter.note, { from: "Its sessions", words: "“Sign-in” stopped with an error", line: "“Sign-in” stopped with an error", delivery: "queue", about: ["ses_signin1"] });
  const mails = [];
  await link.sendOutbox({ send: bytes => mails.push(bytes) });
  assert.equal(mails.length, 1);
  assert.equal(lettersFor("ses_reach1")[0].sentTo, peerKey, "to lab");
  assert.deepEqual(JSON.parse(fs.readFileSync(wakesFile, "utf8")), {}, "and nothing's left to send here");
  fs.rmSync(sending, { recursive: true, force: true });
});

test("what you answered a chat's ask after it stopped waiting isn't told it while it moves; once it's moved, it reaches it there", async () => {
  chat("ses_reach2");
  const asks = path.join(home, "run", "work", "asks.json");
  fs.mkdirSync(path.dirname(asks), { recursive: true });
  fs.writeFileSync(asks, JSON.stringify({ asks: [{ id: "wak_reach2", action: "makeProject", session: "ses_reach2", name: "Trip plans", project: "Site", folderName: "Site", folder: null, at: Date.now(), given: { name: "Site" }, late: true }] }));
  const id = "mov_reach2";
  script = () => {};
  writeRecord({ id, kind: "chat", thing: "ses_reach2", name: "“Trip plans”", from: "", to: peerKey, role: "from", stage: "switching", step: "switch", sessions: ["ses_reach2"],
    peer: peerKey, wasPaused: false, tries: 0, started: Date.now(), offered: true, sentAt: Date.now(), switchSince: Date.now(), folder: path.join(wakes, "ses_reach2") });
  const answered = await ask("POST", "kuvo/work/asks/wak_reach2", { answer: "deny" });
  assert.equal(answered.status, 200, JSON.stringify(answered.json));
  assert.deepEqual(engine.prompts.filter(each => each.session === "ses_reach2"), [], "nothing reached it while it moved");
  // Lab switched to it: it lives there now.
  await say({ op: "switched", id });
  assert.ok(!engine.sessions.has("ses_reach2"));
  // Tried again, as the box does every few minutes.
  await watcher().caughtUp;
  const letters = lettersFor("ses_reach2");
  assert.equal(letters.length, 1);
  assert.match(letters[0].text, /^\[The user answered\] The user said no to making Site\./);
  // As the box's own word, the way it would have come here: queued, shown as your answer.
  const words = letters[0].text.slice("[The user answered] ".length);
  assert.deepEqual(letters[0].note, { from: "Your answer", words, line: `You answered: ${words}`, delivery: "queue" });
  // Told once.
  await watcher().caughtUp;
  assert.equal(lettersFor("ses_reach2").length, 1);
  fs.rmSync(sending, { recursive: true, force: true });
});

test("a copy that never got set up here is let go of at once, even while this box's engine isn't running", async () => {
  script = () => {};
  const id = "mov_bare1";
  writeRecord({ id, kind: "chat", thing: "ses_bare1", name: "“Notes”", from: peerKey, to: "", role: "to", stage: "copying", sessions: [], peer: peerKey, wasPaused: false,
    hash: "h", size: 10, sent: 0, tries: 0, started: Date.now() });
  const engineFile = path.join(home, "run", "engine.json");
  fs.renameSync(engineFile, `${engineFile}.away`);
  try {
    await say({ op: "drop", id });
    assert.equal(told.findLast(move => move.id === id)?.op, "dropped");
    assert.deepEqual(underWay((await ask("GET", "kuvo/moves")).json), { moves: [], away: [] }, "nothing of it is left");
  } finally {
    fs.renameSync(`${engineFile}.away`, engineFile);
  }
});

test("a copy this box can't let go of is offered again: refused, saying why, rather than left unanswered", async () => {
  script = () => {};
  // Lab took a move of it back a while ago; its copy here couldn't all go (its engine refusing).
  engine.sessions.set("ses_old1", { id: "ses_old1", title: "Notes", directory: chats, messages: [] });
  writeRecord({ id: "mov_old1", kind: "chat", thing: "ses_old1", name: "“Notes”", from: peerKey, to: "", role: "to", stage: "copying", sessions: ["ses_old1"], peer: peerKey, wasPaused: false,
    hash: "h", size: 10, sent: 10, tries: 0, started: Date.now(), complete: true, dropping: true, sentAt: Date.now() });
  engine.down = true;
  try {
    const { bytes, hash } = bundleFor({ kind: "chat", thing: "ses_old1", name: "“Notes”", wasPaused: false, exports: [{ info: { id: "ses_old1", title: "Notes" }, messages: [] }] });
    await say({ op: "offer", id: "mov_old2", kind: "chat", thing: "ses_old1", name: "“Notes”", size: bytes.length, hash, wasPaused: false, from: peerKey });
    const answer = told.findLast(move => move.id === "mov_old2");
    assert.equal(answer?.op, "refused");
    assert.equal(answer.message, "An earlier copy of “Notes” on this Mac couldn’t be let go of yet. Try again in a moment.");
  } finally {
    engine.down = false;
  }
  link.keepMoving(Date.now() + 61_000);
  await until(() => !engine.sessions.has("ses_old1") && !recordOf("ses_old1"));
});

test("a copy that still can't be let go of after a week says so in the log, once, and stays held", async () => {
  script = () => {};
  engine.sessions.set("ses_stuck1", { id: "ses_stuck1", title: "Notes", directory: chats, messages: [] });
  const started = Date.now();
  writeRecord({ id: "mov_stuck1", kind: "chat", thing: "ses_stuck1", name: "“Notes”", from: peerKey, to: "", role: "to", stage: "copying", sessions: ["ses_stuck1"], peer: peerKey, wasPaused: false,
    hash: "h", size: 10, sent: 10, tries: 0, started, complete: true, dropping: true, sentAt: started });
  const logged = [];
  const error = console.error;
  console.error = (...words) => logged.push(words.join(" "));
  engine.down = true;
  try {
    const refused = engine.refused;
    link.keepMoving(started + 8 * 24 * 3600_000);
    await until(() => logged.length > 0);
    assert.ok(engine.refused > refused, "it tried");
    assert.match(logged[0], /^kuvo-link: a copy of “Notes” that came here couldn’t be let go of in a week/);
    link.keepMoving(started + 8 * 24 * 3600_000 + 2 * 3600_000);
    await until(() => engine.refused > refused + 1);
    assert.equal(logged.length, 1, "said once");
    assert.deepEqual((await ask("GET", "kuvo/moves")).json.away, ["ses_stuck1"], "held: nothing reaches it");
  } finally {
    engine.down = false;
    console.error = error;
  }
  link.keepMoving(started + 8 * 24 * 3600_000 + 4 * 3600_000);
  await until(() => !engine.sessions.has("ses_stuck1") && !recordOf("ses_stuck1"));
});

test("an answer to a chat's letter that came after it stopped waiting isn't told it while it moves; once it's moved, it reaches it there", async () => {
  chat("ses_left1");
  // Scout, on another computer, answered; the chat's tool had given up waiting.
  const replies = path.join(home, "run", "replies");
  fs.mkdirSync(replies, { recursive: true });
  fs.writeFileSync(path.join(replies, "ltr_left1.json"), JSON.stringify({ text: "The venue is booked.", to: "ses_left1", from: "ses_scout9", name: "Scout" }));
  fs.writeFileSync(path.join(replies, "ltr_left1.gaveup"), "");
  const id = "mov_left9";
  script = () => {};
  writeRecord({ id, kind: "chat", thing: "ses_left1", name: "“Trip plans”", from: "", to: peerKey, role: "from", stage: "switching", step: "switch", sessions: ["ses_left1"],
    peer: peerKey, wasPaused: false, tries: 0, started: Date.now(), offered: true, sentAt: Date.now(), switchSince: Date.now(), folder: path.join(wakes, "ses_left1") });
  await link.macSendOutbox();
  assert.deepEqual(engine.prompts.filter(each => each.session === "ses_left1"), [], "nothing reached it while it moved");
  // Lab switched to it: it lives there now.
  await say({ op: "switched", id });
  await link.macSendOutbox();
  const letters = lettersFor("ses_left1");
  assert.equal(letters.length, 1);
  assert.match(letters[0].text, /^\[Message from Scout · ses_scout9\][^\n]*\n\nThe venue is booked\.$/);
  // Delivered there as Scout's answer, under that one heading (not as a letter from no one).
  assert.deepEqual(letters[0].note, { from: "Scout", words: "The venue is booked.", delivery: "steer" });
  // Told once.
  await link.macSendOutbox();
  assert.equal(lettersFor("ses_left1").length, 1);
  fs.rmSync(sending, { recursive: true, force: true });
});

test("an answer a chat waited for that comes once its tool stopped waiting isn't told it while it moves; once it's moved, it reaches it there", async () => {
  chat("ses_ask1");
  // Ada, an agent of this box's, answers a letter the chat wrote her; the chat's tool has gone.
  engine.sessions.set("ses_here1", { id: "ses_here1", title: "Ada", directory: chats, messages: [], replies: [{ id: "msg_zzzzzzzzzzzzzzzzzzzzzzzz", type: "assistant", content: [{ type: "text", text: "The venue is booked." }] }] });
  const agents = path.join(home, "run", "agents.json");
  fs.writeFileSync(agents, JSON.stringify({ agents: [{ session: "ses_here1", name: "Ada" }] }));
  fs.mkdirSync(sending, { recursive: true });
  fs.writeFileSync(path.join(sending, "ltr_ask1.json"), JSON.stringify({ from: "ses_ask1", to: "ses_here1", text: "Is the venue booked?", wait: true, at: Date.now() }));
  const id = "mov_ask1";
  script = () => {};
  writeRecord({ id, kind: "chat", thing: "ses_ask1", name: "“Trip plans”", from: "", to: peerKey, role: "from", stage: "switching", step: "switch", sessions: ["ses_ask1"],
    peer: peerKey, wasPaused: false, tries: 0, started: Date.now(), offered: true, sentAt: Date.now(), switchSince: Date.now(), folder: path.join(wakes, "ses_ask1") });
  const source = { port: enginePort, password: "pw" };
  try {
    await link.sendOutbox({ send() {} }, undefined, Date.now(), 0, undefined, 1);
    assert.equal(engine.prompts.filter(each => each.session === "ses_here1").length, 1, "Ada had the letter");
    await link.macSendOutbox();
    assert.deepEqual(engine.prompts.filter(each => each.session === "ses_ask1"), [], "nothing reached the chat while it moved");
    // Lab switched to it: it lives there now.
    await say({ op: "switched", id });
    await link.macSendOutbox();
    const letters = lettersFor("ses_ask1");
    assert.equal(letters.length, 1);
    assert.match(letters[0].text, /^\[Message from Ada · ses_here1\][^\n]*\n\nThe venue is booked\.$/);
    assert.deepEqual(letters[0].note, { from: "Ada", words: "The venue is booked.", delivery: "steer" });
    await link.macSendOutbox();
    assert.equal(lettersFor("ses_ask1").length, 1, "told once");
  } finally {
    fs.rmSync(agents, { force: true });
    fs.rmSync(sending, { recursive: true, force: true });
  }
});

test("on this Mac, an answer that came after its conversation's tool stopped waiting reaches it as a message, in the box's own rounds", async () => {
  chat("ses_late1");
  const replies = path.join(home, "run", "replies");
  fs.mkdirSync(replies, { recursive: true });
  fs.writeFileSync(path.join(replies, "ltr_late1.json"), JSON.stringify({ text: "All done.", to: "ses_late1", from: "ses_scout9", name: "Scout" }));
  await link.macSendOutbox();
  const [prompt, ...more] = engine.prompts.filter(each => each.session === "ses_late1");
  assert.deepEqual(more, []);
  assert.match(prompt.text, /^\[Message from Scout · ses_scout9\][^\n]*\n\nAll done\.$/);
  assert.ok(!fs.existsSync(path.join(replies, "ltr_late1.json")), "once");
});

test("a copy held here a long while, only now being let go of, isn't said in the log to have been stuck for a week", async () => {
  script = () => {};
  engine.sessions.set("ses_long1", { id: "ses_long1", title: "Notes", directory: chats, messages: [] });
  const id = "mov_long1";
  writeRecord({ id, kind: "chat", thing: "ses_long1", name: "“Notes”", from: peerKey, to: "", role: "to", stage: "copying", sessions: ["ses_long1"], peer: peerKey, wasPaused: false,
    hash: "h", size: 10, sent: 10, tries: 0, started: Date.now() - 6 * 24 * 3600_000, complete: true });
  const logged = [];
  const error = console.error;
  console.error = (...words) => logged.push(words.join(" "));
  engine.down = true;
  try {
    // Lab takes it back now, as this box's engine refuses to let it go; a day on, it still does.
    await say({ op: "drop", id });
    const refused = engine.refused;
    link.keepMoving(Date.now() + 24 * 3600_000);
    await until(() => engine.refused > refused);
    engine.down = false;
    link.keepMoving(Date.now() + 24 * 3600_000 + 2 * 3600_000);
    await until(() => !engine.sessions.has("ses_long1") && !recordOf("ses_long1"));
    assert.deepEqual(logged, []);
  } finally {
    engine.down = false;
    console.error = error;
  }
});

test("the box's own word for a conversation that moved here, as it comes from the computer it moved from, is delivered as that box would have here: not as a letter from no one", async () => {
  chat("ses_note1");
  const said = [];
  const take = (id, note) => link.takeLetter(lab, { id, from: null, to: "ses_note1", text: "[The user answered] Yes.", at: Date.now(), wait: false, note },
    { send: (_peer, message) => said.push(message.delivered), targets: [{ port: enginePort, password: "pw" }], told: {}, peers: [lab], moved: new Map() });
  await take("ltr_note1aaaa", { from: "Your answer", words: "Yes.", line: "You answered: Yes.", delivery: "queue" });
  await take("ltr_note1bbbb", { from: "Scout", words: "Booked.", delivery: "steer" });
  assert.deepEqual(said.map(each => each.ok), [true, true]);
  assert.deepEqual(engine.prompts.filter(each => each.session === "ses_note1"), [
    { session: "ses_note1", text: "[The user answered] Yes.", delivery: "queue", metadata: { kuvo: { note: { from: "Your answer", line: "You answered: Yes." } } } },
    { session: "ses_note1", text: "[The user answered] Yes.", delivery: "steer" },
  ]);
  // One that isn't a note, or a bad one, is a letter as ever.
  await take("ltr_note1cccc", { from: "Your answer", words: "Yes.", delivery: "now" });
  const [, , plain] = engine.prompts.filter(each => each.session === "ses_note1");
  assert.match(plain.text, /^\[Message from an agent on lab · unknown\]/);
  assert.equal(plain.delivery, "steer");
  // (Not the box's own note: its parts, as a letter's, say who wrote it.)
  assert.deepEqual(plain.metadata, { kuvo: { parts: { words: "[The user answered] Yes.", mail: { name: "an agent on lab", session: "unknown" } } } });
});

test("the box's own word for a conversation that has since moved back here is delivered here as the box's own, not as a letter", async () => {
  chat("ses_note2");
  const agents = path.join(home, "run", "agents.json");
  fs.writeFileSync(agents, JSON.stringify({ agents: [{ session: "ses_note2", name: "Trip plans" }] }));
  fs.mkdirSync(sending, { recursive: true });
  fs.writeFileSync(path.join(sending, "ltr_note2aaaa.json"), JSON.stringify({ from: null, to: "ses_note2", text: "[Session finished] \"Sign-in\" is done.", wait: false, at: Date.now(), peer: peerKey,
    note: { from: "Its sessions", words: "“Sign-in” finished", line: "“Sign-in” finished", delivery: "queue" } }));
  try {
    await link.sendOutbox({ send() {} }, undefined, Date.now(), 0, undefined, 1);
    assert.deepEqual(engine.prompts.filter(each => each.session === "ses_note2"), [
      { session: "ses_note2", text: "[Session finished] \"Sign-in\" is done.", delivery: "queue", metadata: { kuvo: { note: { from: "Its sessions", line: "“Sign-in” finished" } } } },
    ]);
    assert.deepEqual(lettersFor("ses_note2"), []);
  } finally {
    fs.rmSync(agents, { force: true });
    fs.rmSync(sending, { recursive: true, force: true });
  }
});

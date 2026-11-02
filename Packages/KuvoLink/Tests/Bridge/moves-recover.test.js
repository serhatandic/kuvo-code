// Move to Computer when something on the way goes wrong (PROTOCOL.md, `kuvo/moves`): a word between
// the boxes lost, a box started again partway, its engine or group chats not answering, a bot at
// work on a goal. Whatever it is, a move ends, and never leaves a second live copy, a group chat
// held for good, or a goal left behind with nobody at it. One box, real (this Mac's), against a
// scripted other computer whose mail goes to the script instead of the relay (`sendMovesWith`); its
// engine and its group chats' bridge are stand-ins.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/moves-recover.test.js`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test as nodeTest } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

// Each fails, rather than hangs, when what it waits for never comes.
const test = (name, run) => nodeTest(name, { timeout: 30_000 }, run);

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

// An engine with its conversations, as its API exports, imports and deletes them, and what it was
// sent. Its deletes fail while it's `down`.
const engine = { sessions: new Map(), prompts: [], down: false, refused: 0 };
const engineServer = http.createServer(async (request, response) => {
  const given = await reading(request);
  const url = new URL(request.url, "http://x");
  const send = (status, data) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ data }));
  const listed = each => ({ id: each.id, title: each.title, directory: each.directory, location: { directory: each.directory } });
  if (url.pathname === "/api/session" && url.searchParams.get("parentID")) return send(200, [...engine.sessions.values()].filter(each => each.parentID === url.searchParams.get("parentID")).map(listed));
  if (url.pathname === "/api/session/active") return send(200, {});
  if (url.pathname === "/api/experimental/session/import") {
    if (engine.sessions.has(given.info.id)) return response.writeHead(409).end("{}");
    engine.sessions.set(given.info.id, { id: given.info.id, title: given.info.title, parentID: given.info.parentID, directory: given.location.directory, messages: given.messages });
    return send(200, listed(engine.sessions.get(given.info.id)));
  }
  const exported = url.pathname.match(/^\/api\/experimental\/session\/([^/]+)\/export$/);
  if (exported) {
    const session = engine.sessions.get(exported[1]);
    return session ? send(200, { info: { id: session.id, title: session.title, ...(session.parentID ? { parentID: session.parentID } : {}) }, messages: session.messages }) : send(404, null);
  }
  const match = url.pathname.match(/^\/api\/session\/([^/]+)(\/[a-z/]+)?$/);
  const session = match && engine.sessions.get(match[1]);
  if (!session) return send(404, null);
  if (match[2] === "/prompt") {
    engine.prompts.push({ session: session.id, text: given.text });
    return send(200, {});
  }
  if (match[2] === "/inbox" || match[2] === "/message" || match[2] === "/permission" || match[2] === "/question") return send(200, []);
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
const groups = { chats: new Map(), down: false, refused: 0 };
const bridgeServer = http.createServer(async (request, response) => {
  const given = await reading(request);
  const url = new URL(request.url, "http://x");
  const send = (status, value) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
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
const stop = new AbortController();
link.watchMoves(() => ({ send() {} }), stop.signal);
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

// Until `found` holds: looked at again as the script hears more.
async function until(found) {
  for (let tries = 0; tries < 2000 && !found(); tries++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(found(), `never: ${found}`);
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

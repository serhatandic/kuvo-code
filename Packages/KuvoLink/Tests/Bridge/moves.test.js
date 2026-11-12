// Move to Computer, box to box (PROTOCOL.md, `kuvo/moves`): this Mac's box and one of its machines
// move a chat and a bot between them over the relay, with no client in the middle. A chat goes from
// this Mac to the machine with its wake-ups; a bot goes from the machine to this Mac, asked as this
// Mac asks a machine (`box route`, a process of its own, which the machine's running link moves it
// for); one the machine can't take now stays where it was, as it was. This Mac's box is `serve`'s
// link, here; the machine is `kuvo-link.js run`, a process of its own, set up as the app sets one up
// over SSH. Only the relay, the app, the engines and the coding agents' bridges are stand-ins.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/moves.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { relayStandIn } from "./relay-stand-in.js";
import { atEnd, removeAtEnd } from "./at-end.js";

// What's under way, as `kuvo/moves` says it (not what moved away lately, `moved`, which stays two days).
const underWay = ({ moved: _moved, ...rest } = {}) => rest;

const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-moves-")));
const macHome = path.join(support, "mac");
const machineHome = path.join(support, "machine");
for (const home of [macHome, machineHome]) fs.mkdirSync(path.join(home, "run"), { recursive: true });
// Where each keeps its chats, its bots and their wake-ups.
const macChats = path.join(support, "Chats"), macBots = path.join(support, "bots"), macWakes = path.join(support, "wakes");
const labChats = path.join(machineHome, "chats"), labBots = path.join(machineHome, "bots"), labWakes = path.join(machineHome, "wakes");

// What a box wrote (the machine is another process): looked at again every few milliseconds until
// it's there, or the test runs out of time (`signal`).
let signal;
function eventually(found) {
  return new Promise((resolve, reject) => {
    const look = () => {
      const value = found();
      if (!value) return;
      clearInterval(timer);
      resolve(value);
    };
    const timer = setInterval(look, 20);
    signal?.addEventListener("abort", () => {
      clearInterval(timer);
      reject(new Error(`it never got there: ${found}`));
    }, { once: true });
    look();
  });
}

const authorized = request => request.headers.authorization === `Basic ${Buffer.from("opencode:pw").toString("base64")}`;
function listening(server) {
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}
function body(request) {
  return new Promise(resolve => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { resolve({}); }
    });
  });
}

// An engine with its conversations (`{id, title, directory, messages}`), as its API exports, imports
// and deletes them.
async function engineWith(sessions) {
  const engine = { sessions: new Map(sessions.map(each => [each.id, each])), prompts: [], entries: [], cursors: new Map(), active: new Set() };
  const server = http.createServer(async (request, response) => {
    const given = await body(request);
    const url = new URL(request.url, "http://x");
    const send = (status, data) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ data }));
    if (!authorized(request)) return response.writeHead(401).end();
    const listed = each => ({ id: each.id, title: each.title, directory: each.directory, location: { directory: each.directory }, time: { updated: 1 }, ...(each.metadata ? { metadata: each.metadata } : {}) });
    const entry = url.pathname.match(/^\/api\/experimental\/session\/([^/]+)\/instructions\/entries\/([^/]+)$/);
    if (entry) {
      if (request.method === "PUT") engine.entries.push({ session: entry[1], key: entry[2], value: given.value });
      return send(200, true);
    }
    if (url.pathname === "/api/session" && request.method === "GET") {
      // A conversation's subagents', a hundred at a time, as the engine pages them; or the latest.
      const parent = url.searchParams.get("parentID") ?? engine.cursors.get(url.searchParams.get("cursor"));
      if (parent && parent !== "null") {
        const children = [...engine.sessions.values()].filter(each => each.parent === parent);
        const from = Number(url.searchParams.get("cursor")?.split(":")[1] ?? 0);
        const page = children.slice(from, from + 100);
        const next = from + 100 < children.length ? `${parent}:${from + 100}` : null;
        if (next) engine.cursors.set(next, parent);
        return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: page.map(listed), cursor: next ? { next } : {} }));
      }
      return send(200, [...engine.sessions.values()].map(listed));
    }
    if (url.pathname === "/api/session/active") return send(200, Object.fromEntries([...engine.active].map(id => [id, { type: "busy" }])));
    if (url.pathname === "/api/model") return send(200, []);
    if (url.pathname === "/api/experimental/session/import" && request.method === "POST") {
      if (engine.sessions.has(given.info?.id)) return response.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ message: "It's there already." }));
      engine.sessions.set(given.info.id, { id: given.info.id, title: given.info.title, directory: given.location.directory, messages: given.messages, ...(given.info.metadata ? { metadata: given.info.metadata } : {}), parent: given.info.parentID });
      return send(200, listed(engine.sessions.get(given.info.id)));
    }
    const exported = url.pathname.match(/^\/api\/experimental\/session\/([^/]+)\/export$/);
    if (exported) {
      const session = engine.sessions.get(exported[1]);
      return session ? send(200, { info: { id: session.id, title: session.title, ...(session.parent ? { parentID: session.parent } : {}), ...(session.metadata ? { metadata: session.metadata } : {}) }, messages: session.messages }) : send(404, null);
    }
    const match = url.pathname.match(/^\/api\/session\/([^/]+)(\/inbox(?:\/([^/]+))?|\/prompt|\/instructions\/entries|\/interrupt|\/message)?$/);
    const session = match && engine.sessions.get(match[1]);
    if (!session) return send(404, null);
    // What it holds to go (`inbox`: messages sent while it worked), as the engine keeps them.
    if (match[2] === "/inbox") return send(200, session.inbox ?? []);
    if (match[3]) {
      const held = (session.inbox ?? []).find(each => each.id === decodeURIComponent(match[3]));
      if (!held) return send(404, null);
      if (request.method === "PATCH") held.delivery = given.delivery;
      if (request.method === "DELETE") session.inbox = session.inbox.filter(each => each !== held);
      return send(200, true);
    }
    if (match[2] === "/instructions/entries") return send(200, []);
    if (match[2] === "/interrupt") {
      engine.active.delete(session.id);
      return send(200, true);
    }
    if (match[2] === "/message") return send(200, []);
    if (match[2] === "/prompt") {
      engine.prompts.push({ session: session.id, text: given.text, delivery: given.delivery, ...(given.files ? { files: given.files } : {}) });
      return send(200, {});
    }
    if (request.method === "DELETE") {
      engine.sessions.delete(session.id);
      return send(200, true);
    }
    return send(200, listed(session));
  });
  const port = await listening(server);
  atEnd(() => { server.closeAllConnections(); server.close(); });
  return Object.assign(engine, { port, password: "pw" });
}

// A coding agents' bridge with its group chats (`{group, messages, status}` by ID), as the link
// holds, brings in, starts and lets go of one (`api/kuvo/groups`), and no sessions of its own.
async function bridgeWith(groups = new Map()) {
  const server = http.createServer(async (request, response) => {
    const given = await body(request);
    if (!authorized(request)) return response.writeHead(401).end();
    const send = (status, value) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (request.method === "GET" && request.url === "/api/kuvo/peers/mail") {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.flushHeaders();
      return;
    }
    if (request.method === "GET" && request.url === "/api/kuvo/groups") return send(200, { data: [...groups.values()].map(({ group, status }) => ({ group, status })) });
    const match = request.url.match(/^\/api\/kuvo\/groups\/([^/]+)(?:\/(hold|activate|release))?$/);
    if (match) {
      const chat = groups.get(match[1]);
      if (request.method === "PUT") {
        groups.set(match[1], { group: given.group, messages: given.messages, status: given.status });
        return send(200, { data: true });
      }
      if (!chat) return send(404, { message: "No such chat." });
      if (request.method === "GET") return send(200, { data: chat });
      if (match[2] === "hold") chat.status = "held";
      if (match[2] === "activate") chat.status = "active";
      if (match[2] === "release") groups.delete(match[1]);
      return send(200, { data: match[2] === "hold" ? { group: chat.group, messages: chat.messages } : true });
    }
    // None of its own sessions: a message for one isn't for it.
    if (request.url.startsWith("/api/session/")) return send(404, { message: "No such session." });
    return send(200, {});
  });
  const port = await listening(server);
  atEnd(() => { server.closeAllConnections(); server.close(); });
  return { port, password: "pw", pid: process.pid, groups };
}

// The app, as its host interface answers this Mac's box: its keys.
const app = { keys: null };
const appHost = http.createServer(async (request, response) => {
  const given = await body(request);
  if (request.url === "/hello") {
    const proof = crypto.createHmac("sha256", "host-password").update(`kuvo-host-hello\u0000${given.nonce}\u0000127.0.0.1:${appHost.address().port}`).digest("hex");
    return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ proof }));
  }
  if (request.headers.authorization !== "Bearer host-password") return response.writeHead(401).end();
  if (request.url === "/link/identity") return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(app.keys));
  if (request.url === "/link/route") return response.writeHead(404, { "content-type": "application/json", "x-kuvo-answer": "1" }).end("{}");
  response.writeHead(404).end();
});
await listening(appHost);

Object.assign(process.env, {
  KUVO_HOME: macHome,
  KUVO_BOTS: macBots,
  KUVO_WAKES: macWakes,
  KUVO_BOX: "mac",
  KUVO_ENGINE_CONFIG: path.join(support, "opencode"),
  KUVO_KEYS: path.join(support, "keys"),
  KUVO_HOST_URL: `http://127.0.0.1:${appHost.address().port}`,
  KUVO_HOST_PASSWORD: "host-password",
});
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
const relay = await relayStandIn(link, { changed: () => {} });

// A chat on this Mac, with a wake-up; a bot on the machine, in its own folder.
const messages = text => [{ info: { id: `msg_${crypto.randomBytes(4).toString("hex")}`, role: "user" }, parts: [{ type: "text", text }] }];
const macEngine = await engineWith([
  { id: "ses_chat1", title: "Trip plans", directory: macChats, messages: messages("Where to in May?") },
  { id: "ses_chat2", title: "Groceries", directory: macChats, messages: messages("Milk") },
]);
const labEngine = await engineWith([{ id: "ses_bot1", title: "Ada", directory: path.join(labBots, "bot_ada", "workspace"), messages: messages("Remember the deploy.") }]);
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
};
write(path.join(macHome, "run", "engine.json"), { port: macEngine.port, password: "pw" });
// A group chat of the machine's bots, and one with a bot of this Mac's, on this Mac.
const said = [{ id: "gmsg_1", from: "you", text: "Morning." }];
const macBridge = await bridgeWith(new Map([
  ["grp_lab", { group: { id: "grp_lab", name: "Lab crew", members: ["bot_lin"] }, messages: said, status: "active" }],
  ["grp_mix", { group: { id: "grp_mix", name: "Mixed", members: ["bot_lin", "bot_mac"] }, messages: said, status: "active" }],
]));
const labBridge = await bridgeWith();
const { groups: _mac, ...macBridgeRecord } = macBridge;
const { groups: _lab, ...labBridgeRecord } = labBridge;
write(path.join(macHome, "run", "bridge.json"), macBridgeRecord);
write(path.join(machineHome, "run", "engine.json"), { port: labEngine.port, password: "pw" });
write(path.join(machineHome, "run", "bridge.json"), labBridgeRecord);
write(path.join(labBots, "bot_lin", "bot.json"), { kuvo: 1, id: "bot_lin", name: "Lin" });
write(path.join(labBots, "bot_lin", "session"), "ses_lin\n");
write(path.join(macWakes, "ses_chat1", "wakes.json"), [{ id: "wak_1", due: 1, note: "Book the train" }]);
write(path.join(labBots, "bot_ada", "bot.json"), { kuvo: 1, id: "bot_ada", name: "Ada", look: { color: "graphite", shape: "round", face: "calm" } });
write(path.join(labBots, "bot_ada", "session"), "ses_bot1\n");
write(path.join(labBots, "bot_ada", "MEMORY.md"), "The deploy is on Fridays.\n");
// A bot you paused, on the machine.
write(path.join(labBots, "bot_rest", "bot.json"), { kuvo: 1, id: "bot_rest", name: "Rest" });
write(path.join(labBots, "bot_rest", "session"), "ses_rest\n");
write(path.join(labBots, "bot_rest", "paused"), "Back on Monday");
labEngine.sessions.set("ses_rest", { id: "ses_rest", title: "Rest", directory: path.join(labBots, "bot_rest", "workspace"), messages: messages("Rest up.") });

// This Mac's keys, as your Keychain keeps them.
const macKey = link.newKey();
const macSecret = crypto.randomBytes(32);
const mac = link.publicOf(macKey).toString("base64url");
app.keys = { key: macKey.toString("base64url"), secret: macSecret.toString("base64url"), sign: link.newSigningSeed() };

link.macLink.hold = link.macNoticeHold();
const handle = link.engineHandler(link.readEngineFile, { name: "Mac" }, link.readBridgeFile, () => {}, link.macLink.hold);
async function ask(method, p, given) {
  const parts = [];
  for await (const part of handle({ method, path: p, headers: {}, body: given ? Buffer.from(JSON.stringify(given)) : Buffer.alloc(0), fromApp: true }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  let json;
  try { json = JSON.parse(text); } catch {}
  return { status: parts[0].head.status, json };
}

// What the machine's box answers this Mac over SSH (`box route`), a process of its own.
async function askMachine(method, p, given) {
  const child = spawn(process.execPath, [script, "box", "route"], { env: { PATH: process.env.PATH, HOME: support, KUVO_HOME: machineHome, ...(process.env.BUN_BE_BUN ? { BUN_BE_BUN: "1" } : {}) }, stdio: ["pipe", "pipe", "inherit"] });
  child.stdin.end(JSON.stringify({ method, path: p, ...(given ? { body: given } : {}) }));
  let out = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) out += chunk;
  const answer = JSON.parse(out.trim().split("\n").at(-1));
  return { status: answer.status, json: JSON.parse(answer.body) };
}

let lab = null;

before(async () => {
  assert.notEqual((await ask("PUT", "kuvo/link/config", { phones: false, machines: true, relay: relay.url, name: "Studio Mac", app: "0.9.0" })).json?.state, "failed");
  const setup = await ask("GET", "kuvo/link/setup");
  assert.equal(setup.status, 200);
  const result = spawnSync(process.execPath, [script, "setup"], {
    input: JSON.stringify({ relay: relay.url, name: "lab", mac, macSign: setup.json.macSign, docs: setup.json.docs, id: "lab" }),
    env: { PATH: process.env.PATH, HOME: support, KUVO_HOME: machineHome, ...(process.env.BUN_BE_BUN ? { BUN_BE_BUN: "1" } : {}) },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  lab = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal((await ask("PUT", "kuvo/link/peers", { peers: [{ key: lab.key, sign: lab.sign, address: lab.address, name: "lab", id: "lab" }], moved: [] })).status, 200);
  link.runMacLink();
  link.runMacPeers();
  // Both on the relay, as they are once they've started.
  await eventually(() => relay.has(link.addressOf(macSecret)) && relay.has(Buffer.from(lab.address, "base64url")));
});

removeAtEnd(support);
atEnd(async () => {
  link.stopMacPeers();
  link.stopMacLink();
  let pid = 0;
  try { pid = Number(fs.readFileSync(path.join(machineHome, "run", "link.pid"), "utf8")); } catch {}
  if (pid > 0) {
    try { process.kill(pid, "SIGTERM"); } catch {}
    for (let tries = 0; tries < 100; tries++) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  await relay.close();
  appHost.close();
});

// What's in a box's trash: each thing it holds, by its name.
const trashed = home => {
  try { return fs.readdirSync(path.join(home, "trash")).flatMap(when => fs.readdirSync(path.join(home, "trash", when)).map(name => path.join(home, "trash", when, name))); } catch { return []; }
};

test("where something can go: each of your other computers", { timeout: 60_000 }, async t => {
  signal = t.signal;
  const places = await ask("GET", "kuvo/moves/places?kind=chat&id=ses_chat1");
  assert.equal(places.status, 200);
  assert.deepEqual(places.json.places, [{ key: lab.key, name: "lab", kind: "machine", ok: true }]);
  assert.equal((await ask("GET", "kuvo/moves/places?kind=chat&id=ses_nothing")).status, 404);
});

test("a chat moves from this Mac to the machine, with its wake-ups; here it's gone, kept in the trash", { timeout: 60_000 }, async t => {
  signal = t.signal;
  // The imported chat is older than the destination's latest forty: it is still ours
  // immediately at landing, even when a normal directory refresh would leave it out.
  for (let i = 0; i < 45; i++) labEngine.sessions.set(`ses_recent${i}`, { id: `ses_recent${i}`, title: `Recent ${i}`, directory: labChats, messages: [] });
  const said = macEngine.sessions.get("ses_chat1").messages;
  const moved = await ask("POST", "kuvo/moves", { kind: "chat", id: "ses_chat1", to: lab.key });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal(moved.json.move.thing, "ses_chat1");
  assert.deepEqual(moved.json.move.sessions, ["ses_chat1"]);
  // There: its conversation, word for word, in the machine's chats, and its wake-ups going.
  const there = labEngine.sessions.get("ses_chat1");
  assert.equal(there?.directory, labChats);
  assert.deepEqual(there.messages, said);
  assert.equal(there.metadata?.kuvo?.chat, labChats, "a chat there from the first, as the box it came to marks its chats");
  assert.equal(JSON.parse(fs.readFileSync(path.join(labWakes, "ses_chat1", "wakes.json"), "utf8"))[0].note, "Book the train");
  assert.equal(fs.readFileSync(path.join(labWakes, "ses_chat1", "directory"), "utf8"), labChats);
  assert.ok(!fs.existsSync(path.join(labWakes, "ses_chat1", "paused")), "its wake-ups go on there");
  // Here: gone, its conversation kept with its wake-ups in the trash.
  assert.ok(!macEngine.sessions.has("ses_chat1"));
  assert.ok(!fs.existsSync(path.join(macWakes, "ses_chat1")));
  const kept = trashed(macHome).find(each => path.basename(each) === "ses_chat1");
  assert.ok(kept && JSON.parse(fs.readFileSync(path.join(kept, "conversation.json"), "utf8"))[0].info.id === "ses_chat1");
  // Nothing under way on either box, and nothing listed where it doesn't live.
  assert.deepEqual(underWay((await ask("GET", "kuvo/moves")).json), { moves: [], away: [] });
  assert.deepEqual(underWay((await askMachine("GET", "kuvo/moves")).json), { moves: [], away: [] });
});

test("the chat that moved takes messages where it lives now", { timeout: 60_000 }, async t => {
  signal = t.signal;
  const listed = JSON.parse(fs.readFileSync(path.join(machineHome, "run", "agents.json"), "utf8"));
  assert.ok(listed.agents.some(agent => agent.session === "ses_chat1" && agent.machine === listed.machine), "the receiving box lists the chat before acknowledging the move");
  const sent = await ask("POST", "kuvo/agent-tools", { name: "send_message", arguments: { to: "ses_chat1", text: "Did you book it?", wait: false }, session: "ses_chat2" });
  assert.equal(sent.status, 200);
  assert.equal(sent.json.isError, false, sent.json.text);

  // Stop on a refusal too: a stale receiving list must fail this test immediately.
  const result = await eventually(() => {
    const prompt = labEngine.prompts.find(each => each.session === "ses_chat1");
    if (prompt) return { prompt };
    for (const mail of relay.delivered) {
      try {
        const body = link.readFrame(mail.payload).body;
        const payload = JSON.parse(link.openOneWay(body, macKey, Buffer.from(lab.key, "base64url")).payload.toString());
        if (payload.delivered?.ok === false) return { refused: payload.delivered.why };
      } catch {}
    }
    return false;
  });
  assert.equal(result.refused, undefined);
  const { prompt } = result;
  assert.match(prompt.text, /Did you book it\?$/);
});

test("a bot moves from the machine to this Mac, asked as this Mac asks a machine", { timeout: 60_000 }, async t => {
  signal = t.signal;
  const moved = await askMachine("POST", "kuvo/moves", { kind: "bot", id: "bot_ada", to: mac });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  // Here: its folder, its memory, its conversation working in it, and nothing holding it.
  assert.equal(fs.readFileSync(path.join(macBots, "bot_ada", "MEMORY.md"), "utf8"), "The deploy is on Fridays.\n");
  assert.ok(!fs.existsSync(path.join(macBots, "bot_ada", "paused")));
  assert.equal(macEngine.sessions.get("ses_bot1")?.directory, path.join(macBots, "bot_ada", "workspace"));
  // There: gone, to the machine's trash with its conversation.
  assert.ok(!labEngine.sessions.has("ses_bot1"));
  assert.ok(!fs.existsSync(path.join(labBots, "bot_ada")));
  const kept = trashed(machineHome).find(each => path.basename(each) === "bot_ada");
  assert.ok(kept && fs.existsSync(path.join(kept, "conversation.json")));
});

test("a computer that can't take it now: it stays where it was, as it was", { timeout: 60_000 }, async t => {
  signal = t.signal;
  // The machine's engine down.
  const record = path.join(machineHome, "run", "engine.json");
  const was = fs.readFileSync(record, "utf8");
  write(record, { port: 9, password: "pw" });
  t.after(() => write(record, was));
  const moved = await ask("POST", "kuvo/moves", { kind: "chat", id: "ses_chat2", to: lab.key });
  assert.equal(moved.status, 409);
  assert.match(moved.json.message, /engine on lab isn’t running/);
  assert.ok(macEngine.sessions.has("ses_chat2"));
  assert.ok(!labEngine.sessions.has("ses_chat2"));
  assert.deepEqual(underWay((await ask("GET", "kuvo/moves")).json), { moves: [], away: [] });
});

test("a group chat goes to the machine its bots live on, held there until the switch; one whose bots don't all live there stays", { timeout: 60_000 }, async t => {
  signal = t.signal;
  // Once the machine has said which bots live there, its place says so for each chat.
  await eventually(() => {
    try { return JSON.parse(fs.readFileSync(path.join(macHome, "run", "peer-agents.json"), "utf8"))[lab.key]?.list.some(agent => agent.kind === "bot" && agent.id === "bot_lin"); } catch { return false; }
  });
  assert.deepEqual((await ask("GET", "kuvo/moves/places?kind=group&id=grp_lab")).json.places, [{ key: lab.key, name: "lab", kind: "machine", ok: true }]);
  assert.deepEqual((await ask("GET", "kuvo/moves/places?kind=group&id=grp_mix")).json.places, [{
    key: lab.key, name: "lab", kind: "machine", ok: false,
    why: "“Mixed”’s bots don’t all live on lab. Move them there first, then the chat can follow.", note: "Its bots don’t all live there",
  }]);
  const moved = await ask("POST", "kuvo/moves", { kind: "group", id: "grp_lab", to: lab.key });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal(labBridge.groups.get("grp_lab")?.status, "active");
  assert.deepEqual(labBridge.groups.get("grp_lab").messages, said);
  assert.ok(!macBridge.groups.has("grp_lab"), "let go here");

  const mixed = await ask("POST", "kuvo/moves", { kind: "group", id: "grp_mix", to: lab.key });
  assert.equal(mixed.status, 409);
  assert.match(mixed.json.message, /Mixed.*bots live on different computers/);
  assert.equal(macBridge.groups.get("grp_mix")?.status, "active", "it goes on here as it was");
  assert.ok(!labBridge.groups.has("grp_mix"));
});

test("a chat with more subagents than the engine lists at once moves with every one", { timeout: 60_000 }, async t => {
  signal = t.signal;
  macEngine.sessions.set("ses_many", { id: "ses_many", title: "Research", directory: macChats, messages: messages("Look into it.") });
  for (let i = 0; i < 130; i++) macEngine.sessions.set(`ses_sub${i}`, { id: `ses_sub${i}`, title: `Part ${i}`, directory: macChats, messages: messages(`Part ${i}`), parent: "ses_many" });
  const moved = await ask("POST", "kuvo/moves", { kind: "chat", id: "ses_many", to: lab.key });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal(moved.json.move.sessions.length, 131);
  for (let i = 0; i < 130; i++) assert.equal(labEngine.sessions.get(`ses_sub${i}`)?.parent, "ses_many", `ses_sub${i} there`);
  assert.ok(![...macEngine.sessions.keys()].some(id => id === "ses_many" || id.startsWith("ses_sub")), "and gone here");
});

test("asked twice at once (a phone and this Mac, say), it moves once; the other is told it's moving", { timeout: 60_000 }, async t => {
  signal = t.signal;
  macEngine.sessions.set("ses_twice", { id: "ses_twice", title: "Twice", directory: macChats, messages: messages("Once?") });
  const asked = await Promise.all([1, 2].map(() => ask("POST", "kuvo/moves", { kind: "chat", id: "ses_twice", to: lab.key })));
  assert.deepEqual(asked.map(each => each.status).sort(), [200, 409]);
  assert.match(asked.find(each => each.status === 409).json.message, /moving to another computer/);
  assert.ok(labEngine.sessions.has("ses_twice") && !macEngine.sessions.has("ses_twice"));
});

test("a bot you paused moves paused, as you paused it", { timeout: 60_000 }, async t => {
  signal = t.signal;
  const moved = await askMachine("POST", "kuvo/moves", { kind: "bot", id: "bot_rest", to: mac });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal(fs.readFileSync(path.join(macBots, "bot_rest", "paused"), "utf8"), "Back on Monday");
  assert.ok(macEngine.sessions.has("ses_rest") && !fs.existsSync(path.join(labBots, "bot_rest")));
});

test("a chat on Autopilot moves on Autopilot, its agent told there, with the calls it made", { timeout: 60_000 }, async t => {
  signal = t.signal;
  macEngine.sessions.set("ses_pilot", { id: "ses_pilot", title: "Cafe", directory: macChats, messages: messages("Build the menu"), metadata: { kuvo: { autopilot: true } } });
  write(path.join(macHome, "run", "work", "decided.json"), { ses_pilot: [{ id: "frm_pilot", text: "Which roast?", choice: "Warm", options: ["Warm", "Dark"], call: "call_pilot", at: 1 }] });
  const moved = await ask("POST", "kuvo/moves", { kind: "chat", id: "ses_pilot", to: lab.key });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.ok(labEngine.entries.some(each => each.session === "ses_pilot" && each.key === "kuvo.autopilot" && /Autopilot/.test(each.value)));
  const there = await askMachine("GET", "kuvo/sessions/ses_pilot/autopilot");
  assert.equal(there.json.autopilot, true);
  assert.deepEqual(there.json.decided.map(call => call.id), ["frm_pilot"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(macHome, "run", "work", "decided.json"), "utf8")).ses_pilot, undefined, "gone with it from the box it left");
});

test("a chat you stopped moves stopped, with what waits for it in the same order; nothing of it stays here", { timeout: 60_000 }, async t => {
  signal = t.signal;
  macEngine.sessions.set("ses_stop", { id: "ses_stop", title: "Stopped", directory: macChats, messages: messages("Wait for me.") });
  assert.equal((await ask("POST", "kuvo/sessions/ses_stop/stop")).json?.paused, true);
  // What came while it was stopped: another agent's letter, then one of yours with a file.
  await ask("POST", "kuvo/sessions/ses_stop/queue/add", { id: "msg_wait1", text: "[Letter] The build is green.", from: "Ada", words: "The build is green.", kept: true });
  fs.writeFileSync(path.join(support, "stop-notes.txt"), "Docs first.");
  await ask("POST", "kuvo/sessions/ses_stop/queue/add", { id: "msg_wait2", text: "Then the docs.", files: [{ uri: `file://${path.join(support, "stop-notes.txt")}`, name: "notes.txt" }] });
  const moved = await ask("POST", "kuvo/moves", { kind: "chat", id: "ses_stop", to: lab.key });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  // There: still stopped, the same waiting, in the same order, shown as here.
  const there = await askMachine("GET", "kuvo/sessions/ses_stop/queue");
  assert.equal(there.status, 200);
  assert.equal(there.json.paused, true, "still stopped");
  assert.deepEqual(there.json.waiting?.map(each => [each.id, each.from ?? null, each.text, each.files ?? null]), [
    ["msg_wait1", "Ada", "The build is green.", null],
    ["msg_wait2", null, "Then the docs.", ["notes.txt"]],
  ]);
  assert.deepEqual(labEngine.prompts.filter(each => each.session === "ses_stop"), [], "nothing went to the agent");
  // Here: nothing of it.
  assert.deepEqual((await ask("GET", "kuvo/sessions/ses_stop/queue")).json, { paused: false, held: [] });
  for (const id of ["msg_wait1", "msg_wait2"]) assert.ok(!fs.existsSync(path.join(macHome, "run", "waiting", `${id}.json`)), id);
  // Resume there: the first goes, whole, as it would have gone here.
  assert.equal((await askMachine("POST", "kuvo/sessions/ses_stop/queue/resume")).status, 200);
  assert.deepEqual(labEngine.prompts.filter(each => each.session === "ses_stop"), [{ session: "ses_stop", text: "[Letter] The build is green.", delivery: "steer" }]);
  assert.deepEqual((await askMachine("GET", "kuvo/sessions/ses_stop/queue")).json.waiting.map(each => each.id), ["msg_wait2"]);
});

test("a chat stopped with messages the engine held moves with them, in their order, and the files of what waits go along", { timeout: 90_000 }, async t => {
  signal = t.signal;
  // Two sent while it worked, still in the engine's inbox as you press Stop: the one for its next
  // step goes first.
  macEngine.sessions.set("ses_held", { id: "ses_held", title: "Held", directory: macChats, messages: messages("Build it."), inbox: [
    { id: "msg_held1", sessionID: "ses_held", type: "user", delivery: "queue", payload: { text: "Also run the tests.", files: [{ data: "b2s=", mime: "text/plain", source: { type: "uri", uri: "file:///gone/log.txt" }, name: "log.txt" }] } },
    { id: "msg_held2", sessionID: "ses_held", type: "user", delivery: "steer", payload: { text: "[Message from Ada · ses_ada] (To answer, use send_message to ses_ada.)\n\nThe build is green." } },
  ] });
  assert.equal((await ask("POST", "kuvo/sessions/ses_held/stop")).json?.paused, true);
  // Then one of yours, with a file only this Mac has.
  const notes = path.join(support, "notes.txt");
  fs.writeFileSync(notes, "Ship on Friday.");
  await ask("POST", "kuvo/sessions/ses_held/queue/add", { id: "msg_wait4", text: "Then the docs.", files: [{ uri: `file://${notes}`, name: "notes.txt" }] });
  // And one whose file is gone by now: it goes, without it.
  await ask("POST", "kuvo/sessions/ses_held/queue/add", { id: "msg_wait5", text: "And the tag.", files: [{ uri: `file://${path.join(support, "gone.txt")}`, name: "gone.txt" }] });
  const moved = await ask("POST", "kuvo/moves", { kind: "chat", id: "ses_held", to: lab.key });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  // There: stopped, all three waiting in the order they had here, shown as here.
  const there = (await askMachine("GET", "kuvo/sessions/ses_held/queue")).json;
  assert.equal(there.paused, true, "still stopped");
  assert.deepEqual(there.waiting?.map(each => [each.id, each.from ?? null, each.text, each.files ?? null]), [
    ["msg_held2", "Ada", "The build is green.", null],
    ["msg_held1", null, "Also run the tests.", ["log.txt"]],
    ["msg_wait4", null, "Then the docs.", ["notes.txt"]],
    ["msg_wait5", null, "And the tag.", null],
  ]);
  assert.deepEqual(labEngine.prompts.filter(each => each.session === "ses_held"), [], "nothing went to the agent");
  // Each goes whole as Resume sends it, a file with what's in it.
  for (const step of [1, 2, 3, 4]) {
    assert.equal((await askMachine("POST", "kuvo/sessions/ses_held/queue/resume")).status, 200);
    await eventually(() => labEngine.prompts.filter(each => each.session === "ses_held").length >= step);
  }
  assert.deepEqual(labEngine.prompts.filter(each => each.session === "ses_held").map(each => [each.text, each.files ?? null]), [
    ["[Message from Ada · ses_ada] (To answer, use send_message to ses_ada.)\n\nThe build is green.", null],
    ["Also run the tests.", [{ name: "log.txt", uri: "data:text/plain;base64,b2s=" }]],
    ["Then the docs.", [{ name: "notes.txt", uri: `data:text/plain;base64,${Buffer.from("Ship on Friday.").toString("base64")}` }]],
    ["And the tag.", null],
  ]);
});

test("a chat at work as you move it: Stop while it waits for the turn to end, and it moves stopped, with what was sent meanwhile", { timeout: 90_000 }, async t => {
  signal = t.signal;
  macEngine.sessions.set("ses_busy", { id: "ses_busy", title: "Busy", directory: macChats, messages: messages("Refactor it."), inbox: [
    { id: "msg_busy1", sessionID: "ses_busy", type: "user", delivery: "queue", payload: { text: "Keep the old names." } },
  ] });
  macEngine.active.add("ses_busy");
  const moving = ask("POST", "kuvo/moves", { kind: "chat", id: "ses_busy", to: lab.key });
  // Once it's moving (waiting for the turn to end): Stop.
  while (!(await ask("GET", "kuvo/moves")).json?.moves?.some(each => each.thing === "ses_busy")) await new Promise(resolve => setTimeout(resolve, 20));
  const stopped = await ask("POST", "kuvo/sessions/ses_busy/stop");
  assert.equal(stopped.status, 200, JSON.stringify(stopped.json));
  assert.equal(stopped.json.paused, true);
  const moved = await moving;
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  const there = (await askMachine("GET", "kuvo/sessions/ses_busy/queue")).json;
  assert.equal(there.paused, true, "still stopped");
  assert.deepEqual(there.waiting?.map(each => each.text), ["Keep the old names."]);
});

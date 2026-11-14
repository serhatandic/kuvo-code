// This Mac's box and one of its machines, each with agents of its own, over the relay (PROTOCOL.md,
// "Peers"): each tells the other who its agents are; a letter from one of this Mac's conversations
// (its send_message, which this Mac's box answers) reaches the machine's, and its answer comes back
// to the one waiting, or, once it stopped waiting, as a message; a letter from the machine reaches this Mac's; this Mac's group chats' mail
// reaches the machine's and is said to be there; and what an earlier Kuvo Code kept itself (its
// letters on their way) goes on from the box. This Mac's box is `serve`'s
// link, here; the machine is `kuvo-link.js run`, a process of its own, set up as the app sets one up
// over SSH. Only the relay, the app, the engines and the coding agents' bridges are stand-ins.
//
// Run with `node --test box/bridge-tests/mac-peers.test.js`.
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

const script = fileURLToPath(new URL("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-mac-peers-")));
const macHome = path.join(support, "mac");
const machineHome = path.join(support, "machine");
for (const home of [macHome, machineHome]) fs.mkdirSync(path.join(home, "run"), { recursive: true });

// Each time a stand-in records something: what a test waits on looks again.
const waitingForChange = [];
const changed = () => new Promise(resolve => waitingForChange.push(resolve));
const poke = () => { for (const resolve of waitingForChange.splice(0)) resolve(); };
// Looked at again each time a stand-in records something, until it's there, or the test runs out
// of time (`signal`), saying what never came.
async function arrived(found) {
  for (;;) {
    const value = await found();
    if (value) return value;
    if (signal?.aborted) throw new Error(`It never came: ${found}`);
    await Promise.race([changed(), new Promise(resolve => signal?.addEventListener("abort", resolve, { once: true }))]);
  }
}
// What a box wrote that tells nothing here when it does (the machine is another process; mail
// this Mac's box takes comes through the relay, which only says it delivered): looked at again
// every few milliseconds until it's there, or the test runs out of time (`signal`).
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
      reject(new Error("it never got there"));
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

// An engine with `sessions`: what's prompted in each, and, for those given one (`answers`), the
// reply its agent writes after.
async function engineWith(sessions) {
  const seen = { prompts: [], answers: new Map() };
  const server = http.createServer(async (request, response) => {
    const given = await body(request);
    const url = new URL(request.url, "http://x");
    const send = (status, data) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ data }));
    if (!authorized(request)) return response.writeHead(401).end();
    if (url.pathname === "/api/session") return send(200, sessions.map(each => ({ id: each.id, title: each.title, time: { updated: Date.now() }, directory: "/work" })));
    if (url.pathname === "/api/session/active") return send(200, {});
    const match = url.pathname.match(/^\/api\/session\/([^/]+)(\/prompt|\/message)?$/);
    const session = match && sessions.find(each => each.id === match[1]);
    if (!session) return send(404, null);
    if (match[2] === "/prompt") {
      seen.prompts.push({ session: session.id, text: given.text });
      poke();
      return send(200, {});
    }
    if (match[2] === "/message") {
      const answer = seen.answers.get(session.id);
      const prompted = seen.prompts.some(each => each.session === session.id);
      return send(200, answer && prompted ? [{ id: "msg_~", type: "assistant", content: [{ type: "text", text: answer }] }] : []);
    }
    return send(200, { id: session.id, title: session.title });
  });
  const port = await listening(server);
  atEnd(() => { server.closeAllConnections(); server.close(); });
  return { port, password: "pw", seen };
}

// A coding agents' bridge, as its group chats talk to the link (`api/kuvo/peers`): who your other
// computers are, as it's told; the mail it sends (`give`, on the stream it's followed on); what
// comes for it; and what it hears went.
async function bridgeWith() {
  const seen = { peers: [], mail: [], sent: [], streams: new Set() };
  const server = http.createServer(async (request, response) => {
    const given = await body(request);
    if (!authorized(request)) return response.writeHead(401).end();
    const done = () => response.writeHead(200, { "content-type": "application/json" }).end("{}");
    if (request.method === "GET" && request.url === "/api/kuvo/peers/mail") {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      // Followed from now, as the bridge answers at once.
      response.flushHeaders();
      seen.streams.add(response);
      response.on("close", () => seen.streams.delete(response));
      poke();
      return;
    }
    if (request.method === "PUT" && request.url === "/api/kuvo/peers") seen.peers.push(given);
    else if (request.method === "POST" && request.url === "/api/kuvo/peers/mail") seen.mail.push(given);
    else if (request.method === "POST" && request.url === "/api/kuvo/peers/sent") seen.sent.push(...(given.ids ?? []));
    else if (!(request.method === "POST" && request.url === "/api/kuvo/peers/gaveup")) return response.writeHead(404).end();
    poke();
    return done();
  });
  const port = await listening(server);
  atEnd(() => { server.closeAllConnections(); server.close(); });
  return { port, password: "pw", pid: process.pid, seen, give: line => { for (const stream of seen.streams) stream.write(JSON.stringify(line) + "\n"); } };
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
  KUVO_BOTS: path.join(support, "bots"),
  KUVO_WAKES: path.join(support, "wakes"),
  KUVO_BOX: "mac",
  KUVO_ENGINE_CONFIG: path.join(support, "opencode"),
  KUVO_KEYS: path.join(support, "keys"),
  KUVO_HOST_URL: `http://127.0.0.1:${appHost.address().port}`,
  KUVO_HOST_PASSWORD: "host-password",
});
const link = await import("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js");
const relay = await relayStandIn(link, { changed: poke });

// Each box's engine, with a conversation of its own, and its coding agents' bridge.
const macEngine = await engineWith([{ id: "ses_mac1", title: "Release notes" }]);
const labEngine = await engineWith([{ id: "ses_lab1", title: "API work" }]);
const macBridge = await bridgeWith();
const labBridge = await bridgeWith();
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
write(path.join(macHome, "run", "engine.json"), { port: macEngine.port, password: "pw" });
write(path.join(macHome, "run", "bridge.json"), { port: macBridge.port, password: "pw", pid: process.pid });
write(path.join(machineHome, "run", "engine.json"), { port: labEngine.port, password: "pw" });
write(path.join(machineHome, "run", "bridge.json"), { port: labBridge.port, password: "pw", pid: process.pid });

// This Mac's keys, as your Keychain keeps them.
const macKey = link.newKey();
const macSecret = crypto.randomBytes(32);
const macAddress = link.addressOf(macSecret);
const mac = link.publicOf(macKey).toString("base64url");
app.keys = { key: macKey.toString("base64url"), secret: macSecret.toString("base64url"), sign: link.newSigningSeed() };

link.macLink.hold = link.macNoticeHold();
const handle = link.engineHandler(link.readEngineFile, { name: "Mac" }, link.readBridgeFile, () => {}, link.macLink.hold);
async function ask(method, p, given, { abort } = {}) {
  const parts = [];
  for await (const part of handle({ method, path: p, headers: {}, body: given ? Buffer.from(JSON.stringify(given)) : Buffer.alloc(0), fromApp: true }, {}, abort)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  let json;
  // (A stream of lines: each, and the last as the answer.)
  const lines = parts[0].head.headers?.["content-type"] === "application/x-ndjson" ? text.trim().split("\n").map(line => JSON.parse(line)) : null;
  try { json = lines ? lines.at(-1) : JSON.parse(text); } catch {}
  return { status: parts[0].head.status, json, lines };
}

const run = file => path.join(machineHome, "run", file);
const read = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const sending = home => { try { return fs.readdirSync(path.join(home, "run", "outbox", "sending")).filter(name => name.endsWith(".json")); } catch { return []; } };

let lab = null;

before(async () => {
  // This Mac's box on, meeting its machines: up first, as the machine starts after it's set up.
  assert.notEqual((await ask("PUT", "kuvo/link/config", { phones: false, machines: true, relay: relay.url, name: "Studio Mac", app: "0.9.0" })).json?.state, "failed");
  const setup = await ask("GET", "kuvo/link/setup");
  assert.equal(setup.status, 200);
  // Set up as the app sets it up over SSH.
  const result = spawnSync(process.execPath, [script, "setup"], {
    input: JSON.stringify({ relay: relay.url, name: "lab", mac, macSign: setup.json.macSign, docs: setup.json.docs, id: "lab" }),
    env: { PATH: process.env.PATH, HOME: support, KUVO_HOME: machineHome },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  lab = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal((await ask("PUT", "kuvo/link/peers", { peers: [{ key: lab.key, sign: lab.sign, address: lab.address, name: "lab", id: "lab" }], moved: [] })).status, 200);
  link.runMacLink();
  link.runMacPeers();
});

removeAtEnd(support);
atEnd(async () => {
  link.stopMacPeers();
  link.stopMacLink();
  let pid = 0;
  try { pid = Number(fs.readFileSync(run("link.pid"), "utf8")); } catch {}
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

test("each box tells the other who its agents are, with what this Mac answers", { timeout: 60_000 }, async t => {
  signal = t.signal;
  await arrived(() => relay.has(macAddress));
  const told = await eventually(() => read(run("peer-agents.json"))?.[mac]);
  assert.deepEqual(told.list.map(agent => [agent.session, agent.name]), [["ses_mac1", "Release notes"]]);
  // What this Mac answers, as its box says it (its app gives no list).
  assert.deepEqual(told.features, link.macFeatures());
  // This Mac's box has the machine's, by its name here, for the app's list of everyone.
  const peers = await eventually(() => {
    const agents = read(path.join(macHome, "run", "peer-agents.json"));
    return agents?.[lab.key] && agents;
  });
  assert.ok(peers);
  const listed = (await ask("GET", "kuvo/link/agents")).json.peers.find(peer => peer.key === lab.key);
  assert.equal(listed.id, "lab");
  assert.deepEqual(listed.list.map(agent => [agent.session, agent.name]), [["ses_lab1", "API work"]]);
  // And the list this Mac's group chats name: its own, and the machine's, by its name.
  const everyone = read(path.join(macHome, "run", "agents.json"));
  assert.deepEqual(everyone.agents.map(agent => [agent.session, agent.machine ?? null]), [["ses_mac1", null], ["ses_lab1", "lab"]]);
});

test("a letter from this Mac's conversation reaches the machine's, and its answer comes back to the one waiting", { timeout: 60_000 }, async t => {
  signal = t.signal;
  labEngine.seen.answers.set("ses_lab1", "Shipped this morning.");
  const answer = await ask("POST", "kuvo/agent-tools", { name: "send_message", arguments: { to: "ses_lab1", text: "Is the API out?", wait: true }, session: "ses_mac1" });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.json, { text: "API work answered:\n\nShipped this morning.", isError: false });
  const prompt = labEngine.seen.prompts.find(each => each.session === "ses_lab1");
  assert.match(prompt.text, /^\[Message from Release notes · ses_mac1\] \(They're waiting for your reply/);
  assert.match(prompt.text, /Is the API out\?$/);
  // Nothing left on its way, on either box.
  await eventually(() => !sending(macHome).length && !sending(machineHome).length);
});

test("an answer that comes after this Mac's conversation stopped waiting reaches it as a message", { timeout: 60_000 }, async t => {
  signal = t.signal;
  labEngine.seen.answers.set("ses_lab1", "Later, but done.");
  const prompted = labEngine.seen.prompts.length;
  const stop = new AbortController();
  const asking = ask("POST", "kuvo/agent-tools", { name: "send_message", arguments: { to: "ses_lab1", text: "And the docs?", wait: true }, session: "ses_mac1" }, { abort: stop.signal });
  // There, and its turn stopped before the answer.
  await arrived(() => labEngine.seen.prompts.length > prompted);
  stop.abort();
  assert.equal((await asking).json.text, "API work hasn't answered yet. It may still write back with send_message.");
  const message = await arrived(() => macEngine.seen.prompts.find(each => each.text.includes("Later, but done.")));
  assert.equal(message.session, "ses_mac1");
  assert.match(message.text, /^\[Message from API work · ses_lab1\]/);
});

test("a letter from the machine's conversation reaches this Mac's", { timeout: 60_000 }, async t => {
  signal = t.signal;
  // As the machine's tool leaves one.
  fs.mkdirSync(run("outbox/sending"), { recursive: true });
  write(run("outbox/sending/ltr_fromlab1.json"), { from: "ses_lab1", to: "ses_mac1", text: "The build is green.", wait: false, at: Date.now() });
  const message = await arrived(() => macEngine.seen.prompts.find(each => each.text.includes("The build is green.")));
  assert.equal(message.session, "ses_mac1");
  assert.match(message.text, /^\[Message from API work · ses_lab1\] \(To answer, use send_message to ses_lab1\.\)/);
  // Said to be there: it's gone from the machine's outbox.
  await eventually(() => !sending(machineHome).includes("ltr_fromlab1.json"));
});

test("this Mac's group chats' mail reaches the machine's, and what mustn't be lost is said to be there", { timeout: 60_000 }, async t => {
  signal = t.signal;
  // The bridge is told who your other computers are: the machine, taking chats' turns.
  await arrived(() => macBridge.seen.peers.some(peers => peers.boxes?.some(box => box.key === lab.key && box.seats)));
  // Followed by this Mac's box: what it sends now goes.
  await arrived(() => macBridge.seen.streams.size > 0);
  macBridge.give({ id: "seat_turn1", to: lab.key, mail: { kind: "turn", chat: "grp_1", text: "Your turn." }, durable: true });
  const taken = await arrived(() => labBridge.seen.mail.find(each => each.mail.chat === "grp_1"));
  assert.deepEqual(taken, { from: mac, mail: { kind: "turn", chat: "grp_1", text: "Your turn." } });
  // The link has it to deliver (the bridge hears so), and once the machine says it's there, it's
  // no longer on its way.
  await arrived(() => macBridge.seen.sent.includes("seat_turn1"));
  await eventually(() => !sending(macHome).includes("seat_turn1.json"));
});

test("letters an earlier Kuvo Code had on their way go on from this Mac's box, and those it delivered aren't delivered twice", { timeout: 60_000 }, async t => {
  signal = t.signal;
  const at = Date.now();
  const taken = await ask("POST", "kuvo/link/letters/take", {
    letters: [{ id: "mac0123456789", from: "ses_mac1", to: "ses_lab1", text: "From the app, before.", peer: lab.key, at }],
    seen: { ltr_delivered1: at },
  });
  assert.equal(taken.status, 200);
  await arrived(() => labEngine.seen.prompts.some(each => each.text.includes("From the app, before.")));
  // One the app had delivered, sent again by the machine (its word that it was there got lost):
  // said to be there, not delivered again.
  const before = macEngine.seen.prompts.length;
  write(run("outbox/sending/ltr_delivered1.json"), { from: "ses_lab1", to: "ses_mac1", text: "Twice?", wait: false, at });
  await eventually(() => !sending(machineHome).includes("ltr_delivered1.json"));
  assert.equal(macEngine.seen.prompts.length, before);
});

test("a letter for this Mac's conversation while it moves to another computer isn't delivered: it comes again", { timeout: 60_000 }, async t => {
  signal = t.signal;
  // Moving to another computer, as this Mac's box notes its moves (`kuvo/moves`).
  const record = path.join(macHome, "run", "moves", "mov_letter1.json");
  fs.mkdirSync(path.dirname(record), { recursive: true });
  write(record, { id: "mov_letter1", kind: "chat", thing: "ses_mac1", name: "Release notes", from: mac, to: lab.key, role: "from", stage: "switching",
    step: "switch", sentAt: Date.now() + 3_600_000, switchSince: Date.now(), sessions: ["ses_mac1"], peer: lab.key, wasPaused: true, tries: 0, started: Date.now() });
  t.after(() => fs.rmSync(record, { force: true }));
  write(run("outbox/sending/ltr_moving1.json"), { from: "ses_lab1", to: "ses_mac1", text: "Are you there yet?", wait: false, at: Date.now() });
  // Said not now: still the machine's to send again, and nothing reached the conversation.
  await eventually(() => read(run("outbox/sending/ltr_moving1.json"))?.sentTo === mac);
  assert.ok(!macEngine.seen.prompts.some(each => each.text.includes("Are you there yet?")));
});

test("this Mac in use reaches the machine, with what of its own this Mac's notifications showed", { timeout: 60_000 }, async t => {
  signal = t.signal;
  const labKey = Buffer.from(read(run("link.json")).key, "base64url");
  const before = relay.delivered.length;
  assert.equal((await ask("POST", "kuvo/attention", { for: 30, sessions: ["ses_mac1", "ses_lab1"], shown: [{ session: "ses_mac1", ask: false }],
    elsewhere: { lab: [{ session: "ses_lab1", ask: true, request: "per_1" }], "gone.invalid": [{ session: "ses_x", ask: false }] } })).status, 200);
  // What the machine got from this Mac, opened as the machine opens it.
  const said = await arrived(() => relay.delivered.slice(before).map(each => {
    if (!each.to.equals(Buffer.from(lab.address, "base64url"))) return null;
    try { return JSON.parse(link.openOneWay(link.readFrame(each.payload).body, labKey, link.publicOf(macKey)).payload.toString()); } catch { return null; }
  }).find(payload => payload?.attention));
  assert.deepEqual(said.attention, { for: 30, sessions: ["ses_mac1", "ses_lab1"], shown: [{ session: "ses_lab1", ask: true, request: "per_1" }] });
});

test("a letter left while this Mac's box is off the relay says so at once, and goes once it's back", { timeout: 60_000 }, async t => {
  signal = t.signal;
  link.stopMacLink();
  await arrived(() => !relay.has(macAddress));
  const left = await ask("POST", "kuvo/agent-tools", { name: "send_message", arguments: { to: "ses_lab1", text: "Sent while away.", wait: true }, session: "ses_mac1" });
  assert.equal(left.status, 200);
  assert.deepEqual(left.json, { text: "Your other computers can't be reached through the relay now: it goes once this Mac's back on it, and its answer comes to you as a message.", isError: false });
  link.runMacLink();
  await arrived(() => labEngine.seen.prompts.find(each => each.text.includes("Sent while away.")));
});

test("the coding agents' bridge going and coming back: this Mac's box follows its group chats' mail again", { timeout: 60_000 }, async t => {
  signal = t.signal;
  await arrived(() => macBridge.seen.streams.size > 0);
  const told = macBridge.seen.peers.length;
  // The bridge restarting: its stream ends.
  for (const stream of macBridge.seen.streams) stream.end();
  // Followed again, and told who your other computers are again.
  await arrived(() => macBridge.seen.streams.size > 0 && macBridge.seen.peers.length > told);
  macBridge.give({ id: "seat_again1", to: lab.key, mail: { kind: "turn", chat: "grp_2", text: "Still there?" }, durable: true });
  await arrived(() => labBridge.seen.mail.find(each => each.mail.chat === "grp_2"));
});

// An agent's tool call as a machine's tools ask its box: a process of its own (`box route`).
function machineTool(name, args, session) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "box", "route"], { env: { PATH: process.env.PATH, HOME: support, KUVO_HOME: machineHome, TMPDIR: machineHome }, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("error", reject);
    child.on("close", () => resolve(JSON.parse(JSON.parse(out.trim().split("\n").pop()).body)));
    child.stdin.end(JSON.stringify({ method: "POST", path: "kuvo/agent-tools", body: { name, arguments: args, session } }));
  });
}

test("a Mac conversation writes to the machine's agent by its name, and gets its answer", { timeout: 60_000 }, async t => {
  signal = t.signal;
  labEngine.seen.answers.set("ses_lab1", "Deployed at noon.");
  const said = (await ask("POST", "kuvo/agent-tools", { name: "send_message", arguments: { to: "&api work", text: "When did it go out?", wait: true }, session: "ses_mac1" })).json;
  assert.deepEqual(said, { text: "API work answered:\n\nDeployed at noon.", isError: false });
  const prompt = labEngine.seen.prompts.findLast(each => each.session === "ses_lab1");
  assert.match(prompt.text, /^\[Message from Release notes · ses_mac1\] \(They're waiting for your reply: just answer, in your words\.\)\n\nWhen did it go out\?$/);
  const listed = (await ask("POST", "kuvo/agent-tools", { name: "list_agents", arguments: {}, session: "ses_mac1" })).json;
  assert.match(listed.text, /- API work \(session, on lab, in work\) address: ses_lab1/);
});

test("a Mac conversation reads the machine's agent's conversation, which comes by mail", { timeout: 60_000 }, async t => {
  signal = t.signal;
  const prompted = labEngine.seen.prompts.length;
  const said = (await ask("POST", "kuvo/agent-tools", { name: "read_conversation", arguments: { of: "API work" }, session: "ses_mac1" })).json;
  assert.equal(said.isError, false, said.text);
  assert.match(said.text, /^API work's conversation \(session, on lab, in work, address ses_lab1\), oldest first\./);
  assert.match(said.text, /\n\n# API work\n\n\*\*API work\*\*\n\nDeployed at noon\.\n$/);
  assert.equal(labEngine.seen.prompts.length, prompted, "reading it says nothing to it");
});

test("a machine's conversation writes to a Mac's agent with its tool, and gets its answer; one that can't share its conversations yet says so", { timeout: 60_000 }, async t => {
  signal = t.signal;
  macEngine.seen.answers.set("ses_mac1", "Notes are done.");
  const said = await machineTool("send_message", { to: "Release notes", text: "Are the notes ready?", wait: true }, "ses_lab1");
  assert.deepEqual(said, { text: "Release notes answered:\n\nNotes are done.", isError: false });
  const prompt = macEngine.seen.prompts.findLast(each => each.session === "ses_mac1");
  assert.match(prompt.text, /^\[Message from API work · ses_lab1\] \(They're waiting for your reply/);
  // As if this Mac ran an older Kuvo Code, which didn't say it shares them.
  const told = read(run("peer-agents.json"));
  told[mac].features = told[mac].features.filter(feature => feature !== "letters-read");
  fs.writeFileSync(run("peer-agents.json"), JSON.stringify(told));
  const refused = await machineTool("read_conversation", { of: "Release notes" }, "ses_lab1");
  assert.deepEqual(refused, { text: "Release notes's computer doesn't share its conversations yet (it runs an older Kuvo Code). Ask it what you need with send_message.", isError: true });
});

// The machine's link, stopped, as a machine is when it's asleep; started again, it's back on the relay.
async function stopMachineLink() {
  const pid = Number(fs.readFileSync(run("link.pid"), "utf8"));
  process.kill(pid, "SIGTERM");
  await arrived(() => !relay.has(Buffer.from(lab.address, "base64url")));
}
async function startMachineLink() {
  spawn(process.execPath, [script, "run"], { detached: true, stdio: "ignore", env: { PATH: process.env.PATH, HOME: support, KUVO_HOME: machineHome } }).unref();
  await arrived(() => relay.has(Buffer.from(lab.address, "base64url")));
}
const NOTE = { from: "Its sessions", words: "It finished.", line: "“Sign-in” finished", delivery: "queue" };
const THREE_DAYS = 3 * 86_400_000;

test("news kept three days for a lead on the machine, whose link is stopped, arrives once it's started, once", { timeout: 60_000 }, async t => {
  signal = t.signal;
  await stopMachineLink();
  fs.mkdirSync(path.join(macHome, "run", "outbox", "sending"), { recursive: true });
  write(path.join(macHome, "run", "outbox", "sending", "ltr_newsformachine.json"), { from: null, to: "ses_lab1", text: "[Session finished] from the Mac", peer: lab.key, wait: false, at: Date.now() - THREE_DAYS, note: NOTE });
  // A try goes nowhere while it's stopped: it stays.
  await link.macSendOutbox();
  assert.ok(sending(macHome).includes("ltr_newsformachine.json"));
  await startMachineLink();
  // (A try comes each minute: here, a minute on.)
  await link.sendOutbox(link.macLink.host, undefined, Date.now() + 61_000, 0);
  await arrived(() => labEngine.seen.prompts.find(each => each.text === "[Session finished] from the Mac"));
  await eventually(() => !sending(macHome).includes("ltr_newsformachine.json"));
  assert.equal(labEngine.seen.prompts.filter(each => each.text === "[Session finished] from the Mac").length, 1);
});

test("news kept three days for a lead on this Mac by a machine whose link was stopped arrives as it's started, once", { timeout: 60_000 }, async t => {
  signal = t.signal;
  await stopMachineLink();
  fs.mkdirSync(run("outbox/sending"), { recursive: true });
  write(run("outbox/sending/ltr_newsformac0.json"), { from: null, to: "ses_mac1", text: "[Session finished] from the machine", peer: mac, wait: false, at: Date.now() - THREE_DAYS, note: NOTE });
  await startMachineLink();
  await arrived(() => macEngine.seen.prompts.find(each => each.text === "[Session finished] from the machine"));
  await eventually(() => !sending(machineHome).includes("ltr_newsformac0.json"));
  assert.equal(macEngine.seen.prompts.filter(each => each.text === "[Session finished] from the machine").length, 1);
});

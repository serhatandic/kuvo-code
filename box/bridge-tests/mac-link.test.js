// This Mac's box holds the relay connection a machine's bridge holds (PROTOCOL.md, "This Mac's box:
// the relay"): with its keys from its app, in memory only; your phones paired and answered there,
// what's the app's passed to the app, and the app's notices pushed on its connection. (Your
// machines' mail is the box's own: mac-peers and two-boxes.) Only the relay and the app are
// stand-ins.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/mac-link.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { relayStandIn } from "./relay-stand-in.js";
import { atEnd, removeAtEnd } from "./at-end.js";

const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-mac-link-")));
removeAtEnd(support);

// Each time a stand-in (the app, the relay) records something: what a test waits on looks again.
const waitingForChange = [];
const changed = () => new Promise(resolve => waitingForChange.push(resolve));
const poke = () => { for (const resolve of waitingForChange.splice(0)) resolve(); };

// The app, as its host interface answers this Mac's box: its keys (your Keychain), and the Mac's
// own routes.
const app = { keys: null, hellos: 0, away: false, turnedAway: 0, asked: [], streams: new Set() };
const appHost = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => {
    if (app.away) {
      app.turnedAway += 1;
      poke();
      return request.socket.destroy();
    }
    const given = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    // That it's this Mac's app: the box's nonce and where it reached it, signed with the password.
    if (request.url === "/hello") {
      app.hellos += 1;
      const proof = crypto.createHmac("sha256", "host-password").update(`kuvo-host-hello\u0000${given.nonce}\u0000127.0.0.1:${appHost.address().port}`).digest("hex");
      return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ proof }));
    }
    if (request.headers.authorization !== "Bearer host-password") return response.writeHead(401).end();
    if (request.url === "/link/identity") {
      if (!app.keys) return response.writeHead(503).end("{}");
      return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(app.keys));
    }
    if (request.url === "/link/route") {
      app.asked.push(given);
      if (given.path === "kuvo/asks/events") {
        // Followed: a line now, then open until the app goes.
        response.writeHead(200, { "content-type": "application/x-ndjson", "x-kuvo-answer": "1" });
        response.write(JSON.stringify({ asks: ["lab"] }) + "\n");
        app.streams.add(response);
        return;
      }
      // A real answer says so, whatever its status (a session that's gone is a real 404).
      if (given.path === "kuvo/mac/gone") return response.writeHead(404, { "content-type": "application/json", "x-kuvo-answer": "1" }).end(JSON.stringify({ message: "Gone." }));
      if (given.path === "kuvo/mac/cut") {
        // An answer cut off halfway (the app quit as it answered).
        response.writeHead(200, { "content-type": "application/json", "x-kuvo-answer": "1" });
        response.write('{"half":');
        return setTimeout(() => request.socket.destroy(), 20);
      }
      return response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "x-kuvo-answer": "1" }).end(JSON.stringify({ answered: "app", path: given.path, phone: given.phone }));
    }
    response.writeHead(404).end();
  });
});
await new Promise(resolve => appHost.listen(0, "127.0.0.1", resolve));
atEnd(() => appHost.close());

Object.assign(process.env, {
  KUVO_HOME: path.join(support, "box"),
  KUVO_BOTS: path.join(support, "bots"),
  KUVO_WAKES: path.join(support, "wakes"),
  KUVO_BOX: "mac",
  KUVO_ENGINE_CONFIG: path.join(support, "opencode"),
  KUVO_KEYS: path.join(support, "keys"),
  KUVO_HOST_URL: `http://127.0.0.1:${appHost.address().port}`,
  KUVO_HOST_PASSWORD: "host-password",
});
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

const relay = await relayStandIn(link, { changed: poke });
atEnd(() => relay.close());

// This Mac's keys, as your Keychain keeps them.
const macKey = link.newKey();
const macSecret = crypto.randomBytes(32);
const macAddress = link.addressOf(macSecret);
const keys = { key: macKey.toString("base64url"), secret: macSecret.toString("base64url"), sign: link.newSigningSeed() };

// The app's own request to its box, as `serve` takes it, with this Mac's notices held there.
link.macLink.hold = link.macNoticeHold();
const handle = link.engineHandler(link.readEngineFile, { name: "Mac" }, link.readBridgeFile, () => {}, link.macLink.hold);
async function ask(method, p, body, { fromApp = true } = {}) {
  const parts = [];
  for await (const part of handle({ method, path: p, headers: {}, body: body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0), fromApp }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  let json;
  try { json = JSON.parse(text); } catch {}
  return { status: parts[0].head.status, json };
}

// The link's state, once it's `state` (or one of them; followed, as the app follows it).
async function untilStatus(state) {
  const wanted = [state].flat();
  const stop = new AbortController();
  try {
    for await (const part of handle({ method: "GET", path: "kuvo/link/status/events", headers: {}, body: Buffer.alloc(0), fromApp: true }, {}, stop.signal)) {
      if (!part.body) continue;
      for (const line of part.body.toString().split("\n").filter(Boolean)) {
        const status = JSON.parse(line);
        if (wanted.includes(status.state)) return status;
      }
    }
  } finally {
    stop.abort();
  }
  throw new Error(`the link never got ${state}: ${JSON.stringify(link.macLink.status)}`);
}

// What another process gets (the relay, the app) once it's there: looked at again each time one
// of them records something.
async function arrived(found) {
  for (;;) {
    const value = found();
    if (value) return value;
    await changed();
  }
}

const config = (change = {}) => ask("PUT", "kuvo/link/config", { phones: true, machines: false, relay: relay.url, name: "Studio Mac", app: "0.9.0", ...change });

// A phone on the relay, opening sessions with this Mac and asking it things.
function phone() {
  const key = link.newKey();
  const device = relay.device();
  let session = crypto.randomInt(1, 2 ** 31);
  let transport = null;
  const frames = async () => {
    const message = link.readRelay(await device.next());
    if (message?.kind !== "deliver") return { kind: "unreachable" };
    return link.readFrame(message.payload);
  };
  return {
    key,
    device,
    public: link.publicOf(key).toString("base64url"),
    async open(hello = {}) {
      session += 1;
      const initiator = new link.IKInitiator(key, link.publicOf(macKey), link.PROLOGUE);
      device.send(macAddress, link.frame(link.Frame.handshake1, session, initiator.writeMessage1(Buffer.from(JSON.stringify({ v: 1, name: "Test iPhone", app: "0", ...hello })))));
      const answer = await frames();
      if (answer.kind !== link.Frame.handshake2) return { refused: true };
      const opened = initiator.readMessage2(answer.body);
      transport = opened.transport;
      return JSON.parse(opened.payload);
    },
    send(method, p, id = crypto.randomInt(1, 2 ** 20), body) {
      const h = body === undefined ? {} : { "content-type": "application/json" };
      const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
      for (const piece of link.pieces({ t: "req", id, m: method, p, h }, bytes, true)) device.send(macAddress, link.frame(link.Frame.transport, session, transport.seal(piece)));
    },
    async request(method, p, body) {
      this.send(method, p, undefined, body);
      const pieces = [];
      while (true) {
        const next = await frames();
        if (next.kind !== link.Frame.transport) return { closed: true, pieces };
        const message = link.decodeMessage(transport.open(next.body));
        pieces.push(message);
        if (message.head.end === true) break;
      }
      return { status: pieces[0].head.s, body: Buffer.concat(pieces.map(piece => piece.body)).toString(), pieces };
    },
    // What comes next on its session, piece by piece (a stream).
    async piece() {
      const next = await frames();
      if (next.kind !== link.Frame.transport) return null;
      return link.decodeMessage(transport.open(next.body));
    },
  };
}

// The link on, its keys given by the app.
async function ready(change = {}) {
  app.keys = keys;
  assert.notEqual((await config(change)).json.state, "failed");
}

// Paired through Settings › Phone's link: its token, once the Mac's on the relay.
async function paired() {
  await ready();
  const pairing = await ask("POST", "kuvo/phones/pair");
  assert.equal(pairing.status, 200);
  await untilStatus("connected");
  const token = new URL(pairing.json.link).searchParams.get("token");
  const it = phone();
  const hello = await it.open({ pair: token });
  return { it, hello };
}

before(() => { link.runMacLink(); });
atEnd(() => link.stopMacLink());

test("the link waits for its app, and without your Keychain's keys stays off and says so, making none of its own", async () => {
  assert.equal(link.macLink.status.state, "off");
  // On, but the app can't give its keys.
  assert.equal((await config()).status, 200);
  const failed = await untilStatus("failed");
  assert.match(failed.reason, /Keychain/);
  assert.equal((await ask("POST", "kuvo/phones/pair")).status, 409, "no pairing link without the link's keys");
  assert.equal(fs.existsSync(link.LINK_FILE), false, "no keys of its own written");

  // Whatever answers where the app said it was (its host.json, left by an app that crashed) gets
  // nothing but the proof it can't give: never asked for this Mac's keys.
  const impostorCalls = [];
  const impostor = http.createServer((request, response) => {
    impostorCalls.push(request.url);
    request.resume();
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ proof: "0".repeat(64), key: "x" }));
  });
  await new Promise(resolve => impostor.listen(0, "127.0.0.1", resolve));
  const hostFile = path.join(process.env.KUVO_HOME, "run", "host.json");
  fs.writeFileSync(hostFile, JSON.stringify({ url: `http://127.0.0.1:${impostor.address().port}`, password: "host-password" }));
  try {
    // Its keys are asked for before the config's answered.
    assert.equal((await config()).status, 200);
    assert.equal(link.macLink.overlay, null, "no keys taken");
    assert.ok(impostorCalls.length > 0 && impostorCalls.every(url => url === "/hello"), JSON.stringify(impostorCalls));
  } finally {
    fs.rmSync(hostFile, { force: true });
    impostor.close();
  }
});

test("a phone pairs with Settings › Phone's link, and the Mac's box answers it: its own areas itself, the Mac's own routes through the app", async () => {
  const { it, hello } = await paired();
  assert.equal(hello.kind, "mac");
  assert.equal(hello.name, "Studio Mac");
  assert.equal(hello.app, "0.9.0");
  // The box's own area: answered here.
  const personalities = await it.request("GET", "kuvo/personalities");
  assert.equal(personalities.status, 200);
  assert.deepEqual(JSON.parse(personalities.body), { personalities: [] });
  // As every box answers them: a file named in a reply, a sign-in that returns here, this Mac's
  // sign-ins, a command stopped. Here, not the app's (which answers whatever it's handed).
  const asked = app.asked.length;
  assert.equal((await it.request("GET", "kuvo/file?uri=https%3A%2F%2Fexample.com%2Fa.png")).status, 400);
  assert.equal((await it.request("GET", "kuvo/sign-in/return")).status, 405);
  assert.equal((await it.request("GET", "kuvo/accounts/credentials")).status, 503, "no engine here to list them");
  assert.equal((await it.request("POST", "kuvo/shell/sh_1/stop")).status, 503, "no engine here to stop it in");
  // Search, and a project's Changes, as the app sends them here itself.
  await it.request("GET", "kuvo/search?q=readme");
  await it.request("GET", `kuvo/git/status?directory=${encodeURIComponent(support)}`);
  // And the engine's API and the coding agents', which it passes on itself (none run in this test).
  assert.equal((await it.request("GET", "api/session")).status, 503);
  assert.equal((await it.request("GET", "kuvo/agents/api/session")).status, 503);
  // Who "&" can name, and its group chats (whose bridge isn't running in this test).
  assert.equal((await it.request("GET", "kuvo/named")).status, 200);
  const groups = await it.request("GET", "kuvo/groups");
  assert.deepEqual([groups.status, JSON.parse(groups.body).message], [503, "Group chats on this Mac are starting. Try again in a moment."]);
  // What it hears of a bridge that's down isn't that it's starting: why, on each route that needs it,
  // and what starts it, when nothing's trying.
  const run = path.join(support, "box", "run");
  const agentsStopped = path.join(run, "agents-stopped");
  const heard = async () => {
    const answers = [];
    for (const route of ["kuvo/groups", "kuvo/artifacts", "kuvo/agents/api/session"]) {
      const answer = await it.request("GET", route);
      answers.push([answer.status, JSON.parse(answer.body).message]);
    }
    return answers;
  };
  fs.writeFileSync(agentsStopped, JSON.stringify({ why: "It can't be run.", retrying: false }));
  for (const each of await heard()) assert.deepEqual(each, [503, "This Mac's coding agents aren't running. It can't be run. Restart them in Kuvo Code on the Mac."]);
  fs.writeFileSync(agentsStopped, JSON.stringify({ why: "It stopped (exit code 3). Trying again by itself.", retrying: true }));
  for (const each of await heard()) assert.deepEqual(each, [503, "This Mac's coding agents aren't running. It stopped (exit code 3). Trying again by itself."]);
  fs.rmSync(agentsStopped);
  assert.equal(app.asked.length, asked, "none went to the app");
  // The Mac's own: the app's, with which phone asked.
  const asks = await it.request("GET", "kuvo/asks");
  assert.deepEqual(JSON.parse(asks.body), { answered: "app", path: "kuvo/asks", phone: it.public });
  // Kept where a machine keeps its phones, readable by you alone, with no key in it.
  const kept = JSON.parse(fs.readFileSync(link.LINK_FILE, "utf8"));
  assert.deepEqual(kept.phones.map(each => each.key), [it.public]);
  assert.equal(kept.phones[0].address, it.device.address.toString("base64url"));
  for (const name of ["key", "secret", "sign", "relay", "name"]) assert.equal(kept[name], undefined, `${name} isn't written`);
  assert.equal((fs.statSync(link.LINK_FILE).mode & 0o777).toString(8), "600");
  // The app follows its phones.
  const listed = await ask("GET", "kuvo/link/phones");
  assert.deepEqual(listed.json.phones.map(each => each.key), [it.public]);
});

test("one list says what the app answers: the app answers those alone and hands its box the rest, and the box answers everything else a phone asks", () => {
  const swift = fs.readFileSync(new URL("../../../../KuvoCode/Stores/PhoneLink.swift", import.meta.url), "utf8");
  // The app's own areas, as it keeps them, are the box's list.
  const appRoutes = swift.match(/static let appRoutes = \[([^\]]*)\]/)[1].match(/"[^"]+"/g).map(JSON.parse);
  assert.deepEqual([...appRoutes].sort(), [...link.MAC_APP_ROUTES].sort());
  // Every route the app answers itself (in what it answers a phone's request with) is on it: a
  // route of the app's own that the box doesn't hand it would never reach it.
  const code = (from, to) => swift.slice(swift.indexOf(from), swift.indexOf(to, swift.indexOf(from))).split("\n").filter(line => !line.trim().startsWith("//")).join("\n");
  const answered = [...code("static func respond(to request: LinkRequest", "// MARK: This Mac's box's link").matchAll(/"(kuvo\/[^"\\]+)"/g),
    ...code("private func answer(_ request: LinkRequest)", "static func message(").matchAll(/"(kuvo\/[^"\\]+)"/g)].map(match => match[1]);
  assert.ok(answered.length >= 10, JSON.stringify(answered));
  assert.deepEqual(answered.filter(route => !link.macAppAnswers(route.endsWith("/") ? `${route}x` : route)), []);
  // And nothing more: everything else is the box's, the link's own and a session's among them.
  for (const route of ["kuvo/info", "kuvo/link/config", "kuvo/projects", "kuvo/sessions/ses_1/agents", "kuvo/sessions/ses_1/autopilot", "kuvo/personalities", "kuvo/update", "kuvo/sessions/ses_1/branch", "kuvo/machinesx"]) {
    assert.equal(link.macAppAnswers(route), false, route);
  }
});

test("a phone moving a conversation to the coding agents, or reading its Autopilot, is answered by this Mac's box, whether the app answers or not", async () => {
  const { it } = await paired();
  const asked = app.asked.length;
  const codex = { model: { id: "gpt-5.5", providerID: "codex-cli" } };
  for (const away of [false, true]) {
    app.away = away;
    try {
      // (No engine runs in this test: the box says so, as a machine's does.)
      const moved = await it.request("POST", "kuvo/sessions/ses_older/agents", codex);
      assert.deepEqual([moved.status, JSON.parse(moved.body).message], [503, "The engine isn’t running."], away ? "the app away" : "the app there");
      const autopilot = await it.request("GET", "kuvo/sessions/ses_older/autopilot");
      assert.deepEqual([autopilot.status, JSON.parse(autopilot.body).message], [503, "The engine isn't running."]);
    } finally {
      app.away = false;
    }
  }
  assert.equal(app.asked.length, asked, "none went to the app");
});

test("a phone asking what this Mac is hears it from its box, the app away too: a Mac, its name and version, and the box's own list of what it answers", async () => {
  const { it } = await paired();
  const asked = app.asked.length;
  for (const away of [false, true]) {
    app.away = away;
    try {
      const info = await it.request("GET", "kuvo/info");
      assert.equal(info.status, 200, away ? "the app away" : "the app there");
      const said = JSON.parse(info.body);
      assert.deepEqual([said.kind, said.name, said.app, said.agents, said.started], ["mac", "Studio Mac", "0.9.0", false, null]);
      assert.equal(typeof said.engine, "string");
      assert.equal(typeof said.chats, "string");
      assert.equal(typeof said.integrations, "object");
      assert.equal(said.running, undefined, "a machine's alone");
      assert.deepEqual(said.features, link.macFeatures());
      for (const feature of ["machines", "hosts", "mac", "claude-code", "usage.history", "accounts.ended", "autopilot", "sessions.agents", "work.elsewhere"]) assert.ok(said.features.includes(feature), feature);
      for (const feature of ["update", "engine.start"]) assert.ok(!said.features.includes(feature), `${feature} is a machine's`);
      // A route no box has is the box's to say so, as a machine's does.
      const none = await it.request("GET", "kuvo/nothing-here");
      assert.deepEqual([none.status, JSON.parse(none.body)], [404, {}]);
    } finally {
      app.away = false;
    }
  }
  assert.equal(app.asked.length, asked, "none went to the app");
});

test("what the app last said of the link is kept, never its keys: the box takes it again as it starts, with whether there are machines from their list", async () => {
  await ready({ phones: false, machines: true, name: "Kept Mac" });
  assert.deepEqual(JSON.parse(fs.readFileSync(link.MAC_LINK_FILE, "utf8")), { phones: false, relay: relay.url, name: "Kept Mac", app: "0.9.0" });
  assert.equal((fs.statSync(link.MAC_LINK_FILE).mode & 0o777).toString(8), "600");
  // Whether there are machines, as their list says now: machines removed since don't bring it back.
  const list = path.join(process.env.KUVO_HOME, "machines.json");
  const machines = () => link.savedMacConfig().machines;
  try {
    assert.deepEqual(link.savedMacConfig(), { phones: false, machines: false, relay: relay.url, name: "Kept Mac", app: "0.9.0" }, "no list: none");
    fs.writeFileSync(list, JSON.stringify([{ destination: "lab" }]));
    assert.equal(machines(), true);
    fs.writeFileSync(list, "{ not json");
    assert.equal(machines(), true, "a list that won't read counts, as the app counts it");
    fs.writeFileSync(list, "[]");
    assert.equal(machines(), false, "the last one removed");
  } finally {
    fs.rmSync(list, { force: true });
  }
  // What isn't what it keeps is nothing.
  const other = path.join(support, "mac-link-other.json");
  for (const kept of ["{ not json", "{}", JSON.stringify({ phones: true, relay: "https://example.com" }), JSON.stringify({ phones: "yes", relay: relay.url })]) {
    fs.writeFileSync(other, kept);
    assert.equal(link.savedMacConfig(other), null, kept);
  }
  // An older app also says what it answers: taken, and left, as the box says that itself.
  assert.equal((await config({ machines: false, features: ["mac"] })).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(link.MAC_LINK_FILE, "utf8")), { phones: true, relay: relay.url, name: "Studio Mac", app: "0.9.0" }, "the latest word kept");
});

test("what this Mac's box says it answers holds what its peers check, and a peer keeps it whole", () => {
  const features = link.macFeatures();
  for (const checked of ["moves", "moves.agents", "moves.check", "letters-read", "groups.seats", "work.elsewhere"]) assert.ok(features.includes(checked), checked);
  assert.equal(new Set(features).size, features.length);
  assert.deepEqual(link.keptFeatures(features), features);
});

test("a phone asking for a pairing link leaves Settings › Phone's as it is: each lets in once", async () => {
  await ready();
  const shown = await ask("POST", "kuvo/phones/pair");
  const asked = await ask("POST", "kuvo/phones/pair", undefined, { fromApp: false });
  await untilStatus("connected");
  const token = response => new URL(response.json.link).searchParams.get("token");
  assert.notEqual(token(shown), token(asked));
  assert.equal((await phone().open({ pair: token(asked) })).kind, "mac");
  assert.equal((await phone().open({ pair: token(shown) })).kind, "mac");
  assert.deepEqual(await phone().open({ pair: token(shown) }), { refused: true }, "used up");
});

test("what the app doesn't answer is a 503 at once, and a stream from the app ends when the app goes", async () => {
  const { it } = await paired();
  // Followed through the app: its first line, then the end once the app's gone.
  it.send("GET", "kuvo/asks/events", 7);
  const first = await it.piece();
  assert.equal(first.head.s, 200);
  assert.deepEqual(JSON.parse(first.body.toString()), { asks: ["lab"] });
  for (const response of app.streams) response.end();
  app.streams.clear();
  let last = first;
  while (last.head.end !== true) last = await it.piece();
  assert.equal(last.head.id, 7, "the stream ended");
  app.away = true;
  try {
    const away = await it.request("GET", "kuvo/asks");
    assert.equal(away.status, 503);
    assert.match(JSON.parse(away.body).message, /isn't answering/);
  } finally {
    app.away = false;
  }
  // Back: it proves it's this Mac's app again before it's asked anything.
  const hellos = app.hellos;
  assert.equal((await it.request("GET", "kuvo/asks")).status, 200);
  assert.equal(app.hellos, hellos + 1, "proved again after it went");

  // Whatever answers where the app's host.json says (left by an app that crashed) gets a phone's
  // request no further than the proof it can't give: the phone hears this Mac isn't answering.
  const impostorCalls = [];
  const impostor = http.createServer((request, response) => {
    impostorCalls.push(request.url);
    request.resume();
    response.writeHead(200, { "content-type": "application/json", "x-kuvo-answer": "1" }).end(JSON.stringify({ proof: "0".repeat(64) }));
  });
  await new Promise(resolve => impostor.listen(0, "127.0.0.1", resolve));
  const hostFile = path.join(process.env.KUVO_HOME, "run", "host.json");
  fs.writeFileSync(hostFile, JSON.stringify({ url: `http://127.0.0.1:${impostor.address().port}`, password: "host-password" }));
  try {
    const refused = await it.request("GET", "kuvo/asks");
    assert.equal(refused.status, 503);
    assert.deepEqual([...new Set(impostorCalls)], ["/hello"]);
  } finally {
    fs.rmSync(hostFile, { force: true });
    impostor.close();
  }
  assert.equal((await it.request("GET", "kuvo/asks")).status, 200, "the app again, once the file's gone");
});

test("the app's own answer reaches the phone as it is, a 404 too; an answer cut off ends as cut off, not as whole", async () => {
  const { it } = await paired();
  const gone = await it.request("GET", "kuvo/mac/gone");
  assert.equal(gone.status, 404);
  assert.deepEqual(JSON.parse(gone.body), { message: "Gone." });
  const asks = await it.request("GET", "kuvo/asks");
  assert.equal(asks.pieces[0].head.h["cache-control"], "no-store");
  it.send("GET", "kuvo/mac/cut", 9);
  const pieces = [];
  for (let piece = await it.piece(); piece; piece = await it.piece()) {
    pieces.push(piece);
    if (piece.head.t === "cancel" || piece.head.end === true) break;
  }
  assert.equal(pieces.at(-1).head.t, "cancel", "the phone hears it was cut off");
});

test("the app's own notices go out on the box's connection", async () => {
  // A notice only the app knows (an ask from its panel's browser), sealed here for each phone
  // that's said where it is.
  const { it } = await paired();
  await it.request("GET", "kuvo/personalities");
  const before = relay.pushed.length;
  const told = await ask("POST", "kuvo/attention/notice", { notice: { title: "Ada", body: "Done.", category: "ask", thread: "ask_1", data: { ask: "ask_1" } } });
  assert.equal(told.status, 200);
  // On its way over the box's connection: there once the relay has it.
  const mine = await arrived(() => relay.pushed.slice(before).find(each => each.to.equals(it.device.address)));
  const opened = link.openOneWay(link.readFrame(mine.payload).body, it.key, link.publicOf(macKey));
  const notice = JSON.parse(opened.payload.toString());
  assert.equal(notice.title, "Ada");
  assert.equal(notice.body, "Done.");
  // A connection that's closing as it's sent takes nothing: the notice is held to try again.
  const real = link.macLink.host;
  link.macLink.host = { welcomed: true, send: () => false };
  try {
    await ask("POST", "kuvo/attention/notice", { notice: { title: "Ada", body: "Again.", category: "ask", thread: "ask_2", data: { ask: "ask_2" } } });
    assert.ok((await ask("GET", "kuvo/attention")).json.held >= 1, "held");
  } finally {
    link.macLink.host = real;
  }
  // Answered meanwhile: it never goes.
  await ask("POST", "kuvo/attention/answered", { id: "ask_2" });
  assert.equal((await ask("GET", "kuvo/attention")).json.held, 0);
  // Not for anyone but the app.
  assert.equal((await ask("POST", "kuvo/attention/notice", { notice: { title: "x" } }, { fromApp: false })).status, 403);
});

test("the app removes a phone as the Mac; the link's routes are the app's alone", async () => {
  const { it } = await paired();
  // A paired phone over the relay never reads or changes them.
  const before = fs.readFileSync(link.MAC_LINK_FILE, "utf8");
  for (const [method, p, body] of [["GET", "kuvo/link/status"], ["GET", "kuvo/link/phones"], ["GET", "kuvo/link/config"], ["PUT", "kuvo/link/config", { phones: false, machines: false, relay: "https://example.com" }]]) {
    assert.equal((await it.request(method, p, body)).status, 403, `${method} ${p}`);
  }
  assert.equal(fs.readFileSync(link.MAC_LINK_FILE, "utf8"), before, "what's kept is as it was");
  assert.equal((await ask("GET", "kuvo/link/status")).json.state, "connected");
  assert.ok((await ask("GET", "kuvo/link/phones")).json.phones.some(each => each.key === it.public));
  assert.equal((await ask("POST", "kuvo/phones/remove", { phones: [{ key: it.public }] })).status, 200);
  assert.ok(!(await ask("GET", "kuvo/link/phones")).json.phones.some(each => each.key === it.public));
  for (const p of ["kuvo/link/status", "kuvo/link/phones", "kuvo/link/config"]) assert.equal((await ask("GET", p, undefined, { fromApp: false })).status, 403, p);
  assert.equal((await ask("PUT", "kuvo/link/config", { phones: true, machines: false, relay: "https://example.com" })).status, 400);
});

test("with the phone link off, phones are let go and refused, and no pairing link is made", async () => {
  const { it } = await paired();
  await config({ phones: false, machines: true });
  assert.equal((await ask("POST", "kuvo/phones/pair")).status, 409);
  assert.deepEqual(await it.open({}), { refused: true });
  await config({ phones: true, machines: false });
});

test("a link no longer wanted leaves the relay, and says it's off", async () => {
  app.keys = keys;
  // Nothing paired: it's up for your machines alone.
  link.updateLink(current => ({ ...(current ?? {}), phones: [], removed: current?.removed ?? [] }));
  await config({ machines: true });
  await untilStatus("connected");
  assert.ok(relay.has(macAddress));
  await config({ machines: false });
  await untilStatus("off");
  await arrived(() => !relay.has(macAddress));
});

test("whatever the relay sends, and a relay that goes, the box's own routes go on answering", async () => {
  app.keys = keys;
  await config({ machines: true });
  await untilStatus("connected");
  const stranger = relay.device();
  stranger.send(macAddress, crypto.randomBytes(40));
  stranger.send(macAddress, link.frame(link.Frame.transport, 9, crypto.randomBytes(30)));
  assert.equal((await ask("GET", "kuvo/personalities")).status, 200);
  relay.drop();
  await untilStatus("connecting");
  assert.equal((await ask("GET", "kuvo/personalities")).status, 200);
  await untilStatus("connected");
  await config({ relay: "ws://127.0.0.1:9", machines: true });
  const failed = await untilStatus("failed");
  assert.match(failed.reason, /127\.0\.0\.1:9/);
  assert.equal((await ask("GET", "kuvo/personalities")).status, 200);
  await config({ machines: false });
});

test("a phone removes itself through this Mac's box: it's off the Mac's phones, and the app hears so", async () => {
  const { it } = await paired();
  const removed = await it.request("POST", "kuvo/phones/remove", { phones: [{ key: it.public }] });
  assert.equal(removed.status, 200);
  const listed = await ask("GET", "kuvo/link/phones");
  assert.ok(!listed.json.phones.some(each => each.key === it.public), "off the Mac's phones");
  assert.ok(listed.json.removed.some(each => each.key === it.public), "kept removed");
  await config({ machines: false });
});

test("closing Settings › Phone's pairing link by its token ends that one alone: a newer one stays", async () => {
  await ready();
  const token = made => new URL(made.json.link).searchParams.get("token");
  const first = await ask("POST", "kuvo/phones/pair");
  const second = await ask("POST", "kuvo/phones/pair");
  assert.notEqual(token(first), token(second));
  // The first, closed late: the second stays.
  assert.equal((await ask("DELETE", `kuvo/phones/pair?token=${token(first)}`)).status, 200);
  assert.equal((await ask("GET", "kuvo/link/phones")).json.pairing, true);
  assert.equal((await ask("DELETE", `kuvo/phones/pair?token=${token(second)}`)).status, 200);
  assert.equal((await ask("GET", "kuvo/link/phones")).json.pairing, false);
  await config({ machines: false });
});

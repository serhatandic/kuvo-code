// This Mac's box holds the relay connection a machine's bridge holds (PROTOCOL.md, "This Mac's box:
// the relay"): with its keys from its app, in memory only; your phones paired and answered there,
// what's the app's passed to the app; mail from your machines handed to the app, and the app's mail
// and pushes sent on its connection. Only the relay and the app are stand-ins.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/mac-link.test.js`.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { relayStandIn } from "./relay-stand-in.js";

const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-mac-link-")));
after(() => fs.rmSync(support, { recursive: true, force: true }));

// The app, as its host interface answers this Mac's box: its keys (your Keychain), the Mac's own
// routes, and mail from your machines.
const app = { keys: null, away: false, turnedAway: 0, mailed: [], asked: [], streams: new Set() };
const appHost = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => {
    if (request.headers.authorization !== "Bearer host-password") return response.writeHead(401).end();
    if (app.away) {
      app.turnedAway += 1;
      return request.socket.destroy();
    }
    const given = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (request.url === "/link/identity") {
      if (!app.keys) return response.writeHead(503).end("{}");
      return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(app.keys));
    }
    if (request.url === "/link/mailed") {
      app.mailed.push(given);
      return response.writeHead(200, { "content-type": "application/json" }).end("{}");
    }
    if (request.url === "/link/route") {
      app.asked.push(given);
      if (given.path === "kuvo/machines/events") {
        // Followed: a line now, then open until the app goes.
        response.writeHead(200, { "content-type": "application/x-ndjson", "x-kuvo-answer": "1" });
        response.write(JSON.stringify({ machines: ["lab"] }) + "\n");
        app.streams.add(response);
        return;
      }
      // A real answer says so, whatever its status (a session that's gone is a real 404).
      if (given.path === "kuvo/gone") return response.writeHead(404, { "content-type": "application/json", "x-kuvo-answer": "1" }).end(JSON.stringify({ message: "Gone." }));
      if (given.path === "kuvo/cut") {
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
after(() => appHost.close());

Object.assign(process.env, {
  KUVO_HOME: path.join(support, "box"),
  KUVO_BOTS: path.join(support, "bots"),
  KUVO_WAKES: path.join(support, "wakes"),
  KUVO_ENGINE_CONFIG: path.join(support, "opencode"),
  KUVO_KEYS: path.join(support, "keys"),
  KUVO_HOST_URL: `http://127.0.0.1:${appHost.address().port}`,
  KUVO_HOST_PASSWORD: "host-password",
});
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

const relay = await relayStandIn(link);
after(() => relay.close());

// This Mac's keys, as your Keychain keeps them.
const macKey = link.newKey();
const macSecret = crypto.randomBytes(32);
const macAddress = link.addressOf(macSecret);
const keys = { key: macKey.toString("base64url"), secret: macSecret.toString("base64url"), sign: link.newSigningSeed() };

// The app's own request to its box, as `serve` takes it.
const handle = link.engineHandler(link.readEngineFile, { name: "Mac" });
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
  const timer = setTimeout(() => stop.abort(), 10_000);
  try {
    for await (const part of handle({ method: "GET", path: "kuvo/link/status/events", headers: {}, body: Buffer.alloc(0), fromApp: true }, {}, stop.signal)) {
      if (!part.body) continue;
      for (const line of part.body.toString().split("\n").filter(Boolean)) {
        const status = JSON.parse(line);
        if (wanted.includes(status.state)) return status;
      }
    }
  } finally {
    clearTimeout(timer);
    stop.abort();
  }
  throw new Error(`the link never got ${state}: ${JSON.stringify(link.macLink.status)}`);
}

// What another process gets (the relay, the app) once it's there: looked for as it comes, for five
// seconds at most.
function arrived(found, why) {
  return new Promise((resolve, reject) => {
    const check = setInterval(() => {
      const value = found();
      if (value) {
        clearInterval(check);
        resolve(value);
      }
    }, 5);
    setTimeout(() => { clearInterval(check); reject(new Error(why)); }, 5000).unref();
  });
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
    send(method, p, id = crypto.randomInt(1, 2 ** 20)) {
      for (const piece of link.pieces({ t: "req", id, m: method, p, h: {} }, Buffer.alloc(0), true)) device.send(macAddress, link.frame(link.Frame.transport, session, transport.seal(piece)));
    },
    async request(method, p) {
      this.send(method, p);
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
after(() => link.stopMacLink());

test("the link waits for its app, and without your Keychain's keys stays off and says so, making none of its own", async () => {
  assert.equal(link.macLink.status.state, "off");
  // On, but the app can't give its keys.
  assert.equal((await config()).status, 200);
  const failed = await untilStatus("failed");
  assert.match(failed.reason, /Keychain/);
  assert.equal((await ask("POST", "kuvo/phones/pair")).status, 409, "no pairing link without the link's keys");
  assert.equal(fs.existsSync(link.LINK_FILE), false, "no keys of its own written");
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
  // The Mac's own: the app's, with which phone asked.
  const usage = await it.request("GET", "kuvo/usage");
  assert.deepEqual(JSON.parse(usage.body), { answered: "app", path: "kuvo/usage", phone: it.public });
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
  it.send("GET", "kuvo/machines/events", 7);
  const first = await it.piece();
  assert.equal(first.head.s, 200);
  assert.deepEqual(JSON.parse(first.body.toString()), { machines: ["lab"] });
  for (const response of app.streams) response.end();
  app.streams.clear();
  let last = first;
  while (last.head.end !== true) last = await it.piece();
  assert.equal(last.head.id, 7, "the stream ended");
  app.away = true;
  try {
    const away = await it.request("GET", "kuvo/usage");
    assert.equal(away.status, 503);
    assert.match(JSON.parse(away.body).message, /isn't answering/);
  } finally {
    app.away = false;
  }
});

test("the app's own answer reaches the phone as it is, a 404 too; an answer cut off ends as cut off, not as whole", async () => {
  const { it } = await paired();
  const gone = await it.request("GET", "kuvo/gone");
  assert.equal(gone.status, 404);
  assert.deepEqual(JSON.parse(gone.body), { message: "Gone." });
  const usage = await it.request("GET", "kuvo/usage");
  assert.equal(usage.pieces[0].head.h["cache-control"], "no-store");
  it.send("GET", "kuvo/cut", 9);
  const pieces = [];
  for (let piece = await it.piece(); piece; piece = await it.piece()) {
    pieces.push(piece);
    if (piece.head.t === "cancel" || piece.head.end === true) break;
  }
  assert.equal(pieces.at(-1).head.t, "cancel", "the phone hears it was cut off");
});

test("mail from your machines goes to the app; the app's mail and pushes go out on the box's connection", async () => {
  app.keys = keys;
  await config({ machines: true });
  await untilStatus("connected");
  const machine = relay.device();
  const sealed = link.frame(link.Frame.mail, 0, crypto.randomBytes(48));
  const mailedBefore = app.mailed.length;
  machine.send(macAddress, sealed);
  await arrived(() => app.mailed.length > mailedBefore, "the app got no mail");
  assert.deepEqual(app.mailed.at(-1), { from: machine.address.toString("base64url"), frame: sealed.toString("base64") });
  // The app's mail, sealed by the app: to the machine as it was.
  const going = link.frame(link.Frame.mail, 0, crypto.randomBytes(64));
  assert.equal((await ask("POST", "kuvo/link/send", { to: machine.address.toString("base64url"), frame: going.toString("base64") })).status, 200);
  const delivered = link.readRelay(await machine.next());
  assert.equal(delivered.kind, "deliver");
  assert.deepEqual(delivered.payload, going);
  assert.deepEqual(delivered.address, macAddress);
  assert.equal((await ask("POST", "kuvo/link/send", { to: machine.address.toString("base64url"), frame: Buffer.alloc(70_000).toString("base64") })).status, 413);
  // A notice, sealed here for each phone that's said where it is.
  const { it } = await paired();
  await it.request("GET", "kuvo/personalities");
  const before = relay.pushed.length;
  const pushedTo = await ask("POST", "kuvo/link/push", { notice: { title: "Ada", body: "Done." } });
  assert.equal(pushedTo.status, 200);
  // On its way over the box's connection: there once the relay has it.
  const mine = await arrived(() => relay.pushed.slice(before).find(each => each.to.equals(it.device.address)), "the relay got no push for the phone");
  const opened = link.openOneWay(link.readFrame(mine.payload).body, it.key, link.publicOf(macKey));
  assert.deepEqual(JSON.parse(opened.payload.toString()), { title: "Ada", body: "Done." });
  // A connection that's closing as it's asked takes nothing: none's said to have gone.
  const real = link.macLink.host;
  link.macLink.host = { welcomed: true, send: () => false };
  try {
    assert.equal((await ask("POST", "kuvo/link/push", { notice: { title: "Ada", body: "Again." } })).status, 503);
  } finally {
    link.macLink.host = real;
  }
  await config({ machines: false });
});

test("phones from before are taken, a removal winning; the app removes as the Mac; the link's routes are the app's alone", async () => {
  const a = link.publicOf(link.newKey()).toString("base64url");
  const b = link.publicOf(link.newKey()).toString("base64url");
  const taken = await ask("POST", "kuvo/link/phones/take", {
    phones: [{ key: a, name: "Old iPhone", added: 1_700_000_000, pairing: "p1" }, { key: b, name: "Lost iPhone", added: 1_700_000_000, pairing: "" }],
    removed: [{ key: b, pairing: "" }],
  });
  assert.equal(taken.status, 200);
  assert.ok(taken.json.phones.some(each => each.key === a && each.name === "Old iPhone" && each.pairing === "p1"));
  assert.ok(!taken.json.phones.some(each => each.key === b), "removed before: stays out");
  assert.equal((await ask("POST", "kuvo/phones/remove", { phones: [{ key: a, pairing: "p1" }] })).status, 200);
  assert.ok(!(await ask("GET", "kuvo/link/phones")).json.phones.some(each => each.key === a));
  // An older copy that still has it: it stays removed.
  await ask("POST", "kuvo/link/phones/take", { phones: [{ key: a, name: "Old iPhone", pairing: "p1" }], removed: [] });
  assert.ok(!(await ask("GET", "kuvo/link/phones")).json.phones.some(each => each.key === a));
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

test("mail the app couldn't take at once is handed over when it can, in the order it came", async () => {
  app.keys = keys;
  await config({ machines: true });
  await untilStatus("connected");
  const machine = relay.device();
  const first = link.frame(link.Frame.mail, 0, crypto.randomBytes(30));
  const second = link.frame(link.Frame.mail, 0, crypto.randomBytes(31));
  const before = app.mailed.length;
  app.away = true;
  const refused = app.turnedAway;
  machine.send(macAddress, first);
  machine.send(macAddress, second);
  await arrived(() => app.turnedAway > refused, "the app was never asked");
  app.away = false;
  await arrived(() => app.mailed.length >= before + 2, "the app never got the mail");
  assert.deepEqual(app.mailed.slice(before).map(each => each.frame), [first.toString("base64"), second.toString("base64")]);
  await config({ machines: false });
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
  await arrived(() => !relay.has(macAddress), "it's still on the relay");
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

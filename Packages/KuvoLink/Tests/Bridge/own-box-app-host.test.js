// A Mac's box in a home of its own, its app attached to it (#333 piece 6b; PROTOCOL.md, "This Mac's
// app"): its host is its helper, which holds its keys but can't answer what only the open app can (a
// phone's ask of the Mac's own routes). So the app, as it registers, says where its own host
// interface answers (`kuvo/box/app`'s `host`, from the app itself only), and a phone's ask goes there
// while it's open: proved to be the app each time, and nothing once it quits. The real box script, in
// a home of the test's own laid out as a Mac's; the helper, the app and the relay are stand-ins.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/own-box-app-host.test.js`.
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

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-own-box-app-host-")));
removeAtEnd(home);
const K = path.join(home, ".kuvo-code");
fs.mkdirSync(path.join(K, "box"), { recursive: true });
fs.mkdirSync(path.join(K, "run"), { recursive: true });
fs.writeFileSync(path.join(K, "box", "kind"), "mac\n");

const listen = async server => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  atEnd(() => { server.closeAllConnections(); server.close(); });
  return server.address().port;
};
const read = request => new Promise(resolve => {
  const chunks = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")));
});
const proof = (password, nonce, port) => crypto.createHmac("sha256", password).update(`kuvo-host-hello\u0000${nonce}\u0000127.0.0.1:${port}`).digest("hex");

// This Mac's keys, as its helper keeps them in your Keychain.
const helper = { asked: [], keys: null };
const HELPER_PASSWORD = crypto.randomBytes(16).toString("hex");
const helperHost = http.createServer(async (request, response) => {
  const given = await read(request);
  if (request.url === "/hello") return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ proof: proof(HELPER_PASSWORD, given.nonce, helperHost.address().port) }));
  if (request.headers.authorization !== `Bearer ${HELPER_PASSWORD}`) return response.writeHead(401).end();
  helper.asked.push(request.url);
  if (request.url === "/link/identity") return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(helper.keys));
  // What only the open app answers: the helper says it isn't open (BoxHelperHost).
  response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ message: "Kuvo Code isn’t open on this Mac." }));
});
const helperPort = await listen(helperHost);
fs.writeFileSync(path.join(K, "run", "host.json"), JSON.stringify({ url: `http://127.0.0.1:${helperPort}`, password: HELPER_PASSWORD }));

// The open app's own host interface: proves it's the app, and answers a phone's ask of the Mac's own routes.
const app = { hellos: 0, asked: [] };
const APP_PASSWORD = crypto.randomBytes(16).toString("hex");
const appHost = http.createServer(async (request, response) => {
  const given = await read(request);
  if (request.url === "/hello") {
    app.hellos += 1;
    return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ proof: proof(APP_PASSWORD, given.nonce, appHost.address().port) }));
  }
  if (request.headers.authorization !== `Bearer ${APP_PASSWORD}`) return response.writeHead(401).end();
  app.asked.push(given.path);
  response.writeHead(200, { "content-type": "application/json", "x-kuvo-answer": "1" }).end(JSON.stringify({ answered: "app", path: given.path }));
});
const appPort = await listen(appHost);
const registration = { tools: { url: "http://127.0.0.1:4567/mcp", token: "t".repeat(32) }, bundle: "/Applications/Kuvo Code.app", host: { url: `http://127.0.0.1:${appPort}`, password: APP_PASSWORD } };

Object.assign(process.env, { HOME: home, KUVO_HOME: K, TMPDIR: home });
delete process.env.KUVO_BOX;
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
const relay = await relayStandIn(link);
atEnd(() => relay.close());

const macKey = link.newKey();
const macSecret = crypto.randomBytes(32);
const macAddress = link.addressOf(macSecret);
helper.keys = { key: macKey.toString("base64url"), secret: macSecret.toString("base64url"), sign: link.newSigningSeed() };

// The app's own request to its box, as its server takes it (`x-kuvo-from: app`), or Kuvo Code's
// `box route` (`fromMac`).
const handle = link.engineHandler(link.readEngineFile, { name: "Mac" }, link.readBridgeFile);
async function ask(method, p, body, from = { fromApp: true }) {
  const parts = [];
  for await (const part of handle({ method, path: p, headers: {}, body: body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0), ...from }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  let json;
  try { json = JSON.parse(text); } catch {}
  return { status: parts[0].head.status, json };
}

async function untilConnected() {
  const stop = new AbortController();
  try {
    for await (const part of handle({ method: "GET", path: "kuvo/link/status/events", headers: {}, body: Buffer.alloc(0), fromApp: true }, {}, stop.signal)) {
      if (part.body && part.body.toString().split("\n").filter(Boolean).some(line => JSON.parse(line).state === "connected")) return;
    }
  } finally {
    stop.abort();
  }
}

// A phone, paired through the app's Settings › Phone, asking this Mac things over the relay.
async function pairedPhone() {
  const pairing = await ask("POST", "kuvo/phones/pair");
  assert.equal(pairing.status, 200, JSON.stringify(pairing.json));
  await untilConnected();
  const token = new URL(pairing.json.link).searchParams.get("token");
  const key = link.newKey();
  const device = relay.device();
  const session = crypto.randomInt(1, 2 ** 31);
  const frames = async () => {
    const message = link.readRelay(await device.next());
    return message?.kind === "deliver" ? link.readFrame(message.payload) : { kind: "unreachable" };
  };
  const initiator = new link.IKInitiator(key, link.publicOf(macKey), link.PROLOGUE);
  device.send(macAddress, link.frame(link.Frame.handshake1, session, initiator.writeMessage1(Buffer.from(JSON.stringify({ v: 1, name: "Test iPhone", app: "0", pair: token })))));
  const answer = await frames();
  assert.equal(answer.kind, link.Frame.handshake2, "paired");
  const { transport } = initiator.readMessage2(answer.body);
  return async (method, p) => {
    for (const piece of link.pieces({ t: "req", id: crypto.randomInt(1, 2 ** 20), m: method, p, h: {} }, Buffer.alloc(0), true)) device.send(macAddress, link.frame(link.Frame.transport, session, transport.seal(piece)));
    const pieces = [];
    for (;;) {
      const next = await frames();
      if (next.kind !== link.Frame.transport) break;
      const message = link.decodeMessage(transport.open(next.body));
      pieces.push(message);
      if (message.head.end === true) break;
    }
    return { status: pieces[0].head.s, json: JSON.parse(Buffer.concat(pieces.map(piece => piece.body)).toString() || "null") };
  };
}

before(() => { link.runMacLink(); });
atEnd(() => link.stopMacLink());

test("a phone's ask of the Mac's own routes goes to the open app's own host as it registered, proved each time, and to nothing once it quits", async () => {
  assert.ok((await ask("GET", "kuvo/info")).json.features.includes("box.app.host"));
  assert.equal((await ask("PUT", "kuvo/link/config", { phones: true, machines: false, relay: relay.url, name: "Studio Mac", app: "0.9.0" })).status, 200);
  const phone = await pairedPhone();

  // The app not registered yet: the helper can't answer it, and it isn't asked to.
  const before = await phone("GET", "kuvo/mac/info");
  assert.equal(before.status, 503);
  assert.equal(before.json.message, "Kuvo Code isn't open on this Mac.");
  assert.deepEqual(helper.asked.filter(call => call !== "/link/identity"), []);

  // Registered, from the app itself: answered by the app, where it said.
  assert.equal((await ask("POST", "kuvo/box/app", registration)).status, 200);
  assert.equal(fs.statSync(path.join(K, "run", "app.json")).mode & 0o777, 0o600);
  const first = await phone("GET", "kuvo/mac/info");
  assert.deepEqual([first.status, first.json], [200, { answered: "app", path: "kuvo/mac/info" }]);
  await phone("GET", "kuvo/asks");
  assert.deepEqual(app.asked, ["kuvo/mac/info", "kuvo/asks"]);
  assert.equal(app.hellos, 2, "proved for each ask: the box outlives the app, and its port could be anyone's after a crash");
  assert.deepEqual(helper.asked.filter(call => call !== "/link/identity"), []);
  // What the box says of it never gives its host's password.
  assert.equal(JSON.stringify((await ask("GET", "kuvo/box/app")).json).includes(APP_PASSWORD), false);

  // Only the app itself says where its host is: `box route` (anything you run could use it) can't.
  const elsewhere = { ...registration, host: { url: "http://127.0.0.1:1", password: "p".repeat(32) } };
  assert.equal((await ask("POST", "kuvo/box/app", elsewhere, { fromMac: true })).status, 403);
  assert.equal((await ask("POST", "kuvo/box/app", { ...registration, host: { url: "http://example.com:80", password: "p".repeat(32) } })).status, 400);
  assert.equal((await phone("GET", "kuvo/mac/info")).status, 200, "still the app's");
  // Registered again saying nothing of its host (a Kuvo Code from before it said one): the host the
  // last one gave goes, never kept for this one.
  assert.equal((await ask("POST", "kuvo/box/app", { tools: registration.tools }, { fromMac: true })).status, 200);
  const unsaid = await phone("GET", "kuvo/mac/info");
  assert.equal(unsaid.status, 503);
  assert.equal(unsaid.json.message, "Kuvo Code isn't open on this Mac.");
  assert.equal((await ask("POST", "kuvo/box/app", registration)).status, 200);
  assert.equal((await phone("GET", "kuvo/mac/info")).status, 200);

  // It quits: nothing goes to where it answered.
  assert.equal((await ask("POST", "kuvo/box/app", { tools: null })).status, 200);
  const asked = app.asked.length;
  const after = await phone("GET", "kuvo/mac/info");
  assert.equal(after.status, 503);
  assert.equal(after.json.message, "Kuvo Code isn't open on this Mac.");
  assert.equal(app.asked.length, asked);

  // Opened again, then quit to install an update: the same.
  assert.equal((await ask("POST", "kuvo/box/app", registration)).status, 200);
  assert.equal((await ask("POST", "kuvo/box/app", { updating: true })).status, 200);
  assert.equal((await phone("GET", "kuvo/mac/info")).status, 503);
  assert.equal(app.asked.length, asked);
});

test("something else on the app's port after it crashed is never sent a phone's ask", async () => {
  assert.equal((await ask("POST", "kuvo/box/app", registration)).status, 200);
  const phone = await pairedPhone();
  assert.equal((await phone("GET", "kuvo/mac/info")).status, 200);
  // The app gone without saying; something else answers there, with no proof it's the app.
  const squatter = [];
  const other = http.createServer(async (request, response) => {
    squatter.push(request.url);
    await read(request);
    response.writeHead(200, { "content-type": "application/json", "x-kuvo-answer": "1" }).end(JSON.stringify({ proof: "0".repeat(64), answered: "squatter" }));
  });
  const otherPort = await listen(other);
  const record = JSON.parse(fs.readFileSync(path.join(K, "run", "app.json"), "utf8"));
  fs.writeFileSync(path.join(K, "run", "app.json"), JSON.stringify({ ...record, host: { url: `http://127.0.0.1:${otherPort}`, password: APP_PASSWORD } }));
  const answer = await phone("GET", "kuvo/mac/info");
  assert.equal(answer.status, 503);
  assert.match(answer.json.message, /isn't answering/, "registered, but not answering as the app");
  assert.deepEqual(squatter, ["/hello"], "asked only for the proof it can't give");
});

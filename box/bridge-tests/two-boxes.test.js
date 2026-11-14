// Two boxes over the relay: this Mac's (`serve`, here, with its app a stand-in) and one of its
// machines (`kuvo-link.js run`, a process of its own, set up as the app sets one up over SSH). This
// Mac's documents, from before its box held them and after, reach the machine; a phone the machine
// lets go reaches this Mac's app; and a machine you remove lets this Mac go. (Agents, letters and
// group chats' mail between the two: mac-peers.) Only the relay and the app are stand-ins.
//
// Run with `node --test box/bridge-tests/two-boxes.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-two-boxes-")));
const machineHome = path.join(support, "machine");
fs.mkdirSync(machineHome, { recursive: true });

// Each time a stand-in (the app, the relay) records something: what a test waits on looks again.
const waitingForChange = [];
const changed = () => new Promise(resolve => waitingForChange.push(resolve));
const poke = () => { for (const resolve of waitingForChange.splice(0)) resolve(); };
async function arrived(found) {
  for (;;) {
    const value = await found();
    if (value) return value;
    await changed();
  }
}

// The app, as its host interface answers this Mac's box: its keys.
const app = { keys: null };
const appHost = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => {
    const given = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (request.url === "/hello") {
      const proof = crypto.createHmac("sha256", "host-password").update(`kuvo-host-hello\u0000${given.nonce}\u0000127.0.0.1:${appHost.address().port}`).digest("hex");
      return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ proof }));
    }
    if (request.headers.authorization !== "Bearer host-password") return response.writeHead(401).end();
    if (request.url === "/link/identity") return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(app.keys));
    if (request.url === "/link/route") return response.writeHead(404, { "content-type": "application/json", "x-kuvo-answer": "1" }).end("{}");
    response.writeHead(404).end();
  });
});
await new Promise(resolve => appHost.listen(0, "127.0.0.1", resolve));

Object.assign(process.env, {
  KUVO_HOME: path.join(support, "mac"),
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

// This Mac's keys, as your Keychain keeps them.
const macKey = link.newKey();
const macSecret = crypto.randomBytes(32);
const macAddress = link.addressOf(macSecret);
const macSeed = link.newSigningSeed();
const mac = link.publicOf(macKey).toString("base64url");
const macSign = link.signingKeyOf(macSeed);
app.keys = { key: macKey.toString("base64url"), secret: macSecret.toString("base64url"), sign: macSeed };

link.macLink.hold = link.macNoticeHold();
const handle = link.engineHandler(link.readEngineFile, { name: "Mac" }, link.readBridgeFile, () => {}, link.macLink.hold);
async function ask(method, p, body) {
  const parts = [];
  for await (const part of handle({ method, path: p, headers: {}, body: body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0), fromApp: true }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  let json;
  try { json = JSON.parse(text); } catch {}
  return { status: parts[0].head.status, json };
}

// What this Mac's box says on `route`'s stream (as the app follows it), once `found` says it's there.
async function followed(route, found) {
  const stop = new AbortController();
  try {
    for await (const part of handle({ method: "GET", path: route, headers: {}, body: Buffer.alloc(0), fromApp: true }, {}, stop.signal)) {
      if (!part.body) continue;
      for (const line of part.body.toString().split("\n").filter(Boolean)) {
        const value = JSON.parse(line);
        if (found(value)) return value;
      }
    }
  } finally {
    stop.abort();
  }
  throw new Error(`${route} ended first`);
}

// The machine's own files, as its bridge keeps them.
const machineLink = () => {
  try { return JSON.parse(fs.readFileSync(path.join(machineHome, "run", "link.json"), "utf8")); } catch { return null; }
};
// What the machine has of this Mac's `kind`: its version, as it reads it.
const machineHas = kind => {
  const envelope = machineLink()?.docs?.[`${macSign} ${kind}`];
  return envelope ? JSON.parse(Buffer.from(envelope.d, "base64url").toString("utf8")).n : 0;
};
// What the machine (another process, which can't tell this one) has written, looked at again
// every few milliseconds until it's there (a watch on its files starts a moment late and can miss
// a write in that moment), or until the test runs out of time (`signal`).
let signal;
function onTheMachine(found) {
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
      reject(new Error("the machine never got there"));
    }, { once: true });
    look();
  });
}

// The machine set up as the app sets one up over SSH: this Mac's keys and documents in, its own
// keys, address and documents back.
function setUp(docs) {
  const result = spawnSync(process.execPath, [script, "setup"], {
    input: JSON.stringify({ relay: relay.url, name: "lab", mac, macSign, docs, id: "lab" }),
    env: { PATH: process.env.PATH, HOME: support, KUVO_HOME: machineHome },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

before(() => { link.runMacLink(); });
removeAtEnd(support);
atEnd(async () => {
  link.stopMacLink();
  // The machine's bridge stopped, and gone before its folder is (it writes as it ends).
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

// A phone on the relay, opening sessions with a box (`to`: its address and key) and asking it things.
function phone() {
  const key = link.newKey();
  const device = relay.device();
  let session = crypto.randomInt(1, 2 ** 31);
  let transport = null, at = null;
  // What the box it's talking to sends it (another's, a moment late from a session before, isn't).
  const frames = async () => {
    for (;;) {
      const message = link.readRelay(await device.next(10_000));
      if (message && at && !message.address.equals(at.address)) continue;
      if (message?.kind !== "deliver") return { kind: "unreachable" };
      return link.readFrame(message.payload);
    }
  };
  return {
    key,
    public: link.publicOf(key).toString("base64url"),
    async open(to, hello = {}) {
      at = to;
      session += 1;
      const initiator = new link.IKInitiator(key, to.key, link.PROLOGUE);
      device.send(to.address, link.frame(link.Frame.handshake1, session, initiator.writeMessage1(Buffer.from(JSON.stringify({ v: 1, name: "Test iPhone", app: "0", ...hello })))));
      const answer = await frames();
      if (answer.kind !== link.Frame.handshake2) return { refused: true };
      const opened = initiator.readMessage2(answer.body);
      transport = opened.transport;
      return JSON.parse(opened.payload);
    },
    async request(method, p, body) {
      const h = body === undefined ? {} : { "content-type": "application/json" };
      const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
      for (const piece of link.pieces({ t: "req", id: 1, m: method, p, h }, bytes, true)) device.send(at.address, link.frame(link.Frame.transport, session, transport.seal(piece)));
      const pieces = [];
      while (true) {
        const next = await frames();
        if (next.kind !== link.Frame.transport) return { closed: true };
        const message = link.decodeMessage(transport.open(next.body));
        pieces.push(message);
        if (message.head.end === true) break;
      }
      return { status: pieces[0].head.s };
    },
  };
}

test("this Mac's documents reach a machine; a phone the machine lets go reaches this Mac's app; a machine you remove lets this Mac go, and comes back when set up again", { timeout: 90_000 }, async t => {
  signal = t.signal;
  // This Mac's box on, and the machine set up over SSH with what the box gives it, then given to
  // the box as its machine.
  assert.notEqual((await ask("PUT", "kuvo/link/config", { phones: true, machines: true, relay: relay.url, name: "Studio Mac", app: "0.9.0" })).json?.state, "failed");
  const setup = await ask("GET", "kuvo/link/setup");
  assert.equal(setup.status, 200);
  const lab = setUp(setup.json.docs);
  assert.ok(lab.key && lab.address && lab.sign, JSON.stringify(lab));
  const peersAtSetup = machineHas("peers");
  const phonesAtSetup = machineHas("phones");
  assert.ok(peersAtSetup >= 1 && phonesAtSetup >= 1, JSON.stringify({ peersAtSetup, phonesAtSetup }));
  assert.equal((await ask("PUT", "kuvo/link/peers", { peers: [{ key: lab.key, sign: lab.sign, address: lab.address, name: "lab", id: "lab" }], moved: [] })).status, 200);
  await arrived(() => relay.has(macAddress));

  // Who its computers are now names the machine: past what it had from its setup.
  await onTheMachine(() => machineHas("peers") > peersAtSetup);

  // A phone paired on this Mac: in its next phones document, which the machine takes.
  const pairing = await ask("POST", "kuvo/phones/pair");
  const token = new URL(pairing.json.link).searchParams.get("token");
  const it = phone();
  assert.equal((await it.open({ key: link.publicOf(macKey), address: macAddress }, { pair: token })).kind, "mac");
  await onTheMachine(() => machineHas("phones") > phonesAtSetup && (machineLink()?.phones ?? []).some(each => each.key === it.public));

  // The phone removes itself on the machine: the machine's phones document says so, and this Mac's
  // box takes it (the app hears it).
  assert.equal((await it.open({ key: Buffer.from(lab.key, "base64url"), address: Buffer.from(lab.address, "base64url") })).kind, "machine");
  assert.equal((await it.request("POST", "kuvo/phones/remove", { phones: [{ key: it.public }] })).status, 200);
  const removed = await followed("kuvo/link/phones/events", phones => phones.removed.some(each => each.key === it.public));
  assert.ok(!removed.phones.some(each => each.key === it.public), "off this Mac's phones too");

  // Removed in Settings › Machines: it hears this Mac's peers document, and lets this Mac go.
  assert.equal((await ask("PUT", "kuvo/link/peers", { peers: [], moved: [], removed: [lab.key] })).status, 200);
  await onTheMachine(() => !(machineLink()?.macs ?? []).includes(mac));
  // Set up again over SSH, as the app does once it forgot it (no `?key=`: the peers document it
  // carries still names it as removed): this Mac's again, whatever it said before.
  const again = await ask("GET", "kuvo/link/setup");
  assert.ok(again.json.docs.map(link.readDoc).find(doc => doc?.origin === macSign && doc.kind === "peers").body.left.includes(lab.key));
  const back = setUp(again.json.docs);
  assert.equal(back.key, lab.key, JSON.stringify(back));
  assert.ok((machineLink()?.macs ?? []).includes(mac));
  assert.equal((await ask("PUT", "kuvo/link/peers", { peers: [{ key: lab.key, sign: lab.sign, address: lab.address, name: "lab", id: "lab" }], moved: [] })).status, 200);

  // Removed while this Mac's box is off the relay: the machine hears it once it's back.
  link.stopMacLink();
  await arrived(() => !relay.has(macAddress));
  assert.equal((await ask("PUT", "kuvo/link/peers", { peers: [], moved: [], removed: [lab.key] })).status, 200);
  link.runMacLink();
  await onTheMachine(() => !(machineLink()?.macs ?? []).includes(mac));
});

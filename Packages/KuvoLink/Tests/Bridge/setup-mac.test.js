// This Mac's box and your setup (PROTOCOL.md, "Your setup"; the Work Queue's "Numbers"): a Mac that
// numbers on its own leads a setup of its own, named in its peers document, and keeps numbering
// where it was; one that numbers through another Mac, by a machine both set up (or with a machine
// another Mac set up too), leads none and numbers as before, from the first Mac you set up.
//
// This Mac's box is the link in this process (`KUVO_BOX=mac`), its keys as its app gives them; its
// machines and the other Mac are keys whose mail is opened as the relay carries it, and what they
// told this Mac of their Work Queues is kept as it would be. Only the engine is a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/setup-mac.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-setup-mac-")));
removeAtEnd(support);
const home = path.join(support, "box");
Object.assign(process.env, {
  KUVO_HOME: home,
  KUVO_BOX: "mac",
  KUVO_ENGINE_CONFIG: path.join(support, "opencode"),
  KUVO_BOTS: path.join(support, "bots"),
  KUVO_WAKES: path.join(support, "wakes"),
});
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
const run = path.join(home, "run");
const queues = path.join(run, "work-queue");
const numbers = path.join(queues, "numbers.json");
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
};
const read = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

// The engine, with the session whose tool calls add items here.
const calling = new Map();
const engine = http.createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    const reply = value => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/session" && request.method === "GET") return reply({ data: [{ id: "ses_lead", title: "Lead", time: { created: 1, updated: 2 } }] });
    if (url.pathname === "/api/session/ses_lead") return reply({ data: { id: "ses_lead", title: "Lead", time: { created: 1, updated: 2 } } });
    if (url.pathname === "/api/session/ses_lead/message") {
      const call = calling.get("ses_lead");
      return reply({ data: call ? [{ id: "msg_1", type: "assistant", content: [{ type: "tool", name: `kuvo-browser_${call.name}`, callID: "call_1", state: { status: "running", input: call.args } }] }] : [] });
    }
    reply({ data: [] });
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
const target = { port: engine.address().port, password: "p" };

// This Mac (its keys, as its app gives them), its machine lab, and another Mac that set lab up too.
const k = key => key.toString("base64url");
const box = (kind, name) => {
  const key = link.newKey();
  const sign = link.newSigningSeed();
  const address = k(link.addressOf(crypto.randomBytes(32)));
  return { key, sign, pub: k(link.publicOf(key)), address, peer: { key: k(link.publicOf(key)), address, name, kind, sign: link.signingKeyOf(sign), id: name } };
};
const self = box("mac", "Studio"), lab = box("machine", "lab"), other = box("mac", "Old Mac");
link.macLink.overlay = { key: k(self.key), secret: k(crypto.randomBytes(32)), sign: self.sign, relay: "wss://relay.test", name: "Studio" };
link.macLink.config = { phones: false, machines: true, relay: "wss://relay.test", name: "Studio", app: "0.9.0" };

// Mail as the relay hands it on, and what this box sent, opened as `to` would.
const sent = [];
const host = { welcomed: true, send: bytes => sent.push(bytes) };
const mailTo = to => sent.filter(bytes => k(bytes.subarray(1, 17)) === to.address)
  .map(bytes => JSON.parse(link.openOneWay(link.readFrame(bytes.subarray(17)).body, to.key, link.publicOf(self.key)).payload.toString("utf8")));
// What lab told of how it numbers, as its Work Queue's mail leaves it here.
const labTold = numbering => write(path.join(queues, "peers", `${lab.pub}.json`), { id: "wqt_labtoldlabtold", at: 1, heard: 1, kind: "machine", since: 50, items: [], owners: [], categories: [], ...numbering });

const handle = link.engineHandler(() => target);
async function route(method, pathname) {
  const pieces = [];
  for await (const piece of handle({ method, path: pathname, headers: {}, body: undefined, fromApp: true }, undefined)) pieces.push(piece);
  return { status: pieces.find(each => each.head).head.status, json: JSON.parse(Buffer.concat(pieces.filter(each => each.body).map(each => each.body)).toString() || "null") };
}
async function addItem(title) {
  calling.set("ses_lead", { name: "queue_add", args: { title } });
  try {
    for await (const piece of handle({ method: "POST", path: "kuvo/work-queue/tools", headers: {}, body: Buffer.from(JSON.stringify({ name: "queue_add", arguments: { title }, session: "ses_lead" })), fromApp: true }, undefined)) {
      if (piece.body) return JSON.parse(piece.body.toString()).text;
    }
  } finally {
    calling.delete("ses_lead");
  }
}
// This Mac's own peers document as it signs it now.
const ownPeers = () => {
  let body = null;
  link.updateLink(current => {
    const made = link.ownDoc(current, "peers", link.macPeersBody(current));
    body = link.readDoc(made.envelope).body;
    return current;
  });
  return body;
};

beforeEach(() => {
  fs.rmSync(run, { recursive: true, force: true });
  write(path.join(run, "engine.json"), { ...target, version: "0.0.0" });
  sent.length = 0;
  link.writeLink({ phones: [], macPeers: [lab.peer], macMoved: [] });
});

test("this Mac numbers through a machine it shares with a Mac set up before it: its ask goes through that machine, naming that Mac", () => {
  write(numbers, { primary: "self", next: 12, leases: [], since: 9_000 });
  labTold({ primary: { key: other.pub, kind: "mac", since: 1_000 } });
  const primary = link.primaryOf(link.readLink(), numbers);
  assert.equal(primary.peer?.key, other.pub, "the Mac set up first");
  assert.equal(primary.via?.key, lab.pub, "reached through lab");
  link.notePrimaryNow(link.readLink(), { file: numbers });
  const kept = link.readNumbers(numbers);
  assert.equal(kept.primary, other.pub);
  assert.equal(kept.through, lab.pub);
  assert.ok(kept.asking, "it asks at once, having numbered on its own");
  link.pushNumbers(host, link.readLink());
  const asked = mailTo(lab).map(each => each.workQueue);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].to, other.pub);
  assert.ok(asked[0].ask.top >= 11, "telling how far it got");
});

test("this Mac, numbering on its own, leads a setup of its own: its peers document names it, its numbers go on where they were (#41, then #42), and kuvo/setup says it's the main computer", async () => {
  write(numbers, { primary: "self", next: 42, leases: [], since: 1_000 });
  labTold({ primary: { key: self.pub, kind: "mac", since: 1_000 } });
  assert.equal(ownPeers().setup, undefined, "none before it's looked at");
  link.noteSetupNow(Date.now(), { soon: 0 });
  const named = ownPeers().setup;
  assert.match(named?.id ?? "", /^set_[A-Za-z0-9_-]{22}$/);
  assert.deepEqual({ epoch: named.epoch, primary: named.primary }, { epoch: 1, primary: self.pub });
  // Looked at again: the same setup, never a new one.
  link.noteSetupNow(Date.now(), { soon: 0 });
  assert.equal(ownPeers().setup.id, named.id);

  assert.match(await addItem("Ship it"), /^Added #42 /);
  const shown = await route("GET", "kuvo/setup");
  assert.equal(shown.status, 200);
  assert.deepEqual(shown.json, {
    setup: named.id, epoch: 1,
    primary: { key: self.pub, name: "Studio", kind: "mac" },
    you: { key: self.pub, role: "primary" },
    computers: [{ key: self.pub, name: "Studio", kind: "mac", role: "primary", app: true }, { key: lab.pub, name: "lab", kind: "machine", role: "member", app: false }],
    startsFromOthers: { value: null, default: "off" },
  });
  // Its card, as it's next written: the same, with the item made since.
  link.writeCard();
  const card = read(path.join(run, "setup-card.json"));
  assert.deepEqual({ setup: card.setup, role: card.role, primary: card.primary.key, app: card.app, computers: card.computers, items: card.items }, { setup: named.id, role: "primary", primary: self.pub, app: true, computers: 2, items: 1 });
});

test("a Mac whose numbers go through another Mac, or whose machine another Mac shares, leads no setup and numbers as before; one that led it steps aside once it hears its machine is shared, and leads it again, the same, once it isn't", () => {
  write(numbers, { primary: "self", next: 12, leases: [], since: 9_000 });
  labTold({ primary: { key: other.pub, kind: "mac", since: 1_000 } });
  link.noteSetupNow(Date.now(), { soon: 0 });
  assert.equal(link.readLink().setup, undefined, "it numbers from the Mac set up first: no setup of its own");
  assert.equal(ownPeers().setup, undefined);
  assert.equal(link.primaryOf(link.readLink(), numbers).via?.key, lab.pub, "and through lab, as before");

  // lab numbers from this Mac, but says another Mac set it up too.
  write(numbers, { primary: "self", next: 12, leases: [], since: 1_000 });
  labTold({ primary: { key: self.pub, kind: "mac", since: 1_000 }, shared: true });
  link.noteSetupNow(Date.now(), { soon: 0 });
  assert.equal(link.readLink().setup, undefined);

  // lab isn't shared: it leads. Then it hears lab is (another Mac set it up since): it steps aside,
  // numbering on as it was, and its peers document names no setup.
  labTold({ primary: { key: self.pub, kind: "mac", since: 1_000 } });
  link.noteSetupNow(Date.now(), { soon: 0 });
  const led = ownPeers().setup;
  assert.ok(led);
  labTold({ primary: { key: self.pub, kind: "mac", since: 1_000 }, shared: true });
  link.noteSetupNow(Date.now(), { soon: 0 });
  assert.equal(ownPeers().setup, undefined);
  assert.equal(link.readLink().setup.aside, true, "kept aside, never made again");
  assert.deepEqual(link.primaryOf(link.readLink(), numbers), { self: true });
  assert.deepEqual(link.setupView(link.readLink()).you, { key: self.pub, role: null });
  labTold({ primary: { key: self.pub, kind: "mac", since: 1_000 } });
  link.noteSetupNow(Date.now(), { soon: 0 });
  assert.deepEqual(ownPeers().setup, led, "the same setup, at the same epoch");
});

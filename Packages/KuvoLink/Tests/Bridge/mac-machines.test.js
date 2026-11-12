// A Mac's machines for a phone, with its app open, closed or stuck (PROTOCOL.md, "Machines"): each
// box is its own, so a phone sees them whatever the Mac's app is doing, and hears plainly what needs
// the app. A real `serve` with a phone on the relay, and what it does as the app comes and goes; only
// the relay and what answers for the app are stand-ins, and that answers as the keeper does with the
// app closed.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/mac-machines.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";
import { relayStandIn } from "./relay-stand-in.js";

const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-mac-machines-")));
removeAtEnd(support);

// What answers for this Mac's app (the keeper's host interface): `closed`, as the keeper says it while
// the app isn't open, which isn't the app's own answer; `open`, the app's; `wontSay`, its own 503 (its list
// wouldn't read); `stuck`, no answer.
const app = { state: "closed", streams: new Set(), asked: [] };
const appLine = { machines: [{ id: "lab", name: "lab", otherAddresses: [], connection: "connected", status: "Connected", action: "disconnect" }], hosts: ["gpu"] };
const appHost = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => {
    const given = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (request.url === "/hello") {
      const proof = crypto.createHmac("sha256", "host-password").update(`kuvo-host-hello\u0000${given.nonce}\u0000127.0.0.1:${appHost.address().port}`).digest("hex");
      return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ proof }));
    }
    if (request.url === "/link/identity") return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(keys));
    if (request.url !== "/link/route") return response.writeHead(404).end();
    app.asked.push(given);
    if (app.state === "stuck") return;
    if (app.state === "wontSay") return response.writeHead(503, { "content-type": "application/json", "x-kuvo-answer": "1" }).end(JSON.stringify({ message: "Its own words" }));
    if (app.state === "closed") return response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ message: "Kuvo Code isn’t open on this Mac." }));
    if (given.path === "kuvo/machines/events") {
      response.writeHead(200, { "content-type": "application/x-ndjson", "x-kuvo-answer": "1" });
      response.write(JSON.stringify(appLine) + "\n");
      app.streams.add(response);
      return;
    }
    if (given.path === "kuvo/hosts") return response.writeHead(200, { "content-type": "application/json", "x-kuvo-answer": "1" }).end(JSON.stringify({ hosts: [] }));
    if (given.method === "GET") return response.writeHead(200, { "content-type": "application/json", "x-kuvo-answer": "1" }).end(JSON.stringify(appLine));
    response.writeHead(200, { "content-type": "application/json", "x-kuvo-answer": "1" }).end(JSON.stringify({ did: given.path }));
  });
});
await new Promise(resolve => appHost.listen(0, "127.0.0.1", resolve));
atEnd(() => {
  for (const stream of app.streams) stream.destroy();
  appHost.closeAllConnections();
  appHost.close();
});

const box = path.join(support, "box");
const environment = {
  KUVO_HOME: box,
  KUVO_BOTS: path.join(support, "bots"),
  KUVO_WAKES: path.join(support, "wakes"),
  KUVO_BOX: "mac",
  KUVO_ENGINE_CONFIG: path.join(support, "opencode"),
  KUVO_KEYS: path.join(support, "keys"),
  KUVO_HOST_URL: `http://127.0.0.1:${appHost.address().port}`,
  KUVO_HOST_PASSWORD: "host-password",
};
Object.assign(process.env, environment);
const script = new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url);
const link = await import(script);

const relay = await relayStandIn(link);
atEnd(() => relay.close());

const macKey = link.newKey();
const macSecret = crypto.randomBytes(32);
const macAddress = link.addressOf(macSecret);
const keys = { key: macKey.toString("base64url"), secret: macSecret.toString("base64url"), sign: link.newSigningSeed() };

const listFile = path.join(box, "machines.json");
const phoneLinkFile = path.join(support, "phone-link.json");
function saved(list) {
  fs.mkdirSync(box, { recursive: true });
  fs.writeFileSync(listFile, typeof list === "string" ? list : JSON.stringify(list));
}

// The real box, as the keeper starts it.
const password = "s3cret";
const child = spawn(process.execPath, [fileURLToPath(script), "serve"], { env: { ...process.env, ...environment, OPENCODE_PASSWORD: password }, stdio: ["pipe", "pipe", "inherit"] });
atEnd(() => child.kill());
let said = "";
child.stdout.setEncoding("utf8");
for await (const chunk of child.stdout) {
  said += chunk;
  if (said.includes("\n")) break;
}
const url = JSON.parse(said.split("\n")[0]).url;
// What the keeper's and app's PhoneLink ask of it.
async function asApp(method, route, body) {
  const response = await fetch(`${url}/${route}`, {
    method,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "x-kuvo-from": "app", "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}
assert.equal((await asApp("PUT", "kuvo/link/config", { phones: true, machines: true, relay: relay.url, name: "Studio", app: "1.0.0" })).status, 200);
// On the relay, as the app follows it.
{
  const following = new AbortController();
  const status = await fetch(`${url}/kuvo/link/status/events`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "x-kuvo-from": "app" }, signal: following.signal });
  let lines = "";
  for await (const chunk of status.body) {
    lines += Buffer.from(chunk).toString();
    if (lines.includes("\"connected\"")) break;
  }
  following.abort();
}

// A phone on the relay, paired with it, asking it things.
async function pairedPhone() {
  const device = relay.device();
  const key = link.newKey();
  const pairing = await asApp("POST", "kuvo/phones/pair");
  assert.equal(pairing.status, 200);
  const token = new URL(pairing.json.link).searchParams.get("token");
  const session = crypto.randomInt(1, 2 ** 31);
  const frames = async () => {
    const message = link.readRelay(await device.next(30_000));
    if (message?.kind !== "deliver") return { kind: "unreachable" };
    return link.readFrame(message.payload);
  };
  const initiator = new link.IKInitiator(key, link.publicOf(macKey), link.PROLOGUE);
  device.send(macAddress, link.frame(link.Frame.handshake1, session, initiator.writeMessage1(Buffer.from(JSON.stringify({ v: 1, name: "Test iPhone", app: "0", pair: token })))));
  const answer = await frames();
  assert.equal(answer.kind, link.Frame.handshake2, "paired");
  const { transport } = initiator.readMessage2(answer.body);
  return {
    async request(method, route) {
      for (const piece of link.pieces({ t: "req", id: crypto.randomInt(1, 2 ** 20), m: method, p: route, h: {} }, Buffer.alloc(0), true)) device.send(macAddress, link.frame(link.Frame.transport, session, transport.seal(piece)));
      const pieces = [];
      for (;;) {
        const next = await frames();
        const message = link.decodeMessage(transport.open(next.body));
        pieces.push(message);
        if (message.head.end === true) break;
      }
      const text = Buffer.concat(pieces.map(piece => piece.body)).toString();
      return { status: pieces[0].head.s, json: JSON.parse(text || "null") };
    },
  };
}

const phone = await pairedPhone();

test("with the app closed a phone still lists the Mac's machines, says how each is doing, and offers nothing only the app can do", async () => {
  app.state = "closed";
  saved([{ destination: "lab", otherAddresses: ["lab.tail"], identity: "a".repeat(32), reachedAt: "lab.tail" }, { destination: "quiet" }, { destination: "elsewhere" }]);
  // Told of two of them (the third is another Mac's, which this box doesn't meet); one heard from lately.
  const peer = (name, fill) => ({ key: Buffer.alloc(32, fill).toString("base64url"), sign: Buffer.alloc(32, fill + 1).toString("base64url"), address: Buffer.alloc(16, fill).toString("base64url"), name, id: name });
  const [lab, quiet] = [peer("lab", 1), peer("quiet", 3)];
  assert.equal((await asApp("PUT", "kuvo/link/peers", { peers: [lab, quiet], moved: [] })).status, 200);
  fs.mkdirSync(path.join(box, "run"), { recursive: true });
  fs.writeFileSync(path.join(box, "run", "peer-agents.json"), JSON.stringify({
    [lab.key]: { at: Date.now() - 60_000, kind: "machine", id: "lab", list: [] },
    [quiet.key]: { at: Date.now() - 24 * 3600_000, kind: "machine", id: "quiet", list: [] },
  }));

  const listed = await phone.request("GET", "kuvo/machines");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json, {
    machines: [
      { id: "lab", name: "lab", otherAddresses: ["lab.tail"], connection: "notConnected", status: "Running · Kuvo Code isn’t open on Studio" },
      { id: "quiet", name: "quiet", otherAddresses: [], connection: "notConnected", status: "Not heard from lately · Kuvo Code isn’t open on Studio" },
      { id: "elsewhere", name: "elsewhere", otherAddresses: [], connection: "notConnected", status: "Kuvo Code isn’t open on Studio" },
    ],
    hosts: [],
  });
});

test("with the app closed, what needs it says so at once", async () => {
  app.state = "closed";
  saved([{ destination: "lab" }]);
  const plainly = { status: 503, json: { message: "Kuvo Code isn’t open on Studio. Open it there, then try again." } };
  for (const [method, route] of [["POST", "kuvo/machines"], ["POST", "kuvo/machines/lab/connect"], ["POST", "kuvo/machines/lab/uninstall"], ["DELETE", "kuvo/machines/lab"], ["DELETE", "kuvo/machines/lab/addresses/lab.tail"], ["POST", "kuvo/machines/lab/home"], ["DELETE", "kuvo/hosts/lab"]]) {
    assert.deepEqual(await phone.request(method, route), plainly, `${method} ${route}`);
  }
});

test("with the app open its answers go as they are, the page's button and all, and what changes something reaches it", async () => {
  app.state = "open";
  saved([{ destination: "not-what-the-app-says" }]);
  assert.deepEqual(await phone.request("GET", "kuvo/machines"), { status: 200, json: appLine });
  assert.deepEqual(await phone.request("POST", "kuvo/machines/lab/disconnect"), { status: 200, json: { did: "kuvo/machines/lab/disconnect" } });
  app.state = "closed";
});

test("a list that's not there is none, and one that can't be read isn't none", async () => {
  app.state = "closed";
  fs.rmSync(listFile, { force: true });
  assert.deepEqual(await phone.request("GET", "kuvo/machines"), { status: 200, json: { machines: [], hosts: [] } });
  for (const damaged of ["[{\"destination\": 42}]", "{ not json", "{\"machines\": []}"]) {
    saved(damaged);
    assert.deepEqual(await phone.request("GET", "kuvo/machines"), { status: 503, json: { message: "This Mac’s list of machines can’t be read right now." } }, damaged);
  }
  fs.rmSync(listFile, { force: true });
});

test("with the app closed a phone still learns which machines it may reach, and one removed stays marked", async () => {
  app.state = "closed";
  saved([{ destination: "lab" }]);
  const host = name => ({ name, address: "ab".repeat(16), key: Buffer.alloc(32, 9).toString("base64url") });
  fs.writeFileSync(phoneLinkFile, JSON.stringify({ phones: [], removed: [], machines: { lab: { ...host("lab"), anotherMac: true, peers: true }, gone: host("Gone") } }));
  const listed = await phone.request("GET", "kuvo/hosts");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.hosts.map(({ machine, name, anotherMac, removed, relay: where, kind }) => ({ machine, name, anotherMac, removed, where, kind })), [
    { machine: "gone", name: "Gone", anotherMac: false, removed: true, where: relay.url, kind: "machine" },
    { machine: "lab", name: "lab", anotherMac: true, removed: false, where: relay.url, kind: "machine" },
  ]);
  // What a phone takes for all your machines is never said from what can't be read: it would forget them.
  fs.writeFileSync(phoneLinkFile, "{ not json");
  assert.equal((await phone.request("GET", "kuvo/hosts")).status, 503);
  // Nor from nothing, with machines in the list.
  fs.rmSync(phoneLinkFile, { force: true });
  assert.equal((await phone.request("GET", "kuvo/hosts")).status, 503);
  saved([]);
  assert.deepEqual(await phone.request("GET", "kuvo/hosts"), { status: 200, json: { hosts: [] } });
  fs.rmSync(listFile, { force: true });
  assert.deepEqual(await phone.request("GET", "kuvo/hosts"), { status: 200, json: { hosts: [] } });
});

test("no list while the app keeps bridges for machines isn't none: the list is still in its settings", async () => {
  app.state = "closed";
  fs.rmSync(listFile, { force: true });
  const unknown = { status: 503, json: { message: "This Mac’s list of machines can’t be read right now." } };
  fs.writeFileSync(phoneLinkFile, JSON.stringify({ phones: [], removed: [], machines: { lab: { name: "lab", address: "ab".repeat(16), key: Buffer.alloc(32, 9).toString("base64url") } } }));
  assert.deepEqual(await phone.request("GET", "kuvo/machines"), unknown);
  assert.deepEqual(await phone.request("GET", "kuvo/hosts"), unknown, "a phone would forget them all");
  // The last one removed leaves an empty list, so that's none, and the one left is marked.
  saved([]);
  assert.deepEqual(await phone.request("GET", "kuvo/machines"), { status: 200, json: { machines: [], hosts: [] } });
  assert.deepEqual((await phone.request("GET", "kuvo/hosts")).json.hosts.map(host => host.removed), [true]);
  fs.rmSync(phoneLinkFile, { force: true });
  fs.rmSync(listFile, { force: true });
});

test("whether a machine was heard from goes by when it was heard, not by its clock", async () => {
  app.state = "closed";
  saved([{ destination: "lab" }]);
  const key = Buffer.alloc(32, 1).toString("base64url");
  for (const off of [-6, 6]) {
    fs.rmSync(path.join(box, "run", "peer-agents.json"), { force: true });
    assert.equal(link.takeAgents({ key, kind: "machine", id: "lab" }, { at: Date.now() + off * 3600_000, list: [] }), true);
    assert.equal((await phone.request("GET", "kuvo/machines")).json.machines[0].status, "Running · Kuvo Code isn’t open on Studio", `a clock ${off} hours off`);
  }
  // A clock set right after running ahead: older by it, and heard all the same.
  fs.rmSync(path.join(box, "run", "peer-agents.json"), { force: true });
  link.takeAgents({ key, kind: "machine", id: "lab" }, { at: Date.now() + 6 * 3600_000, list: [] });
  const ahead = JSON.parse(fs.readFileSync(path.join(box, "run", "peer-agents.json"), "utf8"));
  ahead[key].heard = Date.now() - 3600_000;
  fs.writeFileSync(path.join(box, "run", "peer-agents.json"), JSON.stringify(ahead));
  assert.equal(link.takeAgents({ key, kind: "machine", id: "lab" }, { at: Date.now(), list: [] }), false, "the list said ahead of it stands");
  assert.equal((await phone.request("GET", "kuvo/machines")).json.machines[0].status, "Running · Kuvo Code isn’t open on Studio");
  // And long ago is long ago, however it was dated.
  const kept = JSON.parse(fs.readFileSync(path.join(box, "run", "peer-agents.json"), "utf8"));
  kept[key].heard = Date.now() - 3600_000;
  fs.writeFileSync(path.join(box, "run", "peer-agents.json"), JSON.stringify(kept));
  assert.equal((await phone.request("GET", "kuvo/machines")).json.machines[0].status, "Not heard from lately · Kuvo Code isn’t open on Studio");
});

test("an app that won't say isn't the last word on a read: the box says what it can, and only a change hears the app", async () => {
  saved([{ destination: "lab" }]);
  app.state = "wontSay";
  const listed = await phone.request("GET", "kuvo/machines");
  assert.equal(listed.status, 200);
  assert.equal(listed.json.machines[0].id, "lab");
  fs.writeFileSync(phoneLinkFile, JSON.stringify({ phones: [], removed: [], machines: {} }));
  assert.equal((await phone.request("GET", "kuvo/hosts")).status, 200);
  fs.rmSync(phoneLinkFile, { force: true });
  saved("{ not json");
  assert.deepEqual(await phone.request("GET", "kuvo/machines"), { status: 503, json: { message: "This Mac’s list of machines can’t be read right now." } });
  assert.deepEqual(await phone.request("POST", "kuvo/machines/lab/connect"), { status: 503, json: { message: "Its own words" } });
  fs.rmSync(listFile, { force: true });
  app.state = "closed";
});

// What the phone reads from a stream, line by line, in this process (the app coming and going takes
// `look` to be noticed, a test's own).
const timing = { wait: 200, look: 5 };
function follow() {
  const front = link.macFront(async function* () { throw new Error("the box's own routes aren't asked"); }, timing);
  const stop = new AbortController();
  const pieces = front({ method: "GET", path: "kuvo/machines/events", headers: {}, body: Buffer.alloc(0) }, undefined, stop.signal);
  let text = "";
  return {
    stop: () => stop.abort(),
    async head() { return (await pieces.next()).value; },
    async line() {
      while (!text.includes("\n")) text += (await pieces.next()).value.body.toString();
      const end = text.indexOf("\n");
      const line = text.slice(0, end);
      text = text.slice(end + 1);
      return line;
    },
    close: () => pieces.return(),
    async ended() {
      for (;;) if ((await pieces.next()).done) return;
    },
  };
}

test("one stream follows the machines as the app opens and quits", async () => {
  link.macLink.config = { phones: true, machines: true, relay: relay.url, name: "Studio", app: "1.0.0" };
  saved([{ destination: "bench" }]);
  app.state = "closed";
  const stream = follow();
  assert.equal((await stream.head()).head.status, 200);
  const closed = { machines: [{ id: "bench", name: "bench", otherAddresses: [], connection: "notConnected", status: "Kuvo Code isn’t open on Studio" }], hosts: [] };
  assert.deepEqual(JSON.parse(await stream.line()), closed);

  // The app opens: its lines, with no new request from the phone.
  app.state = "open";
  assert.deepEqual(JSON.parse(await stream.line()), appLine);

  // It quits halfway through a line: what's cut off is a line of its own, which a phone skips.
  for (const response of app.streams) {
    response.write("{\"half\":", () => setImmediate(() => response.destroy()));
  }
  app.streams.clear();
  app.state = "closed";
  assert.equal(await stream.line(), "{\"half\":");
  assert.deepEqual(JSON.parse(await stream.line()), closed);
  stream.stop();
  await stream.close();
});

test("an app that's stuck is answered for, as one that's closed", async () => {
  saved([{ destination: "lab" }]);
  app.state = "stuck";
  const front = link.macFront(async function* () {}, timing);
  const parts = [];
  for await (const part of front({ method: "GET", path: "kuvo/machines", headers: {}, body: Buffer.alloc(0) }, undefined, undefined)) parts.push(part);
  assert.equal(parts[0].head.status, 200);
  assert.equal(JSON.parse(parts[1].body).machines[0].id, "lab");
  app.state = "closed";
});

test("a stream carries on past an app that's stuck, or won't say, and finds it when it answers", async () => {
  saved([{ destination: "bench" }]);
  const own = { machines: [{ id: "bench", name: "bench", otherAddresses: [], connection: "notConnected", status: "Kuvo Code isn’t open on Studio" }], hosts: [] };
  for (const state of ["stuck", "wontSay"]) {
    app.state = state;
    const stream = follow();
    assert.equal((await stream.head()).head.status, 200, state);
    assert.deepEqual(JSON.parse(await stream.line()), own, state);
    app.state = "open";
    assert.deepEqual(JSON.parse(await stream.line()), appLine, state);
    stream.stop();
    await stream.close();
    for (const response of app.streams) response.destroy();
    app.streams.clear();
  }
  app.state = "closed";
});

test("a phone leaving stops the asking", async () => {
  saved([{ destination: "lab" }]);
  app.state = "stuck";
  // (The app's never given up on by itself here: only the phone leaving ends this.)
  const front = link.macFront(async function* () {}, { wait: 2_000_000_000, look: 2_000_000_000 });
  const stop = new AbortController();
  const pieces = front({ method: "GET", path: "kuvo/machines/events", headers: {}, body: Buffer.alloc(0) }, undefined, stop.signal);
  const asked = app.asked.length;
  const next = pieces.next();
  while (app.asked.length === asked) await new Promise(resolve => setImmediate(resolve));
  stop.abort();
  assert.equal((await next).done, true, "ended, with nothing more said");
  app.state = "closed";
});

test("the list going unreadable ends a stream, so what the app said last doesn't stand, and a phone's next try hears why", async () => {
  saved([{ destination: "bench" }]);
  app.state = "open";
  const stream = follow();
  await stream.head();
  assert.deepEqual(JSON.parse(await stream.line()), appLine);
  saved("{ not json");
  for (const response of app.streams) response.destroy();
  app.streams.clear();
  app.state = "closed";
  await stream.ended();
  const again = follow();
  assert.equal((await again.head()).head.status, 503);
  again.stop();
  await again.close();
  fs.rmSync(listFile, { force: true });
});

test("a list that can't be read as a stream starts says so, as a read does", async () => {
  saved("{ not json");
  app.state = "closed";
  const stream = follow();
  assert.equal((await stream.head()).head.status, 503);
  stream.stop();
  await stream.close();
  fs.rmSync(listFile, { force: true });
});

// What this Mac's box takes of the app's own areas itself, with the app closed too (#341).
async function asked(front, method, route) {
  const parts = [];
  for await (const part of front({ method, path: route, headers: {}, body: Buffer.alloc(0) }, undefined, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  return { status: parts[0].head.status, json: text ? JSON.parse(text) : undefined };
}

test("a phone restarts this Mac's engine through its keeper with the app closed; while the app runs the box itself, the app does", async () => {
  app.state = "closed";
  const run = path.join(box, "run"), bin = path.join(box, "bin");
  fs.mkdirSync(run, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  // The keeper's `kuvo-start`, as it writes it (`--box-control`): here, what it was asked.
  const told = path.join(support, "keeper-told");
  fs.writeFileSync(path.join(bin, "kuvo-start"), `#!/bin/sh\necho "$@" >"${told}"\n`, { mode: 0o700 });
  const front = link.macFront(link.engineHandler(() => ({ pid: process.pid, port: 1, password: "p" })));
  const keeper = path.join(run, "keeper.json");
  try {
    // The keeper runs (this process stands for it): the box asks it, and the app isn't needed.
    fs.writeFileSync(keeper, JSON.stringify({ pid: process.pid, version: "1.0.0", build: "1", url: "http://127.0.0.1:9", password: "k", started: 0 }));
    const asking = app.asked.length;
    assert.equal((await asked(front, "POST", "kuvo/engine/restart")).status, 202);
    await link.toolRun();
    assert.equal(fs.readFileSync(told, "utf8").trim(), "restart");
    assert.equal(app.asked.length, asking, "the app wasn't asked");

    // No keeper running (its record left by one that's gone, or none): the app runs the box and
    // restarts its engine, and says it isn't there when it's closed.
    fs.rmSync(told);
    for (const record of [JSON.stringify({ pid: 999999, version: "1.0.0", build: "1", url: "", password: "", started: 0 }), null]) {
      if (record) fs.writeFileSync(keeper, record); else fs.rmSync(keeper);
      assert.equal((await asked(front, "POST", "kuvo/engine/restart")).status, 503);
      assert.equal(app.asked.at(-1).path, "kuvo/engine/restart");
      assert.equal(fs.existsSync(told), false);
    }
  } finally {
    for (const file of [keeper, told, path.join(bin, "kuvo-start")]) fs.rmSync(file, { force: true });
  }
});

test("this Mac's own Claude Code agents and commands come from its box with the app closed; one of its machines' are still the app's", async () => {
  app.state = "closed";
  const saved = process.env.HOME;
  process.env.HOME = path.join(support, "home");
  fs.mkdirSync(path.join(process.env.HOME, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(process.env.HOME, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Reviews\n---\nReview.\n");
  const front = link.macFront(link.engineHandler(() => { throw new Error("not running"); }));
  try {
    const own = await asked(front, "GET", "kuvo/claude-code");
    assert.equal(own.status, 200);
    assert.deepEqual(own.json.agents.map(agent => agent.path), [["agents", "reviewer"]]);
    // (Its machines' are the Mac's ~/.claude brought to them, which only the app answers.)
    assert.equal((await asked(front, "GET", "kuvo/claude-code?machine=lab")).status, 503);
    assert.equal(app.asked.at(-1).path, "kuvo/claude-code?machine=lab");
  } finally {
    process.env.HOME = saved;
  }
});

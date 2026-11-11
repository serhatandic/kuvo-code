// This Mac's box started again with its app closed, as the keeper starts it at login with Background
// Work on (PROTOCOL.md, "The relay, on this Mac's box"): it takes what the app last said of its link,
// so your phones and machines reach this Mac before the app opens, if it ever does, and a phone
// hears what this Mac is from its box. The phone link turned off stays off, and machines removed
// don't bring the link back. Real `serve` processes, one after another in the same folder; only the
// relay and what answers for the app (the keeper's host interface, the app closed) are stand-ins.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/mac-restart.test.js`.
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

const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-mac-restart-")));
removeAtEnd(support);

// The keeper's host interface with the app closed: this Mac's keys from your Keychain, and for the
// Mac's own routes, its word that the app isn't open (not the app's own answer).
const keeper = { asked: [] };
const keeperHost = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => {
    const given = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (request.url === "/hello") {
      const proof = crypto.createHmac("sha256", "host-password").update(`kuvo-host-hello\u0000${given.nonce}\u0000127.0.0.1:${keeperHost.address().port}`).digest("hex");
      return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ proof }));
    }
    if (request.headers.authorization !== "Bearer host-password") return response.writeHead(401).end();
    if (request.url === "/link/identity") return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(keys));
    if (request.url === "/link/route") {
      keeper.asked.push(given.path);
      return response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ message: "Kuvo Code isn’t open on this Mac." }));
    }
    response.writeHead(404).end();
  });
});
await new Promise(resolve => keeperHost.listen(0, "127.0.0.1", resolve));
atEnd(() => {
  keeperHost.closeAllConnections();
  keeperHost.close();
});

const box = path.join(support, "box");
const environment = {
  KUVO_HOME: box,
  KUVO_BOTS: path.join(support, "bots"),
  KUVO_WAKES: path.join(support, "wakes"),
  KUVO_BOX: "mac",
  KUVO_ENGINE_CONFIG: path.join(support, "opencode"),
  KUVO_KEYS: path.join(support, "keys"),
  KUVO_CHATS: path.join(support, "chats"),
  KUVO_HOST_URL: `http://127.0.0.1:${keeperHost.address().port}`,
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

// This Mac's box, as the keeper starts it: nothing tells it of its link unless a test does.
const running = new Set();
atEnd(() => { for (const child of running) child.kill(); });
async function serve() {
  const password = crypto.randomBytes(12).toString("hex");
  const child = spawn(process.execPath, [fileURLToPath(script), "serve"], { env: { ...process.env, ...environment, OPENCODE_PASSWORD: password }, stdio: ["pipe", "pipe", "inherit"] });
  running.add(child);
  const exited = new Promise(resolve => child.once("exit", resolve));
  let said = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) {
    said += chunk;
    if (said.includes("\n")) break;
  }
  const url = JSON.parse(said.split("\n")[0]).url;
  const asApp = async (method, route, body) => {
    const response = await fetch(`${url}/${route}`, {
      method,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "x-kuvo-from": "app", "content-type": "application/json" },
      body: body && JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  return {
    asApp,
    // The link's state once it's `wanted`, looked at every 50 ms for `within` ms: the last seen.
    async status(wanted, within = 15_000) {
      const until = Date.now() + within;
      let state;
      do {
        state = (await asApp("GET", "kuvo/link/status")).json?.state;
        if (state === wanted) return state;
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < until);
      return state;
    },
    // Gone as the keeper stops it (its stdin closes).
    async stop() {
      child.stdin.end();
      await exited;
      running.delete(child);
    },
  };
}

// A phone of this Mac's on the relay, opening sessions with it.
function phone() {
  const key = link.newKey();
  const device = relay.device();
  let session = crypto.randomInt(1, 2 ** 31);
  let transport = null;
  const frames = async () => {
    const message = link.readRelay(await device.next(30_000));
    if (message?.kind !== "deliver") return { kind: "unreachable" };
    return link.readFrame(message.payload);
  };
  return {
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
    async request(method, route) {
      for (const piece of link.pieces({ t: "req", id: crypto.randomInt(1, 2 ** 20), m: method, p: route, h: {} }, Buffer.alloc(0), true)) device.send(macAddress, link.frame(link.Frame.transport, session, transport.seal(piece)));
      const pieces = [];
      for (;;) {
        const next = await frames();
        if (next.kind !== link.Frame.transport) return { closed: true };
        const message = link.decodeMessage(transport.open(next.body));
        pieces.push(message);
        if (message.head.end === true) break;
      }
      return { status: pieces[0].head.s, json: JSON.parse(Buffer.concat(pieces.map(piece => piece.body)).toString() || "null") };
    },
  };
}

// Whether this Mac is on the relay, once the relay's seen it come or go (within a few seconds).
async function onRelay(wanted) {
  for (let tries = 0; tries < 100 && relay.has(macAddress) !== wanted; tries++) await new Promise(resolve => setTimeout(resolve, 50));
  return relay.has(macAddress);
}

const iphone = phone();
const listFile = path.join(box, "machines.json");

test("the phone link on, this Mac is back on the relay after its box starts again, before the app opens: a phone reaches it and hears what it is from its box", async () => {
  // The app, open, turns the link on and pairs a phone; then you restart, and only the keeper starts.
  const first = await serve();
  assert.equal((await first.asApp("PUT", "kuvo/link/config", { phones: true, machines: false, relay: relay.url, name: "Studio", app: "1.0.0" })).status, 200);
  const pairing = await first.asApp("POST", "kuvo/phones/pair");
  assert.equal(pairing.status, 200);
  assert.equal(await first.status("connected"), "connected");
  assert.equal((await iphone.open({ pair: new URL(pairing.json.link).searchParams.get("token") })).kind, "mac");
  await first.stop();
  assert.equal(await onRelay(false), false, "off the relay with it");

  const again = await serve();
  assert.equal(await again.status("connected"), "connected", "nothing told it of its link this time");
  assert.equal(await onRelay(true), true);
  const hello = await iphone.open();
  assert.deepEqual([hello.kind, hello.name, hello.app], ["mac", "Studio", "1.0.0"]);
  // What this Mac is, from its box: the app's closed.
  const info = await iphone.request("GET", "kuvo/info");
  assert.equal(info.status, 200);
  assert.deepEqual([info.json.kind, info.json.name, info.json.app, info.json.chats], ["mac", "Studio", "1.0.0", environment.KUVO_CHATS]);
  assert.deepEqual(info.json.features, link.macFeatures());
  // The box's own areas answer; the Mac's own say the app isn't answering.
  assert.equal((await iphone.request("GET", "kuvo/personalities")).status, 200);
  const usage = await iphone.request("GET", "kuvo/usage");
  assert.deepEqual([usage.status, usage.json.message], [503, "Kuvo Code on this Mac isn't answering. Try again in a moment."]);
  assert.deepEqual(keeper.asked, ["kuvo/usage"], "only the Mac's own went to the keeper, for the app");
  await again.stop();
});

test("the phone link turned off stays off after a restart: phones don't reach this Mac", async () => {
  const on = await serve();
  assert.equal(await on.status("connected"), "connected");
  assert.equal((await on.asApp("PUT", "kuvo/link/config", { phones: false, machines: false, relay: relay.url, name: "Studio", app: "1.0.0" })).status, 200);
  assert.equal(await on.status("off"), "off");
  await on.stop();
  assert.equal(await onRelay(false), false);

  const again = await serve();
  // Long enough for its first try, had it made one.
  assert.equal(await again.status("connected", 1500), "off");
  assert.ok(!relay.has(macAddress));
  assert.deepEqual(await iphone.open(), { refused: true });
  await again.stop();
});

test("for your machines alone: back on the relay while the list has one, not once the last is removed", async () => {
  fs.writeFileSync(listFile, JSON.stringify([{ destination: "lab" }]));
  const withOne = await serve();
  assert.equal(await withOne.status("connected"), "connected", "the phone link off, but a machine to meet");
  assert.equal(await onRelay(true), true);
  await withOne.stop();
  assert.equal(await onRelay(false), false);

  // Removed (the app writes the list as it removes the last), then a restart.
  fs.writeFileSync(listFile, "[]");
  const none = await serve();
  assert.equal(await none.status("connected", 1500), "off");
  assert.ok(!relay.has(macAddress));
  await none.stop();
  fs.rmSync(listFile, { force: true });
});

// The Work Queue across two of your computers, over the relay, both ways (PROTOCOL.md, "The Work
// Queue", Across your computers): an item an agent keeps on a machine takes its number from this
// Mac (the first computer you set up) and shows in this Mac's All view, saying it's on the
// machine; one handed from a bot here to a session there moves there once.
//
// This Mac's box (`serve`'s link, here, with its app a stand-in) and one of its machines
// (`kuvo-link.js run`, a process of its own, set up as the app sets one up over SSH). Only the
// relay, the app and the engines are stand-ins.
//
// Run with `node --test box/bridge-tests/work-queue-two-boxes.test.js`.
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
const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-work-queue-two-")));
removeAtEnd(support);
const macHome = path.join(support, "mac");
const machineHome = path.join(support, "machine");
for (const home of [macHome, machineHome]) fs.mkdirSync(path.join(home, "run"), { recursive: true });
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
};
const read = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

// What a box writes in another process, looked at every few milliseconds until it's there, or
// until the test runs out of time (`signal`).
let signal;
function eventually(found) {
  return new Promise((resolve, reject) => {
    const look = async () => {
      const value = await found();
      if (!value) return;
      clearInterval(timer);
      resolve(value);
    };
    const timer = setInterval(look, 50);
    signal?.addEventListener("abort", () => {
      clearInterval(timer);
      reject(new Error(`it never got there: ${found}`));
    }, { once: true });
    look();
  });
}
const body = request => new Promise(resolve => {
  const chunks = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { resolve({}); }
  });
});
const listening = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

// An engine with `sessions`, and the tool call each is making now (`calling`).
async function engineWith(sessions) {
  const calling = new Map();
  const all = new Map(sessions.map(each => [each.id, { time: { created: Date.now(), updated: Date.now() }, directory: "/work", ...each }]));
  const server = http.createServer(async (request, response) => {
    await body(request);
    const url = new URL(request.url, "http://x");
    const send = (status, data) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(status < 400 ? { data } : { message: data }));
    if (request.headers.authorization !== `Basic ${Buffer.from("opencode:pw").toString("base64")}`) return response.writeHead(401).end();
    if (url.pathname === "/api/session" && request.method === "GET") return send(200, [...all.values()].filter(each => !each.parentID && (url.searchParams.get("limit") !== "100" || each.listed)));
    if (url.pathname === "/api/session/active") return send(200, {});
    const match = url.pathname.match(/^\/api\/session\/([^/]+)(\/.*)?$/);
    const id = match && decodeURIComponent(match[1]);
    const session = id && all.get(id);
    if (!session) return send(404, "No such session.");
    if (!match[2]) return send(200, session);
    if (match[2] === "/message") {
      const call = calling.get(id);
      return send(200, call ? [{ id: "msg_1", type: "assistant", content: [{ type: "tool", name: `kuvo-browser_${call.name}`, callID: "call_1", state: { status: "running", input: call.args } }] }] : []);
    }
    return send(200, []);
  });
  const port = await listening(server);
  atEnd(() => { server.closeAllConnections(); server.close(); });
  return { port, password: "pw", calling };
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
atEnd(() => appHost.close());

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
const relay = await relayStandIn(link, { changed: () => {} });

// A bot here, and a session on the machine.
write(path.join(support, "bots", "bot_foreman0001", "bot.json"), { kuvo: 1, id: "bot_foreman0001", name: "Foreman", job: "Runs the release.", look: { color: "sky", shape: "round", face: "calm" }, created: "2026-11-01T09:00:00Z", updated: "2026-11-01T09:00:00Z" });
write(path.join(support, "bots", "bot_foreman0001", "session"), "ses_lead");
const macEngine = await engineWith([{ id: "ses_lead", title: "Foreman", listed: true }]);
const labEngine = await engineWith([{ id: "ses_far", title: "Importer", listed: true }]);
write(path.join(macHome, "run", "engine.json"), { port: macEngine.port, password: "pw" });
write(path.join(machineHome, "run", "engine.json"), { port: labEngine.port, password: "pw" });

// This Mac's keys, as your Keychain keeps them.
const macKey = link.newKey();
const macSecret = crypto.randomBytes(32);
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
// An agent's Work Queue tool on this Mac, while its conversation is making the call.
async function onMac(name, args, session = "ses_lead") {
  macEngine.calling.set(session, { name, args });
  try {
    return (await ask("POST", "kuvo/work-queue/tools", { name, arguments: args, session })).json;
  } finally {
    macEngine.calling.delete(session);
  }
}
const machineEnv = { PATH: process.env.PATH, HOME: support, KUVO_HOME: machineHome, TMPDIR: support };
const labPid = () => { try { return Number(fs.readFileSync(path.join(machineHome, "run", "link.pid"), "utf8")); } catch { return 0; } };

let lab = null;
before(async () => {
  assert.notEqual((await ask("PUT", "kuvo/link/config", { phones: false, machines: true, relay: relay.url, name: "Studio Mac", app: "0.9.0", features: ["mac", "work.elsewhere", "work-queue", "work-queue.elsewhere"] })).json?.state, "failed");
  const setup = await ask("GET", "kuvo/link/setup");
  const result = spawnSync(process.execPath, [script, "setup"], {
    input: JSON.stringify({ relay: relay.url, name: "lab", mac: link.publicOf(macKey).toString("base64url"), macSign: setup.json.macSign, docs: setup.json.docs, id: "lab" }),
    env: machineEnv,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  lab = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal((await ask("PUT", "kuvo/link/peers", { peers: [{ key: lab.key, sign: lab.sign, address: lab.address, name: "lab", id: "lab" }], moved: [] })).status, 200);
  link.runMacLink();
  link.runMacPeers();
});

atEnd(async () => {
  link.stopMacPeers();
  link.stopMacLink();
  const pid = labPid();
  if (pid > 0) {
    try { process.kill(pid, "SIGTERM"); } catch {}
    for (let tries = 0; tries < 200; tries++) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  await relay.close();
});

const labQueue = owner => read(path.join(machineHome, "run", "work-queue", "queues", `${owner}.json`))?.items ?? [];

test("an item kept on a machine takes its number from this Mac and shows in this Mac's All view, saying it's there; one a bot here hands to a session there moves there once", { timeout: 120_000 }, async t => {
  signal = t.signal;
  // This Mac is the first computer: it numbers its own at once.
  const own = await onMac("queue_add", { title: "Ship the release" });
  assert.match(own.text, /^Added #1 "Ship the release"/);

  // An agent on lab keeps one there (as its tool leaves it), with no number yet: lab asks this Mac.
  write(path.join(machineHome, "run", "work-queue", "queues", "ses_far.json"), { owner: "ses_far", items: [{ id: "wqi_labitemlabitemlabi01", owner: "ses_far", title: "Port the importer", body: "", category: "next", order: 0, notes: [], files: [], links: [], sessions: [], created: { at: Date.now(), by: { session: "ses_far", name: "Importer" } }, updated: { at: Date.now(), by: { session: "ses_far", name: "Importer" } } }] });
  const numbered = await eventually(() => labQueue("ses_far")[0]?.number);
  assert.ok(numbered > 1, `#${numbered}: from a block this Mac gave, past its own`);

  // This Mac's All view: lab's item, saying where it is.
  const shown = await eventually(async () => (await ask("GET", "kuvo/work-queue?owner=all")).json.items.find(item => item.number === numbered));
  assert.equal(shown.title, "Port the importer");
  assert.deepEqual(shown.computer, { key: lab.key, name: "lab", kind: "machine", id: "lab" });
  assert.equal((await ask("GET", `kuvo/work-queue/refs?refs=${numbered}`)).json.refs[numbered].computer.name, "lab");

  // The bot hands its own item to the session on lab: it moves there, once.
  const handed = await onMac("queue_hand", { item: "#1", to: "ses_far" });
  assert.equal(handed.isError, false, handed.text);
  assert.match(handed.text, /^Handing #1 "Ship the release" to Importer on lab/);
  const arrived = await eventually(() => labQueue("ses_far").find(item => item.number === 1));
  assert.equal(arrived.owner, "ses_far");
  assert.equal(arrived.handedBy, "ses_lead");
  assert.deepEqual(arrived.sessions.map(each => each.session), ["ses_far"]);
  await eventually(() => !read(path.join(macHome, "run", "work-queue", "queues", "ses_lead.json"))?.items?.length);
  // Still in the bot's view, now on lab, once lab tells it.
  const inView = await eventually(async () => (await ask("GET", "kuvo/work-queue?owner=ses_lead")).json.items.find(item => item.number === 1 && item.computer));
  assert.equal(inView.computer.name, "lab");
  assert.equal(labQueue("ses_far").filter(item => item.number === 1).length, 1);
});

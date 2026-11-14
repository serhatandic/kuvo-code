// Work on another of your computers (PROTOCOL.md, "Peers", `call`, start_session): a bot on this
// Mac starts a session on one of its machines as if it lived there, and lists and stops it from
// here; with the machine's link down it hears at once that nothing was started. The other way, a
// bot on the machine can't start work on this Mac until you allow it on this Mac, and then can.
//
// Two boxes over the relay, both ways: this Mac's (`serve`'s link, here, with its app a stand-in)
// and one of its machines (`kuvo-link.js run`, a process of its own, set up as the app sets one up
// over SSH, its tools asked as kuvo-browser.js asks them: `kuvo-link.js box route`). Only the relay,
// the app and the engines are stand-ins.
//
// Run with `node --test box/bridge-tests/start-elsewhere.test.js`.
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
const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-start-elsewhere-")));
removeAtEnd(support);
const macHome = path.join(support, "mac");
const machineHome = path.join(support, "machine");
for (const home of [macHome, machineHome]) fs.mkdirSync(path.join(home, "run"), { recursive: true });
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
};
const read = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

// Each time a stand-in records something: what a test waits on looks again; what a box writes in
// another process, every few milliseconds; until the test runs out of time (`signal`).
const waitingForChange = [];
const poke = () => { for (const resolve of waitingForChange.splice(0)) resolve(); };
let signal;
function eventually(found) {
  return new Promise((resolve, reject) => {
    const look = async () => {
      const value = await found();
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
const body = request => new Promise(resolve => {
  const chunks = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { resolve({}); }
  });
});
const listening = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

// An engine with `sessions` (each as the engine has it): what's prompted in each, what's
// interrupted and summarized, the asks each has and how each was answered. Its list of the latest
// for list_agents (`limit=100`) names only those marked `listed`, as a box names only its latest 40.
async function engineWith(sessions) {
  const seen = { prompts: [], interrupted: [], compacted: [], replied: [], asks: new Map(), made: [] };
  const all = new Map(sessions.map(each => [each.id, { time: { created: Date.now(), updated: Date.now() }, directory: "/work", ...each }]));
  const server = http.createServer(async (request, response) => {
    const given = await body(request);
    const url = new URL(request.url, "http://x");
    const send = (status, data) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(status < 400 ? { data } : { message: data }));
    if (request.headers.authorization !== `Basic ${Buffer.from("opencode:pw").toString("base64")}`) return response.writeHead(401).end();
    if (url.pathname === "/api/session" && request.method === "GET") {
      const parent = url.searchParams.get("parentID");
      let listed = [...all.values()].filter(each => (parent && parent !== "null" ? each.parentID === parent : !each.parentID));
      if (url.searchParams.get("limit") === "100") listed = listed.filter(each => each.listed);
      return send(200, listed);
    }
    if (url.pathname === "/api/session" && request.method === "POST") {
      const id = `ses_new${crypto.randomBytes(4).toString("hex")}`;
      const made = { id, time: { created: Date.now(), updated: Date.now() }, directory: given.location?.directory, title: given.title ?? "New Session", permissions: given.permissions, metadata: given.metadata, ...(given.agent ? { agent: given.agent } : {}) };
      all.set(id, made);
      seen.made.push(made);
      poke();
      return send(200, made);
    }
    if (url.pathname === "/api/session/active") return send(200, {});
    if (url.pathname === "/api/provider") return send(200, [{ id: "p" }]);
    if (url.pathname === "/api/model") return send(200, [{ id: "m1", providerID: "p", name: "Model One" }]);
    // (Its accounts, as Settings › Accounts lists them: p is one of your own, with nothing to sign in to.)
    if (url.pathname === "/api/integration") return send(200, []);
    if (url.pathname.startsWith("/api/experimental/")) return send(200, {});
    const match = url.pathname.match(/^\/api\/session\/([^/]+)(\/.*)?$/);
    const id = match && decodeURIComponent(match[1]);
    const session = id && all.get(id);
    if (!session) return send(404, "No such session.");
    const rest = match[2] ?? "";
    if (!rest && request.method === "GET") return send(200, session);
    if (!rest && request.method === "PATCH") {
      if (given.metadata) session.metadata = { ...(session.metadata ?? {}), ...given.metadata };
      if (given.permissions) session.permissions = given.permissions;
      return send(200, session);
    }
    if (rest === "/prompt") {
      seen.prompts.push({ session: id, text: given.text, metadata: given.metadata });
      poke();
      return send(200, {});
    }
    if (rest === "/interrupt") {
      seen.interrupted.push(id);
      return send(200, {});
    }
    if (rest === "/compact") {
      seen.compacted.push(id);
      return send(200, {});
    }
    if (rest === "/permission") return send(200, (seen.asks.get(id) ?? []).map(ask => ({ ...ask, sessionID: id })));
    if (rest === "/form") return send(200, []);
    const reply = rest.match(/^\/permission\/([^/]+)\/reply$/);
    if (reply) {
      seen.replied.push({ session: id, ask: decodeURIComponent(reply[1]), ...given });
      seen.asks.set(id, (seen.asks.get(id) ?? []).filter(ask => ask.id !== decodeURIComponent(reply[1])));
      return send(200, {});
    }
    if (rest === "/message") return send(200, [{ id: "msg_1", type: "user", content: [{ type: "text", text: `The task of ${session.title}.` }] }, { id: "msg_2", type: "assistant", content: [{ type: "text", text: `Working on ${session.title}.` }] }].reverse());
    if (rest === "/background" && request.method === "DELETE") return send(200, {});
    return send(200, {});
  });
  const port = await listening(server);
  atEnd(() => { server.closeAllConnections(); server.close(); });
  return { port, password: "pw", seen, all };
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
  KUVO_CHATS: path.join(support, "chats"),
  KUVO_ENGINE_CONFIG: path.join(support, "opencode"),
  KUVO_KEYS: path.join(support, "keys"),
  KUVO_HOST_URL: `http://127.0.0.1:${appHost.address().port}`,
  KUVO_HOST_PASSWORD: "host-password",
});
const link = await import("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js");
const relay = await relayStandIn(link, { changed: poke });

// Foreman, a bot that lives on this Mac now: it moved here from lab, and left its sessions there.
// Wren lives on lab: it moved there from this Mac, and left its sessions here.
const by = { bot: "bot_foreman0001", name: "Foreman" };
write(path.join(support, "bots", "bot_foreman0001", "bot.json"), { kuvo: 1, id: "bot_foreman0001", name: "Foreman", job: "Runs the release.", look: { color: "sky", shape: "round", face: "calm" }, created: "2026-11-01T09:00:00Z", updated: "2026-11-01T09:00:00Z" });
write(path.join(support, "bots", "bot_foreman0001", "session"), "ses_lead");
const macEngine = await engineWith([
  { id: "ses_lead", title: "Foreman", listed: true, permissions: [], model: { providerID: "p", id: "m1" } },
  { id: "ses_mleft1", title: "Docs pass", metadata: { kuvo: { startedBy: "ses_wren", depth: 1 } } },
  { id: "ses_mine", title: "My own", listed: true },
]);
const labEngine = await engineWith([
  { id: "ses_wren", title: "Wren", listed: true, permissions: [], model: { providerID: "p", id: "m1" } },
  { id: "ses_left1", title: "Sign-in", metadata: { kuvo: { startedBy: "ses_lead", depth: 1, by } } },
  // (In Accept Edits: a session in Ask First is always the user's to answer, so a bot can't allow what it asks.)
  { id: "ses_left2", title: "Billing", permissions: [{ action: "shell", resource: "*", effect: "ask" }], metadata: { kuvo: { startedBy: "ses_lead", depth: 1, by, approval: "acceptEdits", applied: "acceptEdits" } } },
  { id: "ses_left3", title: "Old work", metadata: { kuvo: { startedBy: "ses_lead", depth: 1, by } } },
  { id: "ses_user", title: "The user's own", listed: true },
  { id: "ses_user_old", title: "The user's archived", metadata: { kuvo: { archived: true } } },
]);
labEngine.seen.asks.set("ses_left2", [{ id: "per_1", action: "shell", resources: ["git status"] }]);
// A project on each.
for (const [where, name] of [[macHome, "site"], [machineHome, "api"]]) {
  fs.mkdirSync(path.join(support, "projects", name), { recursive: true });
  write(path.join(where, "box", "projects.json"), { projects: [{ directory: path.join(support, "projects", name), folders: [] }] });
}
write(path.join(macHome, "run", "engine.json"), { port: macEngine.port, password: "pw" });
write(path.join(machineHome, "run", "engine.json"), { port: labEngine.port, password: "pw" });

// This Mac's keys, as your Keychain keeps them.
const macKey = link.newKey();
const macSecret = crypto.randomBytes(32);
const macAddress = link.addressOf(macSecret);
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
// A tool on this Mac, from Foreman's conversation.
const onMac = async (name, args) => (await ask("POST", "kuvo/agent-tools", { name, arguments: args, session: "ses_lead" })).json;
// A tool on lab, from Wren's conversation, as kuvo-browser.js asks it there: a process of its own.
const machineEnv = { PATH: process.env.PATH, HOME: support, KUVO_HOME: machineHome, TMPDIR: support };
function onLab(name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "box", "route"], { env: machineEnv, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("error", reject);
    child.on("close", () => {
      const said = JSON.parse(out.trim().split("\n").pop());
      resolve(JSON.parse(said.body));
    });
    child.stdin.end(JSON.stringify({ method: "POST", path: "kuvo/agent-tools", body: { name, arguments: args, session: "ses_wren" } }));
  });
}
const labPid = () => { try { return Number(fs.readFileSync(path.join(machineHome, "run", "link.pid"), "utf8")); } catch { return 0; } };
async function stopLab() {
  const pid = labPid();
  if (pid > 0) {
    try { process.kill(pid, "SIGTERM"); } catch {}
    for (let tries = 0; tries < 200; tries++) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}
function startLab() {
  spawn(process.execPath, [script, "run"], { env: machineEnv, detached: true, stdio: "ignore", cwd: machineHome }).unref();
}

let lab = null;
before(async () => {
  assert.notEqual((await ask("PUT", "kuvo/link/config", { phones: false, machines: true, relay: relay.url, name: "Studio Mac", app: "0.9.0", features: ["mac", "letters-read", "work.elsewhere", "work.elsewhere.start", "approval.otherComputers"] })).json?.state, "failed");
  const setup = await ask("GET", "kuvo/link/setup");
  const result = spawnSync(process.execPath, [script, "setup"], {
    input: JSON.stringify({ relay: relay.url, name: "lab", mac, macSign: setup.json.macSign, docs: setup.json.docs, id: "lab" }),
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
  await stopLab();
  await relay.close();
});

const sendingOn = home => { try { return fs.readdirSync(path.join(home, "run", "outbox", "sending")).filter(name => name.endsWith(".json")); } catch { return []; } };
// Each box knows the other takes starts: its agents' mail has said so.
const takesStarts = (home, key) => (read(path.join(home, "run", "peer-agents.json"))?.[key]?.features ?? []).includes("work.elsewhere.start");

test("a bot on this Mac starts a session on the machine as if it lived there, then lists and stops it from here", { timeout: 90_000 }, async t => {
  signal = t.signal;
  await eventually(() => takesStarts(macHome, lab.key));
  const said = await onMac("start_session", { computer: "lab", project: "api", title: "Sign-in", task: "Fix the sign-in." });
  assert.equal(said.isError, false, said.text);
  const made = labEngine.seen.made.at(-1);
  assert.ok(made, "made on lab");
  assert.match(said.text, new RegExp(`^\\[On lab\\] Started "Sign-in" in api \\(address ${made.id}\\)`));
  assert.equal(made.directory, path.join(support, "projects", "api"));
  assert.deepEqual(made.metadata.kuvo.lead, { box: "Studio Mac", key: mac, name: "Foreman" });
  assert.deepEqual(made.metadata.kuvo.by, by);
  const told = await eventually(() => labEngine.seen.prompts.find(each => each.session === made.id));
  assert.match(told.text, /^\[Message from Foreman on Studio Mac · ses_lead\]/);
  // Nothing came to the bot as a message: its answer went to its tool.
  assert.equal(macEngine.seen.prompts.filter(each => each.session === "ses_lead").length, 0);

  // From here, the bot lists it and stops it, as one of its own.
  const list = await onMac("list_sessions", {});
  assert.match(list.text, new RegExp(`On lab, the latest first:\\n- Sign-in \\(address ${made.id}\\)`));
  assert.deepEqual(await onMac("stop_session", { session: made.id }), { text: "Stopped \"Sign-in\".", isError: false });
  assert.ok(labEngine.seen.interrupted.includes(made.id));
  // Its models and projects, read from here.
  assert.match((await onMac("list_projects", { computer: "lab" })).text, /^Projects on lab:\n- api: /);
  assert.match((await onMac("list_models", { computer: "lab" })).text, /p\/m1 \(Model One\)/);
});

test("with the machine's link down, a start there is refused at once, and nothing's left to start it later", { timeout: 90_000 }, async t => {
  signal = t.signal;
  await stopLab();
  await eventually(() => !relay.has(Buffer.from(lab.address, "base64url")));
  const made = labEngine.seen.made.length;
  const began = Date.now();
  const said = await onMac("start_session", { computer: "lab", project: "api", task: "Fix the sign-in." });
  assert.ok(Date.now() - began < 2000, `took ${Date.now() - began} ms`);
  assert.equal(said.isError, true);
  assert.match(said.text, /^lab isn't answering: it may be asleep, off or offline, so nothing was started\./);
  assert.deepEqual(sendingOn(macHome).filter(name => name.startsWith("cal_")), []);
  startLab();
  await eventually(() => relay.has(Buffer.from(lab.address, "base64url")));
  assert.equal(labEngine.seen.made.length, made);
});

test("the other way: a bot on the machine can't start work on this Mac until you allow it here, then can", { timeout: 90_000 }, async t => {
  signal = t.signal;
  await eventually(() => relay.has(Buffer.from(lab.address, "base64url")) && takesStarts(machineHome, mac));
  assert.equal((await ask("GET", "kuvo/approval")).json.otherComputers, false, "off on the Mac with the app");
  const refused = await onLab("start_session", { computer: "Studio Mac", project: "site", task: "Update the docs." });
  assert.deepEqual(refused, { text: "On Studio Mac: Studio Mac doesn't take work from your other computers. Ask the user to allow it in Settings › Permissions on Studio Mac.", isError: true });
  assert.equal(macEngine.seen.made.length, 0);

  const allowed = await ask("PATCH", "kuvo/approval", { otherComputers: true });
  assert.deepEqual([allowed.status, allowed.json.otherComputers], [200, true]);
  const said = await onLab("start_session", { computer: "the Mac", project: "site", title: "Docs", task: "Update the docs." });
  assert.equal(said.isError, false, said.text);
  const made = macEngine.seen.made.at(-1);
  assert.match(said.text, new RegExp(`^\\[On Studio Mac\\] Started "Docs" in site \\(address ${made.id}\\)`));
  assert.deepEqual(made.metadata.kuvo.lead, { box: "lab", key: lab.key, name: "Wren" });
});

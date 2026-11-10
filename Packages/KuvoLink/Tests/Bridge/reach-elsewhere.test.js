// Reach what you started, anywhere (PROTOCOL.md, "Peers", `call`, and "Work", `rows`): a bot that
// moved from one of your computers to another still lists, reads, answers, summarizes and stops the
// sessions it left behind, from where it lives now; with that computer away, it hears so at once,
// with the rows it was last told, and a stop it gives then is done once that computer is back.
//
// Two boxes over the relay, both ways: this Mac's (`serve`'s link, here, with its app a stand-in)
// and one of its machines (`kuvo-link.js run`, a process of its own, set up as the app sets one up
// over SSH, its tools asked as kuvo-browser.js asks them: `kuvo-link.js box route`). Only the relay,
// the app and the engines are stand-ins.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/reach-elsewhere.test.js`.
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

const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-reach-elsewhere-")));
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
  const seen = { prompts: [], interrupted: [], compacted: [], replied: [], asks: new Map() };
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
    if (url.pathname === "/api/session/active") return send(200, {});
    const match = url.pathname.match(/^\/api\/session\/([^/]+)(\/.*)?$/);
    const id = match && decodeURIComponent(match[1]);
    const session = id && all.get(id);
    if (!session) return send(404, "No such session.");
    const rest = match[2] ?? "";
    if (!rest && request.method === "GET") return send(200, session);
    if (!rest && request.method === "PATCH") {
      if (given.metadata) session.metadata = given.metadata;
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
  KUVO_ENGINE_CONFIG: path.join(support, "opencode"),
  KUVO_KEYS: path.join(support, "keys"),
  KUVO_HOST_URL: `http://127.0.0.1:${appHost.address().port}`,
  KUVO_HOST_PASSWORD: "host-password",
});
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
const relay = await relayStandIn(link, { changed: poke });

// Foreman, a bot that lives on this Mac now: it moved here from lab, and left its sessions there.
// Wren lives on lab: it moved there from this Mac, and left its sessions here.
const by = { bot: "bot_foreman0001", name: "Foreman" };
write(path.join(support, "bots", "bot_foreman0001", "bot.json"), { kuvo: 1, id: "bot_foreman0001", name: "Foreman", job: "Runs the release.", look: { color: "sky", shape: "round", face: "calm" }, created: "2026-11-01T09:00:00Z", updated: "2026-11-01T09:00:00Z" });
write(path.join(support, "bots", "bot_foreman0001", "session"), "ses_lead");
const macEngine = await engineWith([
  { id: "ses_lead", title: "Foreman", listed: true, permissions: [] },
  { id: "ses_mleft1", title: "Docs pass", metadata: { kuvo: { startedBy: "ses_wren", depth: 1 } } },
  { id: "ses_mine", title: "My own", listed: true },
]);
const labEngine = await engineWith([
  { id: "ses_wren", title: "Wren", listed: true, permissions: [] },
  { id: "ses_left1", title: "Sign-in", metadata: { kuvo: { startedBy: "ses_lead", depth: 1, by } } },
  // (In Accept Edits: a session in Ask First is always the user's to answer, so a bot can't allow what it asks.)
  { id: "ses_left2", title: "Billing", permissions: [{ action: "shell", resource: "*", effect: "ask" }], metadata: { kuvo: { startedBy: "ses_lead", depth: 1, by, approval: "acceptEdits", applied: "acceptEdits" } } },
  { id: "ses_left3", title: "Old work", metadata: { kuvo: { startedBy: "ses_lead", depth: 1, by } } },
  { id: "ses_user", title: "The user's own", listed: true },
  { id: "ses_user_old", title: "The user's archived", metadata: { kuvo: { archived: true } } },
]);
labEngine.seen.asks.set("ses_left2", [{ id: "per_1", action: "shell", resources: ["git status"] }]);
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
// A route on lab, as kuvo-browser.js asks one there: a process of its own (`box route`).
const machineEnv = { PATH: process.env.PATH, HOME: support, KUVO_HOME: machineHome, TMPDIR: support };
function routeOnLab(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "box", "route"], { env: machineEnv, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("error", reject);
    child.on("close", () => {
      const said = JSON.parse(out.trim().split("\n").pop());
      resolve(JSON.parse(said.body));
    });
    child.stdin.end(JSON.stringify(request));
  });
}
// A tool on lab, from Wren's conversation.
const onLab = (name, args) => routeOnLab({ method: "POST", path: "kuvo/agent-tools", body: { name, arguments: args, session: "ses_wren" } });
const timed = async (run) => {
  const began = Date.now();
  const value = await run();
  return { value, took: Date.now() - began };
};
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
  assert.notEqual((await ask("PUT", "kuvo/link/config", { phones: false, machines: true, relay: relay.url, name: "Studio Mac", app: "0.9.0", features: ["mac", "letters-read", "work.elsewhere"] })).json?.state, "failed");
  const setup = await ask("GET", "kuvo/link/setup");
  const result = spawnSync(process.execPath, [script, "setup"], {
    input: JSON.stringify({ relay: relay.url, name: "lab", mac, macSign: setup.json.macSign, docs: setup.json.docs, id: "lab" }),
    env: machineEnv,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  lab = JSON.parse(result.stdout.trim().split("\n").at(-1));
  // Each box's record of the bot that moved away from it.
  const hourAgo = Date.now() - 3_600_000;
  write(path.join(machineHome, "run", "moves", "moved.json"), [{ session: "ses_lead", key: mac, at: hourAgo }]);
  write(path.join(macHome, "run", "moves", "moved.json"), [{ session: "ses_wren", key: lab.key, at: hourAgo }]);
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

const rowsOn = (home, key) => read(path.join(home, "run", "work", "elsewhere", `${key}.json`));

test("a bot that moved here lists, reads, answers, summarizes and stops the sessions it left on the machine", { timeout: 90_000 }, async t => {
  signal = t.signal;
  // The machine tells this Mac of them, unasked, as soon as it sees the move.
  const kept = await eventually(() => rowsOn(macHome, lab.key)?.leads?.ses_lead?.length === 3 && rowsOn(macHome, lab.key));
  assert.deepEqual(kept.leads.ses_lead.map(row => row.session).sort(), ["ses_left1", "ses_left2", "ses_left3"], "only the bot's own");
  // One of them put away since.
  labEngine.all.get("ses_left3").metadata.kuvo.archived = true;

  const list = await onMac("list_sessions", {});
  assert.equal(list.isError, false);
  assert.match(list.text, /^On lab, the latest first:/m);
  assert.match(list.text, /- Sign-in \(address ses_left1\), in work: /);
  assert.match(list.text, /- Billing \(address ses_left2\), in work: asks to run a command: git status \(ask per_1\)/);
  assert.doesNotMatch(list.text, /ses_user|ses_left3/);

  // Read by address, though lab's list of its agents doesn't name it; and its own archived one.
  const read1 = await onMac("read_conversation", { of: "ses_left1" });
  assert.equal(read1.isError, false, read1.text);
  assert.match(read1.text, /Working on Sign-in\./);
  const archived = await onMac("read_conversation", { of: "ses_left3" });
  assert.equal(archived.isError, false, archived.text);
  assert.match(archived.text, /Working on Old work\./);

  const allowed = await onMac("answer_ask", { session: "ses_left2", ask: "per_1", decision: "allow", reason: "Status is harmless." });
  assert.deepEqual(allowed, { text: "Allowed: git status.", isError: false });
  assert.deepEqual(labEngine.seen.replied.map(each => [each.session, each.ask, each.decision]), [["ses_left2", "per_1", "once"]]);
  // Kept on the session, by the bot, as an answer here is.
  assert.deepEqual(labEngine.all.get("ses_left2").metadata.kuvo.answers.map(each => [each.ask, each.decision, each.by.name]), [["per_1", "allow", "Foreman"]]);

  assert.match((await onMac("compact_session", { session: "ses_left1" })).text, /^Summarizing "Sign-in" now\./);
  assert.deepEqual(labEngine.seen.compacted, ["ses_left1"]);
  assert.deepEqual(await onMac("stop_session", { session: "ses_left1" }), { text: "Stopped \"Sign-in\".", isError: false });
  assert.ok(labEngine.seen.interrupted.includes("ses_left1"));

  // What isn't its own isn't its to stop, wherever it is.
  const notMine = await onMac("stop_session", { session: "ses_user" });
  assert.equal(notMine.isError, true);
  assert.match(notMine.text, /isn't yours to stop/);
  assert.ok(!labEngine.seen.interrupted.includes("ses_user"));
  // Nothing was told to the bot as a message along the way: each answer went to its tool.
  assert.equal(macEngine.seen.prompts.filter(each => each.session === "ses_lead").length, 0);
});

test("with the machine's link down: in under 2 s the bot hears it isn't answering, with the rows it has; a stop it gives then is done once it's back", { timeout: 90_000 }, async t => {
  signal = t.signal;
  await eventually(() => rowsOn(macHome, lab.key));
  await stopLab();
  await eventually(() => !relay.has(Buffer.from(lab.address, "base64url")));

  const began = Date.now();
  const list = await onMac("list_sessions", {});
  const took = Date.now() - began;
  assert.ok(took < 2000, `took ${took} ms`);
  assert.match(list.text, /^On lab, as of .+\. lab isn't answering \(it may be asleep, off or offline\)/m);
  assert.match(list.text, /\(address ses_left2\)/);

  const reading = Date.now();
  const read1 = await onMac("read_conversation", { of: "ses_left2" });
  assert.ok(Date.now() - reading < 2000);
  assert.equal(read1.isError, true);
  assert.match(read1.text, /lab isn't answering/);

  const stop = await onMac("stop_session", { session: "ses_left2" });
  assert.equal(stop.isError, false);
  assert.match(stop.text, /^lab isn't answering \(it may be asleep, off or offline\)\. Your stop is kept and done when it's back/);
  assert.ok(!labEngine.seen.interrupted.includes("ses_left2"));

  // It's back: the stop is done, and how it went comes to the bot as a message.
  startLab();
  await eventually(() => labEngine.seen.interrupted.includes("ses_left2"));
  const told = await eventually(() => macEngine.seen.prompts.find(each => each.session === "ses_lead"));
  assert.equal(told.text, "[On lab] Stopped \"Billing\".");
  assert.equal(told.metadata?.kuvo?.note?.from, "lab", "as that computer's own word");
  // Once: nothing of it is left on its way, on either box, to come again.
  const onItsWay = home => { try { return fs.readdirSync(path.join(home, "run", "outbox", "sending")).filter(name => name.endsWith(".json")); } catch { return []; } };
  await eventually(() => !onItsWay(macHome).length && !onItsWay(machineHome).length);
  assert.equal(macEngine.seen.prompts.filter(each => each.session === "ses_lead").length, 1);
  assert.equal(labEngine.seen.interrupted.filter(each => each === "ses_left2").length, 1);
});

test("the other way: a bot that moved to the machine reaches the sessions it left on this Mac, and a stop waits for this Mac's link", { timeout: 120_000 }, async t => {
  signal = t.signal;
  await eventually(() => relay.has(Buffer.from(lab.address, "base64url")));
  const kept = await eventually(() => rowsOn(machineHome, mac)?.leads?.ses_wren?.length && rowsOn(machineHome, mac));
  assert.deepEqual(kept.leads.ses_wren.map(row => row.session), ["ses_mleft1"]);

  const list = await onLab("list_sessions", {});
  assert.match(list.text, /^On Studio Mac, the latest first:\n- Docs pass \(address ses_mleft1\)/m);
  assert.match((await onLab("read_conversation", { of: "ses_mleft1" })).text, /Working on Docs pass\./);
  assert.match((await onLab("compact_session", { session: "ses_mleft1" })).text, /^Summarizing "Docs pass" now\./);
  assert.deepEqual(macEngine.seen.compacted, ["ses_mleft1"]);

  // This Mac's link stops: the machine hears it isn't answering, and its stop waits for it.
  link.stopMacLink();
  await eventually(() => !relay.has(macAddress));
  // (A process of its own, as a machine's tools are: its call goes the moment the machine's link
  // sees it in its outbox, and the relay's word comes back as fast. What that adds is timed, past
  // what a box route takes that asks nothing: on a busy Mac, starting one alone takes seconds.)
  const asksNothing = await timed(() => routeOnLab({ method: "GET", path: "kuvo/info" }));
  const { took, value: away } = await timed(() => onLab("list_sessions", {}));
  assert.ok(took - asksNothing.took < 2000, `took ${took} ms, ${asksNothing.took} ms for one that asks nothing`);
  // The relay's word, not the call's wait (20 s) running out.
  assert.match(away.text, /^On Studio Mac, as of .+\. Studio Mac isn't answering \(it may be asleep, off or offline\)/m);
  const stop = await onLab("stop_session", { session: "ses_mleft1" });
  assert.match(stop.text, /^Studio Mac isn't answering .+ Your stop is kept/);
  assert.ok(!macEngine.seen.interrupted.includes("ses_mleft1"));
  link.runMacLink();
  await eventually(() => macEngine.seen.interrupted.includes("ses_mleft1"));
  const told = await eventually(() => labEngine.seen.prompts.find(each => each.session === "ses_wren"));
  assert.equal(told.text, "[On Studio Mac] Stopped \"Docs pass\".");
});

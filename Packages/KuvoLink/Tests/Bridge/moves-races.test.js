// Move to Computer when the two boxes' steps cross (PROTOCOL.md, `kuvo/moves`): one box, real,
// against a scripted other computer, whose mail it would send over the relay goes to the script
// instead (`sendMovesWith`). Whatever comes in what order, a move never leaves both copies gone,
// nor two live: a copy that couldn't be set up as it arrived leaves the original as it was; a switch
// the other computer can't honour (it let its copy go) leaves the original; parts that come twice
// set a copy up once; and a box answers a step for a move it doesn't have as dropped, never as
// switched. This Mac's box, here; its engine a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/moves-races.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test as nodeTest } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

// What's under way, as `kuvo/moves` says it (not what moved away lately, `moved`, which stays two days).
const underWay = ({ moved: _moved, ...rest } = {}) => rest;

// Each fails, rather than hangs, when what it waits for never comes: once it's failed or out of
// time, what it still waits for stops waiting too (its signal, `running`), so the file can end.
let running;
const test = (name, run) => nodeTest(name, { timeout: 30_000 }, t => {
  running = t.signal;
  return run(t);
});

const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-moves-races-")));
const home = path.join(support, "mac");
const chats = path.join(support, "Chats"), wakes = path.join(support, "wakes");
fs.mkdirSync(path.join(home, "run"), { recursive: true });
Object.assign(process.env, {
  KUVO_HOME: home, KUVO_BOTS: path.join(support, "bots"), KUVO_WAKES: wakes, KUVO_BOX: "mac",
  KUVO_ENGINE_CONFIG: path.join(support, "opencode"), KUVO_KEYS: path.join(support, "keys"),
});
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

// An engine with its conversations, as its API exports, imports and deletes them; it counts imports.
// Its imports can be held (`hold`, a promise: a big one on a small machine), and its deletes fail
// (`down`: the engine went away; or one conversation's, `downFor`), as can one's export
// (`exportFails`, counted in `exportsRefused`).
const engine = { sessions: new Map(), imports: 0, hold: null, holding: false, down: false, downFor: null, refused: 0, exportFails: null, exportsRefused: 0 };
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => {
    const given = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const url = new URL(request.url, "http://x");
    const send = (status, data) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ data }));
    const listed = each => ({ id: each.id, title: each.title, directory: each.directory, location: { directory: each.directory }, ...(each.metadata ? { metadata: each.metadata } : {}), ...(each.time ? { time: each.time } : {}) });
    // (Those at the top, `parentID=null`, only those another conversation started: the work lists'.)
    const parent = url.searchParams.get("parentID");
    if (url.pathname === "/api/session" && parent) return send(200, [...engine.sessions.values()].filter(each => parent === "null" ? !each.parentID && each.metadata : each.parentID === parent).map(listed));
    if (url.pathname === "/api/session/active") return send(200, engine.active ?? {});
    if (url.pathname === "/api/provider") return send(200, [{ id: "opencode" }]);
    if (url.pathname === "/api/experimental/session/import") {
      const bring = () => {
        if (engine.sessions.has(given.info.id)) return response.writeHead(409).end("{}");
        if (engine.refuse === given.info.id) return response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ message: "The disk is full." }));
        engine.imports += 1;
        engine.sessions.set(given.info.id, { id: given.info.id, title: given.info.title, parentID: given.info.parentID, directory: given.location.directory, messages: given.messages });
        return send(200, listed(engine.sessions.get(given.info.id)));
      };
      if (!engine.hold) return bring();
      engine.holding = true;
      return void engine.hold.then(() => { engine.holding = false; bring(); });
    }
    const exported = url.pathname.match(/^\/api\/experimental\/session\/([^/]+)\/export$/);
    if (exported) {
      const session = engine.sessions.get(exported[1]);
      if (session && engine.exportFails === session.id) {
        engine.exportsRefused += 1;
        return response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ message: "It couldn't be read." }));
      }
      return session ? send(200, { info: { id: session.id, title: session.title, ...(session.parentID ? { parentID: session.parentID } : {}) }, messages: session.messages }) : send(404, null);
    }
    const match = url.pathname.match(/^\/api\/session\/([^/]+)(\/inbox|\/interrupt|\/prompt|\/message)?$/);
    const session = match && engine.sessions.get(match[1]);
    if (!session) return send(404, null);
    if (match[2] === "/inbox") return send(200, []);
    if (match[2] === "/message") return send(200, session.replies ?? []);
    if (match[2]) return send(200, true);
    if (request.method === "DELETE") {
      if (engine.down || engine.downFor === session.id) {
        engine.refused += 1;
        return response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ message: "The engine went away." }));
      }
      engine.sessions.delete(session.id);
      return send(200, true);
    }
    return send(200, listed(session));
  });
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify({ port: server.address().port, password: "pw" }));

// This Mac's box, and its one other computer, "lab": what lab is told goes to `script`, and what
// lab says comes back as its mail would.
const labSecret = link.newKey();
const peerKey = link.publicOf(labSecret).toString("base64url");
const lab = { key: peerKey, address: link.addressOf(crypto.randomBytes(32)).toString("base64url"), kind: "machine", name: "lab", id: "lab", sign: link.signingKeyOf(link.newSigningSeed()) };
// And another computer, "studio".
const studio = { key: link.publicOf(link.newKey()).toString("base64url"), address: link.addressOf(crypto.randomBytes(32)).toString("base64url"), kind: "machine", name: "studio", id: "studio" };
link.writeLink({ macPeers: [lab, studio] });
// Its keys, as its app gives them (kept in your Keychain, never in its files).
const macSecret = link.newKey();
link.macLink.overlay = { key: macSecret.toString("base64url"), secret: crypto.randomBytes(32).toString("base64url"), relay: "wss://relay.test", name: "Studio Mac" };
const told = [];
let script = () => {};
const toScript = (_peer, move) => {
  told.push(move);
  setImmediate(() => script(move));
  return true;
};
link.sendMovesWith(toScript);
const say = move => link.takeMoveMail(lab, move);
// Its relay connection, which takes what it's given (a test's own, `relay`, for one that doesn't).
let relay = { send: () => true };
let stop = new AbortController();
let done = false;
link.watchMoves(() => relay, stop.signal);
removeAtEnd(support);
atEnd(() => {
  done = true;
  stop.abort();
  link.sendMovesWith(null);
  server.closeAllConnections();
  server.close();
});

const handle = link.engineHandler(link.readEngineFile, { name: "Mac" }, link.readBridgeFile, () => {}, null);
async function ask(method, p, given) {
  const parts = [];
  for await (const part of handle({ method, path: p, headers: {}, body: given ? Buffer.from(JSON.stringify(given)) : Buffer.alloc(0), fromApp: true }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  return { status: parts[0].head.status, json: text ? JSON.parse(text) : null };
}

// Until `found` holds: looked at again as the script hears more, however long that takes (a busy
// machine is slow, never wrong); a test that never sees it fails at its time limit.
async function until(found) {
  const signal = running;
  while (!found()) {
    signal.throwIfAborted();
    await new Promise(resolve => setImmediate(resolve));
  }
}

// A chat here, with a wake-up, to move.
function chat(id) {
  engine.sessions.set(id, { id, title: "Trip plans", directory: chats, messages: [{ info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text: "May?" }] }] });
  fs.mkdirSync(path.join(wakes, id), { recursive: true });
  fs.writeFileSync(path.join(wakes, id, "wakes.json"), "[]");
}
// As it was before it moved: here, whole, its wake-ups going, nothing under way.
async function asItWas(id) {
  assert.ok(engine.sessions.has(id), "its conversation is still here");
  assert.ok(fs.existsSync(path.join(wakes, id, "wakes.json")), "its wake-ups are still here");
  assert.ok(!fs.existsSync(path.join(wakes, id, "paused")), "and going");
  assert.deepEqual(underWay((await ask("GET", "kuvo/moves")).json), { moves: [], away: [] });
}

test("a copy that couldn't be set up as it arrived leaves the original here as it was", async () => {
  chat("ses_race1");
  // Lab takes the parts, says it arrived, and at once that setting it up failed (both on their
  // way before this box had read either); it let its copy go, so a switch is answered dropped.
  script = move => {
    if (move.op === "offer") say({ op: "ready", id: move.id });
    if (move.op === "part") {
      say({ op: "got", id: move.id, i: move.i });
      if (move.i === move.of - 1) {
        say({ op: "arrived", id: move.id });
        say({ op: "failed", id: move.id, message: "Its disk is full." });
      }
    }
    if (move.op === "switch") say({ op: "dropped", id: move.id });
  };
  const moved = await ask("POST", "kuvo/moves", { kind: "chat", id: "ses_race1", to: peerKey });
  assert.equal(moved.status, 409, JSON.stringify(moved.json));
  await asItWas("ses_race1");
});

test("a switch the other computer can't honour (it let its copy go) leaves the original here", async () => {
  chat("ses_race2");
  script = move => {
    if (move.op === "offer") say({ op: "ready", id: move.id });
    if (move.op === "part") {
      say({ op: "got", id: move.id, i: move.i });
      if (move.i === move.of - 1) say({ op: "arrived", id: move.id });
    }
    if (move.op === "switch") say({ op: "dropped", id: move.id });
  };
  const moved = await ask("POST", "kuvo/moves", { kind: "chat", id: "ses_race2", to: peerKey });
  assert.equal(moved.status, 409);
  assert.match(moved.json.message, /stayed here/);
  await asItWas("ses_race2");
});

test("parts that come twice set a copy up once; a part after the switch changes nothing", async () => {
  script = () => {};
  // A chat lab moves here: its bundle, as lab packs it.
  const packed = path.join(support, "pack");
  fs.mkdirSync(packed, { recursive: true });
  fs.writeFileSync(path.join(packed, "move.json"), JSON.stringify({ kind: "chat", thing: "ses_in1", name: "“Groceries”", wasPaused: true,
    exports: [{ info: { id: "ses_in1", title: "Groceries" }, messages: [] }] }));
  const bundle = path.join(support, "bundle.tgz");
  assert.equal(spawnSync("tar", ["-czf", bundle, "-C", packed, "move.json"]).status, 0);
  const bytes = fs.readFileSync(bundle);
  const hash = crypto.createHash("sha256").update(bytes).digest("base64url");
  const id = "mov_in1";
  await say({ op: "offer", id, kind: "chat", thing: "ses_in1", name: "“Groceries”", size: bytes.length, hash, wasPaused: true, from: peerKey });
  await until(() => told.some(move => move.id === id && move.op === "ready"));
  const part = { op: "part", id, hash, i: 0, of: 1, d: bytes.toString("base64url") };
  // The same part twice at once (its `got` was lost, and it was sent again).
  await Promise.all([say(part), say(part)]);
  await until(() => told.some(move => move.id === id && move.op === "arrived"));
  assert.equal(engine.imports, 1, "set up once");
  assert.equal(told.filter(move => move.id === id && (move.op === "arrived" || move.op === "failed")).map(move => move.op).join(), "arrived");
  // Held until the switch: not this box's yet.
  assert.deepEqual((await ask("GET", "kuvo/moves")).json.away, ["ses_in1"]);
  engine.sessions.get("ses_in1").replies = [{ id: "msg_in1last", type: "assistant", time: { created: 1 } }];
  await say({ op: "switch", id });
  assert.ok(told.some(move => move.id === id && move.op === "switched"));
  // What it came with, noted: only what's after it is its running here.
  assert.equal(JSON.parse(fs.readFileSync(path.join(movesFolder, "ended.json"), "utf8"))[id]?.last, "msg_in1last");
  assert.deepEqual(underWay((await ask("GET", "kuvo/moves")).json), { moves: [], away: [] });
  // A late repeat of the part: nothing set up again, nothing held.
  await say(part);
  assert.equal(engine.imports, 1);
  assert.deepEqual(underWay((await ask("GET", "kuvo/moves")).json), { moves: [], away: [] });
  // And a switch again (its answer was lost): switched still.
  await say({ op: "switch", id });
  assert.equal(told.filter(move => move.id === id && move.op === "switched").length, 2);
});

test("a part its relay connection didn't take (closing as it was sent) goes again at the next look, not twenty seconds on", async () => {
  chat("ses_race9");
  // This box's mail goes by its relay connection, as lab would get it, which for a while takes no
  // parts (it answers false, as one that's closing does).
  let takesParts = true;
  const refused = [];
  relay = {
    send(bytes) {
      if (!bytes.subarray(1, 17).equals(Buffer.from(lab.address, "base64url"))) return true;
      const body = link.readFrame(bytes.subarray(17)).body;
      const move = JSON.parse(link.openOneWay(body, labSecret, link.publicOf(macSecret)).payload.toString()).move;
      if (!move) return true;
      if (move.op === "part" && !takesParts) {
        refused.push(move.i);
        return false;
      }
      return toScript(lab.key, move);
    },
  };
  link.sendMovesWith(null);
  try {
    script = move => {
      if (move.op === "offer") {
        takesParts = false;
        say({ op: "ready", id: move.id });
      }
      if (move.op === "part") {
        say({ op: "got", id: move.id, i: move.i });
        if (move.i === move.of - 1) say({ op: "arrived", id: move.id });
      }
      if (move.op === "switch") say({ op: "switched", id: move.id });
    };
    const moving = ask("POST", "kuvo/moves", { kind: "chat", id: "ses_race9", to: peerKey });
    await until(() => refused.length > 0);
    assert.ok(!told.some(move => move.op === "part" && move.id === told.findLast(each => each.op === "offer").id), "no part went");
    takesParts = true;
    link.keepMoving(Date.now() + 1_000);
    assert.ok(told.some(move => move.op === "part" && move.i === refused[0]), "the part it didn't take goes at the next look");
    const moved = await moving;
    assert.equal(moved.status, 200, JSON.stringify(moved.json));
  } finally {
    relay = { send: () => true };
    link.sendMovesWith(toScript);
  }
});

test("every part on its way lost at once (the relay dropped them all) goes again, and it isn't stuck until it's given up on", async () => {
  chat("ses_race16");
  // Enough to fill what can be on its way at once, however well it packs.
  engine.sessions.get("ses_race16").messages[0].parts[0].text = crypto.randomBytes(800_000).toString("base64");
  const lost = new Set();
  let losing = true;
  script = move => {
    if (move.op === "offer") say({ op: "ready", id: move.id });
    if (move.op === "part") {
      if (losing) return void lost.add(move.i);
      say({ op: "got", id: move.id, i: move.i });
      if (move.i === move.of - 1) say({ op: "arrived", id: move.id });
    }
    if (move.op === "switch") say({ op: "switched", id: move.id });
  };
  const moving = ask("POST", "kuvo/moves", { kind: "chat", id: "ses_race16", to: peerKey });
  await until(() => lost.size === 16);
  losing = false;
  const before = told.length;
  link.keepMoving(Date.now() + 25_000);
  assert.ok(told.slice(before).some(move => move.op === "part" && lost.has(move.i)), "those it lost go again");
  // Half as many at once, on a connection that lost them: a slow one isn't sent it all over and over.
  assert.equal(told.slice(before).filter(move => move.op === "part").length, 8);
  const moved = await moving;
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
});

test("a step for a move this box doesn't have is answered dropped, never switched", async () => {
  await say({ op: "switch", id: "mov_nothere1" });
  await say({ op: "drop", id: "mov_nothere2" });
  assert.deepEqual(told.filter(move => move.id?.startsWith("mov_nothere")).map(move => move.op), ["dropped", "dropped"]);
});

// A bundle lab packs for a chat it moves here: its conversations, and its wake-ups' folder.
function bundleFor(thing, exports, wakeFiles = {}, links = {}) {
  const packed = fs.mkdtempSync(path.join(support, "pack-"));
  fs.writeFileSync(path.join(packed, "move.json"), JSON.stringify({ kind: "chat", thing, name: "“Notes”", wasPaused: false, folder: thing, exports }));
  fs.mkdirSync(path.join(packed, thing));
  for (const [name, text] of Object.entries(wakeFiles)) {
    fs.mkdirSync(path.dirname(path.join(packed, thing, name)), { recursive: true });
    fs.writeFileSync(path.join(packed, thing, name), text);
  }
  for (const [name, target] of Object.entries(links)) {
    fs.mkdirSync(path.dirname(path.join(packed, thing, name)), { recursive: true });
    fs.symlinkSync(target, path.join(packed, thing, name));
  }
  const file = path.join(packed, "bundle.tgz");
  assert.equal(spawnSync("tar", ["-czf", file, "-C", packed, "move.json", thing]).status, 0);
  const bytes = fs.readFileSync(file);
  return { bytes, hash: crypto.createHash("sha256").update(bytes).digest("base64url") };
}

test("a copy whose setting up fails partway leaves nothing here: none of its conversations, nor its folder", async () => {
  const thing = "ses_part1";
  const { bytes, hash } = bundleFor(thing, [{ info: { id: thing, title: "Notes" }, messages: [] }, { info: { id: "ses_part1sub", parentID: thing, title: "Sub" }, messages: [] }], { "wakes.json": "[]" });
  engine.refuse = "ses_part1sub";
  const id = "mov_part1";
  await say({ op: "offer", id, kind: "chat", thing, name: "“Notes”", size: bytes.length, hash, wasPaused: false, from: peerKey });
  await say({ op: "part", id, hash, i: 0, of: 1, d: bytes.toString("base64url") });
  await until(() => told.some(move => move.id === id && move.op === "failed"));
  engine.refuse = null;
  assert.ok(!engine.sessions.has(thing), "the conversation that did come in is gone");
  assert.ok(!fs.existsSync(path.join(wakes, thing)), "and its folder");
  assert.deepEqual(underWay((await ask("GET", "kuvo/moves")).json), { moves: [], away: [] });
});

test("the other computer going quiet partway: it's taken back after a while, and the original goes on here", async () => {
  chat("ses_quiet1");
  // Lab says it's ready, then nothing more (it went away).
  script = move => { if (move.op === "offer") say({ op: "ready", id: move.id }); };
  const before = told.length;
  const asked = ask("POST", "kuvo/moves", { kind: "chat", id: "ses_quiet1", to: peerKey });
  await until(() => told.slice(before).some(move => move.op === "part"));
  // Ten minutes and more later, with no word from it.
  link.keepMoving(Date.now() + 11 * 60_000);
  const moved = await asked;
  assert.equal(moved.status, 503);
  assert.match(moved.json.message, /lab stopped answering/);
  await asItWas("ses_quiet1");
  // It asks lab to let its copy go; one never answered is given up a day later, nothing kept.
  const records = () => fs.readdirSync(path.join(home, "run", "moves")).filter(name => /^mov_.*\.json$/.test(name) && !name.endsWith(".outcome.json"));
  assert.equal(records().length, 1);
  link.keepMoving(Date.now() + 25 * 3600_000);
  assert.deepEqual(records(), []);
});

test("what another computer offers over one that lives here is refused, and what lives here stays as it is", async () => {
  chat("ses_here1");
  const { bytes, hash } = bundleFor("ses_here1", [{ info: { id: "ses_here1", title: "Not yours" }, messages: [] }]);
  await say({ op: "offer", id: "mov_over1", kind: "chat", thing: "ses_here1", name: "“Trip plans”", size: bytes.length, hash, wasPaused: false, from: peerKey });
  const answer = told.find(move => move.id === "mov_over1");
  assert.equal(answer.op, "refused");
  assert.match(answer.message, /already/);
  assert.equal(engine.sessions.get("ses_here1").title, "Trip plans");
  await asItWas("ses_here1");
});

test("a copy that brings a link (to somewhere else on this computer) isn't set up", async () => {
  const thing = "ses_link1";
  const { bytes, hash } = bundleFor(thing, [{ info: { id: thing, title: "Notes" }, messages: [] }], { "wakes.json": "[]" }, { home: os.homedir() });
  await say({ op: "offer", id: "mov_link1", kind: "chat", thing, name: "“Notes”", size: bytes.length, hash, wasPaused: false, from: peerKey });
  await say({ op: "part", id: "mov_link1", hash, i: 0, of: 1, d: bytes.toString("base64url") });
  await until(() => told.some(move => move.id === "mov_link1" && move.op === "failed"));
  assert.match(told.find(move => move.id === "mov_link1" && move.op === "failed").message, /a link/);
  assert.ok(!fs.existsSync(path.join(wakes, thing)) && !engine.sessions.has(thing));
});

test("a copy whose links only seem to stay in its folder, one through another, isn't set up", async () => {
  // `d/L` is its own folder `e`; `A` reads, as text, as a file in it, but is the file next to its
  // folder (one there: refused for where it goes, not for going nowhere).
  const thing = "ses_link2";
  const { bytes, hash } = bundleFor(thing, [{ info: { id: thing, title: "Notes" }, messages: [] }], { "wakes.json": "[]", "e/notes.txt": "x" }, { "d/L": "../e", A: "d/L/../../move.json" });
  await say({ op: "offer", id: "mov_link2", kind: "chat", thing, name: "“Notes”", size: bytes.length, hash, wasPaused: false, from: peerKey });
  await say({ op: "part", id: "mov_link2", hash, i: 0, of: 1, d: bytes.toString("base64url") });
  await until(() => told.some(move => move.id === "mov_link2" && (move.op === "failed" || move.op === "arrived")));
  assert.match(told.find(move => move.id === "mov_link2" && move.op === "failed")?.message ?? "it was set up", /a link/);
  assert.ok(!fs.existsSync(path.join(wakes, thing)) && !engine.sessions.has(thing));
});

test("a move under way from one computer can't be taken over by another", async () => {
  const thing = "ses_one1";
  const { bytes, hash } = bundleFor(thing, [{ info: { id: thing, title: "Notes" }, messages: [] }]);
  await say({ op: "offer", id: "mov_one1", kind: "chat", thing, name: "“Notes”", size: bytes.length, hash, wasPaused: false, from: peerKey });
  assert.equal(told.find(move => move.id === "mov_one1")?.op, "ready");
  await link.takeMoveMail(studio, { op: "offer", id: "mov_one2", kind: "chat", thing, name: "“Notes”", size: bytes.length, hash, wasPaused: false, from: studio.key });
  assert.equal(told.find(move => move.id === "mov_one2")?.op, "refused");
  await link.takeMoveMail(studio, { op: "drop", id: "mov_one1" });
  assert.deepEqual((await ask("GET", "kuvo/moves")).json.moves.map(move => move.id), ["mov_one1"], "lab's move is as it was");
  await say({ op: "drop", id: "mov_one1" });
});

test("a copy on its way when this box starts again goes on from the parts it had", async () => {
  const thing = "ses_restart1";
  // Big enough for two parts (30,000 bytes each), as the box it comes from sends them.
  const { bytes, hash } = bundleFor(thing, [{ info: { id: thing, title: "Notes" }, messages: [] }], { "notes.txt": crypto.randomBytes(40_000).toString("base64") });
  assert.ok(bytes.length > 30_000 && bytes.length <= 60_000, `${bytes.length} bytes`);
  const id = "mov_restart1";
  const part = i => ({ op: "part", id, hash, i, of: 2, d: bytes.subarray(i * 30_000, (i + 1) * 30_000).toString("base64url") });
  await say({ op: "offer", id, kind: "chat", thing, name: "“Notes”", size: bytes.length, hash, wasPaused: false, from: peerKey });
  await say(part(0));
  // This box starts again; the other sends the part it had no answer for.
  link.forgetMovesInMemory();
  await say(part(1));
  await until(() => told.some(move => move.id === id && move.op === "arrived"));
  assert.ok(engine.sessions.has(thing));
  await say({ op: "drop", id });
});

test("one that keeps getting messages while it moves goes again with them, and after three tries stays here, as it was", async () => {
  chat("ses_busy1");
  let offers = 0;
  script = move => {
    if (move.op === "offer") {
      offers += 1;
      say({ op: "ready", id: move.id });
    }
    if (move.op === "part") {
      say({ op: "got", id: move.id, i: move.i });
      if (move.i === move.of - 1) {
        // A message reaches it just as its copy's there: what was sent isn't all of it any more.
        engine.sessions.get("ses_busy1").messages.push({ info: { id: `msg_more${offers}`, role: "user" }, parts: [{ type: "text", text: "And this." }] });
        say({ op: "arrived", id: move.id });
      }
    }
    if (move.op === "drop") say({ op: "dropped", id: move.id });
  };
  const moved = await ask("POST", "kuvo/moves", { kind: "chat", id: "ses_busy1", to: peerKey });
  assert.equal(moved.status, 409);
  assert.match(moved.json.message, /kept getting messages/);
  assert.equal(offers, 3, "sent again with what came, three times");
  assert.equal(engine.sessions.get("ses_busy1").messages.length, 4, "nothing lost here");
  await asItWas("ses_busy1");
});

test("while it moves, what waits for it stays as it is: a Remove, an Undo or a Resume is refused, and taken back it's all there, still stopped", async () => {
  chat("ses_qmove");
  assert.equal((await ask("POST", "kuvo/sessions/ses_qmove/stop")).json?.paused, true);
  for (const [id, text] of [["msg_q1", "First."], ["msg_q2", "Second."]]) assert.equal((await ask("POST", "kuvo/sessions/ses_qmove/queue/add", { id, text })).json?.waits, true);
  // Asked to change it as its copy arrives there, then the copy there fails.
  let tried = null;
  script = move => {
    if (move.op === "offer") say({ op: "ready", id: move.id });
    if (move.op === "part") {
      say({ op: "got", id: move.id, i: move.i });
      if (move.i === move.of - 1) tried = Promise.all([
        ask("DELETE", "kuvo/sessions/ses_qmove/queue/msg_q1"),
        ask("POST", "kuvo/sessions/ses_qmove/queue/add", { id: "msg_q3", text: "Third.", before: "msg_q1" }),
        ask("POST", "kuvo/sessions/ses_qmove/queue/resume"),
      ]).finally(() => say({ op: "failed", id: move.id, message: "Its disk is full." }));
    }
  };
  const moved = await ask("POST", "kuvo/moves", { kind: "chat", id: "ses_qmove", to: peerKey });
  assert.equal(moved.status, 409, JSON.stringify(moved.json));
  const answers = await tried;
  assert.deepEqual(answers.map(each => each.status), [409, 409, 409]);
  for (const each of answers) assert.match(each.json.message, /moving to another computer/);
  const queue = (await ask("GET", "kuvo/sessions/ses_qmove/queue")).json;
  assert.equal(queue.paused, true, "still stopped");
  assert.deepEqual(queue.waiting.map(each => each.id), ["msg_q1", "msg_q2"]);
  for (const id of ["msg_q1", "msg_q2"]) assert.ok(fs.existsSync(path.join(home, "run", "waiting", `${id}.json`)), id);
  // And it can be changed again.
  assert.equal((await ask("DELETE", "kuvo/sessions/ses_qmove/queue/msg_q1")).status, 200);
  assert.deepEqual((await ask("GET", "kuvo/sessions/ses_qmove/queue")).json.waiting.map(each => each.id), ["msg_q2"]);
});

test("where a moved conversation lives: by the computer that moved it, lately, and never one of this box's own", () => {
  const run = path.join(home, "run");
  // This box's own conversations, as it lists them.
  fs.writeFileSync(path.join(run, "agents.json"), JSON.stringify({ machine: null, agents: [{ session: "ses_mine1", name: "Mine", kind: "session" }] }));
  const now = Date.now();
  fs.writeFileSync(path.join(run, "peer-agents.json"), JSON.stringify({
    [peerKey]: { at: now, kind: "machine", list: [], moved: [
      { session: "ses_went1", key: studio.key, at: now - 60_000 },
      // One of this box's own, claimed: not taken.
      { session: "ses_mine1", key: studio.key, at: now },
      // Long ago: not any more.
      { session: "ses_old1", key: studio.key, at: now - 3 * 24 * 3600_000 },
    ] },
    // A computer that isn't one of this box's any more.
    [link.publicOf(link.newKey()).toString("base64url")]: { at: now, kind: "machine", list: [], moved: [{ session: "ses_gone1", key: peerKey, at: now }] },
  }));
  const moved = link.movedOf(link.readLink());
  assert.equal(moved.get("ses_went1"), studio.key);
  assert.ok(!moved.has("ses_mine1") && !moved.has("ses_old1") && !moved.has("ses_gone1"));
});

// The record of the move of `thing` here, as it's kept.
const movesFolder = path.join(home, "run", "moves");
function recordOf(thing) {
  const names = fs.existsSync(movesFolder) ? fs.readdirSync(movesFolder) : [];
  for (const name of names.filter(name => /^mov_[A-Za-z0-9]+\.json$/.test(name))) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(movesFolder, name), "utf8"));
      if (record.thing === thing) return record;
    } catch {}
  }
  return null;
}
// Lab answers each step as a box would, and switch with `onSwitch` (nothing: it's gone quiet).
function labAnswers(onSwitch) {
  script = move => {
    if (move.op === "offer") say({ op: "ready", id: move.id });
    if (move.op === "part") {
      say({ op: "got", id: move.id, i: move.i });
      if (move.i === move.of - 1) say({ op: "arrived", id: move.id });
    }
    if (move.op === "switch" && onSwitch) say({ op: onSwitch, id: move.id });
    if (move.op === "drop") say({ op: "dropped", id: move.id });
  };
}

test("the other computer removed just as it was told to switch: the original stays here, as it was", async () => {
  chat("ses_gone1");
  labAnswers(null);
  const before = told.length;
  const asked = ask("POST", "kuvo/moves", { kind: "chat", id: "ses_gone1", to: peerKey });
  await until(() => told.slice(before).some(move => move.op === "switch"));
  // Lab goes from your computers (removed, or just left out as they're read again).
  link.writeLink({ macPeers: [studio] });
  let moved;
  try {
    const now = Date.now();
    link.keepMoving(now);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(recordOf("ses_gone1")?.stage, "switching", "left out a moment: nothing changes");
    assert.ok(engine.sessions.has("ses_gone1"));
    // Gone a while: it never heard `switched`, so the original goes on here.
    link.keepMoving(now + 6 * 60_000);
    moved = await asked;
  } finally {
    link.writeLink({ macPeers: [lab, studio] });
  }
  assert.equal(moved.status, 409, JSON.stringify(moved.json));
  await asItWas("ses_gone1");
});

test("a drop that comes while a copy's being set up waits for it, then lets all of it go", async () => {
  script = () => {};
  const thing = "ses_slow1";
  const { bytes, hash } = bundleFor(thing, [{ info: { id: thing, title: "Notes" }, messages: [] }], { "wakes.json": "[]" });
  let release;
  engine.hold = new Promise(resolve => { release = resolve; });
  const id = "mov_slow1";
  await say({ op: "offer", id, kind: "chat", thing, name: "“Notes”", size: bytes.length, hash, wasPaused: false, from: peerKey });
  const settingUp = say({ op: "part", id, hash, i: 0, of: 1, d: bytes.toString("base64url") });
  await until(() => engine.holding);
  // Lab takes it back now (it stopped hearing from this box), as its conversation comes in here.
  const dropping = say({ op: "drop", id });
  // A drop that doesn't wait for it is done before the import is (it can't be answered before then
  // when it waits).
  for (let tries = 0; tries < 2000 && !told.some(move => move.id === id && move.op === "dropped"); tries++) await new Promise(resolve => setImmediate(resolve));
  engine.hold = null;
  release();
  await Promise.all([settingUp, dropping]);
  await until(() => told.some(move => move.id === id && move.op === "dropped"));
  assert.ok(!engine.sessions.has(thing), "its conversation isn't left here, live, beside the original");
  assert.ok(!fs.existsSync(path.join(wakes, thing)), "nor its folder");
  assert.deepEqual(underWay((await ask("GET", "kuvo/moves")).json), { moves: [], away: [] });
  // And lab heard, as it was set up, that it was still at it.
  assert.ok(told.some(move => move.id === id && move.op === "working"));
});

test("a switch heard while this box's engine is down: the original goes once it's back", async () => {
  chat("ses_fin1");
  labAnswers("switched");
  engine.down = true;
  const refused = engine.refused;
  const asked = ask("POST", "kuvo/moves", { kind: "chat", id: "ses_fin1", to: peerKey });
  await until(() => recordOf("ses_fin1")?.stage === "finishing" && engine.refused > refused);
  assert.ok(engine.sessions.has("ses_fin1"));
  engine.down = false;
  link.keepMoving(Date.now() + 2 * 60_000);
  await until(() => !engine.sessions.has("ses_fin1") && !recordOf("ses_fin1"));
  const moved = await asked;
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.deepEqual((await ask("GET", "kuvo/moves")).json.moves, []);
});

test("a switch never answered: it asks the other computer to let its copy go, and the original goes on here", async () => {
  chat("ses_ask1");
  labAnswers(null);
  const before = told.length;
  const asked = ask("POST", "kuvo/moves", { kind: "chat", id: "ses_ask1", to: peerKey });
  await until(() => told.slice(before).some(move => move.op === "switch"));
  link.keepMoving(Date.now() + 11 * 60_000);
  await until(() => told.slice(before).some(move => move.op === "drop"));
  const moved = await asked;
  assert.equal(moved.status, 409);
  await asItWas("ses_ask1");
});

test("a move taken back, left at any step, lets its copy there go and is forgotten; never offered again", async () => {
  const id = "mov_left1";
  const file = path.join(movesFolder, `${id}.json`);
  fs.mkdirSync(movesFolder, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    id, kind: "chat", thing: "ses_left1", name: "“Left”", from: "", to: peerKey, role: "from", stage: "copying", sessions: ["ses_left1"],
    peer: peerKey, wasPaused: false, tries: 0, started: Date.now(), offered: true, step: "offer", sentAt: Date.now() - 120_000, failed: "It didn’t get there.", failedStatus: 409,
  }));
  labAnswers(null);
  const before = told.length;
  link.keepMoving();
  await until(() => !fs.existsSync(file));
  assert.deepEqual(told.slice(before).filter(move => move.id === id).map(move => move.op), ["drop"]);
});

test("a switch asked again long after it switched (the other computer asleep all that while) is answered switched", async () => {
  const file = path.join(movesFolder, "ended.json");
  fs.mkdirSync(movesFolder, { recursive: true });
  let kept = {};
  try { kept = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  kept.mov_long1 = { as: "switched", at: Date.now() - 8 * 24 * 3600_000 };
  fs.writeFileSync(file, JSON.stringify(kept));
  await say({ op: "switch", id: "mov_long1" });
  assert.deepEqual(told.filter(move => move.id === "mov_long1").map(move => move.op), ["switched"]);
});

test("a copy whose conversations aren't its own is refused, and what lives here is left as it is", async () => {
  chat("ses_mine2");
  // One that names a conversation of this box's as its subagent's.
  const thing = "ses_tie1";
  const one = bundleFor(thing, [{ info: { id: thing, title: "Notes" }, messages: [] }, { info: { id: "ses_mine2", parentID: thing, title: "Not yours" }, messages: [] }]);
  await say({ op: "offer", id: "mov_tie1", kind: "chat", thing, name: "“Notes”", size: one.bytes.length, hash: one.hash, wasPaused: false, from: peerKey });
  await say({ op: "part", id: "mov_tie1", hash: one.hash, i: 0, of: 1, d: one.bytes.toString("base64url") });
  await until(() => told.some(move => move.id === "mov_tie1" && move.op === "failed"));
  assert.equal(engine.sessions.get("ses_mine2")?.title, "Trip plans", "this box's own is still here, as it was");
  assert.ok(!engine.sessions.has(thing));
  // And one whose conversation isn't the chat it says it moves.
  const other = bundleFor("ses_tie2", [{ info: { id: "ses_else1", title: "Else" }, messages: [] }]);
  await say({ op: "offer", id: "mov_tie2", kind: "chat", thing: "ses_tie2", name: "“Notes”", size: other.bytes.length, hash: other.hash, wasPaused: false, from: peerKey });
  await say({ op: "part", id: "mov_tie2", hash: other.hash, i: 0, of: 1, d: other.bytes.toString("base64url") });
  await until(() => told.some(move => move.id === "mov_tie2" && move.op === "failed"));
  assert.ok(!engine.sessions.has("ses_else1"));
  // And ones whose conversations aren't one tree: a subagent's whose parent didn't come, a root with
  // a parent.
  for (const [id, exports] of [
    ["mov_tie3", [{ info: { id: "ses_tie3", title: "Notes" }, messages: [] }, { info: { id: "ses_tie3sub", parentID: "ses_nowhere", title: "Sub" }, messages: [] }]],
    ["mov_tie4", [{ info: { id: "ses_tie4", parentID: "ses_tie4sub", title: "Notes" }, messages: [] }, { info: { id: "ses_tie4sub", parentID: "ses_tie4", title: "Sub" }, messages: [] }]],
  ]) {
    const thing = exports[0].info.id;
    const shape = bundleFor(thing, exports);
    await say({ op: "offer", id, kind: "chat", thing, name: "“Notes”", size: shape.bytes.length, hash: shape.hash, wasPaused: false, from: peerKey });
    await say({ op: "part", id, hash: shape.hash, i: 0, of: 1, d: shape.bytes.toString("base64url") });
    await until(() => told.some(move => move.id === id && move.op === "failed"));
    assert.match(told.find(move => move.id === id && move.op === "failed").message, /aren’t its own/);
    assert.ok(exports.every(each => !engine.sessions.has(each.info.id)));
  }
  assert.deepEqual(underWay((await ask("GET", "kuvo/moves")).json), { moves: [], away: [] });
});

test("a copy whose move.json is a link to a file here isn't set up, and nothing of that file is said back", async () => {
  const secret = path.join(support, "secret.txt");
  fs.writeFileSync(secret, "SECRET-7f3a not for the other computer");
  const packed = fs.mkdtempSync(path.join(support, "pack-"));
  fs.symlinkSync(secret, path.join(packed, "move.json"));
  const file = path.join(packed, "bundle.tgz");
  assert.equal(spawnSync("tar", ["-czf", file, "-C", packed, "move.json"]).status, 0);
  const bytes = fs.readFileSync(file);
  const hash = crypto.createHash("sha256").update(bytes).digest("base64url");
  await say({ op: "offer", id: "mov_sym1", kind: "chat", thing: "ses_sym1", name: "“Notes”", size: bytes.length, hash, wasPaused: false, from: peerKey });
  await say({ op: "part", id: "mov_sym1", hash, i: 0, of: 1, d: bytes.toString("base64url") });
  await until(() => told.some(move => move.id === "mov_sym1" && move.op === "failed"));
  const said = told.find(move => move.id === "mov_sym1" && move.op === "failed").message;
  assert.doesNotMatch(said, /SECRET/);
  assert.match(said, /isn’t a move/);
});

test("a computer with a Kuvo Code from before moves says it needs a newer one, as a place and when asked", async () => {
  chat("ses_old2");
  const file = path.join(home, "run", "peer-agents.json");
  fs.writeFileSync(file, JSON.stringify({ [peerKey]: { at: Date.now(), kind: "machine", list: [], features: ["sessions", "bots"] } }));
  try {
    const places = (await ask("GET", "kuvo/moves/places?kind=chat&id=ses_old2")).json.places;
    assert.deepEqual(places.find(place => place.key === peerKey), { key: peerKey, name: "lab", kind: "machine", ok: false, why: "lab needs a newer Kuvo Code before things can move to or from it.", note: "Needs a newer Kuvo Code" });
    assert.equal(places.find(place => place.key === studio.key)?.ok, true, "one that hasn't said what it answers is tried");
    const moved = await ask("POST", "kuvo/moves", { kind: "chat", id: "ses_old2", to: peerKey });
    assert.equal(moved.status, 409);
    assert.match(moved.json.message, /needs a newer Kuvo Code/);
    await asItWas("ses_old2");
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("offered again as a copy before it is still being set up: that one goes once it's all here, and no copy of it is left", async () => {
  script = () => {};
  const thing = "ses_again1";
  const first = bundleFor(thing, [{ info: { id: thing, title: "Notes" }, messages: [] }]);
  let release;
  engine.hold = new Promise(resolve => { release = resolve; });
  await say({ op: "offer", id: "mov_again1", kind: "chat", thing, name: "“Notes”", size: first.bytes.length, hash: first.hash, wasPaused: false, from: peerKey });
  const settingUp = say({ op: "part", id: "mov_again1", hash: first.hash, i: 0, of: 1, d: first.bytes.toString("base64url") });
  await until(() => engine.holding);
  // Lab started again, took that one back, and moves it once more.
  const again = say({ op: "offer", id: "mov_again2", kind: "chat", thing, name: "“Notes”", size: first.bytes.length, hash: first.hash, wasPaused: false, from: peerKey });
  // An offer that doesn't wait for the first copy is answered before it's all here.
  for (let tries = 0; tries < 2000 && !told.some(move => move.id === "mov_again2"); tries++) await new Promise(resolve => setImmediate(resolve));
  engine.hold = null;
  release();
  await Promise.all([settingUp, again]);
  assert.equal(told.find(move => move.id === "mov_again2")?.op, "ready");
  assert.ok(!engine.sessions.has(thing), "the first copy isn't left here, live");
  assert.deepEqual((await ask("GET", "kuvo/moves")).json.moves.map(move => move.id), ["mov_again2"]);
  await say({ op: "drop", id: "mov_again2" });
});

test("a switch never answered, then asked to let go, answered switched: the original goes, as it would have", async () => {
  chat("ses_late1");
  labAnswers(null);
  script = (answer => move => (move.op === "drop" ? say({ op: "switched", id: move.id }) : answer(move)))(script);
  const before = told.length;
  const asked = ask("POST", "kuvo/moves", { kind: "chat", id: "ses_late1", to: peerKey });
  await until(() => told.slice(before).some(move => move.op === "switch"));
  link.keepMoving(Date.now() + 11 * 60_000);
  const moved = await asked;
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.ok(!engine.sessions.has("ses_late1"));
});

test("letting the original go, cut short partway: tried again, it keeps the whole conversation, subagents too", async () => {
  chat("ses_keep1");
  engine.sessions.set("ses_keep1sub", { id: "ses_keep1sub", title: "Sub", parentID: "ses_keep1", directory: chats, messages: [{ info: { id: "msg_s1", role: "user" }, parts: [{ type: "text", text: "Look it up." }] }] });
  labAnswers("switched");
  // Its subagent's goes, then the engine goes away before the chat's own does.
  engine.downFor = "ses_keep1";
  const refused = engine.refused;
  const asked = ask("POST", "kuvo/moves", { kind: "chat", id: "ses_keep1", to: peerKey });
  await until(() => recordOf("ses_keep1")?.stage === "finishing" && !engine.sessions.has("ses_keep1sub") && engine.refused > refused);
  engine.downFor = null;
  link.keepMoving(Date.now() + 2 * 60_000);
  assert.equal((await asked).status, 200);
  const trash = path.join(home, "trash");
  const kept = fs.readdirSync(trash).map(each => path.join(trash, each, "ses_keep1", "conversation.json")).find(each => fs.existsSync(each));
  assert.ok(kept, "kept in the trash");
  assert.deepEqual(JSON.parse(fs.readFileSync(kept, "utf8")).map(each => each.info.id), ["ses_keep1", "ses_keep1sub"]);
});

test("a copy whose folder is a link (to a folder here) isn't set up, and that folder is left as it was", async () => {
  const thing = "ses_dirlink1";
  const mine = fs.mkdtempSync(path.join(support, "mine-"));
  fs.writeFileSync(path.join(mine, "notes.txt"), "mine");
  const packed = fs.mkdtempSync(path.join(support, "pack-"));
  fs.writeFileSync(path.join(packed, "move.json"), JSON.stringify({ kind: "chat", thing, name: "“Notes”", wasPaused: false, folder: thing, exports: [{ info: { id: thing, title: "Notes" }, messages: [] }] }));
  fs.symlinkSync(mine, path.join(packed, thing));
  const file = path.join(packed, "bundle.tgz");
  assert.equal(spawnSync("tar", ["-czf", file, "-C", packed, "move.json", thing]).status, 0);
  const bytes = fs.readFileSync(file);
  const hash = crypto.createHash("sha256").update(bytes).digest("base64url");
  const id = "mov_dirlink1";
  await say({ op: "offer", id, kind: "chat", thing, name: "“Notes”", size: bytes.length, hash, wasPaused: false, from: peerKey });
  await say({ op: "part", id, hash, i: 0, of: 1, d: bytes.toString("base64url") });
  await until(() => told.some(move => move.id === id && move.op === "failed"));
  assert.match(told.find(move => move.id === id && move.op === "failed").message, /a link/);
  assert.deepEqual(fs.readdirSync(mine), ["notes.txt"], "nothing written into the folder it pointed at");
  assert.ok(!fs.existsSync(path.join(wakes, thing)) && !engine.sessions.has(thing));
  assert.deepEqual(underWay((await ask("GET", "kuvo/moves")).json), { moves: [], away: [] });
});

test("letting the original go, its engine refusing again and again to give its conversation to keep: it goes on here too, and says so", async () => {
  chat("ses_stuck1");
  labAnswers(null);
  const answers = script;
  // Lab switches; from then on this box's engine won't give the conversation up (it's up, and says no).
  script = move => {
    if (move.op !== "switch") return answers(move);
    engine.exportFails = "ses_stuck1";
    say({ op: "switched", id: move.id });
  };
  const asked = ask("POST", "kuvo/moves", { kind: "chat", id: "ses_stuck1", to: peerKey });
  try {
    await until(() => recordOf("ses_stuck1")?.stage === "finishing" && engine.exportsRefused > 0);
    // Tried again each minute, a while.
    for (let tries = 0; tries < 12 && recordOf("ses_stuck1"); tries++) {
      const refused = engine.exportsRefused;
      link.keepMoving(Date.now() + 61_000);
      await until(() => engine.exportsRefused > refused || !recordOf("ses_stuck1"));
    }
    assert.equal(recordOf("ses_stuck1"), null, "it doesn't stay half gone for ever");
    const moved = await asked;
    assert.equal(moved.status, 409);
    assert.match(moved.json.message, /on both computers/);
    await asItWas("ses_stuck1");
  } finally {
    engine.exportFails = null;
  }
});

test("a copy whose setting up gets stuck (its engine not answering) is given up on after a while, and nothing of it is left", async () => {
  script = () => {};
  const thing = "ses_stuckin1";
  const { bytes, hash } = bundleFor(thing, [{ info: { id: thing, title: "Notes" }, messages: [] }], { "wakes.json": "[]" });
  // Its engine takes the import and never answers.
  engine.hold = new Promise(() => {});
  const id = "mov_stuckin1";
  try {
    await say({ op: "offer", id, kind: "chat", thing, name: "“Notes”", size: bytes.length, hash, wasPaused: false, from: peerKey });
    const settingUp = say({ op: "part", id, hash, i: 0, of: 1, d: bytes.toString("base64url") });
    await until(() => engine.holding);
    // Half an hour and more later.
    link.keepMoving(Date.now() + 31 * 60_000);
    await until(() => told.some(move => move.id === id && move.op === "failed"));
    assert.match(told.find(move => move.id === id && move.op === "failed").message, /too long/);
    await settingUp;
    assert.ok(!engine.sessions.has(thing) && !fs.existsSync(path.join(wakes, thing)), "nothing of it is left here");
    assert.deepEqual(underWay((await ask("GET", "kuvo/moves")).json), { moves: [], away: [] });
  } finally {
    engine.hold = null;
    engine.holding = false;
  }
});

test("one over 1 GB is refused, saying so plainly, and nothing of it comes", async () => {
  script = () => {};
  const id = "mov_big1";
  await say({ op: "offer", id, kind: "chat", thing: "ses_big1", name: "“Videos”", size: 2 * 1024 ** 3, hash: "a".repeat(64), wasPaused: false, from: peerKey });
  const answer = told.find(move => move.id === id);
  assert.equal(answer.op, "refused");
  assert.equal(answer.message, "“Videos” is more than 1 GB, too big to move to another computer, so it stays where it is.");
  assert.deepEqual(underWay((await ask("GET", "kuvo/moves")).json), { moves: [], away: [] });
});

test("what's moving says which computer it's going to by name, as your computers call it", async () => {
  chat("ses_named1");
  // Lab gets ready, and then nothing more: it stays on its way.
  script = move => { if (move.op === "offer") say({ op: "ready", id: move.id }); };
  const before = told.length;
  const asked = ask("POST", "kuvo/moves", { kind: "chat", id: "ses_named1", to: peerKey });
  await until(() => told.slice(before).some(move => move.op === "part"));
  const listed = (await ask("GET", "kuvo/moves")).json.moves.find(move => move.thing === "ses_named1");
  assert.equal(listed.place, "lab");
  assert.equal(listed.stage, "copying");
  assert.ok(listed.size > 0 && listed.sent <= listed.size, "how much of it went");
  // Taken back (lab quiet for long enough), its copy there let go.
  script = move => { if (move.op === "drop") say({ op: "dropped", id: move.id }); };
  link.keepMoving(Date.now() + 11 * 60_000);
  assert.equal((await asked).status, 503);
  await asItWas("ses_named1");
});

// The box's own looks at its moves (each 3 seconds, by the real clock) stopped once a test's move
// is under way (before, this box wouldn't move it: it's the bridge only while it looks), so one of
// them can't undo what the test sees as it looks ahead in time itself; started again after.
async function withoutLooks(run) {
  let stopped = false, started = false;
  // Once (not once the file's done: nothing would stop them).
  const start = () => {
    if (!stopped || started || done) return;
    started = true;
    stop = new AbortController();
    link.watchMoves(() => relay, stop.signal);
  };
  // (Also as soon as the test's failed or out of time, though what it waits for still hasn't come:
  // the tests after it are moved as ever.)
  running.addEventListener("abort", start, { once: true });
  try {
    await run(() => {
      stopped = true;
      stop.abort();
    });
  } finally {
    start();
  }
}

test("a move whose other computer went quiet says it's waiting for it, until it speaks again, and is still taken back after a while", () => withoutLooks(async stopLooks => {
  chat("ses_waits1");
  // Lab gets ready, and then nothing more.
  script = move => { if (move.op === "offer") say({ op: "ready", id: move.id }); };
  const before = told.length;
  const asked = ask("POST", "kuvo/moves", { kind: "chat", id: "ses_waits1", to: peerKey });
  await until(() => told.slice(before).some(move => move.op === "part"));
  stopLooks();
  const listed = async () => (await ask("GET", "kuvo/moves")).json.moves.find(move => move.thing === "ses_waits1");
  // A step answered a little late isn't waiting.
  link.keepMoving(Date.now() + 30_000);
  assert.equal((await listed()).waiting, undefined);
  // Quiet a couple of minutes: waiting for lab, still copying, nothing taken back.
  link.keepMoving(Date.now() + 2 * 60_000);
  const waiting = await listed();
  assert.equal(waiting.waiting, true);
  assert.equal(waiting.stage, "copying");
  // Lab says something of it: it isn't waiting any more.
  await say({ op: "working", id: waiting.id });
  link.keepMoving(Date.now());
  assert.equal((await listed()).waiting, undefined);
  // Quiet for long enough: taken back, as before.
  script = move => { if (move.op === "drop") say({ op: "dropped", id: move.id }); };
  link.keepMoving(Date.now() + 11 * 60_000);
  assert.equal((await asked).status, 503);
  await asItWas("ses_waits1");
}));

test("a switch the other computer went quiet on says it's waiting for it, also once it's asked to let its copy go instead", () => withoutLooks(async stopLooks => {
  chat("ses_waits2");
  // Lab takes it all, and then says nothing more: not to the switch, nor to letting its copy go.
  labAnswers(null);
  script = (answer => move => { if (move.op !== "drop") answer(move); })(script);
  const before = told.length;
  const asked = ask("POST", "kuvo/moves", { kind: "chat", id: "ses_waits2", to: peerKey });
  await until(() => told.slice(before).some(move => move.op === "switch"));
  stopLooks();
  const listed = async () => (await ask("GET", "kuvo/moves")).json.moves.find(move => move.thing === "ses_waits2");
  const at = Date.now();
  link.keepMoving(at + 2 * 60_000);
  assert.equal((await listed()).waiting, true);
  // Asked to let its copy go instead (it may have switched): still waiting for lab.
  link.keepMoving(at + 11 * 60_000);
  await until(() => told.slice(before).some(move => move.op === "drop"));
  link.keepMoving(at + 12 * 60_000);
  const waiting = await listed();
  assert.equal(waiting.stage, "switching");
  assert.equal(waiting.waiting, true);
  // Back, it says it let its copy go: the original goes on here.
  labAnswers(null);
  link.keepMoving(at + 14 * 60_000);
  assert.equal((await asked).status, 409);
  await asItWas("ses_waits2");
}));

test("a copy coming here whose other computer went quiet before all of it came says it's waiting for it", () => withoutLooks(async stopLooks => {
  script = () => {};
  const thing = "ses_waits3";
  const { bytes, hash } = bundleFor(thing, [{ info: { id: thing, title: "Notes" }, messages: [] }], { "wakes.json": "[]" });
  const id = "mov_waits3";
  await say({ op: "offer", id, kind: "chat", thing, name: "“Notes”", size: bytes.length, hash, wasPaused: false, from: peerKey });
  await until(() => told.some(move => move.id === id && move.op === "ready"));
  stopLooks();
  const listed = async () => (await ask("GET", "kuvo/moves")).json.moves.find(move => move.id === id);
  link.keepMoving(Date.now() + 30_000);
  assert.equal((await listed()).waiting, undefined);
  // None of its parts for a couple of minutes: waiting for lab.
  link.keepMoving(Date.now() + 2 * 60_000);
  const waiting = await listed();
  assert.equal(waiting.role, "to");
  assert.equal(waiting.waiting, true);
  // Its part comes: it isn't waiting any more.
  await say({ op: "part", id, hash, i: 0, of: 1, d: bytes.toString("base64url") });
  link.keepMoving(Date.now());
  assert.equal((await listed())?.waiting, undefined);
  // (Let go of, as lab takes it back.)
  await until(() => told.some(move => move.id === id && move.op === "arrived"));
  await say({ op: "drop", id });
  await until(() => told.some(move => move.id === id && move.op === "dropped"));
  const signal = running;
  while (await listed()) {
    signal.throwIfAborted();
    await new Promise(resolve => setImmediate(resolve));
  }
}));

test("a copy all here and set up, whose other computer went quiet before it switched to it, says it's waiting for it", () => withoutLooks(async stopLooks => {
  script = () => {};
  const thing = "ses_waits4";
  const { bytes, hash } = bundleFor(thing, [{ info: { id: thing, title: "Notes" }, messages: [] }], { "wakes.json": "[]" });
  const id = "mov_waits4";
  await say({ op: "offer", id, kind: "chat", thing, name: "“Notes”", size: bytes.length, hash, wasPaused: false, from: peerKey });
  await until(() => told.some(move => move.id === id && move.op === "ready"));
  stopLooks();
  await say({ op: "part", id, hash, i: 0, of: 1, d: bytes.toString("base64url") });
  await until(() => told.some(move => move.id === id && move.op === "arrived"));
  const listed = async () => (await ask("GET", "kuvo/moves")).json.moves.find(move => move.id === id);
  const at = Date.now();
  // Lab gets the original ready to go a while (a minute at most) before it switches: not waiting.
  link.keepMoving(at + 2 * 60_000);
  assert.equal((await listed()).waiting, undefined);
  // Quiet past that: waiting for lab.
  link.keepMoving(at + 3 * 60_000);
  assert.equal((await listed()).waiting, true);
  // Back, it switches: it lives here now.
  await say({ op: "switch", id });
  assert.ok(told.some(move => move.id === id && move.op === "switched"));
  assert.equal(await listed(), undefined);
}));

// ---- What a move leaves here: kept as the way back, then removed ----

const WEEK = 7 * 24 * 3600_000;
const leftHere = () => {
  try { return JSON.parse(fs.readFileSync(path.join(movesFolder, "left.json"), "utf8")); } catch { return []; }
};
const leftBy = thing => leftHere().find(each => each.thing === thing);
async function movedAwayChat(id) {
  chat(id);
  script = move => {
    if (move.op === "offer") say({ op: "ready", id: move.id });
    if (move.op === "part") {
      say({ op: "got", id: move.id, i: move.i });
      if (move.i === move.of - 1) say({ op: "arrived", id: move.id });
    }
    if (move.op === "switch") say({ op: "switched", id: move.id });
  };
  const moved = await ask("POST", "kuvo/moves", { kind: "chat", id, to: peerKey });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.ok(!engine.sessions.has(id), "it went");
  const entry = leftBy(id);
  assert.ok(entry?.trash && fs.existsSync(path.join(entry.trash, "conversation.json")), "and what it was is kept, as the way back");
  return entry;
}

test("what a move left stays until a week after it first ran on the other computer, then it's gone; only that computer's word counts", async () => {
  const entry = await movedAwayChat("ses_left1");
  const before = told.length;
  link.keepMoving(Date.now() + 2 * 3600_000);
  assert.ok(told.slice(before).some(move => move.op === "ran?" && move.id === entry.id && move.session === "ses_left1"), "it asks whether it's run there");
  // Never heard, however long: it stays.
  link.keepMoving(Date.now() + 90 * 24 * 3600_000);
  assert.ok(fs.existsSync(entry.trash));
  const at = Date.now();
  await link.takeMoveMail(studio, { op: "ran", id: entry.id, at });
  link.keepMoving(at + 2 * WEEK);
  assert.ok(fs.existsSync(entry.trash), "another computer's word isn't that one's");
  assert.equal(leftBy("ses_left1").ranAt, undefined);

  await say({ op: "ran", id: entry.id, at });
  link.keepMoving(at + WEEK - 1);
  assert.ok(fs.existsSync(entry.trash), "not before the week's up");
  link.keepMoving(at + WEEK + 1);
  await until(() => !fs.existsSync(entry.trash));
  await until(() => !leftBy("ses_left1"));
});

test("while it's on its way back, and as that's taken back, nothing it left goes; after that, it goes as it would have", async () => {
  const entry = await movedAwayChat("ses_left2");
  const at = Date.now();
  await say({ op: "ran", id: entry.id, at });
  const one = bundleFor("ses_left2", [{ info: { id: "ses_left2", title: "Trip plans" }, messages: [] }]);
  await say({ op: "offer", id: "mov_left2", kind: "chat", thing: "ses_left2", name: "“Trip plans”", size: one.bytes.length, hash: one.hash, wasPaused: false, from: peerKey });
  await until(() => told.some(move => move.id === "mov_left2" && move.op === "ready"));
  link.keepMoving(at + 2 * WEEK);
  assert.ok(fs.existsSync(entry.trash), "on its way, it's kept");
  assert.ok(leftBy("ses_left2"));
  await say({ op: "drop", id: "mov_left2" });
  await until(() => told.some(move => move.id === "mov_left2" && move.op === "dropped"));
  assert.ok(fs.existsSync(entry.trash), "taken back, it's kept until the next look");
  link.keepMoving(at + 2 * WEEK);
  await until(() => !fs.existsSync(entry.trash));
});

test("moved back before the week's up: what came is the one, the older copy goes, and nothing here is removed later", async () => {
  const entry = await movedAwayChat("ses_left3");
  const one = bundleFor("ses_left3", [{ info: { id: "ses_left3", title: "Trip plans, further on" }, messages: [] }]);
  await say({ op: "offer", id: "mov_left3", kind: "chat", thing: "ses_left3", name: "“Trip plans”", size: one.bytes.length, hash: one.hash, wasPaused: false, from: peerKey });
  await say({ op: "part", id: "mov_left3", hash: one.hash, i: 0, of: 1, d: one.bytes.toString("base64url") });
  await until(() => told.some(move => move.id === "mov_left3" && move.op === "arrived"));
  assert.ok(fs.existsSync(entry.trash), "not yet: it could still be taken back");
  await say({ op: "switch", id: "mov_left3" });
  await until(() => told.some(move => move.id === "mov_left3" && move.op === "switched"));
  assert.ok(!fs.existsSync(entry.trash));
  assert.equal(leftBy("ses_left3"), undefined);
  link.keepMoving(Date.now() + 2 * WEEK);
  assert.equal(engine.sessions.get("ses_left3")?.title, "Trip plans, further on");
});

test("asked whether what came here has run: when it first did since it came; not yet, no word; gone from here, the time starts", async () => {
  const file = path.join(movesFolder, "ended.json");
  const at = Date.now() - 3600_000;
  let kept = {};
  try { kept = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  Object.assign(kept, { mov_ran1: { as: "switched", at }, mov_ran2: { as: "switched", at }, mov_ran3: { as: "switched", at }, mov_ran4: { as: "dropped", at } });
  fs.writeFileSync(file, JSON.stringify(kept));
  engine.sessions.set("ses_ran1", { id: "ses_ran1", title: "Ran", directory: chats, messages: [], replies: [{ type: "assistant", time: { created: at + 500 } }, { type: "assistant", time: { created: at + 100 } }, { type: "assistant", time: { created: at - 100 } }, { type: "user", time: { created: at + 50 } }] });
  engine.sessions.set("ses_ran2", { id: "ses_ran2", title: "Not yet", directory: chats, messages: [], replies: [{ type: "assistant", time: { created: at - 100 } }] });
  const heard = id => told.filter(move => move.id === id && move.op === "ran");
  await say({ op: "ran?", id: "mov_ran1", session: "ses_ran1" });
  assert.deepEqual(heard("mov_ran1").map(move => move.at), [at + 100]);
  await say({ op: "ran?", id: "mov_ran2", session: "ses_ran2" });
  assert.deepEqual(heard("mov_ran2"), []);
  const asked = Date.now();
  await say({ op: "ran?", id: "mov_ran3", session: "ses_notHere" });
  assert.ok(heard("mov_ran3")[0]?.at >= asked);
  // One let go of, or one it never had, isn't a word of anything.
  await say({ op: "ran?", id: "mov_ran4", session: "ses_ran1" });
  await say({ op: "ran?", id: "mov_ran5", session: "ses_ran1" });
  assert.deepEqual([...heard("mov_ran4"), ...heard("mov_ran5")], []);
});

test("what came with it doesn't count as having run here, whatever the other computer's clock said", async () => {
  const file = path.join(movesFolder, "ended.json");
  const at = Date.now() - 3600_000;
  const kept = JSON.parse(fs.readFileSync(file, "utf8"));
  Object.assign(kept, { mov_skew: { as: "switched", at, last: "msg_came2" } });
  fs.writeFileSync(file, JSON.stringify(kept));
  // Its last reply there, timed by a clock an hour and more ahead of this one.
  const came = [{ id: "msg_came2", type: "assistant", time: { created: at + 5_000_000 } }, { id: "msg_came1", type: "user", time: { created: at + 4_000_000 } }];
  engine.sessions.set("ses_skew", { id: "ses_skew", title: "Skewed", directory: chats, messages: [], replies: came });
  const heard = () => told.filter(move => move.id === "mov_skew" && move.op === "ran");
  await say({ op: "ran?", id: "mov_skew", session: "ses_skew" });
  assert.deepEqual(heard(), [], "nothing's run here yet");
  // It runs here: its first reply here is when.
  engine.sessions.get("ses_skew").replies = [{ id: "msg_here1", type: "assistant", time: { created: at + 60_000 } }, { id: "msg_here0", type: "user", time: { created: at + 50_000 } }, ...came];
  await say({ op: "ran?", id: "mov_skew", session: "ses_skew" });
  assert.deepEqual(heard().map(move => move.at), [at + 60_000]);
});

test("asked where it can go, it says what stays here: the sessions it started, what it asked you, the goal it proposed", async () => {
  chat("ses_stays1");
  chat("ses_stays2");
  engine.sessions.set("ses_stays1w", { id: "ses_stays1w", title: "Its work", directory: chats, messages: [], metadata: { kuvo: { startedBy: "ses_stays1", depth: 1 } }, time: { created: 2 } });
  engine.sessions.set("ses_stays1ww", { id: "ses_stays1ww", title: "Its work's work", directory: chats, messages: [], metadata: { kuvo: { startedBy: "ses_stays1w", depth: 2 } }, time: { created: 3 } });
  const work = path.join(home, "run", "work");
  fs.mkdirSync(work, { recursive: true });
  const asked = { id: "ask_stays1", action: "makeProject", session: "ses_stays1", name: "“Trip plans”", project: "trip", folderName: "trip", folder: null, at: Date.now(), given: { name: "trip" } };
  fs.writeFileSync(path.join(work, "asks.json"), JSON.stringify({ asks: [asked] }));
  fs.writeFileSync(path.join(work, "goals.json"), JSON.stringify({ goals: [{ id: "goal_stays1", bot: "", session: "ses_stays1", name: "Book it", state: "proposed", proposed: Date.now(), projects: [] }] }));
  try {
    const places = await ask("GET", "kuvo/moves/places?kind=chat&id=ses_stays1");
    assert.equal(places.status, 200, JSON.stringify(places.json));
    assert.deepEqual(places.json.stays, { sessions: 2, asks: 1, goals: 1 });
    // Another chat, with none of it: nothing said.
    assert.equal((await ask("GET", "kuvo/moves/places?kind=chat&id=ses_stays2")).json.stays, undefined);
  } finally {
    fs.rmSync(path.join(work, "asks.json"), { force: true });
    fs.rmSync(path.join(work, "goals.json"), { force: true });
    for (const id of ["ses_stays1", "ses_stays2", "ses_stays1w", "ses_stays1ww"]) engine.sessions.delete(id);
  }
});

test("a move's folder that no move here has is cleared away after a while, never one a move has", async () => {
  const orphan = path.join(movesFolder, "mov_orphan1");
  fs.mkdirSync(path.join(orphan, "carry", "lanes"), { recursive: true });
  fs.writeFileSync(path.join(orphan, "carry", "lanes", "big"), "a copy of a conversation");
  const at = Date.now();
  link.keepMoving(at);
  link.keepMoving(at + 10 * 60_000);
  assert.ok(fs.existsSync(orphan), "not at once: a step may still be making it");
  link.keepMoving(at + 21 * 60_000);
  assert.ok(!fs.existsSync(orphan));
});

// ---- Whether it can run there, asked first ----

async function checking(run) {
  const file = path.join(home, "run", "peer-agents.json");
  fs.writeFileSync(file, JSON.stringify({ [peerKey]: { at: Date.now(), kind: "machine", list: [], features: ["sessions", "bots", "moves", "moves.agents", "moves.check"] } }));
  try { return await run(); } finally { fs.rmSync(file, { force: true }); }
}

test("the other computer says first whether it can run it: refused there, nothing was held here, and its words are said", () => checking(async () => {
  chat("ses_chk1");
  let asked = null;
  const said = "The coding agents on lab aren’t running. Try again once they are.";
  script = async move => {
    // (Others' mail, like a word of what an earlier move left, isn't this move's.)
    if (move.op !== "check" && move.id !== asked?.id) return;
    if (move.op !== "check") return assert.fail(`nothing more goes once it's refused: ${move.op}`);
    asked = move;
    // While it's asked, nothing's held here: a prompt goes, its wake-ups go on.
    assert.ok(!fs.existsSync(path.join(wakes, "ses_chk1", "paused")), "its wake-ups aren't held");
    const prompted = await ask("POST", "api/session/ses_chk1/prompt", { text: "Still here?" });
    assert.notEqual(prompted.status, 409, "a prompt isn't refused as moving");
    say({ op: "checked", id: move.id, ok: false, message: said });
  };
  const moved = await ask("POST", "kuvo/moves", { kind: "chat", id: "ses_chk1", to: peerKey });
  assert.equal(moved.status, 409);
  assert.equal(moved.json.message, said);
  assert.equal(asked?.kind, "chat");
  assert.deepEqual(told.filter(move => move.id === asked.id).map(move => move.op), ["check"]);
  await asItWas("ses_chk1");
}));

test("it can run there, another way: the move goes, and its answer says how", () => checking(async () => {
  chat("ses_chk2");
  const note = "On lab, Trip plans uses the Claude Code account signed in there (ada@example.com).";
  script = move => {
    if (move.op === "check") say({ op: "checked", id: move.id, ok: true, note });
    if (move.op === "offer") say({ op: "ready", id: move.id });
    if (move.op === "part") {
      say({ op: "got", id: move.id, i: move.i });
      if (move.i === move.of - 1) say({ op: "arrived", id: move.id });
    }
    if (move.op === "switch") say({ op: "switched", id: move.id });
  };
  const moved = await ask("POST", "kuvo/moves", { kind: "chat", id: "ses_chk2", to: peerKey });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal(moved.json.note, note);
  assert.ok(!engine.sessions.has("ses_chk2"));
}));

test("asked whether it can run what's coming: not with its coding agents down, nor on a model with no sign-in here; else yes", async () => {
  const answerTo = async (id, given) => {
    await say({ op: "check", id, kind: "bot", name: "Ada", ...given });
    await until(() => told.some(move => move.id === id && move.op === "checked"));
    return told.find(move => move.id === id && move.op === "checked");
  };
  const agents = await answerTo("mov_chk3", { lane: true, model: { providerID: "claude-code", id: "default" } });
  assert.equal(agents.ok, false);
  assert.match(agents.message, /coding agents on this Mac aren’t running/);
  const signedOut = await answerTo("mov_chk4", { model: { providerID: "anthropic", id: "claude-opus-5-5" } });
  assert.equal(signedOut.ok, false);
  assert.equal(signedOut.message, "Ada uses claude-opus-5-5, which needs a sign-in on this Mac. Sign in to it in Settings › Accounts there, or choose another model, then move Ada.");
  const fine = await answerTo("mov_chk5", { model: { providerID: "opencode", id: "big-pickle" } });
  assert.equal(fine.ok, true);
  // It keeps nothing of them: they're only questions.
  assert.deepEqual(underWay((await ask("GET", "kuvo/moves")).json), { moves: [], away: [] });
});

test("asked with its coding agents here on a model none of them has: the engine's sign-ins answer, not 'isn't installed'", async () => {
  const bridge = http.createServer((request, response) => {
    const send = data => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
    if (request.url.startsWith("/api/session/active")) return send({});
    if (request.url.startsWith("/api/integration")) return send([{ id: "claude-code", name: "Claude Code", metadata: { installed: true }, connections: [{}] }]);
    response.writeHead(404).end("{}");
  });
  await new Promise(resolve => bridge.listen(0, "127.0.0.1", resolve));
  const file = path.join(home, "run", "bridge.json");
  fs.writeFileSync(file, JSON.stringify({ port: bridge.address().port, password: "pw" }));
  try {
    const answerTo = async (id, model) => {
      await say({ op: "check", id, kind: "bot", name: "Ada", lane: true, model });
      await until(() => told.some(move => move.id === id && move.op === "checked"));
      return told.find(move => move.id === id && move.op === "checked");
    };
    const signedOut = await answerTo("mov_chk6", { providerID: "anthropic", id: "claude-opus-5-5" });
    assert.equal(signedOut.ok, false);
    assert.match(signedOut.message, /needs a sign-in on this Mac/);
    assert.equal((await answerTo("mov_chk7", { providerID: "opencode", id: "big-pickle" })).ok, true);
    assert.equal((await answerTo("mov_chk8", { providerID: "claude-code", id: "default" })).ok, true);
  } finally {
    fs.rmSync(file, { force: true });
    bridge.close();
  }
});

nodeTest("still in its turn after the wait: it says it's working, not that messages are on their way, and it stays as it was", { timeout: 120_000 }, async () => {
  chat("ses_busy1");
  engine.active = { ses_busy1: { type: "busy" } };
  const sent = [];
  script = move => { if (move.op === "offer" || move.op === "part") sent.push(move.op); };
  try {
    const moved = await ask("POST", "kuvo/moves", { kind: "chat", id: "ses_busy1", to: peerKey });
    assert.deepEqual(sent, [], "nothing went");
    assert.equal(moved.status, 409);
    assert.equal(moved.json.message, "“Trip plans” is working. Move it once it’s done.");
  } finally {
    engine.active = null;
    script = () => {};
  }
  await asItWas("ses_busy1");
});

// ---- A bot's own keys ----

test("a bot whose own key can't be kept here isn't set up: it's said back, and nothing of it stays", async () => {
  const packed = fs.mkdtempSync(path.join(support, "pack-"));
  const thing = "bot_keyed1", session = "ses_keyed1";
  fs.writeFileSync(path.join(packed, "move.json"), JSON.stringify({ kind: "bot", thing, name: "Kay", wasPaused: false, folder: thing, exports: [{ info: { id: session, title: "Kay" }, messages: [] }], keys: { "not-here": { TOKEN: "secret" } } }));
  fs.mkdirSync(path.join(packed, thing, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(packed, thing, "bot.json"), JSON.stringify({ kuvo: 1, id: thing, name: "Kay", model: { id: "big-pickle", providerID: "opencode" } }));
  fs.writeFileSync(path.join(packed, thing, "session"), `${session}\n`);
  const file = path.join(packed, "bundle.tgz");
  assert.equal(spawnSync("tar", ["-czf", file, "-C", packed, "move.json", thing]).status, 0);
  const bytes = fs.readFileSync(file), hash = crypto.createHash("sha256").update(bytes).digest("base64url");
  await say({ op: "offer", id: "mov_keyed1", kind: "bot", thing, name: "Kay", size: bytes.length, hash, wasPaused: false, from: peerKey });
  await say({ op: "part", id: "mov_keyed1", hash, i: 0, of: 1, d: bytes.toString("base64url") });
  await until(() => told.some(move => move.id === "mov_keyed1" && (move.op === "failed" || move.op === "arrived")));
  const failed = told.find(move => move.id === "mov_keyed1" && move.op === "failed");
  assert.ok(failed, "never arrived: the box it came from keeps it, with its key");
  assert.match(failed.message, /own key for not-here couldn’t be kept there/);
  assert.doesNotMatch(failed.message, /secret/);
  assert.ok(!engine.sessions.has(session));
  assert.ok(!fs.existsSync(path.join(support, "bots", thing)));
});

// ---- What still runs ----

test("one with a command still running in the background doesn't move (it would end): it says why, and stays as it was", async () => {
  chat("ses_bg1");
  const file = path.join(home, "run", "work", "background.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ engine: { sessions: { ses_bg1: { commands: [{ id: "cmd_1", command: "npm run dev", started: Date.now() }], subagents: [], tasks: [] } }, folders: [] } }));
  try {
    const places = (await ask("GET", "kuvo/moves/places?kind=chat&id=ses_bg1")).json.places;
    const lab = places.find(place => place.key === peerKey);
    assert.equal(lab.ok, false);
    assert.equal(lab.why, "“Trip plans” has a command running. Wait for it to finish, or stop it, then move “Trip plans”.");
    assert.equal(lab.note, "Running something");
    script = move => assert.fail(`nothing goes while it runs: ${move.op}`);
    const moved = await ask("POST", "kuvo/moves", { kind: "chat", id: "ses_bg1", to: peerKey });
    assert.equal(moved.status, 409);
    assert.match(moved.json.message, /has a command running/);
    await asItWas("ses_bg1");
  } finally {
    fs.rmSync(file, { force: true });
  }
});

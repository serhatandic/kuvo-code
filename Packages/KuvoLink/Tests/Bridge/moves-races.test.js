// Move to Computer when the two boxes' steps cross (PROTOCOL.md, `kuvo/moves`): one box, real,
// against a scripted other computer, whose mail it would send over the relay goes to the script
// instead (`sendMovesWith`). Whatever comes in what order, a move never leaves both copies gone,
// nor two live: a copy that couldn't be set up as it arrived leaves the original as it was; a switch
// the other computer can't honour (it let its copy go) leaves the original; parts that come twice
// set a copy up once; and a box answers a step for a move it doesn't have as dropped, never as
// switched. This Mac's box, here; its engine a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/moves-races.test.js`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

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
// (`down`: the engine went away; or one conversation's, `downFor`).
const engine = { sessions: new Map(), imports: 0, hold: null, holding: false, down: false, downFor: null, refused: 0 };
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => {
    const given = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const url = new URL(request.url, "http://x");
    const send = (status, data) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ data }));
    const listed = each => ({ id: each.id, title: each.title, directory: each.directory, location: { directory: each.directory } });
    if (url.pathname === "/api/session" && url.searchParams.get("parentID")) return send(200, [...engine.sessions.values()].filter(each => each.parentID === url.searchParams.get("parentID")).map(listed));
    if (url.pathname === "/api/session/active") return send(200, {});
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
      return session ? send(200, { info: { id: session.id, title: session.title, ...(session.parentID ? { parentID: session.parentID } : {}) }, messages: session.messages }) : send(404, null);
    }
    const match = url.pathname.match(/^\/api\/session\/([^/]+)(\/inbox)?$/);
    const session = match && engine.sessions.get(match[1]);
    if (!session) return send(404, null);
    if (match[2]) return send(200, []);
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
const peerKey = link.publicOf(link.newKey()).toString("base64url");
const lab = { key: peerKey, address: link.addressOf(crypto.randomBytes(32)).toString("base64url"), kind: "machine", name: "lab", id: "lab", sign: link.signingKeyOf(link.newSigningSeed()) };
// And another computer, "studio".
const studio = { key: link.publicOf(link.newKey()).toString("base64url"), address: link.addressOf(crypto.randomBytes(32)).toString("base64url"), kind: "machine", name: "studio", id: "studio" };
link.writeLink({ macPeers: [lab, studio] });
// Its keys, as its app gives them (kept in your Keychain, never in its files).
link.macLink.overlay = { key: link.newKey().toString("base64url"), secret: crypto.randomBytes(32).toString("base64url"), relay: "wss://relay.test", name: "Studio Mac" };
const told = [];
let script = () => {};
link.sendMovesWith((_peer, move) => {
  told.push(move);
  setImmediate(() => script(move));
  return true;
});
const say = move => link.takeMoveMail(lab, move);
const stop = new AbortController();
link.watchMoves(() => ({ send() {} }), stop.signal);
after(() => {
  stop.abort();
  link.sendMovesWith(null);
  server.closeAllConnections();
  server.close();
  fs.rmSync(support, { recursive: true, force: true });
});

const handle = link.engineHandler(link.readEngineFile, { name: "Mac" }, link.readBridgeFile, () => {}, null);
async function ask(method, p, given) {
  const parts = [];
  for await (const part of handle({ method, path: p, headers: {}, body: given ? Buffer.from(JSON.stringify(given)) : Buffer.alloc(0), fromApp: true }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  return { status: parts[0].head.status, json: text ? JSON.parse(text) : null };
}

// Until `found` holds: looked at again as the script hears more.
async function until(found) {
  for (let tries = 0; tries < 2000 && !found(); tries++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(found(), `never: ${found}`);
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
  assert.deepEqual((await ask("GET", "kuvo/moves")).json, { moves: [], away: [] });
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
  await say({ op: "switch", id });
  assert.ok(told.some(move => move.id === id && move.op === "switched"));
  assert.deepEqual((await ask("GET", "kuvo/moves")).json, { moves: [], away: [] });
  // A late repeat of the part: nothing set up again, nothing held.
  await say(part);
  assert.equal(engine.imports, 1);
  assert.deepEqual((await ask("GET", "kuvo/moves")).json, { moves: [], away: [] });
  // And a switch again (its answer was lost): switched still.
  await say({ op: "switch", id });
  assert.equal(told.filter(move => move.id === id && move.op === "switched").length, 2);
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
  for (const [name, text] of Object.entries(wakeFiles)) fs.writeFileSync(path.join(packed, thing, name), text);
  for (const [name, target] of Object.entries(links)) fs.symlinkSync(target, path.join(packed, thing, name));
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
  assert.deepEqual((await ask("GET", "kuvo/moves")).json, { moves: [], away: [] });
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
  assert.deepEqual((await ask("GET", "kuvo/moves")).json, { moves: [], away: [] });
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
  assert.deepEqual((await ask("GET", "kuvo/moves")).json, { moves: [], away: [] });
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
    assert.deepEqual(places.find(place => place.key === peerKey), { key: peerKey, name: "lab", kind: "machine", ok: false, why: "lab needs a newer Kuvo Code before things can move to or from it." });
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

// Files sent with a message are kept on the box a folder for each session, and go when their
// session is deleted, on any box, with no client connected: as the box hears it's deleted, or, for
// one deleted while it wasn't listening, as it finds its engine again. This Mac's box clears the
// Mac app's own copies of its sessions' files with them (its Attachments folder). A conversation
// that copied another's words (a branch, a handoff, one carried on) keeps the files they show.
// The real box code; only the engine and the coding agents' bridge are stand-ins.
//
// Run with `node --test box/bridge-tests/attachments-go.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test as nodeTest } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

// Each fails, rather than hangs, when what it waits for never comes.
const test = (name, run) => nodeTest(name, { timeout: 30_000 }, run);

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-attachments-")));
// The Mac app's Attachments folder, as this Mac's box is told it.
const mac = path.join(home, "Mac Attachments");
process.env.KUVO_HOME = home;
process.env.KUVO_MAC_ATTACHMENTS = mac;
removeAtEnd(home);
const link = await import("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js");
const kept = path.join(home, "attachments");
// A process the box takes for its coding agents' bridge's (by its name), which it looks for
// running before it judges anything gone.
const bridgeProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)", "kuvo-agents"], { stdio: "ignore" });
atEnd(() => bridgeProcess.kill());

// A place sessions live (the engine, or the coding agents' bridge): each session's metadata and
// messages, as it lists and answers them (`read`: how often each's were read), and its events, to
// whoever follows them. `down`: it can't list them now.
async function place(sessions = {}) {
  const state = { sessions, prompted: {}, read: {}, followers: [], awaiting: [], down: false };
  state.nextFollower = () => new Promise(resolve => state.awaiting.push(resolve));
  state.send = event => { for (const follower of state.followers) follower.write(`data: ${JSON.stringify(event)}\n\n`); };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": hello\n\n");
      state.followers.push(response);
      request.on("close", () => { state.followers = state.followers.filter(each => each !== response); });
      for (const resolve of state.awaiting.splice(0)) resolve();
      return;
    }
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (state.down) return reply({ message: "Starting." }, 503);
      if (url.pathname === "/api/session") return reply({ data: Object.entries(state.sessions).map(([id, each]) => ({ id, metadata: each.metadata ?? {} })) });
      if (url.pathname === "/api/model") return reply({ data: [{ id: "words", providerID: "p", capabilities: { input: ["text"] } }] });
      const [, id, rest] = url.pathname.match(/^\/api\/session\/([^/]+)(\/.*)?$/) ?? [];
      const session = state.sessions[id];
      if (!session) return reply({ message: "No such session." }, 404);
      if (!rest) return reply({ data: { id, metadata: session.metadata ?? {}, model: { id: "words", providerID: "p" } } });
      // Newest first, as the engine pages them.
      if (rest === "/message") {
        state.read[id] = (state.read[id] ?? 0) + 1;
        return reply({ data: [...(session.messages ?? [])].reverse() });
      }
      if (rest === "/prompt") {
        state.prompted[id] = JSON.parse(body);
        return reply({});
      }
      reply({ message: "Not here." }, 404);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  atEnd(() => { server.closeAllConnections(); server.close(); });
  state.target = { pid: process.pid, port: server.address().port, password: "pw", version: "2.0.32" };
  return state;
}

// What a phone's request gets from the handler.
async function answer(handle, method, p, body) {
  const parts = [];
  for await (const part of handle({ method, path: p, headers: {}, body: Buffer.from(body ?? "") }, {}, undefined)) parts.push(part);
  return { status: parts[0].head.status };
}

// A file sent from a phone to `session` with a message: where the box kept it, as the message's
// note says.
let messages = 0;
async function sent(engine, session, name) {
  const handle = link.engineHandler(() => engine.target);
  const files = [{ uri: `data:application/octet-stream;base64,${Buffer.from(name).toString("base64")}`, name }];
  // Each message its own id, as a client gives it: one under an id sent already is taken once.
  messages += 1;
  assert.equal((await answer(handle, "POST", `api/session/${session}/prompt`, JSON.stringify({ id: `msg_${messages}`, text: "Look", files }))).status, 200);
  const where = engine.prompted[session].text.split("\n").filter(line => line.startsWith(kept + path.sep));
  assert.equal(where.length, 1, engine.prompted[session].text);
  assert.equal(path.basename(where[0]), name);
  return where[0];
}

// A file of the Mac app's own, sent in `session` (or, with none, waiting in a composer).
function macFile(session, name) {
  const file = session ? path.join(mac, session, name) : path.join(mac, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, name);
  return file;
}

// This box watching its engine and its coding agents' bridge (a machine's link and this Mac's box
// alike), until the test ends; `looked` hears each time it's looked over what a deleted session
// left (null: all it no longer has).
async function watching(engine, bridge, t, looked) {
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify(engine.target));
  fs.writeFileSync(path.join(home, "run", "bridge.json"), JSON.stringify({ ...bridge.target, pid: bridgeProcess.pid }));
  const stop = new AbortController();
  t.after(() => stop.abort());
  const following = engine.nextFollower();
  link.watchBox({ bots: true, notices: false, signal: stop.signal, attachmentsLooked: looked });
  await following;
}

test("a session's files go as it's deleted, the Mac app's own copies with them; another session's, and a file waiting to be sent, stay", async t => {
  const engine = await place({ ses_gone1: {}, ses_stays1: {} });
  const bridge = await place({});
  const gone = await sent(engine, "ses_gone1", "plan.pdf");
  const stays = await sent(engine, "ses_stays1", "notes.txt");
  assert.equal(path.relative(kept, gone).split(path.sep)[0], "ses_gone1", "kept in a folder of its session's");
  const macGone = macFile("ses_gone1", "Pasted Image.png");
  const macStays = macFile("ses_stays1", "shot.png");
  const waiting = macFile(null, "Pasted Image 2.png");

  let heard;
  const lookedAtIt = new Promise(resolve => { heard = resolve; });
  await watching(engine, bridge, t, session => session === "ses_gone1" && heard());
  delete engine.sessions.ses_gone1;
  engine.send({ type: "session.deleted", data: { sessionID: "ses_gone1" } });
  await lookedAtIt;

  assert.equal(fs.existsSync(path.join(kept, "ses_gone1")), false);
  assert.equal(fs.existsSync(path.join(mac, "ses_gone1")), false);
  assert.equal(fs.existsSync(macGone), false);
  for (const file of [stays, macStays, waiting]) assert.ok(fs.existsSync(file), file);
});

test("a branch, a handoff or a carried-on conversation keeps the files its words show, until it's deleted too", async t => {
  const engine = await place({ ses_source1: {}, ses_branch1: {}, ses_plain1: {} });
  const file = await sent(engine, "ses_source1", "design.png");
  const own = await sent(engine, "ses_branch1", "more.png");
  // A branch copies its source's words, and the paths in them.
  engine.sessions.ses_branch1.metadata = { kuvo: { branchedFrom: "ses_source1" } };
  engine.sessions.ses_branch1.messages = [{ id: "msg_1", parts: [{ type: "text", text: `Look\n\n<attached-files>\n${file}\n</attached-files>` }] }];
  // One that isn't from another, naming it in its words: it doesn't hold the source's files.
  engine.sessions.ses_plain1.messages = [{ id: "msg_1", parts: [{ type: "text", text: file }] }];

  const bridge = await place({});
  let heard = {};
  const lookedAt = session => new Promise(resolve => { heard[session] = resolve; });
  await watching(engine, bridge, t, session => heard[session]?.());
  let looked = lookedAt("ses_source1");
  delete engine.sessions.ses_source1;
  engine.send({ type: "session.deleted", data: { sessionID: "ses_source1" } });
  await looked;
  assert.ok(fs.existsSync(file), "the branch still shows it");

  // The branch deleted: its own files go, and the source's, which nothing shows any more, go once
  // the box looks over what's left (as it finds its engine again).
  looked = lookedAt("ses_branch1");
  delete engine.sessions.ses_branch1;
  engine.send({ type: "session.deleted", data: { sessionID: "ses_branch1" } });
  await looked;
  assert.equal(fs.existsSync(own), false);
  await link.letAttachmentsGo({ engine: engine.target, bridge: bridge.target });
  assert.equal(fs.existsSync(path.join(kept, "ses_source1")), false);

  // A branch of a branch: its words show the first one's files, and keep them after the one
  // between is deleted too.
  engine.sessions.ses_first1 = {};
  const first = await sent(engine, "ses_first1", "first.png");
  engine.sessions.ses_middle1 = { metadata: { kuvo: { branchedFrom: "ses_first1" } } };
  engine.sessions.ses_last1 = { metadata: { kuvo: { branchedFrom: "ses_middle1" } }, messages: [{ id: "msg_1", parts: [{ type: "text", text: first }] }] };
  delete engine.sessions.ses_middle1;
  delete engine.sessions.ses_first1;
  await link.letAttachmentsGo({ engine: engine.target, bridge: bridge.target }, "ses_first1");
  assert.ok(fs.existsSync(first));
  // And with the one between still there.
  engine.sessions.ses_first2 = {};
  const second = await sent(engine, "ses_first2", "second.png");
  engine.sessions.ses_middle2 = { metadata: { kuvo: { branchedFrom: "ses_first2" } } };
  engine.sessions.ses_last2 = { metadata: { kuvo: { branchedFrom: "ses_middle2" } }, messages: [{ id: "msg_1", parts: [{ type: "text", text: second }] }] };
  delete engine.sessions.ses_first2;
  engine.read = {};
  await link.letAttachmentsGo({ engine: engine.target, bridge: bridge.target }, "ses_first2");
  assert.ok(fs.existsSync(second));
  assert.equal(engine.read.ses_plain1, undefined, "a conversation that didn't start from another's isn't read");

  // A handoff, or a conversation carried on with the coding agents, in the bridge: the same.
  for (const mark of ["handoffFrom", "carriedFrom"]) {
    engine.sessions.ses_from1 = {};
    const from = await sent(engine, "ses_from1", "spec.md");
    bridge.sessions.ses_on1 = { metadata: { kuvo: { [mark]: "ses_from1" } }, messages: [{ id: "msg_1", parts: [{ type: "file", url: `file://${from}` }] }] };
    delete engine.sessions.ses_from1;
    await link.letAttachmentsGo({ engine: engine.target, bridge: bridge.target }, "ses_from1");
    assert.ok(fs.existsSync(from), mark);
    delete bridge.sessions.ses_on1;
    await link.letAttachmentsGo({ engine: engine.target, bridge: bridge.target });
    assert.equal(fs.existsSync(from), false, mark);
  }
});

test("what a session left while the box wasn't listening goes as it finds its engine again, only once both its places say it's gone; this Mac's box leaves the Mac app's folder to the app there", async t => {
  const engine = await place({ ses_here1: {} });
  const bridge = await place({ ses_agents1: {} });
  const here = await sent(engine, "ses_here1", "a.txt");
  // Kept for a coding agents' session (the bridge keeps it), and for one deleted meanwhile.
  const agents = path.join(kept, "ses_agents1", "0a0b0c0d", "b.txt");
  const left = path.join(kept, "ses_left1", "0a0b0c0e", "c.txt");
  for (const file of [agents, left]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x");
  }
  // A machine's session's copies on this Mac: not this box's to judge. Nor those of one that
  // left this box (moved to a machine long ago, say), where it's kept a folder too.
  const machines = macFile("ses_machine1", "d.png");
  const leftForAMachine = macFile("ses_left1", "c.png");

  // The bridge not running: its sessions can't be told from deleted ones, so all stay.
  await link.letAttachmentsGo({ engine: engine.target, bridge: null });
  assert.ok(fs.existsSync(left));
  // Nor while either can't say.
  bridge.down = true;
  await link.letAttachmentsGo({ engine: engine.target, bridge: bridge.target });
  assert.ok(fs.existsSync(left));
  bridge.down = false;
  engine.down = true;
  await link.letAttachmentsGo({ engine: engine.target, bridge: bridge.target });
  assert.ok(fs.existsSync(left));
  engine.down = false;

  await link.letAttachmentsGo({ engine: engine.target, bridge: bridge.target });
  assert.equal(fs.existsSync(path.join(kept, "ses_left1")), false);
  for (const file of [here, agents, machines, leftForAMachine]) assert.ok(fs.existsSync(file), file);

  // And as the box finds its engine (started, or started again).
  const again = path.join(kept, "ses_left2", "0a0b0c0f", "e.txt");
  fs.mkdirSync(path.dirname(again), { recursive: true });
  fs.writeFileSync(again, "x");
  let heard;
  const sweep = new Promise(resolve => { heard = resolve; });
  await watching(engine, bridge, t, session => session === null && !fs.existsSync(again) && heard());
  await sweep;
  for (const file of [here, agents, machines]) assert.ok(fs.existsSync(file), file);
});

test("a deleted session's files stay while the box can't read its conversations, or its coding agents aren't running", async () => {
  const engine = await place({ ses_unread1: {}, ses_branch2: { metadata: { kuvo: { branchedFrom: "ses_unread1" } } } });
  const bridge = await place({});
  const file = await sent(engine, "ses_unread1", "f.txt");
  delete engine.sessions.ses_unread1;
  engine.down = true;
  await link.letAttachmentsGo({ engine: engine.target, bridge: bridge.target }, "ses_unread1");
  assert.ok(fs.existsSync(file));
  engine.down = false;
  // (A conversation carried on there may show them.)
  await link.letAttachmentsGo({ engine: engine.target, bridge: null }, "ses_unread1");
  assert.ok(fs.existsSync(file));
  await link.letAttachmentsGo({ engine: engine.target, bridge: bridge.target }, "ses_unread1");
  assert.equal(fs.existsSync(file), false);
});

test("a conversation moving to another computer, moved there, or a copy here let go of as its move is taken back keeps its files here, the Mac app's copies too", async () => {
  const moves = path.join(home, "run", "moves");
  fs.mkdirSync(moves, { recursive: true });
  try {
    const engine = await place({ ses_moving1: {}, ses_moved1: {}, ses_dropped1: {} });
    const bridge = await place({});
    const files = [];
    for (const session of ["ses_moving1", "ses_moved1", "ses_dropped1"]) files.push(await sent(engine, session, "g.txt"), macFile(session, "Pasted Image.png"));
    // Under way; moved lately; and a copy that came here, taken back (it lives on where it came from).
    fs.writeFileSync(path.join(moves, "mov_under1.json"), JSON.stringify({ id: "mov_under1", thing: "ses_moving1", peer: "another-box", role: "from", sessions: ["ses_moving1"], started: Date.now(), tries: 0 }));
    fs.writeFileSync(path.join(moves, "moved.json"), JSON.stringify([{ session: "ses_moved1", key: "another-box", at: Date.now() }]));
    fs.writeFileSync(path.join(moves, "ended.json"), JSON.stringify({ mov_back1: { as: "dropped", at: Date.now(), sessions: ["ses_dropped1"] } }));
    for (const session of ["ses_moving1", "ses_moved1", "ses_dropped1"]) {
      delete engine.sessions[session];
      await link.letAttachmentsGo({ engine: engine.target, bridge: bridge.target }, session);
    }
    await link.letAttachmentsGo({ engine: engine.target, bridge: bridge.target });
    for (const file of files) assert.ok(fs.existsSync(file), file);
  } finally {
    fs.rmSync(moves, { recursive: true, force: true });
  }
});

test("files older than two weeks still go, kept a folder for each session or as before", async () => {
  const engine = await place({ ses_old1: {} });
  const weeksAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  const flat = path.join(kept, "0ld0ld00");
  const nested = path.join(kept, "ses_old2", "0ld0ld01");
  for (const folder of [flat, nested]) {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "old.txt"), "old");
    fs.utimesSync(folder, weeksAgo, weeksAgo);
  }
  const fresh = await sent(engine, "ses_old1", "new.txt");
  assert.equal(fs.existsSync(flat), false);
  assert.equal(fs.existsSync(path.join(kept, "ses_old2")), false, "its session's folder, left empty, with it");
  assert.ok(fs.existsSync(fresh));
});

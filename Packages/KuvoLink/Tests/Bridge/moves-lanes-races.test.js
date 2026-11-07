// Move to Computer with a coding agent, against a scripted other computer (`sendMovesWith`): what the
// checks are for. Something written after the conversation was packed is noticed, and it all goes
// again, or stays; what's in place there not matching takes it back; a computer that goes quiet for
// good leaves the original as it was. This Mac's box, here, with the real agents bridge; the engine a
// stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/moves-lanes-races.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test as nodeTest } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";
import { NO_BUN, testBun } from "./bun-for-tests.js";

let running;
const test = (name, run) => nodeTest(name, { timeout: 60_000 }, t => {
  running = t.signal;
  return run(t);
});

const bun = testBun();
assert.ok(bun, NO_BUN);
const bridgeScript = fileURLToPath(new URL("../../../../KuvoCode/Resources/kuvo-agents.js", import.meta.url));
const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-lanes-races-")));
removeAtEnd(support);
const home = path.join(support, "mac"), bots = path.join(support, "bots"), agents = path.join(support, "agents"), claude = path.join(support, "claude");
fs.mkdirSync(path.join(home, "run"), { recursive: true });
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
};
const slug = directory => directory.replace(/[^a-zA-Z0-9]/g, "-");

// A bot on Claude Code, as it's kept: seeded before the bridge reads its sessions.
function seedBot(bot) {
  const folder = path.join(bots, bot), work = path.join(folder, "workspace"), session = `ses_${bot.slice(4)}`, id = crypto.randomUUID();
  write(path.join(folder, "bot.json"), { kuvo: 1, id: bot, name: bot, model: { id: "default", providerID: "claude-code" } });
  write(path.join(folder, "session"), `${session}\n`);
  write(path.join(folder, "via"), "bridge\n");
  fs.mkdirSync(work, { recursive: true });
  const kept = path.join(agents, "sessions", session);
  write(path.join(kept, "session.json"), { id: session, projectID: "prj_x", model: { id: "default", providerID: "claude-code" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 }, title: bot, location: { directory: work }, metadata: { kuvo: { bot } } });
  write(path.join(kept, "messages.json"), [{ id: `msg_${session}`, sessionID: session, type: "user", text: "Hello.", time: { created: 1 } }, { id: `msg_${session}x`, type: "idle", outcome: "succeeded", time: { created: 2 } }]);
  write(path.join(kept, "agent.json"), { threads: { "claude-code": { state: { claudeSession: id, claudeStarted: true }, seen: `msg_${session}` } } });
  const file = path.join(claude, "projects", slug(work), `${id}.jsonl`);
  write(file, '{"type":"user"}\n');
  return { bot, session, file, id, folder };
}
const late = seedBot("bot_late"), always = seedBot("bot_always"), wrong = seedBot("bot_wrong"), quiet = seedBot("bot_quiet"), tampered = seedBot("bot_tampered"), linked = seedBot("bot_linked");
fs.mkdirSync(path.join(path.dirname(linked.file), linked.id), { recursive: true });
fs.symlinkSync("/etc/hosts", path.join(path.dirname(linked.file), linked.id, "elsewhere"));

// What a move leaves: a bot with its memory in Claude Code's folder, and a session it started in a
// project, which stays here for good, with Claude Code's own files for it; and one whose workspace a
// session it started still works in, so its memory there is that session's too.
const memoryOf = ({ file }) => path.join(path.dirname(file), "memory");
const seedStarted = (session, directory) => {
  const id = crypto.randomUUID(), kept = path.join(agents, "sessions", session);
  fs.mkdirSync(directory, { recursive: true });
  write(path.join(kept, "session.json"), { id: session, projectID: "prj_x", model: { id: "default", providerID: "claude-code" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 }, title: session, location: { directory } });
  write(path.join(kept, "messages.json"), [{ id: `msg_${session}`, sessionID: session, type: "user", text: "Hello.", time: { created: 1 } }, { id: `msg_${session}x`, type: "idle", outcome: "succeeded", time: { created: 2 } }]);
  write(path.join(kept, "agent.json"), { threads: { "claude-code": { state: { claudeSession: id, claudeStarted: true }, seen: `msg_${session}` } } });
  const file = path.join(claude, "projects", slug(directory), `${id}.jsonl`);
  write(file, '{"type":"user","started":true}\n');
  return { session, file };
};
const leaves = seedBot("bot_leaves"), shares = seedBot("bot_shares");
write(path.join(memoryOf(leaves), "MEMORY.md"), "The bot's.\n");
write(path.join(path.dirname(leaves.file), leaves.id, "subagents", "agent-1.jsonl"), "{}\n");
write(path.join(memoryOf(shares), "MEMORY.md"), "Both of them use this.\n");
const started = seedStarted("ses_started", path.join(support, "project"));
write(path.join(memoryOf(started), "MEMORY.md"), "The project's.\n");
const startedThere = seedStarted("ses_startedThere", path.join(shares.folder, "workspace"));

write(path.join(agents, "claude", "tokens", "default.json"), { token: "stand-in" });
const bridge = spawn(bun, [bridgeScript], {
  env: {
    PATH: process.env.PATH, HOME: support, TMPDIR: process.env.TMPDIR ?? os.tmpdir(), BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    KUVO_AGENTS_HOME: agents, OPENCODE_PASSWORD: "pw", CLAUDE_CONFIG_DIR: claude,
    KUVO_GROUPS: path.join(support, "groups"), KUVO_BOTS: bots, KUVO_TRASH: path.join(home, "trash"), KUVO_ARTIFACTS: path.join(support, "artifacts"),
  },
  stdio: ["pipe", "pipe", "inherit"],
});
const port = await new Promise((resolve, reject) => {
  let out = "";
  bridge.stdout.on("data", chunk => {
    out += chunk;
    const line = out.split("\n").find(each => each.startsWith("{"));
    if (line) resolve(Number(new URL(JSON.parse(line).url).port));
  });
  bridge.once("exit", status => reject(new Error(`the agents bridge stopped (${status})`)));
});
bridge.removeAllListeners("exit");
atEnd(async () => {
  const gone = new Promise(resolve => bridge.once("exit", resolve));
  bridge.stdin.end();
  bridge.kill("SIGTERM");
  await gone;
});
write(path.join(home, "run", "bridge.json"), { port, password: "pw", pid: bridge.pid });
const asks = (method, route, given) => fetch(`http://127.0.0.1:${port}${route}`, {
  method,
  headers: { authorization: `Basic ${Buffer.from("opencode:pw").toString("base64")}`, ...(given ? { "content-type": "application/json" } : {}) },
  body: given ? JSON.stringify(given) : undefined,
}).then(async response => ({ status: response.status, json: await response.json().catch(() => null) }));

const engine = http.createServer((request, response) => {
  const send = (status, data) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ data }));
  if (request.url === "/api/session/active") return send(200, {});
  if (request.url.startsWith("/api/session/")) return send(404, null);
  return send(200, []);
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
write(path.join(home, "run", "engine.json"), { port: engine.address().port, password: "pw" });

Object.assign(process.env, { KUVO_HOME: home, KUVO_BOTS: bots, KUVO_WAKES: path.join(support, "wakes"), KUVO_BOX: "mac", KUVO_ENGINE_CONFIG: path.join(support, "opencode"), KUVO_KEYS: path.join(support, "keys") });
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
const labKey = link.publicOf(link.newKey()).toString("base64url");
const lab = { key: labKey, address: link.addressOf(crypto.randomBytes(32)).toString("base64url"), kind: "machine", name: "lab", id: "lab", sign: link.signingKeyOf(link.newSigningSeed()) };
link.writeLink({ macPeers: [lab] });
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
link.watchMoves(() => ({ send: () => true }), stop.signal);
atEnd(() => {
  stop.abort();
  link.sendMovesWith(null);
});
const handle = link.engineHandler(link.readEngineFile, { name: "Mac" }, link.readBridgeFile, () => {}, null);
async function ask(method, p, given) {
  const parts = [];
  for await (const part of handle({ method, path: p, headers: {}, body: given ? Buffer.from(JSON.stringify(given)) : Buffer.alloc(0), fromApp: true }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  return { status: parts[0].head.status, json: text ? JSON.parse(text) : null };
}
async function until(found) {
  const signal = running;
  while (!(await found())) {
    signal.throwIfAborted();
    await new Promise(resolve => setImmediate(resolve));
  }
}
const digestOf = async session => (await asks("POST", "/api/kuvo/carry/digest", { root: session })).json.data.digest;
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// As it was before it moved: on this computer, nothing holding it.
async function asItWas({ bot, session, file }, wrote) {
  assert.equal((await asks("GET", `/api/session/${session}`)).status, 200, "its conversation is still here");
  assert.ok(fs.existsSync(path.join(bots, bot, "bot.json")), "its folder is still here");
  assert.ok(!fs.existsSync(path.join(bots, bot, "paused")), "and it goes on");
  assert.equal(fs.readFileSync(file, "utf8"), wrote);
  await until(async () => (await ask("GET", "kuvo/moves")).json.moves.length === 0);
}

test("written after it was packed (a wake-up, a letter): it's noticed, and it all goes again with that in it", async () => {
  let offers = 0;
  const digests = [];
  script = async move => {
    if (move.op === "offer") {
      offers++;
      digests.push(await digestOf(late.session));
      // The first time it's written to as it goes, once it's been read for sending.
      if (offers === 1) fs.appendFileSync(late.file, '{"type":"assistant","late":true}\n');
      say({ op: "ready", id: move.id });
    }
    if (move.op === "part") {
      say({ op: "got", id: move.id, i: move.i });
      if (move.i === move.of - 1) say({ op: "arrived", id: move.id, hash: move.hash, digest: digests.at(-1) });
    }
    if (move.op === "switch") say({ op: "switched", id: move.id });
  };
  const moved = await ask("POST", "kuvo/moves", { kind: "bot", id: late.bot, to: labKey });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal(offers, 2, "it went again");
  const sent = told.filter(move => move.op === "offer");
  assert.notEqual(sent.at(-1).hash, sent.at(-2).hash, "with what was written");
  assert.notEqual(digests[1], digests[0]);
  assert.equal((await asks("GET", `/api/session/${late.session}`)).status, 404, "let go here once it was the same");
});

test("written to again and again: it stays where it is, as it was", async () => {
  let wrote = fs.readFileSync(always.file, "utf8");
  const digests = [];
  script = async move => {
    if (move.op === "offer") {
      digests.push(await digestOf(always.session));
      fs.appendFileSync(always.file, '{"type":"assistant"}\n');
      wrote = fs.readFileSync(always.file, "utf8");
      say({ op: "ready", id: move.id });
    }
    if (move.op === "part") {
      say({ op: "got", id: move.id, i: move.i });
      if (move.i === move.of - 1) say({ op: "arrived", id: move.id, hash: move.hash, digest: digests.at(-1) });
    }
    if (move.op === "switch") assert.fail("it never switches to a copy that isn't the same");
    if (move.op === "drop") say({ op: "dropped", id: move.id });
  };
  const moved = await ask("POST", "kuvo/moves", { kind: "bot", id: always.bot, to: labKey });
  assert.equal(moved.status, 409);
  assert.match(moved.json.message, /kept getting messages/);
  await asItWas(always, wrote);
});

test("what's in place there isn't what was sent: taken back, and nothing's let go here", async () => {
  const wrote = fs.readFileSync(wrong.file, "utf8");
  script = move => {
    if (move.op === "offer") say({ op: "ready", id: move.id });
    if (move.op === "part") {
      say({ op: "got", id: move.id, i: move.i });
      if (move.i === move.of - 1) say({ op: "arrived", id: move.id, hash: move.hash, digest: "not-the-same" });
    }
    if (move.op === "switch") assert.fail("it never switches to a copy that isn't the same");
    if (move.op === "drop") say({ op: "dropped", id: move.id });
  };
  const moved = await ask("POST", "kuvo/moves", { kind: "bot", id: wrong.bot, to: labKey });
  assert.equal(moved.status, 409);
  assert.match(moved.json.message, /didn’t come out the same/);
  await asItWas(wrong, wrote);
});

test("the other computer quiet for good as it's sent: taken back, nothing half done here", async () => {
  const wrote = fs.readFileSync(quiet.file, "utf8");
  // It takes the offer, then is never heard from again.
  script = move => {
    if (move.op === "offer") say({ op: "ready", id: move.id });
    if (move.op === "drop") say({ op: "dropped", id: move.id });
  };
  const moving = ask("POST", "kuvo/moves", { kind: "bot", id: quiet.bot, to: labKey });
  await until(() => {
    const offer = told.find(move => move.op === "offer" && move.thing === quiet.bot);
    return offer && told.some(move => move.op === "part" && move.id === offer.id);
  });
  link.keepMoving(Date.now() + 11 * 60_000);
  const moved = await moving;
  assert.equal(moved.status, 503);
  assert.match(moved.json.message, /stopped answering/);
  await asItWas(quiet, wrote);
});

test("what came doesn't match what it says it is: nothing's placed, and what was there stays", async () => {
  const from = path.join(support, "bundle"), keep = path.join(support, "keep");
  const packed = await asks("POST", "/api/kuvo/carry/pack", { root: tampered.session, into: from });
  assert.equal(packed.status, 200, JSON.stringify(packed.json));
  assert.equal(packed.json.data.lanes[0].how, "files");
  // It's on this computer: as if another's, a file of the same name, and a copy that's lost a word.
  await asks("DELETE", `/api/session/${tampered.session}`);
  const there = fs.readFileSync(tampered.file, "utf8");
  const place = () => asks("POST", "/api/kuvo/carry/place", { from, keep, directory: path.join(tampered.folder, "workspace"), root: tampered.session });
  const file = path.join(from, "lanes", "0", "conversation", `${tampered.id}.jsonl`);
  const whole = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, whole.replace("user", "useR"));
  const refused = await place();
  assert.equal(refused.status, 409);
  assert.match(refused.json.message, /didn't come whole/);
  assert.equal(fs.readFileSync(tampered.file, "utf8"), there);
  assert.equal((await asks("GET", `/api/session/${tampered.session}`)).status, 404, "nothing was added");

  // Whole: placed over what was there, and undone puts that back.
  fs.writeFileSync(file, whole);
  fs.writeFileSync(tampered.file, "what was here before\n");
  const placed = await place();
  assert.equal(placed.status, 200, JSON.stringify(placed.json));
  assert.equal(fs.readFileSync(tampered.file, "utf8"), whole);
  assert.equal((await asks("GET", `/api/session/${tampered.session}`)).status, 200);
  const undone = await asks("POST", "/api/kuvo/carry/undo", { keep });
  assert.equal(undone.status, 200, JSON.stringify(undone.json));
  assert.equal(fs.readFileSync(tampered.file, "utf8"), "what was here before\n");
  assert.equal((await asks("GET", `/api/session/${tampered.session}`)).status, 404);
});

test("a conversation with something in it that isn't a plain file can't be packed: it's said so, and it stays", async () => {
  const wrote = fs.readFileSync(linked.file, "utf8");
  script = move => {
    if (move.op === "drop") say({ op: "dropped", id: move.id });
  };
  const moved = await ask("POST", "kuvo/moves", { kind: "bot", id: linked.bot, to: labKey });
  assert.equal(moved.status, 409);
  assert.match(moved.json.message, /something that isn't a plain file \(elsewhere\)/);
  await asItWas(linked, wrote);
});

test("a bridge that isn't running says why", async () => {
  const record = path.join(home, "run", "bridge.json");
  const was = fs.readFileSync(record, "utf8");
  write(record, { port: 9, password: "pw", pid: 999999 });
  try {
    const places = await ask("GET", `kuvo/moves/places?kind=bot&id=${quiet.bot}`);
    assert.equal(places.json.places[0].ok, false);
    assert.match(places.json.places[0].why, /coding agents on this Mac aren’t running/);
  } finally {
    write(record, was);
  }
});

// ---- What a move leaves here: kept as the way back, then removed ----

const WEEK = 7 * 24 * 3600_000;
const leftHere = () => {
  try { return JSON.parse(fs.readFileSync(path.join(home, "run", "moves", "left.json"), "utf8")); } catch { return []; }
};
const moveAway = async ({ bot, session }) => {
  script = async move => {
    if (move.op === "offer") say({ op: "ready", id: move.id });
    if (move.op === "part") {
      say({ op: "got", id: move.id, i: move.i });
      if (move.i === move.of - 1) say({ op: "arrived", id: move.id, hash: move.hash, digest: await digestOf(session) });
    }
    if (move.op === "switch") say({ op: "switched", id: move.id });
  };
  const moved = await ask("POST", "kuvo/moves", { kind: "bot", id: bot, to: labKey });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal((await asks("GET", `/api/session/${session}`)).status, 404, "it can't run here any more");
  return leftHere().find(each => each.thing === bot);
};

test("what a move left of a Claude Code bot goes a week after it ran there: its conversation and memory, never a session it started", async () => {
  const entry = await moveAway(leaves);
  const beside = path.join(path.dirname(leaves.file), leaves.id);
  assert.ok(fs.existsSync(leaves.file) && fs.existsSync(memoryOf(leaves)) && fs.existsSync(beside), "kept, as the way back");
  assert.ok(entry?.ranAt === undefined);
  link.keepMoving(Date.now() + 90 * 24 * 3600_000);
  assert.ok(fs.existsSync(leaves.file), "with no word it's run there, it stays");

  const at = Date.now();
  await say({ op: "ran", id: entry.id, at });
  link.keepMoving(at + WEEK - 1);
  assert.ok(fs.existsSync(leaves.file), "not before the week's up");
  link.keepMoving(at + WEEK + 1);
  await until(() => !leftHere().some(each => each.id === entry.id));
  assert.ok(!fs.existsSync(leaves.file) && !fs.existsSync(beside) && !fs.existsSync(memoryOf(leaves)), "all of it's gone");
  if (entry.trash) assert.ok(!fs.existsSync(entry.trash));
  // What it started stays, and still runs here.
  assert.ok(fs.existsSync(started.file));
  assert.equal(fs.readFileSync(path.join(memoryOf(started), "MEMORY.md"), "utf8"), "The project's.\n");
  assert.equal((await asks("GET", `/api/session/${started.session}`)).status, 200);
});

test("a memory folder a session it started still uses stays when the rest of what it left goes", async () => {
  const entry = await moveAway(shares);
  const at = Date.now();
  await say({ op: "ran", id: entry.id, at });
  link.keepMoving(at + WEEK + 1);
  await until(() => !leftHere().some(each => each.id === entry.id));
  assert.ok(!fs.existsSync(shares.file), "its conversation's gone");
  assert.equal(fs.readFileSync(path.join(memoryOf(shares), "MEMORY.md"), "utf8"), "Both of them use this.\n");
  assert.ok(fs.existsSync(startedThere.file));
  assert.equal((await asks("GET", `/api/session/${startedThere.session}`)).status, 200);
});

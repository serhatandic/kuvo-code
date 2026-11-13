// Group chats across your computers (PROTOCOL.md, "Peers": `seat`): the link carries the coding
// agents' bridge's mail between computers, now or until it's there, in parts when it's big, and
// tells the bridge who your other computers and their bots are. Run with
// `node --test Packages/KuvoLink/Tests/Bridge/*.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { removeAtEnd } from "./at-end.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-seats-"));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

const run = path.join(home, "run");
const k = key => key.toString("base64url");
const box = (kind, id) => {
  const key = link.newKey();
  const address = k(link.addressOf(crypto.randomBytes(32)));
  return { key, pub: k(link.publicOf(key)), address, peer: { key: k(link.publicOf(key)), address, name: id ?? kind, kind, ...(id ? { id } : {}) } };
};
const here = box("machine", "devbox"), mac = box("mac"), second = box("machine", "second");
const fresh = () => {
  fs.rmSync(run, { recursive: true, force: true });
  fs.mkdirSync(run, { recursive: true });
  link.writeLink({ secret: crypto.randomBytes(32).toString("base64url"), key: k(here.key), relay: "wss://relay.test", name: "devbox", id: "devbox", mac: mac.pub, macs: [mac.pub], phones: [], peersFrom: { [mac.pub]: { at: 1, peers: [mac.peer, second.peer] } } });
};
const opened = (bytes, to) => {
  const body = link.readFrame(bytes.subarray(17)).body;
  return { address: k(bytes.subarray(1, 17)), payload: JSON.parse(link.openOneWay(body, to.key, link.publicOf(here.key)).payload.toString("utf8")) };
};
// The bridge, as the link asks it: what it was handed, and whether it takes it now.
const bridge = (takes = true) => {
  const asked = [];
  return { asked, ask: async (method, route, body) => {
    asked.push({ method, route, body });
    if (!takes) throw new Error("It isn't running.");
    return { ok: true };
  } };
};

test("a group chat's mail that came goes to the bridge; one that mustn't be lost is said to have come once the bridge has it, or to come again later", async () => {
  fresh();
  const said = [];
  const send = (to, message) => said.push({ to: to.key, message });
  const now = bridge();
  await link.takeSeat(second.peer, { seat: { kind: "turn", turn: { id: "trn_1" } } }, send, now.ask);
  assert.deepEqual(now.asked, [{ method: "POST", route: "/mail", body: { from: second.pub, mail: { kind: "turn", turn: { id: "trn_1" } } } }]);
  assert.deepEqual(said, [], "one that goes now isn't said to have come");

  await link.takeSeat(second.peer, { seat: { kind: "work", work: { task: "gt_1" } }, seatID: "sm_work0001" }, send, now.ask);
  assert.deepEqual(said, [{ to: second.pub, message: { delivered: { id: "sm_work0001", ok: true } } }]);
  // The bridge not running now: it comes again, from the box that sent it.
  const down = bridge(false);
  await link.takeSeat(second.peer, { seat: { kind: "work", work: { task: "gt_2" } }, seatID: "sm_work0002" }, send, down.ask);
  assert.deepEqual(said.at(-1), { to: second.pub, message: { delivered: { id: "sm_work0002", ok: false, why: "Not now.", retry: true } } });
});

test("a big one (the whole chat, for a seat new to it) goes in parts, and is put together where it goes, in any order, once", async () => {
  fresh();
  // Words of any script: each part fits in a mail as the relay takes it, in bytes.
  const mail = { kind: "turn", turn: { id: "trn_big", text: "é".repeat(100_000) + "漢字".repeat(30_000) + "\"quoted\"".repeat(5_000) } };
  const payloads = link.seatPayloads(mail, "sm_bigone001");
  assert.ok(payloads.length >= 4, `${payloads.length} parts`);
  assert.ok(payloads.every(payload => payload.seatPart && link.mailFor(second.peer, { ...payload, at: Date.now() }, link.readLink())), "each fits in a mail");
  const said = [];
  const taken = bridge();
  for (const payload of [...payloads].reverse()) await link.takeSeat(second.peer, payload, (to, message) => said.push(message), taken.ask);
  assert.equal(taken.asked.length, 1);
  assert.deepEqual(taken.asked[0].body.mail, mail);
  assert.deepEqual(said, [{ delivered: { id: "sm_bigone001", ok: true } }]);
  // Parts another box sent don't make up this one's.
  const mixed = bridge();
  await link.takeSeat(mac.peer, payloads[0], () => {}, mixed.ask);
  for (const payload of payloads.slice(1)) await link.takeSeat(second.peer, payload, () => {}, mixed.ask);
  assert.equal(mixed.asked.length, 0);
  // A small one goes whole.
  assert.deepEqual(link.seatPayloads({ kind: "stop", id: "trn_1" }), [{ seat: { kind: "stop", id: "trn_1" } }]);
});

test("one too big to be put together where it goes isn't sent at all: given up, the bridge told, and the log says so", async () => {
  fresh();
  const sending = path.join(run, "outbox", "sending");
  fs.mkdirSync(sending, { recursive: true });
  const now = Date.now();
  const huge = { kind: "memory", memory: { chat: "grp_1", bot: "bot_far", transcript: "x".repeat(1_000_000) } };
  assert.equal(link.seatPayloads(huge, "sm_huge0001"), null);
  fs.writeFileSync(path.join(sending, "sm_huge0001.json"), JSON.stringify({ peer: second.pub, seat: huge, at: now }));
  const sent = [];
  const logged = [];
  const error = console.error;
  const told = bridge();
  console.error = (...words) => logged.push(words.join(" "));
  try {
    await link.sendOutbox({ send: bytes => sent.push(bytes) }, link.readLink(), now, 0, told.ask);
  } finally {
    console.error = error;
  }
  assert.equal(sent.length, 0);
  assert.deepEqual(told.asked.map(each => [each.route, each.body.mail.kind]), [["/gaveup", "memory"]]);
  assert.equal(fs.existsSync(path.join(sending, "sm_huge0001.json")), false, "not tried again each minute for two days");
  assert.equal(logged.length, 1);
  assert.match(logged[0], /memory for second is too big to send/);
});

test("what the bridge sends that mustn't be lost goes at once, then each minute; what a bot remembers of a chat, only the newest", () => {
  fresh();
  const sending = path.join(run, "outbox", "sending");
  const now = Date.now();
  const sent = [];
  const host = { send: bytes => sent.push(bytes) };
  const memory = (id, recap, chat = "grp_1") => ({ id, to: second.pub, durable: true, mail: { kind: "memory", memory: { chat, bot: "bot_far", recap } } });
  assert.equal(link.carrySeat(host, memory("sm_memory001", "first"), link.readLink(), now), true);
  assert.equal(sent.length, 1, "sent as it's left, not at the next round");
  assert.deepEqual(opened(sent[0], second).payload.seat.memory.recap, "first");
  link.sendOutbox(host, link.readLink(), now + 3000);
  assert.equal(sent.length, 1, "not again within the minute");
  // A newer one for the same bot and chat goes for it; another chat's stays.
  link.carrySeat(host, memory("sm_memory002", "second"), link.readLink(), now + 4000);
  link.carrySeat(host, memory("sm_memory003", "elsewhere", "grp_2"), link.readLink(), now + 5000);
  assert.deepEqual(fs.readdirSync(sending).sort(), ["sm_memory002.json", "sm_memory003.json"]);
  // What goes now isn't kept.
  link.carrySeat(host, { id: "sm_stop00001", to: second.pub, durable: false, mail: { kind: "stop", id: "trn_1" } }, link.readLink(), now + 6000);
  assert.deepEqual(fs.readdirSync(sending).sort(), ["sm_memory002.json", "sm_memory003.json"]);
  assert.equal(opened(sent.at(-1), second).payload.seat.kind, "stop");
});

test("who can be in a chat here from your other computers: each peer, taking a chat's turns only when it says so (groups.seats), and the bots it told of, by id, with how they look", () => {
  fresh();
  const look = { color: "sky", shape: "gem", face: "happy" };
  link.takeAgents(second.peer, { at: 2, features: ["groups", "groups.seats"], list: [
    { session: "ses_far", name: "Far", kind: "bot", id: "bot_far", about: "Watches CI", look: { ...look, extra: "dropped" } },
    { session: "ses_s", name: "A session", kind: "session", id: "bot_not", look },
  ] });
  link.takeAgents(mac.peer, { at: 2, list: [{ session: "ses_m", name: "Mac bot", kind: "bot", id: "bot_mac", look: { color: "sky" } }] });
  const peers = link.seatPeers(link.readLink());
  // This box too, as its plan limits' rows name it (PROTOCOL.md, "Plan limits").
  assert.deepEqual(peers.self, { key: here.pub, name: "devbox" });
  assert.deepEqual(peers.boxes, [{ key: mac.pub, name: "mac", seats: false }, { key: second.pub, name: "second", seats: true }]);
  assert.deepEqual(peers.bots, [
    { id: "bot_mac", name: "Mac bot", job: "", box: mac.pub, session: "ses_m", look: { color: "sky", shape: "round", face: "calm" } },
    { id: "bot_far", name: "Far", job: "Watches CI", box: second.pub, session: "ses_far", look },
  ]);
  assert.ok(link.FEATURES.includes("groups.seats"), "this box takes them");
});

test("a bot that a newer computer says looks a way the apps don't draw yet is told of plain in what they don't know, so a phone can always show it", () => {
  fresh();
  link.takeAgents(second.peer, { at: 3, features: ["groups.seats"], list: [
    { session: "ses_new", name: "New", kind: "bot", id: "bot_new", look: { color: "ultraviolet", shape: "gem", face: "smirk" } },
    { session: "ses_odd", name: "Odd", kind: "bot", id: "bot_odd", look: { color: 7 } },
  ] });
  const looks = Object.fromEntries(link.seatPeers(link.readLink()).bots.map(bot => [bot.id, bot.look]));
  assert.deepEqual(looks.bot_new, { color: "graphite", shape: "gem", face: "calm" });
  assert.deepEqual(looks.bot_odd, { color: "graphite", shape: "round", face: "calm" });
});

test("what mustn't be lost goes to its computer only, each minute until it says it has it, and never through the Mac", () => {
  fresh();
  const sending = path.join(run, "outbox", "sending");
  fs.mkdirSync(sending, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(sending, "sm_report001.json"), JSON.stringify({ peer: second.pub, seat: { kind: "report", task: "gt_1", wrapUp: "gm_1", chat: "grp_1", result: { ok: true, text: "Done.", steps: [] } }, at: now }));
  const sent = [];
  const host = { send: bytes => sent.push(bytes) };
  link.sendOutbox(host, link.readLink(), now);
  assert.equal(sent.length, 1);
  const { address, payload } = opened(sent[0], second);
  assert.equal(address, second.address);
  assert.deepEqual([payload.seat.kind, payload.seatID], ["report", "sm_report001"]);
  link.sendOutbox(host, link.readLink(), now + 3000);
  assert.equal(sent.length, 1, "not again within the minute");
  link.sendOutbox(host, link.readLink(), now + 64_000);
  assert.equal(sent.length, 2, "again after a minute");
  // No relay for a long while: it waits for it, rather than going to the Mac over SSH.
  link.sendOutbox(host, link.readLink(), now + 130_000, 10 * 60_000);
  assert.ok(fs.existsSync(path.join(sending, "sm_report001.json")));
  assert.equal(fs.readdirSync(path.join(run, "outbox")).filter(name => name.endsWith(".json")).length, 0);
  // Only the computer it went to says it has it.
  link.letterWent(mac.peer, { id: "sm_report001", ok: true });
  assert.ok(fs.existsSync(path.join(sending, "sm_report001.json")));
  link.letterWent(second.peer, { id: "sm_report001", ok: true });
  assert.equal(fs.existsSync(path.join(sending, "sm_report001.json")), false);
});

const minute = 60_000, day = 86_400_000;
const work = task => ({ kind: "work", work: { task, wrapUp: "gm_1", chat: "grp_1", bot: "bot_far", text: "Fix the build.", started: "2026-10-20T10:00:00Z" } });
// The link's rounds of the outbox, every five minutes from `from` to `to` (online, or `offline` that long).
async function rounds(host, from, to, { offline = 0, ask = bridge().ask } = {}) {
  for (let at = from; at <= to; at += 5 * minute) await link.sendOutbox(host, link.readLink(), at, offline, ask);
}

test("one that's had no word from its computer for two days online is given up: the bridge is told, and it goes once the bridge has heard", async () => {
  fresh();
  const sending = path.join(run, "outbox", "sending");
  const made = Date.now();
  const sent = [];
  const host = { send: bytes => sent.push(bytes) };
  link.carrySeat(host, { id: "sm_work00001", to: second.pub, durable: true, mail: work("gt_1") }, link.readLink(), made);
  await rounds(host, made, made + 2 * day);
  assert.ok(fs.existsSync(path.join(sending, "sm_work00001.json")), "still sent each minute");
  const tries = sent.length;
  // The bridge not running now: kept, and not sent on.
  const down = bridge(false);
  await rounds(host, made + 2 * day + 5 * minute, made + 2 * day + 10 * minute, { ask: down.ask });
  assert.deepEqual(down.asked[0], { method: "POST", route: "/gaveup", body: { to: second.pub, mail: work("gt_1"), at: made } });
  assert.ok(fs.existsSync(path.join(sending, "sm_work00001.json")));
  assert.equal(sent.length, tries);
  // Then it is: told, and the letter goes.
  const up = bridge();
  await link.sendOutbox(host, link.readLink(), made + 2 * day + 11 * minute, 0, up.ask);
  assert.deepEqual(up.asked, [{ method: "POST", route: "/gaveup", body: { to: second.pub, mail: work("gt_1"), at: made } }]);
  assert.equal(fs.existsSync(path.join(sending, "sm_work00001.json")), false);
  assert.equal(sent.length, tries, "never sent once given up");
});

test("its two days count only while this computer is online: asleep over a weekend, or without the relay, it isn't given up", async () => {
  fresh();
  const sending = path.join(run, "outbox", "sending");
  const made = Date.now();
  const sent = [];
  const host = { send: bytes => sent.push(bytes) };
  const told = bridge();
  link.carrySeat(host, { id: "sm_work00002", to: second.pub, durable: true, mail: work("gt_2") }, link.readLink(), made);
  await link.sendOutbox(host, link.readLink(), made + 3000, 0, told.ask);
  // The laptop sleeps three days (no round runs), wakes, and is without the relay three more.
  await rounds(host, made + 3 * day, made + 6 * day, { offline: 10 * minute, ask: told.ask });
  // Online again: a day and 23 hours of it, and it's still sent.
  await rounds(host, made + 6 * day, made + 6 * day + 47 * 60 * minute, { ask: told.ask });
  assert.deepEqual(told.asked, []);
  assert.ok(fs.existsSync(path.join(sending, "sm_work00002.json")));
  const before = sent.length;
  await link.sendOutbox(host, link.readLink(), made + 6 * day + 47 * 60 * minute + 64_000, 0, told.ask);
  assert.equal(sent.length, before + 1, "still sent each minute");
  // Past two days online: given up, and the bridge told.
  await rounds(host, made + 6 * day + 47 * 60 * minute + 5 * minute, made + 6 * day + 49 * 60 * minute, { ask: told.ask });
  assert.deepEqual(told.asked.map(each => [each.route, each.body.mail.work.task]), [["/gaveup", "gt_2"]]);
  assert.equal(fs.existsSync(path.join(sending, "sm_work00002.json")), false);
});

test("a bridge that turns down hearing it was given up (an older one, or group chats off here) has heard: the letter goes, not told again every few seconds", async () => {
  fresh();
  const sending = path.join(run, "outbox", "sending");
  fs.mkdirSync(sending, { recursive: true });
  const huge = { kind: "memory", memory: { chat: "grp_1", bot: "bot_far", transcript: "x".repeat(1_000_000) } };
  fs.writeFileSync(path.join(sending, "sm_huge0002.json"), JSON.stringify({ peer: second.pub, seat: huge, at: Date.now() }));
  const asked = [];
  const ask = async (method, route) => {
    asked.push(route);
    throw Object.assign(new Error("The coding agents' bridge answered 404."), { status: 404 });
  };
  const error = console.error;
  console.error = () => {};
  try {
    await link.sendOutbox({ send() {} }, link.readLink(), Date.now(), 0, ask);
    await link.sendOutbox({ send() {} }, link.readLink(), Date.now() + 3000, 0, ask);
  } finally {
    console.error = error;
  }
  assert.deepEqual(asked, ["/gaveup"]);
  assert.equal(fs.existsSync(path.join(sending, "sm_huge0002.json")), false);
});

test("what the bridge sends as it goes (its group chats' mail, followed) keeps coming past the time the bridge has to answer", async () => {
  fresh();
  let following;
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.write('{"n":1}\n');
    following = response;
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(run, "bridge.json"), JSON.stringify({ port: server.address().port, password: "bridge-pw" }));
  const deadline = new AbortController();
  const answerIn = link.bridgeClock.answerIn;
  link.bridgeClock.answerIn = () => deadline.signal;
  try {
    const answer = await link.bridgeAsk("GET", "/mail");
    const reader = answer.body.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value, { stream: true });
    // The time it had to answer is up, and it sends more.
    deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));
    following.end('{"n":2}\n');
    for (let part = await reader.read(); !part.done; part = await reader.read()) text += decoder.decode(part.value, { stream: true });
    assert.equal(text, '{"n":1}\n{"n":2}\n');
  } finally {
    link.bridgeClock.answerIn = answerIn;
    server.close();
  }
});

test("a bridge that answered and then says nothing for a minute is followed anew: what it sends then still goes, and it's told again who your computers are", async () => {
  fresh();
  const waiting = [];
  const poke = () => { for (const resolve of waiting.splice(0)) resolve(); };
  const until = async check => { while (!check()) await new Promise(resolve => waiting.push(resolve)); };
  const follows = [], told = [], sent = [];
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (request.method === "GET" && request.url === "/api/kuvo/peers/mail") {
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.flushHeaders();
        follows.push(response);
        // The first time it answers and then says nothing; the second, it sends.
        if (follows.length === 2) response.write(JSON.stringify({ id: "sm_stop0001", to: second.pub, mail: { kind: "stop", id: "trn_1" }, durable: false }) + "\n");
      } else {
        if (request.method === "PUT") told.push(request.url);
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      }
      poke();
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(run, "bridge.json"), JSON.stringify({ port: server.address().port, password: "bridge-pw" }));
  const timers = [];
  const after = link.bridgeClock.after;
  link.bridgeClock.after = (ms, work) => {
    const timer = { ms, work, live: true };
    timers.push(timer);
    poke();
    return () => { timer.live = false; };
  };
  const stop = new AbortController();
  try {
    link.watchSeats(() => ({ send: bytes => { sent.push(bytes); poke(); } }), stop.signal);
    await until(() => follows.length === 1 && told.length === 1);
    const quiet = timers.findLast(timer => timer.live);
    assert.ok(quiet, "it keeps an eye on how long the bridge has said nothing");
    assert.equal(quiet.ms, 60_000);
    // A minute without a word.
    quiet.work();
    await until(() => follows.length === 2 && sent.length === 1 && told.length === 2);
  } finally {
    stop.abort();
    link.bridgeClock.after = after;
    server.closeAllConnections();
    server.close();
  }
});

test("plan limits (PROTOCOL.md, \"Plan limits\"): what the bridge tells a computer goes to it now as mail of its own, kept nowhere; what a computer tells comes to the bridge here", async () => {
  fresh();
  const sent = [];
  const host = { send: bytes => sent.push(bytes) };
  const accounts = [{ provider: "claude-code", service: "claude", identity: "0123456789abcdef", windows: [{ id: "five_hour", used: 0.4, read: 5, source: "usage" }], checked: 5 }];
  assert.equal(link.carrySeat(host, { id: "sm_limits001", to: second.pub, durable: false, mail: { kind: "limits", at: 5, accounts, ask: true } }, link.readLink()), true);
  assert.equal(sent.length, 1);
  const payload = opened(sent[0], second).payload;
  assert.deepEqual(payload.limits, { at: 5, accounts, ask: true });
  assert.equal(payload.seat, undefined, "not as a group chat's");
  assert.equal(payload.seatID, undefined);
  const sending = path.join(run, "outbox", "sending");
  assert.deepEqual(fs.existsSync(sending) ? fs.readdirSync(sending) : [], [], "nothing kept to send again");

  // What another computer tells, opened as any mail of theirs, goes to the bridge here.
  let heard;
  const posted = new Promise(resolve => { heard = resolve; });
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      heard({ method: request.method, url: request.url, body: JSON.parse(body) });
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(run, "bridge.json"), JSON.stringify({ port: server.address().port, password: "bridge-pw" }));
  try {
    const mail = link.mailFor(here.peer, { limits: { at: 6, accounts }, at: Date.now() }, { key: k(second.key) });
    link.receiveMail(link.readFrame(mail.subarray(17)).body, host, (sender, given) => link.peerMail(sender, given, host));
    assert.deepEqual(await posted, { method: "POST", url: "/api/kuvo/peers/mail", body: { from: second.pub, mail: { at: 6, accounts, kind: "limits" } } });
  } finally {
    server.close();
  }
});

test("plan limits with a box only a peer knows (another Mac's, beside a machine two Macs share): its limits go to it and come from it, and nothing else does", async () => {
  fresh();
  const air = box("mac", "air");
  // The second machine says which boxes it knows: this one, and the Air, which isn't this box's peer.
  link.takeAgents(second.peer, { at: Date.now(), list: [], boxes: [here.peer, air.peer, { key: "not a key", address: "x", kind: "mac" }] });
  const peers = link.seatPeers(link.readLink());
  assert.deepEqual(peers.also, [{ key: air.pub, name: "air" }]);
  assert.ok(!peers.boxes.some(each => each.key === air.pub), "not in its group chats");

  // What the bridge tells it goes there; nothing else of the bridge's does.
  const sent = [];
  const host = { send: bytes => sent.push(bytes) };
  link.carrySeat(host, { id: "sm_limits002", to: air.pub, durable: false, mail: { kind: "limits", at: 7, accounts: [] } }, link.readLink());
  assert.equal(sent.length, 1);
  assert.deepEqual(opened(sent[0], air).payload.limits, { at: 7, accounts: [] });
  link.carrySeat(host, { id: "sm_turn0002", to: air.pub, durable: false, mail: { kind: "turn", turn: { id: "trn_9" } } }, link.readLink());
  assert.equal(sent.length, 1, "a group chat's mail isn't sent to it");

  // What it sends: its limits reach the bridge; its agents and letters are dropped.
  const posted = [];
  let heard;
  const got = new Promise(resolve => { heard = resolve; });
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      posted.push(JSON.parse(body));
      heard();
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(run, "bridge.json"), JSON.stringify({ port: server.address().port, password: "bridge-pw" }));
  try {
    const mail = link.mailFor(here.peer, { limits: { at: 8, accounts: [] }, agents: { at: Date.now(), list: [{ session: "ses_air1", name: "Air's", kind: "session" }] }, letter: { id: "ltr_x" }, at: Date.now() }, { key: k(air.key) });
    link.receiveMail(link.readFrame(mail.subarray(17)).body, host, (sender, given) => link.peerMail(sender, given, host));
    await got;
    assert.deepEqual(posted, [{ from: air.pub, mail: { at: 8, accounts: [], kind: "limits" } }]);
    assert.equal(link.readPeerAgents()[air.pub], undefined, "its agents aren't taken");
  } finally {
    server.close();
  }
});

test("usage history (PROTOCOL.md, \"Usage history\") goes to a box only a peer knows, in parts when it's big; from it, its usage reaches the bridge and its group chats' mail doesn't", async () => {
  fresh();
  const air = box("mac", "air");
  link.takeAgents(second.peer, { at: Date.now(), list: [], boxes: [here.peer, air.peer] });
  const sent = [];
  const host = { send: bytes => sent.push(bytes) };
  // A month of hours is bigger than a mail: it goes in parts, kept nowhere.
  const used = Array.from({ length: 4000 }, (_, i) => [490000 + i, 0, 123456, 1.234567]);
  const mail = { kind: "usage", at: 7, accounts: [{ provider: "claude-code", service: "claude", identity: "0123456789abcdef", hours: { models: ["claude-opus-5"], used } }] };
  assert.equal(link.carrySeat(host, { id: "sm_usage0001", to: air.pub, durable: false, mail }, link.readLink()), true);
  assert.ok(sent.length > 1, "in parts");
  const parts = sent.map(bytes => opened(bytes, air).payload.seatPart);
  assert.ok(parts.every(Boolean));
  const sending = path.join(run, "outbox", "sending");
  assert.deepEqual(fs.existsSync(sending) ? fs.readdirSync(sending) : [], [], "nothing kept to send again");

  const posted = [];
  let heard;
  const got = new Promise(resolve => { heard = resolve; });
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      posted.push(JSON.parse(body));
      heard();
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(run, "bridge.json"), JSON.stringify({ port: server.address().port, password: "bridge-pw" }));
  try {
    // A group chat's turn from it first: dropped.
    const turn = link.mailFor(here.peer, { seat: { kind: "turn", turn: { id: "trn_air" } }, at: Date.now() }, { key: k(air.key) });
    link.receiveMail(link.readFrame(turn.subarray(17)).body, host, (sender, given) => link.peerMail(sender, given, host));
    // Its usage, in parts: put together, and to the bridge.
    for (const part of parts) {
      const bytes = link.mailFor(here.peer, { seatPart: part, at: Date.now() }, { key: k(air.key) });
      link.receiveMail(link.readFrame(bytes.subarray(17)).body, host, (sender, given) => link.peerMail(sender, given, host));
    }
    await got;
    assert.deepEqual(posted, [{ from: air.pub, mail }]);
  } finally {
    server.close();
  }
});

test("a box only a peer knew is forgotten once no peer names it: nothing goes to it, and its mail isn't opened", () => {
  fresh();
  const air = box("mac", "air");
  const at = Date.now();
  link.takeAgents(second.peer, { at, list: [], boxes: [air.peer] });
  assert.deepEqual(link.seatPeers(link.readLink()).also, [{ key: air.pub, name: "air" }]);
  // The second machine no longer names it (the Air's Mac let it go).
  link.takeAgents(second.peer, { at: at + 1, list: [], boxes: [] });
  assert.deepEqual(link.seatPeers(link.readLink()).also, []);
  const sent = [];
  link.carrySeat({ send: bytes => sent.push(bytes) }, { id: "sm_limits003", to: air.pub, durable: false, mail: { kind: "limits", at: 9, accounts: [] } }, link.readLink());
  assert.equal(sent.length, 0);
  const mail = link.mailFor(here.peer, { limits: { at: 9, accounts: [] }, at: Date.now() }, { key: k(air.key) });
  assert.equal(link.openMail(link.readFrame(mail.subarray(17)).body, link.readLink(), () => link.vouchedOf(link.readLink())), null);
  // (While it was named, it was opened.)
  link.takeAgents(second.peer, { at: at + 2, list: [], boxes: [air.peer] });
  assert.equal(link.openMail(link.readFrame(mail.subarray(17)).body, link.readLink(), () => link.vouchedOf(link.readLink()))?.vouched, true);
});

test("the usage panel's settings (PROTOCOL.md, \"Usage settings\") go between your own computers only: to a peer as a seat's mail, never to a box only a peer knows, and from it never to the bridge", async () => {
  fresh();
  const air = box("mac", "air");
  link.takeAgents(second.peer, { at: Date.now(), list: [], boxes: [here.peer, air.peer] });
  const sent = [];
  const host = { send: bytes => sent.push(bytes) };
  // The bridge is told the setup this box follows, which settings stay within: `null` once it's
  // settled on none (a setup set aside, a machine Macs share), not said while it can't say yet.
  assert.equal("setup" in link.seatPeers(link.readLink()), false, "no record yet (a box from before setups, updating): not said");
  const withSetup = { ...link.readLink(), setup: { id: "set_AAAAAAAAAAAAAAAAAAAAAA", epoch: 1, primary: mac.pub, sign: mac.pub, role: "member" } };
  assert.equal(link.seatPeers(withSetup).setup, "set_AAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(link.seatPeers({ ...withSetup, setup: { ...withSetup.setup, aside: true } }).setup, null, "set aside: none");
  // A main computer whose keys aren't its record's (not read yet as its link starts): not said.
  assert.equal("setup" in link.seatPeers({ ...withSetup, setup: { ...withSetup.setup, role: "primary", primary: second.pub } }), false);
  // A machine two Macs set up: none, settled.
  assert.equal(link.seatPeers({ ...link.readLink(), macs: [mac.pub, air.pub] }).setup, null, "a machine Macs share: none");
  const mail = { kind: "settings", at: 7, digest: "d", setup: "set_AAAAAAAAAAAAAAAAAAAAAA", usage: { notifications: { value: { underTenPercent: true, healthyToClose: false, closeToRunningOut: false }, stamp: { v: 7, by: here.pub } } } };
  // To one of your computers: as a seat's, kept nowhere.
  assert.equal(link.carrySeat(host, { id: "sm_settings01", to: second.pub, durable: false, mail }, link.readLink()), true);
  assert.equal(sent.length, 1);
  assert.deepEqual(opened(sent[0], second).payload.seat, mail);
  // To a box only a peer knows (another person's Mac): nothing goes.
  link.carrySeat(host, { id: "sm_settings02", to: air.pub, durable: false, mail }, link.readLink());
  assert.equal(sent.length, 1, "nothing to a box a peer vouches for");

  const posted = [];
  let heard;
  const got = new Promise(resolve => { heard = resolve; });
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      posted.push(JSON.parse(body));
      heard();
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(run, "bridge.json"), JSON.stringify({ port: server.address().port, password: "bridge-pw" }));
  try {
    // The Air's settings first: dropped. Then the second machine's: to the bridge.
    const fromAir = link.mailFor(here.peer, { seat: { ...mail, digest: "air" }, at: Date.now() }, { key: k(air.key) });
    link.receiveMail(link.readFrame(fromAir.subarray(17)).body, host, (sender, given) => link.peerMail(sender, given, host));
    const fromSecond = link.mailFor(here.peer, { seat: { ...mail, digest: "second" }, at: Date.now() }, { key: k(second.key) });
    link.receiveMail(link.readFrame(fromSecond.subarray(17)).body, host, (sender, given) => link.peerMail(sender, given, host));
    await got;
    assert.deepEqual(posted, [{ from: second.pub, mail: { ...mail, digest: "second" } }]);
  } finally {
    server.close();
  }
});

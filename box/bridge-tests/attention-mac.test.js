// This Mac's notices for your phones, held by its box while you're at the Mac (PROTOCOL.md,
// "kuvo/attention"), as a machine's bridge holds its own: its app says you're here as "mac", with
// the conversations on its screen and the notifications it showed; this Mac's own news waits a
// little, and never goes if you answer it or see it meanwhile; once you're not (the Mac asleep or
// locked, the app gone quiet), what waits goes at once, and with no one here, at once. Its news
// comes from the engine's events, in the Mac's words, sealed for each phone. The engine and the
// relay connection are stand-ins, and the clock is the test's own.
//
// Run with `node --test box/bridge-tests/attention-mac.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { removeAtEnd } from "./at-end.js";

const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-attention-mac-")));
removeAtEnd(support);
Object.assign(process.env, {
  KUVO_HOME: path.join(support, "box"),
  KUVO_BOTS: path.join(support, "bots"),
  KUVO_WAKES: path.join(support, "wakes"),
  KUVO_BOX: "mac",
  KUVO_ENGINE_CONFIG: path.join(support, "opencode"),
  KUVO_KEYS: path.join(support, "keys"),
});
const link = await import("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js");

// The date as far as the tests go.
const TODAY = 1_800_000_000_000;

// A clock that moves only when the test moves it, and the timers it runs.
function clock() {
  let now = 1_800_000_000_000;
  let timers = [];
  let next = 1;
  return {
    now: () => now,
    // The date, for what a box before kept: fixed.
    wall: () => TODAY,
    setTimer: (fire, ms) => {
      const id = next++;
      timers.push({ id, at: now + ms, fire });
      return id;
    },
    clearTimer: id => { timers = timers.filter(timer => timer.id !== id); },
    // Moves on by `ms`, running each timer as its time comes.
    pass(ms) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter(timer => timer !== due);
        now = due.at;
        due.fire();
      }
      now = end;
    },
  };
}

// An engine whose events a test sends to whoever follows them; its sessions in a folder of a
// project called "shop", and the permissions each asks now (`asking`).
async function engineWith(sessions, asking = {}) {
  const followers = [];
  let followed;
  const following = new Promise(resolve => { followed = resolve; });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": hello\n\n");
      followers.push(response);
      followed();
      return;
    }
    // What each session asks now: none named, none asked (as the engine answers for "global",
    // asked without the folder of an MCP server's form).
    const asked = url.pathname.match(/^\/api\/session\/([^/]+)\/(permission|form)$/);
    if (asked) {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ data: (asking[decodeURIComponent(asked[1])] ?? []).map(id => ({ id })) }));
    }
    const session = sessions[decodeURIComponent(url.pathname.split("/").pop())];
    response.writeHead(session ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: session ?? null }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    read: () => ({ port: server.address().port, password: "pw" }),
    following,
    send: event => { for (const follower of followers) follower.write(`data: ${JSON.stringify(event)}\n\n`); },
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

// This Mac's keys, and a phone paired with it that's said where it is.
const macKey = link.newKey();
const phoneKey = link.newKey();
const phoneAddress = crypto.randomBytes(16);
fs.mkdirSync(path.join(support, "box", "run"), { recursive: true });
fs.writeFileSync(path.join(support, "box", "run", "link.json"), JSON.stringify({
  phones: [{ key: link.publicOf(phoneKey).toString("base64url"), name: "iPhone", added: 1_800_000_000, address: phoneAddress.toString("base64url") }],
}));
link.macLink.overlay = { key: macKey.toString("base64url") };

let running = null;
afterEach(() => {
  running?.stop.abort();
  running?.engine.close();
  running = null;
  link.macLink.hold = null;
  link.macLink.host = null;
  link.macLink.config = null;
  fs.rmSync(path.join(support, "box", "run", "held-notices.json"), { force: true });
});

// This Mac's box as `serve` runs it: its notices held, its engine's news made into notices, its
// app's requests answered; what reached the phone, opened as the phone opens it.
// `before(hold)`: what it held before its engine's events are heard (they weren't, for a while);
// `asking`: the engine's permissions asked now.
async function macBox({ config = { phones: true, machines: false }, before = () => {}, asking = {} } = {}) {
  const time = clock();
  const phone = [];
  link.macLink.config = config;
  link.macLink.host = {
    welcomed: true,
    send: bytes => {
      const relayed = link.readFrame(bytes.subarray(17));
      phone.push(JSON.parse(link.openOneWay(relayed.body, phoneKey, link.publicOf(macKey)).payload.toString()));
      return true;
    },
  };
  const hold = link.macNoticeHold(time);
  link.macLink.hold = hold;
  const handle = link.engineHandler(link.readEngineFile, { name: "Mac" }, link.readBridgeFile, () => {}, hold);
  before(hold);
  const engine = await engineWith({ ses_a: { id: "ses_a", title: "Fix the tests", location: { directory: "/Users/me/shop" } } }, asking);
  const stop = new AbortController();
  running = { stop, engine };
  // Each notice and answer the engine's events made, as they're made.
  const made = [];
  const waiting = [];
  const settle = () => { for (const wait of waiting.splice(0)) wait(); };
  link.watchEvents(engine.read, notice => { const taken = link.macTell(notice); made.push(notice); settle(); return taken; }, stop.signal,
    id => { hold.resolve(id); made.push({ answered: id }); settle(); }, { bots: true, notices: true, signIns: true, hold });
  await engine.following;
  const next = async count => { while (made.length < count) await new Promise(resolve => waiting.push(resolve)); };
  // The app, saying you're here (`sessions` on its screen, `shown` in its notifications) or not.
  const app = async body => {
    const parts = [];
    for await (const part of handle({ method: "POST", path: "kuvo/attention", headers: {}, body: Buffer.from(JSON.stringify(body)), fromApp: true }, {}, undefined)) parts.push(part);
    assert.equal(parts[0].head.status, 200);
  };
  return {
    time, phone, hold, app, engine,
    async finished() {
      engine.send({ type: "session.execution.succeeded", data: { sessionID: "ses_a" } });
      await next(made.length + 1);
    },
    async asked(id) {
      engine.send({ type: "permission.asked", data: { id, sessionID: "ses_a", action: "shell", resources: ["npm test"] } });
      await next(made.length + 1);
    },
    async replied(id) {
      engine.send({ type: "permission.replied", data: { sessionID: "ses_a", requestID: id } });
      await next(made.length + 1);
    },
  };
}

const here = (extra = {}) => ({ for: 45, sessions: [], ...extra });

test("at the Mac, a run finished waits its hold, then reaches your phone in the Mac's words", async () => {
  const mac = await macBox();
  await mac.app(here());
  await mac.finished();
  assert.deepEqual(mac.phone, []);
  // Still here: renewed as the app does, until the hold ends.
  for (let i = 0; i < 3; i++) {
    mac.time.pass(15_000);
    await mac.app(here());
  }
  mac.time.pass(link.NEWS_HOLD - 45_000 - 1);
  assert.deepEqual(mac.phone, []);
  mac.time.pass(1);
  assert.equal(mac.phone.length, 1);
  assert.equal(mac.phone[0].category, "finished");
  assert.equal(mac.phone[0].title, "Fix the tests");
  assert.equal(mac.phone[0].subtitle, "shop");
  assert.equal(mac.phone[0].data.session, "ses_a");
});

test("a permission answered during its hold never reaches your phone", async () => {
  const mac = await macBox();
  await mac.app(here());
  await mac.asked("per_1");
  assert.equal(mac.hold.count, 1);
  mac.time.pass(5_000);
  // Answered (at the Mac, from its notification, or a phone): the engine says so.
  await mac.replied("per_1");
  assert.equal(mac.hold.count, 0);
  mac.time.pass(120_000);
  assert.deepEqual(mac.phone, []);
});

test("its conversation on the Mac's screen counts as seen", async () => {
  const mac = await macBox();
  await mac.app(here());
  await mac.finished();
  mac.time.pass(15_000);
  await mac.app(here({ sessions: ["ses_a"] }));
  mac.time.pass(link.NEWS_HOLD);
  await mac.app(here({ sessions: ["ses_a"] }));
  await mac.app({ for: 0 });
  assert.deepEqual(mac.phone, []);
});

test("a permission seen but left unanswered goes as you leave the Mac", async () => {
  const mac = await macBox();
  await mac.app(here({ sessions: ["ses_a"] }));
  await mac.asked("per_1");
  mac.time.pass(15_000);
  await mac.app(here({ sessions: ["ses_a"] }));
  mac.time.pass(link.ASK_HOLD);
  assert.deepEqual(mac.phone, []);
  // The screen locks.
  await mac.app({ for: 0 });
  assert.deepEqual(mac.phone.map(notice => notice.category), ["permission"]);
});

test("a run finished the Mac showed in a notification never reaches your phone", async () => {
  const mac = await macBox();
  await mac.app(here());
  await mac.finished();
  // As the app tells what it showed (`Notifier.shown`): its conversation, news.
  await mac.app(here({ shown: [{ session: "ses_a", ask: false }] }));
  mac.time.pass(link.NEWS_HOLD);
  await mac.app({ for: 0 });
  assert.deepEqual(mac.phone, []);
});

test("a permission the Mac showed waits until it's answered, or you leave", async () => {
  const mac = await macBox();
  await mac.app(here());
  await mac.asked("per_1");
  await mac.app(here({ shown: [{ session: "ses_a", ask: true, request: "per_1" }] }));
  mac.time.pass(link.ASK_HOLD);
  assert.deepEqual(mac.phone, []);
  await mac.app({ for: 0 });
  assert.deepEqual(mac.phone.map(notice => notice.data.request), ["per_1"]);

  await mac.app(here());
  await mac.asked("per_2");
  await mac.app(here({ shown: [{ session: "ses_a", ask: true, request: "per_2" }] }));
  mac.time.pass(link.ASK_HOLD);
  await mac.replied("per_2");
  await mac.app({ for: 0 });
  assert.equal(mac.phone.length, 1);
});

test("one notification stands for one notice: of two runs finished, the one not shown still goes", async () => {
  const mac = await macBox();
  await mac.app(here());
  await mac.finished();
  await mac.finished();
  await mac.app(here({ shown: [{ session: "ses_a", ask: false }] }));
  for (let i = 0; i < 4; i++) {
    mac.time.pass(15_000);
    await mac.app(here());
  }
  assert.equal(mac.phone.length, 1);
});

test("the app gone without a word (it stopped mid-way): its lease runs out, and what's held goes at once", async () => {
  const mac = await macBox();
  await mac.app(here());
  await mac.finished();
  mac.time.pass(45_000 - 1);
  assert.deepEqual(mac.phone, []);
  mac.time.pass(1);
  assert.deepEqual(mac.phone.map(notice => notice.category), ["finished"]);
});

test("the Mac asleep or locked: what's held goes at once", async () => {
  const mac = await macBox();
  await mac.app(here());
  await mac.asked("per_1");
  assert.deepEqual(mac.phone, []);
  await mac.app({ for: 0 });
  assert.deepEqual(mac.phone.map(notice => notice.category), ["permission"]);
});

test("with no one at the Mac, its news goes at once", async () => {
  const mac = await macBox();
  await mac.finished();
  assert.deepEqual(mac.phone.map(notice => notice.category), ["finished"]);
  assert.equal(mac.hold.count, 0);
});

test("news from before the app says whether the phone link's on is held, then goes once it's on; none while it's off", async () => {
  const mac = await macBox({ config: null });
  await mac.finished();
  assert.deepEqual(mac.phone, []);
  assert.equal(mac.hold.count, 1, "held, not dropped");
  link.macLink.config = { phones: true, machines: false };
  mac.time.pass(5_000);
  assert.deepEqual(mac.phone.map(notice => notice.category), ["finished"]);

  link.macLink.config = { phones: false, machines: false };
  await mac.finished();
  mac.time.pass(link.NEWS_HOLD);
  assert.equal(mac.phone.length, 1);
  assert.equal(mac.hold.count, 0);
});

test("what was answered while the box couldn't hear its engine never reaches your phone; what's still asked goes as you leave", async () => {
  const permission = id => ({ title: "Fix the tests", subtitle: "shop", body: "Wants to run a command: npm test", category: "permission", thread: "ses_a", data: { session: "ses_a", request: id } });
  let settled;
  const looked = new Promise(resolve => { settled = resolve; });
  const mac = await macBox({
    asking: { ses_a: ["per_2"] },
    // At the Mac, two asked: then its engine's events weren't heard for a while (it restarted).
    before: hold => {
      hold.attend("mac", { seconds: 45, sessions: [], shown: [] });
      hold.tell(permission("per_1"));
      hold.tell(permission("per_2"));
      const resolve = hold.resolve.bind(hold);
      hold.resolve = id => { resolve(id); settled(); };
    },
  });
  // Heard again: per_1 was answered meanwhile.
  await looked;
  assert.deepEqual(mac.hold.held.map(entry => entry.notice.data.request), ["per_2"]);
  await mac.app({ for: 0 });
  assert.deepEqual(mac.phone.map(notice => notice.data.request), ["per_2"]);
});

test("a permission held when you stop the run never reaches your phone: the engine lets it go without a word", async () => {
  const asking = { ses_a: ["per_1"] };
  const mac = await macBox({ asking });
  await mac.app(here());
  await mac.asked("per_1");
  assert.equal(mac.hold.count, 1);
  // Stopped: the engine has it no more, and says only that the run ended. Then it's run again.
  asking.ses_a = [];
  mac.engine.send({ type: "session.execution.interrupted", data: { sessionID: "ses_a", reason: "user" } });
  await mac.finished();
  await mac.app({ for: 0 });
  assert.deepEqual(mac.phone.map(notice => notice.category), ["finished"]);
});

test("an MCP server's form held while the box couldn't hear its engine stays held: the engine can't say without its folder", async () => {
  const form = { title: "Fix the tests", subtitle: "shop", body: "Linear wants: Your workspace", category: "question", thread: "ses_a", data: { session: "ses_a", request: "frm_1", requestSession: "global" } };
  let looked;
  const settled = new Promise(resolve => { looked = resolve; });
  const mac = await macBox({
    asking: { ses_a: [] },
    before: hold => {
      hold.attend("mac", { seconds: 45, sessions: [], shown: [] });
      hold.tell(form);
      // A permission it can tell about, looked up after: settled once that's done.
      hold.tell({ ...form, category: "permission", data: { session: "ses_a", request: "per_9" } });
      const resolve = hold.resolve.bind(hold);
      hold.resolve = id => { resolve(id); if (id === "per_9") looked(); };
    },
  });
  await settled;
  assert.deepEqual(mac.hold.held.map(entry => entry.notice.data.request), ["frm_1"]);
  await mac.app({ for: 0 });
  assert.deepEqual(mac.phone.map(notice => notice.data.request), ["frm_1"]);
});

test("held as this Mac's box stopped while you were at the Mac: each keeps the rest of its hold, one you saw waits while the app says you're still here, and all go once you leave", async () => {
  const today = TODAY;
  const permission = { title: "Fix the tests", subtitle: "shop", body: "Wants to run a command: npm test", category: "permission", thread: "ses_a", data: { session: "ses_a", request: "per_1" } };
  const finished = { title: "Fix the tests", subtitle: "shop", body: "All green.", category: "finished", thread: "ses_a", data: { session: "ses_a" } };
  const kept = () => fs.writeFileSync(path.join(support, "box", "run", "held-notices.json"),
    JSON.stringify([{ notice: permission, at: today - 5_000, seen: true, attended: true }, { notice: finished, at: today - 5_000, seen: false, attended: true }]));
  kept();
  const mac = await macBox();
  // Started again: nothing goes before the app's had a moment to say you're still here.
  mac.time.pass(15_000);
  assert.deepEqual(mac.phone, []);
  await mac.app(here());
  // The news's hold ends 60 seconds after it was made; the one you saw waits on you.
  mac.time.pass(link.NEWS_HOLD - 5_000 - 15_000 - 1);
  assert.deepEqual(mac.phone, []);
  mac.time.pass(1);
  assert.deepEqual(mac.phone.map(notice => notice.category), ["finished"]);
  await mac.app({ for: 0 });
  assert.deepEqual(mac.phone.map(notice => notice.category), ["finished", "permission"]);
});

test("held as this Mac's box stopped, and the app doesn't say you're here again: all of it goes a moment later", async () => {
  const today = TODAY;
  const permission = { title: "Fix the tests", subtitle: "shop", body: "Wants to run a command: npm test", category: "permission", thread: "ses_a", data: { session: "ses_a", request: "per_1" } };
  fs.writeFileSync(path.join(support, "box", "run", "held-notices.json"), JSON.stringify([{ notice: permission, at: today - 5_000, seen: true, attended: true }]));
  const mac = await macBox();
  mac.time.pass(link.RESTORED_WAIT - 1);
  assert.deepEqual(mac.phone, []);
  mac.time.pass(1);
  assert.deepEqual(mac.phone.map(notice => notice.category), ["permission"]);
});

test("news made while the phone link is off never reaches your phone, even once it's turned on", async () => {
  const mac = await macBox({ config: { phones: false, machines: false } });
  await mac.app(here());
  await mac.finished();
  assert.equal(mac.hold.count, 0, "let go at once");
  link.macLink.config = { phones: true, machines: false };
  mac.time.pass(link.NEWS_HOLD);
  await mac.app({ for: 0 });
  assert.deepEqual(mac.phone, []);
});

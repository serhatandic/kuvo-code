// An agent's work isn't news to you (PROTOCOL.md, "What's been read", READ_RULE; task #424): a
// session a bot (or another conversation that hears when it finishes) started and leads is its
// work, so the box reads its turns as they end, on every client at once (no dot on its row, its
// project or its computer), unless what came since you last read it is news to you, as its
// notification is: a reply to you (you wrote in it, or answered what it asked you), a failure, or
// what its agent sent you on purpose. What it asks you still waits on you, and your own sessions are
// as ever. The real box code, watching an engine that's a stand-in. Run with
// `node --test Packages/KuvoLink/Tests/Bridge/work-read.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-work-read-")));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

// The engine: its sessions (each one's `time.idle` and `time.viewed`), each one's messages (newest
// first), what each asks, and every client told what was read (`session.viewed`), as the engine does.
let sessions, pages, asks, followers, viewed;
const engine = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": hello\n\n");
      followers.push(response);
      for (const resolve of following.splice(0)) resolve();
      return;
    }
    if (url.pathname === "/api/session") {
      const parent = url.searchParams.get("parentID");
      return reply({ data: Object.values(sessions).filter(each => parent === null || parent === "null" ? true : each.parentID === parent), cursor: null });
    }
    const [, id, rest] = url.pathname.match(/^\/api\/session\/([^/]+)(\/.*)?$/) ?? [];
    const session = sessions[decodeURIComponent(id ?? "")];
    if (!session) return reply({ message: "Not here." }, 404);
    if (!rest && request.method === "GET") return reply({ data: session });
    if (rest === "/message") return pages[session.id] === null ? reply({ message: "Couldn't read it." }, 500) : reply({ data: pages[session.id] ?? [], cursor: null });
    if (rest === "/permission") return reply({ data: asks[session.id] ?? [] });
    if (rest === "/form") return reply({ data: [] });
    if (rest === "/view" && request.method === "POST") {
      // (It takes which end you saw, and keeps the later; every client hears of it.)
      const { idle } = JSON.parse(body || "{}");
      if (idle === undefined) return reply({ message: "Missing key idle" }, 400);
      if (idle > (session.time.viewed ?? 0)) {
        session.time.viewed = idle;
        send({ type: "session.viewed", data: { sessionID: session.id, idle } });
      }
      reply({});
      for (const wait of viewed.splice(0)) wait();
      return;
    }
    reply({ message: "Not here." }, 404);
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
const target = { port: engine.address().port, password: "pw" };
const following = [];
const send = event => { for (const follower of followers) follower.write(`data: ${JSON.stringify(event)}\n\n`); };
// What the box told lately, where an agent's notify_user is kept.
const told = path.join(home, "run", "notices", "told.json");

beforeEach(() => {
  sessions = {};
  pages = {};
  asks = {};
  followers = [];
  viewed = [];
  fs.rmSync(told, { force: true });
});

// A session, unread: its last turn ended at 2000, and it was last read at 1000.
const BOT = { bot: "bot_1", name: "Kuvo Foreman" };
const session = (id, metadata) => {
  sessions[id] = { id, title: id, location: { directory: "/home/me/kuvo-store" }, time: { created: 1, updated: 2000, idle: 2000, viewed: 1000 }, ...(metadata ? { metadata } : {}) };
  return sessions[id];
};
const bots = id => session(id, { kuvo: { startedBy: "ses_foreman", by: BOT, depth: 1, wake: ["finished", "asks"] } });
// The same unread on every client: `Session.isUnread`, which each row and what rolls them up reads.
const isUnread = id => sessions[id].time.idle > (sessions[id].time.viewed ?? 0);

const end = (at, outcome = "succeeded") => ({ type: "idle", outcome, time: { created: at } });
const reply = text => ({ type: "assistant", content: [{ type: "text", text }] });
const user = (text, metadata) => ({ type: "user", text, ...(metadata ? { metadata } : {}) });
const letter = "[Message from Kuvo Foreman · ses_foreman] (To answer, use send_message to ses_foreman.)\n\nFix the store's checkout page.";
// The turn before, read at 1000.
const before = [end(1000), reply("Started."), user(letter)];

// The box following the engine as every box does, while `run` runs.
async function watching(run, tell = () => true) {
  const stop = new AbortController();
  const connected = new Promise(resolve => following.push(resolve));
  link.watchEvents(() => target, tell, stop.signal, undefined, { work: "engine" });
  try {
    await connected;
    await run();
  } finally {
    stop.abort();
  }
}
// Until `id` is read, as the engine is told so.
const readNow = id => new Promise(resolve => {
  const look = () => (isUnread(id) ? viewed.push(look) : resolve());
  look();
});
// (A box that never reads what it should fails the test rather than waiting for good.)
const WAITS = { timeout: 30_000 };

test("a session the bot leads, answering the bot, is read as its turn ends: nothing new on any client", WAITS, async () => {
  bots("ses_checkout");
  sessions.ses_checkout.time.viewed = 2000;
  await watching(async () => {
    // Its next turn: the bot's word to it, and its reply.
    sessions.ses_checkout.time.idle = 3000;
    pages.ses_checkout = [end(3000), reply("The checkout page is fixed."), user(letter), end(2000), reply("Started."), user(letter)];
    send({ type: "session.execution.succeeded", data: { sessionID: "ses_checkout" } });
    await readNow("ses_checkout");
    assert.equal(sessions.ses_checkout.time.viewed, 3000, "read up to the end of that turn");
  });
});

test("so are its other turns that aren't to you: its own wake-up, what it left running coming back, its sessions' news, one stopped, a summary", async () => {
  const turns = {
    ses_wake: [end(2000), reply("The build is green."), user("[Wake-up] Check the build", { kuvo: { wake: { summary: "Check the build" } } })],
    ses_follow: [end(2000), reply("The crawl finished."), { type: "synthetic", metadata: { source: "shell" } }],
    ses_session_news: [end(2000), reply("Its tests pass."), user("[Session finished] \"Tests\" in kuvo-store (address ses_tests):\nAll green.", { kuvo: { note: { from: "Its sessions", line: "“Tests” finished" } } })],
    ses_stopped: [end(2000, "interrupted"), reply("Looking at the"), user(letter)],
    ses_summary: [end(2000), { type: "compaction", status: "completed", reason: "manual" }, end(1500), reply("Done."), user(letter)],
  };
  for (const [id, page] of Object.entries(turns)) {
    bots(id);
    pages[id] = [...page, ...before];
    await link.keepWorkRead(target, id);
    assert.equal(isUnread(id), false, id);
  }
});

test("what's news to you since you read it stays new, as its notification does: its reply to you, a failure, what it sent you on purpose", async () => {
  const turns = {
    ses_asked: [end(2000), reply("Two, both in the README."), user("How many broken links did you find?")],
    // Your word came while it worked on the bot's: the turn answers you too.
    ses_mixed: [end(2000), reply("Done, and the button's blue now."), user("Make the button blue too"), reply("On it."), user(letter)],
    ses_answered: [end(2000), reply("Using Postgres."), user("[The user answered] Postgres")],
    ses_failed: [end(2000, "failed"), user(letter)],
    // Your reply came first, the bot's word after it: yours is still to be read.
    ses_then_bot: [end(2000), reply("On it."), user(letter), end(1500), reply("Yes, merged."), user("Did you merge it?")],
  };
  for (const [id, page] of Object.entries(turns)) {
    bots(id);
    pages[id] = [...page, ...before];
    await link.keepWorkRead(target, id);
    assert.equal(isUnread(id), true, id);
  }
  // Its agent told you something with notify_user since you read it.
  bots("ses_notified");
  pages.ses_notified = [end(2000), reply("Waiting for the key."), user(letter), ...before];
  fs.mkdirSync(path.dirname(told), { recursive: true });
  fs.writeFileSync(told, JSON.stringify([{ id: "ntc_1", at: 1500, by: "agent", notice: { title: "ses_notified", body: "I need your Stripe key.", category: "finished", thread: "ses_notified", data: { session: "ses_notified" } } }]));
  await link.keepWorkRead(target, "ses_notified");
  assert.equal(isUnread("ses_notified"), true);
  // One whose turns can't be read is left as it is.
  bots("ses_unreadable");
  pages.ses_unreadable = null;
  await link.keepWorkRead(target, "ses_unreadable");
  assert.equal(isUnread("ses_unreadable"), true);
});

test("your own sessions, a bot's own conversation, a subagent's, a hidden run's, and one whose starter doesn't hear of it, are as they were", async () => {
  session("ses_yours");
  session("ses_bot", { kuvo: { bot: "bot_1" } });
  sessions.ses_sub = { ...bots("ses_sub"), parentID: "ses_checkout" };
  session("ses_seat", { kuvo: { startedBy: "ses_foreman", by: BOT, seat: { group: "grp_1", bot: "bot_1" } } });
  // Started by one of your conversations, which isn't told when it finishes: you're the one to see it.
  session("ses_unheard", { kuvo: { startedBy: "ses_mine" } });
  for (const id of ["ses_yours", "ses_bot", "ses_sub", "ses_seat", "ses_unheard"]) {
    pages[id] = [end(2000), reply("Done."), user(letter), ...before];
    await link.keepWorkRead(target, id);
    assert.equal(isUnread(id), true, id);
  }
  // One your conversation started and hears of, as a bot does: its work.
  session("ses_heard", { kuvo: { startedBy: "ses_mine", wake: ["finished"] } });
  pages.ses_heard = [end(2000), reply("Done."), user(letter), ...before];
  await link.keepWorkRead(target, "ses_heard");
  assert.equal(isUnread("ses_heard"), false);
});

test("while it asks you something, it's left as it is: what it asks reaches your phones, and stays with you", WAITS, async () => {
  bots("ses_checkout");
  pages.ses_checkout = [end(2000), reply("I need to run the tests."), user(letter), ...before];
  asks.ses_checkout = [{ id: "per_1", sessionID: "ses_checkout", action: "shell", resources: ["npm test"] }];
  let notice;
  const noticed = new Promise(resolve => { notice = resolve; });
  await watching(async () => {
    send({ type: "permission.asked", data: { id: "per_1", sessionID: "ses_checkout", action: "shell", resources: ["npm test"] } });
    assert.equal((await noticed).category, "permission");
  }, item => { notice(item); return true; });
  await link.keepWorkRead(target, "ses_checkout");
  assert.equal(isUnread("ses_checkout"), true);
  // Answered: its work is read again.
  asks.ses_checkout = [];
  await link.keepWorkRead(target, "ses_checkout");
  assert.equal(isUnread("ses_checkout"), false);
});

test("what ended before the box was listening (the 16 sessions at work for days) is read as it finds its engine; one with a reply to you stays new", WAITS, async () => {
  for (let index = 0; index < 16; index++) {
    bots(`ses_work${index}`);
    pages[`ses_work${index}`] = [end(2000), reply("Step done."), user(letter), ...before];
  }
  // Never read at all.
  bots("ses_never");
  delete sessions.ses_never.time.viewed;
  pages.ses_never = [end(2000), reply("Step done."), user(letter), end(500), reply("Started."), user(letter)];
  bots("ses_to_you");
  pages.ses_to_you = [end(2000), reply("Yes, merged."), user("Did you merge it?"), ...before];
  session("ses_yours");
  pages.ses_yours = [end(2000), reply("Done."), ...before];
  await watching(async () => {
    for (let index = 0; index < 16; index++) await readNow(`ses_work${index}`);
    await readNow("ses_never");
  });
  await link.settleWorkRead(target);
  assert.equal(isUnread("ses_to_you"), true);
  assert.equal(isUnread("ses_yours"), true);
});

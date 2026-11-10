// An agent's work isn't news to you (PROTOCOL.md, "What's been read", READ_RULE; task #424): a
// session a bot or another conversation started and leads is its work, so the box reads each of
// its turns as it ends, on every client at once (no dot on its row, its project or its computer),
// unless the turn answers you: you wrote in it, or answered what it asked you. Your own sessions
// are as ever, and what such a session asks you still waits on you. The real box code, watching an
// engine that's a stand-in. Run with `node --test Packages/KuvoLink/Tests/Bridge/work-read.test.js`.
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

// The engine: its sessions (each one's `time.idle` and `time.viewed`), each one's latest messages
// (newest first), and what each client's been told was read (`session.viewed`), as the engine does.
let sessions, pages, followers, viewed;
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
    if (url.pathname === "/api/session") return reply({ data: Object.values(sessions), cursor: null });
    const [, id, rest] = url.pathname.match(/^\/api\/session\/([^/]+)(\/.*)?$/) ?? [];
    const session = sessions[decodeURIComponent(id ?? "")];
    if (!session) return reply({ message: "Not here." }, 404);
    if (!rest && request.method === "GET") return reply({ data: session });
    if (rest === "/message") return reply({ data: pages[session.id] ?? [], cursor: null });
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

beforeEach(() => {
  sessions = {};
  pages = {};
  followers = [];
  viewed = [];
});

// A session, unread: its last turn ended at 2000, and it was last read at 1000.
const BOT = { bot: "bot_1", name: "Kuvo Foreman" };
const session = (id, metadata) => {
  sessions[id] = { id, title: id, location: { directory: "/home/me/kuvo-store" }, time: { created: 1, updated: 2000, idle: 2000, viewed: 1000 }, ...(metadata ? { metadata } : {}) };
  return sessions[id];
};
const bots = id => session(id, { kuvo: { startedBy: "ses_foreman", by: BOT, depth: 1 } });
// The same unread on every client: `Session.isUnread`, which each row and what rolls them up reads.
const isUnread = id => sessions[id].time.idle > (sessions[id].time.viewed ?? 0);

const idle = { type: "idle", outcome: "succeeded" };
const reply = text => ({ type: "assistant", content: [{ type: "text", text }] });
const user = (text, metadata) => ({ type: "user", text, ...(metadata ? { metadata } : {}) });
const letter = "[Message from Kuvo Foreman · ses_foreman] (To answer, use send_message to ses_foreman.)\n\nFix the store's checkout page.";

// The box following the engine as every box does, while `run` runs.
async function watching(run) {
  const stop = new AbortController();
  const connected = new Promise(resolve => following.push(resolve));
  link.watchEvents(() => target, () => true, stop.signal, undefined, { work: "engine" });
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

test("a session the bot leads, answering the bot, is read as its turn ends: nothing new on any client", async () => {
  bots("ses_checkout");
  sessions.ses_checkout.time.viewed = 2000;
  await watching(async () => {
    // Its next turn: the bot's word to it, and its reply.
    sessions.ses_checkout.time.idle = 3000;
    pages.ses_checkout = [idle, reply("The checkout page is fixed."), user(letter)];
    send({ type: "session.execution.succeeded", data: { sessionID: "ses_checkout" } });
    await readNow("ses_checkout");
    assert.equal(sessions.ses_checkout.time.viewed, 3000, "read up to the end of that turn");
  });
});

test("so are its other turns that aren't to you: its own wake-up, what it left running coming back, one that failed or was stopped", async () => {
  const turns = {
    ses_wake: [idle, reply("The build is green."), user("[Wake-up] Check the build", { kuvo: { wake: { summary: "Check the build" } } })],
    ses_follow: [idle, reply("The crawl finished."), { type: "synthetic", metadata: { source: "shell" } }],
    ses_session_news: [idle, reply("Its tests pass."), user("[Session finished] \"Tests\" in kuvo-store (address ses_tests):\nAll green.", { kuvo: { note: { from: "Its sessions", line: "“Tests” finished" } } })],
    ses_failed: [{ type: "idle", outcome: "failed" }, user(letter)],
    ses_stopped: [{ type: "idle", outcome: "interrupted" }, reply("Looking at the"), user(letter)],
  };
  for (const [id, page] of Object.entries(turns)) {
    bots(id);
    pages[id] = page;
    await link.keepWorkRead(target, id);
    assert.equal(isUnread(id), false, id);
  }
});

test("its reply to you is unread, as in any session of yours: you wrote in it, or answered what it asked you", async () => {
  for (const [id, page] of Object.entries({
    ses_asked: [idle, reply("Two, both in the README."), user("How many broken links did you find?")],
    // Your word came while it worked on the bot's: the turn answers you too.
    ses_mixed: [idle, reply("Done, and the button's blue now."), user("Make the button blue too"), reply("On it."), user(letter)],
    ses_answered: [idle, reply("Using Postgres."), user("[The user answered] Postgres")],
  })) {
    bots(id);
    pages[id] = page;
    await link.keepWorkRead(target, id);
    assert.equal(isUnread(id), true, id);
  }
  // One whose turn can't be read is left as it is.
  bots("ses_unreadable");
  await link.keepWorkRead(target, "ses_unreadable");
  assert.equal(isUnread("ses_unreadable"), true);
});

test("your own sessions, a bot's own conversation and a subagent's are as they were", async () => {
  session("ses_yours");
  session("ses_bot", { kuvo: { bot: "bot_1" } });
  sessions.ses_sub = { ...bots("ses_sub"), parentID: "ses_checkout" };
  for (const id of ["ses_yours", "ses_bot", "ses_sub"]) {
    pages[id] = [idle, reply("Done."), user(letter)];
    await link.keepWorkRead(target, id);
    assert.equal(isUnread(id), true, id);
  }
});

test("what ended before the box was listening (the 16 sessions at work for days) is read as it finds its engine; one that answered you stays new", async () => {
  for (let index = 0; index < 16; index++) {
    bots(`ses_work${index}`);
    pages[`ses_work${index}`] = [idle, reply("Step done."), user(letter)];
  }
  bots("ses_to_you");
  pages.ses_to_you = [idle, reply("Yes, merged."), user("Did you merge it?")];
  session("ses_yours");
  pages.ses_yours = [idle, reply("Done.")];
  await watching(async () => {
    for (let index = 0; index < 16; index++) await readNow(`ses_work${index}`);
  });
  await link.settleWorkRead(target);
  assert.equal(isUnread("ses_to_you"), true);
  assert.equal(isUnread("ses_yours"), true);
});

test("what it asks you still waits on you: told to your phones, and nothing read for it", async () => {
  bots("ses_checkout");
  sessions.ses_checkout.time.viewed = 2000;
  const stop = new AbortController();
  const connected = new Promise(resolve => following.push(resolve));
  let told;
  const notice = new Promise(resolve => { told = resolve; });
  link.watchEvents(() => target, item => { told(item); return true; }, stop.signal, undefined, { work: "engine" });
  try {
    await connected;
    send({ type: "permission.asked", data: { id: "per_1", sessionID: "ses_checkout", action: "shell", resources: ["npm test"] } });
    assert.deepEqual(await notice, {
      title: "ses_checkout", subtitle: "kuvo-store", body: "Wants to run a command: npm test", category: "permission", thread: "ses_checkout",
      data: { session: "ses_checkout", request: "per_1", alwaysTitle: "Always Allow npm test" },
    });
    assert.equal(sessions.ses_checkout.time.viewed, 2000);
  } finally {
    stop.abort();
  }
});

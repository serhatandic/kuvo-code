// A session's queue, carried on by its box (PROTOCOL.md, "The queue"), whichever client is
// connected or none: once a run ends, after a moment, the next message goes; a Stop (from any
// client), a failed run and a queue left when the engine started again pause it, holding what was
// for the next step ahead of the queue; Resume and Send Now go on. The real box code, on a clock the
// test moves; only the engine is a stand-in, keeping each session's inbox as the engine does.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/queue.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-queue-")));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

// The engine: each session's inbox and whether it runs; what was asked of it, each time a test
// waits on it looking again.
let inboxes, running, asked, prompted, unsure = false, taken = new Set(), waiting = [], latest = {}, pages = {}, viewedAt = 0, looks = 0, whenLooked = null;
// A busy engine: the next `stalls` reads of a session get no answer until the test ends them.
let stalls = 0, stalled = [];
const heard = () => new Promise(resolve => waiting.push(resolve));
const engine = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const url = new URL(request.url, "http://x");
    const [, session, rest] = url.pathname.match(/^\/api\/session\/([^/]+)(\/.*)?$/) ?? [];
    let answer = null;
    if (url.pathname === "/api/session") answer = { data: Object.keys(inboxes).map(id => ({ id, time: { updated: Date.now() } })) };
    else if (url.pathname === "/api/session/active") {
      looks++;
      answer = unsure ? null : { data: Object.fromEntries([...running].map(id => [id, {}])) };
      // (What happens just as it's answered, once.)
      const then = whenLooked;
      whenLooked = null;
      then?.();
    }
    else if (session && !rest && request.method === "GET" && stalls > 0) {
      stalls--;
      return stalled.push(response);
    }
    else if (session && !rest && request.method === "GET") answer = inboxes[session] ? { data: { id: session, time: { viewed: viewedAt, idle: 3_000 } } } : null;
    else if (rest === "/view" && request.method === "POST") {
      // (As the engine: it takes which end you saw, and refuses a look that doesn't say.)
      const seen = JSON.parse(body || "{}").idle;
      if (seen === undefined) return reply({ message: "Missing key idle" }, 400);
      viewedAt = seen;
      answer = {};
    }
    else if (rest === "/inbox") answer = { data: inboxes[session] ?? [] };
    // Its newest message (the queue only asks for the one).
    else if (rest === "/message") answer = { data: url.searchParams.get("limit") === "6" ? pages[session] ?? [] : latest[session] ? [latest[session]] : [] };
    else if (rest?.startsWith("/inbox/") && request.method === "DELETE") {
      inboxes[session] = (inboxes[session] ?? []).filter(each => each.id !== decodeURIComponent(rest.slice(7)));
      asked.push(`${session} ${decodeURIComponent(rest.slice(7))} gone`);
      answer = {};
    }
    else if (rest?.startsWith("/inbox/") && request.method === "PATCH") {
      const item = (inboxes[session] ?? []).find(each => each.id === decodeURIComponent(rest.slice(7)));
      const { delivery } = JSON.parse(body);
      // Taken by the agent already: the engine has no such item.
      if (!item || taken.has(item.id)) return reply({ message: "Not in the inbox." }, 404);
      if (item) item.delivery = delivery;
      asked.push(`${session} ${item?.id} ${delivery}`);
      answer = {};
    } else if (rest === "/prompt" && request.method === "POST") {
      // A message for the session: what it says, as it went.
      const given = JSON.parse(body);
      prompted.push({ session, ...given });
      asked.push(`${session} prompt ${given.id}`);
      answer = {};
    } else if (rest === "/interrupt") {
      asked.push(`${session} ${url.searchParams.get("resume") === "true" ? "resume" : "stop"}`);
      answer = { data: true };
    }
    if (answer === null) reply({ message: "Not here." }, 404);
    else reply(answer);
    for (const resolve of waiting.splice(0)) resolve();
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
const target = { port: engine.address().port, password: "p", pid: 1 };
fs.mkdirSync(path.join(home, "run"), { recursive: true });
fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify(target));

beforeEach(() => {
  // Each test's box as it starts: no message remembered as sent (their ids repeat across tests).
  link.forgetEverythingSent();
  inboxes = {};
  running = new Set();
  asked = [];
  prompted = [];
  unsure = false;
  taken = new Set();
  latest = {};
  pages = {};
  whenLooked = null;
  stalls = 0;
  for (const response of stalled.splice(0)) response.destroy();
  link.PLACE_TRIES.splice(0, Infinity, 10_000, 20_000);
  fs.rmSync(path.join(home, "run", "queues.json"), { force: true });
  fs.rmSync(path.join(home, "run", "waiting"), { recursive: true, force: true });
});

// What the engine was asked, once it's been asked `count` things.
async function askedAfter(count) {
  while (asked.length < count) await heard();
  return asked;
}

// The box watching the engine, on a clock the test moves.
function box(found) {
  let time = 0;
  let timers = [];
  const hear = link.queueWatcher(target, {
    schedule: (run, ms) => { const timer = { at: time + ms, run }; timers.push(timer); return timer; },
    cancel: timer => { timers = timers.filter(each => each !== timer); },
    found,
  });
  const box = {
    hear: (type, data = {}, session = "ses_1") => hear({ type, data: { sessionID: session, ...data } }),
    wait: ms => {
      time += ms;
      for (let due = timers.find(each => each.at <= time); due; due = timers.find(each => each.at <= time)) {
        timers = timers.filter(each => each !== due);
        due.run();
      }
    },
    // Moved on `ms`, until the box has looked whether a session is at work (and a few turns more,
    // for what it does with the answer).
    looked: async ms => {
      const before = looks;
      box.wait(ms);
      while (looks === before) await heard();
      for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
    },
  };
  return box;
}

// The box's routes, as a client asks them.
const handle = link.engineHandler(() => target, { name: "lab" }, () => { throw new Error("none"); });
// (From this Mac's app, unless `from` says "phone".)
async function ask(method, route, body, from = "app") {
  let status = 0, text = "";
  for await (const part of handle({ method, path: route, headers: {}, body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)), fromApp: from === "app" }, {}, undefined)) {
    if (part.head) status = part.head.status;
    if (part.body) text += part.body.toString();
  }
  return { status, json: JSON.parse(text) };
}
// Until the box's state of `session` is what `wanted` says (it changes once the engine's last
// answer is read: looked at again each turn of the event loop).
async function until(wanted, session = "ses_1") {
  while (!wanted(link.queueOf(session))) await new Promise(resolve => setImmediate(resolve));
  return link.queueOf(session);
}

test("once a run ends, the next queued message goes a moment later, the first queued first", async () => {
  inboxes.ses_1 = [{ id: "msg_q1", delivery: "queue" }, { id: "msg_q2", delivery: "queue" }];
  const b = box();
  b.hear("session.execution.succeeded");
  b.wait(1000);
  assert.deepEqual(asked, [], "not at once: the engine may still be handing over what it had");
  b.wait(500);
  assert.deepEqual(await askedAfter(1), ["ses_1 msg_q1 steer"]);
  // A run starting meanwhile: nothing more goes until it ends.
  b.hear("session.execution.succeeded");
  b.hear("session.execution.started");
  b.wait(5000);
  assert.deepEqual(asked, ["ses_1 msg_q1 steer"]);
});

test("Stop holds what was for the next step ahead of the queue and pauses it; a run ending doesn't start it; Resume goes on with what Stop held first", async () => {
  inboxes.ses_1 = [{ id: "msg_q1", delivery: "queue" }, { id: "msg_s1", delivery: "steer" }];
  running.add("ses_1");
  const stopped = await ask("POST", "kuvo/sessions/ses_1/stop");
  assert.deepEqual(stopped, { status: 200, json: { paused: true, held: ["msg_s1"] } });
  assert.deepEqual(asked, ["ses_1 msg_s1 queue", "ses_1 stop"]);
  running.delete("ses_1");
  const b = box();
  b.hear("session.execution.interrupted", { reason: "user" });
  b.hear("session.execution.succeeded");
  b.wait(5000);
  assert.equal(asked.length, 2, "nothing started while it's paused");
  assert.deepEqual((await ask("GET", "kuvo/sessions/ses_1/queue")).json, { paused: true, held: ["msg_s1"] });
  const resumed = await ask("POST", "kuvo/sessions/ses_1/queue/resume");
  assert.equal(resumed.status, 200);
  assert.deepEqual(asked.slice(2), ["ses_1 msg_s1 steer"], "what Stop held goes first");
  assert.deepEqual(resumed.json, { paused: false, held: [] });
});

test("a summary waiting at Stop isn't a message: what a lead's stop_session leaves isn't paused, and nothing is left to run unseen", async () => {
  // A bot stopping its own session: paused only when something really waits.
  inboxes.ses_1 = [{ id: "msg_sum", type: "compaction", delivery: "steer" }];
  running.add("ses_1");
  await link.stopSession(target, "ses_1", false);
  assert.deepEqual((await ask("GET", "kuvo/sessions/ses_1/queue")).json, { paused: false, held: [] });
  assert.deepEqual(asked, ["ses_1 stop"]);
  running.delete("ses_1");
  const b = box();
  b.hear("session.execution.interrupted", { reason: "user" });
  b.wait(5000);
  await askedAfter(2);
  assert.equal(asked[1], "ses_1 msg_sum gone");
  assert.deepEqual(inboxes.ses_1, []);

  // Your Stop holds what's yours and pauses, as ever; the summary isn't among them.
  inboxes.ses_1 = [{ id: "msg_sum", type: "compaction", delivery: "steer" }, { id: "msg_s1", delivery: "steer" }];
  const stopped = await ask("POST", "kuvo/sessions/ses_1/stop");
  assert.deepEqual(stopped.json, { paused: true, held: ["msg_s1"] });
});

test("a failed run lets go of a summary waiting; a summary that failed pauses nothing, and what's queued goes on", async () => {
  inboxes.ses_1 = [{ id: "msg_sum", type: "compaction", delivery: "steer" }, { id: "msg_q1", delivery: "queue" }];
  const b = box();
  b.hear("session.execution.failed", { error: { message: "No." } });
  await askedAfter(1);
  assert.deepEqual(asked, ["ses_1 msg_sum gone"]);
  assert.equal((await ask("GET", "kuvo/sessions/ses_1/queue")).json.paused, true, "a run that failed pauses, as ever");

  await ask("POST", "kuvo/sessions/ses_1/queue/resume");
  asked = [];
  prompted = [];
  inboxes.ses_2 = [{ id: "msg_q2", delivery: "queue" }];
  pages.ses_2 = [{ type: "idle", outcome: "failed" }, { type: "compaction", status: "failed", reason: "manual" }];
  b.hear("session.execution.failed", { error: { message: "It couldn't." } }, "ses_2");
  await new Promise(resolve => setImmediate(resolve));
  for (let looks = 0; looks < 100_000 && !asked.includes("ses_2 msg_q2 steer"); looks++) { b.wait(5000); await Promise.race([heard(), new Promise(resolve => setImmediate(resolve))]); }
  assert.ok(asked.includes("ses_2 msg_q2 steer"), "what waited went on");
  assert.equal((await ask("GET", "kuvo/sessions/ses_2/queue")).json.paused, false);
});

test("a session only summarized while it was read stays read; one with news from before stays unread; a reply after it is news", async () => {
  inboxes.ses_1 = [];
  const summarized = [{ type: "idle", outcome: "succeeded", time: { created: 3_000 } }, { type: "compaction", status: "completed", reason: "manual" }, { type: "idle", outcome: "succeeded", time: { created: 1_000 } }];
  pages.ses_1 = summarized;
  viewedAt = 2_000;
  await link.keepReadThroughSummary(target, "ses_1");
  assert.equal(viewedAt, 3_000, "read up to the summary's end");

  viewedAt = 500;
  await link.keepReadThroughSummary(target, "ses_1");
  assert.equal(viewedAt, 500, "there was news before it");

  viewedAt = 2_000;
  pages.ses_1 = [{ type: "idle", outcome: "succeeded", time: { created: 4_000 } }, { type: "assistant", content: [] }, ...summarized.slice(1)];
  await link.keepReadThroughSummary(target, "ses_1");
  assert.equal(viewedAt, 2_000, "a reply after it");

  // Taken at a step of a run on the engine: the end after it is that run's, with its reply to read.
  pages.ses_1 = [summarized[0], summarized[1], { type: "assistant", content: [] }, { type: "user", text: "Go." }, summarized[2]];
  await link.keepReadThroughSummary(target, "ses_1");
  assert.equal(viewedAt, 2_000, "a reply in the same run");
});

test("a Stop from a client that stops the run itself pauses the queue too; Send Now's stop-and-go doesn't", async () => {
  inboxes.ses_1 = [{ id: "msg_q1", delivery: "queue" }];
  inboxes.ses_2 = [{ id: "msg_q2", delivery: "queue" }];
  const b = box();
  // The coding agents' bridge says no reason; the engine says "user".
  b.hear("session.execution.interrupted");
  b.hear("session.execution.interrupted", { reason: "user" }, "ses_2");
  b.hear("session.execution.started", {}, "ses_2");
  b.wait(1500);
  assert.deepEqual(await until(state => state.paused), { paused: true, held: [] });
  assert.deepEqual(link.queueOf("ses_2"), { paused: false, held: [] }, "it started again at once: Send Now");
  // The engine ending a run itself goes on as one that ended well.
  inboxes.ses_3 = [{ id: "msg_q3", delivery: "queue" }];
  b.hear("session.execution.interrupted", { reason: "inactivity" }, "ses_3");
  b.wait(1500);
  assert.ok((await askedAfter(asked.length + 1)).includes("ses_3 msg_q3 steer"));
});

test("a failed run pauses the queue, holding what was for its next step; a message you send to go now goes on", async () => {
  inboxes.ses_1 = [{ id: "msg_q1", delivery: "queue" }, { id: "msg_s1", delivery: "steer" }];
  const b = box();
  b.hear("session.execution.failed");
  assert.deepEqual(await until(state => state.paused && state.held.length), { paused: true, held: ["msg_s1"] });
  b.hear("session.execution.succeeded");
  b.wait(5000);
  assert.deepEqual(asked, ["ses_1 msg_s1 queue"], "it doesn't run the rest into the same error");
  // You write again, for now: no longer paused.
  inboxes.ses_1.push({ id: "msg_s2", delivery: "steer" });
  b.hear("session.inbox.enqueued", { inboxID: "msg_s2", item: { type: "user", delivery: "steer", payload: { text: "Try the other model." } } });
  assert.equal(link.queueOf("ses_1").paused, false);
});

test("a message queued while nothing runs goes a moment later, unless the queue is paused", async () => {
  inboxes.ses_1 = [{ id: "msg_q1", delivery: "queue" }];
  const b = box();
  b.hear("session.inbox.enqueued", { inboxID: "msg_q1", item: { delivery: "queue" } });
  b.wait(1500);
  assert.deepEqual(await askedAfter(1), ["ses_1 msg_q1 steer"]);
  // Paused: it waits.
  inboxes.ses_2 = [{ id: "msg_q2", delivery: "queue" }];
  assert.equal((await ask("POST", "kuvo/sessions/ses_2/queue/hold")).json.paused, true);
  b.hear("session.inbox.enqueued", { inboxID: "msg_q2", item: { delivery: "queue" } }, "ses_2");
  b.wait(5000);
  assert.ok(!asked.some(each => each.startsWith("ses_2")));
});

test("Send Now gives a queued message to the agent right away: steered, the step under way stopped for it, the queue going again", async () => {
  inboxes.ses_1 = [{ id: "msg_q1", delivery: "queue" }, { id: "msg_q2", delivery: "queue" }];
  running.add("ses_1");
  fs.writeFileSync(path.join(home, "run", "queues.json"), JSON.stringify({ ses_1: { paused: true, held: [] } }));
  const sent = await ask("POST", "kuvo/sessions/ses_1/queue/msg_q2/now");
  assert.deepEqual(sent, { status: 200, json: { paused: false, held: [] } });
  assert.deepEqual(asked, ["ses_1 msg_q2 steer", "ses_1 resume"]);
  assert.equal((await ask("POST", "kuvo/sessions/ses_1/queue/msg_gone/now")).status, 404);
});

test("a queue left with nothing running when the engine started again waits for Resume; the same engine's events coming back don't pause it", async () => {
  inboxes.ses_1 = [{ id: "msg_q1", delivery: "queue" }, { id: "msg_s1", delivery: "steer" }];
  inboxes.ses_2 = [];
  inboxes.ses_3 = [{ id: "msg_q3", delivery: "queue" }];
  running.add("ses_3");
  await link.scanQueues({ ...target, pid: 10 });
  assert.deepEqual(link.queueOf("ses_1"), { paused: true, held: ["msg_s1"] });
  assert.deepEqual(link.queueOf("ses_3"), { paused: false, held: [] }, "one at work carries on");
  fs.rmSync(path.join(home, "run", "queues.json"), { force: true });
  await link.scanQueues({ ...target, pid: 10 });
  assert.deepEqual(link.queueOf("ses_1"), { paused: false, held: [] });
  await link.scanQueues({ ...target, pid: 11 });
  assert.equal(link.queueOf("ses_1").paused, true);
});

test("a run that ended while the box was starting again, beside the same engine: what waits goes on, unless it's paused, or the run was stopped or failed", async () => {
  await link.scanQueues({ ...target, pid: 30 });
  inboxes.ses_1 = [{ id: "msg_q1", delivery: "queue" }];
  // (Each run's end as the engine says it: its newest message, how the run went.)
  latest.ses_1 = { id: "msg_i1", type: "idle", outcome: "succeeded" };
  inboxes.ses_2 = [{ id: "msg_q2", delivery: "queue" }];
  inboxes.ses_3 = [{ id: "msg_q3", delivery: "queue" }];
  running.add("ses_3");
  // Stopped (from a client that couldn't reach the box), and failed.
  inboxes.ses_4 = [{ id: "msg_q4", delivery: "queue" }, { id: "msg_s4", delivery: "steer" }];
  latest.ses_4 = { id: "msg_i4", type: "idle", outcome: "interrupted" };
  inboxes.ses_5 = [{ id: "msg_q5", delivery: "queue" }];
  latest.ses_5 = { id: "msg_i5", type: "idle", outcome: "failed", error: { type: "provider", message: "Overloaded." } };
  await ask("POST", "kuvo/sessions/ses_2/queue/hold");
  await link.scanQueues({ ...target, pid: 30 });
  assert.deepEqual(asked.filter(each => each.endsWith(" steer") || each.endsWith(" resume")), ["ses_1 msg_q1 steer"], "the one waiting goes; the paused one, the one at work, the stopped and the failed don't");
  assert.deepEqual(link.queueOf("ses_1"), { paused: false, held: [] });
  assert.deepEqual(link.queueOf("ses_4"), { paused: true, held: ["msg_s4"] }, "held as a Stop holds it");
  assert.deepEqual(link.queueOf("ses_5"), { paused: true, held: [] });
});

test("every client follows the queues: a line now, one each time they change", async () => {
  inboxes.ses_1 = [{ id: "msg_q1", delivery: "queue" }];
  const stop = new AbortController();
  const lines = [];
  const following = (async () => {
    let text = "";
    for await (const part of handle({ method: "GET", path: "kuvo/sessions/queues/events", headers: {}, body: Buffer.alloc(0) }, {}, stop.signal)) {
      if (!part.body) continue;
      text += part.body.toString();
      lines.push(...text.split("\n").slice(0, -1).map(line => JSON.parse(line)));
      text = text.slice(text.lastIndexOf("\n") + 1);
      if (lines.length === 2) stop.abort();
    }
  })();
  while (!lines.length) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(lines[0], { queues: {} });
  await ask("POST", "kuvo/sessions/ses_1/queue/hold");
  await following;
  assert.deepEqual(lines[1], { queues: { ses_1: { paused: true, held: [] } } });
});

test("when its engine can't say whether a session runs, a message for its next step stays where it is", async () => {
  inboxes.ses_1 = [{ id: "msg_s1", delivery: "steer" }];
  unsure = true;
  await link.scanQueues({ ...target, pid: 20 });
  assert.deepEqual(asked, [], "not moved to the queue: the agent may be at work and take it");
  assert.deepEqual(link.queueOf("ses_1"), { paused: false, held: [] });
});

test("Resume pressed in the moment after a Stop keeps the queue going: the box's look at that Stop leaves it", async () => {
  inboxes.ses_1 = [{ id: "msg_q1", delivery: "queue" }, { id: "msg_q2", delivery: "queue" }];
  const b = box();
  b.hear("session.execution.interrupted", { reason: "user" });
  const resumed = await ask("POST", "kuvo/sessions/ses_1/queue/resume");
  assert.deepEqual(resumed.json, { paused: false, held: [] });
  b.wait(1500);
  // (Its look goes no further: nothing asked of the engine, nothing held.)
  for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(link.queueOf("ses_1").paused, false);
  assert.ok(!asked.some(each => each.endsWith(" queue")), "nothing held");
});

test("after a Stop, another agent's letter or a wake-up reaching the conversation doesn't start the queue; your own message does", async () => {
  inboxes.ses_1 = [{ id: "msg_q1", delivery: "queue" }];
  fs.writeFileSync(path.join(home, "run", "queues.json"), JSON.stringify({ ses_1: { paused: true, held: [] } }));
  const b = box();
  for (const text of ["[Message from Scout · ses_scout] (To answer, use send_message to ses_scout.)\n\nBuild's green.", "[Wake-up] Check the deploy."]) {
    b.hear("session.inbox.enqueued", { inboxID: "msg_x", item: { type: "user", delivery: "steer", payload: { text } } });
    assert.equal(link.queueOf("ses_1").paused, true, text);
  }
  b.hear("session.inbox.enqueued", { inboxID: "msg_y", item: { type: "user", delivery: "steer", payload: { text: "Actually, skip the docs." } } });
  assert.equal(link.queueOf("ses_1").paused, false);
});

test("a Stop as the agent takes a message for its next step holds only what's still waiting", async () => {
  // msg_s1 is listed as the box reads the inbox, but the agent takes it before it's moved.
  inboxes.ses_1 = [{ id: "msg_q1", delivery: "queue" }, { id: "msg_s1", delivery: "steer" }];
  taken.add("msg_s1");
  const stopped = await ask("POST", "kuvo/sessions/ses_1/queue/hold");
  assert.deepEqual(stopped.json, { paused: true, held: [] }, "nothing held that isn't there to hold");
});

test("Stop holds the conversation though nothing waits: what you queue meanwhile waits on the box, shown with the queue, and goes once you resume, after what Stop held, a run at a time", async () => {
  inboxes.ses_1 = [];
  running.add("ses_1");
  assert.deepEqual((await ask("POST", "kuvo/sessions/ses_1/stop")).json, { paused: true, held: [] }, "paused with nothing waiting");
  running.delete("ses_1");
  // Undo of a removed message, and one sent after this run: to the box, not the engine.
  const first = await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_back1", text: "Also update the docs." });
  assert.equal(first.json.waits, true);
  await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_back2", text: "Then run the tests.", files: [{ uri: "file:///tmp/notes.txt", name: "notes.txt" }] });
  assert.deepEqual(prompted, [], "nothing reached the engine, which would run it");
  const shown = (await ask("GET", "kuvo/sessions/ses_1/queue")).json;
  assert.deepEqual(shown.waiting.map(({ id, text, files }) => ({ id, text, files })), [
    { id: "msg_back1", text: "Also update the docs.", files: undefined },
    { id: "msg_back2", text: "Then run the tests.", files: ["notes.txt"] },
  ]);
  // A run ending meanwhile (the stopped one's end coming late) starts nothing.
  const b = box();
  b.hear("session.execution.succeeded");
  b.wait(5000);
  assert.deepEqual(prompted, []);
  // Resume: the first goes now; the next once its run ends.
  const resumed = await ask("POST", "kuvo/sessions/ses_1/queue/resume");
  assert.deepEqual(prompted.map(each => [each.id, each.text, each.delivery]), [["msg_back1", "Also update the docs.", "steer"]]);
  assert.deepEqual(resumed.json.waiting.map(each => each.id), ["msg_back2"]);
  b.hear("session.execution.started");
  b.hear("session.execution.succeeded");
  b.wait(1500);
  while (prompted.length < 2) await heard();
  assert.deepEqual(prompted.map(each => each.id), ["msg_back1", "msg_back2"]);
  assert.equal(link.queueOf("ses_1").waiting, undefined);
  assert.deepEqual(prompted[1].files, [{ uri: "file:///tmp/notes.txt", name: "notes.txt" }], "whole, with its files");
});

test("a message added while the queue isn't paused goes straight to the engine, as asked", async () => {
  inboxes.ses_1 = [];
  const added = await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_q1", text: "After this, the docs." });
  assert.equal(added.json.waits, false);
  assert.deepEqual(prompted.map(each => [each.id, each.delivery]), [["msg_q1", "queue"]]);
});

test("a message for the queue sent again under its id (its phone's link dropped before the answer) is added once (#144)", async () => {
  inboxes.ses_1 = [];
  const message = { id: "msg_again1", text: "After this, the changelog.", files: [{ uri: "data:image/png;base64,iVBORw0KGgo=", name: "shot.png" }] };
  const first = await ask("POST", "kuvo/sessions/ses_1/queue/add", message);
  const again = await ask("POST", "kuvo/sessions/ses_1/queue/add", message);
  assert.equal(first.json.waits, false);
  assert.equal(again.status, 200);
  assert.equal(again.json.waits, false);
  assert.deepEqual(prompted.map(each => each.id), ["msg_again1"]);
  // Paused, one sent again waits there once.
  await ask("POST", "kuvo/sessions/ses_1/stop");
  const held = { id: "msg_again2", text: "And the docs." };
  assert.equal((await ask("POST", "kuvo/sessions/ses_1/queue/add", held)).json.waits, true);
  assert.equal((await ask("POST", "kuvo/sessions/ses_1/queue/add", held)).json.waits, true);
  assert.deepEqual(link.queueOf("ses_1").waiting.map(each => each.id), ["msg_again2"]);
  // Taken away, then put back with Undo under the same id: it's there again.
  const removed = (await ask("DELETE", "kuvo/sessions/ses_1/queue/msg_again2")).json.removed;
  assert.deepEqual(link.queueOf("ses_1").waiting ?? [], []);
  assert.equal((await ask("POST", "kuvo/sessions/ses_1/queue/add", { ...removed, kept: true })).json.waits, true);
  assert.deepEqual(link.queueOf("ses_1").waiting.map(each => each.id), ["msg_again2"]);
});

test("paused, the queue stays so once what waited is taken away: what arrives after still waits for Resume", async () => {
  inboxes.ses_1 = [{ id: "msg_q1", delivery: "queue" }];
  assert.equal((await ask("POST", "kuvo/sessions/ses_1/stop")).json.paused, true);
  inboxes.ses_1 = [];
  const b = box();
  b.hear("session.inbox.cancelled", { inboxID: "msg_q1" });
  for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(link.queueOf("ses_1").paused, true);
  assert.equal((await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_late", text: "One more thing." })).json.waits, true);
});

test("Undo puts one taken away from what waits back as it was, where it was: its whole words, who it's from, and how it was shown", async () => {
  inboxes.ses_1 = [];
  await ask("POST", "kuvo/sessions/ses_1/stop");
  await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_w1", text: "From Ada: the build is green.", from: "Ada" });
  await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_w2", text: "Second." });
  await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_w3", text: "Third." });
  const { removed } = (await ask("DELETE", "kuvo/sessions/ses_1/queue/msg_w1")).json;
  // (`before`: what came after it, for Undo to put it back ahead of; its parts, kept with it.)
  assert.deepEqual(removed, { id: "msg_w1", text: "From Ada: the build is green.", delivery: "queue", from: "Ada", words: "From Ada: the build is green.", before: "msg_w2",
    metadata: { kuvo: { parts: { words: "From Ada: the build is green." } } } });
  const back = await ask("POST", "kuvo/sessions/ses_1/queue/add", { ...removed, words: "the build is green.", kept: true });
  assert.equal(back.json.waits, true);
  assert.deepEqual(back.json.waiting.map(each => [each.id, each.from ?? null, each.text]), [["msg_w1", "Ada", "the build is green."], ["msg_w2", null, "Second."], ["msg_w3", null, "Third."]], "first again, where it was");
  // One from the middle, and the last: each where it was too.
  for (const item of ["msg_w2", "msg_w3"]) {
    const taken = (await ask("DELETE", `kuvo/sessions/ses_1/queue/${item}`)).json.removed;
    await ask("POST", "kuvo/sessions/ses_1/queue/add", { ...taken, kept: true });
    assert.deepEqual(link.queueOf("ses_1").waiting.map(each => each.id), ["msg_w1", "msg_w2", "msg_w3"], item);
  }
  assert.deepEqual(prompted, [], "nothing reached the engine");
  await ask("POST", "kuvo/sessions/ses_1/queue/msg_w1/now");
  assert.deepEqual(prompted.map(each => [each.id, each.text]), [["msg_w1", "From Ada: the build is green."]], "whole, as it would have gone");
});

test("after a Stop, one the engine held, removed and put back with Undo, waits on the box in its old place, and Resume sends it first", async () => {
  inboxes.ses_1 = [{ id: "msg_s1", delivery: "steer" }, { id: "msg_q2", delivery: "queue" }];
  running.add("ses_1");
  assert.deepEqual((await ask("POST", "kuvo/sessions/ses_1/stop")).json, { paused: true, held: ["msg_s1"] });
  running.delete("ses_1");
  // A client takes the first away in the engine, as it does, and the box hears.
  inboxes.ses_1 = [{ id: "msg_q2", delivery: "queue" }];
  box().hear("session.inbox.cancelled", { inboxID: "msg_s1" });
  await until(state => state.held.length === 0);
  // Undo: back ahead of what came after it, which the client names.
  const back = await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_s1", text: "Fix the docs.", before: "msg_q2" });
  assert.equal(back.json.waits, true);
  assert.deepEqual([back.json.held, back.json.waiting.map(each => each.id)], [["msg_s1"], ["msg_s1"]], "first in what goes, waiting on the box");
  assert.deepEqual(prompted, [], "nothing reached the engine, which would run it all");
  // Resume: it goes first; what the engine holds once its run ends.
  await ask("POST", "kuvo/sessions/ses_1/queue/resume");
  assert.deepEqual(prompted.map(each => [each.id, each.delivery]), [["msg_s1", "steer"]]);
  assert.ok(!asked.includes("ses_1 msg_q2 steer"), "not yet");
  const b = box();
  b.hear("session.execution.started");
  b.hear("session.execution.succeeded");
  b.wait(1500);
  assert.deepEqual((await askedAfter(4)).slice(-2), ["ses_1 prompt msg_s1", "ses_1 msg_q2 steer"]);
});

test("one the engine queued, taken from the middle and put back, goes between the same two again", async () => {
  inboxes.ses_1 = [{ id: "msg_a", delivery: "queue" }, { id: "msg_c", delivery: "queue" }];
  fs.writeFileSync(path.join(home, "run", "queues.json"), JSON.stringify({ ses_1: { paused: true, held: [] } }));
  const back = await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_b", text: "B.", before: "msg_c" });
  assert.deepEqual(back.json.held, ["msg_a", "msg_b"], "after the one ahead of it, ahead of the one after");
  await ask("POST", "kuvo/sessions/ses_1/queue/resume");
  assert.deepEqual(asked, ["ses_1 msg_a steer"]);
  // Each run ends, and the next goes.
  const b = box();
  inboxes.ses_1 = [{ id: "msg_c", delivery: "queue" }];
  b.hear("session.execution.succeeded");
  b.wait(1500);
  await askedAfter(2);
  b.hear("session.execution.succeeded");
  b.wait(1500);
  assert.deepEqual(await askedAfter(3), ["ses_1 msg_a steer", "ses_1 prompt msg_b", "ses_1 msg_c steer"]);
});

test("Send Now on one the engine holds keeps what waits on the box, to go after it", async () => {
  inboxes.ses_1 = [{ id: "msg_q1", delivery: "queue" }];
  await ask("POST", "kuvo/sessions/ses_1/stop");
  await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_w1", text: "[Letter] The build is green.", from: "Ada", words: "The build is green.", kept: true });
  const sent = await ask("POST", "kuvo/sessions/ses_1/queue/msg_q1/now");
  assert.equal(sent.status, 200);
  assert.ok(asked.includes("ses_1 msg_q1 steer"));
  assert.deepEqual(sent.json.waiting?.map(each => [each.id, each.from]), [["msg_w1", "Ada"]], "the letter still waits");
  assert.ok(fs.existsSync(path.join(home, "run", "waiting", "msg_w1.json")));
});

test("a phone's message held while stopped goes as the phone's prompt would, saying it's from the phone, shown as written", async () => {
  inboxes.ses_1 = [];
  await ask("POST", "kuvo/sessions/ses_1/stop");
  const added = await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_p1", text: "Ship it after this." }, "phone");
  assert.equal(added.json.waits, true);
  assert.deepEqual(added.json.waiting.map(each => each.text), ["Ship it after this."]);
  await ask("POST", "kuvo/sessions/ses_1/queue/msg_p1/now");
  assert.match(prompted[0].text, /^Ship it after this\.\n\n<from-phone>[\s\S]*<\/from-phone>$/);
});

test("Send Now sends one waiting on the box at once, the queue going again; one taken away doesn't go", async () => {
  inboxes.ses_1 = [];
  running.add("ses_1");
  await ask("POST", "kuvo/sessions/ses_1/stop");
  await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_w1", text: "First." });
  await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_w2", text: "Second." });
  const removed = await ask("DELETE", "kuvo/sessions/ses_1/queue/msg_w1");
  assert.deepEqual(removed.json.waiting.map(each => each.id), ["msg_w2"]);
  assert.equal((await ask("DELETE", "kuvo/sessions/ses_1/queue/msg_w1")).status, 404);
  assert.ok(!fs.existsSync(path.join(home, "run", "waiting", "msg_w1.json")), "its contents go with it");
  // Still at work (its stop not through yet): it gets it at once, the step stopped for it.
  const sent = await ask("POST", "kuvo/sessions/ses_1/queue/msg_w2/now");
  assert.deepEqual(sent.json, { paused: false, held: [] });
  assert.deepEqual(prompted.map(each => [each.id, each.delivery]), [["msg_w2", "steer"]]);
  assert.ok(asked.includes("ses_1 resume"));
});

test("what waits on the box outlives the box: one left as the queue went on goes once the box starts again", async () => {
  inboxes.ses_1 = [];
  await ask("POST", "kuvo/sessions/ses_1/stop");
  await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_w1", text: "Carry on." });
  // Resumed as the box stopped, before it went.
  const file = path.join(home, "run", "queues.json");
  const kept = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...kept, ses_1: { ...kept.ses_1, paused: false } }));
  await link.scanQueues({ ...target, pid: 40 });
  assert.deepEqual(prompted.map(each => each.id), ["msg_w1"]);
  assert.equal(link.queueOf("ses_1").waiting, undefined);
});

test("a run that fails after Resume sent what waited on the box pauses the queue again, the rest still waiting for Resume", async () => {
  inboxes.ses_1 = [];
  await ask("POST", "kuvo/sessions/ses_1/stop");
  await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_w1", text: "Check the build." });
  await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_w2", text: "Then deploy." });
  await ask("POST", "kuvo/sessions/ses_1/queue/resume");
  assert.deepEqual(prompted.map(each => each.id), ["msg_w1"]);
  // Its run fails (a rate limit): the next isn't run into the same error, and Resume shows.
  const b = box();
  b.hear("session.execution.started");
  b.hear("session.execution.failed");
  const after = await until(state => state.paused);
  assert.deepEqual(after.waiting.map(each => each.id), ["msg_w2"]);
  b.wait(5000);
  assert.deepEqual(prompted.map(each => each.id), ["msg_w1"]);
});

test("a conversation deleted while stopped takes what waited on the box with it", async () => {
  inboxes.ses_1 = [];
  await ask("POST", "kuvo/sessions/ses_1/stop");
  await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_w1", text: "Carry on.", files: [{ uri: "file:///tmp/a.txt", name: "a.txt" }] });
  box().hear("session.deleted");
  assert.deepEqual(link.queueOf("ses_1"), { paused: false, held: [] });
  assert.deepEqual(fs.readdirSync(path.join(home, "run", "waiting")), [], "nothing of it left on the box");
  assert.equal("ses_1" in link.readQueues(), false);
});

test("a conversation carried on in another session while stopped (a client moved it to the coding agents) stays stopped there, with what waited on the box", async () => {
  inboxes.ses_1 = [];
  await ask("POST", "kuvo/sessions/ses_1/stop");
  await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_w1", text: "[Letter] The build is green.", from: "Ada", words: "The build is green.", kept: true });
  // Its engine's session archived as carried on, as the client that moved it marks it.
  box().hear("session.metadata.updated", { metadata: { "kuvo.archived": true, "kuvo.carriedTo": "ses_2" } });
  const carried = link.queueOf("ses_2");
  assert.equal(carried.paused, true);
  assert.deepEqual(carried.waiting?.map(each => [each.from, each.text]), [["Ada", "The build is green."]]);
  assert.deepEqual(fs.readdirSync(path.join(home, "run", "waiting")), ["msg_w1.json"], "kept, whole, to go there");
  assert.equal("ses_1" in link.readQueues(), false);
  assert.deepEqual(prompted, []);
});

test("a conversation brought back after it was carried on keeps its own queue when its marks change later (pinned, say)", async () => {
  inboxes.ses_1 = [];
  await ask("POST", "kuvo/sessions/ses_1/stop");
  await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_w1", text: "[Letter] The build is green.", from: "Ada", words: "The build is green.", kept: true });
  // Brought back, then pinned: a client sends its metadata whole, the old carry's mark with it.
  box().hear("session.metadata.updated", { metadata: { "kuvo.archived": false, "kuvo.carriedTo": "ses_2" } });
  box().hear("session.metadata.updated", { metadata: { "kuvo.archived": false, "kuvo.pinned": true, "kuvo.carriedTo": "ses_2" } });
  const own = link.queueOf("ses_1");
  assert.equal(own.paused, true, "still stopped");
  assert.deepEqual(own.waiting?.map(each => [each.from, each.text]), [["Ada", "The build is green."]]);
  assert.equal("ses_2" in link.readQueues(), false, "nothing of it went to the session it was carried to before");
  assert.deepEqual(prompted, []);
});

test("a conversation carried on, brought back and archived again keeps its own queue, and the one it was carried to goes on", async () => {
  inboxes.ses_1 = [];
  // Carried on to ses_3 once (nothing waiting then).
  box().hear("session.metadata.updated", { metadata: { "kuvo.archived": true, "kuvo.carriedTo": "ses_3" } });
  // Brought back, stopped, a letter waits; then archived again, the old mark sent with it.
  box().hear("session.metadata.updated", { metadata: { "kuvo.archived": false, "kuvo.carriedTo": "ses_3" } });
  await ask("POST", "kuvo/sessions/ses_1/stop");
  await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_w1", text: "[Letter] The build is green.", from: "Ada", words: "The build is green.", kept: true });
  box().hear("session.metadata.updated", { metadata: { "kuvo.archived": true, "kuvo.carriedTo": "ses_3" } });
  assert.equal(link.queueOf("ses_3").paused, false, "the conversation it was carried to before isn't stopped");
  assert.deepEqual(link.queueOf("ses_3").waiting ?? [], []);
  assert.deepEqual(link.queueOf("ses_1").waiting?.map(each => each.from), ["Ada"], "its own waits with it");
  assert.deepEqual(prompted, []);
});

test("your own message waits shown as you wrote it, though what goes to the agent says more (its files' notes)", async () => {
  inboxes.ses_1 = [];
  await ask("POST", "kuvo/sessions/ses_1/stop");
  const whole = "Look at this.\n\n[Attached: /tmp/a.png]";
  await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_w1", text: whole, words: "Look at this." });
  assert.deepEqual((await ask("GET", "kuvo/sessions/ses_1/queue")).json.waiting.map(each => each.text), ["Look at this."]);
  await ask("POST", "kuvo/sessions/ses_1/queue/resume");
  assert.deepEqual(prompted.map(each => each.text), [whole]);
});

test("a coding agents' run still keeping its files as it ends doesn't leave the next message waiting: it goes once the bridge says the session's free", { timeout: 10_000 }, async () => {
  inboxes.ses_1 = [];
  await ask("POST", "kuvo/sessions/ses_1/stop");
  await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_w1", text: "Check the build." });
  await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_w2", text: "Then deploy." });
  await ask("POST", "kuvo/sessions/ses_1/queue/resume");
  assert.deepEqual(prompted.map(each => each.id), ["msg_w1"]);
  const b = box();
  b.hear("session.execution.started");
  // It ends, and the bridge still lists it at work while it keeps the files it changed (a big
  // folder: a while).
  running.add("ses_1");
  b.hear("session.execution.succeeded");
  await b.looked(1500);
  b.wait(60_000);
  for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(prompted.map(each => each.id), ["msg_w1"]);
  running.delete("ses_1");
  b.hear("session.idle");
  b.wait(1500);
  while (prompted.length < 2) await heard();
  assert.deepEqual(prompted.map(each => each.id), ["msg_w1", "msg_w2"]);
  assert.deepEqual(link.queueOf("ses_1").waiting, undefined);
});

test("Resume pressed after a Stop while the coding agents' run still keeps its files goes on once the session's free", { timeout: 10_000 }, async () => {
  inboxes.ses_1 = [{ id: "msg_q1", delivery: "queue" }, { id: "msg_q2", delivery: "queue" }];
  running.add("ses_1");
  await ask("POST", "kuvo/sessions/ses_1/stop");
  const b = box();
  b.hear("session.execution.interrupted");
  await b.looked(1500);
  const resumed = await ask("POST", "kuvo/sessions/ses_1/queue/resume");
  assert.equal(resumed.json.paused, false);
  b.wait(60_000);
  for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(!asked.some(each => each.endsWith(" steer")), "nothing goes while it's still at work");
  running.delete("ses_1");
  b.hear("session.idle");
  b.wait(1500);
  assert.deepEqual(await askedAfter(asked.length + 1).then(all => all.filter(each => each.endsWith(" steer"))), ["ses_1 msg_q1 steer"]);
  assert.equal(link.queueOf("ses_1").paused, false);
});

// Each step the box takes in turn: what it was asked once it's had time to act (a few turns of
// the event loop for each answer).
const settle = async () => { for (let turn = 0; turn < 50; turn++) await new Promise(resolve => setImmediate(resolve)); };

test("Resume pressed after a failed coding agents' run, while it still keeps its files, goes on once the session's free", { timeout: 10_000 }, async () => {
  inboxes.ses_1 = [{ id: "msg_q1", delivery: "queue" }];
  running.add("ses_1");
  const b = box();
  b.hear("session.execution.failed");
  await until(state => state.paused);
  await ask("POST", "kuvo/sessions/ses_1/queue/resume");
  await b.looked(1500);
  assert.ok(!asked.some(each => each.endsWith(" steer")), "nothing goes while it's still at work");
  running.delete("ses_1");
  b.hear("session.idle");
  b.wait(1500);
  assert.deepEqual((await askedAfter(1)).filter(each => each.endsWith(" steer")), ["ses_1 msg_q1 steer"]);
  b.wait(1500);
  await settle();
  assert.deepEqual(asked, ["ses_1 msg_q1 steer"], "once");
});

test("the coding agents' bridge saying a session's free right as a Stop ends it still holds and pauses its queue; Resume then sends the next one once", { timeout: 10_000 }, async () => {
  inboxes.ses_1 = [{ id: "msg_q1", delivery: "queue" }, { id: "msg_s1", delivery: "steer" }];
  const b = box();
  // A client's own interrupt (not the box's Stop): the bridge ends the run and is free at once.
  b.hear("session.execution.interrupted");
  b.hear("session.idle");
  b.wait(1500);
  assert.deepEqual(await until(state => state.paused), { paused: true, held: ["msg_s1"] });
  await settle();
  assert.deepEqual(asked, ["ses_1 msg_s1 queue"]);
  // Stopped and freed again, and Resume pressed straight after: what Stop held goes, once.
  b.hear("session.execution.interrupted");
  b.hear("session.idle");
  await ask("POST", "kuvo/sessions/ses_1/queue/resume");
  assert.deepEqual(asked.slice(1), ["ses_1 msg_s1 steer"]);
  running.add("ses_1");
  b.hear("session.execution.started");
  b.wait(1500);
  await settle();
  assert.deepEqual(asked.slice(1), ["ses_1 msg_s1 steer"], "nothing more: it's running again");
});

test("a coding agents' session at work as the box finds its bridge started anew (finishing a turn cut short) is held and paused once it's free, not run on", { timeout: 10_000 }, async () => {
  inboxes.ses_1 = [{ id: "msg_q1", delivery: "queue" }, { id: "msg_q2", delivery: "queue" }];
  running.add("ses_1");
  const found = new Map();
  const b = box(found);
  await link.scanQueues({ ...target, pid: 50 }, found);
  assert.deepEqual(link.queueOf("ses_1"), { paused: false, held: [] }, "left while it's at work");
  running.delete("ses_1");
  b.hear("session.idle");
  b.wait(1500);
  assert.equal((await until(state => state.paused)).paused, true);
  b.wait(1500);
  await settle();
  assert.ok(!asked.some(each => each.endsWith(" steer")), "nothing sent");
});

test("a coding agents' session the box finds at work that's free by the time it's looked at goes on, though its word that it's free came first", { timeout: 10_000 }, async () => {
  inboxes.ses_1 = [];
  await link.scanQueues({ ...target, pid: 52 });
  inboxes.ses_1 = [{ id: "msg_q1", delivery: "queue" }];
  latest.ses_1 = { id: "msg_i1", type: "idle", outcome: "succeeded" };
  running.add("ses_1");
  const found = new Map();
  const b = box(found);
  // The bridge frees it just as it says it's at work, and says so before the box has its answer.
  whenLooked = () => {
    running.delete("ses_1");
    b.hear("session.idle");
  };
  await link.scanQueues({ ...target, pid: 52 }, found);
  assert.deepEqual(asked, ["ses_1 msg_q1 steer"]);
  b.wait(1500);
  await settle();
  assert.deepEqual(asked, ["ses_1 msg_q1 steer"], "once");
});

test("the box's stream connecting again while a coding agents' run kept its files: once it's free, its queue goes on, unless that run failed", { timeout: 10_000 }, async () => {
  inboxes.ses_1 = [];
  await link.scanQueues({ ...target, pid: 51 });
  inboxes.ses_1 = [{ id: "msg_q1", delivery: "queue" }];
  inboxes.ses_2 = [{ id: "msg_q2", delivery: "queue" }];
  latest.ses_2 = { id: "msg_i2", type: "idle", outcome: "failed", error: { type: "provider", message: "Overloaded." } };
  running.add("ses_1");
  running.add("ses_2");
  const found = new Map();
  const b = box(found);
  // The same bridge (its stream dropped and came back), its runs' ends unheard.
  await link.scanQueues({ ...target, pid: 51 }, found);
  running.clear();
  b.hear("session.idle");
  b.hear("session.idle", {}, "ses_2");
  b.wait(1500);
  assert.deepEqual(await askedAfter(1), ["ses_1 msg_q1 steer"]);
  assert.equal((await until(state => state.paused, "ses_2")).paused, true, "not into the same error");
  b.wait(1500);
  await settle();
  assert.deepEqual(asked, ["ses_1 msg_q1 steer"]);
});

// #443: a box under heavy load, whose engine runs but answers late.
test("a message added while the engine is slow to answer goes once it answers, not refused as if the engine weren't running", async () => {
  inboxes.ses_1 = [];
  link.PLACE_TRIES.splice(0, Infinity, 100, 2_000);
  stalls = 1;
  const added = await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_q1", text: "After this, the docs." });
  assert.deepEqual([added.status, added.json.waits], [200, false], JSON.stringify(added.json));
  assert.deepEqual(prompted.map(each => each.id), ["msg_q1"]);
});

test("an engine that stays too busy to answer says it's busy, to try again, never that it isn't running", async () => {
  inboxes.ses_1 = [];
  link.PLACE_TRIES.splice(0, Infinity, 50, 100);
  stalls = 2;
  const added = await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_q1", text: "After this, the docs." });
  assert.equal(added.status, 504);
  assert.equal(added.json.busy, true);
  assert.doesNotMatch(added.json.message, /isn.t running/);
  assert.deepEqual(prompted, [], "nothing went: it can be asked again");
});

test("an engine whose record outlived it (nothing listens there) is said not to be running, at once, not busy", async () => {
  inboxes.ses_1 = [];
  const closed = http.createServer();
  await new Promise(resolve => closed.listen(0, "127.0.0.1", resolve));
  const port = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  const was = target.port;
  target.port = port;
  try {
    const added = await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_q1", text: "After this, the docs." });
    assert.deepEqual([added.status, added.json.message, added.json.busy], [503, "The engine isn't running.", undefined]);
  } finally {
    target.port = was;
  }
});

// A session's queue, carried on by its box (PROTOCOL.md, "The queue"), whichever client is
// connected or none: once a run ends, after a moment, the next message goes; a Stop (from any
// client), a failed run and a queue left when the engine started again pause it, holding what was
// for the next step ahead of the queue; Resume and Send Now go on. The real box code, on a clock the
// test moves; only the engine is a stand-in, keeping each session's inbox as the engine does.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/queue.test.js`.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-queue-")));
process.env.KUVO_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

// The engine: each session's inbox and whether it runs; what was asked of it, each time a test
// waits on it looking again.
let inboxes, running, asked, unsure = false, taken = new Set(), waiting = [], latest = {};
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
    else if (url.pathname === "/api/session/active") answer = unsure ? null : { data: Object.fromEntries([...running].map(id => [id, {}])) };
    else if (session && !rest && request.method === "GET") answer = inboxes[session] ? { data: { id: session } } : null;
    else if (rest === "/inbox") answer = { data: inboxes[session] ?? [] };
    // Its newest message (the queue only asks for the one).
    else if (rest === "/message") answer = { data: latest[session] ? [latest[session]] : [] };
    else if (rest?.startsWith("/inbox/") && request.method === "PATCH") {
      const item = (inboxes[session] ?? []).find(each => each.id === decodeURIComponent(rest.slice(7)));
      const { delivery } = JSON.parse(body);
      // Taken by the agent already: the engine has no such item.
      if (!item || taken.has(item.id)) return reply({ message: "Not in the inbox." }, 404);
      if (item) item.delivery = delivery;
      asked.push(`${session} ${item?.id} ${delivery}`);
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
after(() => { engine.closeAllConnections(); engine.close(); });
const target = { port: engine.address().port, password: "p", pid: 1 };
fs.mkdirSync(path.join(home, "run"), { recursive: true });
fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify(target));

beforeEach(() => {
  inboxes = {};
  running = new Set();
  asked = [];
  unsure = false;
  taken = new Set();
  latest = {};
  fs.rmSync(path.join(home, "run", "queues.json"), { force: true });
});

// What the engine was asked, once it's been asked `count` things.
async function askedAfter(count) {
  while (asked.length < count) await heard();
  return asked;
}

// The box watching the engine, on a clock the test moves.
function box() {
  let time = 0;
  let timers = [];
  const hear = link.queueWatcher(target, {
    schedule: (run, ms) => { const timer = { at: time + ms, run }; timers.push(timer); return timer; },
    cancel: timer => { timers = timers.filter(each => each !== timer); },
  });
  return {
    hear: (type, data = {}, session = "ses_1") => hear({ type, data: { sessionID: session, ...data } }),
    wait: ms => {
      time += ms;
      for (let due = timers.find(each => each.at <= time); due; due = timers.find(each => each.at <= time)) {
        timers = timers.filter(each => each !== due);
        due.run();
      }
    },
  };
}

// The box's routes, as a client asks them.
const handle = link.engineHandler(() => target, { name: "lab" }, () => { throw new Error("none"); });
async function ask(method, route) {
  let status = 0, text = "";
  for await (const part of handle({ method, path: route, headers: {}, body: Buffer.alloc(0) }, {}, undefined)) {
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
  latest.ses_1 = { id: "msg_a1", type: "assistant", content: [{ type: "text", text: "Done." }] };
  inboxes.ses_2 = [{ id: "msg_q2", delivery: "queue" }];
  inboxes.ses_3 = [{ id: "msg_q3", delivery: "queue" }];
  running.add("ses_3");
  // Stopped (from a client that couldn't reach the box), and failed.
  inboxes.ses_4 = [{ id: "msg_q4", delivery: "queue" }, { id: "msg_s4", delivery: "steer" }];
  latest.ses_4 = { id: "msg_a4", type: "assistant", content: [], error: { type: "aborted", message: "Stopped." } };
  inboxes.ses_5 = [{ id: "msg_q5", delivery: "queue" }];
  latest.ses_5 = { id: "msg_a5", type: "assistant", content: [], error: { type: "provider", message: "Overloaded." } };
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

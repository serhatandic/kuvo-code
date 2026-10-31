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
let inboxes, running, asked, prompted, unsure = false, taken = new Set(), waiting = [], latest = {};
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
after(() => { engine.closeAllConnections(); engine.close(); });
const target = { port: engine.address().port, password: "p", pid: 1 };
fs.mkdirSync(path.join(home, "run"), { recursive: true });
fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify(target));

beforeEach(() => {
  inboxes = {};
  running = new Set();
  asked = [];
  prompted = [];
  unsure = false;
  taken = new Set();
  latest = {};
  fs.rmSync(path.join(home, "run", "queues.json"), { force: true });
  fs.rmSync(path.join(home, "run", "waiting"), { recursive: true, force: true });
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

test("Undo puts one taken away from what waits back as it was: its whole words, who it's from, and how it was shown", async () => {
  inboxes.ses_1 = [];
  await ask("POST", "kuvo/sessions/ses_1/stop");
  await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_w1", text: "From Ada: the build is green.", from: "Ada" });
  await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_w2", text: "Second." });
  const { removed } = (await ask("DELETE", "kuvo/sessions/ses_1/queue/msg_w1")).json;
  assert.deepEqual(removed, { id: "msg_w1", text: "From Ada: the build is green.", delivery: "queue", from: "Ada", words: "From Ada: the build is green." });
  const back = await ask("POST", "kuvo/sessions/ses_1/queue/add", { ...removed, words: "the build is green.", kept: true });
  assert.equal(back.json.waits, true);
  assert.deepEqual(back.json.waiting.map(each => [each.id, each.from ?? null, each.text]), [["msg_w2", null, "Second."], ["msg_w1", "Ada", "the build is green."]]);
  assert.deepEqual(prompted, [], "nothing reached the engine");
  await ask("POST", "kuvo/sessions/ses_1/queue/msg_w1/now");
  assert.deepEqual(prompted.map(each => [each.id, each.text]), [["msg_w1", "From Ada: the build is green."]], "whole, as it would have gone");
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

test("your own message waits shown as you wrote it, though what goes to the agent says more (its files' notes)", async () => {
  inboxes.ses_1 = [];
  await ask("POST", "kuvo/sessions/ses_1/stop");
  const whole = "Look at this.\n\n[Attached: /tmp/a.png]";
  await ask("POST", "kuvo/sessions/ses_1/queue/add", { id: "msg_w1", text: whole, words: "Look at this." });
  assert.deepEqual((await ask("GET", "kuvo/sessions/ses_1/queue")).json.waiting.map(each => each.text), ["Look at this."]);
  await ask("POST", "kuvo/sessions/ses_1/queue/resume");
  assert.deepEqual(prompted.map(each => each.text), [whole]);
});

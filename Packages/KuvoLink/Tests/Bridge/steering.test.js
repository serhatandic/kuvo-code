// A message you send to an agent that waits on a long command (or a subagent) it started in the
// foreground is read at once: the box moves what it waits on to the background, as the engine's
// own Ctrl+B does, rather than leave your message until the command ends. Another agent's letter or
// the box's news never does: it's read as the command ends. Run with
// `node --test Packages/KuvoLink/Tests/Bridge/*.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { removeAtEnd } from "./at-end.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-steering-"));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

// The box following one engine's events, on a clock the test moves.
function box() {
  let time = 0;
  let timers = [];
  const backgrounded = [];
  const hear = link.steering(session => backgrounded.push(session), {
    now: () => time,
    schedule: (run, ms) => { const timer = { at: time + ms, run }; timers.push(timer); return timer; },
    cancel: timer => { timers = timers.filter(each => each !== timer); },
  });
  return {
    backgrounded,
    hear: (type, data) => hear({ type, data: { sessionID: "ses_1", ...data } }),
    // The clock moves on `ms`, and what's due by then runs, what that sets for then too.
    wait: ms => {
      time += ms;
      for (let due = timers.find(each => each.at <= time); due; due = timers.find(each => each.at <= time)) {
        timers = timers.filter(each => each !== due);
        due.run();
      }
    },
  };
}

const command = (b, id, input = { command: "npm test" }) => {
  b.hear("session.tool.input.started", { id, name: "shell" });
  b.hear("session.tool.called", { id, input });
};
const yours = (b, inboxID, delivery = "steer") => b.hear("session.inbox.enqueued", { inboxID, item: { type: "user", delivery, payload: { text: "and also…" } } });

test("your message while a long command runs is read at once: the command goes on in the background", () => {
  const b = box();
  command(b, "call_1", { command: "sleep 90" });
  b.wait(10_000);
  yours(b, "msg_1");
  b.wait(0);
  assert.deepEqual(b.backgrounded, ["ses_1"]);
});

// Another agent's letter (send_message, a lead's word) and the box's news of its sessions, each
// sent to steer as the box sends them.
const letter = (b, inboxID) => b.hear("session.inbox.enqueued", { inboxID, item: { type: "user", delivery: "steer", payload: { text: "[Message from Kuvo Foreman · ses_lead] (To answer, use send_message to ses_lead.)\n\nHow are the tests going?" } } });
const news = (b, inboxID) => b.hear("session.inbox.enqueued", { inboxID, item: { type: "user", delivery: "steer", payload: { text: '[Session asks] "Fix the build" (address ses_child) asks to run a command.', metadata: { kuvo: { note: { from: "Its sessions", line: "“Fix the build” asks" } } } } } });

test("another agent's letter, or a session's news, while a long command runs waits for the command: nothing goes to the background", () => {
  const b = box();
  command(b, "call_1", { command: "bun test" });
  b.wait(10_000);
  letter(b, "msg_1");
  news(b, "msg_2");
  b.wait(30_000);
  assert.deepEqual(b.backgrounded, [], "the tests run on in the foreground");
  // Sent now from the queue, it doesn't either.
  b.hear("session.inbox.delivery.changed", { inboxID: "msg_1", delivery: "steer" });
  b.wait(10_000);
  assert.deepEqual(b.backgrounded, []);
  // The command ends, and the agent reads them as it takes its next step.
  b.hear("session.tool.success", { id: "call_1" });
  b.hear("session.inbox.delivered", { inboxID: "msg_1" });
  b.hear("session.inbox.delivered", { inboxID: "msg_2" });
  b.wait(30_000);
  assert.deepEqual(b.backgrounded, []);

  // Your own message among them still goes at once.
  const yoursToo = box();
  command(yoursToo, "call_2", { command: "bun test" });
  letter(yoursToo, "msg_3");
  yoursToo.wait(5_000);
  assert.deepEqual(yoursToo.backgrounded, []);
  yours(yoursToo, "msg_4");
  yoursToo.wait(0);
  assert.deepEqual(yoursToo.backgrounded, ["ses_1"]);
});

test("a command that has only just started gets a moment to end on its own", () => {
  const b = box();
  command(b, "call_1");
  b.wait(1_000);
  yours(b, "msg_1");
  b.wait(1_000);
  assert.deepEqual(b.backgrounded, [], "not before it has run a moment");
  b.wait(1_000);
  assert.deepEqual(b.backgrounded, ["ses_1"]);

  // One that ends within its moment: your message is read as it ends, nothing moved.
  const quick = box();
  command(quick, "call_2");
  yours(quick, "msg_2");
  quick.wait(500);
  quick.hear("session.tool.success", { id: "call_2" });
  quick.hear("session.inbox.delivered", { inboxID: "msg_2" });
  quick.wait(10_000);
  assert.deepEqual(quick.backgrounded, []);
});

test("a message sent before the agent starts a long command is read once the command has run a moment", () => {
  const b = box();
  b.hear("session.execution.started", {});
  yours(b, "msg_1");
  command(b, "call_1");
  b.wait(3_000);
  assert.deepEqual(b.backgrounded, ["ses_1"]);
});

test("a subagent it waits on goes on in the background too", () => {
  const b = box();
  b.hear("session.tool.input.started", { id: "call_1", name: "subagent" });
  b.hear("session.tool.called", { id: "call_1", input: { agent: "explore", prompt: "find the tests" } });
  b.wait(5_000);
  yours(b, "msg_1");
  b.wait(0);
  assert.deepEqual(b.backgrounded, ["ses_1"]);
});

test("a message queued for after the turn, or the engine's own note, waits as before", () => {
  const b = box();
  command(b, "call_1");
  b.wait(10_000);
  yours(b, "msg_1", "queue");
  b.hear("session.inbox.enqueued", { inboxID: "syn_1", item: { type: "synthetic", delivery: "steer", payload: { text: "The command finished." } } });
  b.wait(10_000);
  assert.deepEqual(b.backgrounded, []);
  // Sent now from the queue (Send Now): read at once.
  b.hear("session.inbox.delivery.changed", { inboxID: "msg_1", delivery: "steer" });
  b.wait(0);
  assert.deepEqual(b.backgrounded, ["ses_1"]);
});

test("each command gets its moment: one that ended doesn't time the next", () => {
  const b = box();
  command(b, "call_1");
  b.wait(2_000);
  command(b, "call_2");
  yours(b, "msg_1");
  b.hear("session.tool.success", { id: "call_1" });
  b.wait(1_000);
  assert.deepEqual(b.backgrounded, [], "call_2 has run 1 second");
  b.wait(2_000);
  assert.deepEqual(b.backgrounded, ["ses_1"]);
});

test("still waiting behind it after that (the command was asking you first), it's tried again", () => {
  const b = box();
  command(b, "call_1");
  b.wait(5_000);
  yours(b, "msg_1");
  b.wait(0);
  assert.deepEqual(b.backgrounded, ["ses_1"]);
  b.wait(3_000);
  assert.deepEqual(b.backgrounded, ["ses_1", "ses_1"]);
  // Moved now: it ends at once, and your message is read.
  b.hear("session.tool.success", { id: "call_1" });
  b.hear("session.inbox.delivered", { inboxID: "msg_1" });
  b.wait(30_000);
  assert.deepEqual(b.backgrounded, ["ses_1", "ses_1"]);
});

test("nothing moves for a command already in the background, one that ended, or a message taken back", () => {
  const b = box();
  command(b, "call_1", { command: "npm run dev", background: true });
  b.wait(10_000);
  yours(b, "msg_1");
  b.wait(10_000);
  assert.deepEqual(b.backgrounded, []);

  const ended = box();
  command(ended, "call_2");
  ended.hear("session.tool.failed", { id: "call_2" });
  yours(ended, "msg_2");
  ended.wait(10_000);
  assert.deepEqual(ended.backgrounded, []);

  const taken = box();
  command(taken, "call_3");
  yours(taken, "msg_3");
  taken.hear("session.inbox.cancelled", { inboxID: "msg_3" });
  taken.wait(10_000);
  assert.deepEqual(taken.backgrounded, []);

  // Stopped: what waited is gone with the turn.
  const stopped = box();
  command(stopped, "call_4");
  yours(stopped, "msg_4");
  stopped.hear("session.execution.interrupted", {});
  stopped.wait(10_000);
  assert.deepEqual(stopped.backgrounded, []);
});

test("stopped, it moves nothing more", () => {
  let time = 0, timers = [];
  const backgrounded = [];
  const stop = new AbortController();
  const hear = link.steering(session => backgrounded.push(session), {
    signal: stop.signal, now: () => time,
    schedule: (run, ms) => { const timer = { at: time + ms, run }; timers.push(timer); return timer; },
    cancel: timer => { timers = timers.filter(each => each !== timer); },
  });
  hear({ type: "session.tool.input.started", data: { sessionID: "ses_1", id: "call_1", name: "shell" } });
  hear({ type: "session.tool.called", data: { sessionID: "ses_1", id: "call_1", input: { command: "sleep 90" } } });
  hear({ type: "session.inbox.enqueued", data: { sessionID: "ses_1", inboxID: "msg_1", item: { type: "user", delivery: "steer" } } });
  stop.abort();
  time = 60_000;
  for (const timer of timers) timer.run();
  assert.deepEqual(backgrounded, []);
});

test("once the engine's events stop (it restarted, the stream dropped), what it was waiting to move is let go", async () => {
  let posts = 0, firstPost;
  const posted = new Promise(resolve => { firstPost = resolve; });
  const followers = [];
  let reconnected;
  const again = new Promise(resolve => { reconnected = resolve; });
  const server = http.createServer((request, response) => {
    if (request.url === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": hello\n\n");
      followers.push(response);
      if (followers.length === 2) reconnected(posts);
      return;
    }
    if (request.method === "POST") { posts += 1; firstPost(); }
    response.writeHead(204);
    response.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const send = (type, data) => followers[0].write(`data: ${JSON.stringify({ type, data: { sessionID: "ses_long", ...data } })}\n\n`);
  const stop = new AbortController();
  try {
    link.watchEvents(() => ({ port: server.address().port, password: "pw" }), () => true, stop.signal, () => {}, { bots: true, notices: false, steers: true, steerAfter: 20 });
    while (!followers.length) await new Promise(resolve => setImmediate(resolve));
    send("session.tool.input.started", { id: "call_1", name: "shell" });
    send("session.tool.called", { id: "call_1", input: { command: "sleep 90" } });
    send("session.inbox.enqueued", { inboxID: "msg_1", item: { type: "user", delivery: "steer", payload: { text: "Still there?" } } });
    await posted;
    followers[0].end();
    // Back once it has paused (2 seconds): what the old stream can't settle was let go as it
    // ended, not asked for again and again meanwhile (100 times, every 20 ms).
    assert.ok(await again < 10);
  } finally {
    stop.abort();
    server.closeAllConnections();
    server.close();
  }
});

test("every box does it as it follows its engine, with the Mac closed too: the engine is asked to background the session's tools", async () => {
  let asked;
  const backgrounded = new Promise(resolve => { asked = resolve; });
  const followers = [];
  let followed;
  const following = new Promise(resolve => { followed = resolve; });
  const server = http.createServer((request, response) => {
    if (request.url === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": hello\n\n");
      followers.push(response);
      return followed();
    }
    if (request.method === "POST" && request.url.endsWith("/background")) asked({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(204);
    response.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const send = (type, data) => { for (const follower of followers) follower.write(`data: ${JSON.stringify({ type, data: { sessionID: "ses_long", ...data } })}\n\n`); };
  const stop = new AbortController();
  try {
    link.watchEvents(() => ({ port: server.address().port, password: "pw" }), () => true, stop.signal, () => {}, { bots: true, notices: false, steers: true, steerAfter: 0 });
    await following;
    send("session.tool.input.started", { id: "call_1", name: "shell" });
    send("session.tool.called", { id: "call_1", input: { command: "sleep 90" } });
    send("session.inbox.enqueued", { inboxID: "msg_1", item: { type: "user", delivery: "steer", payload: { text: "What's 17 + 25?" } } });
    assert.deepEqual(await backgrounded, { url: "/api/session/ses_long/background", authorization: `Basic ${Buffer.from("opencode:pw").toString("base64")}` });
  } finally {
    stop.abort();
    server.closeAllConnections();
    server.close();
  }
});

test("following its engine, a box asks nothing for another agent's letter while a command runs, and still does for yours", async () => {
  const posted = [];
  let enough;
  const done = new Promise(resolve => { enough = resolve; });
  const followers = [];
  let followed;
  const following = new Promise(resolve => { followed = resolve; });
  const server = http.createServer((request, response) => {
    if (request.url === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": hello\n\n");
      followers.push(response);
      return followed();
    }
    if (request.method === "POST" && request.url.endsWith("/background")) {
      posted.push(request.url);
      if (posted.filter(url => url.includes("ses_yours")).length >= 3) enough();
    }
    response.writeHead(204);
    response.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const send = (session, type, data) => { for (const follower of followers) follower.write(`data: ${JSON.stringify({ type, data: { sessionID: session, ...data } })}\n\n`); };
  const stop = new AbortController();
  try {
    link.watchEvents(() => ({ port: server.address().port, password: "pw" }), () => true, stop.signal, () => {}, { bots: true, notices: false, steers: true, steerAfter: 0 });
    await following;
    for (const session of ["ses_mail", "ses_yours"]) {
      send(session, "session.tool.input.started", { id: "call_1", name: "shell" });
      send(session, "session.tool.called", { id: "call_1", input: { command: "bun test" } });
    }
    send("ses_mail", "session.inbox.enqueued", { inboxID: "msg_1", item: { type: "user", delivery: "steer", payload: { text: "[Message from Kuvo Foreman · ses_lead] (To answer, use send_message to ses_lead.)\n\nHow are the tests going?" } } });
    send("ses_yours", "session.inbox.enqueued", { inboxID: "msg_2", item: { type: "user", delivery: "steer", payload: { text: "How are the tests going?" } } });
    // Yours, asked for again and again while it waits (every 0 ms here); the letter, never.
    await done;
    assert.deepEqual(posted.filter(url => !url.includes("ses_yours")), []);
  } finally {
    stop.abort();
    server.closeAllConnections();
    server.close();
  }
});

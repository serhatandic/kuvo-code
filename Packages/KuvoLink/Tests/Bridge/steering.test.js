// A message you send to an agent that waits on a long command (or a subagent) it started in the
// foreground is read at once: the box moves what it waits on to the background, as the engine's
// own Ctrl+B does, rather than leave your message until the command ends. Run with
// `node --test Packages/KuvoLink/Tests/Bridge/*.test.js`.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-steering-"));
process.env.KUVO_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
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
    wait: ms => {
      time += ms;
      for (const timer of timers.filter(each => each.at <= time)) {
        timers = timers.filter(each => each !== timer);
        timer.run();
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

test("a message queued for after the turn, a wake-up or an agent's letter waits as before", () => {
  const b = box();
  command(b, "call_1");
  b.wait(10_000);
  yours(b, "msg_1", "queue");
  b.hear("session.inbox.enqueued", { inboxID: "syn_1", item: { type: "synthetic", delivery: "steer", payload: { text: "Wake up: check the build" } } });
  b.wait(10_000);
  assert.deepEqual(b.backgrounded, []);
  // Sent now from the queue (Send Now): read at once.
  b.hear("session.inbox.delivery.changed", { inboxID: "msg_1", delivery: "steer" });
  b.wait(0);
  assert.deepEqual(b.backgrounded, ["ses_1"]);
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

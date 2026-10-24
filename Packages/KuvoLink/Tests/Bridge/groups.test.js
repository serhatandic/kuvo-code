// A machine's group chats through its bridge (PROTOCOL.md, `kuvo/groups`): answered as a Mac answers
// its own, from the coding agents' bridge there, which runs them. Run with
// `node --test Packages/KuvoLink/Tests/Bridge/*.test.js`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-groups-"));
process.env.KUVO_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

// Two bots in their folders, as the app keeps them on a machine.
for (const [id, name] of [["bot_pal", "Pal"], ["bot_lb", "Lokum Builder"]]) {
  const folder = path.join(home, "bots", id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "bot.json"), JSON.stringify({ kuvo: 1, id, name, job: "Helps", look: { color: "mint", shape: "round", face: "calm" }, created: "2026-10-21T09:00:00Z", updated: "2026-10-21T09:00:00Z" }));
  fs.writeFileSync(path.join(folder, "session"), "ses_" + id);
  fs.writeFileSync(path.join(folder, "directory"), path.join(folder, "workspace"));
}

async function ask(handle, method, p, { body, abort } = {}) {
  const parts = [];
  for await (const part of handle({ method, path: p, headers: {}, body: body ? Buffer.from(body) : Buffer.alloc(0) }, {}, abort?.signal)) {
    parts.push(part);
    // A stream: its first line is enough.
    if (abort && parts.some(each => each.body)) {
      abort.abort();
      break;
    }
  }
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  let json;
  try { json = JSON.parse(text.split("\n")[0]); } catch {}
  return { status: parts[0].head.status, headers: parts[0].head.headers, json, text };
}

// The coding agents' bridge, running one chat here and one moving here, as its runner answers.
async function fakeRunner() {
  const asked = [];
  const group = { id: "grp_box0000001", name: "k", members: ["bot_pal", "bot_lb"], seats: {}, heard: {}, created: "2026-10-21T09:00:00Z", viewed: "2026-10-22T07:00:00Z",
                  meeting: { next: "2026-10-23T06:00:00Z", every: "1d", topic: "Standup", at: 540 } };
  const messages = [
    { id: "gm_1", text: "Ship it?", time: "2026-10-22T07:59:00Z", kind: "message", named: "<named-agents>\n- &Scout (ses_x): a bot\n</named-agents>" },
    { id: "gm_2", author: "bot_pal", text: "Yes.", time: "2026-10-22T08:00:00Z", kind: "message", steps: [{ type: "tool", id: "call_1", name: "webfetch", state: { status: "completed", input: {}, content: [] } }] },
    { id: "gm_3", author: "bot_pal", text: "We ship.", time: "2026-10-22T08:01:00Z", kind: "wrapUp", tasks: [{ id: "gt_1", bot: "bot_lb", task: "Tag it", state: "working", started: "2026-10-22T08:02:00Z" }] },
    { id: "gm_4", text: "Lokum Builder couldn’t answer: away", time: "2026-10-22T08:03:00Z", kind: "note" },
  ];
  const state = { speaking: "bot_lb", discussing: true, paused: false };
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      asked.push({ method: request.method, url: request.url, auth: request.headers.authorization, body: body ? JSON.parse(body) : undefined });
      const send = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.url === "/api/kuvo/groups") {
        return send(200, { version: 1, data: [
          { group, status: "active", state, last: messages[3], said: messages[2], fromBot: messages[2] },
          { group: { ...group, id: "grp_moving0001", name: "Moving" }, status: "held", state: { discussing: false, paused: false } },
        ] });
      }
      if (request.url === "/api/kuvo/groups/grp_box0000001" && request.method === "GET") return send(200, { data: { group, status: "active", state, messages } });
      if (request.url === "/api/kuvo/groups/grp_box0000001/undo") return send(200, { data: { text: "Ship it?" } });
      if (request.url.startsWith("/api/kuvo/groups/grp_moving0001/")) return send(409, { message: "That chat is moving." });
      if (request.url.startsWith("/api/kuvo/groups/grp_box0000001")) return send(200, { data: {} });
      send(404, { message: "No such chat." });
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { asked, state, port: server.address().port, close: () => { server.closeAllConnections(); server.close(); } };
}

test("a machine's group chats, as a Mac lists and sends its own", async t => {
  const runner = await fakeRunner();
  t.after(runner.close);
  const named = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "kuvo-agents"], { stdio: "ignore" });
  t.after(() => named.kill());
  const handle = link.engineHandler(() => ({ port: 1, password: "engine", version: "2.0.32" }), { name: "box" }, () => ({ pid: named.pid, port: runner.port, password: "agents" }));

  // The list: one moving here isn't in it yet; times in seconds; the last thing said, not a note,
  // without its steps; unread, as a bot spoke after you last looked.
  const list = await ask(handle, "GET", "kuvo/groups");
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.groups.map(each => each.id), ["grp_box0000001"]);
  const chat = list.json.groups[0];
  assert.deepEqual(chat.members.map(member => [member.id, member.name, member.session, member.agents]), [["bot_pal", "Pal", "ses_bot_pal", false], ["bot_lb", "Lokum Builder", "ses_bot_lb", false]]);
  assert.deepEqual([chat.speaking, chat.discussing, chat.paused, chat.unread], ["bot_lb", true, false, true]);
  assert.equal(chat.last.id, "gm_3");
  assert.equal(chat.last.time, Date.parse("2026-10-22T08:01:00Z") / 1000);
  assert.equal(chat.last.tasks[0].started, Date.parse("2026-10-22T08:02:00Z") / 1000);
  assert.equal(chat.meeting.next, Date.parse("2026-10-23T06:00:00Z") / 1000);
  assert.equal(runner.asked[0].auth, `Basic ${Buffer.from("opencode:agents").toString("base64")}`);

  // One chat, followed: its messages with each bot's steps, never the machine's record of who you named.
  const followed = await ask(handle, "GET", "kuvo/groups/grp_box0000001/events", { abort: new AbortController() });
  assert.equal(followed.headers["content-type"], "application/x-ndjson");
  assert.deepEqual(followed.json.messages.map(message => message.id), ["gm_1", "gm_2", "gm_3", "gm_4"]);
  assert.equal(followed.json.messages[0].named, undefined);
  assert.equal(followed.json.messages[1].steps.length, 1);
  assert.equal((await ask(handle, "GET", "kuvo/groups/grp_moving0001")).status, 404, "one moving here isn't there yet");

  // What a phone does in it, sent to the runner.
  assert.equal((await ask(handle, "POST", "kuvo/groups/grp_box0000001", { body: '{"text":"Go"}' })).status, 200);
  assert.equal((await ask(handle, "POST", "kuvo/groups/grp_box0000001/stop", { body: "{}" })).status, 200);
  assert.equal((await ask(handle, "POST", "kuvo/groups/grp_box0000001/viewed", { body: "{}" })).status, 200);
  assert.deepEqual((await ask(handle, "POST", "kuvo/groups/grp_box0000001/undo", { body: '{"message":"gm_1"}' })).json, { text: "Ship it?" });
  assert.equal((await ask(handle, "POST", "kuvo/groups/grp_box0000001/start", { body: '{"message":"gm_3"}' })).status, 200);
  assert.deepEqual(runner.asked.slice(-5).map(each => `${each.method} ${each.url}`), [
    "POST /api/kuvo/groups/grp_box0000001/send", "POST /api/kuvo/groups/grp_box0000001/stop", "PATCH /api/kuvo/groups/grp_box0000001",
    "POST /api/kuvo/groups/grp_box0000001/undo", "POST /api/kuvo/groups/grp_box0000001/start-work",
  ]);
  assert.deepEqual(runner.asked.at(-5).body, { text: "Go" });
  assert.deepEqual(runner.asked.at(-1).body, { wrapUp: "gm_3" });
  assert.equal((await ask(handle, "POST", "kuvo/groups/../x")).status, 403);
  // One moving: what you'd do waits, as on a Mac.
  assert.equal((await ask(handle, "POST", "kuvo/groups/grp_moving0001/undo", { body: '{"message":"gm_1"}' })).status, 409);
  assert.equal((await ask(handle, "POST", "kuvo/groups/grp_moving0001", { body: '{"text":"Go"}' })).status, 409);
});

test("a phone deletes a machine's group chat as Delete Group Chat does, with the Mac closed", async t => {
  // The runner's chats, as it keeps them: one here, one moving here (which it won't delete).
  const chats = new Map([["grp_box0000001", "active"], ["grp_moving0001", "held"]]);
  const asked = [];
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      asked.push(`${request.method} ${request.url}`);
      const send = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      const id = request.url.split("/")[4];
      if (request.url === "/api/kuvo/groups") {
        return send(200, { data: [...chats].map(([each, status]) => ({ group: { id: each, name: each, members: [], seats: {}, heard: {}, created: "2026-10-21T09:00:00Z" }, status, state: {} })) });
      }
      if (request.method === "DELETE" && chats.get(id) === "held") return send(409, { message: "That chat is moving." });
      if (request.method === "DELETE" && chats.delete(id)) return send(200, {});
      send(404, { message: "No such chat." });
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const named = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "kuvo-agents"], { stdio: "ignore" });
  t.after(() => named.kill());
  const handle = link.engineHandler(() => ({ port: 1, password: "engine", version: "2.0.32" }), { name: "box" }, () => ({ pid: named.pid, port: server.address().port, password: "agents" }));

  const deleted = await ask(handle, "DELETE", "kuvo/groups/grp_box0000001");
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.json, {});
  assert.ok(asked.includes("DELETE /api/kuvo/groups/grp_box0000001"));
  assert.deepEqual((await ask(handle, "GET", "kuvo/groups")).json.groups, [], "gone from the list");
  // Gone already: as good as deleted.
  const again = await ask(handle, "DELETE", "kuvo/groups/grp_box0000001");
  assert.equal(again.status, 200);
  assert.deepEqual(again.json, {});
  // One moving here stays, and says why.
  const moving = await ask(handle, "DELETE", "kuvo/groups/grp_moving0001");
  assert.equal(moving.status, 409);
  assert.equal(moving.json.message, "That chat is moving. Try again once it’s there.");
  assert.equal(chats.get("grp_moving0001"), "held");
});

test("a chat's next line leaves out its messages when only who's talking or what they do changed", async t => {
  const runner = await fakeRunner();
  t.after(runner.close);
  const named = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "kuvo-agents"], { stdio: "ignore" });
  t.after(() => named.kill());
  const handle = link.engineHandler(() => ({ port: 1, password: "engine", version: "2.0.32" }), { name: "box" }, () => ({ pid: named.pid, port: runner.port, password: "agents" }));
  const abort = new AbortController();
  const lines = [];
  for await (const part of handle({ method: "GET", path: "kuvo/groups/grp_box0000001/events", headers: {}, body: Buffer.alloc(0) }, {}, abort.signal)) {
    if (!part.body) continue;
    lines.push(JSON.parse(part.body.toString()));
    if (lines.length === 1) runner.state.activity = [{ kind: "thinking", text: "Checking the tag" }];
    if (lines.length === 2) break;
  }
  abort.abort();
  assert.equal(lines[0].messages.length, 4);
  assert.equal(lines[1].messages, undefined, "the phone keeps the ones it has");
  assert.deepEqual(lines[1].activity, [{ kind: "thinking", text: "Checking the tag" }]);
  assert.equal(lines[1].speaking, "bot_lb");
});

test("a bridge there but not answering now is asked again, not taken as having no group chats", async t => {
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(500, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const named = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "kuvo-agents"], { stdio: "ignore" });
  t.after(() => named.kill());
  const handle = link.engineHandler(() => ({ port: 1, password: "engine", version: "2.0.32" }), { name: "box" }, () => ({ pid: named.pid, port: server.address().port, password: "agents" }));
  for (const route of ["kuvo/groups", "kuvo/groups/events", "kuvo/groups/grp_box0000001/events"]) {
    assert.equal((await ask(handle, "GET", route)).status, 503, route);
  }
  // What a phone does there, too.
  assert.equal((await ask(handle, "POST", "kuvo/groups/grp_box0000001", { body: '{"text":"Go"}' })).status, 503);
  const deleting = await ask(handle, "DELETE", "kuvo/groups/grp_box0000001");
  assert.equal(deleting.status, 503);
  assert.ok(deleting.json.message);
  assert.equal((await ask(handle, "POST", "kuvo/groups/grp_box0000001/undo", { body: '{"message":"gm_1"}' })).status, 503);
});

test("without the coding agents' bridge, a machine's group chats say why", async () => {
  const handle = link.engineHandler(() => ({ port: 1, password: "engine", version: "2.0.32" }), { name: "box" }, () => null);
  const answer = await ask(handle, "GET", "kuvo/groups");
  assert.equal(answer.status, 503);
  const deleting = await ask(handle, "DELETE", "kuvo/groups/grp_box0000001");
  assert.equal(deleting.status, 503);
  assert.ok(deleting.json.message);
});

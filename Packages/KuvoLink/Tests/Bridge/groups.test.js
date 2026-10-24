// A machine's group chats through its bridge (PROTOCOL.md, `kuvo/groups`): passed on to the coding
// agents' bridge there, which runs them and answers in the shapes a client takes, with every rule
// of what can be (Agents' groups-link tests hold those). Run with
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

async function ask(handle, method, p, { body, lines } = {}) {
  const abort = new AbortController();
  const parts = [];
  for await (const part of handle({ method, path: p, headers: {}, body: body ? Buffer.from(body) : Buffer.alloc(0) }, {}, abort.signal)) {
    parts.push(part);
    // A followed one: as many lines as asked for, as they come.
    if (lines && Buffer.concat(parts.filter(each => each.body).map(each => each.body)).toString().split("\n").filter(Boolean).length >= lines) {
      abort.abort();
      break;
    }
  }
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  let json;
  try { json = JSON.parse(text.split("\n")[0]); } catch {}
  return { status: parts[0].head.status, headers: parts[0].head.headers, json, text };
}

// The coding agents' bridge, answering a client's group chat routes as it would.
async function fakeBridge(answer) {
  const asked = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      asked.push({ method: request.method, url: request.url, auth: request.headers.authorization, body });
      answer(request, response);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { asked, port: server.address().port, close: () => { server.closeAllConnections(); server.close(); } };
}

const send = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

function bridgeProcess(t) {
  const named = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "kuvo-agents"], { stdio: "ignore" });
  t.after(() => named.kill());
  return named;
}

test("a machine's group chats are the bridge's answers, as it gives them, to every route a client has", async t => {
  let release;
  const bridge = await fakeBridge((request, response) => {
    if (request.url === "/api/kuvo/link/groups/grp_box0000001/events") {
      // A line now, the next when the chat changes: each passed on as it comes.
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write(JSON.stringify({ messages: [], discussing: false }) + "\n");
      release = () => response.end(JSON.stringify({ discussing: true }) + "\n");
      return;
    }
    if (request.url === "/api/kuvo/link/groups/grp_moving0001") return send(response, 409, { message: "That chat is moving. Try again once it’s there." });
    if (request.url === "/api/kuvo/link/groups" && request.method === "POST") return send(response, 201, { group: { id: "grp_new0000001" } });
    send(response, 200, { groups: [{ id: "grp_box0000001" }] });
  });
  t.after(bridge.close);
  const named = bridgeProcess(t);
  const handle = link.engineHandler(() => ({ port: 1, password: "engine", version: "2.0.32" }), { name: "box" }, () => ({ pid: named.pid, port: bridge.port, password: "agents" }));

  const list = await ask(handle, "GET", "kuvo/groups");
  assert.deepEqual([list.status, list.json], [200, { groups: [{ id: "grp_box0000001" }] }]);
  assert.equal(bridge.asked[0].auth, `Basic ${Buffer.from("opencode:agents").toString("base64")}`);

  const followed = ask(handle, "GET", "kuvo/groups/grp_box0000001/events", { lines: 2 });
  await new Promise(resolve => { const look = () => (release ? resolve() : setImmediate(look)); look(); });
  release();
  const lines = (await followed).text.split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(lines, [{ messages: [], discussing: false }, { discussing: true }]);
  assert.equal((await followed).headers["content-type"], "application/x-ndjson");

  const made = await ask(handle, "POST", "kuvo/groups", { body: '{"name":"Standup","members":["bot_a","bot_b"]}' });
  assert.deepEqual([made.status, made.json], [201, { group: { id: "grp_new0000001" } }]);
  assert.equal((await ask(handle, "PATCH", "kuvo/groups/grp_moving0001", { body: '{"name":"Ghost"}' })).status, 409);
  for (const [method, route, body] of [["GET", "kuvo/groups/joinable"], ["GET", "kuvo/groups/events"], ["POST", "kuvo/groups/grp_box0000001", '{"text":"Go"}'],
    ["POST", "kuvo/groups/grp_box0000001/undo", '{"message":"gm_1"}'], ["POST", "kuvo/groups/grp_box0000001/start", '{"message":"gm_3"}'], ["DELETE", "kuvo/groups/grp_box0000001"]]) {
    assert.equal((await ask(handle, method, route, { body, lines: route.endsWith("events") ? 1 : undefined })).status, 200, route);
  }
  assert.deepEqual(bridge.asked.map(each => `${each.method} ${each.url}`), [
    "GET /api/kuvo/link/groups", "GET /api/kuvo/link/groups/grp_box0000001/events", "POST /api/kuvo/link/groups", "PATCH /api/kuvo/link/groups/grp_moving0001",
    "GET /api/kuvo/link/groups/joinable", "GET /api/kuvo/link/groups/events", "POST /api/kuvo/link/groups/grp_box0000001",
    "POST /api/kuvo/link/groups/grp_box0000001/undo", "POST /api/kuvo/link/groups/grp_box0000001/start", "DELETE /api/kuvo/link/groups/grp_box0000001",
  ]);
  assert.equal(bridge.asked[2].body, '{"name":"Standup","members":["bot_a","bot_b"]}', "what a client sends, as it sent it");
  assert.equal((await ask(handle, "POST", "kuvo/groups/../x")).status, 403);
});

test("a bridge there but not answering now is asked again, not taken as having no group chats", async t => {
  const bridge = await fakeBridge((request, response) => send(response, 500, {}));
  t.after(bridge.close);
  const named = bridgeProcess(t);
  const handle = link.engineHandler(() => ({ port: 1, password: "engine", version: "2.0.32" }), { name: "box" }, () => ({ pid: named.pid, port: bridge.port, password: "agents" }));
  for (const route of ["kuvo/groups", "kuvo/groups/events", "kuvo/groups/grp_box0000001/events"]) {
    const answer = await ask(handle, "GET", route);
    assert.equal(answer.status, 503, route);
    assert.ok(answer.json.message);
  }
  assert.equal((await ask(handle, "POST", "kuvo/groups/grp_box0000001", { body: '{"text":"Go"}' })).status, 503);
  // Nothing listening where it was: the same.
  bridge.close();
  assert.equal((await ask(handle, "DELETE", "kuvo/groups/grp_box0000001")).status, 503);
});

test("without the coding agents' bridge, a machine's group chats say why", async () => {
  const handle = link.engineHandler(() => ({ port: 1, password: "engine", version: "2.0.32" }), { name: "box" }, () => null);
  const answer = await ask(handle, "GET", "kuvo/groups");
  assert.equal(answer.status, 503);
  assert.ok(answer.json.message);
  const deleting = await ask(handle, "DELETE", "kuvo/groups/grp_box0000001");
  assert.equal(deleting.status, 503);
  assert.ok(deleting.json.message);
});

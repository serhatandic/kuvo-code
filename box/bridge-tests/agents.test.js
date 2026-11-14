// A machine's coding agents through its bridge (PROTOCOL.md, `kuvo/agents/api/…`): passed to the
// agents' bridge beside its engine, as a Mac passes them to its own. Run with
// `node --test box/bridge-tests/*.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { removeAtEnd } from "./at-end.js";
import { runningAs } from "./running-as.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-agents-"));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const link = await import("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js");

async function ask(handle, method, p, { headers = {}, body } = {}) {
  const parts = [];
  for await (const part of handle({ method, path: p, headers, body: body ? Buffer.from(body) : Buffer.alloc(0) }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  let json;
  try { json = JSON.parse(text); } catch {}
  return { status: parts[0].head.status, headers: parts[0].head.headers, json, text };
}

// The agents' bridge on a free port: answers with what it was asked.
async function fakeBridge() {
  const asked = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      asked.push({ method: request.method, url: request.url, auth: request.headers.authorization, directory: request.headers["x-opencode-directory"], body });
      response.writeHead(200, { "content-type": "application/json", "set-cookie": "no=thanks" });
      response.end(JSON.stringify({ url: request.url }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { asked, port: server.address().port, close: () => { server.closeAllConnections(); server.close(); } };
}

test("the coding agents' bridge gets what a phone asks, with its password; where the engine is, never", async t => {
  const bridge = await fakeBridge();
  t.after(bridge.close);
  // A process its record names, whose command line says it's the agents' bridge (on Linux, the
  // bridge checks), and its command line is its own before its pid is handed over.
  const agents = await runningAs("kuvo-agents", t);
  let record = { pid: agents, port: bridge.port, password: "agents" };
  const handle = link.engineHandler(() => ({ port: 1, password: "engine", version: "2.0.32" }), { name: "my-server" }, () => record);

  const info = await ask(handle, "GET", "kuvo/info");
  assert.equal(info.json.agents, true, "kuvo/info says they're up");

  const prompt = await ask(handle, "POST", "kuvo/agents/api/session/ses_1/prompt", { headers: { "X-Opencode-Directory": "/home/me/p", Authorization: "Basic forged" }, body: '{"text":"hi"}' });
  assert.equal(prompt.status, 200);
  assert.equal(prompt.headers["set-cookie"], undefined);
  const sent = bridge.asked.at(-1);
  assert.equal(sent.url, "/api/session/ses_1/prompt");
  assert.equal(sent.auth, `Basic ${Buffer.from("opencode:agents").toString("base64")}`);
  assert.equal(sent.directory, "/home/me/p");
  // A message from the phone says so, at its end, as one to the engine does, and keeps its parts.
  assert.equal(sent.body, JSON.stringify({ text: `hi\n\n${link.FROM_PHONE}`, metadata: { kuvo: { parts: { words: "hi", phone: true } } } }));
  assert.equal((await ask(handle, "PUT", "kuvo/agents/api/kuvo/auto", { body: "{}" })).status, 200);

  // An agent's update too: the phone is yours.
  assert.equal((await ask(handle, "POST", "kuvo/agents/api/integration/claude-code/update", { body: "{}" })).status, 200);

  const before = bridge.asked.length;
  for (const [method, p] of [["PUT", "kuvo/agents/api/kuvo/engine"], ["PUT", "kuvo/agents/api/kuvo/%65ngine"], ["POST", "kuvo/agents/api/kuvo/groups/grp_x/release"],
    // A space at the end, which fetch would drop on the way.
    ["PUT", "kuvo/agents/api/kuvo/engine "]]) {
    assert.equal((await ask(handle, method, p)).status, 403, p);
  }
  assert.equal(bridge.asked.length, before, "none of those reached it");

  // Not running: kuvo/info says so, and its routes answer 503.
  record = null;
  assert.equal((await ask(handle, "GET", "kuvo/info")).json.agents, false);
  const down = await ask(handle, "GET", "kuvo/agents/api/session");
  assert.equal(down.status, 503);
  assert.match(down.json.message, /coding agents/);
  // One left by a bridge that stopped (its process gone) counts as not running.
  record = { pid: 2 ** 22 + 12345, port: bridge.port, password: "agents" };
  assert.equal((await ask(handle, "GET", "kuvo/agents/api/session")).status, 503);
});

test("a phone using the machine is noted, and keeps its engine up for a week after", async () => {
  assert.equal(link.phoneSeenLately(path.join(home, "run", "never-written")), false, "no phone yet");
  const handle = link.engineHandler(() => ({ port: 1, password: "engine" }), {}, () => null);
  await ask(handle, "GET", "kuvo/info");
  assert.equal(link.phoneSeenLately(), true);
  const stat = fs.statSync(link.SEEN_FILE);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(link.phoneSeenLately(link.SEEN_FILE, stat.mtimeMs + link.KEEP_FOR + 1), false, "a week on, not any more");
});

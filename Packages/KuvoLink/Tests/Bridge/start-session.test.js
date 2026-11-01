// A session an agent starts on a machine (its start_session tool, `kuvo-browser.js`, which its box
// answers through `kuvo-link.js box route`) is marked as started by the conversation it works for
// (`kuvo.startedBy`), so every client shows it under that one: the conversation itself, a
// subagent's, and an engine run of a coding agent's (Auto's) all name the conversation. The real
// tool and box script; only the engine is a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/start-session.test.js`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-start-session-")));
removeAtEnd(home);
const tool = fileURLToPath(new URL("../../../../KuvoCode/Resources/kuvo-browser.js", import.meta.url));
fs.mkdirSync(path.join(home, "bin"), { recursive: true });
fs.copyFileSync(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url), path.join(home, "bin", "kuvo-link.js"));

// The engine: a conversation, a subagent it started, an engine run it works through, and what
// each new session was marked with.
const marked = new Map();
let made = 0;
// Whether the engine takes a new session's marks (it may refuse one, as a busy engine does).
let marking = true;
const engine = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const one = request.url.match(/^\/api\/session\/([^/?]+)$/);
    if (one && request.method === "GET") {
      const id = decodeURIComponent(one[1]);
      if (id === "ses_lead") return reply({ data: { id, location: { directory: home } } });
      if (id === "ses_helper") return reply({ data: { id, parentID: "ses_lead", location: { directory: home } } });
      if (id === "ses_run") return reply({ data: { id, location: { directory: home }, metadata: { kuvo: { engineFor: "ses_lead" } } } });
      return reply({ message: "No such session." }, 404);
    }
    if (request.method === "POST" && request.url === "/api/session") return reply({ data: { id: `ses_new${++made}` } });
    if (one && request.method === "PATCH") {
      if (!marking) return reply({ message: "Busy." }, 503);
      marked.set(decodeURIComponent(one[1]), JSON.parse(body).metadata);
    }
    reply({});
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
fs.mkdirSync(path.join(home, "run"), { recursive: true });
fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify({ port: engine.address().port, password: "p", version: "0.0.0" }));

// The tool, as the engine starts it, and its calls, as the engine makes them.
const mcp = spawn(process.execPath, [tool, "mcp"], { env: { ...process.env, KUVO_HOME: home }, stdio: ["pipe", "pipe", "ignore"] });
atEnd(() => mcp.kill());
const answers = new Map();
let buffer = "";
mcp.stdout.on("data", chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    answers.get(message.id)?.(message.result);
  }
});
let next = 1;
function call(name, args, session) {
  const id = next++;
  return new Promise(resolve => {
    answers.set(id, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, _meta: { "ai.opencode/sessionID": session } } }) + "\n");
  });
}
mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }) + "\n");

test("a session started from a conversation, its subagent or its engine run is marked as the conversation's", async () => {
  for (const caller of ["ses_lead", "ses_helper", "ses_run"]) {
    const result = await call("start_session", { task: "Review the docs.", title: "Review docs" }, caller);
    assert.equal(result.isError ?? false, false, result.content?.[0]?.text);
    const started = result.content[0].text.match(/\(address (ses_\w+)\)/)?.[1];
    assert.ok(started, result.content[0].text);
    assert.deepEqual(marked.get(started), { kuvo: { startedBy: "ses_lead" } }, `started from ${caller}`);
  }
});

test("an agent is promised it'll hear of a session it starts only once that session is marked to tell it: from no conversation here, or one the engine couldn't mark, it's told to write to it instead", async t => {
  t.after(() => { marking = true; });
  const woken = /You'll be woken when it finishes/;
  const marked = await call("start_session", { task: "Port it.", title: "Port", wake: "finished" }, "ses_lead");
  assert.match(marked.content[0].text, woken, "marked: it'll hear");
  const outside = await call("start_session", { task: "Port it.", title: "Port", wake: "finished", folder: home }, "ses_elsewhere");
  assert.equal(outside.isError ?? false, false, outside.content?.[0]?.text);
  assert.doesNotMatch(outside.content[0].text, woken, "nothing here would tell it");
  assert.match(outside.content[0].text, /Write to it with send_message/);
  marking = false;
  const unmarked = await call("start_session", { task: "Port it.", title: "Port", wake: "finished" }, "ses_lead");
  assert.equal(unmarked.isError ?? false, false, unmarked.content?.[0]?.text);
  assert.doesNotMatch(unmarked.content[0].text, woken, "its mark didn't take");
});

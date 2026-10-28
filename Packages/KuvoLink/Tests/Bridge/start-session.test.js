// A session an agent starts on a machine (its start_session tool, `kuvo-browser.js`) is marked as
// started by the conversation it works for (`kuvo.startedBy`), so every client shows it under that
// one: the conversation itself, a subagent's, and an engine run of a coding agent's (Auto's) all
// name the conversation. Only the engine is a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/start-session.test.js`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-start-session-")));
after(() => fs.rmSync(home, { recursive: true, force: true }));
const tool = fileURLToPath(new URL("../../../../KuvoCode/Resources/kuvo-browser.js", import.meta.url));

// The engine: a conversation, a subagent it started, an engine run it works through, and what
// each new session was marked with.
const marked = new Map();
let made = 0;
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
    if (one && request.method === "PATCH") marked.set(decodeURIComponent(one[1]), JSON.parse(body).metadata);
    reply({});
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
after(() => { engine.closeAllConnections(); engine.close(); });
fs.mkdirSync(path.join(home, "run"), { recursive: true });
fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify({ port: engine.address().port, password: "p", version: "0.0.0" }));

// The tool, as the engine starts it, and its calls, as the engine makes them.
const mcp = spawn(process.execPath, [tool, "mcp"], { env: { ...process.env, KUVO_HOME: home }, stdio: ["pipe", "pipe", "ignore"] });
after(() => mcp.kill());
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

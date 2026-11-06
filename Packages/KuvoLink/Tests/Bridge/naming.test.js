// "&" in a message from a phone, on every box (PROTOCOL.md, "Messages in a session", `kuvo/named`):
// the agents it names, told at its end, as the Mac's AgentReferences words it. Both read the same
// cases (Vectors/routes/names/agent-naming.json).
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/naming.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-naming-"));
process.env.KUVO_HOME = home;
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
// (Once the list a message started working out is written: it would write it again in a folder
// just removed.)
removeAtEnd(home);
atEnd(async () => {
  await link.ownRefreshed();
});
const vector = JSON.parse(fs.readFileSync(new URL("../../Vectors/routes/names/agent-naming.json", import.meta.url), "utf8"));

for (const each of vector.cases) {
  test(each.about, () => {
    assert.equal(link.nameAgents(each.message, { excluding: each.excluding ?? null, here: each.here ?? null, agents: vector.agents }), each.expected);
  });
}

test("a box passes a phone's message on with who it names told, as everyone's listed there, and that it's from the phone", async t => {
  // The engine, which takes the message.
  const got = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => body += chunk);
    request.on("end", () => {
      if (request.url.startsWith("/api/session?")) return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [] }));
      got.push({ url: request.url, body });
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  // Everyone, as this box (a machine, "lab") lists them.
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  fs.writeFileSync(path.join(home, "run", "agents.json"), JSON.stringify({ machine: "lab", agents: [
    { session: "ses_scout", name: "Scout", kind: "bot", machine: "lab", about: "Watches the build" },
    { session: "ses_mac", name: "Release notes", kind: "session" },
  ] }));
  const handle = link.engineHandler(() => ({ port: server.address().port, password: "pw" }));
  const parts = [];
  for await (const part of handle({ method: "POST", path: "api/session/ses_here/prompt", headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ id: "msg_1", text: "Ask &Scout and &release notes" })) }, {}, undefined)) parts.push(part);
  assert.equal(parts[0].head.status, 200);
  const text = JSON.parse(got.at(-1).body).text;
  // The block's heading, as the cases have it.
  const heading = vector.cases[0].expected.split("\n")[3];
  assert.equal(text.split("\n\n<from-phone>")[0], "Ask &Scout and &release notes\n\n<named-agents>\n" + heading
    + "\n- &Scout (ses_scout): bot, here: Watches the build\n- &Release notes (ses_mac): session, on the Mac\n</named-agents>");
  assert.ok(text.endsWith(link.FROM_PHONE));
});

test("a phone's message to a coding agent's conversation, through their bridge, has who it names told too", async t => {
  const got = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => body += chunk);
    request.on("end", () => {
      got.push({ url: request.url, body });
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  // The coding agents' bridge, as it runs (its process says what it is).
  const bridge = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)", "kuvo-agents"], { stdio: "ignore" });
  t.after(() => bridge.kill());
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  fs.writeFileSync(path.join(home, "run", "agents.json"), JSON.stringify({ machine: null, agents: [{ session: "ses_scout", name: "Scout", kind: "bot" }] }));
  const handle = link.engineHandler(() => ({ port: 9, password: "pw" }), {}, () => ({ port: server.address().port, password: "pw", pid: bridge.pid }));
  const parts = [];
  for await (const part of handle({ method: "POST", path: "kuvo/agents/api/session/ses_claude/prompt", headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ text: "Ask &Scout" })) }, {}, undefined)) parts.push(part);
  assert.equal(parts[0].head.status, 200);
  const text = JSON.parse(got.at(-1).body).text;
  assert.match(text, /^Ask &Scout\n\n<named-agents>\n[^\n]+\n- &Scout \(ses_scout\): bot, on the Mac\n<\/named-agents>\n\n<from-phone>/);
});

// (Its time limit is under the ten seconds a box waits for an engine's list: one that waited on it,
// rather than naming from the list as it is, runs out.)
test("a phone's message is named at once from the list as it is; one naming someone it doesn't have yet waits a moment for it", { timeout: 5000 }, async t => {
  // The engine: its conversations, or (`hang`) no answer at all for now.
  const engine = { sessions: [], hang: false, got: [] };
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => body += chunk);
    request.on("end", () => {
      if (request.url.startsWith("/api/session?")) {
        if (engine.hang) return;
        return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: engine.sessions }));
      }
      engine.got.push(JSON.parse(body).text);
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  // A machine's box, with its link (it lists its own agents for its peers).
  link.writeLink({ key: link.newKey().toString("base64url"), secret: "c2VjcmV0", relay: "ws://127.0.0.1:9", id: "lab", phones: [] });
  fs.writeFileSync(path.join(home, "run", "agents.json"), JSON.stringify({ machine: "lab", agents: [{ session: "ses_scout", name: "Scout", kind: "bot", machine: "lab" }] }));
  const handle = link.engineHandler(() => ({ port: server.address().port, password: "pw" }));
  const send = async words => {
    for await (const _ of handle({ method: "POST", path: "api/session/ses_here/prompt", headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ text: words })) }, {}, undefined)) {}
    return engine.got.at(-1);
  };
  // Made a moment ago, not listed yet: worked out again, then named.
  engine.sessions = [{ id: "ses_new", title: "Newbie", time: { updated: 2 } }];
  assert.match(await send("Ask &Newbie"), /- &Newbie \(ses_new\): session, here/);
  // Listed already: named at once, whatever the engine is doing (it doesn't answer now).
  engine.hang = true;
  assert.match(await send("Ask &Newbie again"), /- &Newbie \(ses_new\): session, here/);
});

// A name that starts with one listed isn't it: "&Miranda" made a moment ago, with "Mira" listed.
test("a phone's message naming someone whose name starts with a listed one's waits for them too", { timeout: 5000 }, async t => {
  // (Not the one the test before left working out, against its engine.)
  await link.ownRefreshed();
  const engine = { sessions: [], got: [] };
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => body += chunk);
    request.on("end", () => {
      if (request.url.startsWith("/api/session?")) return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: engine.sessions }));
      engine.got.push(JSON.parse(body).text);
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  link.writeLink({ key: link.newKey().toString("base64url"), secret: "c2VjcmV0", relay: "ws://127.0.0.1:9", id: "lab", phones: [] });
  fs.writeFileSync(path.join(home, "run", "agents.json"), JSON.stringify({ machine: "lab", agents: [{ session: "ses_mira", name: "Mira", kind: "session", machine: "lab" }] }));
  engine.sessions = [{ id: "ses_mira", title: "Mira", time: { updated: 1 } }, { id: "ses_miranda", title: "Miranda", time: { updated: 2 } }];
  const handle = link.engineHandler(() => ({ port: server.address().port, password: "pw" }));
  for await (const _ of handle({ method: "POST", path: "api/session/ses_here/prompt", headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ text: "Ask &Miranda" })) }, {}, undefined)) {}
  assert.match(engine.got.at(-1), /- &Miranda \(ses_miranda\): session, here/);
});

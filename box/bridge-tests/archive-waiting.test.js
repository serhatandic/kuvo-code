// A conversation archived while it waits on you (a permission, a question, its subagent's too)
// stops its run on its box, from a phone (its metadata through the box) and from a Mac (its wake-ups
// held by archiving), as a bot's Stop and Archive has it: nothing waits out of sight for an answer.
// One that waits on nothing goes on working. The engine is a stand-in.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-archive-"));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

// The engine: ses_perm1 waits on a permission, ses_form1's subagent on a question, ses_busy1 on
// nothing, all of them at work. What's stopped is noted.
const stopped = [];
const metadata = {};
const engine = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const reply = (value) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const url = new URL(request.url, "http://engine");
    const session = /^\/api\/session\/([^/]+)/.exec(url.pathname)?.[1];
    if (url.pathname === "/api/session") {
      // A project's, as Remove Project reads them: ses_perm1 and ses_busy1 work in `home`.
      if (url.searchParams.get("directory") === home) return reply({ data: ["ses_perm1", "ses_busy1"].map(id => ({ id, location: { directory: home }, metadata: metadata[id] ?? {} })) });
      const parent = url.searchParams.get("parentID");
      return reply({ data: parent === "ses_form1" ? [{ id: "ses_formsub", parentID: "ses_form1" }] : [] });
    }
    if (url.pathname.endsWith("/interrupt")) {
      stopped.push(session);
      return reply({ data: true });
    }
    if (url.pathname.endsWith("/permission")) return reply({ data: session === "ses_perm1" ? [{ id: "per_1", sessionID: session, action: "shell", resources: ["git push"] }] : [] });
    if (url.pathname.endsWith("/form")) return reply({ data: session === "ses_formsub" ? [{ id: "frm_1", sessionID: session, fields: [{ key: "db", type: "string", title: "Which database?" }] }] : [] });
    if (url.pathname.endsWith("/inbox")) return reply({ data: [] });
    // At work, as a real engine lists them: each that waits on you (what it asks holds its turn) and the one working.
    if (url.pathname === "/api/session/active") return reply({ data: Object.fromEntries(["ses_perm1", "ses_form1", "ses_formsub", "ses_busy1"].map(id => [id, { type: "running" }])) });
    if (request.method === "PATCH") metadata[session] = { ...metadata[session], ...JSON.parse(body).metadata };
    reply({ data: { id: session, location: { directory: home }, metadata: metadata[session] ?? {} } });
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
const handle = link.engineHandler(() => ({ pid: process.pid, port: engine.address().port, password: "pw", version: "2.2.0" }), { name: "lab" }, () => null);

async function ask(method, p, body) {
  const parts = [];
  for await (const part of handle({ method, path: p, headers: {}, body: Buffer.from(body ? JSON.stringify(body) : "") }, {}, undefined)) parts.push(part);
  return parts[0].head.status;
}

test("archived from a phone while it waits on you, its run stops; one that waits on nothing goes on", async () => {
  stopped.length = 0;
  assert.equal(await ask("PATCH", "api/session/ses_perm1", { metadata: { "kuvo.archived": true } }), 200);
  assert.deepEqual(stopped, ["ses_perm1"], "a permission it waits on");
  assert.equal(await ask("PATCH", "api/session/ses_form1", { metadata: { "kuvo.archived": true } }), 200);
  assert.deepEqual(stopped, ["ses_perm1", "ses_form1", "ses_formsub"], "its subagent's question: the subagent too, which may work on in the background");
  assert.equal(await ask("PATCH", "api/session/ses_busy1", { metadata: { "kuvo.archived": true } }), 200);
  // Brought back, or pinned while archived: nothing stops.
  assert.equal(await ask("PATCH", "api/session/ses_perm1", { metadata: { "kuvo.archived": false } }), 200);
  assert.equal(await ask("PATCH", "api/session/ses_form1", { metadata: { "kuvo.archived": true, "kuvo.pinned": true } }), 200);
  assert.deepEqual(stopped, ["ses_perm1", "ses_form1", "ses_formsub"]);
});

test("archived on a Mac while it waits on you (its wake-ups held by archiving), its run stops too", async () => {
  stopped.length = 0;
  // Brought back on a phone just now: a Mac that hasn't heard yet says it's archived, and nothing stops.
  metadata.ses_perm1 = { "kuvo.archived": false };
  assert.equal(await ask("POST", "kuvo/wakes/ses_perm1/pause", { archived: true }), 200);
  assert.deepEqual(stopped, [], "brought back since: it isn't stopped");
  // The Mac's Archive, which its engine took first.
  metadata.ses_perm1 = { "kuvo.archived": true };
  metadata.ses_busy1 = { "kuvo.archived": true };
  assert.equal(await ask("POST", "kuvo/wakes/ses_perm1/pause", { archived: true }), 200);
  assert.deepEqual(stopped, ["ses_perm1"]);
  assert.equal(await ask("POST", "kuvo/wakes/ses_busy1/pause", { archived: true }), 200);
  assert.equal(await ask("POST", "kuvo/wakes/ses_perm1/pause", { archived: false }), 200);
  assert.equal(await ask("POST", "kuvo/wakes/ses_perm1/pause", { paused: true }), 200);
  // A first wake-up made for one archived before: held, not stopped (you may be at work in it).
  assert.equal(await ask("POST", "kuvo/wakes/ses_perm1/pause", { archived: true, stop: false }), 200);
  assert.deepEqual(stopped, ["ses_perm1"], "only archiving stops it");
});

test("Remove Project on its box, with no Mac about, stops its sessions that wait on you", async () => {
  stopped.length = 0;
  for (const id of ["ses_perm1", "ses_busy1"]) metadata[id] = {};
  assert.equal(await ask("PUT", `kuvo/projects?directory=${encodeURIComponent(home)}`, { name: "Home" }), 200);
  assert.equal(await ask("DELETE", `kuvo/projects?directory=${encodeURIComponent(home)}`), 200);
  assert.equal(metadata.ses_perm1["kuvo.archived"], true);
  assert.deepEqual(stopped, ["ses_perm1"]);
});

// Refresh Models (PROTOCOL.md, `kuvo/accounts/<provider>/refresh`): a provider's models asked of
// again on a box, without restarting its engine, from Settings › Accounts on a Mac or a phone. The
// engine reads an account's models (GitHub Copilot's) as it opens a folder, so the box closes the
// folders it has open, for each to open afresh as it's next used: at once where nothing's going on,
// and only once its work is done where something is (a run, a terminal, a command, a question for
// you), which closing would cut. What providers need from the engine is learned again from the list
// as it is now. The engine is a stand-in that answers as the real one does;
// `compatibility-live.test.js` does it on the real one.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/models-refresh.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-models-refresh-"));
process.env.KUVO_HOME = home;
removeAtEnd(home);
fs.mkdirSync(path.join(home, "run"), { recursive: true });
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

const OWN = "/w/engine";

// An engine with a Copilot account whose models are `account` (what Copilot gives it now), and
// folders open, each with the list it read as it opened and what's going on there.
async function engineWith(account, folders) {
  const engine = {
    pid: 4242,
    account,
    // Each open folder: the models it read as it opened, and what's going on there.
    open: new Map([[OWN, {}], ...Object.entries(folders)].map(([folder, going]) => [folder, { models: [...account], ...going }])),
    active: {},
    closed: [],
    followers: [],
    awaiting: [],
    closing: [],
  };
  engine.say = type => { for (const follower of engine.followers) follower.write(`data: ${JSON.stringify({ type, data: {} })}\n\n`); };
  engine.nextFollower = () => new Promise(resolve => engine.awaiting.push(resolve));
  engine.nextClose = () => new Promise(resolve => engine.closing.push(resolve));
  // A folder used: opened afresh if it was closed, reading the account's models as they are now.
  const use = folder => {
    if (!engine.open.has(folder)) engine.open.set(folder, { models: [...engine.account] });
    return engine.open.get(folder);
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    const send = (status, body) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const header = request.headers["x-opencode-directory"];
    const folder = header ? decodeURIComponent(header) : OWN;
    if (url.pathname === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": hello\n\n");
      engine.followers.push(response);
      for (const resolve of engine.awaiting.splice(0)) resolve();
      return;
    }
    if (url.pathname === "/api/debug/location" && request.method === "GET") return send(200, [...engine.open.keys()].map(directory => ({ directory })));
    if (url.pathname === "/api/debug/location" && request.method === "DELETE") {
      const closed = url.searchParams.get("location[directory]");
      engine.open.delete(closed);
      engine.closed.push(closed);
      for (const resolve of engine.closing.splice(0)) resolve(closed);
      return response.writeHead(204).end();
    }
    if (url.pathname === "/api/integration/github-copilot") return send(200, { data: { id: "github-copilot", connections: [{ id: "cred_copilot", method: "oauth" }] } });
    if (url.pathname.startsWith("/api/integration/")) return send(404, { message: "Integration not found" });
    if (url.pathname === "/api/session/active") return send(200, { data: Object.fromEntries(Object.keys(engine.active).map(id => [id, { type: "running" }])) });
    if (url.pathname.startsWith("/api/session/")) {
      const id = decodeURIComponent(url.pathname.split("/").pop());
      return engine.active[id] ? send(200, { data: { id, location: { directory: engine.active[id] } } }) : send(404, {});
    }
    const there = use(folder);
    if (url.pathname === "/api/model") return send(200, { location: { directory: folder }, data: there.models.map(id => ({ providerID: "github-copilot", id, family: id.replace(/-[\d.]+$/, "") })) });
    if (url.pathname === "/api/form") return send(200, { data: there.forms ?? [] });
    if (url.pathname === "/api/permission/request") return send(200, { data: there.permissions ?? [] });
    if (url.pathname === "/api/pty") return send(200, { data: there.terminal ? [{ id: "pty_1", status: there.terminal }] : [] });
    if (url.pathname === "/api/shell") return send(200, { data: there.command ? [{ id: "sh_1", status: there.command }] : [] });
    send(404, {});
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  atEnd(() => { server.closeAllConnections(); server.close(); });
  engine.source = { pid: engine.pid, port: server.address().port, password: "pw" };
  return engine;
}

const asker = engine => {
  const handle = link.engineHandler(() => engine.source);
  return async (method, route) => {
    const parts = [];
    for await (const part of handle({ method, path: route, headers: {}, body: Buffer.alloc(0) }, {}, undefined)) parts.push(part);
    const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
    let json;
    try { json = JSON.parse(text); } catch {}
    return { status: parts[0].head.status, json };
  };
};

// The models the engine reads from the box's own settings file, by name.
function engineReads() {
  let text;
  try { text = fs.readFileSync(path.join(home, "config", "opencode", "opencode.jsonc"), "utf8"); } catch { return []; }
  return Object.keys(JSON.parse(text.split("\n").filter(line => !line.startsWith("//")).join("\n")).providers?.["github-copilot"]?.models ?? {}).sort();
}

test("Refresh Models opens the engine's folders afresh where nothing's going on, and each one at work once its work is done; what the account has now is learned", async t => {
  const engine = await engineWith(["claude-opus-5.6"], {
    "/w/quiet": {},
    "/w/terminal": { terminal: "running" },
    "/w/command": { command: "running", terminal: "exited" },
    "/w/run": {},
    "/w/asks": { forms: [{ id: "frm_1" }] },
    "/w/permission": { permissions: [{ id: "per_1" }] },
  });
  engine.active.ses_1 = "/w/run";
  fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify(engine.source));
  const stop = new AbortController();
  t.after(() => stop.abort());
  const followed = engine.nextFollower();
  link.watchBox({ signal: stop.signal });
  await followed;
  const ask = asker(engine);

  // Copilot gives the account another model: the engine doesn't know until it reads its list again.
  engine.account = ["claude-opus-5.6", "claude-sonnet-5.6"];
  const answer = await ask("POST", "kuvo/accounts/github-copilot/refresh");
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.json.waiting.sort(), ["/w/asks", "/w/command", "/w/permission", "/w/run", "/w/terminal"]);
  // Nothing at work was cut.
  assert.deepEqual(engine.closed.sort(), [OWN, "/w/quiet"].sort());
  // The engine's own folder, which the model pickers read, has it; and the box learned it.
  assert.deepEqual(engine.open.get(OWN).models, ["claude-opus-5.6", "claude-sonnet-5.6"]);
  assert.deepEqual(engineReads(), ["claude-opus-5.6", "claude-sonnet-5.6"]);
  assert.deepEqual(engine.open.get("/w/terminal").models, ["claude-opus-5.6"]);

  // Its terminal closed: that folder goes now, the rest stay.
  let closed = engine.nextClose();
  engine.open.get("/w/terminal").terminal = "exited";
  engine.say("pty.exited");
  assert.equal(await closed, "/w/terminal");
  // A run's end; a question answered; a permission answered; a command done.
  closed = engine.nextClose();
  delete engine.active.ses_1;
  engine.say("session.execution.succeeded");
  assert.equal(await closed, "/w/run");
  closed = engine.nextClose();
  engine.open.get("/w/asks").forms = [];
  engine.say("form.replied");
  assert.equal(await closed, "/w/asks");
  closed = engine.nextClose();
  engine.open.get("/w/permission").permissions = [];
  engine.say("permission.replied");
  assert.equal(await closed, "/w/permission");
  closed = engine.nextClose();
  engine.open.get("/w/command").command = "exited";
  engine.say("shell.exited");
  assert.equal(await closed, "/w/command");
  // (Its look under way, done.)
  await link.settleDueModels(engine.source);
  stop.abort();
  // Each opens afresh as it's next used, with the account's models as they are now.
  assert.deepEqual(engine.closed.sort(), [OWN, "/w/asks", "/w/command", "/w/permission", "/w/quiet", "/w/run", "/w/terminal"].sort());
  assert.equal(fs.existsSync(path.join(home, "run", "models-due.json")), false);
});

test("folders left at work by a refresh aren't closed on an engine started since, which opened them afresh anyway", async () => {
  const engine = await engineWith(["claude-opus-5.6"], { "/w/terminal": { terminal: "running" } });
  const answer = await asker(engine)("POST", "kuvo/accounts/github-copilot/refresh");
  assert.deepEqual(answer.json.waiting, ["/w/terminal"]);
  // Restarted (another process), its terminal gone with it; the box looks as it finds it.
  engine.source.pid = 4343;
  engine.open.get("/w/terminal").terminal = "exited";
  await link.settleDueModels(engine.source);
  assert.deepEqual(engine.closed, [OWN]);
  assert.equal(fs.existsSync(path.join(home, "run", "models-due.json")), false);
});

test("Refresh Models for a provider the engine doesn't have, or with the engine down, says so; nothing is closed", async () => {
  const engine = await engineWith(["claude-opus-5.6"], { "/w/quiet": {} });
  const ask = asker(engine);
  const unknown = await ask("POST", "kuvo/accounts/no-such-provider/refresh");
  assert.equal(unknown.status, 404);
  assert.equal((await ask("GET", "kuvo/accounts/github-copilot/refresh")).status, 405);
  assert.deepEqual(engine.closed, []);
  const down = link.engineHandler(() => { throw new Error("no engine"); });
  const parts = [];
  for await (const part of down({ method: "POST", path: "kuvo/accounts/github-copilot/refresh", headers: {}, body: Buffer.alloc(0) }, {}, undefined)) parts.push(part);
  assert.equal(parts[0].head.status, 503);
  const gone = link.engineHandler(() => ({ port: 1, password: "pw" }));
  const unreachable = [];
  for await (const part of gone({ method: "POST", path: "kuvo/accounts/github-copilot/refresh", headers: {}, body: Buffer.alloc(0) }, {}, undefined)) unreachable.push(part);
  assert.equal(unreachable[0].head.status, 503);
  assert.match(JSON.parse(Buffer.concat(unreachable.filter(part => part.body).map(part => part.body)).toString()).message, /isn't answering/);
});

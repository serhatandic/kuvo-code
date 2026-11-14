// Refresh Models (PROTOCOL.md, `kuvo/accounts/<provider>/refresh`): a provider's models asked of
// again on a box, without restarting its engine, from Settings › Accounts on a Mac or a phone. The
// engine (opencode 2.2.6) reads GitLab Duo's models as each folder opens, so the box closes the
// folders it has open, for each to open afresh as it's next used: at once where nothing's going on,
// and only once its work is done where something is (a run, a terminal, a command, a question for
// you), which closing would cut. GitHub Copilot's it keeps for the whole engine, read again only once
// it has no folder open: the box closes every folder when nothing's going on in any, and otherwise
// closes none and says when they come by themselves. What providers need from the engine is learned
// again from the list as it is now. The engine is a stand-in that answers as the real one does;
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

// An engine with an account of `kind` (GitLab Duo's, or GitHub Copilot's) whose models are `account`
// (what it gives it now), and folders open, each with what's going on there: GitLab's list each
// folder's own, read as it opened; Copilot's the whole engine's, read again as a folder opens only
// when none was open (`reopen`: a folder something opens again as the last one closes).
async function engineWith(account, folders, kind = "gitlab") {
  const engine = {
    pid: 4242,
    kind,
    account,
    shared: [...account],
    reopen: null,
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
    if (!engine.open.has(folder)) {
      if (!engine.open.size) engine.shared = [...engine.account];
      engine.open.set(folder, { models: [...engine.account] });
    }
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
      // An engine without a way to close a folder.
      if (engine.cantClose) return response.writeHead(405).end();
      const closed = url.searchParams.get("location[directory]");
      engine.open.delete(closed);
      engine.closed.push(closed);
      if (!engine.open.size && engine.reopen) { const again = engine.reopen; engine.reopen = null; again(use); }
      for (const resolve of engine.closing.splice(0)) resolve(closed);
      return response.writeHead(204).end();
    }
    if (url.pathname === "/api/provider") return send(200, { data: [] });
    if (url.pathname === "/api/integration/github-copilot") return send(200, { data: { id: "github-copilot", connections: [{ id: "cred_copilot", method: "oauth" }] } });
    if (url.pathname === `/api/integration/${engine.kind}`) return send(200, { data: { id: engine.kind, connections: [{ id: "cred_1", method: "oauth" }] } });
    if (url.pathname.startsWith("/api/integration/")) return send(404, { message: "Integration not found" });
    if (url.pathname === "/api/session/active") return send(200, { data: Object.fromEntries(Object.keys(engine.active).map(id => [id, { type: "running" }])) });
    if (url.pathname.startsWith("/api/session/")) {
      const id = decodeURIComponent(url.pathname.split("/").pop());
      return engine.active[id] ? send(200, { data: { id, location: { directory: engine.active[id] } } }) : send(404, {});
    }
    const there = use(folder);
    if (url.pathname === "/api/model") return send(200, { location: { directory: folder }, data: (engine.kind === "gitlab" ? there.models : engine.shared).map(id => ({ providerID: engine.kind, id, family: id.replace(/-[\d.]+$/, "") })) });
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

test("Refresh Models for a list each folder reads itself (GitLab Duo's) opens the engine's folders afresh where nothing's going on, and each one at work once its work is done", async t => {
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

  // GitLab gives the account another model: the engine doesn't know until it reads its list again.
  engine.account = ["claude-opus-5.6", "claude-sonnet-5.6"];
  const answer = await ask("POST", "kuvo/accounts/gitlab/refresh");
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.json.waiting.sort(), ["/w/asks", "/w/command", "/w/permission", "/w/run", "/w/terminal"]);
  // Nothing at work was cut.
  assert.deepEqual(engine.closed.sort(), [OWN, "/w/quiet"].sort());
  // The engine's own folder, which the model pickers read, has it as it's next used.
  const own = await fetch(`http://127.0.0.1:${engine.source.port}/api/model`).then(response => response.json());
  assert.deepEqual(own.data.map(model => model.id), ["claude-opus-5.6", "claude-sonnet-5.6"]);
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
  const answer = await asker(engine)("POST", "kuvo/accounts/gitlab/refresh");
  assert.deepEqual(answer.json.waiting, ["/w/terminal"]);
  // Restarted (another process), its terminal gone with it; the box looks as it finds it.
  engine.source.pid = 4343;
  engine.open.get("/w/terminal").terminal = "exited";
  await link.settleDueModels(engine.source);
  assert.deepEqual(engine.closed, [OWN]);
  assert.equal(fs.existsSync(path.join(home, "run", "models-due.json")), false);
});

test("Refresh Models for a list the whole engine keeps (GitHub Copilot's) closes every folder, only with nothing going on in any, and opens none until the engine has none open; otherwise it closes none and says when they come", async () => {
  const engine = await engineWith(["claude-opus-5.6"], { "/w/quiet": {}, "/w/terminal": { terminal: "running" } }, "github-copilot");
  const ask = asker(engine);
  engine.account = ["claude-opus-5.6", "claude-sonnet-5.6"];
  // A terminal running in one project: closing the rest would bring nothing, and that one can't be.
  let answer = await ask("POST", "kuvo/accounts/github-copilot/refresh");
  assert.equal(answer.status, 409);
  assert.match(answer.json.message, /they show by themselves within twenty minutes/);
  assert.deepEqual(engine.closed, []);
  assert.equal(fs.existsSync(path.join(home, "run", "models-due.json")), false);
  // A run that starts in one as the others close: the rest stay as they are, and it says so.
  engine.open.get("/w/terminal").terminal = "exited";
  const closing = engine.nextClose();
  closing.then(() => { engine.active.ses_2 = "/w/terminal"; });
  answer = await ask("POST", "kuvo/accounts/github-copilot/refresh");
  assert.equal(answer.status, 409);
  assert.ok(engine.open.has("/w/terminal"), "A folder where a run started meanwhile was closed");
  assert.deepEqual(engine.shared, ["claude-opus-5.6"]);
  delete engine.active.ses_2;
  // All quiet, and one opened again as the last closes (a client reading it): that one's closed too,
  // and only then is any opened again, so the engine reads the list afresh; the box learns it.
  engine.closed = [];
  engine.reopen = use => use("/w/late");
  answer = await ask("POST", "kuvo/accounts/github-copilot/refresh");
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.json.waiting, []);
  assert.ok(engine.closed.includes("/w/late"), "A folder opened again meanwhile kept the engine's list from before");
  assert.deepEqual(engine.shared, ["claude-opus-5.6", "claude-sonnet-5.6"]);
  assert.deepEqual(engineReads(), ["claude-opus-5.6", "claude-sonnet-5.6"]);
  assert.equal(fs.existsSync(path.join(home, "run", "models-due.json")), false);
});

test("Refresh Models for a provider whose models don't come from your account, one the engine doesn't have, on an engine that can't close a folder, or with the engine down, says so; nothing is closed", async () => {
  const engine = await engineWith(["claude-opus-5.6"], { "/w/quiet": {} }, "github-copilot");
  const ask = asker(engine);
  // A client offers it for the providers whose models come from your account alone.
  const offered = await ask("GET", "kuvo/accounts/refreshable");
  assert.ok(offered.json.providers.includes("github-copilot") && !offered.json.providers.includes("anthropic"));
  // One whose models come from the catalog, which the engine reads again by itself.
  const catalog = await ask("POST", "kuvo/accounts/anthropic/refresh");
  assert.equal(catalog.status, 409);
  assert.match(catalog.json.message, /by itself/);
  // One the engine doesn't have (removed meanwhile): said in words.
  const unknown = await ask("POST", "kuvo/accounts/modal/refresh");
  assert.equal(unknown.status, 404);
  assert.match(unknown.json.message, /isn't on this computer's engine/);
  assert.equal((await ask("GET", "kuvo/accounts/github-copilot/refresh")).status, 405);
  assert.deepEqual(engine.closed, []);
  // One that can't close a folder can't make its lists afresh without a restart: it says so, and
  // keeps none for later.
  engine.cantClose = true;
  const cant = await ask("POST", "kuvo/accounts/github-copilot/refresh");
  assert.equal(cant.status, 503);
  assert.match(cant.json.message, /restart/i);
  assert.equal(fs.existsSync(path.join(home, "run", "models-due.json")), false);
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

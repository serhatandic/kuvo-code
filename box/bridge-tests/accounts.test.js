// Your plans' sign-ins on a box, as a phone sees and changes them (PROTOCOL.md, "kuvo/accounts"),
// on every box, this Mac's too: the plans whose sign-in ran out and couldn't be renewed (a run on
// one was refused), until it works again or you sign in again; and Disconnect, as Settings ›
// Accounts does it, for your plans alone, never an integration's server. The engine is a stand-in.
//
// Run with `node --test box/bridge-tests/accounts.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-accounts-"));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const link = await import("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js");

// An engine with your plans, an integration's server, and what each is signed in with; it keeps
// what was removed.
async function engineWith() {
  const engine = {
    sessions: { ses_a: { id: "ses_a", model: { providerID: "openai" } }, ses_k: { id: "ses_k", model: { providerID: "anthropic" } } },
    credentials: [
      { id: "crd_1", integrationID: "openai", label: "me" },
      { id: "crd_2", integrationID: "openai", label: "work" },
      { id: "crd_3", integrationID: "anthropic", label: "Work" },
      { id: "crd_4", integrationID: "sirket-proxy", label: "Şirket" },
      { id: "crd_5", integrationID: "şirket-proxy", label: "Şirket, from before" },
      { id: "crd_6", integrationID: "notion", label: "Notion" },
    ],
    // The sign-in each plan uses now.
    inUse: { openai: { credentialID: "crd_1", method: "oauth" }, anthropic: { credentialID: "crd_3", method: "key" } },
    removed: [],
    followers: [],
    // Those waiting for the next to follow its events.
    awaitingFollower: [],
  };
  engine.nextFollower = () => new Promise(resolve => engine.awaitingFollower.push(resolve));
  // Its events, to whoever follows them.
  engine.send = event => { for (const follower of engine.followers) follower.write(`data: ${JSON.stringify(event)}\n\n`); };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": hello\n\n");
      engine.followers.push(response);
      for (const resolve of engine.awaitingFollower.splice(0)) resolve();
      return;
    }
    const send = (status, body) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (request.method === "DELETE" && url.pathname.startsWith("/api/credential/")) {
      if (engine.refusesRemoving) return send(500, { message: "Busy." });
      const id = decodeURIComponent(url.pathname.split("/").pop());
      // Removed meanwhile (Disconnect on the phone and the Mac at once): the engine has none.
      if (engine.goneAlready) {
        engine.credentials = engine.credentials.filter(each => each.id !== id);
        return send(404, { message: "Not found." });
      }
      engine.removed.push(id);
      engine.credentials = engine.credentials.filter(each => each.id !== id);
      return send(200, { data: true });
    }
    if (url.pathname === "/api/credential") return send(200, { data: engine.credentials });
    // Its providers, which it answers once its plugins are set up.
    if (url.pathname === "/api/provider") {
      if (engine.notAnswering) return send(503, { message: "Starting." });
      engine.settingUp = false;
      return send(200, { data: [] });
    }
    if (url.pathname === "/api/integration") {
      // Restarting, or too busy to answer.
      if (engine.notAnswering) return send(503, { message: "Starting." });
      // As the engine lists a sign-in in use: its credential's `id`.
      const plan = id => ({ id, connections: engine.inUse[id] ? [{ type: "credential", id: engine.inUse[id].credentialID, method: engine.inUse[id].method }] : [] });
      // (Just started: nothing yet, or what it has before its plugins are set up, without OpenAI.)
      if (engine.listsNothing) return send(200, { data: [] });
      const plans = [plan("openai"), plan("anthropic"), plan("sirket-proxy"), plan("şirket-proxy"), { id: "notion", metadata: { source: "mcp" }, connections: [] }];
      return send(200, { data: engine.settingUp ? plans.slice(1) : plans });
    }
    const session = engine.sessions[decodeURIComponent(url.pathname.split("/").pop())];
    send(session ? 200 : 404, { data: session ?? null });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  atEnd(() => { server.closeAllConnections(); server.close(); });
  engine.source = { port: server.address().port, password: "pw" };
  return engine;
}

const engine = await engineWith();
const handle = link.engineHandler(() => engine.source);
async function ask(method, route) {
  const parts = [];
  for await (const part of handle({ method, path: route, headers: {}, body: Buffer.alloc(0) }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  let json;
  try { json = JSON.parse(text); } catch {}
  return { status: parts[0].head.status, json };
}
const ended = async () => (await ask("GET", "kuvo/accounts/ended")).json.providers;
// A run on the engine, as its events say it ended.
const refused = session => link.noteSignIn({ type: "session.execution.failed", data: { sessionID: session, error: { type: "provider.auth", message: "Request failed with status 401" } } }, engine.source);

test("a plan whose sign-in ran out is listed, until it works again or you sign in again; a key never is", async () => {
  assert.deepEqual(await ended(), []);
  await refused("ses_a");
  assert.deepEqual(await ended(), ["openai"]);
  // It worked after all: a step on its model ended well.
  await link.noteSignIn({ type: "session.step.ended", data: { sessionID: "ses_a" } }, engine.source);
  assert.deepEqual(await ended(), []);

  await refused("ses_a");
  assert.deepEqual(await ended(), ["openai"]);
  // Signed in again: the one in use is another.
  engine.inUse.openai = { credentialID: "crd_2", method: "oauth" };
  assert.deepEqual(await ended(), []);

  // A key refused, or a run that failed some other way: nothing to sign in to again.
  await refused("ses_k");
  await link.noteSignIn({ type: "session.execution.failed", data: { sessionID: "ses_a", error: { type: "provider.auth", message: "Invalid model" } } }, engine.source);
  await link.noteSignIn({ type: "session.execution.failed", data: { sessionID: "ses_a", error: { type: "unknown", message: "Request failed" } } }, engine.source);
  assert.deepEqual(await ended(), []);
});

test("a plan whose sign-in ran out isn't said to work again while the engine can't say which sign-in it uses: the box says it couldn't read it", async () => {
  engine.inUse.openai = { credentialID: "crd_1", method: "oauth" };
  await refused("ses_a");
  assert.deepEqual(await ended(), ["openai"]);
  engine.notAnswering = true;
  const answer = await ask("GET", "kuvo/accounts/ended");
  engine.notAnswering = false;
  assert.equal(answer.status, 503);
  assert.deepEqual(await ended(), ["openai"]);
  await link.noteSignIn({ type: "session.step.ended", data: { sessionID: "ses_a" } }, engine.source);
});

test("Disconnect signs the box out of that plan alone, and of nothing that isn't one", async () => {
  engine.inUse.openai = { credentialID: "crd_1", method: "oauth" };
  await refused("ses_a");
  assert.deepEqual(await ended(), ["openai"]);
  assert.equal((await ask("POST", "kuvo/accounts/openai/forget")).status, 200);
  assert.deepEqual(engine.removed.sort(), ["crd_1", "crd_2"]);
  assert.ok(!engine.credentials.some(each => each.integrationID === "openai"));
  engine.inUse.openai = undefined;
  assert.deepEqual(await ended(), []);

  // Only a plan's own name: an integration's server, one the box hasn't, or a path that isn't one
  // signs nothing out.
  for (const route of ["kuvo/accounts/notion/forget", "kuvo/accounts/nowhere/forget", "kuvo/accounts/a%2Fb/forget", "kuvo/accounts/../credential/forget", "kuvo/accounts//forget"]) {
    assert.notEqual((await ask("POST", route)).status, 200, route);
  }
  assert.equal((await ask("GET", "kuvo/accounts/anthropic/forget")).status, 405);
  assert.deepEqual(engine.removed.sort(), ["crd_1", "crd_2"]);
});

test("Disconnect while the engine is just starting doesn't take a plan it hasn't listed yet for one it hasn't", async () => {
  engine.credentials.push({ id: "crd_9", integrationID: "openai", label: "me" });
  // Nothing listed yet: it says to try again, and signs nothing out.
  engine.listsNothing = true;
  const answer = await ask("POST", "kuvo/accounts/openai/forget");
  engine.listsNothing = false;
  assert.equal(answer.status, 503);
  assert.ok(engine.credentials.some(each => each.id === "crd_9"));
  // Before its plugins are set up: its plans are listed once they are, OpenAI's too.
  engine.settingUp = true;
  assert.equal((await ask("POST", "kuvo/accounts/openai/forget")).status, 200);
  assert.ok(!engine.credentials.some(each => each.id === "crd_9"));
});

test("Disconnect that the engine refuses says so, and the plan still says its sign-in ended", async () => {
  engine.credentials.push({ id: "crd_7", integrationID: "openai", label: "me" });
  engine.inUse.openai = { credentialID: "crd_7", method: "oauth" };
  await refused("ses_a");
  assert.deepEqual(await ended(), ["openai"]);
  engine.refusesRemoving = true;
  const answer = await ask("POST", "kuvo/accounts/openai/forget");
  engine.refusesRemoving = false;
  assert.equal(answer.status, 502);
  assert.ok(answer.json?.message, "says why");
  assert.ok(engine.credentials.some(each => each.id === "crd_7"));
  assert.deepEqual(await ended(), ["openai"]);
  // Tried again once the engine takes it: signed out, and nothing ended any more.
  assert.equal((await ask("POST", "kuvo/accounts/openai/forget")).status, 200);
  engine.inUse.openai = undefined;
  assert.deepEqual(await ended(), []);
});

test("Disconnect of a sign-in removed meanwhile from another device is done, not refused", async () => {
  engine.credentials.push({ id: "crd_8", integrationID: "openai", label: "me" });
  engine.inUse.openai = { credentialID: "crd_8", method: "oauth" };
  await refused("ses_a");
  assert.deepEqual(await ended(), ["openai"]);
  engine.goneAlready = true;
  const answer = await ask("POST", "kuvo/accounts/openai/forget");
  engine.goneAlready = false;
  assert.equal(answer.status, 200);
  assert.ok(!engine.credentials.some(each => each.id === "crd_8"));
  // Nothing said to have ended any more.
  assert.deepEqual(await ended(), []);
  engine.inUse.openai = undefined;
});

test("a provider named in any language can be disconnected from a phone: by its plain id, or the name it was given before", async () => {
  engine.removed = [];
  assert.equal((await ask("POST", "kuvo/accounts/sirket-proxy/forget")).status, 200);
  assert.equal((await ask("POST", `kuvo/accounts/${encodeURIComponent("şirket-proxy")}/forget`)).status, 200);
  assert.deepEqual(engine.removed, ["crd_4", "crd_5"]);
});

test("a plan whose sign-in ran out is noted as the box watches its engine, whichever part of it watches (a machine's link, or this Mac's box), and every part of the box says so", async t => {
  // Where the box finds its engine.
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify(engine.source));
  const script = fileURLToPath(new URL("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
  // A machine's link (`run`), then this Mac's box (`serve`), as each starts watching.
  for (const watching of [{}, { bots: true, notices: false }]) {
    await ask("POST", "kuvo/accounts/openai/forget");
    engine.inUse.openai = { credentialID: "crd_1", method: "oauth" };
    engine.credentials.push({ id: "crd_1", integrationID: "openai", label: "me" });
    assert.deepEqual(await ended(), []);
    const stop = new AbortController();
    t.after(() => stop.abort());
    const following = engine.nextFollower();
    let looked;
    const signedIn = new Promise(resolve => { looked = resolve; });
    link.watchBox({ ...watching, signal: stop.signal, signedIn: event => event.type === "session.execution.failed" && looked() });
    await following;
    engine.send({ type: "session.execution.failed", data: { sessionID: "ses_a", error: { type: "provider.auth", message: "Request failed with status 401" } } });
    await signedIn;
    stop.abort();
    assert.deepEqual(await ended(), ["openai"], JSON.stringify(watching));
    // What a Mac asks a machine's box over SSH (`box route`), a process of its own: the same.
    const child = spawn(process.execPath, [script, "box", "route"], { env: { ...process.env, KUVO_HOME: home }, stdio: ["pipe", "pipe", "inherit"] });
    child.stdin.end(JSON.stringify({ method: "GET", path: "kuvo/accounts/ended" }));
    let out = "";
    child.stdout.setEncoding("utf8");
    for await (const chunk of child.stdout) out += chunk;
    const answer = JSON.parse(out.trim().split("\n").at(-1));
    assert.deepEqual(JSON.parse(answer.body), { providers: ["openai"] });
  }
});

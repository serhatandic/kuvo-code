// A Mac's own box (`kuvo-link.js serve`): its routes over HTTP on 127.0.0.1, as the app starts it
// beside the engine (PROTOCOL.md, "This Mac's box"). Run with
// `node --test Packages/KuvoLink/Tests/Bridge/*.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { removeAtEnd } from "./at-end.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-serve-"));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const script = new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url);
const link = await import(script);

const auth = password => `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

// Started as the app starts it: it says where it listens, then answers.
async function started(password = "s3cret") {
  const child = spawn(process.execPath, [script.pathname, "serve"], { env: { ...process.env, KUVO_HOME: home, OPENCODE_PASSWORD: password }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) {
    out += chunk;
    if (out.includes("\n")) break;
  }
  return { child, url: JSON.parse(out.split("\n")[0]).url };
}

test("the box answers its routes to the app, with its password only", async t => {
  const { child, url } = await started();
  t.after(() => child.kill());
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);

  assert.equal((await fetch(`${url}/kuvo/info`)).status, 401);
  assert.equal((await fetch(`${url}/kuvo/info`, { headers: { authorization: auth("wrong") } })).status, 401);

  const info = await fetch(`${url}/kuvo/info`, { headers: { authorization: auth("s3cret") } });
  assert.equal(info.status, 200);
  const said = await info.json();
  assert.equal(said.bridge, link.BRIDGE_VERSION);
  assert.equal(said.chats, path.join(home, "chats"), "its folders are where the app put it");

  // A path that isn't what it seems, as through the relay: sent as it's written (a URL would
  // resolve its "%2e%2e" before it went).
  const { hostname, port } = new URL(url);
  const sneaky = await new Promise(resolve => http.get({ hostname, port, path: "/kuvo/groups/%2e%2e/x", headers: { authorization: auth("s3cret") } }, resolve));
  assert.equal(sneaky.statusCode, 403);
  sneaky.resume();
  // And a route this box doesn't have, as every box answers it.
  const missing = await fetch(`${url}/kuvo/nothing`, { headers: { authorization: auth("s3cret") } });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), {});
});

test("it goes when the app does (its stdin closes)", async () => {
  const { child } = await started();
  child.stdin.end();
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
});

test("without a password it doesn't start", async () => {
  const child = spawn(process.execPath, [script.pathname, "serve"], { env: { ...process.env, KUVO_HOME: home, OPENCODE_PASSWORD: "" }, stdio: "ignore" });
  const [code] = await once(child, "exit");
  assert.equal(code, 2);
});

test("a stream goes as it comes, and stops when the client goes", async t => {
  let stopped = false;
  // A route that follows something, a line each time it changes, as `kuvo/…/events` do.
  const handle = async function* (request, phone, signal) {
    assert.equal(request.path, "kuvo/projects/events");
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    for (let line = 1; !signal.aborted; line++) {
      yield { body: Buffer.from(JSON.stringify({ line }) + "\n") };
      await new Promise(resolve => setImmediate(resolve));
    }
    stopped = true;
  };
  const server = link.serveBox("pw", handle);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/kuvo/projects/events`, { headers: { authorization: auth("pw") } });
  assert.equal(response.headers.get("content-type"), "application/x-ndjson");
  const reader = response.body.getReader();
  const { value } = await reader.read();
  assert.deepEqual(JSON.parse(Buffer.from(value).toString().split("\n")[0]), { line: 1 });
  await reader.cancel();
  while (!stopped) await new Promise(resolve => setImmediate(resolve));
});

// A route that holds a request before its answer's head (an ask waiting for you, a sandbox tool, a
// vault wait) says it's still working, every 20 seconds: a client's wait for the head (URLSession's
// request timeout, a minute unless it says) never runs out while it works.
test("an answer slow to come says it's alive while the box works, so a client waiting for its head doesn't give up", async t => {
  // (Its heartbeat on a clock this test moves: no waiting on one.)
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.after(() => t.mock.timers.reset());
  let started;
  const began = new Promise(resolve => { started = resolve; });
  let release, finish, headed;
  const held = new Promise(resolve => { release = resolve; });
  const rest = new Promise(resolve => { finish = resolve; });
  const head = new Promise(resolve => { headed = resolve; });
  const server = link.serveBox("pw", async function* () {
    started();
    await held;
    yield { head: { status: 200, headers: { "content-type": "application/json" } } };
    await rest;
    yield { body: Buffer.from(JSON.stringify({ ok: true })) };
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const interim = [];
  const answer = new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port: server.address().port, path: "/kuvo/sandbox/tools", method: "POST", headers: { authorization: auth("pw"), "content-type": "application/json" } }, response => {
      headed();
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.on("information", info => interim.push(info.statusCode));
    request.on("error", reject);
    request.end("{}");
  });
  await began;
  // Its 20 seconds with nothing to read: the box says it's still working.
  t.mock.timers.tick(20_000);
  release();
  await head;
  const told = interim.length;
  assert.ok(told >= 1 && interim.every(code => code === 102), `it says it's alive while it works (${interim.join(",")})`);
  // Once its head has gone, it says nothing more: its body is the answer's alone.
  t.mock.timers.tick(60_000);
  finish();
  const got = await answer;
  assert.equal(interim.length, told, "none after its head");
  assert.equal(got.status, 200);
  assert.deepEqual(JSON.parse(got.body), { ok: true }, "and then the answer itself, whole");
});

test("a client of HTTP/1.0, which mustn't get an interim answer, gets only its answer however long it's held", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.after(() => t.mock.timers.reset());
  let started;
  const began = new Promise(resolve => { started = resolve; });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const server = link.serveBox("pw", async function* () {
    started();
    await held;
    yield { head: { status: 200, headers: { "content-type": "application/json" } } };
    yield { body: Buffer.from("{}") };
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const socket = net.connect(server.address().port, "127.0.0.1");
  t.after(() => socket.destroy());
  let heard = "";
  socket.setEncoding("utf8");
  socket.on("data", chunk => { heard += chunk; });
  const closed = once(socket, "close");
  socket.write(`POST /kuvo/sandbox/tools HTTP/1.0\r\nAuthorization: ${auth("pw")}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`);
  await began;
  t.mock.timers.tick(60_000);
  release();
  await closed;
  assert.match(heard, /^HTTP\/1\.[01] 200/, heard);
  assert.doesNotMatch(heard, / 102 /);
});

test("an answer cut off as it comes (the engine gone halfway) reaches the app cut off, not as a whole one", async t => {
  const handle = async function* () {
    yield { head: { status: 200, headers: { "content-type": "application/json" } } };
    yield { body: Buffer.from('{"sessions": [') };
    throw new Error("The engine went.");
  };
  const server = link.serveBox("pw", handle);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  // (Node's fetch has its head first, Bun's may not: either way it never reads as whole.)
  await assert.rejects(async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/session`, { headers: { authorization: auth("pw") } });
    await response.text();
  });
});

// A connection left open between requests is its client's to close: a client whose timers ran
// late (a busy Mac, its loop held up a few seconds) still sends its next request on it, and it gets
// there. (Closed a second after the time it told, the box reset such a request, a sandbox_ask's
// POST, which no client sends again.)
test("a connection a busy client left open past the time the box told it still takes its next request", async t => {
  const handle = async function* (request) {
    yield { head: { status: 200, headers: { "content-type": "application/json" } } };
    yield { body: Buffer.from(JSON.stringify({ method: request.method }) + "\n") };
  };
  const server = link.serveBox("pw", handle);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const socket = net.connect(server.address().port, "127.0.0.1");
  t.after(() => socket.destroy());
  let heard = "";
  let ended = null;
  socket.setEncoding("utf8");
  socket.on("data", chunk => { heard += chunk; });
  socket.on("end", () => { ended ??= "closed by the box"; });
  socket.on("error", error => { ended ??= error.code; });
  // An answer, whole (its last chunk), or the connection gone; none in 10 seconds fails.
  const answered = async () => {
    const until = Date.now() + 10_000;
    while (!heard.includes("\r\n0\r\n\r\n") && !ended) {
      if (Date.now() > until) assert.fail(`no answer in 10 seconds; heard: ${JSON.stringify(heard)}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const answer = heard;
    heard = "";
    return answer;
  };
  const request = method => `${method} /kuvo/sandbox/tools HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: ${auth("pw")}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`;
  socket.write(request("GET"));
  const first = await answered();
  assert.match(first, /^HTTP\/1\.1 200/);
  const told = Number(first.match(/^keep-alive: timeout=(\d+)/im)?.[1]);
  assert.ok(told >= 1, `it tells its clients how long it keeps a connection: ${first}`);
  // Late by a few seconds: past what it told, and the second Node and Bun add.
  await new Promise(resolve => setTimeout(resolve, (told + 3) * 1000));
  assert.equal(ended, null, "the box kept it");
  socket.write(request("POST"));
  const second = await answered();
  assert.match(second, /^HTTP\/1\.1 200/, ended ?? second);
  assert.match(second, /"method":"POST"/);
});

test("the app's own requests aren't a phone using the box; a phone's, through the Mac, are", async t => {
  const server = link.serveBox("pw");
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/kuvo/projects`;
  fs.rmSync(link.SEEN_FILE, { force: true });
  assert.equal((await fetch(url, { headers: { authorization: auth("pw"), "x-kuvo-from": "app" } })).status, 200);
  assert.equal(fs.existsSync(link.SEEN_FILE), false, "the app asking");
  assert.equal((await fetch(url, { headers: { authorization: auth("pw") } })).status, 200);
  assert.equal(fs.existsSync(link.SEEN_FILE), true, "a phone asking");
});

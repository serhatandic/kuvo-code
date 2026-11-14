// A Mac's own box in a home of its own (#333 piece 3; PROTOCOL.md, "This Mac's app"): its agents
// browse in its app's panel. The app registers with the box (`kuvo/box/app`), saying where its tools
// answer and where it's installed; the box's tool server (`kuvo-browser.js mcp`, as its engine starts
// it) sends each browser call there as it came. With the app closed, a browser call has the box open
// it (`kuvo/box/app/open`): once for every call that comes meanwhile, from any of the box's processes,
// by what runs as the app (its host interface's `app/open`, the keeper's), and each call goes on once
// the app has registered. The real box script and tool server, in a home of the test's own; the app's
// tool server and its host interface are stand-ins.
//
// Run with `node --test box/bridge-tests/own-box-app.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-own-box-app-")));
removeAtEnd(home);
const script = fileURLToPath(new URL("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const browserScript = fileURLToPath(new URL("../dist/kuvo-browser.js", import.meta.url));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const run = path.join(home, "run");
// The box: a Mac's, laid out in a home of its own, with its script where its tool server runs it.
write(path.join(home, "box", "kind"), "mac\n");
fs.mkdirSync(path.join(home, "bin"), { recursive: true });
fs.copyFileSync(script, path.join(home, "bin", "kuvo-link.js"));
const env = { ...process.env, KUVO_HOME: home, HOME: home, TMPDIR: home };
const BUNDLE = "/Applications/Kuvo Code.app";

const json = (response, value, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};
const body = request => new Promise(resolve => {
  let text = "";
  request.on("data", chunk => { text += chunk; });
  request.on("end", () => resolve(text));
});
const listen = async server => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  atEnd(() => { server.closeAllConnections(); server.close(); });
  return server.address().port;
};

// The app's tools (the panel's browser): each call as it came, answered with what it was asked.
const appCalls = [];
const TOKEN = crypto.randomBytes(24).toString("hex");
const appTools = http.createServer(async (request, response) => {
  const message = JSON.parse(await body(request));
  appCalls.push({ authorization: request.headers.authorization, session: request.headers["x-kuvo-session"], message });
  if (message.method !== "tools/call") return json(response, {}, 202);
  json(response, { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `the panel did ${message.params.name} ${JSON.stringify(message.params.arguments)}` }] } });
});
const appPort = await listen(appTools);
const tools = { url: `http://127.0.0.1:${appPort}/mcp`, token: TOKEN };

// The box's answer to one request, as Kuvo Code asks it: a process of its own.
function route(method, routePath, sent) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "box", "route"], { env, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("error", reject);
    child.on("close", () => {
      const said = JSON.parse(out.trim().split("\n").pop());
      resolve({ status: said.status, body: said.body ? JSON.parse(said.body) : null });
    });
    child.stdin.end(JSON.stringify({ method, path: routePath, ...(sent === undefined ? {} : { body: sent }) }));
  });
}

// What runs as the app (the keeper): its host interface, proving it's this Mac's app, and opening
// the app as it's asked, which then registers (`opens` says how it answers).
const PASSWORD = crypto.randomBytes(16).toString("hex");
const opened = [];
let opens = async () => {
  await route("POST", "kuvo/box/app", { tools, bundle: BUNDLE });
  return [200, {}];
};
const host = http.createServer(async (request, response) => {
  const given = JSON.parse((await body(request)) || "{}");
  if (request.url === "/hello") {
    const proof = crypto.createHmac("sha256", PASSWORD).update(["kuvo-host-hello", given.nonce, `127.0.0.1:${host.address().port}`].join("\0")).digest("hex");
    return json(response, { proof });
  }
  if (request.headers.authorization !== `Bearer ${PASSWORD}`) return json(response, {}, 401);
  if (request.url !== "/app/open") return json(response, {}, 404);
  opened.push(given.bundle);
  const [status, answer] = await opens();
  json(response, answer, status);
});
const hostPort = await listen(host);
write(path.join(run, "host.json"), JSON.stringify({ url: `http://127.0.0.1:${hostPort}`, password: PASSWORD }));

// The box's tool server, as its engine starts it.
function toolServer() {
  const server = spawn(process.execPath, [browserScript, "mcp"], { env, stdio: ["pipe", "pipe", "ignore"] });
  atEnd(() => server.kill());
  const answers = new Map();
  let buffer = "";
  let next = 1;
  server.stdout.on("data", chunk => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(end + 1)) {
      const message = JSON.parse(buffer.slice(0, end));
      answers.get(message.id)?.(message.result);
    }
  });
  const ask = (method, params) => new Promise(resolve => {
    const id = next++;
    answers.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const call = (name, args, session) => ask("tools/call", { name, arguments: args, _meta: { "ai.opencode/sessionID": session } });
  return { ask, call };
}
const said = result => result.content.map(part => part.text).join("");

test("the app registers with its place; a browser call goes to its tools as it came, with whose it is", async () => {
  const registered = await route("POST", "kuvo/box/app", { tools, bundle: BUNDLE });
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  assert.deepEqual(registered.body, { bundle: BUNDLE, open: true, updating: false, opening: false, failed: null });
  assert.equal(fs.statSync(path.join(run, "app.json")).mode & 0o777, 0o600);
  const server = toolServer();
  const result = await server.call("browser_navigate", { url: "https://example.com" }, "ses_work");
  assert.equal(said(result), 'the panel did browser_navigate {"url":"https://example.com"}');
  const sent = appCalls.at(-1);
  assert.equal(sent.authorization, `Bearer ${TOKEN}`);
  assert.equal(sent.session, "ses_work");
  assert.equal(sent.message.params._meta["ai.opencode/sessionID"], "ses_work");
  assert.deepEqual(opened, [], "nothing opened: it's open");
  // Its place is a whole path to the app, and its tools answer on this Mac only.
  assert.equal((await route("POST", "kuvo/box/app", { tools, bundle: "Kuvo Code.app" })).status, 400);
  assert.equal((await route("POST", "kuvo/box/app", { tools: { url: "http://example.com/mcp", token: TOKEN } })).status, 400);
});

test("with the app closed, browser calls from two of the box's tool servers open it once, where it registered, and each goes on", async () => {
  assert.equal((await route("POST", "kuvo/box/app", { tools: null })).body.open, false);
  const before = appCalls.length;
  const one = toolServer(), two = toolServer();
  const results = await Promise.all([
    one.call("browser_snapshot", {}, "ses_a"),
    one.call("browser_tabs", {}, "ses_b"),
    two.call("browser_navigate", { url: "https://kuvo.run" }, "ses_c"),
  ]);
  assert.deepEqual(results.map(said), ["the panel did browser_snapshot {}", "the panel did browser_tabs {}", 'the panel did browser_navigate {"url":"https://kuvo.run"}']);
  assert.deepEqual(opened, [BUNDLE], "one opening, of the app where it registered");
  assert.equal(appCalls.length - before, 3);
  assert.equal(fs.existsSync(path.join(run, "app-opening.json")), false, "the opening's note gone with it");
});

test("an app that quit without saying is opened again, and the call goes on", async () => {
  // Registered at a port nothing answers on now.
  const gone = http.createServer(() => {});
  const gonePort = await new Promise(resolve => gone.listen(0, "127.0.0.1", () => resolve(gone.address().port)));
  await new Promise(resolve => gone.close(resolve));
  await route("POST", "kuvo/box/app", { tools: { url: `http://127.0.0.1:${gonePort}/mcp`, token: "x".repeat(32) } });
  opened.length = 0;
  const result = await toolServer().call("browser_back", {}, "ses_a");
  assert.equal(said(result), "the panel did browser_back {}");
  assert.deepEqual(opened, [BUNDLE]);
});

test("something else answering where the app's tools were is taken for the app gone: nothing more is sent there, and the app's opened again", async () => {
  const other = [];
  const squatter = http.createServer(async (request, response) => {
    other.push(await body(request));
    json(response, { message: "who are you" }, 401);
  });
  const squatterPort = await listen(squatter);
  await route("POST", "kuvo/box/app", { tools: { url: `http://127.0.0.1:${squatterPort}/mcp`, token: "y".repeat(32) } });
  opened.length = 0;
  opens = async () => {
    await route("POST", "kuvo/box/app", { tools, bundle: BUNDLE });
    return [200, {}];
  };
  const server = toolServer();
  assert.equal(said(await server.call("browser_forward", {}, "ses_a")), "the panel did browser_forward {}");
  assert.equal(said(await server.call("browser_forward", {}, "ses_a")), "the panel did browser_forward {}");
  assert.deepEqual(opened, [BUNDLE]);
  assert.equal(other.length, 1, "asked once, then never again");
});

test("an opening that fails: the agent hears why, and the app isn't opened again for a while", async () => {
  await route("POST", "kuvo/box/app", { tools: null });
  opened.length = 0;
  opens = async () => [502, { message: "macOS refused" }];
  const server = toolServer();
  const first = await server.call("browser_snapshot", {}, "ses_a");
  assert.equal(said(first), "Kuvo Code couldn't be opened in the background on this Mac for its browser (macOS refused). Ask the user to open Kuvo Code, then try again.");
  assert.equal(first.isError, true);
  const second = await server.call("browser_snapshot", {}, "ses_a");
  assert.equal(said(second), said(first));
  assert.deepEqual(opened, [BUNDLE], "asked once");
  assert.equal((await route("GET", "kuvo/box/app")).body.failed.message, said(first));
  // Its app moved or deleted: said so.
  fs.rmSync(path.join(run, "app-open-failed.json"));
  opens = async () => [410, { message: "It isn't there any more." }];
  assert.match(said(await server.call("browser_snapshot", {}, "ses_a")), /isn't where it was installed on this Mac any more/);
  // You opened it yourself meanwhile: registered, and calls go on.
  await route("POST", "kuvo/box/app", { tools, bundle: BUNDLE });
  assert.equal((await route("GET", "kuvo/box/app")).body.failed, null);
  assert.equal(said(await server.call("browser_snapshot", {}, "ses_a")), "the panel did browser_snapshot {}");
});

test("an opening whose process is cut off partway is taken over by a call waiting on it", async () => {
  await route("POST", "kuvo/box/app", { tools: null });
  for (const file of ["app-open-failed.json", "app-opening.json"]) fs.rmSync(path.join(run, file), { force: true });
  opened.length = 0;
  // The first opening hangs at the host, until the test lets it go.
  let letGo;
  const hanging = new Promise(resolve => { letGo = resolve; });
  let asked;
  const firstAsked = new Promise(resolve => { asked = resolve; });
  opens = async () => {
    if (opened.length === 1) {
      asked();
      await hanging;
      return [502, { message: "too late" }];
    }
    await route("POST", "kuvo/box/app", { tools, bundle: BUNDLE });
    return [200, {}];
  };
  atEnd(() => letGo());
  const ask = () => {
    const child = spawn(process.execPath, [script, "box", "route"], { env, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    const done = new Promise(resolve => child.on("close", () => resolve(out.trim() ? JSON.parse(out.trim().split("\n").pop()) : null)));
    child.stdin.end(JSON.stringify({ method: "POST", path: "kuvo/box/app/open", body: {} }));
    return { child, done };
  };
  const first = ask();
  await firstAsked;
  const second = ask();
  first.child.kill("SIGKILL");
  assert.equal(await first.done, null, "the first was cut off");
  const answer = await second.done;
  assert.equal(answer.status, 200, answer.body);
  assert.deepEqual(opened, [BUNDLE, BUNDLE], "opened again by the call that waited");
  letGo();
});

test("a machine's box has no app registering with it", async () => {
  const machine = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-own-box-machine-")));
  removeAtEnd(machine);
  const answer = await new Promise(resolve => {
    const child = spawn(process.execPath, [script, "box", "route"], { env: { ...env, KUVO_HOME: machine, HOME: machine, TMPDIR: machine }, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("close", () => resolve(JSON.parse(out.trim().split("\n").pop())));
    child.stdin.end(JSON.stringify({ method: "POST", path: "kuvo/box/app", body: { tools, bundle: BUNDLE } }));
  });
  assert.equal(answer.status, 409);
  assert.equal(fs.existsSync(path.join(machine, "run", "app.json")), false);
});

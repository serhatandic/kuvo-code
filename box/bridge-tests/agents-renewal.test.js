// A newer coding agents' bridge put on a machine while its sessions work (a Mac that connected
// brought it, on a box that works day and night): the bridge running takes it without cutting a
// turn. The turn under way ends on the bridge it began on, which then makes way, and the next turn
// runs on the new one; on a box with no quiet moment, new turns wait (kept) once it has waited long
// enough, and run on the new one. Nothing sent is lost or run twice. The box says meanwhile which
// build each runs (`kuvo/info`'s `pieces`). The real bridge (swift/KuvoCode/Resources/kuvo-agents.js, on
// Bun) and the real link, a stand-in `codex app-server` whose turns wait to be let go, and what
// keeps a machine's bridge running (its launch starts it again from what's there as it ends).
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";
import { NO_BUN, testBun } from "./bun-for-tests.js";

const bun = testBun();
const built = fileURLToPath(new URL("../../swift/KuvoCode/Resources/kuvo-agents.js", import.meta.url));
const script = fileURLToPath(new URL("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));

// Its turns: each says in the log which bridge started it (its parent), and one whose words say
// "hold" waits until its `release-<last word>` file is there. Each ends with "Done: <its words>".
const FAKE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const folder = process.argv[2];
const send = message => process.stdout.write(JSON.stringify(message) + "\n");
let buffer = "", thread = 0, turns = 0;
async function turn(threadId, turnId, text) {
  fs.appendFileSync(path.join(folder, "turns.log"), JSON.stringify({ text, bridge: process.ppid }) + "\n");
  send({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
  if (/hold/.test(text)) {
    const release = path.join(folder, "release-" + text.split(" ").pop());
    while (!fs.existsSync(release)) await new Promise(resolve => setTimeout(resolve, 20));
  }
  send({ method: "item/started", params: { threadId, turnId, item: { type: "agentMessage", id: "m" + turnId, text: "" } } });
  send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "m" + turnId, text: "Done: " + text } } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
}
process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "t" + ++thread } } });
    else if (message.method === "thread/resume") send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    else if (message.method === "turn/start") {
      const turnId = "u" + ++turns;
      send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
      void turn(message.params.threadId, turnId, message.params.input[0].text);
    } else if (message.method === "account/read") send({ id: message.id, result: { account: { type: "apiKey" } } });
    else if (message.method === "model/list") send({ id: message.id, result: { data: [{ id: "gpt-test", model: "gpt-test", displayName: "GPT Test", isDefault: true }] } });
    else if (message.id !== undefined) send({ id: message.id, result: {} });
  }
});
`;

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

async function until(wanted, what, within = 60_000) {
  for (let waited = 0; waited < within; waited += 20) {
    const found = await wanted();
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Waited too long for ${what}`);
}

/** The same bundle as another build: what a Mac that connected puts in its place (a file of its own,
 * moved over the one there). */
function install(home, build) {
  const text = fs.readFileSync(built, "utf8").replace(/\/\/ Built from Packages\/Box\/src\/agents [0-9a-f]+/, `// Built from Packages/Box/src/agents ${build}`);
  const file = path.join(home, "bin", "kuvo-agents.js");
  fs.writeFileSync(`${file}.new`, text + `\n// kuvo-agents ${build.slice(0, 16)}\n`);
  fs.renameSync(`${file}.new`, file);
}

/** A machine's box in folders of the test's own: its bin with the bridge as a Mac put it there, a
 * stand-in engine, and the bridge kept running as its launch keeps it (started again from what's
 * there whenever it ends, but for a port someone else took). */
async function machine(prefix, extra = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  removeAtEnd(home);
  for (const folder of ["tmp", "work", "agents", "run", "bin", "home", "codex-home", "fake"]) fs.mkdirSync(path.join(home, folder), { recursive: true });
  fs.copyFileSync(built, path.join(home, "bin", "kuvo-agents.js"));
  // Its launch's log, as the launch empties it (its starts, one line each, as the bridge counts them).
  fs.writeFileSync(path.join(home, "run", "agents.log"), "");
  const fake = path.join(home, "fake");
  fs.writeFileSync(path.join(fake, "app-server.js"), FAKE);
  fs.writeFileSync(path.join(fake, "codex"), `#!/bin/sh\nexport BUN_BE_BUN=1\n[ "$1" = "--version" ] && { echo "codex-cli 0.166.0"; exit 0; }\nexec "${bun}" "${path.join(fake, "app-server.js")}" "${fake}"\n`, { mode: 0o755 });

  // The engine: nothing it's asked of here, but its feed, which stays open.
  const engine = http.createServer((request, response) => {
    if (request.url.startsWith("/api/event") || request.url.startsWith("/event")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": open\n\n");
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
  atEnd(() => new Promise(resolve => { engine.closeAllConnections(); engine.close(resolve); }));

  const port = await freePort();
  const env = {
    PATH: `${fake}:/usr/bin:/bin`, HOME: path.join(home, "home"), TMPDIR: `${home}/tmp/`, CODEX_HOME: path.join(home, "codex-home"), BUN_BE_BUN: "1",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", KUVO_AGENTS_REMOTE: "1", KUVO_HOME: home, KUVO_AGENTS_HOME: path.join(home, "agents"), KUVO_AGENTS_PORT: String(port),
    KUVO_AGENTS_PASSWORD: "pw", KUVO_ENGINE_PORT: String(engine.address().port), KUVO_ENGINE_PID: String(process.pid), OPENCODE_PASSWORD: "engine", KUVO_SANDBOX: "off",
    // (Not the half minute of quiet, nor the eleven minutes' run, a machine's bridge waits for.)
    KUVO_TEST_RENEW_SETTLE: "0", KUVO_TEST_RENEW_UPTIME: "0", ...extra,
  };
  // What keeps a machine's bridge running, as its launch does (RemoteServer.agentsScript): the same
  // loop, starting it again five seconds after it ends, while its engine (this process) runs, five
  // runs in a row under ten minutes at most; in a process group of the test's own.
  const loop = 'n=0; while kill -0 "$1" 2>/dev/null && [ $n -lt 5 ]; do s=$(date +%s); "$2" --config=/dev/null --no-env-file "$3" >>"$4" 2>&1 </dev/null; e=$?; [ $e -eq 98 ] && exit 98; [ $(($(date +%s) - s)) -ge 600 ] && n=0; n=$((n + 1)); sleep 5; done';
  const launch = spawn("sh", ["-c", loop, "kuvo-agents", String(process.pid), bun, path.join(home, "bin", "kuvo-agents.js"), path.join(home, "run", "agents.log")], { cwd: path.join(home, "work"), env, stdio: "ignore", detached: true });
  atEnd(() => new Promise(resolve => {
    if (launch.exitCode !== null) return resolve();
    launch.on("exit", () => resolve());
    // (Its group: the loop, the bridge it runs and what that started.)
    try { process.kill(-launch.pid, "SIGTERM"); } catch { resolve(); }
  }));
  /** How many times its launch has started it (one `"url"` line each in its log). */
  const starts = () => (fs.readFileSync(path.join(home, "run", "agents.log"), "utf8").match(/"url"/g) ?? []).length;

  const auth = { authorization: "Basic " + Buffer.from("opencode:pw").toString("base64"), "content-type": "application/json", "x-opencode-directory": encodeURIComponent(path.join(home, "work")) };
  const api = async (method, route, body) => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/${route}`, { method, headers: auth, body: body ? JSON.stringify(body) : undefined });
      const text = await response.text();
      return { status: response.status, json: text ? JSON.parse(text) : null };
    } catch {
      return { status: 0, json: null };
    }
  };
  const record = () => { try { return JSON.parse(fs.readFileSync(path.join(home, "run", "bridge.json"), "utf8")); } catch { return null; } };
  /** The bridge answering now, once it has written where it is: its process and build. */
  const up = (besides) => until(async () => {
    const said = record();
    if (!said?.pid || said.pid === besides) return null;
    const info = await api("GET", "api/info");
    return info.status === 200 && info.json.pid === said.pid ? { pid: said.pid, build: info.json.build } : null;
  }, besides ? "the newer bridge to answer" : "the bridge to answer");
  const turns = () => { try { return fs.readFileSync(path.join(fake, "turns.log"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  const release = word => fs.writeFileSync(path.join(fake, `release-${word}`), "");
  const make = async (title, metadata) => {
    const made = await api("POST", "api/session", { title, location: { directory: path.join(home, "work") }, model: { providerID: "codex-cli", id: "gpt-test" }, ...(metadata ? { metadata } : {}) });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    return made.json.data.id;
  };
  const send = async (session, id, text) => assert.equal((await api("POST", `api/session/${session}/prompt`, { id, delivery: "steer", text })).status, 200);
  const page = async session => (await api("GET", `api/session/${session}/message?limit=100&order=asc`)).json?.data ?? [];
  /** Its conversation, once its last turn is over: what you sent, what came back, and how each turn ended. */
  const finished = (session, sent) => until(async () => {
    const messages = await page(session);
    const yours = messages.filter(each => each.type === "user");
    return yours.length === sent && messages.at(-1)?.type === "idle" ? messages : null;
  }, "its turn to end");
  /** What the box says of its pieces, as a Mac asks it (`kuvo-link.js box route`). */
  const pieces = () => new Promise((resolve, reject) => {
    const asking = spawn(process.execPath, [script, "box", "route"], { env: { PATH: process.env.PATH, KUVO_HOME: home, HOME: path.join(home, "home"), TMPDIR: `${home}/tmp` }, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    asking.stdout.on("data", chunk => { out += chunk; });
    asking.on("error", reject);
    asking.on("close", () => {
      try { resolve(JSON.parse(JSON.parse(out.trim().split("\n").pop()).body).pieces); } catch (error) { reject(error); }
    });
    asking.stdin.end(JSON.stringify({ method: "GET", path: "kuvo/info" }));
  });
  /** A client following its events (the feed stays open; it follows the bridge started again). */
  const follow = () => {
    const stop = new AbortController();
    atEnd(() => stop.abort());
    const open = () => {
      if (stop.signal.aborted) return;
      fetch(`http://127.0.0.1:${port}/api/event`, { headers: { authorization: auth.authorization, accept: "text/event-stream" }, signal: stop.signal })
        .then(async response => { for await (const _ of response.body) {} })
        .catch(() => {})
        .finally(() => setTimeout(open, 200));
    };
    open();
  };
  return { home, starts, api, record, up, turns, release, make, send, finished, pieces, follow };
}

const textOf = messages => messages.filter(each => each.type === "assistant").flatMap(each => each.content ?? []).filter(block => block.type === "text").map(block => block.text);
const outcomes = messages => messages.filter(each => each.type === "idle").map(each => each.outcome);
const NEWER = "e".repeat(64);

test("a newer bridge put in place while a turn runs: that turn ends on the bridge it began on, the next runs on the new one, nothing lost or run twice", { skip: bun ? false : NO_BUN }, async () => {
  const box = await machine("kuvo-renewal-quiet-");
  // Its keeper names an engine a Mac didn't bring (sessions were at work), so it starts the one
  // there, which this bridge runs on: the bundle is for it.
  fs.mkdirSync(path.join(box.home, "engine", path.basename(path.dirname(bun))), { recursive: true });
  fs.writeFileSync(path.join(box.home, "engine", path.basename(path.dirname(bun)), "opencode"), "", { mode: 0o755 });
  fs.writeFileSync(path.join(box.home, "bin", "kuvo-start"), "#!/bin/sh\nV=99.0.0\n");
  const first = await box.up();
  assert.equal((await box.pieces()).agents.behind, false, "it runs what's there");
  const session = await box.make("Long one");
  await box.send(session, "msg_renewalquiet00001", "hold one");
  await until(() => box.turns().length === 1, "its turn to start");

  install(box.home, NEWER);
  // It sees the newer one, and waits: its turn is still under way, on it.
  const waiting = await until(() => box.record()?.renewal, "the bridge to see the newer one");
  assert.equal(waiting.holding, false);
  const said = await box.pieces();
  assert.equal(said.agents.behind, true, "the box says its coding agents run an older build than what's there");
  assert.equal(said.agents.current, NEWER);
  assert.ok(first.build, "the bundle names its build");
  assert.equal(said.agents.running, first.build);
  assert.equal(said.agents.renewal.since, waiting.since);
  assert.equal(said.agents.renewal.holding, false);
  assert.equal(said.agents.waits, "quiet", "it waits for a quiet moment");
  assert.equal(box.record().pid, first.pid, "the turn's bridge runs on");
  assert.notEqual((await box.api("GET", `api/session/${session}/message?limit=1`)).json.data[0]?.type, "idle", "and its turn goes on");

  box.release("one");
  const second = await box.up(first.pid);
  assert.equal(second.build, NEWER, "the new bridge runs the newer build");
  assert.equal((await box.pieces()).agents.behind, false, "and the box says so");
  let messages = await box.finished(session, 1);
  assert.deepEqual(textOf(messages), ["Done: hold one"]);
  assert.deepEqual(outcomes(messages), ["succeeded"], "the turn wasn't cut");

  await box.send(session, "msg_renewalquiet00002", "two");
  messages = await box.finished(session, 2);
  assert.deepEqual(messages.filter(each => each.type === "user").map(each => each.text), ["hold one", "two"]);
  assert.deepEqual(textOf(messages), ["Done: hold one", "Done: two"]);
  assert.deepEqual(outcomes(messages), ["succeeded", "succeeded"]);
  assert.deepEqual(box.turns(), [{ text: "hold one", bridge: first.pid }, { text: "two", bridge: second.pid }], "each turn ran once, the second on the new bridge");
  assert.equal(box.starts(), 2, "its launch started it again once");
});

test("a machine as it runs: its link asks the bridge whether it answers and a client follows its events all the while, and the bridge still goes at a quiet moment", { skip: bun ? false : NO_BUN }, async () => {
  // (Two seconds of quiet here, where a machine's bridge waits half a minute; its link asks every
  // half minute, more often than that here.)
  const box = await machine("kuvo-renewal-watched-", { KUVO_TEST_RENEW_SETTLE: "2000" });
  const first = await box.up();
  box.follow();
  let watching = true;
  atEnd(() => { watching = false; });
  void (async () => {
    while (watching) {
      await box.api("GET", "api/info");
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  })();
  const session = await box.make("Done for now");
  await box.send(session, "msg_renewalwatch00001", "one");
  await box.finished(session, 1);

  install(box.home, NEWER);
  const second = await box.up(first.pid);
  assert.equal(second.build, NEWER, "it went for the newer bridge with nothing at work, its link and a client looking on");
  assert.equal(box.record().renewal, null);
  await box.send(session, "msg_renewalwatch00002", "two");
  const messages = await box.finished(session, 2);
  assert.deepEqual(textOf(messages), ["Done: one", "Done: two"]);
  assert.deepEqual(box.turns(), [{ text: "one", bridge: first.pid }, { text: "two", bridge: second.pid }]);
});

test("a box with no quiet moment: once it has waited, a new message waits, kept, the turn under way ends on its bridge, and what waited runs once on the new one", { skip: bun ? false : NO_BUN }, async () => {
  const box = await machine("kuvo-renewal-busy-", { KUVO_TEST_RENEW_HOLD: "500" });
  const first = await box.up();
  const busy = await box.make("Never quiet");
  const other = await box.make("Sent meanwhile");
  await box.send(busy, "msg_renewalbusy000001", "hold three");
  await until(() => box.turns().length === 1, "its turn to start");

  install(box.home, NEWER);
  await until(() => box.record()?.renewal?.holding, "the bridge to hold new turns");
  // A group chat's seat goes on with its discussion meanwhile: its bot's part isn't held.
  const seat = await box.make("Seat", { kuvo: { seat: { group: "grp_team000001", bot: "bot_ada" } } });
  await box.send(seat, "msg_renewalbusy000003", "seat part");
  await until(() => box.turns().some(each => each.text === "seat part"), "the seat's part to start");
  assert.equal(box.turns().find(each => each.text === "seat part").bridge, first.pid, "on the bridge that makes way, once");
  await box.finished(seat, 1);
  const holding = await box.pieces();
  assert.equal(holding.agents.renewal.holding, true, "the box says new turns wait");
  assert.equal(holding.agents.waits, "holding");
  await box.send(other, "msg_renewalbusy000002", "four");
  const waits = await until(async () => (await box.api("GET", `api/session/${other}/inbox`)).json?.data, "the message to be in line");
  assert.deepEqual(waits.map(each => each.payload.text), ["four"], "it waits in line");
  assert.deepEqual(box.turns().map(each => each.text), ["hold three", "seat part"], "and starts no turn on the bridge that makes way");

  box.release("three");
  const second = await box.up(first.pid);
  assert.equal(second.build, NEWER);
  const ended = await box.finished(busy, 1);
  assert.deepEqual(textOf(ended), ["Done: hold three"]);
  assert.deepEqual(outcomes(ended), ["succeeded"], "the turn under way wasn't cut");
  const waited = await box.finished(other, 1);
  assert.deepEqual(waited.filter(each => each.type === "user").map(each => each.text), ["four"]);
  assert.deepEqual(textOf(waited), ["Done: four"]);
  assert.deepEqual(box.turns(), [{ text: "hold three", bridge: first.pid }, { text: "seat part", bridge: first.pid }, { text: "four", bridge: second.pid }], "what waited ran once, on the new bridge");
  assert.deepEqual((await box.api("GET", `api/session/${other}/inbox`)).json.data, [], "and nothing's left in line");
});

test("what the box says of a bridge from before bridges said their build, and of an engine a newer one waits to replace", { skip: bun ? false : NO_BUN }, async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-renewal-pieces-")));
  removeAtEnd(home);
  for (const folder of ["bin", "run", "tmp", "home", "engine/2.2.5", "engine/2.2.6"]) fs.mkdirSync(path.join(home, folder), { recursive: true });
  for (const version of ["2.2.5", "2.2.6"]) fs.writeFileSync(path.join(home, "engine", version, "opencode"), "", { mode: 0o755 });
  fs.writeFileSync(path.join(home, "bin", "kuvo-start"), "#!/bin/sh\nV=2.2.6\n");
  // Stand-ins whose command lines say what they are, as the box looks for them: an engine of the
  // version before, and a bridge that wrote its record before the bundle in place came.
  const standIn = (...words) => {
    const process_ = spawn(bun, ["-e", "setInterval(() => {}, 1e6)", ...words], { env: { BUN_BE_BUN: "1", PATH: process.env.PATH }, stdio: "ignore" });
    atEnd(() => new Promise(resolve => { if (process_.exitCode !== null) return resolve(); process_.on("exit", resolve); process_.kill(); }));
    return process_.pid;
  };
  const engine = standIn(path.join(home, "engine", "2.2.5", "opencode"));
  const bridge = standIn(path.join(home, "bin", "kuvo-agents.js"));
  fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify({ pid: engine, port: 1, password: "x", version: "2.2.5" }));
  fs.writeFileSync(path.join(home, "run", "bridge.json"), JSON.stringify({ pid: bridge, port: 2, password: "x" }));
  const before = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(home, "run", "bridge.json"), before, before);
  fs.copyFileSync(built, path.join(home, "bin", "kuvo-agents.js"));
  const said = await new Promise((resolve, reject) => {
    const asking = spawn(process.execPath, [script, "box", "route"], { env: { PATH: process.env.PATH, KUVO_HOME: home, HOME: path.join(home, "home"), TMPDIR: `${home}/tmp` }, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    asking.stdout.on("data", chunk => { out += chunk; });
    asking.on("error", reject);
    asking.on("close", () => { try { resolve(JSON.parse(JSON.parse(out.trim().split("\n").pop()).body).pieces); } catch (error) { reject(error); } });
    asking.stdin.end(JSON.stringify({ method: "GET", path: "kuvo/info" }));
  });
  assert.deepEqual(said.agents, { running: null, current: said.agents.current, behind: true, renewal: null, waits: "restart" }, "an older bridge, which doesn't make way by itself");
  assert.match(said.agents.current, /^[0-9a-f]{64}$/);
  assert.deepEqual(said.engine, { running: "2.2.5", current: "2.2.6", behind: true });
  assert.equal(said.link.behind, false, "no link runs here");
});

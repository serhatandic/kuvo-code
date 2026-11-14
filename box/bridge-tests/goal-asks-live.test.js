// What a bot on a goal asks you goes from the goal's list as soon as you answer it, on the real
// engine with a real model: the bot asks its question in its conversation, the box's watch over
// goals lists it with what else waits for you, and once you answer, the engine's own event takes it
// off the list, without the watch's next look; what the bot kept as waiting for that step goes once
// it goes on with the step. The real box script and a real engine on a free model, in folders of
// the test's own; only the coding agents' bridge is a stand-in. Skipped unless OPENCODE_TEST_BINARY
// names the engine.
//
// Run with `OPENCODE_TEST_BINARY=<opencode> node --test box/bridge-tests/goal-asks-live.test.js`,
// with `KUVO_TEST_MODEL=<id>` for another of OpenCode's free models than the engine's default. For a
// provider's model with a key of its own (say OpenCode Go's), also `KUVO_TEST_PROVIDER=<its id>` and
// `KUVO_TEST_AUTH=<an engine's sign-ins>`: its `opencode.db` (the engine's data folder) or an
// opencode `auth.json`, with KUVO_TEST_MODEL, so it never runs on a paid default nobody picked. Only
// that provider's key is read from it, opened read-only, and only this test's own engine gets it, in
// its folders deleted afterwards; a sign-in that renews itself is refused, as the copy renewing it
// would sign the original out.
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

const binary = process.env.OPENCODE_TEST_BINARY;
const provider = process.env.KUVO_TEST_PROVIDER ?? "opencode";

/** `provider`'s key in the engine's sign-ins at `file`, in the engine's form for `api/credential`
 * (`{type: "key", key}`): from its database, or from an `auth.json`. Opened only to read; what
 * fails to read says nothing of what's in it. */
async function keyFrom(file, provider) {
  const start = Buffer.alloc(16);
  const handle = fs.openSync(file, "r");
  try { fs.readSync(handle, start, 0, 16, 0); } finally { fs.closeSync(handle); }
  let value;
  try {
    if (start.toString("latin1") === "SQLite format 3\0") {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const row = db.prepare("SELECT value FROM credential WHERE integration_id = ? AND active = 1 ORDER BY time_updated DESC LIMIT 1").get(provider);
        value = row && JSON.parse(row.value);
      } finally {
        db.close();
      }
    } else {
      const entry = JSON.parse(fs.readFileSync(file, "utf8"))[provider];
      value = entry?.type === "api" ? { type: "key", key: entry.key, ...(entry.metadata ? { metadata: entry.metadata } : {}) } : entry;
    }
  } catch {
    assert.fail(`${file} isn't an engine's database or an auth.json, or can't be read`);
  }
  assert.ok(value, `${file} has no sign-in for ${provider}`);
  assert.ok(value.type === "key" && typeof value.key === "string" && value.key, `${provider}'s sign-in in ${file} isn't a key (${value.type}): a copy renewing it would sign the original out`);
  return value;
}

test("answering a bot's question takes it off its goal's list at once, and what held up a step goes once the bot goes on with it", { skip: !binary && "OPENCODE_TEST_BINARY isn't set", timeout: 600_000 }, async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-goal-asks-live-")));
  removeAtEnd(home);
  for (const folder of ["tmp", "xdg/config", "xdg/data", "xdg/state", "xdg/cache", "bin"]) fs.mkdirSync(path.join(home, folder), { recursive: true });
  process.env.KUVO_HOME = home;
  const link = await import("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js");
  const script = fileURLToPath(new URL("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const waitFor = async (wanted, what) => {
    const end = Date.now() + 240_000;
    for (;;) {
      const found = await wanted().catch(error => { if (error instanceof assert.AssertionError) throw error; return null; });
      if (found) return found;
      assert.ok(Date.now() < end, `Waited too long for ${what}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  };

  // Pixel, a bot here, and its conversation's folder.
  const pixelFolder = path.join(home, "bots", "bot_pixel00001");
  const workspace = path.join(pixelFolder, "workspace");
  fs.mkdirSync(workspace, { recursive: true });

  // The engine, as the box starts it, with no accounts: its default model is a free one.
  const env = {
    PATH: process.env.PATH, HOME: home, TMPDIR: `${home}/tmp/`, XDG_CONFIG_HOME: `${home}/xdg/config`, XDG_DATA_HOME: `${home}/xdg/data`,
    XDG_STATE_HOME: `${home}/xdg/state`, XDG_CACHE_HOME: `${home}/xdg/cache`, OPENCODE_PASSWORD: "pw",
    OPENCODE_CONFIG_CONTENT: link.engineConfigContent(undefined),
  };
  const child = spawn(binary, ["serve", "--stdio", "--port", "0"], { env, cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
  atEnd(() => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.on("exit", resolve); child.stdin.end(); child.kill(); }));
  const port = await new Promise((resolve, reject) => {
    let said = "";
    const look = chunk => { said += chunk; const found = said.match(/127\.0\.0\.1:(\d+)/); if (found) resolve(Number(found[1])); };
    child.stdout.on("data", look);
    child.stderr.on("data", look);
    child.on("exit", code => reject(new Error(`The engine ended (${code}): ${said}`)));
  });
  const target = { port, password: "pw" };
  const auth = { authorization: "Basic " + Buffer.from("opencode:pw").toString("base64"), "content-type": "application/json", "x-opencode-directory": encodeURIComponent(workspace) };
  const api = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/${route}`, { method, headers: auth, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  await waitFor(async () => (await api("GET", "api/model/default")).status === 200, "the engine to start");
  // The engine's default model, or the one KUVO_TEST_MODEL names (a free one, or with KUVO_TEST_AUTH's
  // key, KUVO_TEST_PROVIDER's), which the engine must list.
  if (process.env.KUVO_TEST_AUTH) {
    assert.ok(process.env.KUVO_TEST_MODEL, "KUVO_TEST_AUTH needs KUVO_TEST_MODEL, the model to run on with that key");
    const value = await keyFrom(process.env.KUVO_TEST_AUTH, provider);
    const stored = await api("POST", "api/credential", { integrationID: provider, label: "API key", value, activate: true });
    assert.ok(stored.status < 300, `The engine didn't take ${provider}'s key (${stored.status})`);
  }
  const model = process.env.KUVO_TEST_MODEL ? { model: { providerID: provider, id: process.env.KUVO_TEST_MODEL } } : {};
  if (model.model) {
    // (Its list can change a moment after it starts, or after a key: it's given half a minute.)
    let listed = [];
    const end = Date.now() + 30_000;
    for (;;) {
      listed = ((await api("GET", "api/model")).json?.data ?? []).filter(each => each.providerID === provider).map(each => each.id);
      if (listed.includes(model.model.id)) break;
      assert.ok(Date.now() < end, `The engine doesn't list ${provider}/${model.model.id}; it lists ${listed.join(", ") || "none of that provider's"}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  const session = (await api("POST", "api/session", { title: "Pixel", location: { directory: workspace }, ...model })).json.data.id;

  // The coding agents' bridge, a stand-in: the conversation's goal (its loop), as it's set.
  const loops = new Map();
  const bridge = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      const pathname = new URL(request.url, "http://x").pathname;
      if (pathname === "/api/kuvo/goals") return reply({ data: [...loops.values()] });
      const found = pathname.match(/^\/api\/kuvo\/goals\/([^/]+)$/);
      if (!found) return reply({ message: "Not here." }, 404);
      const id = decodeURIComponent(found[1]);
      if (request.method === "PUT") loops.set(id, { session: id, ...JSON.parse(body), state: "working" });
      if (request.method === "DELETE") loops.delete(id);
      return loops.has(id) ? reply({ data: loops.get(id) }) : reply({ message: "That conversation has no goal." }, 404);
    });
  });
  await new Promise(resolve => bridge.listen(0, "127.0.0.1", resolve));
  const bridgeProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)", "kuvo-agents"], { stdio: "ignore" });
  atEnd(() => { bridge.closeAllConnections(); bridge.close(); bridgeProcess.kill(); });

  write(path.join(pixelFolder, "bot.json"), JSON.stringify({ kuvo: 1, id: "bot_pixel00001", name: "Pixel", job: "Builds apps.", look: { color: "graphite", shape: "squircle", face: "bright" }, created: "2026-10-01T09:00:00Z", updated: "2026-10-01T09:00:00Z" }));
  write(path.join(pixelFolder, "session"), session);
  write(path.join(home, "run", "engine.json"), JSON.stringify({ port, password: "pw", version: "0.0.0" }));
  write(path.join(home, "run", "bridge.json"), JSON.stringify({ port: bridge.address().port, password: "p", pid: bridgeProcess.pid }));
  fs.copyFileSync(new URL("../../swift/KuvoLink/Sources/KuvoLink/Resources/bot-words.json", import.meta.url), path.join(home, "bin", "bot-words.json"));

  // The box's answer to one request, as a machine's tool asks it: a process of its own.
  const route = (method, pathname, body) => new Promise((resolve, reject) => {
    const env = { ...process.env, KUVO_HOME: home, HOME: home, TMPDIR: `${home}/tmp`, KUVO_TEST_SANDBOX_ON: "1" };
    const process_ = spawn(process.execPath, [script, "box", "route"], { env, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    process_.stdout.on("data", chunk => { out += chunk; });
    process_.on("error", reject);
    process_.on("close", () => {
      const said = JSON.parse(out.trim().split("\n").pop());
      resolve({ status: said.status, body: JSON.parse(said.body) });
    });
    process_.stdin.end(JSON.stringify({ method, path: pathname, body }));
  });
  const tool = async (name, args) => (await route("POST", "kuvo/agent-tools", { name, arguments: args, session })).body;
  const waiting = async () => (await route("GET", "kuvo/work/goals")).body.goals[0].waiting;

  // Pixel's goal, started.
  const proposed = await tool("propose_goal", { goal: "Make a plant care app.", title: "Plant care app", steps: [{ text: "Concept" }, { text: "Design", after: [1] }, { text: "Build the app", after: [2] }] });
  assert.equal(proposed.isError, false, proposed.text);
  const [goal] = (await route("GET", "kuvo/work/goals")).body.goals;
  assert.equal((await route("POST", `kuvo/work/goals/${goal.id}`, { action: "start" })).status, 200);

  // Its first turn, on the goal's start, is stopped (the engine's interrupt) once it's under way, with
  // what it set going in the background: that turn works through the goal for minutes, which isn't
  // what this checks, and on Interactive the bot may end it asking a call of its own (a brand, say),
  // so it never goes idle by itself. (Not before it's under way: a question asked then would join
  // that turn.) Stopped before the box's watch starts, so the box doesn't hold the conversation's
  // queue as after your Stop.
  await waitFor(async () => {
    const page = (await api("GET", `api/session/${session}/message?limit=50`)).json?.data ?? [];
    const running = await api("GET", "api/session/active");
    assert.equal(running.status, 200, "the engine says what's at work");
    const active = Object.keys(running.json.data);
    if (page.some(each => each.type === "idle") && active.length === 0) return true;
    for (const each of active.length ? active : [session]) await api("POST", `api/session/${each}/interrupt`);
    return false;
  }, "the bot's first turn to stop");

  // The box's watch over the engine's events, as it runs.
  const stop = new AbortController();
  atEnd(() => stop.abort());
  link.watchEvents(() => target, () => true, stop.signal, () => {}, { work: "engine" });

  // It asks you, on the free model, with its question tool.
  await api("POST", `api/session/${session}/prompt`, { id: "msg_goalaskslive00001", delivery: "steer",
    text: "Use your question tool now to ask me one question, \"Go with LeafCheck, or change it?\", with the choices \"Go with LeafCheck\" and \"Change it\". Write nothing else." });
  const [form] = await waitFor(async () => {
    const forms = (await api("GET", `api/session/${session}/form`)).json?.data ?? [];
    const ours = forms.find(each => JSON.stringify(each.fields ?? []).includes("LeafCheck"));
    if (ours) return [ours];
    // Its turn ended without asking: what the model said, say a free model's limit.
    const page = (await api("GET", `api/session/${session}/message?limit=50`)).json?.data ?? [];
    const ended = page.findIndex(each => each.type === "idle");
    const asked = page.findIndex(each => each.id === "msg_goalaskslive00001");
    if (ended >= 0 && asked >= 0 && ended < asked) assert.fail(`The bot's turn ended without asking: ${page[ended].error?.message ?? page[ended].outcome}`);
    return null;
  }, "the bot's question");
  // The box's watch lists it with what else waits for you; the bot keeps the decision too.
  await link.lookAtGoals(() => true, () => [target], { now: Date.now() });
  assert.equal((await waiting()).filter(each => each.kind === "ask" && each.session === session).length, 1, "its question waits for you on the goal");
  assert.equal((await tool("goal_progress", { waiting: { kind: "judgment", text: "Approve the concept before designing", step: 2 } })).isError, false);

  // You answer it, in its conversation: the engine says so, and its row goes, with no look between.
  const answered = await api("POST", `api/session/${session}/form/${form.id}/reply`, { answer: { [form.fields[0].key]: "Go with LeafCheck" } });
  assert.ok(answered.status < 300, JSON.stringify(answered.json));
  await waitFor(async () => !(await waiting()).some(each => each.kind === "ask"), "the answered question to leave the goal's list");
  assert.deepEqual((await waiting()).map(each => each.text), ["Approve the concept before designing"]);

  // The bot goes on with the step its decision held up: that's settled too.
  assert.match((await tool("goal_progress", { steps: [{ step: 2, state: "doing" }] })).text, /1 no longer waiting, as its step goes on/);
  assert.deepEqual(await waiting(), []);
});

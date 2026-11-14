// A question Codex asks in a conversation on Autopilot, whatever it does next: the real coding agents'
// bridge, the real box watching it, and a stand-in `codex app-server` that does what a real one was seen
// to do. Its question tool returns at once, its model goes on thinking, then sleeps for hours waiting on
// the answer; only new input for its turn ends that sleep. The live test beside this one
// (autopilot-codex-live.test.js) runs the same with a real model.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";
import { NO_BUN, testBun } from "./bun-for-tests.js";

const bun = testBun();
const agentsJS = fileURLToPath(new URL("../../swift/KuvoCode/Resources/kuvo-agents.js", import.meta.url));
const script = fileURLToPath(new URL("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));

// Its turn: each prompt says which question to ask. Answered, it says what it heard, and ends.
const FAKE = String.raw`
const { appendFileSync } = require("node:fs");
const send = message => process.stdout.write(JSON.stringify(message) + "\n");
let buffer = "", wake, turning = false, thread = 0;
const say = (method, threadId, params) => send({ method, params: { threadId, turnId: "u1", ...params } });
async function turn(threadId, text) {
  say("turn/started", threadId, { turn: { id: "u1" } });
  const options = /unmarked/.test(text) ? ["Monday", "Friday"] : ["Light", "Warm (Recommended)", "Dark"];
  say("item/completed", threadId, { item: { type: "agentMessage", id: "q1", phase: "final_answer", delivery: "async", text: "Which one?", questions: [{ title: "Which one?", options }] } });
  say("item/started", threadId, { item: { type: "reasoning", id: "r1", summary: [], content: [] } });
  say("item/completed", threadId, { item: { type: "reasoning", id: "r1", summary: [], content: [] } });
  say("item/started", threadId, { item: { type: "sleep", id: "s1", durationMs: 43200000 } });
  const heard = await new Promise(resolve => { wake = resolve; });
  say("item/completed", threadId, { item: { type: "sleep", id: "s1", durationMs: 43200000 } });
  say("item/started", threadId, { item: { type: "agentMessage", id: "m1", text: "" } });
  say("item/completed", threadId, { item: { type: "agentMessage", id: "m1", text: "Heard: " + heard } });
  turning = false;
  send({ method: "turn/completed", params: { threadId, turn: { id: "u1", status: "completed" } } });
}
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "t" + ++thread } } });
    else if (message.method === "turn/start") {
      turning = true;
      send({ id: message.id, result: { turn: { id: "u1", status: "inProgress" } } });
      void turn(message.params.threadId, message.params.input[0].text);
    } else if (message.method === "turn/steer") {
      send({ id: message.id, result: { turnId: "u1" } });
      wake?.(message.params.input[0].text);
      wake = undefined;
    } else if (message.method === "account/read") send({ id: message.id, result: { account: { type: "apiKey" } } });
    else if (message.method === "model/list") send({ id: message.id, result: { data: [{ id: "gpt-test", model: "gpt-test", displayName: "GPT Test", isDefault: true }] } });
    else if (message.id !== undefined) send({ id: message.id, result: {} });
  }
});
`;

test("on Autopilot, a Codex asleep for hours on its question goes on at once: marked, on its choice; unmarked, set aside; and in an Interactive conversation your answer wakes it", { skip: bun ? false : NO_BUN }, async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-codex-question-")));
  removeAtEnd(home);
  for (const folder of ["tmp", "work", "agents", "run", "bin", "codex-home", "fake"]) fs.mkdirSync(path.join(home, folder), { recursive: true });
  process.env.KUVO_HOME = home;
  const link = await import("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js");

  fs.writeFileSync(path.join(home, "fake", "app-server.js"), FAKE);
  fs.writeFileSync(path.join(home, "fake", "codex"), `#!/bin/sh\nexport BUN_BE_BUN=1\n[ "$1" = "--version" ] && { echo "codex-cli 0.166.0"; exit 0; }\nexec "${bun}" "${path.join(home, "fake", "app-server.js")}"\n`, { mode: 0o755 });

  const workspace = path.join(home, "work");
  const child = spawn(bun, [agentsJS], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: `${path.join(home, "fake")}:${process.env.PATH}`, HOME: home, TMPDIR: `${home}/tmp`, KUVO_AGENTS_HOME: path.join(home, "agents"), OPENCODE_PASSWORD: "pw", CODEX_HOME: path.join(home, "codex-home"), BUN_BE_BUN: "1" },
  });
  atEnd(() => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.on("exit", resolve); child.stdin.end(); child.kill(); }));
  const port = await new Promise((resolve, reject) => {
    let said = "";
    const look = chunk => { said += chunk; const found = said.match(/127\.0\.0\.1:(\d+)/); if (found) resolve(Number(found[1])); };
    child.stdout.on("data", look);
    child.stderr.on("data", look);
    child.on("exit", code => reject(new Error(`The agents' bridge ended (${code}): ${said}`)));
  });
  const target = { port, password: "pw" };
  const auth = { authorization: "Basic " + Buffer.from("opencode:pw").toString("base64"), "content-type": "application/json", "x-opencode-directory": encodeURIComponent(workspace) };
  const api = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/${route}`, { method, headers: auth, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  fs.writeFileSync(path.join(home, "run", "bridge.json"), JSON.stringify({ port, password: "pw", pid: child.pid }));
  fs.copyFileSync(new URL("../../swift/KuvoLink/Sources/KuvoLink/Resources/bot-words.json", import.meta.url), path.join(home, "bin", "bot-words.json"));

  const route = (method, pathname, body) => new Promise((resolve, reject) => {
    const process_ = spawn(process.execPath, [script, "box", "route"], { env: { ...process.env, KUVO_HOME: home, HOME: home, TMPDIR: `${home}/tmp` }, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    process_.stdout.on("data", chunk => { out += chunk; });
    process_.on("error", reject);
    process_.on("close", () => {
      const said = JSON.parse(out.trim().split("\n").pop());
      resolve({ status: said.status, body: JSON.parse(said.body) });
    });
    process_.stdin.end(JSON.stringify({ method, path: pathname, body }));
  });

  // The box's watch over the bridge's events, as it runs.
  const told = [];
  const stop = new AbortController();
  atEnd(() => stop.abort());
  link.watchEvents(() => target, notice => { told.push(notice); return true; }, stop.signal, () => {}, { work: "bridge" });

  const events = [];
  const listen = new AbortController();
  atEnd(() => listen.abort());
  fetch(`http://127.0.0.1:${port}/api/event`, { headers: { authorization: auth.authorization, accept: "text/event-stream" }, signal: listen.signal }).then(async response => {
    let rest = "";
    for await (const chunk of response.body) {
      rest += Buffer.from(chunk).toString();
      for (let end = rest.indexOf("\n\n"); end >= 0; end = rest.indexOf("\n\n")) {
        for (const line of rest.slice(0, end).split("\n")) if (line.startsWith("data:")) try { events.push(JSON.parse(line.slice(5))); } catch {}
        rest = rest.slice(end + 2);
      }
    }
  }).catch(() => {});

  const until = async (wanted, what) => {
    for (let waited = 0; waited < 60_000; waited += 20) {
      const found = await wanted();
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`Waited too long for ${what}`);
  };
  await until(() => events.length > 0, "the event feed to open");

  const page = async session => (await api("GET", `api/session/${session}/message?limit=100`)).json?.data ?? [];
  const forms = async session => (await api("GET", `api/session/${session}/form`)).json?.data ?? [];
  const textOf = messages => messages.filter(each => each.type === "assistant").flatMap(each => each.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");
  const make = async (title, autopilot) => {
    const made = await api("POST", "api/session", { title, location: { directory: workspace }, model: { providerID: "codex-cli", id: "gpt-test" } });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    if (autopilot) assert.equal((await route("PUT", `kuvo/sessions/${made.json.data.id}/autopilot`, { autopilot: true })).status, 200);
    return made.json.data.id;
  };
  const send = async (session, id, text) => assert.equal((await api("POST", `api/session/${session}/prompt`, { id, delivery: "steer", text })).status, 200);
  const finished = session => until(async () => { const messages = await page(session); return messages[0]?.type === "idle" ? messages : null; }, "its turn to end");
  /** How the question `session` asked was settled there, as the event feed comes to say. */
  const settled = session => until(() => {
    const asked = events.find(each => each.type === "form.created" && each.data?.form?.sessionID === session);
    return asked && events.find(each => ["form.replied", "form.cancelled"].includes(each.type) && each.data?.id === asked.data.form.id)?.type;
  }, "its question to be settled");
  // (What it decided is kept just after it's answered, which its turn may beat.)
  const decided = async session => (await route("GET", `kuvo/sessions/${session}/autopilot`)).body.decided;

  await t.test("marked: it goes ahead on the choice, the sleep ends, and nobody's told", async () => {
    const session = await make("Roast", true);
    await send(session, "msg_codexquestion0001", "ask");
    const messages = await finished(session);
    assert.match(textOf(messages), /Heard: Warm/);
    assert.equal(await settled(session), "form.replied");
    const [call, ...more] = await until(async () => { const made = await decided(session); return made.length ? made : null; }, "its call to be kept");
    assert.match(call.choice, /^Warm/);
    assert.deepEqual(more, []);
    assert.equal(messages.filter(each => each.type === "idle").length, 1, "the answer started no second turn");
    assert.deepEqual(told.filter(each => each.thread === session && each.data?.request), []);
  });

  await t.test("unmarked: it comes back declined with the words, the sleep ends, no call is kept, and nobody's told", async () => {
    const session = await make("Day", true);
    await send(session, "msg_codexquestion0002", "ask unmarked");
    const messages = await finished(session);
    assert.match(textOf(messages), /Heard: .*(This is on Autopilot|nothing to wait for)/s);
    assert.equal(await settled(session), "form.cancelled");
    assert.deepEqual(await decided(session), []);
    assert.deepEqual(told.filter(each => each.thread === session && each.data?.request), []);
  });

  await t.test("Interactive: the question waits for you, however long it sleeps, and your answer wakes it", async () => {
    const session = await make("Yours", false);
    await send(session, "msg_codexquestion0003", "ask");
    const [form] = await until(async () => { const open = await forms(session); return open.length ? open : null; }, "its question to show");
    assert.equal((await page(session))[0]?.type === "idle", false, "its turn is still going");
    assert.deepEqual(events.filter(each => ["form.replied", "form.cancelled"].includes(each.type) && each.data?.id === form.id), [], "nothing's answered it for you");
    const key = form.fields[0].key;
    assert.equal((await api("POST", `api/session/${session}/form/${form.id}/reply`, { answer: { [key]: "Dark" } })).status, 200);
    const messages = await finished(session);
    assert.match(textOf(messages), /Heard: Dark/);
    assert.deepEqual(await decided(session), []);
  });
});

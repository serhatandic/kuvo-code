// A bot hands its steps only to models that can answer (PROTOCOL.md, "Work"): when a session it
// started fails because its model's account is out of funds or at a limit, the bot hears why, the
// models of that account that cost something drop out of list_models (its free ones stay),
// start_session on one of them says so and names a model that can, and a start it waits on ends as
// soon as the session stops, with why; once a paid session on it answers, or its key changes, it's
// back. A model that's only busy (overloaded) isn't held back. As on the user's Mac, where a bot on OpenCode Go kept starting
// sessions on OpenCode Zen with no funds, none of them telling it why, and a start it waited on hung
// for ten minutes. The real tool and box script; only the engine is a stand-in, and the watcher's
// clock is the test's.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/bots-dead-models.test.js`.
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

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-dead-models-")));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
const tool = fileURLToPath(new URL("../../../../KuvoCode/Resources/kuvo-browser.js", import.meta.url));
fs.mkdirSync(path.join(home, "bin"), { recursive: true });
fs.copyFileSync(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url), path.join(home, "bin", "kuvo-link.js"));

const app = path.join(home, "work", "the-app");
fs.mkdirSync(app, { recursive: true });
const by = { bot: "bot_mobile00001", name: "Mobile App Expert" };
const go = { providerID: "opencode-go", id: "deepseek-v4.1-flash" };
const zen = id => ({ providerID: "opencode", id, variant: "high" });
const funds = { type: "provider.quota", message: "Upstream request failed: Insufficient account funds", status: 402 };
const sessions = {
  ses_lead: { id: "ses_lead", title: "Mobile App Expert", location: { directory: app }, model: go, time: { created: 1, updated: 1 } },
  ses_concept: { id: "ses_concept", title: "Pick the concept", location: { directory: app }, model: zen("claude-opus-5-5"), time: { created: Date.now(), updated: 1 }, metadata: { kuvo: { startedBy: "ses_lead", by, depth: 1, wake: ["finished", "asks"] } } },
  ses_build: { id: "ses_build", title: "Build the core app", location: { directory: app }, model: zen("gpt-6.1-sol"), time: { created: Date.now(), updated: 1 }, metadata: { kuvo: { startedBy: "ses_lead", by, depth: 1, wake: ["finished", "asks"] } } },
  ses_free: { id: "ses_free", title: "Name the app", location: { directory: app }, model: { providerID: "opencode", id: "deepseek-v4.1-flash-free" }, time: { created: Date.now(), updated: 1 }, metadata: { kuvo: { startedBy: "ses_lead", by, depth: 1, wake: ["finished", "asks"] } } },
  ses_busy: { id: "ses_busy", title: "Write the copy", location: { directory: app }, model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" }, time: { created: Date.now(), updated: 1 }, metadata: { kuvo: { startedBy: "ses_lead", by, depth: 1, wake: ["finished", "asks"] } } },
};
// Each session's messages, oldest first: the concept's turn failed before it wrote anything.
const messages = {
  ses_concept: [
    { id: "msg_1", type: "user", text: "Pick the concept for a new iOS app." },
    { id: "msg_2", type: "assistant", model: zen("claude-opus-5-5"), content: [], finish: "error", error: funds },
    { id: "msg_3", type: "idle", outcome: "failed", error: funds },
  ],
  ses_build: [
    { id: "msg_4", type: "user", text: "Build it." },
    { id: "msg_5", type: "assistant", model: zen("gpt-6.1-sol"), content: [{ type: "text", text: "Built it, with tests." }] },
    { id: "msg_6", type: "idle", outcome: "succeeded" },
  ],
  ses_free: [
    { id: "msg_7", type: "user", text: "Name it." },
    { id: "msg_8", type: "assistant", content: [{ type: "text", text: "Pocket Ledger." }] },
    { id: "msg_9", type: "idle", outcome: "succeeded" },
  ],
};
const models = [
  { id: "claude-opus-5-5", providerID: "opencode", name: "Claude Opus 5.5", variants: [{ id: "high" }], cost: [{ input: 5, output: 25 }] },
  { id: "gpt-6.1-sol", providerID: "opencode", name: "GPT-6.1 Sol", variants: [{ id: "high" }], cost: [{ input: 1.25, output: 10 }] },
  { id: "deepseek-v4.1-flash-free", providerID: "opencode", name: "DeepSeek V4.1 Flash Free", variants: [], cost: [{ input: 0, output: 0 }] },
  { id: "deepseek-v4.1-flash", providerID: "opencode-go", name: "DeepSeek V4.1 Flash", variants: [{ id: "low" }, { id: "high" }], cost: [{ input: 0.2, output: 0.8 }] },
];
let prompts = [];
let made = 0;
const engine = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (request.url === "/api/provider") return reply({ data: [{ id: "opencode" }, { id: "opencode-go" }] });
    if (request.url === "/api/model") return reply({ data: models });
    if (request.url.startsWith("/api/session?")) return reply({ data: Object.values(sessions) });
    if (request.url === "/api/session/active") return reply({ data: {} });
    if (request.method === "POST" && request.url === "/api/session") {
      const id = `ses_new${++made}`;
      sessions[id] = { id, location: { directory: app }, ...JSON.parse(body || "{}"), time: { created: Date.now(), updated: 1 } };
      return reply({ data: sessions[id] });
    }
    const one = request.url.match(/^\/api\/session\/([^/?]+)(\/[^?]*)?(\?.*)?$/);
    const id = one && decodeURIComponent(one[1]);
    if (one && !one[2] && request.method === "GET") return sessions[id] ? reply({ data: sessions[id] }) : reply({ message: "No such session." }, 404);
    if (one && !one[2] && request.method === "PATCH") {
      Object.assign(sessions[id] ??= { id }, JSON.parse(body || "{}"));
      return reply({ data: sessions[id] });
    }
    if (one?.[2] === "/permission" || one?.[2] === "/form") return reply({ data: [] });
    if (one?.[2] === "/message") {
      const all = messages[id] ?? [];
      return reply({ data: /order=desc/.test(one[3] ?? "") ? [...all].reverse() : all });
    }
    if (one?.[2] === "/prompt") {
      const prompt = JSON.parse(body);
      prompts.push({ to: id, ...prompt });
      // A new session on the account out of funds fails at once, before anyone sees it at work.
      if (id.startsWith("ses_new") && sessions[id]?.model?.providerID === "opencode") messages[id] = [{ id: prompt.id, type: "user", text: prompt.text }, { id: prompt.id + "~", type: "idle", outcome: "failed", error: funds }];
      return reply({});
    }
    reply({});
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
const source = { port: engine.address().port, password: "p" };
fs.mkdirSync(path.join(home, "run"), { recursive: true });
fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify({ ...source, version: "0.0.0" }));

// The bot's tools, as the engine starts them, and its calls, as the engine makes them.
const mcp = spawn(process.execPath, [tool, "mcp"], { env: { ...process.env, KUVO_HOME: home }, stdio: ["pipe", "pipe", "ignore"] });
atEnd(() => mcp.kill());
const answers = new Map();
let buffer = "";
mcp.stdout.on("data", chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    answers.get(message.id)?.(message.result);
  }
});
let next = 1;
function call(name, args, session = "ses_lead") {
  const id = next++;
  return new Promise(resolve => {
    answers.set(id, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, _meta: { "ai.opencode/sessionID": session } } }) + "\n");
  });
}
mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }) + "\n");
const text = result => result.content?.[0]?.text ?? "";
// A client's request to the box (as a machine's is asked, a process of its own).
function route(method, pathname) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(home, "bin", "kuvo-link.js"), "box", "route"], { env: { ...process.env, KUVO_HOME: home }, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("error", reject);
    child.on("close", () => {
      const said = JSON.parse(out.trim().split("\n").pop());
      resolve({ status: said.status, body: JSON.parse(said.body) });
    });
    child.stdin.end(JSON.stringify({ method, path: pathname }));
  });
}

// The watcher's clock: what it would run later, run when the test says.
const later = [];
const watch = link.workWatcher(source, () => [source], { schedule: run => { later.push(run); } });
const runAll = async () => { for (const run of later.splice(0)) await run(); };

test("a session that fails for want of funds tells its bot why, and the bot moves its work to a model that can answer", async () => {
  // (As the engine tells it: the error with the event.)
  await watch({ type: "session.execution.failed", data: { sessionID: "ses_concept", error: funds } });
  await runAll();
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].to, "ses_lead");
  assert.match(prompts[0].text, /^\[Session failed\] "Pick the concept" in the-app \(address ses_concept\) stopped: No paid opencode model can answer now: Upstream request failed: Insufficient account funds \(since /, "the bot hears why, and that the account can't");
  assert.match(prompts[0].text, /start it again on a model that can, from list_models/);

  const listed = text(await call("list_models", {}));
  assert.match(listed, /^- opencode-go\/deepseek-v4\.1-flash \(DeepSeek V4\.1 Flash\)/m, "a model that answers is there");
  assert.match(listed, /^- opencode\/deepseek-v4\.1-flash-free \(DeepSeek V4\.1 Flash Free\)/m, "and the account's free one, which spends no funds");
  assert.doesNotMatch(listed, /^- opencode\/(claude-opus-5-5|gpt-6\.1-sol)/m, "none of the account's paid ones is offered");
  assert.match(listed, /Left out, as a session on them just failed:\n- No paid opencode model can answer now: Upstream request failed: Insufficient account funds/);

  const again = await call("start_session", { task: "Pick the concept.", title: "Pick the concept", folder: app, model: "opencode/gpt-6.1-sol", effort: "high" });
  assert.equal(again.isError ?? false, false, "the bot may still try it: it may answer again");
  assert.match(text(again), /No paid opencode model can answer now: Upstream request failed: Insufficient account funds .*so this may fail the same way/, "but it hears it may not");
  assert.match(text(again), /like the one you run on \(opencode-go\/deepseek-v4\.1-flash\)/, "and which one can");

  const moved = await call("start_session", { task: "Pick the concept.", title: "Pick the concept", folder: app, model: "opencode-go/deepseek-v4.1-flash", effort: "high" });
  assert.equal(moved.isError ?? false, false, text(moved));
  assert.match(text(moved), /\(address ses_new\d+\)/);

  const read = text(await call("read_conversation", { of: "ses_concept" }));
  assert.match(read, /\*\*Stopped\*\*\n\nIt stopped with an error: Upstream request failed: Insufficient account funds/, "its conversation shows why it stopped");
});

test("a client's model picker reads the same: which account's models can't answer, and why", async () => {
  const { status, body } = await route("GET", "kuvo/work/unanswering");
  assert.equal(status, 200);
  assert.equal(body.held.length, 1);
  assert.deepEqual({ ...body.held[0], since: 0, until: 0 }, { provider: "opencode", only: "paid", models: ["claude-opus-5-5", "gpt-6.1-sol"], why: "Upstream request failed: Insufficient account funds", since: 0, until: 0 }, "the models it covers named, so a picker marks the ones bots are kept off, its free one not among them");
  assert.ok(body.held[0].until > Date.now() && body.held[0].until - body.held[0].since === 30 * 60_000, "for half an hour, as the error names no reset");
});

test("a free model answering, or another account changing, says nothing of the account's funds; a paid one answering does", async () => {
  prompts = [];
  await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_free" } });
  await watch({ type: "credential.updated", data: null });
  await watch({ type: "credential.switched", data: { integrationID: "opencode-go", credentialID: "cred_1" } });
  await runAll();
  assert.match(text(await call("list_models", {})), /Left out, as a session on them just failed:\n- No paid opencode model/);
  await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_build" } });
  await runAll();
  assert.match(prompts.map(prompt => prompt.text).join("\n\n"), /^\[Session finished\] "Build the core app"/m);
  const listed = text(await call("list_models", {}));
  assert.match(listed, /^- opencode\/claude-opus-5-5 \(Claude Opus 5\.5\)/m);
  assert.doesNotMatch(listed, /Left out/);
});

test("a new key for that account offers its models again", async () => {
  await watch({ type: "session.execution.failed", data: { sessionID: "ses_concept", error: funds } });
  assert.match(text(await call("list_models", {})), /Left out/);
  await watch({ type: "credential.switched", data: { integrationID: "opencode", credentialID: "cred_2" } });
  assert.doesNotMatch(text(await call("list_models", {})), /Left out/);
  await runAll();
});

test("a model that's only busy isn't held back", async () => {
  prompts = [];
  messages.ses_busy = [{ id: "msg_10", type: "user", text: "Write it." }, { id: "msg_11", type: "idle", outcome: "failed", error: { type: "provider.unknown", message: "Overloaded" } }];
  await watch({ type: "session.execution.failed", data: { sessionID: "ses_busy", error: { type: "provider.unknown", message: "Overloaded" } } });
  await runAll();
  assert.match(prompts[0]?.text ?? "", /^\[Session failed\] "Write the copy" in the-app \(address ses_busy\) stopped with an error: Overloaded\. Read it with read_conversation/);
  assert.doesNotMatch(text(await call("list_models", {})), /Left out/);
});

test("a session started and waited for whose model fails at once answers its starter with why, as soon as it stops", async () => {
  const waited = await call("start_session", { task: "Reply with PING OK.", title: "Harness ping", folder: app, model: "opencode/claude-opus-5-5", effort: "high", wait: true });
  assert.equal(waited.isError, true, text(waited));
  assert.match(text(waited), /^Started "Harness ping" in the-app \(address ses_new\d+\): Claude Opus 5\.5 · high\. It stopped with an error before it answered: No paid opencode model can answer now: Upstream request failed: Insufficient account funds/);
  assert.match(text(await call("list_models", {})), /Left out, as a session on them just failed:\n- No paid opencode model/, "and the box knows it can't, without waiting for the watcher");
});

// As OpenCode's free usage runs out on a computer with no account: every free model fails the same.
test("a free model at its account's free-usage limit holds back the account's free ones, until a free one answers", async () => {
  prompts = [];
  const spent = { type: "provider.free-limit", message: "Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.", status: 429 };
  sessions.ses_pickle = { id: "ses_pickle", title: "Sketch the screens", location: { directory: app }, model: { providerID: "opencode", id: "deepseek-v4.1-flash-free" }, time: { created: Date.now(), updated: 1 }, metadata: { kuvo: { startedBy: "ses_lead", by, depth: 1, wake: ["finished", "asks"] } } };
  await watch({ type: "session.execution.failed", data: { sessionID: "ses_pickle", error: spent } });
  await runAll();
  assert.match(prompts.map(prompt => prompt.text).join("\n\n"), /\[Session failed\] "Sketch the screens" in the-app \(address ses_pickle\) stopped: No free opencode model can answer now: Free usage limit reached/m);
  const listed = text(await call("list_models", {}));
  assert.doesNotMatch(listed, /^- opencode\/deepseek-v4\.1-flash-free/m, "no free one of that account is offered");
  const freeHold = (await route("GET", "kuvo/work/unanswering")).body.held.find(each => each.only === "free");
  assert.deepEqual(freeHold.models, ["deepseek-v4.1-flash-free"], "its free ones alone: none that costs something");
  assert.match(listed, /- No free opencode model can answer now: Free usage limit reached/);
  await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_build" } });
  assert.match(text(await call("list_models", {})), /- No free opencode model can answer now/, "a paid one answering says nothing of the free usage");
  await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_free" } });
  assert.doesNotMatch(text(await call("list_models", {})), /No free opencode model/, "a free one answering does");
  await runAll();
});

test("a bot on a model named by another id it's known by (Claude Code's default) is still pointed to the model it runs on", async () => {
  // The paid opencode models can't answer.
  await watch({ type: "session.execution.failed", data: { sessionID: "ses_concept", error: funds } });
  await runAll();
  const was = sessions.ses_lead.model;
  sessions.ses_lead.model = { providerID: "opencode-go", id: "default" };
  models[3].aliases = ["default"];
  try {
    const held = await call("start_session", { task: "Pick the concept.", title: "Pick the concept", folder: app, model: "opencode/gpt-6.1-sol", effort: "high" });
    assert.match(text(held), /so this may fail the same way/);
    assert.match(text(held), /like the one you run on \(opencode-go\/deepseek-v4\.1-flash\)/, "by the model's own id");
  } finally {
    sessions.ses_lead.model = was;
    delete models[3].aliases;
  }
});

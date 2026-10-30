// Agents' tools on a box (PROTOCOL.md, "Agents' tools"): list_agents, send_message,
// read_conversation and start_session answered by the box itself (`POST kuvo/agent-tools`), and a
// session started by a client (`POST kuvo/sessions`), each call by a process of its own as a
// machine's tools ask it (`kuvo-link.js box route`). The real box script on a folder of the test's
// own; only the engine is a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/agent-tools.test.js`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-agent-tools-")));
after(() => fs.rmSync(home, { recursive: true, force: true }));
const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const project = path.join(home, "work", "api");
const other = path.join(home, "work", "web");
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(other, { recursive: true });

// The engine: a lead conversation and its subagent, another session, a bot, a group chat's seat; what
// each was sent, and the sessions made.
const asks = "shell";
const sessions = new Map([
  ["ses_lead", { id: "ses_lead", title: "Lead", location: { directory: project }, model: { providerID: "openai", id: "gpt-5" }, permissions: [{ action: asks, resource: "*", effect: "ask" }], time: { created: 1, updated: 5 } }],
  ["ses_helper", { id: "ses_helper", parentID: "ses_lead", title: "Helper", location: { directory: project }, time: { created: 2, updated: 6 } }],
  ["ses_notes", { id: "ses_notes", title: "Release notes", location: { directory: other }, time: { created: 3, updated: 4 } }],
  ["ses_scout", { id: "ses_scout", title: "Scout", location: { directory: path.join(home, "bots", "bot_scout00001", "workspace") }, time: { created: 1, updated: 3 } }],
  ["ses_plan", { id: "ses_plan", title: "Plan", location: { directory: other }, time: { created: 3, updated: 4 } }],
  ["ses_quiet", { id: "ses_quiet", title: "Quiet", location: { directory: other }, time: { created: 3, updated: 4 } }],
  ["ses_seat", { id: "ses_seat", title: "Seat", location: { directory: project }, metadata: { kuvo: { seat: "grp_1" } }, time: { created: 1, updated: 2 } }],
]);
const messages = new Map([
  ["ses_plan", [
    { id: "msg_001", type: "user", text: "Write the release notes for 0.9." },
    { id: "msg_002", type: "assistant", content: [{ type: "tool", name: "read", state: { input: { filePath: "/x/CHANGELOG.md" } } }, { type: "text", text: "Done: three highlights, the rest as fixes." }] },
  ]],
]);
let prompts = [];
let made = [];
let marked = new Map();
let told = new Map();
let busy = new Map();
// What a conversation does with a message instead of answering it at once, given the message.
let replaceAnswer = {};
const promptHeard = [];
const engine = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/session" && request.method === "GET") return reply({ data: [...sessions.values()].filter(each => !each.parentID) });
    if (url.pathname === "/api/session" && request.method === "POST") {
      const given = JSON.parse(body);
      const id = `ses_new${made.length + 1}`;
      made.push({ id, ...given });
      sessions.set(id, { id, title: given.title, location: given.location, time: { created: 9, updated: 9 } });
      return reply({ data: { id } });
    }
    if (url.pathname === "/api/session/active") {
      // A session given a message is at work for one look, then answers.
      const active = Object.fromEntries([...busy.entries()].filter(([, looks]) => looks > 0).map(([id]) => [id, {}]));
      for (const [id, looks] of busy) busy.set(id, looks - 1);
      return reply({ data: active });
    }
    const one = url.pathname.match(/^\/api\/session\/([^/]+)(\/.*)?$/);
    const id = one && decodeURIComponent(one[1]);
    if (one && !one[2] && request.method === "GET") return sessions.has(id) ? reply({ data: sessions.get(id) }) : reply({ message: "No such session." }, 404);
    if (one && !one[2] && request.method === "PATCH") {
      marked.set(id, JSON.parse(body).metadata);
      return reply({ data: sessions.get(id) });
    }
    if (one?.[2] === "/prompt") {
      const given = JSON.parse(body);
      prompts.push({ to: id, ...given });
      for (const heard of promptHeard.splice(0)) heard();
      // One that never answers is at work for good.
      if (id === "ses_quiet") {
        busy.set(id, Infinity);
        return reply({});
      }
      // Its answer, after the message (ids sort by time).
      busy.set(id, 1);
      const answer = replaceAnswer[id]?.(given) ?? [{ id: given.id + "z", type: "assistant", content: [{ type: "text", text: `On it (${id}).` }] }];
      messages.set(id, [...(messages.get(id) ?? []), { id: given.id, type: "user", text: given.text }, ...answer]);
      return reply({});
    }
    if (one?.[2] === "/message") return reply({ data: [...(messages.get(id) ?? [])].reverse() });
    if (request.url.includes("/instructions/entries/")) {
      told.set(request.url.match(/session\/([^/]+)\//)[1] + " " + request.url.split("/").pop(), JSON.parse(body).value);
      return reply({});
    }
    reply({ message: "Not here." }, 404);
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
after(() => { engine.closeAllConnections(); engine.close(); });
write(path.join(home, "run", "engine.json"), JSON.stringify({ port: engine.address().port, password: "p", version: "0.0.0" }));
// A bot here, as its folder is.
const bot = path.join(home, "bots", "bot_scout00001");
write(path.join(bot, "bot.json"), JSON.stringify({ kuvo: 1, id: "bot_scout00001", name: "Scout", job: "Watches the build.", look: { color: "sky", shape: "round", face: "calm" }, created: "2026-10-01T09:00:00Z", updated: "2026-10-01T09:00:00Z" }));
write(path.join(bot, "session"), "ses_scout");
fs.mkdirSync(path.join(bot, "workspace"), { recursive: true });

beforeEach(() => {
  prompts = [];
  made = [];
  marked = new Map();
  told = new Map();
  busy = new Map();
  replaceAnswer = {};
  fs.rmSync(path.join(home, "run", "tool-limits.json"), { force: true });
});

// The box's answer to one request, as a machine's tool asks it: a process of its own (`started`
// gets it, to stop it).
function route(method, pathname, body, started = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "box", "route"], { env: { ...process.env, KUVO_HOME: home, HOME: home, TMPDIR: home }, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("error", reject);
    child.on("close", () => {
      const said = JSON.parse(out.trim().split("\n").pop());
      resolve({ status: said.status, body: JSON.parse(said.body) });
    });
    child.stdin.end(JSON.stringify({ method, path: pathname, body }));
    started(child);
  });
}
const tool = async (name, args, session) => (await route("POST", "kuvo/agent-tools", { name, arguments: args, session })).body;

test("list_agents names everyone here but the one asking (a subagent asks as its conversation)", async () => {
  const said = await tool("list_agents", {}, "ses_helper");
  assert.equal(said.isError, false);
  assert.match(said.text, /^Agents you can write to with send_message/);
  assert.match(said.text, /- Scout \(bot, here\) address: ses_scout: Watches the build\./);
  assert.match(said.text, /- Release notes \(session, here, in web\) address: ses_notes/);
  assert.doesNotMatch(said.text, /ses_lead|ses_helper|ses_seat/, "not itself, its subagent, nor a group chat's seat");
});

test("send_message reaches the agent named (with & or not), saying who it's from and how to answer", async () => {
  const said = await tool("send_message", { to: "&release NOTES", text: "Add the iPhone fixes." }, "ses_helper");
  assert.deepEqual(said, { text: "Sent to Release notes. Its answer, if it writes one, comes to you as a message.", isError: false });
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].to, "ses_notes");
  assert.equal(prompts[0].delivery, "steer");
  assert.equal(prompts[0].text, "[Message from Lead · ses_lead] (To answer, use send_message to ses_lead.)\n\nAdd the iPhone fixes.");
});

test("send_message to a name that isn't anyone's, or to itself, says why", async () => {
  const missing = await tool("send_message", { to: "Release", text: "Hi." }, "ses_lead");
  assert.equal(missing.isError, true);
  assert.match(missing.text, /^There's no agent called Release\. Did you mean one of these\?\n.*- Release notes/s);
  const self = await tool("send_message", { to: "ses_lead", text: "Hi." }, "ses_helper");
  assert.deepEqual(self, { text: "That's you.", isError: true });
  assert.equal(prompts.length, 0);
});

test("a conversation sends twenty messages in ten minutes at most, however many processes answer them", async () => {
  for (let count = 0; count < 20; count++) assert.equal((await tool("send_message", { to: "ses_notes", text: `Note ${count}` }, "ses_lead")).isError, false);
  const refused = await tool("send_message", { to: "ses_notes", text: "One more." }, "ses_lead");
  assert.deepEqual(refused, { text: "You've sent a lot of messages in the last few minutes. Wait a while, or ask the user how to go on.", isError: true });
  assert.equal(prompts.length, 20);
  // Another conversation's are its own.
  assert.equal((await tool("send_message", { to: "ses_notes", text: "Hi." }, "ses_scout")).isError, false);
});

test("send_message with wait gives back what the agent answered", async () => {
  const said = await tool("send_message", { to: "Scout", text: "Is the build green?", wait: true }, "ses_lead");
  assert.deepEqual(said, { text: "Scout answered:\n\nOn it (ses_scout).", isError: false });
  assert.match(prompts[0].text, /^\[Message from Lead · ses_lead\] \(They're waiting for your reply: just answer, in your words\.\)/);
});

test("send_message with wait gives back the answer to its message, not to one that came after it", async () => {
  // You write to Scout while it answers; its answer to you isn't the asker's.
  replaceAnswer.ses_scout = given => [
    { id: given.id + "a", type: "assistant", content: [{ type: "text", text: "On it (ses_scout)." }] },
    { id: given.id + "b", type: "user", text: "And the docs?" },
    { id: given.id + "c", type: "assistant", content: [{ type: "text", text: "The docs are done (for you, not the asker)." }] },
  ];
  const said = await tool("send_message", { to: "Scout", text: "Is the build green?", wait: true }, "ses_lead");
  assert.deepEqual(said, { text: "Scout answered:\n\nOn it (ses_scout).", isError: false });
});

test("send_message with wait gives back the whole answer, though a message came in while the agent was still at it", async () => {
  // Scout says what it's doing and runs a tool; your message is steered in; then it answers.
  replaceAnswer.ses_scout = given => [
    { id: given.id + "a", type: "assistant", content: [{ type: "text", text: "Checking the build…" }, { type: "tool", name: "shell", state: { input: { command: "make" } } }] },
    { id: given.id + "b", type: "user", text: "And the docs?" },
    { id: given.id + "c", type: "assistant", content: [{ type: "text", text: "The build is green." }] },
  ];
  const said = await tool("send_message", { to: "Scout", text: "Is the build green?", wait: true }, "ses_lead");
  assert.deepEqual(said, { text: "Scout answered:\n\nChecking the build…\n\nThe build is green.", isError: false });
});

test("read_conversation reads another's conversation as the export words it, or the parts a query finds", async () => {
  const whole = await tool("read_conversation", { of: "plan" }, "ses_lead");
  assert.equal(whole.isError, false);
  assert.equal(whole.text, "Plan's conversation (session, here, in web, address ses_plan), oldest first. What's under **User** is the user's; under **Plan**, its agent's.\n\n"
    + "# Plan\n\n**User**\n\nWrite the release notes for 0.9.\n\n**Plan**\n\n- read: /x/CHANGELOG.md\n\nDone: three highlights, the rest as fixes.\n");
  const found = await tool("read_conversation", { of: "ses_plan", query: "HIGHLIGHTS" }, "ses_lead");
  assert.match(found.text, /1 place mentions "HIGHLIGHTS" \(the rest left out as \[…\]\):\n\n- read: \/x\/CHANGELOG\.md\n\nDone: three highlights/);
  const self = await tool("read_conversation", { of: "Lead" }, "ses_helper");
  assert.deepEqual(self, { text: "That's this conversation: you have it already.", isError: true });
});

test("start_session starts one where its conversation works, on its model and approval, marked as started by it", async () => {
  const said = await tool("start_session", { task: "Review the docs.", title: "Review docs" }, "ses_helper");
  assert.equal(said.isError, false, said.text);
  assert.equal(said.text, "Started \"Review docs\" in api (address ses_new1). It's on it now. Write to it with send_message; it can write back to you the same way.");
  assert.equal(made.length, 1);
  assert.deepEqual(made[0].location, { directory: project });
  assert.equal(made[0].title, "Review docs");
  assert.deepEqual(made[0].model, { providerID: "openai", id: "gpt-5" });
  assert.ok(made[0].permissions.some(rule => rule.action === "shell" && rule.effect === "ask"), "it asks first, as its conversation does");
  assert.deepEqual(marked.get("ses_new1"), { kuvo: { startedBy: "ses_lead" } });
  assert.equal(prompts[0].to, "ses_new1");
  assert.equal(prompts[0].text, "[Message from Lead · ses_lead] (To answer, use send_message to ses_lead.)\n\nReview the docs.");
});

test("a session started from a conversation in Plan mode plans too; one from a conversation that builds builds", async () => {
  sessions.get("ses_lead").agent = "plan";
  try {
    assert.equal((await tool("start_session", { task: "Plan the docs." }, "ses_helper")).isError, false);
  } finally {
    delete sessions.get("ses_lead").agent;
  }
  assert.equal(made[0].agent, "plan", "the conversation's mode, not its subagent's");
  assert.equal((await tool("start_session", { task: "Write the docs." }, "ses_lead")).isError, false);
  assert.equal(made[1].agent, undefined, "the engine's own, build");
});

test("a bot starts its sessions in the chats; another conversation, six in ten minutes at most", async () => {
  const first = await tool("start_session", { task: "Look into the flaky test." }, "ses_scout");
  assert.match(first.text, /^Started a new session \(address ses_new1\)/);
  assert.equal(made[0].location.directory, path.join(home, "chats"));
  for (let count = 0; count < 6; count++) assert.equal((await tool("start_session", { task: `Task ${count}` }, "ses_notes")).isError, false);
  const refused = await tool("start_session", { task: "One more." }, "ses_notes");
  assert.deepEqual(refused, { text: "You've started several sessions in the last few minutes. Write to those (send_message), or ask the user before starting more.", isError: true });
  assert.equal(made.length, 7);
  // A bot's are its own to size (bots-work.test.js).
  assert.equal((await tool("start_session", { task: "Another." }, "ses_scout")).isError, false);
});

test("a group chat's seat neither writes to agents nor starts sessions", async () => {
  for (const name of ["send_message", "start_session"]) {
    const said = await tool(name, { to: "Scout", text: "Hi.", task: "Hi." }, "ses_seat");
    assert.deepEqual(said, { text: "Not from a group chat: talk it through here; the work is handed out after the wrap-up.", isError: true });
  }
  assert.equal(prompts.length + made.length, 0);
});

test("a client starts a session with a task, as the user's own first message", async () => {
  const started = await route("POST", "kuvo/sessions", { task: "Fix the login bug.", folder: other, title: "Login bug" });
  assert.equal(started.status, 200);
  assert.deepEqual(started.body, { session: "ses_new1", title: "Login bug", folder: other, project: "web" });
  assert.equal(prompts[0].text, "Fix the login bug.");
  assert.equal(marked.has("ses_new1"), false, "started by no conversation");

  const byAgent = await route("POST", "kuvo/sessions", { task: "Check the deploy.", startedBy: "ses_helper" });
  assert.equal(byAgent.status, 200);
  assert.deepEqual(marked.get(byAgent.body.session), { kuvo: { startedBy: "ses_lead" } });

  assert.deepEqual(await route("POST", "kuvo/sessions", { folder: other }), { status: 400, body: { message: "Say what it's to do (task)." } });
  assert.deepEqual(await route("POST", "kuvo/sessions", { task: "Hi.", folder: path.join(home, "nowhere") }),
    { status: 400, body: { message: `${path.join(home, "nowhere")} isn't a folder on this machine. Give a full path to one.` } });
  assert.deepEqual(await route("POST", "kuvo/sessions", { task: "Hi.", startedBy: "ses_gone" }), { status: 404, body: { message: "There's no such conversation here." } });
});

test("a tool call that waits for an answer, stopped by its caller, stops waiting and says so", async () => {
  const heard = new Promise(resolve => promptHeard.push(resolve));
  let child;
  const answering = route("POST", "kuvo/agent-tools", { name: "send_message", arguments: { to: "Quiet", text: "Still there?", wait: true }, session: "ses_lead" }, started => { child = started; });
  await heard;
  child.kill("SIGTERM");
  const { body } = await answering;
  assert.deepEqual(body, { text: "Quiet hasn't answered yet. It may still write back with send_message.", isError: false });
});

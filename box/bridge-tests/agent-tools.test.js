// Agents' tools on a box (PROTOCOL.md, "Agents' tools"): list_agents, send_message,
// read_conversation and start_session answered by the box itself (`POST kuvo/agent-tools`), and a
// session started by a client (`POST kuvo/sessions`), each call by a process of its own as a
// machine's tools ask it (`kuvo-link.js box route`). The real box script on a folder of the test's
// own; only the engine is a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/agent-tools.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-agent-tools-")));
removeAtEnd(home);
const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
// (The box's link itself, here, for what it hears of the engine.)
process.env.KUVO_HOME = home;
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
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
  ["ses_goal", { id: "ses_goal", title: "Launch", location: { directory: other }, time: { created: 3, updated: 4 } }],
  ["ses_seat", { id: "ses_seat", title: "Seat", location: { directory: project }, metadata: { kuvo: { seat: "grp_1" } }, time: { created: 1, updated: 2 } }],
]);
const messages = new Map([
  ["ses_plan", [
    { id: "msg_001", type: "user", text: "Write the release notes for 0.9." },
    { id: "msg_002", type: "assistant", content: [{ type: "tool", name: "read", state: { input: { filePath: "/x/CHANGELOG.md" } } }, { type: "text", text: "Done: three highlights, the rest as fixes." }] },
  ]],
  // A goal's conversation: what the box wrote to its agent (marked, and one from before it marked
  // them), and the user's own words.
  ["ses_goal", [
    { id: "msg_101", type: "user", text: "[Goal started] The user approved the plan. Work through it now: 1. Sign in.", metadata: { kuvo: { note: { from: "Goal", line: "Goal started" } } } },
    { id: "msg_102", type: "user", text: "[Session finished] \"Sign-in\" in web (address ses_sign), after 3 min:\nDelete the old keys first, then rotate them all." },
    { id: "msg_103", type: "user", text: "Ship it on Friday." },
    { id: "msg_104", type: "assistant", content: [{ type: "text", text: "On it." }] },
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
const lookHeard = [];
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
      for (const heard of lookHeard.splice(0)) heard();
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
    // (Its queue, as the box's Stop and Resume read it: nothing waiting.)
    if (one?.[2] === "/inbox") return reply({ data: [] });
    if (one?.[2] === "/interrupt") return reply({ data: true });
    if (one?.[2] === "/message") return reply({ data: [...(messages.get(id) ?? [])].reverse() });
    if (request.url.includes("/instructions/entries/")) {
      told.set(request.url.match(/session\/([^/]+)\//)[1] + " " + request.url.split("/").pop(), JSON.parse(body).value);
      return reply({});
    }
    reply({ message: "Not here." }, 404);
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
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
  fs.rmSync(path.join(home, "run", "queues.json"), { force: true });
  fs.rmSync(path.join(home, "run", "waiting"), { recursive: true, force: true });
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

test("send_message to a conversation the user stopped waits there with its queue, says so, and goes once they resume it, as a letter no one waits for", async () => {
  assert.equal((await route("POST", "kuvo/sessions/ses_notes/stop")).body.paused, true);
  const said = await tool("send_message", { to: "Release notes", text: "Add the iPhone fixes.", wait: true }, "ses_helper");
  assert.deepEqual(said, { text: "Release notes is stopped: the user paused its conversation. Your message waits there and goes once they resume it; its answer, if it writes one, comes to you as a message.", isError: false });
  assert.deepEqual(prompts, [], "the engine would run everything waiting with it");
  const queue = (await route("GET", "kuvo/sessions/ses_notes/queue")).body;
  assert.deepEqual(queue.waiting.map(({ from, text }) => ({ from, text })), [{ from: "Lead", text: "Add the iPhone fixes." }]);
  await route("POST", "kuvo/sessions/ses_notes/queue/resume");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].to, "ses_notes");
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

test("read_conversation never gives what the box wrote to an agent as the user's words: each is from its note's sender, whole, as the agent read it", async () => {
  const read = await tool("read_conversation", { of: "ses_goal" }, "ses_lead");
  assert.equal(read.isError, false, read.text);
  assert.equal(read.text.slice(read.text.indexOf("# Launch")),
    "# Launch\n\n**Goal**\n\n[Goal started] The user approved the plan. Work through it now: 1. Sign in.\n\n"
    + "**Its sessions**\n\n[Session finished] \"Sign-in\" in web (address ses_sign), after 3 min:\nDelete the old keys first, then rotate them all.\n\n"
    + "**User**\n\nShip it on Friday.\n\n**Launch**\n\nOn it.\n");
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
  // (Its conversation is one from before, its approval read from its rules: so is this one.)
  assert.deepEqual(marked.get("ses_new1"), { kuvo: { startedBy: "ses_lead" } });
  assert.equal(prompts[0].to, "ses_new1");
  assert.equal(prompts[0].text, "[Message from Lead · ses_lead] (To answer, use send_message to ses_lead.)\n\nReview the docs.");
});

test("an agent the box can't place can't start a session on Autopilot by saying so; a client can", async () => {
  const said = await tool("start_session", { task: "Spend it all.", autopilot: true, folder: project }, "ses_nowhere");
  assert.equal(said.isError, false, said.text);
  assert.equal(made.length, 1);
  assert.equal(marked.get("ses_new1")?.kuvo?.autopilot, undefined);

  assert.equal((await route("POST", "kuvo/sessions", { task: "Build it.", folder: project, title: "Asked", autopilot: true })).status, 200);
  assert.equal(marked.get("ses_new2")?.kuvo?.autopilot, true);
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

test("a session whose starter hears it finish is told its last reply is its report, not to send that again as a message; one whose finish isn't heard, as before (#270)", async () => {
  const heard = "[Message from Scout · ses_scout] (They get your last reply when you finish: end with your report there, not in a message. Use send_message to ses_scout only to ask something or say how it's going.)\n\nLook into the flaky test.";
  const note = "You were started by Scout, a bot coordinating this work. When you're done, review your work with reviewer subagents, fix what they find, and end with a short report as your last reply: what you did, what the reviewers found and how you fixed it, and anything left.";
  assert.equal((await tool("start_session", { task: "Look into the flaky test." }, "ses_scout")).isError, false);
  assert.equal(prompts.at(-1).text, `${heard}\n\n${note} Scout gets that reply when you finish: don't also send it with send_message.`);
  // A bot that hears only its asks: its report is to be read, as before.
  assert.equal((await tool("start_session", { task: "Look into the flaky test.", wake: "asks" }, "ses_scout")).isError, false);
  assert.equal(prompts.at(-1).text, `[Message from Scout · ses_scout] (To answer, use send_message to ses_scout.)\n\nLook into the flaky test.\n\n${note} Scout reads that report.`);
  // Another conversation that asked to hear it finish.
  assert.equal((await tool("start_session", { task: "Review the docs.", wake: "finished" }, "ses_lead")).isError, false);
  assert.match(prompts.at(-1).text, /^\[Message from Lead · ses_lead\] \(They get your last reply when you finish: end with your report there, not in a message\. Use send_message to ses_lead only to ask something or say how it's going\.\)\n\nReview the docs\.$/);
});

test("a bot's session started with review: false is told to report but not to review its work; by default it reviews (#554)", async () => {
  const letter = "[Message from Scout · ses_scout] (They get your last reply when you finish: end with your report there, not in a message. Use send_message to ses_scout only to ask something or say how it's going.)\n\nFix the typo.";
  const heard = "Scout gets that reply when you finish: don't also send it with send_message.";
  assert.equal((await tool("start_session", { task: "Fix the typo.", review: false }, "ses_scout")).isError, false);
  assert.equal(prompts.at(-1).text, `${letter}\n\nYou were started by Scout, a bot coordinating this work. When you're done, end with a short report as your last reply: what you did, and anything left. ${heard}`);
  assert.doesNotMatch(prompts.at(-1).text, /review/i);
  for (const review of [undefined, true]) {
    assert.equal((await tool("start_session", { task: "Fix the typo.", ...(review === undefined ? {} : { review }) }, "ses_scout")).isError, false);
    assert.equal(prompts.at(-1).text, `${letter}\n\nYou were started by Scout, a bot coordinating this work. When you're done, review your work with reviewer subagents, fix what they find, and end with a short report as your last reply: what you did, what the reviewers found and how you fixed it, and anything left. ${heard}`);
  }
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
  // (It says it asks first for now.)
  assert.deepEqual(started.body, { session: "ses_new1", title: "Login bug", folder: other, project: "web", got: "askFirst" });
  assert.equal(prompts[0].text, "Fix the login bug.");
  // Started by no conversation: Auto, as you'd start one, which asks first where the sandbox
  // doesn't run (as here).
  assert.deepEqual(marked.get("ses_new1"), { kuvo: { approval: "auto", applied: "askFirst" } });
  assert.ok(made[0].permissions.some(rule => rule.action === "shell" && rule.resource === "*" && rule.effect === "ask"));

  const byAgent = await route("POST", "kuvo/sessions", { task: "Check the deploy.", startedBy: "ses_helper" });
  assert.equal(byAgent.status, 200);
  assert.deepEqual(marked.get(byAgent.body.session), { kuvo: { startedBy: "ses_lead" } });

  // (A client's start with no task makes a new session: "start-folders.test.js". One waited for needs one.)
  assert.deepEqual(await route("POST", "kuvo/sessions", { folder: other, wait: true }), { status: 400, body: { message: "Say what it's to do (task)." } });
  assert.deepEqual(await route("POST", "kuvo/sessions", { task: "Hi.", folder: path.join(home, "nowhere") }),
    { status: 400, body: { message: `${path.join(home, "nowhere")} isn't a folder on this machine. Give a full path to one.` } });
  assert.deepEqual(await route("POST", "kuvo/sessions", { task: "Hi.", startedBy: "ses_gone" }), { status: 404, body: { message: "There's no such conversation here." } });
});

// Its commands would write such a folder whole: an agent in Auto never starts one where that's
// real damage (your home, a whole personal folder, what runs as you log in, your secrets), as you
// can; anywhere else in your home is its to work in; and from Full Access, nothing stops it.
test("an agent in Auto never starts a session where its commands could do real damage, as you can", async () => {
  const onPath = path.join(home, ".local", "bin");
  const documents = path.join(home, "Documents");
  const site = path.join(documents, "site");
  const agents = path.join(home, "Library", "LaunchAgents");
  for (const folder of [onPath, site, agents, path.join(home, ".config"), path.join(home, ".ssh")]) fs.mkdirSync(folder, { recursive: true });
  const refused = {
    [documents]: "its commands could delete a whole personal folder of yours",
    [home]: "its commands could delete your home folder",
    "~": "its commands could delete your home folder",
    [agents]: "its commands would reach what runs as you log in",
    [path.join(home, ".ssh")]: "its commands would reach your secrets",
  };
  for (const [folder, why] of Object.entries(refused)) {
    const said = await tool("start_session", { task: "Tidy it.", folder }, "ses_helper");
    assert.deepEqual(said, { text: `An agent in Auto can't start a session in ${folder} on this machine: ${why}. Ask the user to start it there.`, isError: true });
  }
  // (Your tools' settings hold both your secrets and what runs as you log in.)
  assert.match((await tool("start_session", { task: "Tidy it.", folder: path.join(home, ".config") }, "ses_helper")).text, /can't start a session .*: its commands would reach (your secrets|what runs as you log in)\./);
  assert.equal((await route("POST", "kuvo/sessions", { task: "Tidy it.", folder: home, startedBy: "ses_helper" })).status, 403);
  // Anywhere else: a folder on your PATH, a project in a personal folder.
  for (const folder of [onPath, "~/.local/bin", site]) assert.equal((await tool("start_session", { task: "Tidy it.", folder }, "ses_helper")).isError, false, folder);
  // You start one anywhere.
  assert.equal((await route("POST", "kuvo/sessions", { task: "Tidy it.", folder: home })).status, 200);
  // From a conversation in Full Access, nothing stops it.
  const lead = sessions.get("ses_lead");
  const rules = lead.permissions;
  lead.permissions = [];
  try {
    assert.equal((await tool("start_session", { task: "Tidy it.", folder: documents }, "ses_helper")).isError, false);
  } finally {
    lead.permissions = rules;
  }
});

test("a client starts a session with the approval it picks, else this computer's default: Accept Edits edits on its own, Full Access only where it's switched on, an older client's words read as the box's", async () => {
  const edits = await route("POST", "kuvo/sessions", { task: "Tidy the README.", folder: other, approval: "acceptEdits" });
  assert.equal(edits.status, 200);
  assert.deepEqual(marked.get(edits.body.session), { kuvo: { approval: "acceptEdits", applied: "acceptEdits" } });
  const rules = made[0].permissions;
  const last = action => rules.filter(rule => rule.action === action && rule.resource === "*").pop()?.effect;
  assert.equal(last("shell"), "ask", "commands still ask");
  assert.notEqual(last("edit"), "ask", "edits don't");

  fs.rmSync(path.join(home, "box", "approval.json"), { force: true });
  assert.deepEqual(await route("POST", "kuvo/sessions", { task: "Hi.", folder: other, approval: "fullAccess" }),
    { status: 409, body: { message: "Full Access isn't confirmed on this computer yet: confirm it first.", reason: "fullAccessOff" } });
  assert.equal(made.length, 1, "nothing started with less instead");

  // An older client's Approve All (its default) is this computer's: Auto the first time, and never
  // Full Access unasked, confirmed or not.
  const older = await route("POST", "kuvo/sessions", { task: "Hi.", folder: other, approval: "approveAll" });
  assert.equal(older.status, 200);
  assert.equal(marked.get(older.body.session).kuvo.approval, "auto");
  write(path.join(home, "box", "approval.json"), JSON.stringify({ fullAccess: true }));
  const confirmed = await route("POST", "kuvo/sessions", { task: "Hi.", folder: other, approval: "approveAll" });
  assert.equal(marked.get(confirmed.body.session).kuvo.approval, "auto");
  // Picked once, Full Access is the default from then on: for a start that doesn't say, and for
  // Approve All.
  const picked = await route("POST", "kuvo/sessions", { task: "Hi.", folder: other, approval: "fullAccess" });
  assert.equal(marked.get(picked.body.session).kuvo.approval, "fullAccess");
  const unsaid = await route("POST", "kuvo/sessions", { task: "Hi.", folder: other });
  assert.equal(marked.get(unsaid.body.session).kuvo.approval, "fullAccess");
  const again = await route("POST", "kuvo/sessions", { task: "Hi.", folder: other, approval: "approveAll" });
  assert.equal(marked.get(again.body.session).kuvo.approval, "fullAccess");
  fs.rmSync(path.join(home, "box", "approval.json"), { force: true });
});

test("a session an agent starts never does more on its own than its conversation, and the agent is told what it got", async () => {
  const lead = sessions.get("ses_lead");
  lead.metadata = { kuvo: { approval: "auto", applied: "askFirst" } };
  try {
    const said = await tool("start_session", { task: "Ship it.", title: "Ship", approval: "fullAccess" }, "ses_helper");
    assert.equal(said.isError, false, said.text);
    // (Auto, its conversation's, which asks first here: the sandbox doesn't run.)
    assert.match(said.text, /It asks before it edits or runs commands\./);
    assert.deepEqual(marked.get("ses_new1"), { kuvo: { startedBy: "ses_lead", approval: "auto", applied: "askFirst" } });
  } finally {
    delete lead.metadata;
  }
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

// Task, a session Lead started to hear when it finishes, and the box's watch over the engine's
// sessions (its clock the test's); `heard` runs as the tool waiting for Task's answer first looks
// whether it's still at work.
async function watchingTask() {
  sessions.set("ses_task", { id: "ses_task", title: "Task", location: { directory: project }, time: { created: 9, updated: 9 }, metadata: { kuvo: { startedBy: "ses_lead", depth: 1, wake: ["finished"] } } });
  messages.delete("ses_task");
  fs.rmSync(path.join(home, "run", "work"), { recursive: true, force: true });
  const later = [];
  const source = { port: engine.address().port, password: "p" };
  // Another, as the engine's stream connects again: the clock at `at`, and what it would run later
  // with the one before's.
  const clock = { at: 1000 };
  let current;
  const watcher = async (at, place = { source }) => {
    current?.abort();
    current = new AbortController();
    clock.at = at;
    const watch = link.workWatcher(place.source, () => [source], { schedule: run => { later.push(run); }, now: () => clock.at, signal: current.signal, from: place.from });
    await watch.caughtUp;
    return watch;
  };
  const watch = await watcher(1000);
  return {
    watch,
    clock,
    reconnected: (at = 6000) => watcher(at),
    // The engine's stream lost, not yet connected again.
    dropped: () => current.abort(),
    // The link started again: what the one before would have run later, gone with it.
    restarted: (at, place) => {
      later.length = 0;
      return watcher(at, place);
    },
    runAll: async () => { for (const run of later.splice(0)) await run(); },
    whenWaiting: heard => new Promise(resolve => promptHeard.push(() => lookHeard.push(() => resolve(heard())))),
    toLead: () => prompts.filter(each => each.to === "ses_lead"),
  };
}

test("a summary that failed reaches its lead as just that: its work isn't called failed", async () => {
  const { watch, runAll, toLead } = await watchingTask();
  messages.set("ses_task", [{ id: "msg_zzb", type: "assistant", content: [{ type: "text", text: "All done." }] }, { id: "msg_zzc0", type: "idle", outcome: "succeeded" }, { id: "msg_zzc", type: "compaction", status: "failed", reason: "manual" }, { id: "msg_zzd", type: "idle", outcome: "failed", error: { message: "It couldn't." } }]);
  await watch({ type: "session.execution.failed", data: { sessionID: "ses_task", error: { message: "It couldn't." } } });
  await runAll();
  assert.equal(toLead().length, 1);
  assert.match(toLead()[0].text, /^\[Session not summarized\][^\n]*: It couldn't\. Its conversation and work are as they were\.$/);
});

test("a summary that failed on the engine, whose run says it succeeded: its lead hears why, not that it finished", async () => {
  const { watch, runAll, toLead } = await watchingTask();
  messages.set("ses_task", [{ id: "msg_zzb", type: "assistant", content: [{ type: "text", text: "All done." }] }, { id: "msg_zzc0", type: "idle", outcome: "succeeded" }, { id: "msg_zzc", type: "compaction", status: "failed", reason: "manual", error: { type: "provider.invalid-request", message: "The provider refused." } }, { id: "msg_zzd", type: "idle", outcome: "succeeded" }]);
  await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_task" } });
  await runAll();
  assert.equal(toLead().length, 1);
  assert.match(toLead()[0].text, /^\[Session not summarized\][^\n]*: The provider refused\. Its conversation and work are as they were\.$/);
});

test("a summary taken during a run on the engine is part of that run: its lead hears it finish, with its reply", async () => {
  for (const status of ["completed", "failed"]) {
    const { watch, runAll, toLead } = await watchingTask();
    const before = toLead().length;
    messages.set("ses_task", [{ id: `msg_zzb_${status}`, type: "assistant", content: [{ type: "text", text: `All done, ${status}.` }] }, { id: `msg_zzc_${status}`, type: "compaction", status, reason: "manual" }, { id: `msg_zzd_${status}`, type: "idle", outcome: "succeeded" }]);
    await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_task" } });
    await runAll();
    assert.equal(toLead().length, before + 1, status);
    assert.match(toLead().at(-1).text, new RegExp(`^\\[Session finished\\][^\\n]*:\\nAll done, ${status}\\.`));
  }
});

test("a session that only summarized its conversation, as it was asked, isn't told to its lead as finished; what it does next is", async () => {
  const { watch, runAll, toLead } = await watchingTask();
  messages.set("ses_task", [{ id: "msg_zzb", type: "assistant", content: [{ type: "text", text: "All done." }] }, { id: "msg_zzc0", type: "idle", outcome: "succeeded" }, { id: "msg_zzc", type: "compaction", status: "completed", reason: "manual" }, { id: "msg_zzd", type: "idle", outcome: "succeeded" }]);
  await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_task" } });
  await runAll();
  assert.deepEqual(toLead(), []);
  // A reply after it is news.
  messages.get("ses_task").push({ id: "msg_zze", type: "assistant", content: [{ type: "text", text: "Carried on." }] });
  await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_task" } });
  await runAll();
  assert.equal(toLead().length, 1);
  assert.match(toLead()[0].text, /^\[Session finished\][^\n]*:\nCarried on\./);
});

test("a conversation waiting for the answer of a session it started gets it from send_message, and isn't told again that the session finished with it, heard while it waited or after; a later finish is told", async () => {
  const { watch, runAll, whenWaiting, toLead } = await watchingTask();
  const heard = whenWaiting(() => watch({ type: "session.execution.succeeded", data: { sessionID: "ses_task" } }));
  const said = await tool("send_message", { to: "ses_task", text: "Is the sign-in done?", wait: true }, "ses_lead");
  assert.deepEqual(said, { text: "Task answered:\n\nOn it (ses_task).", isError: false });
  await heard;
  await runAll();
  assert.deepEqual(toLead(), [], "the answer came in the tool");
  // Heard once the tool's answered: the same.
  await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_task" } });
  await runAll();
  assert.deepEqual(toLead(), []);
  // Later, it finishes again with more to say: that's told.
  messages.get("ses_task").push({ id: "msg_zzz", type: "assistant", content: [{ type: "text", text: "Also fixed the tests." }] });
  await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_task" } });
  await runAll();
  assert.equal(toLead().length, 1);
  assert.match(toLead()[0].text, /^\[Session finished\] "Task" in api \(address ses_task\)[^\n]*:\nAlso fixed the tests\./);
});

test("a starter on another computer (one that moved there since it started the session) that waits on its answer by letter gets it once: not told again that the session finished with it; a later finish is told there", async () => {
  const { watch, runAll, whenWaiting } = await watchingTask();
  // Lead lives on the other box now, as the sessions there list it; Task, here, still names it.
  const other = { key: "b3RoZXItYm94LWtleS1vZi10aGlydHktdHdvLWJ5dGVz", address: "other", name: "Mac mini", kind: "machine" };
  sessions.get("ses_task").metadata.kuvo.startedBy = "ses_away";
  write(path.join(home, "run", "work", "homes.json"), JSON.stringify({ ses_away: { key: other.key, at: 1 } }));
  const toAway = () => {
    const sending = path.join(home, "run", "outbox", "sending");
    return (fs.existsSync(sending) ? fs.readdirSync(sending) : []).map(name => JSON.parse(fs.readFileSync(path.join(sending, name), "utf8"))).filter(letter => letter.to === "ses_away");
  };
  fs.rmSync(path.join(home, "run", "outbox"), { recursive: true, force: true });
  const heard = whenWaiting(() => watch({ type: "session.execution.succeeded", data: { sessionID: "ses_task" } }));
  const answers = [];
  const letter = { id: "ltr_waitsforitsanswer1", from: "ses_away", to: "ses_task", text: "Is the sign-in done?", at: Date.now(), wait: true };
  await link.takeLetter(other, letter, { send: () => {}, targets: [{ port: engine.address().port, password: "p" }], answer: each => answers.push(each),
    told: { [other.key]: { at: 1, list: [{ session: "ses_away", name: "Lead", kind: "session" }] } }, peers: [other], moved: new Map(), wait: 10 });
  assert.deepEqual(answers.map(each => [each.to, each.text]), [["ses_away", "On it (ses_task)."]]);
  await heard;
  await runAll();
  await runAll();
  assert.deepEqual(toAway(), [], "the answer went back in its letter");
  // Later, it finishes again with more to say: that's told there.
  messages.get("ses_task").push({ id: "msg_zzz", type: "assistant", content: [{ type: "text", text: "Also fixed the tests." }] });
  await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_task" } });
  await runAll();
  assert.equal(toAway().length, 1);
  assert.match(toAway()[0].text, /^\[Session finished\] "Task" in api \(address ses_task\)[^\n]*:\nAlso fixed the tests\./);
});

test("a session that finishes while its starter waits for its answer, and the wait's given up (its turn stopped), is told it finished once the wait ends", async () => {
  const { watch, runAll, whenWaiting, toLead } = await watchingTask();
  // Task finishes as far as the box hears, while the tool still sees it at work.
  const heard = whenWaiting(() => {
    busy.set("ses_task", Infinity);
    return watch({ type: "session.execution.succeeded", data: { sessionID: "ses_task" } });
  });
  let child;
  const answering = route("POST", "kuvo/agent-tools", { name: "send_message", arguments: { to: "ses_task", text: "Is the sign-in done?", wait: true }, session: "ses_lead" }, started => { child = started; });
  await heard;
  await runAll();
  assert.deepEqual(toLead(), [], "not while it waits");
  child.kill("SIGTERM");
  assert.match((await answering).body.text, /^Task hasn't answered yet/);
  await runAll();
  await runAll();
  assert.equal(toLead().length, 1);
  assert.match(toLead()[0].text, /^\[Session finished\] "Task"/);
});

test("a session that fails while its starter waits for its answer is told at once", async () => {
  const { watch, runAll, whenWaiting, toLead } = await watchingTask();
  const heard = whenWaiting(() => watch({ type: "session.execution.failed", data: { sessionID: "ses_task" } }));
  await tool("send_message", { to: "ses_task", text: "Is the sign-in done?", wait: true }, "ses_lead");
  await heard;
  await runAll();
  assert.equal(toLead().length, 1);
  assert.match(toLead()[0].text, /^\[Session failed\] "Task"/);
});

test("a finish heard while its starter waited isn't told as the engine's stream connects again, once the answer came in the tool", async () => {
  const { watch, runAll, whenWaiting, reconnected, toLead } = await watchingTask();
  const heard = whenWaiting(() => {
    sessions.get("ses_task").time.updated = 5000;
    return watch({ type: "session.execution.succeeded", data: { sessionID: "ses_task" } });
  });
  assert.equal((await tool("send_message", { to: "ses_task", text: "Is the sign-in done?", wait: true }, "ses_lead")).text, "Task answered:\n\nOn it (ses_task).");
  await heard;
  // The watch connected again after looks back and finds it dealt with.
  await reconnected();
  await runAll();
  await runAll();
  assert.deepEqual(toLead(), [], "the answer came in the tool");
});

test("a finish heard while its starter waited, the wait given up, is told once as the engine's stream connects again", async () => {
  const { watch, runAll, whenWaiting, reconnected, toLead } = await watchingTask();
  const heard = whenWaiting(() => {
    busy.set("ses_task", Infinity);
    sessions.get("ses_task").time.updated = 5000;
    return watch({ type: "session.execution.succeeded", data: { sessionID: "ses_task" } });
  });
  let child;
  const answering = route("POST", "kuvo/agent-tools", { name: "send_message", arguments: { to: "ses_task", text: "Is the sign-in done?", wait: true }, session: "ses_lead" }, started => { child = started; });
  await heard;
  child.kill("SIGTERM");
  await answering;
  busy.delete("ses_task");
  // Told by whichever watch finds it first.
  await reconnected();
  await runAll();
  await runAll();
  assert.equal(toLead().length, 1);
  assert.match(toLead()[0].text, /^\[Session finished\] "Task"/);
});

test("a finish held while its starter waited is told after the link starts again, though the box has heard of everything since", async () => {
  const { watch, runAll, whenWaiting, reconnected, restarted, toLead } = await watchingTask();
  const heard = whenWaiting(() => {
    busy.set("ses_task", Infinity);
    sessions.get("ses_task").time.updated = 5000;
    return watch({ type: "session.execution.succeeded", data: { sessionID: "ses_task" } });
  });
  let child;
  const answering = route("POST", "kuvo/agent-tools", { name: "send_message", arguments: { to: "ses_task", text: "Is the sign-in done?", wait: true }, session: "ses_lead" }, started => { child = started; });
  await heard;
  // The stream connects again while the wait goes on: it looks at everything up to now, and holds
  // the finish too.
  await reconnected(6000);
  assert.deepEqual(toLead(), []);
  child.kill("SIGTERM");
  await answering;
  busy.delete("ses_task");
  // Then the link stops before either looks again, and starts.
  await restarted(7000);
  await runAll();
  assert.equal(toLead().length, 1);
  assert.match(toLead()[0].text, /^\[Session finished\] "Task"/);
});

test("a finish held while its starter waited, told once the engine's stream was lost, doesn't hide what the session said meanwhile", async () => {
  const { watch, clock, runAll, whenWaiting, dropped, restarted, toLead } = await watchingTask();
  const heard = whenWaiting(() => {
    busy.set("ses_task", Infinity);
    return watch({ type: "session.execution.succeeded", data: { sessionID: "ses_task" } });
  });
  let child;
  const answering = route("POST", "kuvo/agent-tools", { name: "send_message", arguments: { to: "ses_task", text: "Is the sign-in done?", wait: true }, session: "ses_lead" }, started => { child = started; });
  await heard;
  // The stream's lost; meanwhile the session finishes again, unheard.
  dropped();
  clock.at = 2000;
  messages.get("ses_task").push({ id: "msg_zzz", type: "assistant", time: { created: 2000 }, content: [{ type: "text", text: "Also fixed the tests." }] });
  sessions.get("ses_task").time.updated = 2000;
  // The wait's given up later: the finish it held is told.
  clock.at = 3000;
  child.kill("SIGTERM");
  await answering;
  busy.delete("ses_task");
  await runAll();
  await runAll();
  assert.equal(toLead().length, 1);
  // The link starts again: what the session said meanwhile is told too.
  await restarted(4000);
  await runAll();
  assert.equal(toLead().length, 2);
  assert.match(toLead()[1].text, /Also fixed the tests\./);
});

test("a finish held in the coding agents' bridge while its starter waited is told after the link starts again, though the engine was looked at first", async () => {
  const { runAll, whenWaiting, restarted, toLead } = await watchingTask();
  // The bridge's watch, having heard of everything until 6000.
  const bridge = { source: { port: engine.address().port, password: "p" }, from: "bridge" };
  const theBridge = await restarted(6000, bridge);
  const heard = whenWaiting(() => {
    busy.set("ses_task", Infinity);
    sessions.get("ses_task").time.updated = 5000;
    return theBridge({ type: "session.execution.succeeded", data: { sessionID: "ses_task" } });
  });
  let child;
  const answering = route("POST", "kuvo/agent-tools", { name: "send_message", arguments: { to: "ses_task", text: "Is the sign-in done?", wait: true }, session: "ses_lead" }, started => { child = started; });
  await heard;
  // The link starts again: the engine (which has none of the bridge's sessions) is looked at first.
  const empty = http.createServer((request, response) => response.end("[]"));
  await new Promise(resolve => empty.listen(0, "127.0.0.1", resolve));
  try {
    await restarted(7000, { source: { port: empty.address().port, password: "p" } });
  } finally {
    empty.close();
  }
  child.kill("SIGTERM");
  await answering;
  busy.delete("ses_task");
  await restarted(8000, bridge);
  await runAll();
  assert.equal(toLead().length, 1);
  assert.match(toLead()[0].text, /^\[Session finished\] "Task"/);
});

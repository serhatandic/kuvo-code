// A bot runs sessions as you would (PROTOCOL.md, "Work"): it starts one in a project on the model,
// effort, mode and approval it picks (never above its own), each marked as its work; it lists them,
// stops one, answers what they ask within what it may do itself (never what always comes to you),
// and limits apply only where you set them. Each call by a process of its own, as a machine's
// tools ask it (`kuvo-link.js box route`). The real box script on a folder of the test's own; only
// the engine is a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/bots-work.test.js`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-bots-work-")));
after(() => fs.rmSync(home, { recursive: true, force: true }));
const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const tidepool = path.join(home, "work", "tidepool");
fs.mkdirSync(tidepool, { recursive: true });
write(path.join(home, "box", "projects.json"), JSON.stringify({ projects: [{ directory: tidepool, name: "Tidepool", folders: [] }] }));

// Pixel, a bot here that runs on Approve All, and Mira, one that asks first.
const pixelFolder = path.join(home, "bots", "bot_pixel00001");
const miraFolder = path.join(home, "bots", "bot_mira000001");
const askFirst = [{ action: "shell", resource: "*", effect: "ask" }, { action: "edit", resource: "*", effect: "ask" }];
const botJSON = (id, name, work) => JSON.stringify({ kuvo: 1, id, name, job: "Builds apps.", look: { color: "sky", shape: "round", face: "calm" }, created: "2026-10-01T09:00:00Z", updated: "2026-10-01T09:00:00Z", ...(work ? { work } : {}) });
function setBots({ pixelWork } = {}) {
  write(path.join(pixelFolder, "bot.json"), botJSON("bot_pixel00001", "Pixel", pixelWork));
  write(path.join(pixelFolder, "session"), "ses_pixel");
  fs.mkdirSync(path.join(pixelFolder, "workspace"), { recursive: true });
  write(path.join(miraFolder, "bot.json"), botJSON("bot_mira000001", "Mira"));
  write(path.join(miraFolder, "session"), "ses_mira");
  fs.mkdirSync(path.join(miraFolder, "workspace"), { recursive: true });
}

// The engine: the bots' conversations, a session of the user's own, the models there are accounts
// for; the sessions made, what each was sent, what each asks, and how each ask was answered.
let sessions, prompts, made, asked, replied, interrupted, active, busy;
const noTokens = () => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
function resetEngine() {
  sessions = new Map([
    ["ses_pixel", { id: "ses_pixel", title: "Pixel", location: { directory: path.join(pixelFolder, "workspace") }, model: { providerID: "anthropic", id: "claude-opus-5-5" }, permissions: [], time: { created: 1, updated: 5 }, cost: 0, tokens: noTokens() }],
    ["ses_mira", { id: "ses_mira", title: "Mira", location: { directory: path.join(miraFolder, "workspace") }, model: { providerID: "anthropic", id: "claude-opus-5-5" }, permissions: askFirst, time: { created: 1, updated: 5 }, cost: 0, tokens: noTokens() }],
    ["ses_mine", { id: "ses_mine", title: "My own", location: { directory: tidepool }, time: { created: 2, updated: 6 }, cost: 0, tokens: noTokens() }],
  ]);
  prompts = [];
  made = [];
  asked = new Map();
  replied = [];
  interrupted = [];
  active = new Set();
  busy = new Map();
}
resetEngine();
const engine = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/provider") return reply({ data: [{ id: "anthropic", name: "Anthropic" }, { id: "deepseek", name: "DeepSeek" }] });
    if (url.pathname === "/api/model") {
      return reply({ data: [
        { id: "claude-opus-5-5", providerID: "anthropic", name: "Claude Opus 5.5", variants: [{ id: "high" }, { id: "max" }], enabled: true },
        { id: "claude-sonnet-5-5", providerID: "anthropic", name: "Claude Sonnet 5.5", variants: [{ id: "low" }, { id: "high" }], enabled: true },
        { id: "deepseek-v4", providerID: "deepseek", name: "DeepSeek V4", variants: [], enabled: true },
        { id: "gpt-5", providerID: "openai", name: "GPT-5", variants: [], enabled: true },
      ] });
    }
    if (url.pathname === "/api/session" && request.method === "GET") {
      // A session's subagents by `parentID`; the rest, those at the top.
      const parent = url.searchParams.get("parentID");
      return reply({ data: [...sessions.values()].filter(each => (parent && parent !== "null" ? each.parentID === parent : !each.parentID)) });
    }
    if (url.pathname === "/api/session" && request.method === "POST") {
      const given = JSON.parse(body);
      const id = `ses_new${made.length + 1}`;
      made.push({ id, ...given });
      sessions.set(id, { id, title: given.title, agent: given.agent, model: given.model, permissions: given.permissions, location: given.location, time: { created: Date.now(), updated: Date.now() }, cost: 0, tokens: noTokens() });
      return reply({ data: { id } });
    }
    if (url.pathname === "/api/session/active") {
      // A session given a task is at work for one look, then answers.
      const looking = [...busy.entries()].filter(([, looks]) => looks > 0).map(([id]) => id);
      for (const id of looking) busy.set(id, busy.get(id) - 1);
      return reply({ data: Object.fromEntries([...active, ...looking].map(id => [id, {}])) });
    }
    const one = url.pathname.match(/^\/api\/session\/([^/]+)(\/.*)?$/);
    const id = one && decodeURIComponent(one[1]);
    if (one && !one[2] && request.method === "GET") return sessions.has(id) ? reply({ data: sessions.get(id) }) : reply({ message: "No such session." }, 404);
    if (one && !one[2] && request.method === "PATCH") {
      const change = JSON.parse(body);
      // The engine keeps the metadata it's sent, whole.
      if (change.metadata) sessions.set(id, { ...sessions.get(id), metadata: change.metadata });
      return reply({ data: sessions.get(id) });
    }
    if (one?.[2] === "/prompt") {
      prompts.push({ to: id, ...JSON.parse(body) });
      busy.set(id, 1);
      return reply({});
    }
    if (one?.[2] === "/message") {
      // Its answer, after the last message it was sent (ids sort by time).
      const sent = prompts.filter(each => each.to === id).at(-1);
      return reply({ data: [{ id: sent ? sent.id + "z" : "msg_2", type: "assistant", content: [{ type: "text", text: `Done in ${id}.` }] }] });
    }
    if (one?.[2] === "/inbox") return reply({ data: [] });
    if (one?.[2] === "/interrupt") {
      interrupted.push(id);
      return reply({});
    }
    if (one?.[2] === "/permission") return reply({ data: asked.get(id) ?? [] });
    if (one?.[2] === "/form") return reply({ data: [] });
    const answer = one?.[2]?.match(/^\/permission\/([^/]+)\/reply$/);
    if (answer) {
      replied.push({ session: id, permission: decodeURIComponent(answer[1]), ...JSON.parse(body) });
      asked.set(id, (asked.get(id) ?? []).filter(each => each.id !== decodeURIComponent(answer[1])));
      return reply({});
    }
    if (request.url.includes("/instructions/entries/")) return reply({});
    reply({ message: "Not here." }, 404);
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
after(() => { engine.closeAllConnections(); engine.close(); });
write(path.join(home, "run", "engine.json"), JSON.stringify({ port: engine.address().port, password: "p", version: "0.0.0" }));

beforeEach(() => {
  resetEngine();
  setBots();
  fs.rmSync(path.join(home, "run", "tool-limits.json"), { force: true });
});

// The box's answer to one request, as a machine's tool asks it: a process of its own.
function route(method, pathname, body) {
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
  });
}
const tool = async (name, args, session) => (await route("POST", "kuvo/agent-tools", { name, arguments: args, session })).body;
const startedAddress = said => said.text.match(/\(address (ses_\w+)\)/)?.[1];

test("a bot starts a session in a project, on the model, effort and mode it picks, marked as its work, with the session's half of the playbook", async () => {
  const said = await tool("start_session", { task: "Design the onboarding screens.", title: "Onboarding", project: "Tidepool", model: "anthropic/claude-sonnet-5-5", effort: "high", mode: "plan" }, "ses_pixel");
  assert.equal(said.isError, false, said.text);
  const session = startedAddress(said);
  assert.ok(session, said.text);
  assert.match(said.text, /^Started "Onboarding" in Tidepool \(address ses_new1\): Claude Sonnet 5\.5 · high · Plan\. It's on it now\. You'll be woken when it finishes or asks for something, so don't check on it\.$/);
  assert.deepEqual(made[0].location, { directory: tidepool });
  assert.deepEqual(made[0].model, { providerID: "anthropic", id: "claude-sonnet-5-5", variant: "high" });
  assert.equal(made[0].agent, "plan");
  const kuvo = sessions.get(session).metadata.kuvo;
  assert.equal(kuvo.startedBy, "ses_pixel");
  assert.deepEqual(kuvo.by, { bot: "bot_pixel00001", name: "Pixel" });
  assert.deepEqual(kuvo.wake, ["finished", "asks"], "a bot hears when its sessions finish and ask, unless it says otherwise");
  assert.equal(kuvo.depth, 1);
  assert.equal(prompts[0].to, session);
  assert.match(prompts[0].text, /Design the onboarding screens\./);
  assert.match(prompts[0].text, /review your work with reviewer subagents/i, "the session's half of the playbook travels with its task");
});

test("a session's own sessions are its bot's work too, one deeper", async () => {
  const first = startedAddress(await tool("start_session", { task: "Build sign-in.", project: tidepool }, "ses_pixel"));
  const second = await tool("start_session", { task: "Write the sign-in tests." }, first);
  assert.equal(second.isError, false, second.text);
  const kuvo = sessions.get(startedAddress(second)).metadata.kuvo;
  assert.deepEqual(kuvo.by, { bot: "bot_pixel00001", name: "Pixel" });
  assert.equal(kuvo.startedBy, first);
  assert.equal(kuvo.depth, 2);
  assert.equal(kuvo.wake, undefined, "only the bot is woken by default");
});

test("a model there's no account for, or an effort it hasn't, is refused with what there is", async () => {
  const none = await tool("start_session", { task: "Hi.", project: "Tidepool", model: "openai/gpt-5" }, "ses_pixel");
  assert.equal(none.isError, true);
  assert.match(none.text, /no account for openai/i);
  assert.match(none.text, /list_models/);
  const effort = await tool("start_session", { task: "Hi.", project: "Tidepool", model: "deepseek/deepseek-v4", effort: "max" }, "ses_pixel");
  assert.equal(effort.isError, true);
  assert.match(effort.text, /DeepSeek V4 has no efforts/);
  assert.equal(made.length, 0);
});

test("a session's approval is never above its starter's: a bot that asks first starts sessions that ask first", async () => {
  const said = await tool("start_session", { task: "Tidy the README.", project: "Tidepool", approval: "approveAll" }, "ses_mira");
  assert.equal(said.isError, false, said.text);
  assert.match(said.text, /asks first, as you do/);
  assert.ok(made[0].permissions.some(rule => rule.action === "shell" && rule.effect === "ask"));
  const careful = await tool("start_session", { task: "Look around.", project: "Tidepool", approval: "ask" }, "ses_pixel");
  assert.equal(careful.isError, false, careful.text);
  assert.ok(made[1].permissions.some(rule => rule.action === "shell" && rule.effect === "ask"), "an Approve All bot can start a careful one");
});

test("a bot has no limits until you set them", async () => {
  for (let count = 0; count < 10; count++) assert.equal((await tool("start_session", { task: `Task ${count}`, project: "Tidepool" }, "ses_pixel")).isError, false);
  assert.equal(made.length, 10);
});

test("limits you set are kept: sessions at once and depth", async () => {
  setBots({ pixelWork: { limits: { atOnce: 2, depth: 1 } } });
  const first = startedAddress(await tool("start_session", { task: "One.", project: "Tidepool" }, "ses_pixel"));
  startedAddress(await tool("start_session", { task: "Two.", project: "Tidepool" }, "ses_pixel"));
  active = new Set(["ses_new1", "ses_new2"]);
  const third = await tool("start_session", { task: "Three.", project: "Tidepool" }, "ses_pixel");
  assert.equal(third.isError, true);
  assert.match(third.text, /2 sessions at once/);
  active = new Set();
  const deeper = await tool("start_session", { task: "Deeper.", project: "Tidepool" }, first);
  assert.equal(deeper.isError, true);
  assert.match(deeper.text, /one level deep/);
  assert.equal(made.length, 2);
});

test("list_sessions shows a bot's work and where each stands; stop_session stops only its own", async () => {
  const first = startedAddress(await tool("start_session", { task: "One.", title: "Sign-in", project: "Tidepool" }, "ses_pixel"));
  const second = startedAddress(await tool("start_session", { task: "Two.", title: "Onboarding", project: "Tidepool" }, "ses_pixel"));
  active = new Set([first]);
  asked.set(second, [{ id: "per_1", sessionID: second, action: "shell", resources: ["npx expo install expo-haptics"] }]);
  const listed = await tool("list_sessions", {}, "ses_pixel");
  assert.equal(listed.isError, false, listed.text);
  assert.match(listed.text, new RegExp(`- Sign-in \\(address ${first}\\), in Tidepool: working`));
  assert.match(listed.text, new RegExp(`- Onboarding \\(address ${second}\\), in Tidepool: asks to run a command: npx expo install expo-haptics \\(ask per_1\\)`));
  assert.doesNotMatch(listed.text, /My own/);

  const stopped = await tool("stop_session", { session: first }, "ses_pixel");
  assert.deepEqual(stopped, { text: "Stopped \"Sign-in\".", isError: false });
  assert.deepEqual(interrupted, [first]);
  const notMine = await tool("stop_session", { session: "ses_mine" }, "ses_pixel");
  assert.deepEqual(notMine, { text: "\"My own\" isn't yours to stop: ask the user.", isError: true });
});

test("a bot answers its sessions' asks within what it may do itself, recorded on the session; what always comes to you, it can't", async () => {
  const session = startedAddress(await tool("start_session", { task: "Add haptics.", title: "Haptics", project: "Tidepool" }, "ses_pixel"));
  asked.set(session, [
    { id: "per_1", sessionID: session, action: "shell", resources: ["npx expo install expo-haptics"], source: { type: "tool", messageID: "msg_1", id: "call_1" } },
    { id: "per_2", sessionID: session, action: "shell", resources: ["git push origin main"], source: { type: "tool", messageID: "msg_1", id: "call_2" } },
  ]);
  const allowed = await tool("answer_ask", { session, ask: "per_1", decision: "allow", reason: "The plan names the haptics package." }, "ses_pixel");
  assert.deepEqual(allowed, { text: "Allowed: npx expo install expo-haptics.", isError: false });
  assert.deepEqual(replied[0], { session, permission: "per_1", decision: "once" });
  const record = sessions.get(session).metadata.kuvo.answers;
  assert.equal(record.length, 1);
  assert.deepEqual({ ...record[0], at: undefined }, { ask: "per_1", call: "call_1", what: "Wants to run a command: npx expo install expo-haptics", decision: "allow", reason: "The plan names the haptics package.", by: { bot: "bot_pixel00001", name: "Pixel" }, at: undefined });
  assert.equal(typeof record[0].at, "number");

  const push = await tool("answer_ask", { session, ask: "per_2", decision: "allow", reason: "Ship it." }, "ses_pixel");
  assert.equal(push.isError, true);
  assert.match(push.text, /always comes to the user/);
  assert.equal(replied.length, 1, "a push isn't the bot's to allow");
  const denied = await tool("answer_ask", { session, ask: "per_2", decision: "deny", reason: "Pushing waits for the user." }, "ses_pixel");
  assert.equal(denied.isError, false, "saying no is always the bot's to do");
  assert.deepEqual(replied[1], { session, permission: "per_2", decision: "reject", message: "Pixel: Pushing waits for the user." });
});

test("a bot that asks first can't allow what it would have to ask about itself", async () => {
  const session = startedAddress(await tool("start_session", { task: "Tidy.", project: "Tidepool" }, "ses_mira"));
  asked.set(session, [{ id: "per_1", sessionID: session, action: "shell", resources: ["npm test"] }]);
  const said = await tool("answer_ask", { session, ask: "per_1", decision: "allow", reason: "Tests are fine." }, "ses_mira");
  assert.equal(said.isError, true);
  assert.match(said.text, /you'd have to ask the user about it yourself/);
  assert.equal(replied.length, 0);
});

test("an ask in a session that isn't the bot's isn't its to answer", async () => {
  asked.set("ses_mine", [{ id: "per_9", sessionID: "ses_mine", action: "shell", resources: ["ls"] }]);
  const said = await tool("answer_ask", { session: "ses_mine", ask: "per_9", decision: "allow", reason: "Harmless." }, "ses_pixel");
  assert.equal(said.isError, true);
  assert.match(said.text, /isn't one of your sessions/);
  assert.equal(replied.length, 0);
});

test("list_models lists the models there are accounts for, with their efforts", async () => {
  const said = await tool("list_models", {}, "ses_pixel");
  assert.equal(said.isError, false);
  assert.match(said.text, /- anthropic\/claude-opus-5-5 \(Claude Opus 5\.5\), efforts: high, max/);
  assert.match(said.text, /- deepseek\/deepseek-v4 \(DeepSeek V4\)/);
  assert.doesNotMatch(said.text, /gpt-5/, "no account for OpenAI");
});

test("a client sees a bot's work: its sessions, the answers it gave and today's count", async () => {
  setBots({ pixelWork: { limits: { atOnce: 3 } } });
  const session = startedAddress(await tool("start_session", { task: "Add haptics.", title: "Haptics", project: "Tidepool" }, "ses_pixel"));
  asked.set(session, [{ id: "per_1", sessionID: session, action: "shell", resources: ["npm test"] }]);
  await tool("answer_ask", { session, ask: "per_1", decision: "allow", reason: "Tests." }, "ses_pixel");
  active = new Set([session]);
  const work = await route("GET", "kuvo/work?bot=bot_pixel00001");
  assert.equal(work.status, 200);
  assert.equal(work.body.bot, "bot_pixel00001");
  assert.deepEqual(work.body.sessions.map(each => [each.session, each.title, each.state, each.project, each.depth]), [[session, "Haptics", "working", "Tidepool", 1]]);
  assert.deepEqual(work.body.answered.map(each => [each.session, each.ask, each.decision]), [[session, "per_1", "allow"]]);
  assert.equal(work.body.today.started, 1);
  assert.deepEqual(work.body.limits, { atOnce: 3 });
});

test("a client stops all of a bot's work at once", async () => {
  const one = startedAddress(await tool("start_session", { task: "One.", project: "Tidepool" }, "ses_pixel"));
  const two = startedAddress(await tool("start_session", { task: "Two.", project: "Tidepool" }, "ses_pixel"));
  active = new Set([one, two]);
  const stopped = await route("POST", "kuvo/bots/bot_pixel00001/stop-all");
  assert.deepEqual(stopped, { status: 200, body: { stopped: 2 } });
  assert.deepEqual(interrupted.sort(), [one, two].sort());
});

test("a bot that asks first can't allow a folder outside the project, which it would be asked about itself", async () => {
  const session = startedAddress(await tool("start_session", { task: "Tidy.", project: "Tidepool" }, "ses_mira"));
  asked.set(session, [{ id: "per_1", sessionID: session, action: "external_directory", resources: [path.join(home, ".ssh", "*")] }]);
  const said = await tool("answer_ask", { session, ask: "per_1", decision: "allow", reason: "It needs the keys." }, "ses_mira");
  assert.equal(said.isError, true);
  assert.equal(replied.length, 0);
});

test("what a session's subagent asks, the bot answers on the subagent", async () => {
  const session = startedAddress(await tool("start_session", { task: "Review it.", project: "Tidepool" }, "ses_pixel"));
  sessions.set("ses_reviewer", { id: "ses_reviewer", parentID: session, title: "Reviewer", location: { directory: tidepool }, time: { created: 1, updated: 1 } });
  asked.set("ses_reviewer", [{ id: "per_7", sessionID: "ses_reviewer", action: "shell", resources: ["npm test"] }]);
  const listed = await tool("list_sessions", {}, "ses_pixel");
  assert.match(listed.text, /asks to run a command: npm test \(ask per_7\)/, "its subagent's ask is the session's");
  const said = await tool("answer_ask", { session, ask: "per_7", decision: "allow", reason: "Tests." }, "ses_pixel");
  assert.equal(said.isError, false, said.text);
  assert.deepEqual(replied[0], { session: "ses_reviewer", permission: "per_7", decision: "once" });
});

test("what always comes to the user is told by what a command runs, not by a word in it", async () => {
  const session = startedAddress(await tool("start_session", { task: "Ship it.", project: "Tidepool" }, "ses_pixel"));
  const yours = ["npm run deploy", "make release", "./scripts/publish.sh", "fastlane ios release", "\"git\" push origin main", "git -C app push", "cd app && git push", "gh workflow run deploy.yml", "gh api -X POST repos/a/b/merges", "rm -r -f ~/old", "rm -rf ../../elsewhere", "rm --recursive /etc/thing", "npx vercel --prod"];
  const fine = ["git log --grep push", "cargo build --release", `rm -rf ${path.join(tidepool, "build")}`, "rm -rf build", "xcodebuild -configuration Release build", "npm test", "gh pr view 12", "gh api repos/a/b/pulls"];
  asked.set(session, [...yours, ...fine].map((command, at) => ({ id: `per_${at}`, sessionID: session, action: "shell", resources: [command] })));
  const [all] = [[...yours, ...fine]];
  for (const [at, command] of all.entries()) {
    const said = await tool("answer_ask", { session, ask: `per_${at}`, decision: "allow", reason: "Part of the plan." }, "ses_pixel");
    assert.equal(said.isError, at < yours.length, `${command}: ${said.text}`);
  }
});

test("two answers given at once on one session are both kept", async () => {
  const session = startedAddress(await tool("start_session", { task: "Add haptics.", project: "Tidepool" }, "ses_pixel"));
  asked.set(session, [{ id: "per_1", sessionID: session, action: "shell", resources: ["npm test"] }, { id: "per_2", sessionID: session, action: "shell", resources: ["npm run lint"] }]);
  await Promise.all([
    tool("answer_ask", { session, ask: "per_1", decision: "allow", reason: "Tests." }, "ses_pixel"),
    tool("answer_ask", { session, ask: "per_2", decision: "allow", reason: "Lint." }, "ses_pixel"),
  ]);
  assert.deepEqual(sessions.get(session).metadata.kuvo.answers.map(each => each.ask).sort(), ["per_1", "per_2"]);
  assert.equal(sessions.get(session).metadata.kuvo.by.bot, "bot_pixel00001", "the rest of its notes kept");
});

test("a day's limit counts sessions archived since, and one waited for isn't heard of twice", async () => {
  setBots({ pixelWork: { limits: { perDay: 2 } } });
  const first = startedAddress(await tool("start_session", { task: "One.", project: "Tidepool", wait: true }, "ses_pixel"));
  assert.deepEqual(sessions.get(first).metadata.kuvo.wake, ["asks"], "its answer came back here: only its asks wake the bot");
  startedAddress(await tool("start_session", { task: "Two.", project: "Tidepool" }, "ses_pixel"));
  assert.equal((await tool("stop_session", { session: first, archive: true }, "ses_pixel")).text, "Stopped and archived \"New Session\".");
  assert.equal(sessions.get(first).metadata["kuvo.archived"], true);
  const third = await tool("start_session", { task: "Three.", project: "Tidepool" }, "ses_pixel");
  assert.equal(third.isError, true);
  assert.match(third.text, /2 new sessions a day/);
});

// A bot runs sessions as you would (PROTOCOL.md, "Work"): it starts one in a project on the model,
// effort, mode and approval it picks (never above its own), each marked as its work; it lists them,
// stops one, answers what they ask as far as its own conversation could go ahead (never past it),
// and limits apply only where you set them. Each call by a process of its own, as a machine's
// tools ask it (`kuvo-link.js box route`). The real box script on a folder of the test's own; only
// the engine is a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/bots-work.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runningAs } from "./running-as.js";
import { NO_BUN, testBun } from "./bun-for-tests.js";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-bots-work-")));
removeAtEnd(home);
const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const tidepool = path.join(home, "work", "tidepool");
fs.mkdirSync(tidepool, { recursive: true });
// A repository of its own, as a project is.
spawnSync("git", ["init", "-q", tidepool], { env: { ...process.env, HOME: home } });
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
let sessions, prompts, made, asked, replied, interrupted, active, busy, restarts;
// A session's latest messages where a test says, newest first; what's asked of `/compact`, and how each answers.
let kept, compacted, compacting;
// The questions sessions ask (a form each), and how each was answered.
let forms, answeredForms;
// Sessions given a task stay at work (`staysAtWork`); none is made until the sessions at work were
// looked at `holdMaking` times, so starts asked for at once all look before any is made.
let staysAtWork, holdMaking, activeLooks, held;
const noTokens = () => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
// When a session's made: after the next midnight, so it's "today" to the box however late the run,
// even one that goes past midnight (the box takes the day from its own clock). Later ones later.
const dayAfter = new Date().setHours(24, 0, 0, 0);
const madeAt = () => dayAfter + made.length;
function resetEngine() {
  sessions = new Map([
    ["ses_pixel", { id: "ses_pixel", title: "Pixel", location: { directory: path.join(pixelFolder, "workspace") }, model: { providerID: "anthropic", id: "claude-opus-5-5" }, permissions: [], time: { created: 1, updated: 5 }, cost: 0, tokens: noTokens() }],
    ["ses_mira", { id: "ses_mira", title: "Mira", location: { directory: path.join(miraFolder, "workspace") }, model: { providerID: "anthropic", id: "claude-opus-5-5" }, permissions: askFirst, time: { created: 1, updated: 5 }, cost: 0, tokens: noTokens() }],
    ["ses_mine", { id: "ses_mine", title: "My own", location: { directory: tidepool }, time: { created: 2, updated: 6 }, cost: 0, tokens: noTokens() }],
  ]);
  prompts = [];
  made = [];
  restarts = 0;
  asked = new Map();
  replied = [];
  interrupted = [];
  kept = new Map();
  forms = new Map();
  answeredForms = [];
  compacted = [];
  compacting = new Map();
  active = new Set();
  busy = new Map();
  staysAtWork = false;
  holdMaking = 0;
  activeLooks = 0;
  held = [];
}
resetEngine();
let integrationsAskedFresh = 0;
const engineAccounts = {
  anthropic: { id: "anthropic", name: "Anthropic", metadata: {}, connections: [{ type: "credential", id: "crd_work", label: "Work", method: "key" }, { type: "credential", id: "crd_home", label: "Personal", method: "key" }] },
  deepseek: { id: "deepseek", name: "DeepSeek", metadata: {}, connections: [{ type: "credential", id: "crd_ds", label: "API key", method: "key" }] },
};
const bridgeAccounts = {
  "claude-code": { id: "claude-code", name: "Claude Code", metadata: { source: "agent", accountID: "default" }, connections: [{ type: "agent", label: "ada@example.com · Max plan", method: "oauth" }] },
  "claude-code@acc0001": { id: "claude-code@acc0001", name: "Claude Code", metadata: { source: "agent", accountID: "acc0001", accountLabel: "Athas" }, connections: [{ type: "agent", label: "athas@example.com", method: "oauth" }] },
};
// An ask names the tool call it's for, as the engine's do.
const withSource = ask => ({ ...ask, source: ask.source ?? { type: "tool", messageID: `msg_${ask.id}`, id: `call_${ask.id}` } });
// The coding agents' bridge answers as the engine does, for the sessions on it (`bridge`).
const standIn = onBridge => (request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const url = new URL(request.url, "http://x");
    // The agents bridge told to restart its agents started before the sandbox was on.
    if (onBridge && url.pathname === "/api/kuvo/sandbox/restart" && request.method === "POST") {
      restarts += 1;
      return reply({});
    }
    if (url.pathname === "/api/provider") return reply({ data: [{ id: "anthropic", name: "Anthropic" }, { id: "deepseek", name: "DeepSeek" }] });
    if (url.pathname === "/api/model") {
      return reply({ data: [
        { id: "claude-opus-5-5", providerID: "anthropic", name: "Claude Opus 5.5", variants: [{ id: "high" }, { id: "max" }], enabled: true },
        { id: "claude-sonnet-5-5", providerID: "anthropic", name: "Claude Sonnet 5.5", variants: [{ id: "low" }, { id: "high" }], enabled: true },
        { id: "deepseek-v4", providerID: "deepseek", name: "DeepSeek V4", variants: [], enabled: true },
        // Retired soon by its provider: the engine's own picker leaves it out.
        { id: "deepseek-v3", providerID: "deepseek", name: "DeepSeek V3", variants: [], enabled: true, status: "deprecated" },
        { id: "gpt-5", providerID: "openai", name: "GPT-5", variants: [], enabled: true },
      ] });
    }
    if (url.pathname === "/api/session" && request.method === "GET") {
      // A session's subagents by `parentID`; the rest, those at the top.
      const parent = url.searchParams.get("parentID");
      const listed = [...sessions.values()].filter(each => Boolean(each.bridge) === onBridge && (parent && parent !== "null" ? each.parentID === parent : !each.parentID));
      // Two hundred to a page, as the engine pages them.
      if (url.searchParams.get("limit") === "200") {
        const from = Number(url.searchParams.get("cursor") ?? 0);
        return reply({ data: listed.slice(from, from + 200), cursor: listed.length > from + 200 ? { next: String(from + 200) } : null });
      }
      return reply({ data: listed });
    }
    if (url.pathname === "/api/session" && request.method === "POST") {
      const make = () => {
        const given = JSON.parse(body);
        const id = `ses_new${made.length + 1}`;
        made.push({ id, ...given });
        sessions.set(id, { id, title: given.title, agent: given.agent, model: given.model, permissions: given.permissions, location: given.location, time: { created: madeAt(), updated: madeAt() }, cost: 0, tokens: noTokens() });
        reply({ data: { id } });
      };
      if (activeLooks < holdMaking) held.push(make);
      else make();
      return;
    }
    if (url.pathname === "/api/session/active") {
      activeLooks += 1;
      if (activeLooks >= holdMaking) for (const go of held.splice(0)) go();
      // A session given a task is at work for one look, then answers.
      const looking = [...busy.entries()].filter(([, looks]) => looks > 0).map(([id]) => id);
      for (const id of looking) busy.set(id, busy.get(id) - 1);
      return reply({ data: Object.fromEntries([...active, ...looking].map(id => [id, {}])) });
    }
    const one = url.pathname.match(/^\/api\/session\/([^/]+)(\/.*)?$/);
    const id = one && decodeURIComponent(one[1]);
    if (one && !one[2] && request.method === "GET") return sessions.has(id) && Boolean(sessions.get(id).bridge) === onBridge ? reply({ data: sessions.get(id) }) : reply({ message: "No such session." }, 404);
    if (one && !one[2] && request.method === "PATCH") {
      const change = JSON.parse(body);
      // The engine keeps the metadata it's sent, whole.
      if (change.metadata) sessions.set(id, { ...sessions.get(id), metadata: change.metadata });
      return reply({ data: sessions.get(id) });
    }
    if (one?.[2] === "/prompt") {
      prompts.push({ to: id, ...JSON.parse(body) });
      busy.set(id, 1);
      if (staysAtWork) active.add(id);
      return reply({});
    }
    if (one?.[2] === "/compact" && request.method === "POST") {
      compacted.push(id);
      const answer = compacting.get(id) ?? {};
      return reply(answer.message ? { message: answer.message } : { data: answer.data ?? {} }, answer.message ? 400 : 200);
    }
    if (one?.[2] === "/message" && kept.has(id)) return reply({ data: kept.get(id) });
    if (one?.[2] === "/message") {
      // Its answer, after the last message it was sent (ids sort by time); and each tool call it
      // asks about, whole, in a message of its own, as the engine keeps them.
      const sent = prompts.filter(each => each.to === id).at(-1);
      const calls = (asked.get(id) ?? []).filter(ask => !ask.unseen).map(ask => withSource(ask)).map(ask => ({ id: ask.source.messageID, type: "assistant",
        content: [{ type: "tool", id: ask.source.id, name: ask.tool ?? (ask.action === "shell" ? "shell" : ask.action), state: { status: "running", input: ask.input ?? (ask.action === "shell" ? { command: ask.resources[0] } : { filePath: ask.resources[0] }) } }] }));
      return reply({ data: [{ id: sent ? sent.id + "z" : "msg_2", type: "assistant", content: [{ type: "text", text: `Done in ${id}.` }] }, ...calls] });
    }
    if (one?.[2] === "/inbox") return reply({ data: [] });
    if (one?.[2] === "/interrupt") {
      interrupted.push(id);
      return reply({});
    }
    if (one?.[2] === "/permission") return reply({ data: (asked.get(id) ?? []).map(withSource) });
    if (one?.[2] === "/form") return reply({ data: forms.get(id) ?? [] });
    const formReply = one?.[2]?.match(/^\/form\/([^/]+)\/reply$/);
    if (formReply) {
      answeredForms.push({ session: id, form: decodeURIComponent(formReply[1]), ...JSON.parse(body) });
      forms.set(id, (forms.get(id) ?? []).filter(each => each.id !== decodeURIComponent(formReply[1])));
      return reply({});
    }
    const answer = one?.[2]?.match(/^\/permission\/([^/]+)\/reply$/);
    if (answer) {
      replied.push({ session: id, permission: decodeURIComponent(answer[1]), ...JSON.parse(body) });
      asked.set(id, (asked.get(id) ?? []).filter(each => each.id !== decodeURIComponent(answer[1])));
      return reply({});
    }
    if (request.url.includes("/instructions/entries/")) return reply({});
    // An account as Settings › Accounts lists it: the engine's plans with their sign-ins (the one in
    // use first), the coding agents' accounts with the names you gave them.
    if (url.pathname.startsWith("/api/integration") && request.method === "GET") {
      // (Asked of each agent's program again, the bridge's `fresh` and one account's: what a read of a bot's work never needs.)
      if (url.pathname !== "/api/integration" || url.searchParams.has("fresh")) integrationsAskedFresh += 1;
      else return reply({ location: { directory: home }, data: Object.values(onBridge ? bridgeAccounts : engineAccounts) });
    }
    reply({ message: "Not here." }, 404);
  });
};
const engine = http.createServer(standIn(false));
const bridge = http.createServer(standIn(true));
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
await new Promise(resolve => bridge.listen(0, "127.0.0.1", resolve));
atEnd(() => { bridge.closeAllConnections(); bridge.close(); });
atEnd(() => { engine.closeAllConnections(); engine.close(); });
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
// A session put in another mode than the one it started in, as a client sets one: its approval
// and the rules the box makes for it. A session in Ask First is always the user's to answer,
// whatever its bot's mode, and one started here runs in Auto, which asks first while the sandbox
// isn't running: the tests of what a bot's own rules let it allow put its sessions in Accept Edits.
const MODE_RULES = { askFirst: [{ action: "shell", resource: "*", effect: "ask" }, { action: "edit", resource: "*", effect: "ask" }], acceptEdits: [{ action: "shell", resource: "*", effect: "ask" }], auto: [], fullAccess: [] };
function inMode(session, approval = "acceptEdits") {
  const was = sessions.get(session);
  sessions.set(session, { ...was, permissions: MODE_RULES[approval], metadata: { ...was.metadata, kuvo: { ...was.metadata?.kuvo, approval, applied: approval } } });
  return session;
}
const startedAddress = said => said.text.match(/\(address (ses_\w+)\)/)?.[1];

test("a bot starts a session in a project, on the model, effort and mode it picks, marked as its work, with the session's half of the playbook", async () => {
  const said = await tool("start_session", { task: "Design the onboarding screens.", title: "Onboarding", project: "Tidepool", model: "anthropic/claude-sonnet-5-5", effort: "high", mode: "plan" }, "ses_pixel");
  assert.equal(said.isError, false, said.text);
  const session = startedAddress(said);
  assert.ok(session, said.text);
  // (Its work is never more than Auto, which asks first here: the sandbox doesn't run.)
  assert.match(said.text, /^Started "Onboarding" in Tidepool \(address ses_new1\): Claude Sonnet 5\.5 · high · Plan\. It asks before it edits or runs commands\. It's on it now\. You'll be woken when it finishes or asks for something, so don't check on it\.$/);
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

test("a model its provider is retiring isn't offered, but a session on it can still start one on it (its own model, as a session left to its starter's takes)", async () => {
  const said = await tool("start_session", { task: "Carry on.", project: "Tidepool", model: "deepseek/deepseek-v3" }, "ses_pixel");
  assert.equal(said.isError, false, said.text);
  assert.deepEqual(made[0].model, { providerID: "deepseek", id: "deepseek-v3" });
});

test("a session's approval is never above its starter's:a bot that asks first starts sessions that ask first", async () => {
  const said = await tool("start_session", { task: "Tidy the README.", project: "Tidepool", approval: "approveAll" }, "ses_mira");
  assert.equal(said.isError, false, said.text);
  assert.match(said.text, /It asks before it edits or runs commands/);
  assert.ok(made[0].permissions.some(rule => rule.action === "shell" && rule.effect === "ask"));
  const careful = await tool("start_session", { task: "Look around.", project: "Tidepool", approval: "ask" }, "ses_pixel");
  assert.equal(careful.isError, false, careful.text);
  assert.ok(made[1].permissions.some(rule => rule.action === "shell" && rule.effect === "ask"), "an Approve All bot can start a careful one");
});

test("a bot you gave Full Access starts its work in Full Access, as any conversation would", async () => {
  write(path.join(home, "box", "approval.json"), JSON.stringify({ fullAccess: true }));
  try {
    sessions.set("ses_pixel", { ...sessions.get("ses_pixel"), metadata: { kuvo: { bot: "bot_pixel00001", approval: "fullAccess", applied: "fullAccess" } } });
    const said = await tool("start_session", { task: "Set up the release script.", project: "Tidepool" }, "ses_pixel");
    assert.equal(said.isError, false, said.text);
    assert.deepEqual({ approval: made[0].metadata.kuvo.approval, applied: made[0].metadata.kuvo.applied }, { approval: "fullAccess", applied: "fullAccess" });
    assert.ok(!made[0].permissions.some(rule => rule.action === "shell" && rule.resource === "*" && rule.effect === "ask"), "its commands go ahead");
  } finally {
    fs.rmSync(path.join(home, "box", "approval.json"), { force: true });
  }
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

test("limits you set are kept when the bot starts several sessions at once", async () => {
  staysAtWork = true;
  setBots({ pixelWork: { limits: { atOnce: 2 } } });
  holdMaking = 4;
  const four = await Promise.all(["One.", "Two.", "Three.", "Four."].map(task => tool("start_session", { task, project: "Tidepool" }, "ses_pixel")));
  assert.equal(four.filter(said => !said.isError).length, 2, four.map(said => said.text).join("\n"));
  assert.equal(made.length, 2);
  for (const refused of four.filter(said => said.isError)) assert.match(refused.text, /2 sessions at once/);

  // A day's: two started today already, so one more of four.
  active = new Set();
  setBots({ pixelWork: { limits: { perDay: 3 } } });
  activeLooks = 0;
  const more = await Promise.all(["Five.", "Six.", "Seven.", "Eight."].map(task => tool("start_session", { task, project: "Tidepool" }, "ses_pixel")));
  assert.equal(more.filter(said => !said.isError).length, 1, more.map(said => said.text).join("\n"));
  assert.equal(made.length, 3);
});

test("a bot set to one session at once starts the next once the last has finished", async () => {
  setBots({ pixelWork: { limits: { atOnce: 1 } } });
  startedAddress(await tool("start_session", { task: "One.", project: "Tidepool", wait: true }, "ses_pixel"));
  const next = await tool("start_session", { task: "Two.", project: "Tidepool" }, "ses_pixel");
  assert.equal(next.isError, false, next.text);
  assert.equal(made.length, 2);
});

test("list_sessions shows a bot's work and where each stands; stop_session stops only its own", async () => {
  const first = startedAddress(await tool("start_session", { task: "One.", title: "Sign-in", project: "Tidepool" }, "ses_pixel"));
  const second = startedAddress(await tool("start_session", { task: "Two.", title: "Onboarding", project: "Tidepool" }, "ses_pixel"));
  active = new Set([first]);
  asked.set(second, [{ id: "per_1", sessionID: second, action: "shell", resources: ["git diff --stat"] }]);
  const listed = await tool("list_sessions", {}, "ses_pixel");
  assert.equal(listed.isError, false, listed.text);
  assert.match(listed.text, new RegExp(`- Sign-in \\(address ${first}\\), in Tidepool: working`));
  assert.match(listed.text, new RegExp(`- Onboarding \\(address ${second}\\), in Tidepool: asks to run a command: git diff --stat \\(ask per_1\\)`));
  assert.doesNotMatch(listed.text, /My own/);

  const stopped = await tool("stop_session", { session: first }, "ses_pixel");
  assert.deepEqual(stopped, { text: "Stopped \"Sign-in\".", isError: false });
  assert.deepEqual(interrupted, [first]);
  const notMine = await tool("stop_session", { session: "ses_mine" }, "ses_pixel");
  assert.deepEqual(notMine, { text: "\"My own\" isn't yours to stop: ask the user.", isError: true });
});

test("a summary doesn't change how a lead reads a session: failed stays failed, and a summary that failed is said to be only that", async () => {
  const session = startedAddress(await tool("start_session", { task: "One.", title: "Sign-in", project: "Tidepool" }, "ses_pixel"));
  busy.delete(session);
  sessions.get(session).outcome = "succeeded"; // As the engine has it after the summary.
  sessions.get(session).time.idle = Date.now();
  kept.set(session, [{ id: "msg_i2", type: "idle", outcome: "succeeded" }, { id: "msg_c", type: "compaction", status: "completed", reason: "manual" }, { id: "msg_i1", type: "idle", outcome: "failed" }, { id: "msg_s", type: "assistant", content: [] }]);
  assert.match((await tool("list_sessions", {}, "ses_pixel")).text, /failed/);
  assert.doesNotMatch((await tool("list_sessions", {}, "ses_pixel")).text, /finished/);
});

test("a turn cut short gives as its last reply what it said in that turn, never an earlier turn's reply", async () => {
  const session = startedAddress(await tool("start_session", { task: "One.", title: "Sign-in", project: "Tidepool" }, "ses_pixel"));
  busy.delete(session);
  sessions.get(session).outcome = "interrupted";
  sessions.get(session).time.idle = Date.now();
  const said = (text, id) => ({ id, type: "assistant", content: text ? [{ type: "text", text }] : [] });
  const earlier = [{ id: "msg_i1", type: "idle", outcome: "succeeded" }, said("Previous turn finished.", "msg_s1"), { id: "msg_u1", type: "user" }];
  // Stopped before it said anything.
  kept.set(session, [{ id: "msg_i2", type: "idle", outcome: "interrupted" }, said("", "msg_s2"), { id: "msg_u2", type: "user" }, ...earlier]);
  let listed = (await tool("list_sessions", {}, "ses_pixel")).text;
  assert.match(listed, /stopped/);
  assert.doesNotMatch(listed, /Previous turn finished/);
  // Stopped after it said something in that turn: that's its last reply.
  kept.set(session, [{ id: "msg_i2", type: "idle", outcome: "interrupted" }, said("", "msg_s3"), said("Halfway through the sign-in.", "msg_s2"), { id: "msg_u2", type: "user" }, ...earlier]);
  listed = (await tool("list_sessions", {}, "ses_pixel")).text;
  assert.match(listed, /stopped/);
  assert.match(listed, /Halfway through the sign-in/);
  assert.doesNotMatch(listed, /Previous turn finished/);
  // Stopped, and then summarized: still that turn's.
  kept.set(session, [{ id: "msg_i3", type: "idle", outcome: "succeeded" }, { id: "msg_c", type: "compaction", status: "completed", reason: "manual" }, { id: "msg_i2", type: "idle", outcome: "interrupted" }, { id: "msg_u2", type: "user" }, ...earlier]);
  listed = (await tool("list_sessions", {}, "ses_pixel")).text;
  assert.match(listed, /stopped/);
  assert.doesNotMatch(listed, /Previous turn finished/);
  // Failed before it said anything: the same.
  sessions.get(session).outcome = "failed";
  kept.set(session, [{ id: "msg_i2", type: "idle", outcome: "failed" }, { id: "msg_u2", type: "user" }, ...earlier]);
  listed = (await tool("list_sessions", {}, "ses_pixel")).text;
  assert.match(listed, /failed/);
  assert.doesNotMatch(listed, /Previous turn finished/);
  // A turn that finished says what it said last.
  sessions.get(session).outcome = "succeeded";
  kept.set(session, earlier);
  assert.match((await tool("list_sessions", {}, "ses_pixel")).text, /Previous turn finished/);
});

test("how a lead reads a session past several summaries: what they did isn't how its work went", async () => {
  const session = startedAddress(await tool("start_session", { task: "One.", title: "Sign-in", project: "Tidepool" }, "ses_pixel"));
  busy.delete(session);
  sessions.get(session).outcome = "succeeded";
  sessions.get(session).time.idle = Date.now();
  const end = (outcome, id) => ({ id, type: "idle", outcome });
  const summary = (status, id) => ({ id, type: "compaction", status, reason: "manual" });
  const said = { id: "msg_s", type: "assistant", content: [{ type: "text", text: "Done." }] };
  // Worked; then a summary failed, and the next went through.
  kept.set(session, [end("succeeded", "msg_i3"), summary("completed", "msg_c2"), end("failed", "msg_i2"), summary("failed", "msg_c1"), end("succeeded", "msg_i1"), said]);
  assert.match((await tool("list_sessions", {}, "ses_pixel")).text, /finished/);
  // Failed; then two summaries.
  kept.set(session, [end("succeeded", "msg_i3"), summary("completed", "msg_c2"), end("succeeded", "msg_i2"), summary("completed", "msg_c1"), end("failed", "msg_i1"), said]);
  assert.match((await tool("list_sessions", {}, "ses_pixel")).text, /failed/);
  // No summary, and a run that died without writing its end: the session's word.
  sessions.get(session).outcome = "failed";
  kept.set(session, [said, end("succeeded", "msg_i1")]);
  assert.match((await tool("list_sessions", {}, "ses_pixel")).text, /failed/);
  sessions.get(session).outcome = "succeeded";
  // Failed; a summary; then a model picked, which is no turn.
  kept.set(session, [{ id: "msg_m", type: "model-switched" }, end("succeeded", "msg_i2"), summary("completed", "msg_c1"), end("failed", "msg_i1"), said]);
  assert.match((await tool("list_sessions", {}, "ses_pixel")).text, /failed/);
});

test("list_sessions tells how full a session's context is, as the app's gauge reads it, and the running total as that", async () => {
  const session = startedAddress(await tool("start_session", { task: "One.", title: "Sign-in", project: "Tidepool" }, "ses_pixel"));
  sessions.get(session).tokens = { input: 400_000, output: 27_000, reasoning: 0, cache: { read: 9_000_000, write: 0 } };
  const step = (input, read, write, output) => ({ id: "msg_s", type: "assistant", content: [{ type: "text", text: "Going." }], tokens: { input, output, reasoning: 50, cache: { read, write } } });
  // Newest first: the last step that says, past a note and a step that doesn't.
  kept.set(session, [{ id: "msg_n", type: "synthetic", text: "A note." }, { id: "msg_t", type: "assistant", content: [] }, step(10_000, 295_000, 1_000, 4_000), step(90_000, 10_000, 0, 1_000)]);
  const listed = (await tool("list_sessions", {}, "ses_pixel")).text;
  assert.match(listed, /· 310,000 tokens in context now · 427,000 tokens used in total/);
  // Just summarized: what it was before isn't what's in it now.
  kept.set(session, [{ id: "msg_i", type: "idle", outcome: "succeeded" }, { id: "msg_c", type: "compaction", status: "completed", reason: "manual" }, step(10_000, 295_000, 1_000, 4_000)]);
  const after = (await tool("list_sessions", {}, "ses_pixel")).text;
  assert.match(after, /· just summarized, context size known after its next step · 427,000 tokens used in total/);
  assert.doesNotMatch(after, /310,000/);
  // One that failed changed nothing.
  kept.set(session, [{ id: "msg_i", type: "idle", outcome: "failed" }, { id: "msg_c", type: "compaction", status: "failed", reason: "manual" }, step(10_000, 295_000, 1_000, 4_000)]);
  assert.match((await tool("list_sessions", {}, "ses_pixel")).text, /· 310,000 tokens in context now/);
  // Nothing said yet: no number made up.
  kept.set(session, []);
  sessions.get(session).tokens = noTokens();
  assert.doesNotMatch((await tool("list_sessions", {}, "ses_pixel")).text, /tokens/);
});

test("compact_session summarizes only a session of the caller's own, and says plainly what it can't and when it will", async () => {
  const session = startedAddress(await tool("start_session", { task: "One.", title: "Sign-in", project: "Tidepool" }, "ses_pixel"));
  assert.deepEqual(await tool("compact_session", { session: "ses_mine" }, "ses_pixel"), { text: "\"My own\" isn't yours to compact: ask the user.", isError: true });
  assert.deepEqual(compacted, []);
  assert.equal((await tool("compact_session", {}, "ses_pixel")).isError, true);
  assert.deepEqual(compacted, []);

  // At rest: now, on the engine or the bridge.
  busy.delete(session);
  assert.match((await tool("compact_session", { session }, "ses_pixel")).text, /^Summarizing "Sign-in" now\./);
  compacting.set(session, { data: { state: "compacting" } });
  assert.match((await tool("compact_session", { session }, "ses_pixel")).text, /^Summarizing "Sign-in" now\./);
  // Working: a coding agent's when its turn ends, the engine's at its next step.
  active.add(session);
  compacting.set(session, { data: { state: "waiting" } });
  assert.deepEqual(await tool("compact_session", { session }, "ses_pixel"), { text: "\"Sign-in\" will be summarized when its turn ends.", isError: false });
  compacting.delete(session);
  assert.deepEqual(await tool("compact_session", { session }, "ses_pixel"), { text: "\"Sign-in\" will be summarized at its next step.", isError: false });
  active.delete(session);
  // What can't, in its box's own words.
  const why = "Cursor can't summarize on request: it does so by itself when the conversation fills up.";
  compacting.set(session, { message: why });
  assert.deepEqual(await tool("compact_session", { session }, "ses_pixel"), { text: `Couldn't summarize "Sign-in": ${why}`, isError: true });
  assert.equal(compacted.every(each => each === session), true);
  assert.equal(compacted.length, 5);
});

test("a bot answers its sessions' asks as its own conversation could go ahead, recorded on the session: a push too, as in any conversation", async () => {
  const session = inMode(startedAddress(await tool("start_session", { task: "Add haptics.", title: "Haptics", project: "Tidepool" }, "ses_pixel")));
  asked.set(session, [
    { id: "per_1", sessionID: session, action: "shell", resources: ["git diff --stat"], source: { type: "tool", messageID: "msg_1", id: "call_1" } },
    { id: "per_2", sessionID: session, action: "shell", resources: ["git push origin main"], source: { type: "tool", messageID: "msg_1", id: "call_2" } },
  ]);
  const allowed = await tool("answer_ask", { session, ask: "per_1", decision: "allow", reason: "The plan names the haptics package." }, "ses_pixel");
  assert.deepEqual(allowed, { text: "Allowed: git diff --stat.", isError: false });
  assert.deepEqual(replied[0], { session, permission: "per_1", decision: "once" });
  const record = sessions.get(session).metadata.kuvo.answers;
  assert.equal(record.length, 1);
  assert.deepEqual({ ...record[0], at: undefined }, { ask: "per_1", call: "call_1", what: "Wants to run a command: git diff --stat", decision: "allow", reason: "The plan names the haptics package.", by: { bot: "bot_pixel00001", name: "Pixel" }, at: undefined });
  assert.equal(typeof record[0].at, "number");

  const push = await tool("answer_ask", { session, ask: "per_2", decision: "allow", reason: "Ship it." }, "ses_pixel");
  assert.deepEqual(push, { text: "Allowed: git push origin main.", isError: false }, "its own conversation pushes without asking, so it may let its session");
  assert.deepEqual(replied[1], { session, permission: "per_2", decision: "once" });
  asked.set(session, [{ id: "per_3", sessionID: session, action: "shell", resources: ["git push --force origin main"] }]);
  const denied = await tool("answer_ask", { session, ask: "per_3", decision: "deny", reason: "Not over main." }, "ses_pixel");
  assert.equal(denied.isError, false, "saying no is always the bot's to do");
  assert.deepEqual(replied[2], { session, permission: "per_3", decision: "reject", message: "Pixel: Not over main." });
});

// What a bot does to its sessions, as every client sees it (`kuvo/work/oversight`), so the sidebar
// can show the bot looking after them: each start, message, read, answer and stop, once, in order,
// for its own sessions only. Your own session it reads is nobody's to show, and another bot reading
// Pixel's isn't Pixel looking after it.
test("a client sees what a bot does to each of its sessions, as it does it, and nothing for a session that isn't its", async () => {
  fs.rmSync(path.join(home, "run", "work", "oversight.json"), { force: true });
  const session = inMode(startedAddress(await tool("start_session", { task: "Add haptics.", title: "Haptics", project: "Tidepool" }, "ses_pixel")));
  assert.ok(session);
  assert.equal((await tool("send_message", { to: session, text: "Use the light taps." }, "ses_pixel")).isError, false);
  assert.equal((await tool("read_conversation", { of: session }, "ses_pixel")).isError, false);
  asked.set(session, [{ id: "per_1", sessionID: session, action: "shell", resources: ["git diff --stat"] }]);
  assert.equal((await tool("answer_ask", { session, ask: "per_1", decision: "allow", reason: "To see the change." }, "ses_pixel")).isError, false);
  assert.equal((await tool("read_conversation", { of: "ses_mine" }, "ses_pixel")).isError, false);
  assert.equal((await tool("read_conversation", { of: session }, "ses_mira")).isError, false);
  assert.equal((await tool("stop_session", { session }, "ses_pixel")).isError, false);

  const seen = await route("GET", "kuvo/work/oversight");
  assert.equal(seen.status, 200);
  assert.deepEqual(seen.body.marks.map(mark => [mark.bot, mark.session, mark.kind]), [
    ["bot_pixel00001", session, "started"],
    ["bot_pixel00001", session, "told"],
    ["bot_pixel00001", session, "read"],
    ["bot_pixel00001", session, "answered"],
    ["bot_pixel00001", session, "stopped"],
  ]);
  // Each its own, so a client plays each once.
  assert.equal(new Set(seen.body.marks.map(mark => mark.id)).size, 5);
});

test("a bot that asks first can't allow what it would have to ask about itself", async () => {
  const session = inMode(startedAddress(await tool("start_session", { task: "Tidy.", project: "Tidepool" }, "ses_mira")));
  asked.set(session, [{ id: "per_1", sessionID: session, action: "shell", resources: ["git status"] }]);
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
  assert.doesNotMatch(said.text, /deepseek-v3/, "deprecated");
});

test("a client sees a bot's work: its sessions, the answers it gave and today's count", async () => {
  setBots({ pixelWork: { limits: { atOnce: 3 } } });
  const session = inMode(startedAddress(await tool("start_session", { task: "Add haptics.", title: "Haptics", project: "Tidepool" }, "ses_pixel")));
  asked.set(session, [{ id: "per_1", sessionID: session, action: "shell", resources: ["git status"] }]);
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

test("a client sees which account each of a bot's sessions runs on, as Settings › Accounts names it: its provider, and the name you gave a coding agent's account", async t => {
  write(path.join(home, "run", "bridge.json"), JSON.stringify({ port: bridge.address().port, password: "b", pid: await runningAs("kuvo-agents", t) }));
  t.after(() => fs.rmSync(path.join(home, "run", "bridge.json"), { force: true }));
  const start = async (title, model, onBridge = false) => {
    const session = startedAddress(await tool("start_session", { task: "Go.", title, project: "Tidepool" }, "ses_pixel"));
    Object.assign(sessions.get(session), { model, ...(onBridge ? { bridge: true } : {}) });
    return title;
  };
  // The engine's plan with two sign-ins: by its name alone (they have no names of yours).
  await start("On the work key", { providerID: "anthropic", id: "claude-opus-5-5" });
  // One sign-in: the plan says which.
  await start("On DeepSeek", { providerID: "deepseek", id: "deepseek-v4" });
  // A coding agent's own sign-in, and one you added and named.
  await start("On Claude Code", { providerID: "claude-code", id: "opus" }, true);
  await start("On Athas", { providerID: "claude-code@acc0001", id: "opus" }, true);
  // Custom Auto picks an account each turn; a provider where it runs can't say: none.
  await start("On Auto", { providerID: "auto", id: "auto" });
  await start("On a gone plan", { providerID: "gone", id: "x" });
  integrationsAskedFresh = 0;
  const work = await route("GET", "kuvo/work?bot=bot_pixel00001");
  assert.equal(work.status, 200);
  assert.deepEqual(Object.fromEntries(work.body.sessions.map(each => [each.title, each.account ?? null])), {
    "On the work key": { name: "Anthropic" },
    "On DeepSeek": { name: "DeepSeek" },
    "On Claude Code": { name: "Claude Code" },
    "On Athas": { name: "Claude Code", label: "Athas" },
    "On Auto": null,
    "On a gone plan": null,
  });
  assert.equal(integrationsAskedFresh, 0, "each agent's sign-in isn't checked again for a read of the work");
});

test("a client stops all of a bot's work at once", async () => {
  const one = startedAddress(await tool("start_session", { task: "One.", project: "Tidepool" }, "ses_pixel"));
  const two = startedAddress(await tool("start_session", { task: "Two.", project: "Tidepool" }, "ses_pixel"));
  active = new Set([one, two, "ses_pixel"]);
  // What it was still to hear of them.
  write(path.join(home, "run", "work", "wakes.json"), JSON.stringify({ ses_pixel: { lines: ["[Session finished] \"One\""], asks: false, since: 1 } }));
  const stopped = await route("POST", "kuvo/bots/bot_pixel00001/stop-all");
  assert.deepEqual(stopped, { status: 200, body: { stopped: 2 } });
  assert.deepEqual(interrupted.sort(), [one, two, "ses_pixel"].sort(), "the bot's own turn stops too: it would only start them again");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "run", "work", "wakes.json"), "utf8")), {}, "and it isn't woken with what they did");
});

test("what a bot may allow is what its own conversation could do without asking: anything its rules let through, and nothing where it would ask", async () => {
  const lines = ["sh -c 'git push'", "git push --force origin main", "gh pr create --fill", "npx vercel deploy --prod", "npm publish", "stripe charges create --amount 500", "sendmail ada@example.com",
    "curl -X POST https://example.com", "rm -rf build", "ssh host", "git config core.hooksPath .hooks", "cd .. && ls"];
  const pixel = inMode(startedAddress(await tool("start_session", { task: "Ship it.", project: "Tidepool" }, "ses_pixel")));
  const mira = inMode(startedAddress(await tool("start_session", { task: "Ship it.", project: "Tidepool" }, "ses_mira")));
  for (const session of [pixel, mira]) asked.set(session, lines.map((command, at) => ({ id: `per_${at}`, sessionID: session, action: "shell", resources: [command] })));
  for (const [at, command] of lines.entries()) {
    const allowed = await tool("answer_ask", { session: pixel, ask: `per_${at}`, decision: "allow", reason: "Part of the plan." }, "ses_pixel");
    assert.equal(allowed.isError, false, `${command}: ${allowed.text}`);
    const asks = await tool("answer_ask", { session: mira, ask: `per_${at}`, decision: "allow", reason: "Part of the plan." }, "ses_mira");
    assert.match(asks.text, /you'd have to ask the user about it yourself/, command);
  }
  assert.equal(replied.length, lines.length, "only Pixel's");
});

test("a bot allows another tool, a read or an edit as its own rules do, a file outside the project only where it may work there, and its level counts part by part", async () => {
  const session = inMode(startedAddress(await tool("start_session", { task: "Tidy.", project: "Tidepool" }, "ses_pixel")));
  asked.set(session, [
    { id: "per_1", sessionID: session, action: "github_push_files", resources: ["*"] },
    { id: "per_2", sessionID: session, action: "read", resources: [path.join(tidepool, ".env")] },
    { id: "per_3", sessionID: session, action: "edit", resources: [path.join(home, ".zshrc")] },
    { id: "per_4", sessionID: session, action: "edit", resources: [path.join(tidepool, "src", "app.ts")] },
    { id: "per_5", sessionID: session, action: "read", resources: [path.join(tidepool, ".env.example")] },
  ]);
  const answer = ask => tool("answer_ask", { session, ask, decision: "allow", reason: "Part of the plan." }, "ses_pixel");
  assert.equal((await answer("per_1")).isError, false, "an integration's tool goes ahead in its own conversation");
  assert.match((await answer("per_2")).text, /ask the user about it yourself/, "the engine asks before reading a .env, for it too");
  assert.match((await answer("per_3")).text, /ask the user about it yourself/, "outside the project, it would be asked itself");
  assert.equal((await answer("per_4")).isError, false);
  assert.equal((await answer("per_5")).isError, false);
  // A conversation allowed to run git alone can't allow git and something else in one line.
  const own = sessions.get("ses_pixel").permissions;
  sessions.get("ses_pixel").permissions = [{ action: "shell", resource: "*", effect: "ask" }, { action: "shell", resource: "git *", effect: "allow" }];
  try {
    const level = inMode(startedAddress(await tool("start_session", { task: "Test.", project: "Tidepool" }, "ses_pixel")));
    asked.set(level, [{ id: "per_6", sessionID: level, action: "shell", resources: ["git status && ls"] }, { id: "per_7", sessionID: level, action: "shell", resources: ["git status && git diff"] }]);
    const both = await tool("answer_ask", { session: level, ask: "per_6", decision: "allow", reason: "Tests." }, "ses_pixel");
    assert.match(both.text, /ask the user about it yourself/, "ls is asked about on its own");
    assert.equal((await tool("answer_ask", { session: level, ask: "per_7", decision: "allow", reason: "Tests." }, "ses_pixel")).isError, false);
  } finally {
    sessions.get("ses_pixel").permissions = own;
  }
});

test("a bot that asks first can't allow a folder outside the project, which it would be asked about itself", async () => {
  const session = inMode(startedAddress(await tool("start_session", { task: "Tidy.", project: "Tidepool" }, "ses_mira")));
  asked.set(session, [{ id: "per_1", sessionID: session, action: "external_directory", resources: [path.join(home, ".ssh", "*")] }]);
  const said = await tool("answer_ask", { session, ask: "per_1", decision: "allow", reason: "It needs the keys." }, "ses_mira");
  assert.equal(said.isError, true);
  assert.equal(replied.length, 0);
});

test("what a session's subagent asks, the bot answers on the subagent", async () => {
  const session = inMode(startedAddress(await tool("start_session", { task: "Review it.", project: "Tidepool" }, "ses_pixel")));
  sessions.set("ses_reviewer", { id: "ses_reviewer", parentID: session, title: "Reviewer", location: { directory: tidepool }, time: { created: 1, updated: 1 } });
  asked.set("ses_reviewer", [{ id: "per_7", sessionID: "ses_reviewer", action: "shell", resources: ["git status"] }]);
  const listed = await tool("list_sessions", {}, "ses_pixel");
  assert.match(listed.text, /asks to run a command: git status \(ask per_7\)/, "its subagent's ask is the session's");
  const said = await tool("answer_ask", { session, ask: "per_7", decision: "allow", reason: "Tests." }, "ses_pixel");
  assert.equal(said.isError, false, said.text);
  assert.deepEqual(replied[0], { session: "ses_reviewer", permission: "per_7", decision: "once" });
});

test("two answers given at once on one session are both kept", async () => {
  const session = inMode(startedAddress(await tool("start_session", { task: "Add haptics.", project: "Tidepool" }, "ses_pixel")));
  asked.set(session, [{ id: "per_1", sessionID: session, action: "shell", resources: ["git status"] }, { id: "per_2", sessionID: session, action: "shell", resources: ["git log --oneline -5"] }]);
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

test("a conversation that plans can't start a session that builds", async () => {
  sessions.get("ses_pixel").agent = "plan";
  try {
    const said = await tool("start_session", { task: "Build it.", project: "Tidepool", mode: "build" }, "ses_pixel");
    assert.equal(said.isError, true);
    assert.match(said.text, /Plan mode/);
    assert.equal(made.length, 0);
  } finally {
    delete sessions.get("ses_pixel").agent;
  }
});

test("a bot's work further back than the latest two hundred sessions is still its", async () => {
  const old = startedAddress(await tool("start_session", { task: "Long ago.", project: "Tidepool" }, "ses_pixel"));
  sessions.get(old).time.created = 2;
  for (let at = 0; at < 230; at++) sessions.set(`ses_other${at}`, { id: `ses_other${at}`, title: "Other", location: { directory: tidepool }, time: { created: 10 + at, updated: 10 + at }, metadata: { kuvo: { startedBy: "ses_mine" } } });
  // The latest first, as the engine lists them.
  sessions = new Map([...sessions.entries()].sort(([, a], [, b]) => (b.time?.created ?? 0) - (a.time?.created ?? 0)));
  const work = await route("GET", "kuvo/work?bot=bot_pixel00001");
  assert.deepEqual(work.body.sessions.map(each => each.session), [old]);
});

test("a bot lets a session edit any file in the project, as its own conversation would, but not one a link leads out of it to, nor start one working in your home folder", async () => {
  const session = inMode(startedAddress(await tool("start_session", { task: "Tidy.", project: "Tidepool" }, "ses_pixel")));
  fs.rmSync(path.join(tidepool, "linkout"), { force: true });
  fs.symlinkSync(home, path.join(tidepool, "linkout"));
  const edits = [".git/hooks/pre-commit", "package.json", "Makefile", ".husky/pre-commit", "opencode.json", ".claude/settings.json", "src/app.ts", "docs/plan.md"];
  asked.set(session, [
    ...edits.map((file, at) => ({ id: `per_${at}`, sessionID: session, action: "edit", resources: [path.join(tidepool, file)] })),
    { id: "per_out", sessionID: session, action: "edit", resources: [path.join(tidepool, "linkout", ".zshrc")] },
    { id: "per_read", sessionID: session, action: "read", resources: [path.join(tidepool, "linkout", ".bashrc")] },
    // (Named from the session's folder, as the engine takes a path not from `/`.)
    { id: "per_relative", sessionID: session, action: "edit", resources: ["linkout/.profile"], tool: "edit", input: { filePath: "linkout/.profile", oldString: "", newString: "x" } },
  ]);
  const answer = ask => tool("answer_ask", { session, ask, decision: "allow", reason: "Part of the plan." }, "ses_pixel");
  for (const [at, file] of edits.entries()) assert.equal((await answer(`per_${at}`)).isError, false, file);
  assert.match((await answer("per_out")).text, /ask the user about it yourself/);
  assert.match((await answer("per_read")).text, /ask the user about it yourself/);
  assert.match((await answer("per_relative")).text, /ask the user about it yourself/);

  // Nor start one working in your home folder, which holds your keys and what runs later.
  fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
  const inHome = await tool("start_session", { task: "Look.", folder: home }, "ses_pixel");
  assert.equal(inHome.isError, true);
  assert.match(inHome.text, /its commands could delete your home folder/);
});

test("a coding agent's session that runs in the sandbox lets a bot allow its commands, as the engine's do; one outside it while the bot's own run in it leaves them to you, and with no sandbox on, the bot allows as its own conversation runs", async t => {
  // The coding agents' bridge runs (a stand-in, its record naming a process that runs as it), and
  // the box's sandbox is set up and checked.
  write(path.join(home, "run", "bridge.json"), JSON.stringify({ port: bridge.address().port, password: "b", pid: await runningAs("kuvo-agents", t) }));
  write(path.join(home, "run", "fence", "on"), "set up");
  // (On Linux, each command in a namespace of its own, as the box notes it there.)
  write(path.join(home, "run", "fence", "namespace"), "/usr/bin/unshare");
  t.after(() => fs.rmSync(path.join(home, "run", "bridge.json"), { force: true }));
  t.after(() => fs.rmSync(path.join(home, "run", "fence"), { recursive: true, force: true }));
  // Pixel's session, its conversation now with a coding agent on the bridge.
  const session = inMode(startedAddress(await tool("start_session", { task: "Add haptics.", title: "Haptics", project: "Tidepool" }, "ses_pixel")));
  sessions.get(session).bridge = true;
  // The bridge says which asks come from an agent run whole in the sandbox now.
  asked.set(session, [
    { id: "install", sessionID: session, action: "shell", resources: ["npm install"], sandboxed: true },
    { id: "push", sessionID: session, action: "shell", resources: ["git push origin main"], sandboxed: true },
    { id: "outside", sessionID: session, action: "shell", resources: ["npm test"] },
  ]);
  const answer = ask => tool("answer_ask", { session, ask, decision: "allow", reason: "Part of the plan." }, "ses_pixel");
  assert.deepEqual(await answer("install"), { text: "Allowed: npm install.", isError: false });
  // A push too, as the bot's own conversation pushes.
  assert.deepEqual(await answer("push"), { text: "Allowed: git push origin main.", isError: false });
  // An agent started before the sandbox was on (or one not run in it): here the engine has no
  // sandbox plugin, so the bot's own commands run outside it too, and it allows as they run. (One
  // whose own run in it leaves that to you: the test with the real sandbox below.)
  assert.equal((await answer("outside")).isError, false);
  // The sandbox gone (its check failed): nothing here runs in it, the bot's own commands neither,
  // so it allows as its own conversation would run them.
  fs.rmSync(path.join(home, "run", "fence"), { recursive: true, force: true });
  asked.set(session, [{ id: "again", sessionID: session, action: "shell", resources: ["npm install"] }]);
  assert.equal((await answer("again")).isError, false);
  assert.deepEqual(replied.map(each => each.permission), ["install", "push", "outside", "again"]);
  write(path.join(home, "run", "fence", "on"), "set up");
  write(path.join(home, "run", "fence", "namespace"), "/usr/bin/unshare");
  // Agents use the vault only once the bridge says none of its agents runs outside the sandbox
  // as it is now (one started before it was on may still be at work).
  // (Each setup of the sandbox writes a token of its own in `on`.)
  write(path.join(home, "run", "fence", "on"), "first");
  assert.equal((await route("GET", "kuvo/sandbox")).body.agents, false, "the bridge hasn't said so");
  const bridgePID = JSON.parse(fs.readFileSync(path.join(home, "run", "bridge.json"), "utf8")).pid;
  write(path.join(home, "run", "fence", "agents"), JSON.stringify({ pid: bridgePID, on: "first" }));
  assert.equal((await route("GET", "kuvo/sandbox")).body.agents, true);
  // Set up again at once (its check failed and passed): what the bridge said was of the one before.
  fs.rmSync(path.join(home, "run", "fence", "on"));
  write(path.join(home, "run", "fence", "on"), "second");
  assert.equal((await route("GET", "kuvo/sandbox")).body.agents, false);
  // An empty `on` (an older box's) is no setup the bridge could have said so of.
  write(path.join(home, "run", "fence", "on"), "");
  write(path.join(home, "run", "fence", "agents"), JSON.stringify({ pid: bridgePID, on: "" }));
  assert.equal((await route("GET", "kuvo/sandbox")).body.agents, false);
});

test("the first time the sandbox is on with agents that started before it still running, the box asks you once to restart them, and Restart has the bridge do it", async t => {
  write(path.join(home, "run", "bridge.json"), JSON.stringify({ port: bridge.address().port, password: "b", pid: await runningAs("kuvo-agents", t) }));
  t.after(() => fs.rmSync(path.join(home, "run", "bridge.json"), { force: true }));
  t.after(() => fs.rmSync(path.join(home, "run", "fence"), { recursive: true, force: true }));
  const bridgePID = JSON.parse(fs.readFileSync(path.join(home, "run", "bridge.json"), "utf8")).pid;
  const bridgeSays = said => write(path.join(home, "run", "fence", "agents"), JSON.stringify({ pid: bridgePID, on: "first", ...said }));
  write(path.join(home, "run", "fence", "on"), "first");
  // Before the bridge has looked at its agents for this setup: nothing to ask yet.
  assert.equal((await route("GET", "kuvo/sandbox")).body.restart, undefined);
  bridgeSays({ outside: true });
  const asking = (await route("GET", "kuvo/sandbox")).body;
  assert.equal(asking.restart, true);
  assert.equal(asking.agents, false);
  assert.equal((await route("POST", "kuvo/sandbox/restart", {})).status, 400);
  const restarted = await route("POST", "kuvo/sandbox/restart", { restart: true });
  assert.equal(restarted.status, 200);
  assert.equal(restarted.body.restart, undefined);
  assert.equal(restarts, 1);
  // Asked once: while they finish their turns, and ever after, it isn't asked again.
  assert.equal((await route("GET", "kuvo/sandbox")).body.restart, undefined);
  write(path.join(home, "run", "fence", "on"), "second");
  write(path.join(home, "run", "fence", "agents"), JSON.stringify({ pid: bridgePID, on: "second", outside: true }));
  assert.equal((await route("GET", "kuvo/sandbox")).body.restart, undefined);

  // Not Now: the bridge isn't told, and it isn't asked again either.
  fs.rmSync(path.join(home, "run", "fence"), { recursive: true, force: true });
  write(path.join(home, "run", "fence", "on"), "first");
  bridgeSays({ outside: true });
  assert.equal((await route("GET", "kuvo/sandbox")).body.restart, true);
  assert.equal((await route("POST", "kuvo/sandbox/restart", { restart: false })).status, 200);
  assert.equal(restarts, 1);
  assert.equal((await route("GET", "kuvo/sandbox")).body.restart, undefined);

  // On with every agent in it already: nothing to ask, then or later.
  fs.rmSync(path.join(home, "run", "fence"), { recursive: true, force: true });
  write(path.join(home, "run", "fence", "on"), "first");
  bridgeSays({});
  assert.equal((await route("GET", "kuvo/sandbox")).body.restart, undefined);
  bridgeSays({ outside: true });
  assert.equal((await route("GET", "kuvo/sandbox")).body.restart, undefined);
});

test("where its sessions' commands run in the sandbox, a bot allows what its own conversation runs there, pushes and deploys too, but not an edit outside the project, nor a command that would run outside it", { timeout: 120_000 }, async t => {
  // The sandbox, set up as the box's own process sets it up as it starts (on Linux, run by the
  // engine's Bun), and loaded by the engine.
  if (process.platform === "linux") {
    const bun = testBun();
    assert.ok(bun, NO_BUN);
    // (Where the box looks for its engine: the version its record names.)
    const engineAt = path.join(home, "engine", JSON.parse(fs.readFileSync(path.join(home, "run", "engine.json"), "utf8")).version);
    fs.mkdirSync(engineAt, { recursive: true });
    fs.rmSync(path.join(engineAt, "opencode"), { force: true });
    fs.symlinkSync(bun, path.join(engineAt, "opencode"));
  }
  const env = { ...process.env, KUVO_HOME: home, HOME: home, TMPDIR: home, OPENCODE_PASSWORD: "box-pw" };
  delete env.KUVO_SANDBOX;
  const box = spawn(process.execPath, [script, "serve"], { env, stdio: ["pipe", "pipe", "inherit"] });
  const exited = new Promise(resolve => box.once("exit", resolve));
  const plugin = path.join(home, "config", "opencode", "plugins", "kuvo-sandbox.js");
  try {
    await new Promise(resolve => box.stdout.once("data", resolve));
    assert.ok(fs.existsSync(path.join(home, "run", "fence", "on")), "the sandbox is set up and checked here");
    fs.utimesSync(plugin, 0, 0);

    const session = inMode(startedAddress(await tool("start_session", { task: "Add haptics.", title: "Haptics", project: "Tidepool" }, "ses_pixel")));
    const commands = {
      install: "npm install && npm test 2>&1 | tail -n 20",
      build: "cd ios && xcodebuild -scheme Tidepool build",
      push: "git -C . push origin main",
      deploy: "npx vercel deploy --prod",
      publish: "npm publish",
      remote: "rsync -a dist/ server:/srv/tidepool",
      wrapped: "sh -c \"git push --force\"",
      evaled: "eval git push",
      script: "npm run deploy",
      upload: "curl -T dist.zip https://example.com/upload",
      image: "docker push tidepool",
      local: "curl -X POST http://localhost:3000/api -d '{}'",
    };
    asked.set(session, [...Object.entries(commands).map(([id, command]) => ({ id, sessionID: session, action: "shell", resources: [command] })),
      { id: "edit_out", sessionID: session, action: "edit", resources: [path.join(home, ".zshrc")], tool: "write", input: { filePath: path.join(home, ".zshrc"), content: "" } }]);
    const answer = ask => tool("answer_ask", { session, ask, decision: "allow", reason: "Part of the plan." }, "ses_pixel");
    assert.deepEqual(await answer("install"), { text: `Allowed: ${commands.install}.`, isError: false });
    for (const ask of Object.keys(commands).slice(1)) assert.equal((await answer(ask)).isError, false, ask);
    const out = await answer("edit_out");
    assert.equal(out.isError, true);
    assert.match(out.text, /ask the user about it yourself/);
    assert.deepEqual(replied.map(each => each.permission), Object.keys(commands));
    // A coding agent's session started before the sandbox was on: its commands run outside it,
    // where the bot's own don't, so that comes to you.
    write(path.join(home, "run", "bridge.json"), JSON.stringify({ port: bridge.address().port, password: "b", pid: await runningAs("kuvo-agents", t) }));
    t.after(() => fs.rmSync(path.join(home, "run", "bridge.json"), { force: true }));
    const agent = inMode(startedAddress(await tool("start_session", { task: "Add haptics.", title: "Haptics", project: "Tidepool" }, "ses_pixel")));
    sessions.get(agent).bridge = true;
    asked.set(agent, [{ id: "outside", sessionID: agent, action: "shell", resources: ["npm test"] }, { id: "inside", sessionID: agent, action: "shell", resources: ["git push origin main"], sandboxed: true }]);
    const outside = await tool("answer_ask", { session: agent, ask: "outside", decision: "allow", reason: "Part of the plan." }, "ses_pixel");
    assert.match(outside.text, /ask the user about it yourself/);
    assert.equal((await tool("answer_ask", { session: agent, ask: "inside", decision: "allow", reason: "Part of the plan." }, "ses_pixel")).isError, false);
    // A bot in Full Access runs its own commands outside the sandbox: that one is its to allow.
    write(path.join(home, "box", "approval.json"), JSON.stringify({ fullAccess: true }));
    const own = sessions.get("ses_pixel");
    sessions.set("ses_pixel", { ...own, metadata: { kuvo: { bot: "bot_pixel00001", approval: "fullAccess", applied: "fullAccess" } } });
    try {
      asked.set(agent, [{ id: "outside_full", sessionID: agent, action: "shell", resources: ["npm test"] }]);
      assert.equal((await tool("answer_ask", { session: agent, ask: "outside_full", decision: "allow", reason: "Part of the plan." }, "ses_pixel")).isError, false);
    } finally {
      sessions.set("ses_pixel", own);
      fs.rmSync(path.join(home, "box", "approval.json"), { force: true });
    }
  } finally {
    box.kill("SIGTERM");
    await exited;
    // The sandbox gone again, for what comes after.
    fs.rmSync(path.join(home, "run", "fence"), { recursive: true, force: true });
    fs.rmSync(plugin, { force: true });
  }
  // Without it, a bot allows as its own conversation runs without it.
  const session = inMode(startedAddress(await tool("start_session", { task: "Add haptics.", title: "Haptics", project: "Tidepool" }, "ses_pixel")));
  asked.set(session, [{ id: "install", sessionID: session, action: "shell", resources: ["npm install"] }]);
  assert.equal((await tool("answer_ask", { session, ask: "install", decision: "allow", reason: "Part of the plan." }, "ses_pixel")).isError, false);
});

// A session in Ask First always asks the user, whatever its bot's mode (PROTOCOL.md, "Work",
// Answering asks): a bot in Full Access or Auto can't allow what it asks, though it may still say
// no, and answer a question in words.
const FULL = { kuvo: { bot: "bot_pixel00001", approval: "fullAccess", applied: "fullAccess" } };
const inFullAccess = async fn => {
  write(path.join(home, "box", "approval.json"), JSON.stringify({ fullAccess: true }));
  const own = sessions.get("ses_pixel");
  sessions.set("ses_pixel", { ...own, metadata: FULL });
  try {
    await fn();
  } finally {
    sessions.set("ses_pixel", own);
    fs.rmSync(path.join(home, "box", "approval.json"), { force: true });
  }
};
const ASKED = { id: "per_1", action: "shell", resources: ["git status"] };

test("a bot in Full Access can't allow what a session in Ask First asks: the user answers it, and the bot may still deny or answer a question in words", async () => {
  await inFullAccess(async () => {
    const session = inMode(startedAddress(await tool("start_session", { task: "Tidy.", title: "Tidy", project: "Tidepool" }, "ses_pixel")), "askFirst");
    asked.set(session, [{ ...ASKED, sessionID: session }, { id: "per_2", sessionID: session, action: "shell", resources: ["git log"] }]);
    forms.set(session, [{ id: "frm_1", title: "Name", fields: [{ key: "name", type: "string", description: "What should it be called?" }] }]);
    const said = await tool("answer_ask", { session, ask: "per_1", decision: "allow", reason: "Harmless." }, "ses_pixel");
    assert.equal(said.isError, true);
    assert.match(said.text, /^You can't allow that: "Tidy" is in Ask First, so the user answers every ask it makes/);
    // The ask is still open for the user, and nothing was recorded as allowed.
    assert.deepEqual(replied, []);
    assert.equal(asked.get(session).some(each => each.id === "per_1"), true);
    assert.equal(sessions.get(session).metadata.kuvo.answers, undefined);
    // It may deny, and answer a question in words.
    assert.equal((await tool("answer_ask", { session, ask: "per_2", decision: "deny", reason: "Not needed." }, "ses_pixel")).isError, false);
    assert.deepEqual(replied, [{ session, permission: "per_2", decision: "reject", message: "Pixel: Not needed." }]);
    assert.equal((await tool("answer_ask", { session, ask: "frm_1", answer: "Tidy", reason: "The plan names it." }, "ses_pixel")).isError, false);
    assert.deepEqual(answeredForms, [{ session, form: "frm_1", answer: { name: "Tidy" } }]);
    // The same session in Accept Edits: the bot's own conversation goes ahead, so it may.
    inMode(session, "acceptEdits");
    assert.deepEqual(await tool("answer_ask", { session, ask: "per_1", decision: "allow", reason: "Harmless." }, "ses_pixel"), { text: "Allowed: git status.", isError: false });
  });
});

test("a session in Full Access, Accept Edits or Auto that asks is the bot's to allow, as before", async () => {
  await inFullAccess(async () => {
    // (Auto is Auto only where the sandbox runs: a test box can say it does.)
    process.env.KUVO_TEST_SANDBOX_ON = "1";
    try {
      for (const mode of ["fullAccess", "acceptEdits", "auto"]) {
        replied.length = 0;
        const session = inMode(startedAddress(await tool("start_session", { task: `Tidy ${mode}.`, project: "Tidepool" }, "ses_pixel")), mode);
        asked.set(session, [{ ...ASKED, sessionID: session }]);
        assert.deepEqual(await tool("answer_ask", { session, ask: "per_1", decision: "allow", reason: "Harmless." }, "ses_pixel"), { text: "Allowed: git status.", isError: false }, mode);
        assert.deepEqual(replied, [{ session, permission: "per_1", decision: "once" }], mode);
      }
    } finally {
      delete process.env.KUVO_TEST_SANDBOX_ON;
    }
  });
});

test("an Auto session that can't be Auto here (no sandbox) is in Ask First as it runs: the bot can't allow what it asks", async () => {
  const session = startedAddress(await tool("start_session", { task: "Tidy.", project: "Tidepool" }, "ses_pixel"));
  assert.equal(sessions.get(session).metadata.kuvo.approval, "auto");
  asked.set(session, [{ ...ASKED, sessionID: session }]);
  assert.match((await tool("answer_ask", { session, ask: "per_1", decision: "allow", reason: "Harmless." }, "ses_pixel")).text, /asks first for now \(Auto needs the sandbox/);
  assert.deepEqual(replied, []);
});

test("what a subagent of a session in Ask First asks is the user's too: judged by its session's mode", async () => {
  await inFullAccess(async () => {
    const session = inMode(startedAddress(await tool("start_session", { task: "Review it.", project: "Tidepool" }, "ses_pixel")), "askFirst");
    sessions.set("ses_reviewer", { id: "ses_reviewer", parentID: session, title: "Reviewer", location: { directory: tidepool }, time: { created: 1, updated: 1 } });
    asked.set("ses_reviewer", [{ id: "per_7", sessionID: "ses_reviewer", action: "shell", resources: ["git status"] }]);
    assert.match((await tool("answer_ask", { session, ask: "per_7", decision: "allow", reason: "Tests." }, "ses_pixel")).text, /is in Ask First/);
    assert.deepEqual(replied, []);
    assert.equal((await tool("answer_ask", { session, ask: "per_7", decision: "deny", reason: "No." }, "ses_pixel")).isError, false);
    assert.deepEqual(replied.map(each => [each.session, each.decision]), [["ses_reviewer", "reject"]]);
  });
});

test("a coding agent's session in Ask First is the user's to answer too: the bot can't allow what it asks", async t => {
  write(path.join(home, "run", "bridge.json"), JSON.stringify({ port: bridge.address().port, password: "b", pid: await runningAs("kuvo-agents", t) }));
  t.after(() => fs.rmSync(path.join(home, "run", "bridge.json"), { force: true }));
  await inFullAccess(async () => {
    const agent = inMode(startedAddress(await tool("start_session", { task: "Tidy.", title: "Agent", project: "Tidepool" }, "ses_pixel")), "askFirst");
    sessions.get(agent).bridge = true;
    asked.set(agent, [{ ...ASKED, sessionID: agent }]);
    const said = await tool("answer_ask", { session: agent, ask: "per_1", decision: "allow", reason: "Harmless." }, "ses_pixel");
    assert.equal(said.isError, true);
    assert.match(said.text, /"Agent" is in Ask First/);
    assert.deepEqual(replied, []);
    inMode(agent, "acceptEdits");
    assert.equal((await tool("answer_ask", { session: agent, ask: "per_1", decision: "allow", reason: "Harmless." }, "ses_pixel")).isError, false);
  });
});
